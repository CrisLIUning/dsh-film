// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type {
  DirectorCharacterActionClip,
  DirectorObject,
} from "./directorProject.js";
import {
  getObjectMotionActionSample,
  getObjectMotionSpeed,
  getObjectMotionFacingMode,
  hasObjectMotion,
  OBJECT_MOTION_MOVING_SPEED,
} from "./objectMotion.js";

/** Imported animation is sampled in place; travel remains in the editable route. */
export const CHARACTER_ACTION_MOTION_POLICY = {
  horizontal: "route",
  vertical: "animation",
  heading: "route-when-path-facing",
  requiresPelvisMapping: true,
} as const;

export function characterHeadingSource(object: DirectorObject, seconds: number): "route" | "animation" {
  return getObjectMotionFacingMode(object, seconds) === "path" ? "route" : "animation";
}

export function validateCharacterActionBlend(clip: { blendIn?: number; blendOut?: number }, duration?: number) {
  const blendIn = clip.blendIn === undefined ? 0 : clip.blendIn;
  const blendOut = clip.blendOut === undefined ? 0 : clip.blendOut;
  if (![blendIn, blendOut].every(Number.isFinite) || blendIn < 0 || blendOut < 0 ||
    (duration !== undefined && blendIn + blendOut > duration + 1e-9))
    throw new Error("动作淡入淡出需为非负秒数，总长不能超过动作源时长");
}

/** A base track and a full-body override. Missing intervals retain route/base behavior. */
export function validateCharacterActionClips(
  raw: unknown,
): asserts raw is DirectorCharacterActionClip[] | undefined {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) throw new Error("动作轨道必须是片段数组");
  const ids = new Set<string>();
  for (const clip of raw) {
    if (
      !clip ||
      typeof clip !== "object" ||
      typeof clip.id !== "string" ||
      !clip.id.trim() ||
      clip.id !== clip.id.trim() ||
      ids.has(clip.id)
    )
      throw new Error("动作片段 ID 为空或重复");
    ids.add(clip.id);
    if (
      ![clip.start, clip.end].every(Number.isFinite) ||
      clip.start < 0 ||
      clip.end <= clip.start
    )
      throw new Error("动作片段需要有效的场景起止秒数");
    if (
      clip.actionId !== null &&
      (typeof clip.actionId !== "string" || !clip.actionId.trim())
    )
      throw new Error("动作 ID 必须是非空字符串或 null（基础姿势）");
    if (
      clip.name !== undefined &&
      (typeof clip.name !== "string" || !clip.name.trim())
    )
      throw new Error("动作片段名称不能为空");
    if (clip.loop !== undefined && typeof clip.loop !== "boolean")
      throw new Error("动作循环必须是布尔值");
    if (clip.muted !== undefined && typeof clip.muted !== "boolean")
      throw new Error("动作静音必须是布尔值");
    if (clip.layer !== undefined && clip.layer !== "base" && clip.layer !== "override")
      throw new Error("动作层必须是 base 或 override");
    if (clip.freezeAt !== undefined && (!Number.isFinite(clip.freezeAt) || clip.freezeAt < 0))
      throw new Error("动作定格时间必须是非负秒数");
    for (const key of ["automaticLocomotion", "endExclusive"] as const)
      if (clip[key] !== undefined && typeof clip[key] !== "boolean") throw new Error(`${key} 必须是布尔值`);
    if (
      !clip.source ||
      ![clip.source.duration, clip.source.in, clip.source.out].every(
        Number.isFinite,
      ) ||
      clip.source.duration <= 0 ||
      clip.source.in < 0 ||
      clip.source.out <= clip.source.in ||
      clip.source.out > clip.source.duration
    )
      throw new Error("动作源范围必须是递增的非负秒数");
    validateCharacterActionBlend(clip, clip.source.duration);
  }
  for (const layer of ["base", "override"] as const) {
    const sorted = raw.filter(clip => (clip.layer ?? "override") === layer).sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++)
      if (sorted[i].start < sorted[i - 1].end)
        throw new Error("同一人物同一层的全身动作片段不能重叠");
  }
}

export interface CharacterActionSample {
  actionPresetId: string | null;
  animationTimeSeconds: number;
  /** A null action in a clip explicitly keeps the base pose; it is not an auto-walk request. */
  source: "clip" | "route" | "locomotion" | "base";
  actionClipId: string | null;
  loop: boolean;
  holdingPointIndex: number | null;
}

/** Retiming performance never samples or changes the route transform. */
export function characterActionSourceSeconds(
  clip: Pick<DirectorCharacterActionClip, "start" | "end" | "source">,
  seconds: number,
) {
  const t = Math.max(
    0,
    Math.min(1, (seconds - clip.start) / (clip.end - clip.start)),
  );
  return clip.source.in + t * (clip.source.out - clip.source.in);
}

/** Latest start wins at a shared boundary; otherwise the last frame at a clip end is retained. */
export function getCharacterActionClipAt(
  object: DirectorObject,
  seconds: number,
  layer: "base" | "override" = "override",
) {
  let found: DirectorCharacterActionClip | null = null;
  for (const clip of object.actionClips ?? [])
    if (
      !clip.muted &&
      (clip.layer ?? "override") === layer &&
      seconds >= clip.start &&
      (clip.endExclusive ? seconds < clip.end : seconds <= clip.end) &&
      (!found || clip.start > found.start)
    )
      found = clip;
  return found;
}

/** The lower performance layer keeps its own scene/hold clock. */
export function sampleCharacterBaseAction(object: DirectorObject, seconds: number): CharacterActionSample {
  const clip = getCharacterActionClipAt(object, seconds, "base");
  return clip ? sampleActionClip(object, clip, seconds) : sampleRouteAction(object, seconds);
}

export interface CharacterPerformanceLayer extends CharacterActionSample { weight: number }

/** Source-relative envelopes survive crop/split and scale with a stretched clip. */
export function characterPerformanceWeight(clip: Pick<DirectorCharacterActionClip, "start" | "end" | "source" | "blendIn" | "blendOut">, seconds: number) {
  const source = characterActionSourceSeconds(clip, seconds);
  const smooth = (value: number) => { const t = Math.min(1, Math.max(0, value)); return t * t * (3 - 2 * t); };
  return (clip.blendIn ? smooth(source / clip.blendIn) : 1)
    * (clip.blendOut ? smooth((clip.source.duration - source) / clip.blendOut) : 1);
}

/** Full-body override over the continuously sampled route/base layer. Head aiming
 * is applied afterwards. Keep zero-weight sources so renderers can resolve both
 * animations at the boundary instead of changing players each frame. */
export function sampleCharacterPerformance(object: DirectorObject, seconds: number): CharacterPerformanceLayer[] {
  let layers: CharacterPerformanceLayer[] = [{ ...sampleRouteAction(object, seconds), weight: 1 }];
  for (const layer of ["base", "override"] as const) {
    const clip = getCharacterActionClipAt(object, seconds, layer);
    if (!clip) continue;
    const primary = sampleActionClip(object, clip, seconds);
    if (!clip.blendIn && !clip.blendOut) layers = [{ ...primary, weight: 1 }];
    else {
      const weight = characterPerformanceWeight(clip, seconds);
      layers = [...layers.map(sample => ({ ...sample, weight: sample.weight * (1 - weight) })), { ...primary, weight }];
    }
  }
  return layers;
}

/** Shared by every runtime and the daemon; no browser state or playback-running flag. */
export function sampleCharacterAction(
  object: DirectorObject,
  seconds: number,
): CharacterActionSample {
  const clip = getCharacterActionClipAt(object, seconds);
  return clip ? sampleActionClip(object, clip, seconds) : sampleCharacterBaseAction(object, seconds);
}

function sampleActionClip(object: DirectorObject, clip: DirectorCharacterActionClip, seconds: number): CharacterActionSample {
  return {
      actionPresetId: clip.automaticLocomotion && getObjectMotionSpeed(object, seconds) > OBJECT_MOTION_MOVING_SPEED
        ? "walk-cycle" : clip.actionId,
      animationTimeSeconds: clip.freezeAt ?? characterActionSourceSeconds(clip, seconds),
      source: "clip",
      actionClipId: clip.id,
      loop: clip.loop ?? true,
      holdingPointIndex: getObjectMotionActionSample(object, seconds).holdingPointIndex,
    };
}

function sampleRouteAction(object: DirectorObject, seconds: number): CharacterActionSample {
  const route = getObjectMotionActionSample(object, seconds);
  if (route.actionPresetId)
    return {
      ...route,
      source: hasObjectMotion(object) ? "route" : "base",
      actionClipId: null,
      loop: true,
    };
  const walking =
    getObjectMotionSpeed(object, seconds) > OBJECT_MOTION_MOVING_SPEED;
  return {
    ...route,
    actionPresetId: walking
      ? "walk-cycle"
      : (object.characterRig?.actionPresetId ?? null),
    source: walking ? "locomotion" : "base",
    actionClipId: null,
    loop: true,
  };
}

/** Renderers use their actual animation duration, including imported/native clip variants. */
export function characterActionPhase(
  seconds: number,
  duration: number,
  loop: boolean,
) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(seconds))
    return 0;
  return loop
    ? (((seconds % duration) + duration) % duration) / duration
    : Math.max(0, Math.min(1, seconds / duration));
}

/** Shared transport and viewport eligibility; stationary performances are playable too. */
export function hasObjectPerformance(object:DirectorObject) {
  return hasObjectMotion(object,2) || Boolean(object.characterRig?.actionPresetId)
    || Boolean(object.actionClips?.some(clip=>!clip.muted)) || Boolean(object.lookClips?.some(clip=>!clip.muted));
}
