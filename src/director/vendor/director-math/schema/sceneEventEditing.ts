// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorProject, DirectorSceneEvent } from "./directorProject.js";
import {
  parseSceneEventAnchor,
  parseSceneEventTime,
  resolveSceneEventTime,
  validateSceneEvents,
  type SceneEventTime,
} from "./sceneEvents.js";
import { ensureSceneTimeline } from "./sceneTime.js";
import { editProjectCameraMotionClip } from "./cameraMotionClipEditing.js";
export type SceneEventCommand =
  | {
      type: "set_scene_event";
      eventId?: string;
      name: string;
      at: DirectorSceneEvent["at"];
    }
  | { type: "remove_scene_event"; eventId: string };
export interface CameraEventAlignmentCommand {
  type: "align_camera_clip";
  cameraId: string;
  clipId: string;
  start: SceneEventTime;
  end?: SceneEventTime;
}
const id = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label}不能为空`);
  return value.trim();
};
export function parseSceneEventCommand(raw: unknown): SceneEventCommand {
  if (!raw || typeof raw !== "object") throw new Error("事件命令格式无效");
  const v = raw as SceneEventCommand;
  if (v.type === "remove_scene_event")
    return { type: v.type, eventId: id(v.eventId, "事件 ID") };
  if (v.type !== "set_scene_event") throw new Error("未知事件命令");
  const event = {
    id: v.eventId === undefined ? "event_new" : id(v.eventId, "事件 ID"),
    name: id(v.name, "事件名称"),
    at: typeof v.at === "number" ? v.at : parseSceneEventAnchor(v.at),
  };
  validateSceneEvents([event]);
  return {
    type: v.type,
    ...(v.eventId !== undefined ? { eventId: event.id } : {}),
    name: event.name,
    at: event.at,
  };
}
export function editSceneEvent(
  project: DirectorProject,
  raw: SceneEventCommand,
) {
  const input = parseSceneEventCommand(raw),
    events = project.timeline.events ?? [];
  if (input.type === "remove_scene_event") {
    if (!events.some((event) => event.id === input.eventId))
      throw new Error("命名事件不存在");
    const remaining = events.filter((event) => event.id !== input.eventId),
      { events: _old, ...timeline } = project.timeline;
    return {
      eventId: input.eventId,
      project: {
        ...project,
        timeline: {
          ...timeline,
          ...(remaining.length ? { events: remaining } : {}),
        },
      },
    };
  }
  let eventId = input.eventId;
  if (!eventId) {
    let n = 1;
    while (events.some((e) => e.id === `event_${n}`)) n++;
    eventId = `event_${n}`;
  }
  const event = { id: eventId, name: input.name, at: input.at };
  const next = {
    ...project,
    timeline: {
      ...project.timeline,
      events: [...events.filter((e) => e.id !== eventId), event],
    },
  };
  // Imports may retain broken links for repair. A new write must resolve now.
  resolveSceneEventTime(next, { eventId });
  return { eventId, project: ensureSceneTimeline(next) };
}
export function parseCameraEventAlignment(
  raw: unknown,
): CameraEventAlignmentCommand {
  if (!raw || typeof raw !== "object") throw new Error("事件对齐命令无效");
  const v = raw as CameraEventAlignmentCommand;
  if (v.type !== "align_camera_clip") throw new Error("未知事件对齐命令");
  return {
    type: v.type,
    cameraId: id(v.cameraId, "机位 ID"),
    clipId: id(v.clipId, "片段 ID"),
    start: parseSceneEventTime(v.start),
    ...(v.end !== undefined ? { end: parseSceneEventTime(v.end) } : {}),
  };
}
/** One explicit alignment, not a persistent constraint that silently retimes future edits. */
export function alignCameraClipToEvents(
  project: DirectorProject,
  raw: CameraEventAlignmentCommand,
) {
  const input = parseCameraEventAlignment(raw),
    start = resolveSceneEventTime(project, input.start);
  const end =
    input.end === undefined
      ? undefined
      : resolveSceneEventTime(project, input.end);
  const result = editProjectCameraMotionClip(project, {
    type: "edit_camera_motion_clip",
    cameraId: input.cameraId,
    clipId: input.clipId,
    ...(end === undefined
      ? { action: "move", start }
      : { action: "stretch", start, end }),
  });
  const clip = result.project.cameras
    .find((c) => c.id === input.cameraId)!
    .motionClips.find((c) => c.id === input.clipId)!;
  return { ...result, start: clip.start, end: clip.end };
}
