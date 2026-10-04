// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type {
  DirectorProject,
  DirectorRouteEventAnchor,
  DirectorSceneEvent,
} from "./directorProject.js";
import { getObjectMotionClips, getObjectMotionClipSpans } from "./objectMotion.js";

type EventProject = Pick<DirectorProject, "objects"> & {
  timeline?: { events?: DirectorSceneEvent[] };
};
export type SceneEventTime = number | { eventId: string; offset?: number };
export interface ResolvedSceneEvent {
  id: string;
  name: string;
  kind: "arrival" | "departure" | "marker";
  time: number | null;
  objectId?: string;
  clipId?: string;
  keyframeId?: string;
  anchor?: DirectorRouteEventAnchor;
  issue?: string;
}
const text = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label}不能为空`);
  return value.trim();
};
export function parseSceneEventAnchor(
  value: unknown,
): DirectorRouteEventAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("事件来源必须是路线点");
  const v = value as DirectorRouteEventAnchor;
  if (v.edge !== "arrival" && v.edge !== "departure")
    throw new Error("事件边界必须是 arrival 或 departure");
  if (v.offset !== undefined && !Number.isFinite(v.offset))
    throw new Error("事件偏移必须是有限秒数");
  return {
    objectId: text(v.objectId, "对象 ID"),
    clipId: text(v.clipId, "片段 ID"),
    keyframeId: text(v.keyframeId, "路线点 ID"),
    edge: v.edge,
    ...(v.offset !== undefined ? { offset: v.offset } : {}),
  };
}
export function validateSceneEvents(
  events: unknown,
): asserts events is DirectorSceneEvent[] | undefined {
  if (events === undefined) return;
  if (!Array.isArray(events)) throw new Error("场景事件必须是数组");
  const ids = new Set<string>();
  for (const event of events) {
    if (!event || typeof event !== "object")
      throw new Error("场景事件格式无效");
    const id = text(event.id, "事件 ID");
    text(event.name, "事件名称");
    if (id.startsWith("route:") || ids.has(id))
      throw new Error("事件 ID 重复或占用路线事件命名空间");
    ids.add(id);
    if (typeof event.at === "number") {
      if (!Number.isFinite(event.at) || event.at < 0)
        throw new Error("事件秒数必须大于等于零");
    } else parseSceneEventAnchor(event.at);
  }
}
export function routeEventId(anchor: DirectorRouteEventAnchor) {
  return `route:${JSON.stringify([anchor.objectId, anchor.clipId, anchor.keyframeId, anchor.edge])}`;
}
/** Planned route times, not proof that collision resolution or acting reached a semantic goal. */
function routeEvents(project: EventProject): ResolvedSceneEvent[] {
  const result: ResolvedSceneEvent[] = [];
  for (const object of project.objects) {
    let pointNumber = 0;
    for (const clip of getObjectMotionClips(object)) {
      const { arrivals, departures } = getObjectMotionClipSpans(clip);
      for (const [index, key] of clip.keyframes.entries()) {
        pointNumber++;
        for (const edge of ["arrival", "departure"] as const) {
          const time = edge === "arrival" ? arrivals[index] : departures[index];
          if (
            edge === "departure" &&
            departures[index] - arrivals[index] < 1e-9
          )
            continue;
          const anchor = {
            objectId: object.id,
            clipId: clip.id,
            keyframeId: key.id,
            edge,
          };
          const visible = time >= clip.start - 1e-9 && time <= clip.end + 1e-9;
          result.push({
            id: routeEventId(anchor),
            kind: edge,
            anchor,
            objectId: object.id,
            clipId: clip.id,
            keyframeId: key.id,
            name: `${object.name} · ${clip.name ?? clip.id} · 点 ${pointNumber}${edge === "arrival" ? " 到达" : " 停留结束"}`,
            time: visible
              ? Math.max(clip.start, Math.min(clip.end, time))
              : null,
            ...(!visible ? { issue: "路线时刻已被裁出片段" } : {}),
          });
        }
      }
    }
  }
  return result;
}
export function listSceneEvents(project: EventProject): ResolvedSceneEvent[] {
  validateSceneEvents(project.timeline?.events);
  const routes = routeEvents(project),
    byId = new Map(routes.map((event) => [event.id, event]));
  const markers = (project.timeline?.events ?? []).map(
    (marker): ResolvedSceneEvent => {
      if (typeof marker.at === "number")
        return {
          id: marker.id,
          name: marker.name,
          kind: "marker",
          time: marker.at,
        };
      const anchor = marker.at,
        source = byId.get(routeEventId(anchor));
      const time =
        source?.time == null ? null : source.time + (anchor.offset ?? 0);
      const issue = !source
        ? "来源路线点或停留已不存在"
        : (source.issue ??
          (time != null && time < 0
            ? "偏移后的事件在场景开始之前"
            : undefined));
      return {
        id: marker.id,
        name: marker.name,
        kind: "marker",
        time: issue ? null : time,
        anchor,
        objectId: anchor.objectId,
        clipId: anchor.clipId,
        keyframeId: anchor.keyframeId,
        ...(issue ? { issue } : {}),
      };
    },
  );
  // Hidden source points are useful only when a named marker needs repair.
  return [...routes.filter((event) => event.time !== null), ...markers].sort(
    (a, b) =>
      (a.time ?? Infinity) - (b.time ?? Infinity) || a.id.localeCompare(b.id),
  );
}
export function sceneEventContentEnd(project: EventProject) {
  if (!project.timeline?.events?.length) return 0;
  return Math.max(
    0,
    ...listSceneEvents(project)
      .filter((event) => event.kind === "marker")
      .map((event) => event.time ?? 0),
  );
}
export function parseSceneEventTime(value: unknown): SceneEventTime {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { eventId: string; offset?: number };
    if (v.offset !== undefined && !Number.isFinite(v.offset))
      throw new Error("事件偏移必须是有限秒数");
    return {
      eventId: text(v.eventId, "事件 ID"),
      ...(v.offset !== undefined ? { offset: v.offset } : {}),
    };
  }
  throw new Error("时间需要非负秒数或 {eventId, offset?}");
}
export function resolveSceneEventTime(
  project: EventProject,
  raw: SceneEventTime,
): number {
  const value = parseSceneEventTime(raw);
  if (typeof value === "number") return value;
  const event = listSceneEvents(project).find(
    (event) => event.id === value.eventId,
  );
  if (!event) throw new Error(`事件不存在或已裁出：${value.eventId}`);
  if (event.time == null)
    throw new Error(`${event.name}：${event.issue ?? "事件尚未定位"}`);
  const time = event.time + (value.offset ?? 0);
  if (!Number.isFinite(time) || time < 0)
    throw new Error("偏移后的时间必须大于等于零");
  return time;
}
