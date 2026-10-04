// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { motionClipSource, motionClipSourceSeconds, motionClipSceneSeconds, validateMotionClipSource } from './motionClipTime.js';
import type {
  DirectorObject,
  DirectorObjectMotionClip,
  DirectorObjectMotionKeyframe,
  DirectorObjectMotionPath,
  DirectorRouteCubicBezier,
  DirectorTransform,
} from "./directorProject.js";
import {
  createRouteTimingPlan,
  getRouteTimingPosition,
  interpolateRoutePosition,
  sampleRouteTiming,
} from "./routeTiming.js";
import type { RouteTimingPlan, RouteTimingPoint, RouteTimingSample } from "./routeTiming.js";

/**
 * Object motion, in scene seconds.
 *
 * A character's or prop's route lives in clips. A clip owns a span of the scene
 * timeline — `start` to `end`, in seconds — and the keyframes inside it, each
 * timed in seconds from the clip's start. Between two clips an object stands
 * where the earlier one left it; before its first clip it waits at that clip's
 * first point; after its last it stays at the last. Sampling asks for a scene
 * time and never needs to know how long any camera's shot is.
 *
 * Before clips (project version 1) a route was one `motionPath` whose keyframe
 * times ran 0–1 against whichever camera happened to be asking, so the same
 * walk took six seconds under one camera and ten under another. That shape is
 * still normalised here, for the migration and nothing else.
 */

export const DEFAULT_OBJECT_MOTION_CLIP_SECONDS = 6;
/** A clip shorter than this cannot hold two distinct moments. */
export const MIN_OBJECT_MOTION_CLIP_SECONDS = 0.01;
/**
 * Metres per second below which an object counts as standing. The character
 * runtimes use it to decide whether a character with no route action of its
 * own walks or keeps its pose.
 */
export const OBJECT_MOTION_MOVING_SPEED = 0.01;
const SPEED_WINDOW_SECONDS = 0.012;

export const DEFAULT_OBJECT_MOTION_PATH: DirectorObjectMotionPath = {
  interpolation: "smooth",
  speedMode: "uniform",
  customEasing: [0, 0, 1, 1],
  keyframes: [],
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function tuple(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  return [finite(value[0], fallback[0]), finite(value[1], fallback[1]), finite(value[2], fallback[2])];
}

function cubicBezier(value: unknown): DirectorRouteCubicBezier | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  return value.map((item, index) => clamp(finite(item, index < 2 ? 0 : 1))) as DirectorRouteCubicBezier;
}

function speedMode(value: unknown) {
  return value === "uniform" || value === "soft" || value === "custom" ? value : undefined;
}

function normalizeTransform(value: unknown, fallback: DirectorTransform): DirectorTransform {
  if (!value || typeof value !== "object") {
    return {
      position: [...fallback.position],
      rotation: [...fallback.rotation],
      scale: [...fallback.scale],
    };
  }
  const transform = value as Partial<DirectorTransform>;
  return {
    position: tuple(transform.position, fallback.position),
    rotation: tuple(transform.rotation, fallback.rotation),
    scale: tuple(transform.scale, fallback.scale),
  };
}

const FALLBACK_TRANSFORM: DirectorTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

function normalizeKeyframe(
  entry: unknown,
  index: number,
  fallbackTransform: DirectorTransform,
  clampTime: (time: number) => number,
): DirectorObjectMotionKeyframe | null {
  if (!entry || typeof entry !== "object") return null;
  const keyframe = entry as Partial<DirectorObjectMotionKeyframe>;
  return {
    id: typeof keyframe.id === "string" && keyframe.id ? keyframe.id : `object_motion_${index + 1}`,
    time: clampTime(finite(keyframe.time, index)),
    transform: normalizeTransform(keyframe.transform, fallbackTransform),
    actionPresetId: typeof keyframe.actionPresetId === "string" ? keyframe.actionPresetId : null,
    facingMode: keyframe.facingMode === "path" ? "path" : "manual",
    pointBehavior: keyframe.pointBehavior === "hold" ? "hold" : "pass",
    holdSeconds: Math.max(0, finite(keyframe.holdSeconds, 0)),
    holdAction:
      keyframe.holdAction === "stand" || keyframe.holdAction === "custom" || keyframe.holdAction === "track"
        ? keyframe.holdAction
        : "current",
    ...(keyframe.holdAction === "track" ? {} : { holdActionPresetId:
      typeof keyframe.holdActionPresetId === "string" ? keyframe.holdActionPresetId : null }),
  };
}

function isKeyframe(entry: DirectorObjectMotionKeyframe | null): entry is DirectorObjectMotionKeyframe {
  return Boolean(entry);
}

/* ── the v1 shape ─────────────────────────────────────────────────────────── */

/** A version-1 route: keyframes timed 0–1 against the camera that was asking. */
export function normalizeObjectMotionPath(
  value: unknown,
  fallbackTransform: DirectorTransform = FALLBACK_TRANSFORM
): DirectorObjectMotionPath {
  if (!value || typeof value !== "object") return { ...DEFAULT_OBJECT_MOTION_PATH, keyframes: [] };
  const path = value as Partial<DirectorObjectMotionPath>;
  const keyframes = Array.isArray(path.keyframes)
    ? path.keyframes
        .map((entry, index) => normalizeKeyframe(entry, index, fallbackTransform, (time) => clamp(time)))
        .filter(isKeyframe)
        .sort((a, b) => a.time - b.time)
    : [];
  const mode = speedMode(path.speedMode);
  const customEasing = cubicBezier(path.customEasing);
  return {
    interpolation: path.interpolation === "linear" ? "linear" : "smooth",
    ...(mode ? { speedMode: mode } : {}),
    ...(customEasing ? { customEasing } : {}),
    keyframes,
  };
}

/**
 * Turns a v1 route into the one clip that plays it back unchanged: it spans
 * the seconds the route used to be stretched over, and every point lands at
 * the same moment it did. A route with no points has nothing to carry.
 */
export function migrateObjectMotionPath(
  path: unknown,
  fallbackTransform: DirectorTransform,
  durationSeconds: number,
  clipId: string,
): DirectorObjectMotionClip | null {
  const legacy = normalizeObjectMotionPath(path, fallbackTransform);
  if (legacy.keyframes.length === 0) return null;
  const end = Math.max(MIN_OBJECT_MOTION_CLIP_SECONDS, finite(durationSeconds, DEFAULT_OBJECT_MOTION_CLIP_SECONDS));
  return {
    id: clipId,
    start: 0,
    end,
    interpolation: legacy.interpolation,
    ...(legacy.speedMode ? { speedMode: legacy.speedMode } : {}),
    ...(legacy.customEasing ? { customEasing: legacy.customEasing } : {}),
    keyframes: legacy.keyframes.map((keyframe) => ({ ...keyframe, time: keyframe.time * end })),
  };
}

/* ── clips ────────────────────────────────────────────────────────────────── */

export function getObjectMotionClipDuration(clip: Pick<DirectorObjectMotionClip, "start" | "end">) {
  return Math.max(MIN_OBJECT_MOTION_CLIP_SECONDS, clip.end - clip.start);
}

export function normalizeObjectMotionClip(
  value: unknown,
  fallbackTransform: DirectorTransform = FALLBACK_TRANSFORM,
  index = 0,
): DirectorObjectMotionClip | null {
  if (!value || typeof value !== "object") return null;
  const clip = value as Partial<DirectorObjectMotionClip>;
  const start = Math.max(0, finite(clip.start, 0));
  const end = Math.max(
    start + MIN_OBJECT_MOTION_CLIP_SECONDS,
    finite(clip.end, start + DEFAULT_OBJECT_MOTION_CLIP_SECONDS),
  );
  if (clip.source !== undefined) validateMotionClipSource(clip.source);
  const duration = clip.source?.duration ?? end - start;
  const keyframes = Array.isArray(clip.keyframes)
    ? clip.keyframes
        .map((entry, keyframeIndex) =>
          normalizeKeyframe(entry, keyframeIndex, fallbackTransform, (time) => clamp(time, 0, duration)))
        .filter(isKeyframe)
        .sort((a, b) => a.time - b.time)
    : [];
  const mode = speedMode(clip.speedMode);
  const customEasing = cubicBezier(clip.customEasing);
  return {
    id: typeof clip.id === "string" && clip.id ? clip.id : `object_motion_clip_${index + 1}`,
    ...(typeof clip.name === "string" && clip.name ? { name: clip.name } : {}),
    start,
    end,
    ...(clip.source ? { source: { ...clip.source } } : {}),
    interpolation: clip.interpolation === "linear" ? "linear" : "smooth",
    ...(mode ? { speedMode: mode } : {}),
    ...(customEasing ? { customEasing } : {}),
    keyframes,
  };
}

export function normalizeObjectMotionClips(
  value: unknown,
  fallbackTransform: DirectorTransform = FALLBACK_TRANSFORM,
): DirectorObjectMotionClip[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => normalizeObjectMotionClip(entry, fallbackTransform, index))
    .filter((clip): clip is DirectorObjectMotionClip => Boolean(clip))
    .sort((a, b) => a.start - b.start);
}

export function getObjectMotionClips(object: DirectorObject): DirectorObjectMotionClip[] {
  return normalizeObjectMotionClips(object.motionClips, object.transform);
}

/** A fresh clip, paced the way a new route always has been: uniform speed. */
export function createObjectMotionClip(input: {
  id: string;
  start: number;
  end: number;
  name?: string;
}): DirectorObjectMotionClip {
  const start = Math.max(0, input.start);
  return {
    id: input.id,
    ...(input.name ? { name: input.name } : {}),
    start,
    end: Math.max(start + MIN_OBJECT_MOTION_CLIP_SECONDS, input.end),
    interpolation: DEFAULT_OBJECT_MOTION_PATH.interpolation,
    speedMode: DEFAULT_OBJECT_MOTION_PATH.speedMode as DirectorObjectMotionClip["speedMode"],
    customEasing: [...(DEFAULT_OBJECT_MOTION_PATH.customEasing as DirectorRouteCubicBezier)] as DirectorRouteCubicBezier,
    keyframes: [],
  };
}

export function countObjectMotionKeyframes(object: DirectorObject) {
  return getObjectMotionClips(object).reduce((count, clip) => count + clip.keyframes.length, 0);
}

/** Whether the object has a route at all: at least `minKeyframes` points across its clips. */
export function hasObjectMotion(object: DirectorObject, minKeyframes = 1) {
  return countObjectMotionKeyframes(object) >= minKeyframes;
}

/** Index of the clip whose span contains `seconds`, or -1. */
export function findObjectMotionClipIndexAt(clips: DirectorObjectMotionClip[], seconds: number) {
  for (let index = clips.length - 1; index >= 0; index -= 1) {
    const clip = clips[index];
    if (seconds >= clip.start && seconds <= clip.end) return index;
  }
  return -1;
}

export function findObjectMotionKeyframe(
  clips: DirectorObjectMotionClip[],
  keyframeId: string,
): { clipIndex: number; keyframeIndex: number } | null {
  for (let clipIndex = 0; clipIndex < clips.length; clipIndex += 1) {
    const keyframeIndex = clips[clipIndex].keyframes.findIndex((keyframe) => keyframe.id === keyframeId);
    if (keyframeIndex >= 0) return { clipIndex, keyframeIndex };
  }
  return null;
}

/* ── where on the timeline a moment falls ─────────────────────────────────── */

interface ClipCursor {
  clip: DirectorObjectMotionClip;
  index: number;
  /** 0–1 through the clip's span. */
  local: number;
  phase: "before" | "inside" | "after";
}

/**
 * The clip that answers for a scene time. Clips are sorted by start; the
 * latest one that has begun answers — inside its span at the matching point,
 * past its end holding its last point. Before any clip has begun, the first
 * clip's first point stands in. Clips without points cannot answer.
 */
function resolveClipAt(clips: DirectorObjectMotionClip[], seconds: number): ClipCursor | null {
  let index = -1;
  for (let candidate = 0; candidate < clips.length; candidate += 1) {
    const clip = clips[candidate];
    if (clip.keyframes.length > 0 && clip.start <= seconds) index = candidate;
  }
  if (index < 0) {
    const first = clips.findIndex((clip) => clip.keyframes.length > 0);
    if (first < 0) return null;
    return { clip: clips[first], index: first, local: motionClipSource(clips[first]).in / motionClipSource(clips[first]).duration, phase: "before" };
  }
  const clip = clips[index];
  if (seconds > clip.end) return { clip, index, local: motionClipSource(clip).out / motionClipSource(clip).duration, phase: "after" };
  return {
    clip,
    index,
    local: motionClipSourceSeconds(clip, seconds) / motionClipSource(clip).duration,
    phase: "inside",
  };
}

/* ── inside one clip, on its own 0–1 ──────────────────────────────────────── */

function interpolate(a: number, b: number, progress: number) {
  return a + (b - a) * progress;
}

function interpolateAngle(a: number, b: number, progress: number) {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * progress;
}

function cloneTransform(transform: DirectorTransform): DirectorTransform {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  };
}

function clipPoints(clip: DirectorObjectMotionClip): RouteTimingPoint[] {
  const duration = motionClipSource(clip).duration;
  return clip.keyframes.map((keyframe) => ({
    time: keyframe.time / duration,
    position: keyframe.transform.position,
    pointBehavior: keyframe.pointBehavior,
    holdSeconds: keyframe.holdSeconds,
  }));
}

function createClipTimingPlan(clip: DirectorObjectMotionClip) {
  return createRouteTimingPlan({
    points: clipPoints(clip),
    duration: motionClipSource(clip).duration,
    interpolation: clip.interpolation,
    speedMode: clip.speedMode ?? "custom",
    customEasing: clip.customEasing,
  });
}

/** The pacing of a clip with a speed mode, or null for a legacy-timed one. */
export function getObjectMotionClipTimingPlan(clip: DirectorObjectMotionClip): RouteTimingPlan | null {
  if (!clip.speedMode || clip.keyframes.length < 2) return null;
  return createClipTimingPlan(clip);
}

function findLegacyMotionSegment(points: RouteTimingPoint[], progress: number) {
  const p = clamp(progress);
  let segment = 0;
  while (segment < points.length - 2 && p > points[segment + 1].time) segment += 1;
  const from = points[segment];
  const to = points[Math.min(points.length - 1, segment + 1)];
  const local = clamp((p - from.time) / Math.max(0.000001, to.time - from.time));
  return { local, segment };
}

function sampleClipTiming(clip: DirectorObjectMotionClip, progress: number): RouteTimingSample {
  if (!clip.speedMode) {
    const legacy = findLegacyMotionSegment(clipPoints(clip), progress);
    return { segment: legacy.segment, local: legacy.local, holdingPointIndex: null };
  }
  return sampleRouteTiming(createClipTimingPlan(clip), progress);
}

function samplePosition(clip: DirectorObjectMotionClip, progress: number): [number, number, number] {
  const points = clipPoints(clip);
  const first = points[0];
  const last = points[points.length - 1];
  if (progress <= first.time) return [...first.position];
  if (progress >= last.time) return [...last.position];
  if (!clip.speedMode) {
    const legacy = findLegacyMotionSegment(points, progress);
    return interpolateRoutePosition(points, legacy.segment, legacy.local, clip.interpolation);
  }
  return getRouteTimingPosition(createClipTimingPlan(clip), progress);
}

function getPathFacingYaw(clip: DirectorObjectMotionClip, progress: number) {
  const epsilon = 0.001;
  const points = clipPoints(clip);
  const before = samplePosition(clip, Math.max(points[0].time, progress - epsilon));
  const after = samplePosition(clip, Math.min(points[points.length - 1].time, progress + epsilon));
  const dx = after[0] - before[0];
  const dz = after[2] - before[2];
  return Math.hypot(dx, dz) > 0.000001 ? Math.atan2(dx, dz) : null;
}

function snapshotWithinClip(object: DirectorObject, clip: DirectorObjectMotionClip, progress: number): DirectorTransform {
  const points = clipPoints(clip);
  const p = clamp(progress);
  const first = clip.keyframes[0];
  const last = clip.keyframes[clip.keyframes.length - 1];
  if (p <= points[0].time) {
    const transform = cloneTransform(first.transform);
    const yaw = object.kind === "character" && first.facingMode === "path" ? getPathFacingYaw(clip, points[0].time) : null;
    if (yaw != null) transform.rotation[1] = yaw;
    return transform;
  }
  if (p >= points[points.length - 1].time) {
    const transform = cloneTransform(last.transform);
    const previous = clip.keyframes[clip.keyframes.length - 2];
    const yaw = object.kind === "character" && previous?.facingMode === "path"
      ? getPathFacingYaw(clip, points[points.length - 1].time)
      : null;
    if (yaw != null) transform.rotation[1] = yaw;
    return transform;
  }

  const { segment, local } = sampleClipTiming(clip, p);
  const from = clip.keyframes[segment];
  const to = clip.keyframes[Math.min(clip.keyframes.length - 1, segment + 1)];
  const mapTuple = (
    left: [number, number, number],
    right: [number, number, number],
    angle = false
  ) => left.map((value, axis) =>
    angle ? interpolateAngle(value, right[axis], local) : interpolate(value, right[axis], local)
  ) as [number, number, number];

  const rotation = mapTuple(from.transform.rotation, to.transform.rotation, true);
  if (object.kind === "character" && from.facingMode === "path") {
    const yaw = getPathFacingYaw(clip, p);
    if (yaw != null) rotation[1] = yaw;
  }

  return {
    position: samplePosition(clip, p),
    rotation,
    scale: mapTuple(from.transform.scale, to.transform.scale),
  };
}

/* ── the questions the rest of the desk asks ──────────────────────────────── */

/** The facing owner uses the same segment/end rules as the route transform.
 * A single point has no direction to follow. Before/after retain the endpoint policy. */
export function getObjectMotionFacingMode(object: DirectorObject, seconds: number): "path" | "manual" {
  const cursor = resolveClipAt(getObjectMotionClips(object), seconds);
  if (object.kind !== "character" || !cursor || cursor.clip.keyframes.length < 2) return "manual";
  const { clip, local } = cursor;
  const points = clipPoints(clip);
  const index = local <= points[0].time ? 0 : local >= points[points.length-1].time
    ? clip.keyframes.length-2 : sampleClipTiming(clip, local).segment;
  return clip.keyframes[index].facingMode === "path" ? "path" : "manual";
}

/** Where the object is at a scene time, in seconds. */
export function getObjectMotionSnapshot(object: DirectorObject, seconds: number): DirectorTransform {
  const cursor = resolveClipAt(getObjectMotionClips(object), seconds);
  if (!cursor) return cloneTransform(object.transform);
  return snapshotWithinClip(object, cursor.clip, cursor.local);
}

/** Geometric cursor used by continuous collision, including holds and source trims. */
export function getObjectMotionCurveCursor(object: DirectorObject, seconds: number) {
  const cursor = resolveClipAt(getObjectMotionClips(object), seconds);
  if (!cursor || cursor.clip.keyframes.length < 2) return null;
  const { clip, local } = cursor, points = clipPoints(clip);
  const coordinate = (p: number) => {
    if (p <= points[0].time) return 0;
    if (p >= points[points.length-1].time) return points.length-1;
    const timing = sampleClipTiming(clip,p);
    return timing.segment+timing.local;
  };
  return {clip,index:cursor.index,start:coordinate(motionClipSource(clip).in/motionClipSource(clip).duration),cursor:coordinate(local)};
}

export interface ObjectMotionTimingSample extends RouteTimingSample {
  clipIndex: number;
}

/** Which segment of which clip a scene time falls in; null without a two-point clip to be in. */
export function getObjectMotionTimingSample(object: DirectorObject, seconds: number): ObjectMotionTimingSample | null {
  const cursor = resolveClipAt(getObjectMotionClips(object), seconds);
  if (!cursor || cursor.clip.keyframes.length < 2) return null;
  return { clipIndex: cursor.index, ...sampleClipTiming(cursor.clip, cursor.local) };
}

/**
 * The route point a scene time is at or heading for, counted across every
 * clip in order — the number a route handle shows.
 */
export function getObjectMotionActiveKeyframeIndex(object: DirectorObject, seconds: number) {
  const clips = getObjectMotionClips(object);
  const cursor = resolveClipAt(clips, seconds);
  if (!cursor) return 0;
  const offset = clips.slice(0, cursor.index).reduce((count, clip) => count + clip.keyframes.length, 0);
  if (cursor.clip.keyframes.length < 2) return offset;
  const timing = sampleClipTiming(cursor.clip, cursor.local);
  return offset + (timing.holdingPointIndex ?? timing.segment);
}

/** Points along every clip's route, for drawing it. */
export function sampleObjectMotionPath(object: DirectorObject, count = 80): [number, number, number][] {
  const clips = getObjectMotionClips(object).filter((clip) => clip.keyframes.length > 0);
  if (clips.length === 0) return [object.transform.position];
  return clips.flatMap((clip) => {
    if (clip.keyframes.length === 1 || count < 2) return [clip.keyframes[0].transform.position];
    const points = clipPoints(clip);
    const source = motionClipSource(clip);
    const start = Math.max(points[0].time, source.in / source.duration);
    const end = Math.min(points[points.length - 1].time, source.out / source.duration);
    return Array.from({ length: count }, (_, index) =>
      samplePosition(clip, start + (end - start) * (index / (count - 1)))
    );
  });
}

export interface ObjectMotionClipSpans {
  /** Scene seconds at which each point is reached. */
  arrivals: number[];
  /** Scene seconds at which the object leaves each point again. */
  departures: number[];
}

/** When each of a clip's points is reached and left, on the scene timeline. */
export function getObjectMotionClipSpans(clip: DirectorObjectMotionClip): ObjectMotionClipSpans {
  const duration = motionClipSource(clip).duration;
  const plan = getObjectMotionClipTimingPlan(clip);
  if (!plan) {
    const times = clip.keyframes.map((keyframe) => motionClipSceneSeconds(clip, keyframe.time));
    return { arrivals: times, departures: [...times] };
  }
  return {
    arrivals: plan.arrivals.map((arrival) => motionClipSceneSeconds(clip, arrival * duration)),
    departures: plan.departures.map((departure) => motionClipSceneSeconds(clip, departure * duration)),
  };
}

export function getObjectMotionActionPresetId(object: DirectorObject, seconds: number) {
  return getObjectMotionActionSample(object, seconds).actionPresetId;
}

export interface ObjectMotionActionSample {
  actionPresetId: string | null;
  animationTimeSeconds: number;
  holdingPointIndex: number | null;
}

/**
 * What the object is doing at a scene time. Inside a clip each point's action
 * plays until the next point, and a hold plays its own. Before any clip has
 * begun the object has not set off, so it keeps its own pose; past a clip's
 * end it performs the action of the point it arrived at.
 */
export function getObjectMotionActionSample(object: DirectorObject, seconds: number): ObjectMotionActionSample {
  const cursor = resolveClipAt(getObjectMotionClips(object), seconds);
  if (!cursor) {
    return {
      actionPresetId: object.characterRig?.actionPresetId ?? null,
      animationTimeSeconds: seconds,
      holdingPointIndex: null,
    };
  }
  const { clip } = cursor;
  const keyframes = clip.keyframes;
  const source = motionClipSource(clip);
  const sourceSeconds = cursor.local * source.duration;
  const actionSeconds = clip.source ? source.origin + sourceSeconds : seconds;
  if (cursor.phase === "before") {
    return { actionPresetId: null, animationTimeSeconds: seconds, holdingPointIndex: null };
  }
  if (keyframes.length === 1) return { actionPresetId: keyframes[0].actionPresetId ?? null, animationTimeSeconds: clip.source ? source.origin + motionClipSourceSeconds(clip, seconds, false) : seconds, holdingPointIndex: null };
  if (cursor.phase === "after" && source.out >= source.duration) {
    const last = keyframes[keyframes.length - 1];
    return { actionPresetId: last.actionPresetId ?? null, animationTimeSeconds: clip.source ? source.origin + source.out + Math.max(0, seconds - clip.end) * (source.out - source.in) / getObjectMotionClipDuration(clip) : seconds, holdingPointIndex: null };
  }
  if (!clip.speedMode) {
    const { segment } = findLegacyMotionSegment(clipPoints(clip), cursor.local);
    return {
      actionPresetId: keyframes[segment]?.actionPresetId ?? null,
      animationTimeSeconds: actionSeconds,
      holdingPointIndex: null,
    };
  }
  const plan = createClipTimingPlan(clip);
  const timing = sampleRouteTiming(plan, cursor.local);
  if (timing.holdingPointIndex != null) {
    const point = keyframes[timing.holdingPointIndex];
    if (point.holdAction === "track") {
      return { actionPresetId: null, animationTimeSeconds: actionSeconds, holdingPointIndex: timing.holdingPointIndex };
    }
    if (point.holdAction === "stand") {
      return { actionPresetId: null, animationTimeSeconds: 0, holdingPointIndex: timing.holdingPointIndex };
    }
    if (point.holdAction === "custom") {
      const holdStart = plan.arrivals[timing.holdingPointIndex] * source.duration;
      return {
        actionPresetId: point.holdActionPresetId ?? null,
        animationTimeSeconds: Math.max(0, sourceSeconds - holdStart),
        holdingPointIndex: timing.holdingPointIndex,
      };
    }
    return {
      actionPresetId: keyframes[Math.max(0, timing.holdingPointIndex - 1)]?.actionPresetId ?? null,
      animationTimeSeconds: actionSeconds,
      holdingPointIndex: timing.holdingPointIndex,
    };
  }
  return {
    actionPresetId: keyframes[timing.segment]?.actionPresetId ?? null,
    animationTimeSeconds: actionSeconds,
    holdingPointIndex: null,
  };
}

/** Metres per second at a scene time. */
export function getObjectMotionSpeed(object: DirectorObject, seconds: number) {
  const from = Math.max(0, seconds - SPEED_WINDOW_SECONDS);
  const to = seconds + SPEED_WINDOW_SECONDS;
  const before = getObjectMotionSnapshot(object, from);
  const after = getObjectMotionSnapshot(object, to);
  return Math.hypot(
    after.position[0] - before.position[0],
    after.position[1] - before.position[1],
    after.position[2] - before.position[2]
  ) / Math.max(0.000001, to - from);
}
