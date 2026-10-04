// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type {
  DirectorProject,
  DirectorCameraMotionKeyframe,
} from "./directorProject.js";
import type { CameraViewSnapshot } from "./cameraGeometry.js";
import { validateCameraRoll } from './cameraOptics.js';
import { createPresetCamera } from "./cameraMotionClipPreset.js";
import {
  createCameraMotionClip,
  cameraMotionClipKeyframeSeconds,
} from "./cameraMotionClips.js";
import { putCameraMotionClip } from "./cameraMotionClipEditing.js";
import { getCameraPathTimingPlan } from "./cameraMotion.js";
import { motionClipSourceSeconds } from "./motionClipTime.js";
import { ensureSceneTimeline } from "./sceneTime.js";

/** An explicit lens pose at scene seconds. A keyframeId updates that point; omission inserts. */
export interface CameraKeyframeCommand {
  type: "camera_keyframe";
  cameraId?: string;
  clipId?: string;
  keyframeId?: string;
  start?: number;
  end?: number;
  at: number;
  snapshot: CameraViewSnapshot;
}
export function parseCameraKeyframeCommand(
  raw: unknown,
): CameraKeyframeCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("录点参数必须是对象");
  const v = raw as Record<string, unknown>;
  const text = (key: string) => {
    if (v[key] === undefined) return undefined;
    if (typeof v[key] !== "string" || !(v[key] as string).trim())
      throw new Error(`${key} 必须为非空字符串`);
    return (v[key] as string).trim();
  };
  const cameraId = text("cameraId"),
    clipId = text("clipId"),
    keyframeId = text("keyframeId");
  if ((clipId && !cameraId) || (keyframeId && !clipId))
    throw new Error("修改已有点需要明确机位和片段");
  const number = (key: string) => {
    const n = v[key];
    if (typeof n !== "number" || !Number.isFinite(n))
      throw new Error(`${key} 需要有限秒数`);
    return n;
  };
  const at = number("at");
  if (at < 0) throw new Error("录点时间不能早于 0");
  let range: {} | { start: number; end: number } = {};
  if (!clipId) {
    const start = number("start"),
      end = number("end");
    if (start < 0 || end - start < 0.5 || end - start > 3600)
      throw new Error("新片段时段须为 0.5–3600 秒");
    range = { start, end };
  } else if (v.start !== undefined || v.end !== undefined)
    throw new Error("已有片段使用原时段；请在时间轴修改片段范围");
  const snapshot = v.snapshot as CameraViewSnapshot;
  const vector = (p: unknown): p is [number, number, number] =>
    Array.isArray(p) &&
    p.length === 3 &&
    p.every((n) => typeof n === "number" && Number.isFinite(n));
  if (
    !snapshot ||
    !vector(snapshot.position) ||
    !vector(snapshot.target) ||
    !Number.isFinite(snapshot.fov) ||
    snapshot.fov < 10 ||
    snapshot.fov > 120 ||
    Math.hypot(...snapshot.position.map((n, i) => n - snapshot.target[i])) <
      0.001
  )
    throw new Error("录点需要有效位置、朝向和 10–120° FOV");
  if (snapshot.roll !== undefined) validateCameraRoll(snapshot.roll);
  return {
    type: "camera_keyframe",
    ...(cameraId ? { cameraId } : {}),
    ...(clipId ? { clipId } : {}),
    ...(keyframeId ? { keyframeId } : {}),
    ...range,
    at,
    snapshot: {
      ...(snapshot.roll !== undefined ? {roll:snapshot.roll} : {}),
      position: [...snapshot.position],
      target: [...snapshot.target],
      fov: snapshot.fov,
    },
  };
}
export function stageCameraKeyframe(
  project: DirectorProject,
  raw: CameraKeyframeCommand,
) {
  const input = parseCameraKeyframeCommand(raw),
    existing = project.cameras.find((c) => c.id === input.cameraId);
  if (input.cameraId && !existing) throw new Error("机位不存在");
  if (
    existing &&
    project.objects.some((o) => o.linkedCameraId === existing.id && o.locked)
  )
    throw new Error("机位已锁定");
  const prior = existing?.motionClips.find((c) => c.id === input.clipId);
  if (input.clipId && !prior) throw new Error("片段不存在");
  if (
    input.keyframeId &&
    !prior?.path.keyframes.some((k) => k.id === input.keyframeId)
  )
    throw new Error("关键帧不存在");
  const start = prior?.start ?? input.start!,
    end = prior?.end ?? input.end!;
  if (input.at < start - 1e-9 || input.at > end + 1e-9)
    throw new Error("录点时间必须在当前片段内");
  const created = existing ? null : createPresetCamera(project, input.snapshot),
    camera = existing ?? created!.camera;
  let n = 1;
  while (camera.motionClips.some((c) => c.id === `${camera.id}_manual_${n}`))
    n++;
  const clip = prior ?? {
    ...createCameraMotionClip(
      `${camera.id}_manual_${n}`,
      {
        duration: end - start,
        loop: false,
        interpolation: "linear",
        easing: "linear",
        speedMode: "custom",
        customEasing: [0, 0, 1, 1],
        keyframes: [],
      },
      start,
      end,
    ),
    name: "手动运镜",
  };
  const plan = getCameraPathTimingPlan(clip.path),
    duration = clip.path.duration;
  // Freeze existing arrival seconds before adding or moving a point. Explicit
  // timing must not redistribute an automatically paced route's other points.
  const keys = clip.path.keyframes.map((key, i) => ({
    ...key,
    time: plan?.arrivals[i] ?? key.time,
    ...(plan && plan.effectiveHoldSeconds[i] !== (key.holdSeconds ?? 0)
      ? { holdSeconds: plan.effectiveHoldSeconds[i] }
      : {}),
  }));
  const source = motionClipSourceSeconds(clip, input.at, false),
    time = source / duration;
  const edited = keys.find((k) => k.id === input.keyframeId);
  if (edited) {
    const oldSeconds = cameraMotionClipKeyframeSeconds(
      clip,
      keys.indexOf(edited),
    );
    if (oldSeconds === null) throw new Error("已裁出的关键帧不能编辑");
  }
  for (const key of keys) {
    if (key.id === input.keyframeId) continue;
    if (Math.abs(key.time - time) * duration < 0.01)
      throw new Error("此时刻已有关键帧，请选择该点更新，或换一个时间");
    if (
      key.pointBehavior === "hold" &&
      time > key.time &&
      time < key.time + (key.holdSeconds ?? 0) / duration
    )
      throw new Error("此时刻属于停留段，请先调整停留时间");
  }
  let keyId = input.keyframeId;
  if (!keyId) {
    let i = 1;
    const used = new Set(
      camera.motionClips.flatMap((c) => c.path.keyframes.map((k) => k.id)),
    );
    while (used.has(`${camera.id}_pose_${i}`)) i++;
    keyId = `${camera.id}_pose_${i}`;
  }
  const key: DirectorCameraMotionKeyframe = {
    ...edited,
    id: keyId,
    time,
    ...input.snapshot,
    // A recorded lens pose already includes its framing. Do not apply an
    // inherited composition offset a second time when replaying that pose.
    ...(edited?.composition || clip.path.composition || camera.composition
      ? {composition:{x:0.5,y:0.5}} : {}),
    targetMode: "manual",
    targetObjectId: null,
    targetBodyPart: "center",
    targetFollowMode: "immediate",
    targetStabilizationEnabled: false,
  };
  const path = {
    ...clip.path,
    speedMode: "custom" as const,
    keyframes: [...keys.filter((k) => k.id !== keyId), key].sort(
      (a, b) => a.time - b.time,
    ),
  };
  const nextClip = { ...clip, path };
  const updated = putCameraMotionClip(camera, nextClip, prior?.id);
  const next = {
    ...project,
    cameras: existing
      ? project.cameras.map((c) => (c.id === camera.id ? updated : c))
      : [...project.cameras, updated],
    objects: created ? [...project.objects, created.object] : project.objects,
    activeCameraId: project.activeCameraId ?? camera.id,
  };
  return {
    project: ensureSceneTimeline(next),
    camera: updated,
    clip: nextClip,
    keyframe: key,
  };
}
