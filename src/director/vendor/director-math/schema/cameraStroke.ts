// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { sampleStroke } from "./strokeSampling.js";
import { validateCameraRoll } from "./cameraOptics.js";
import type {
  DirectorCameraMotionPath,
  DirectorProject,
} from "./directorProject.js";
import { createPresetCamera as createDraftCamera } from "./cameraMotionClipPreset.js";
import { createCameraMotionClip } from "./cameraMotionClips.js";
import { putCameraMotionClip } from "./cameraMotionClipEditing.js";
import { getCameraPlaybackAtSeconds } from "./cameraPlayback.js";
import {
  DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT,
  type CameraViewSnapshot,
} from "./cameraGeometry.js";
import {
  getDirectorObjectFocusTarget,
  isCameraFocusableObject,
} from "./cameraTarget.js";
import { getConstrainedObjectMotionSnapshot } from "./routeCollision.js";
import { ensureSceneTimeline } from "./sceneTime.js";
import {
  DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS,
  type DirectorCameraTargetBodyPart,
} from "./semanticBody.js";
import { add, sub, length, type Vec3 } from "./vec3.js";

export interface CameraStrokeSample {
  point: [number, number];
  time: number;
}
export interface CameraStrokeOptions {
  type: "camera_stroke";
  cameraId?: string;
  cameraName?: string;
  clipId?: string;
  replaceClipId?: string;
  start: number;
  end: number;
  /** Lens metres above the scene's ground plane; the stroke supplies scene-local X/Z. */
  height: number;
  aim: "direction" | "point" | "object";
  targetObjectId?: string;
  targetBodyPart?: DirectorCameraTargetBodyPart;
  pace?: "uniform" | "drawn";
  snapshot?: CameraViewSnapshot;
}
export interface CameraStrokeCommand extends CameraStrokeOptions {
  samples: CameraStrokeSample[];
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const vector = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every(finite);
export function parseCameraStrokeOptions(raw: unknown): CameraStrokeOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("相机绘线参数必须是对象");
  const value = raw as Record<string, unknown>;
  const text = (key: string) => {
    if (value[key] === undefined) return undefined;
    if (typeof value[key] !== "string" || !(value[key] as string).trim())
      throw new Error(`${key} 必须是非空字符串`);
    return (value[key] as string).trim();
  };
  const cameraId = text("cameraId"),
    cameraName = text("cameraName"),
    clipId = text("clipId"),
    replaceClipId = text("replaceClipId"),
    targetObjectId = text("targetObjectId");
  if (cameraId && cameraName) throw new Error("cameraName 仅用于新建机位");
  if (replaceClipId && !cameraId) throw new Error("替换片段需要 cameraId");
  if (replaceClipId && clipId && replaceClipId !== clipId)
    throw new Error("替换片段必须保留 ID");
  if (
    !finite(value.start) ||
    !finite(value.end) ||
    value.start < 0 ||
    value.end - value.start < 0.5 ||
    value.end - value.start > 3600
  )
    throw new Error("绘线时段必须为 0.5–3600 秒，开始不能早于 0");
  if (!finite(value.height) || value.height < 0.05 || value.height > 1000)
    throw new Error("镜头离地高度须为 0.05–1000 米");
  if (!["direction", "point", "object"].includes(String(value.aim)))
    throw new Error("请选择保持朝向、固定看向点或跟踪主体");
  if (value.aim === "object" && !targetObjectId)
    throw new Error("跟踪主体需要 targetObjectId");
  if (
    value.targetBodyPart !== undefined &&
    !DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS.some(
      (item) => item.value === value.targetBodyPart,
    )
  )
    throw new Error("未知跟踪部位");
  if (
    value.pace !== undefined &&
    value.pace !== "uniform" &&
    value.pace !== "drawn"
  )
    throw new Error("pace 须为 uniform 或 drawn");
  let snapshot: CameraViewSnapshot | undefined;
  if (value.snapshot !== undefined) {
    const v = value.snapshot as CameraViewSnapshot;
    if (
      !v ||
      !vector(v.position) ||
      !vector(v.target) ||
      !finite(v.fov) ||
      v.fov < 10 ||
      v.fov > 120 ||
      length(sub(v.position, v.target)) < 0.001
    )
      throw new Error("snapshot 需要有效镜头位置、看向点与 10–120° FOV");
    if (v.roll !== undefined) validateCameraRoll(v.roll);
    snapshot = { position: [...v.position], target: [...v.target], fov: v.fov, ...(v.roll !== undefined ? {roll:v.roll} : {}) };
  }
  return {
    type: "camera_stroke",
    start: value.start,
    end: value.end,
    height: value.height,
    aim: value.aim as CameraStrokeOptions["aim"],
    ...(cameraId ? { cameraId } : {}),
    ...(cameraName ? { cameraName } : {}),
    ...(clipId ? { clipId } : {}),
    ...(replaceClipId ? { replaceClipId } : {}),
    ...(targetObjectId ? { targetObjectId } : {}),
    ...(value.targetBodyPart
      ? { targetBodyPart: value.targetBodyPart as DirectorCameraTargetBodyPart }
      : {}),
    ...(value.pace ? { pace: value.pace as "uniform" | "drawn" } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
}
export function parseCameraStrokeCommand(raw: unknown): CameraStrokeCommand {
  const options = parseCameraStrokeOptions(raw),
    samples = (raw as CameraStrokeCommand).samples;
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > 2048)
    throw new Error("绘线需要 2–2048 个地面采样点");
  let previous = -Infinity;
  for (const sample of samples) {
    if (
      !sample ||
      !Array.isArray(sample.point) ||
      sample.point.length !== 2 ||
      !sample.point.every(finite) ||
      !finite(sample.time) ||
      sample.time < 0 ||
      sample.time <= previous
    )
      throw new Error("绘线采样需要有限的 X/Z 和严格递增的非负时间");
    previous = sample.time;
  }
  return {
    ...options,
    samples: samples.map((sample) => ({
      point: [...sample.point],
      time: sample.time,
    })),
  };
}

/** Validate a drawing session before it captures the pointer. No scene is changed. */
export function validateCameraStrokeTarget(
  project: DirectorProject,
  raw: CameraStrokeOptions,
) {
  const options = parseCameraStrokeOptions(raw);
  const camera = project.cameras.find((item) => item.id === options.cameraId);
  if (options.cameraId && !camera) throw new Error("机位不存在");
  if (
    camera &&
    project.objects.some(
      (item) =>
        item.kind === "camera" &&
        item.linkedCameraId === camera.id &&
        item.locked,
    )
  )
    throw new Error("机位已锁定");
  if (
    options.replaceClipId &&
    !camera?.motionClips.some((clip) => clip.id === options.replaceClipId)
  )
    throw new Error("要替换的片段不存在");
  if (
    camera?.motionClips.some(
      (clip) =>
        clip.id !== options.replaceClipId &&
        clip.start < options.end &&
        clip.end > options.start,
    )
  )
    throw new Error("绘线时段与其他运镜片段重叠");
  if (
    options.aim === "object" &&
    !project.objects.some(
      (item) =>
        item.id === options.targetObjectId && isCameraFocusableObject(item),
    )
  )
    throw new Error("跟踪主体不存在或不可见");
  return options;
}

export function stageCameraStroke(
  project: DirectorProject,
  raw: CameraStrokeCommand,
) {
  const input = parseCameraStrokeCommand(raw);
  validateCameraStrokeTarget(project, input);
  const points = sampleStroke(input.samples.map(sample => ({position: [sample.point[0], 0, sample.point[1]], time: sample.time})), input.pace).map(sample => ({point: [sample.position[0], sample.position[2]], time: sample.time}));
  const distances = [0];
  for (let i = 1; i < points.length; i++)
    distances.push(
      distances[i - 1] +
        Math.hypot(
          points[i].point[0] - points[i - 1].point[0],
          points[i].point[1] - points[i - 1].point[1],
        ),
    );
  const total = distances[distances.length - 1];
  if (total < 0.3) throw new Error("请画一条至少 0.3 米的路线");
  if (points.length > 256) throw new Error("路线过于复杂，请分成几段绘制");
  const existing = project.cameras.find(
    (camera) => camera.id === input.cameraId,
  );
  const snapshot =
    input.snapshot ??
    (existing
      ? getCameraPlaybackAtSeconds(
          existing,
          project.objects,
          input.start,
          project.scene,
        )
      : DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT);
  const created = existing
      ? null
      : createDraftCamera(project, snapshot, input.cameraName),
    camera = existing ?? created!.camera;
  let id = input.clipId ?? input.replaceClipId;
  if (!id) {
    let n = 1;
    while (
      camera.motionClips.some((clip) => clip.id === `${camera.id}_draw_${n}`)
    )
      n++;
    id = `${camera.id}_draw_${n}`;
  }
  const used = new Set(
    camera.motionClips
      .filter((clip) => clip.id !== input.replaceClipId)
      .flatMap((clip) => clip.path.keyframes.map((key) => key.id)),
  );
  const duration = input.end - input.start,
    origin = points[0].time,
    drawnDuration = points[points.length - 1].time - origin;
  const subject =
    input.aim === "object"
      ? project.objects.find((object) => object.id === input.targetObjectId)!
      : null;
  const direction = sub(snapshot.target, snapshot.position);
  const path: DirectorCameraMotionPath = {
    duration,
    loop: false,
    interpolation: "linear",
    easing: "linear",
    speedMode: input.pace === "drawn" ? "custom" : "uniform",
    customEasing: [0, 0, 1, 1],
    keyframes: points.map((sample, index) => {
      const time =
        input.pace === "drawn"
          ? (sample.time - origin) / drawnDuration
          : distances[index] / total;
      const position: Vec3 = [
        sample.point[0],
        (project.scene.groundHeight ?? 0) + input.height,
        sample.point[1],
      ];
      const transform = subject
        ? getConstrainedObjectMotionSnapshot(
            subject,
            input.start + time * duration,
            project.scene,
            project.objects,
          )
        : null;
      const target = subject
        ? getDirectorObjectFocusTarget({ ...subject, transform: transform! })
        : input.aim === "point"
          ? ([...snapshot.target] as Vec3)
          : add(position, direction);
      if (length(sub(position, target)) < 0.001)
        throw new Error("路线经过看向点，请调整高度或看向方式");
      let keyId = `${id}_k${index + 1}`;
      while (used.has(keyId)) keyId += "_copy";
      used.add(keyId);
      return {
        id: keyId,
        time,
        position,
        target,
        fov: snapshot.fov,
        ...(snapshot.roll !== undefined ? {roll:snapshot.roll} : {}),
        targetMode: subject ? "object" : "manual",
        targetObjectId: subject?.id ?? null,
        targetBodyPart: input.targetBodyPart ?? "center",
        targetFollowMode: "immediate",
        targetStabilizationEnabled: false,
        pointBehavior: "pass",
        holdSeconds: 0,
      };
    }),
  };
  const clip = {
    ...createCameraMotionClip(id, path, input.start, input.end),
    name:
      camera.motionClips.find((item) => item.id === input.replaceClipId)
        ?.name ?? "手绘运镜",
  };
  const updated = putCameraMotionClip(camera, clip, input.replaceClipId);
  const next = {
    ...project,
    cameras: existing
      ? project.cameras.map((item) => (item.id === camera.id ? updated : item))
      : [...project.cameras, updated],
    objects: created ? [...project.objects, created.object] : project.objects,
    activeCameraId: project.activeCameraId ?? camera.id,
  };
  return {
    project: ensureSceneTimeline(next),
    camera: updated,
    clip,
    createdCamera: Boolean(created),
  };
}
