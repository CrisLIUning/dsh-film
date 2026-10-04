// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { editPerformanceClip, nextPerformanceClipId } from "./performanceClipEditing.js";
import type {
  DirectorCharacterActionClip,
  DirectorObject,
  DirectorProject,
} from "./directorProject.js";
import {
  validateCharacterActionClips,
  validateCharacterActionBlend,
} from "./characterPerformance.js";
import { ensureSceneTimeline } from "./sceneTime.js";
import { requireCharacterAction } from './characterActionCatalog.js';
import { extractLegacyHoldActions } from './legacyHoldActions.js';

export type CharacterActionEdit =
  | {
      type: "set_action_clip";
      objectId: string;
      clipId?: string;
      name?: string;
      start: number;
      end: number;
      actionId: string | null;
      source?: { duration: number; in: number; out: number };
      loop?: boolean;
      muted?: boolean;
      blendIn?: number;
      blendOut?: number;
      layer?: "base" | "override";
      freezeAt?: number | null;
      automaticLocomotion?: boolean;
      endExclusive?: boolean;
    }
  | { type: "extract_hold_actions"; objectId: string; motionClipId?: string }
  | {
      type: "edit_action_clip";
      objectId: string;
      clipId: string;
      action: "move" | "trim" | "stretch" | "duplicate" | "split" | "remove";
      start?: number;
      end?: number;
      at?: number;
      id?: string;
    };

function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label}不能为空`);
  return value.trim();
}
function number(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label}必须是有效秒数`);
  return value;
}
export function parseCharacterActionEdit(raw: unknown): CharacterActionEdit {
  if (!raw || typeof raw !== "object") throw new Error("动作编辑格式无效");
  const v = raw as CharacterActionEdit;
  const objectId = text(v.objectId, "人物 ID");
  if (v.type === "extract_hold_actions") return { type: v.type, objectId,
    ...(v.motionClipId !== undefined ? { motionClipId: text(v.motionClipId, "移动片段 ID") } : {}) };
  if (v.type === "set_action_clip") {
    if (v.source === null) throw new Error("动作源范围无效");
    const clip = {
      id: v.clipId === undefined ? "action_new" : text(v.clipId, "动作片段 ID"),
      start: number(v.start, "开始"),
      end: number(v.end, "结束"),
      actionId: v.actionId,
      source: v.source ?? {
        duration: v.end - v.start,
        in: 0,
        out: v.end - v.start,
      },
      ...(v.name !== undefined ? { name: v.name } : {}),
      ...(v.loop !== undefined ? { loop: v.loop } : {}),
      ...(v.muted !== undefined ? { muted: v.muted } : {}),
      ...(v.blendIn !== undefined ? { blendIn: v.blendIn } : {}),
      ...(v.blendOut !== undefined ? { blendOut: v.blendOut } : {}),
      ...(v.layer !== undefined ? { layer: v.layer } : {}),
      ...(v.freezeAt != null ? { freezeAt: v.freezeAt } : {}),
      ...(v.automaticLocomotion !== undefined ? { automaticLocomotion: v.automaticLocomotion } : {}),
      ...(v.endExclusive !== undefined ? { endExclusive: v.endExclusive } : {}),
    };
    validateCharacterActionClips([{ ...clip, blendIn: undefined, blendOut: undefined }]);
    // Existing edits may retain a longer source than their cropped destination.
    // Its envelope is checked against that actual source after resolving the clip.
    validateCharacterActionBlend(clip, v.source !== undefined || v.clipId === undefined ? clip.source.duration : undefined);
    return {
      type: v.type,
      objectId,
      ...(v.clipId !== undefined ? { clipId: clip.id } : {}),
      start: clip.start,
      end: clip.end,
      actionId: clip.actionId,
      ...(v.source !== undefined ? { source: { ...v.source } } : {}),
      ...(v.name !== undefined ? { name: v.name } : {}),
      ...(v.loop !== undefined ? { loop: v.loop } : {}),
      ...(v.muted !== undefined ? { muted: v.muted } : {}),
      ...(v.blendIn !== undefined ? { blendIn: v.blendIn } : {}),
      ...(v.blendOut !== undefined ? { blendOut: v.blendOut } : {}),
      ...(v.layer !== undefined ? { layer: v.layer } : {}),
      ...(v.freezeAt !== undefined ? { freezeAt: v.freezeAt } : {}),
      ...(v.automaticLocomotion !== undefined ? { automaticLocomotion: v.automaticLocomotion } : {}),
      ...(v.endExclusive !== undefined ? { endExclusive: v.endExclusive } : {}),
    };
  }
  if (
    v.type !== "edit_action_clip" ||
    !["move", "trim", "stretch", "duplicate", "split", "remove"].includes(
      v.action,
    )
  )
    throw new Error("未知动作编辑");
  const clipId = text(v.clipId, "动作片段 ID");
  const times = Object.fromEntries(
    (["start", "end", "at"] as const)
      .filter((key) => v[key] !== undefined)
      .map((key) => [key, number(v[key], key)]),
  );
  if (v.action === "move" && v.start === undefined)
    throw new Error("移动动作需要 start");
  if (v.action === "split" && v.at === undefined)
    throw new Error("分割动作需要 at");
  if (
    (v.action === "trim" || v.action === "stretch") &&
    v.start === undefined &&
    v.end === undefined
  )
    throw new Error("裁剪或拉伸需要开始或结束秒数");
  return {
    type: v.type,
    objectId,
    clipId,
    action: v.action,
    ...times,
    ...(v.id !== undefined ? { id: text(v.id, "新动作片段 ID") } : {}),
  };
}


export function editCharacterAction(
  project: DirectorProject,
  raw: CharacterActionEdit,
) {
  const input = parseCharacterActionEdit(raw),
    object = project.objects.find((o) => o.id === input.objectId);
  if (!object || object.kind !== "character")
    throw new Error("动作轨道需要有效人物");
  if (object.locked) throw new Error("人物已锁定");
  if (input.type === "extract_hold_actions") {
    const result = extractLegacyHoldActions(project, object.id, input.motionClipId);
    return { ...result, clipId: result.clipIds[0] ?? null };
  }
  const clips = object.actionClips ?? [];
  validateCharacterActionClips(clips);
  const old = clips.find((c) => c.id === input.clipId);
  let clipId: string | null = input.clipId ?? null,
    next: DirectorCharacterActionClip[];
  if (input.type === "set_action_clip") {
    requireCharacterAction(project, object, input.actionId);
    clipId = old?.id ?? nextPerformanceClipId(clips, "action", input.clipId);
    const start = input.start,
      end = input.end;
    // Replacing an action keeps the edited source range unless explicitly replaced.
    const clip: DirectorCharacterActionClip = {
      ...old,
      id: clipId,
      start,
      end,
      actionId: input.actionId,
      source: input.source ??
        old?.source ?? { duration: end - start, in: 0, out: end - start },
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.loop !== undefined ? { loop: input.loop } : {}),
      ...(input.muted !== undefined ? { muted: input.muted } : {}),
      ...(input.blendIn !== undefined ? { blendIn: input.blendIn } : {}),
      ...(input.blendOut !== undefined ? { blendOut: input.blendOut } : {}),
      ...(input.layer !== undefined ? { layer: input.layer } : {}),
      ...(input.freezeAt != null ? { freezeAt: input.freezeAt } : {}),
      ...(input.automaticLocomotion !== undefined ? { automaticLocomotion: input.automaticLocomotion } : {}),
      ...(input.endExclusive !== undefined ? { endExclusive: input.endExclusive } : {}),
    };
    if (input.freezeAt === null) delete clip.freezeAt;
    next = [...clips.filter((c) => c.id !== clipId), clip];
  } else {
    if (!old) throw new Error("动作片段不存在");
    const sameLayer = (clip: DirectorCharacterActionClip) => (clip.layer ?? "override") === (old.layer ?? "override");
    const result=editPerformanceClip(clips.filter(sameLayer),input,"action","动作",clips);
    next=[...clips.filter(clip => !sameLayer(clip)), ...result.clips]; clipId=result.clipId;
  }
  validateCharacterActionClips(next);
  const { actionClips: _previous, ...rest } = object;
  const updated: DirectorObject = {
    ...rest,
    ...(next.length
      ? { actionClips: next.sort((a, b) => a.start - b.start) }
      : {}),
  };
  return {
    clipId,
    object: updated,
    project: ensureSceneTimeline({
      ...project,
      objects: project.objects.map((o) => (o.id === object.id ? updated : o)),
    }),
  };
}
