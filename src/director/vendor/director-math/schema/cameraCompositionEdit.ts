// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type {
  DirectorCameraComposition,
  DirectorCameraWithMotionClips,
  DirectorProject,
} from "./directorProject.js";
import { normalizeCameraComposition } from "./cameraComposition.js";
import { cameraMotionClipKeyframeSeconds } from "./cameraMotionClips.js";

export interface CameraCompositionCommand {
  type: "camera_composition";
  cameraId: string;
  /** Omit for the static camera; supply for a motion clip. */
  clipId?: string;
  /** Omit to set the whole clip and clear point overrides. */
  keyframeIds?: string[];
  /** null removes the override; explicit .5/.5 centres the subject. */
  composition: DirectorCameraComposition | null;
}
export function parseCameraCompositionCommand(
  raw: unknown,
): CameraCompositionCommand {
  if (!raw || typeof raw !== "object") throw new Error("构图命令必须是对象");
  const value = raw as CameraCompositionCommand;
  if (
    value.type !== "camera_composition" ||
    typeof value.cameraId !== "string" ||
    !value.cameraId.trim()
  )
    throw new Error("构图需要机位 ID");
  if (
    value.clipId !== undefined &&
    (typeof value.clipId !== "string" || !value.clipId.trim())
  )
    throw new Error("片段 ID 无效");
  if (
    value.keyframeIds !== undefined &&
    (!value.clipId ||
      !Array.isArray(value.keyframeIds) ||
      !value.keyframeIds.length ||
      !value.keyframeIds.every((id) => typeof id === "string" && id.trim()) ||
      new Set(value.keyframeIds).size !== value.keyframeIds.length)
  )
    throw new Error("选点构图需要片段和不重复的关键帧 ID");
  const composition = normalizeCameraComposition(value.composition);
  if (value.composition !== null && !composition)
    throw new Error("构图 x/y 必须是 0–1 的画面比例");
  return {
    type: "camera_composition",
    cameraId: value.cameraId,
    ...(value.clipId ? { clipId: value.clipId } : {}),
    ...(value.keyframeIds ? { keyframeIds: [...value.keyframeIds] } : {}),
    composition: composition ?? null,
  };
}
export function stageCameraComposition(
  project: DirectorProject,
  raw: CameraCompositionCommand,
) {
  const input = parseCameraCompositionCommand(raw);
  const camera = project.cameras.find((item) => item.id === input.cameraId);
  if (!camera) throw new Error("机位不存在");
  if (
    project.objects.some(
      (object) => object.linkedCameraId === camera.id && object.locked,
    )
  )
    throw new Error("机位已锁定");
  const clip = camera.motionClips.find((item) => item.id === input.clipId);
  if (input.clipId && !clip) throw new Error("片段不存在");
  if (input.keyframeIds)
    for (const id of input.keyframeIds) {
      const index = clip!.path.keyframes.findIndex((key) => key.id === id);
      if (index < 0) throw new Error("关键帧不在当前片段");
      const time = cameraMotionClipKeyframeSeconds(clip!, index);
      if (time === null || time < clip!.start - 1e-9 || time > clip!.end + 1e-9)
        throw new Error("不能修改已裁出的关键帧构图");
    }
  const replace = <T extends { composition?: DirectorCameraComposition }>(
    target: T,
  ): T => {
    const { composition: _previous, ...rest } = target;
    return {
      ...rest,
      ...(input.composition ? { composition: input.composition } : {}),
    } as T;
  };
  const updated: DirectorCameraWithMotionClips = clip
    ? {
        ...camera,
        motionClips: camera.motionClips.map((item) =>
          item !== clip
            ? item
            : {
                ...item,
                path: input.keyframeIds
                  ? {
                      ...item.path,
                      keyframes: item.path.keyframes.map((key) =>
                        input.keyframeIds!.includes(key.id)
                          ? replace(key)
                          : key,
                      ),
                    }
                  : {
                      ...replace(item.path),
                      keyframes: item.path.keyframes.map(
                        ({ composition: _override, ...key }) => key,
                      ),
                    },
              },
        ),
      }
    : replace(camera);
  return {
    project: {
      ...project,
      cameras: project.cameras.map((item) =>
        item === camera ? updated : item,
      ),
    },
    camera: updated,
    clipId: clip?.id,
  };
}
