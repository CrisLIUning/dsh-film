// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type {
  DirectorCharacterLookClip,
  DirectorCharacterLookTarget,
  DirectorObject,
  SceneSettings,
} from "./directorProject.js";
import {
  characterPerformanceWeight,
  validateCharacterActionClips,
} from "./characterPerformance.js";
import { hasObjectMotion } from "./objectMotion.js";
import { getConstrainedObjectMotionSnapshot } from "./routeCollision.js";
import { getDirectorObjectFocusTarget } from "./cameraTarget.js";
import { getUE4GroundedLabelY } from "../runtime/ue4Mannequin/ue4MannequinBody.js";
import { getGroundedLabelY } from "../runtime/mannequin/bodyTypes.js";
import { add, applyEulerXYZ, multiply, type Vec3 } from "./vec3.js";

export function validateCharacterLookClips(
  raw: unknown,
): asserts raw is DirectorCharacterLookClip[] | undefined {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) throw new Error("看向轨道必须是片段数组");
  // The two independent tracks deliberately share time, id, source and overlap invariants.
  try {
    validateCharacterActionClips(
      raw.map((clip) => ({ ...clip, actionId: null })),
    );
  } catch (error) {
    throw new Error(
      (error as Error).message.replace(/动作/g, "看向").replace("全身", "头部"),
    );
  }
  for (const clip of raw) {
    const t = clip.target;
    if (!t || (t.kind !== "object" && t.kind !== "point"))
      throw new Error("看向目标必须是对象或场景位置");
    if (
      t.kind === "point" &&
      (!Array.isArray(t.position) ||
        t.position.length !== 3 ||
        !t.position.every(Number.isFinite))
    )
      throw new Error("看向位置需要三个有效坐标");
    if (
      t.kind === "object" &&
      (typeof t.objectId !== "string" ||
        !t.objectId.trim() ||
        !["head", "center"].includes(t.bodyPart))
    )
      throw new Error("看向对象和部位无效");
    if (
      ![clip.blendIn, clip.blendOut, clip.strength].every(Number.isFinite) ||
      clip.blendIn < 0 ||
      clip.blendOut < 0 ||
      clip.blendIn + clip.blendOut > clip.source.duration + 1e-9 ||
      clip.strength < 0 ||
      clip.strength > 1
    )
      throw new Error("看向强度需在 0–1，转入转出时长不能超过源范围");
  }
}
export function getCharacterLookClipAt(
  object: DirectorObject,
  seconds: number,
) {
  return (
    (object.lookClips ?? [])
      .filter((c) => !c.muted && seconds >= c.start && seconds <= c.end)
      .sort((a, b) => b.start - a.start)[0] ?? null
  );
}
export function characterLookWeight(clip: DirectorCharacterLookClip, seconds: number) {
  return clip.strength * characterPerformanceWeight(clip, seconds);
}
export type CharacterLookResolver = (
  object: DirectorObject,
  part: "head" | "center",
) => Vec3 | null;
/** Deterministic semantic target. Runtime may supply the currently animated head; daemon uses an explicitly approximate anchor. */
export function resolveCharacterLookTarget(
  target: DirectorCharacterLookTarget,
  objects: DirectorObject[],
  scene: SceneSettings,
  seconds: number,
  resolver?: CharacterLookResolver,
) {
  if (target.kind === "point")
    return { position: [...target.position] as Vec3, approximate: false };
  const object = objects.find((o) => o.id === target.objectId);
  if (!object) return null;
  const transform = hasObjectMotion(object)
    ? getConstrainedObjectMotionSnapshot(
        object,
        seconds,
        scene,
        objects,
      )
    : object.transform;
  const animated = { ...object, transform };
  const resolved = resolver?.(animated, target.bodyPart);
  if (resolved) return { position: resolved, approximate: false };
  if (target.bodyPart === "center" || object.kind !== "character")
    return {
      position: getDirectorObjectFocusTarget(animated),
      approximate: true,
    };
  const height = object.heightMetres ?? (object.assetRefId
    ? 1.8
    : object.characterRig?.rigType === "ue4-mannequin"
      ? getUE4GroundedLabelY(object.bodyType) - 0.22
      : getGroundedLabelY(object.bodyType) - 0.22);
  const position = add(
    transform.position,
    applyEulerXYZ(
      multiply([0, height * 0.93, 0], transform.scale),
      transform.rotation,
    ),
  );
  return { position, approximate: true };
}
export function sampleCharacterLook(
  object: DirectorObject,
  seconds: number,
  objects: DirectorObject[],
  scene: SceneSettings,
  resolver?: CharacterLookResolver,
) {
  const clip = getCharacterLookClipAt(object, seconds);
  if (!clip) return null;
  const self =
    clip.target.kind === "object" && clip.target.objectId === object.id;
  const target = self
    ? null
    : resolveCharacterLookTarget(
        clip.target,
        objects,
        scene,
        seconds,
        resolver,
      );
  return {
    clipId: clip.id,
    target: target?.position ?? null,
    weight: target ? characterLookWeight(clip, seconds) : 0,
    approximate: target?.approximate ?? false,
    issue: self
      ? ("self-target" as const)
      : target
        ? null
        : ("missing-target" as const),
  };
}
