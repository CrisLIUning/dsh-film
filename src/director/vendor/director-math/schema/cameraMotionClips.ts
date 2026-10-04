// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { normalizeCameraComposition } from "./cameraComposition.js";
import { cameraFrameAspect, validateCameraRoll, validateFilmGate } from './cameraOptics.js';
import type { DirectorCameraMotionPath, DirectorCameraShot, DirectorMotionClipSource, DirectorObject, SceneSettings } from './directorProject.js';
import { DEFAULT_CAMERA_MOTION_PATH, getCameraMotionPath, getCameraMotionSnapshot, getCameraPathTimingPlan, normalizeCameraMotionPath, type CameraMotionSnapshot } from './cameraMotion.js';
import { getCameraPlaybackSnapshot } from './cameraPlayback.js';
import type { CameraObjectFocusResolver } from './cameraTarget.js';
import { motionClipRate, motionClipSource, motionClipSourceSeconds, validateMotionClipSource } from './motionClipTime.js';

export type { DirectorCameraMotionClip, CameraMotionDefaults, DirectorCameraWithMotionClips } from './directorProject.js';
import type { DirectorCameraMotionClip, DirectorCameraWithMotionClips } from './directorProject.js';

import { validateCameraMicroMotion } from './cameraMicroMotion.js';

export const MIN_CAMERA_MOTION_CLIP_SECONDS = .01;

export function validateCameraMotionClip(clip: DirectorCameraMotionClip) {
  if (!clip || typeof clip.id !== 'string' || !clip.id.trim()) throw new Error('相机运动片段需要 id');
  if (clip.name !== undefined && typeof clip.name !== 'string') throw new Error('相机片段名称必须是字符串');
  if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end - clip.start < MIN_CAMERA_MOTION_CLIP_SECONDS - 1e-9) throw new Error('相机运动片段起点不能早于 0，两端至少相隔 0.01 秒');
  validateMotionClipSource(clip.source);
  if (!clip.path || !Number.isFinite(clip.path.duration) || clip.path.duration < .5 || Math.abs(clip.source.duration - clip.path.duration) > 1e-9) throw new Error('相机片段源时长必须与原始曲线时长一致');
  if (!Array.isArray(clip.path.keyframes)) throw new Error('相机片段缺少原始关键帧');
  if (clip.path.composition !== undefined && !normalizeCameraComposition(clip.path.composition)) throw new Error("片段构图比例无效");
  const keys = new Set<string>();
  if (clip.path.roll !== undefined) validateCameraRoll(clip.path.roll);
  if (clip.path.microMotion !== undefined) validateCameraMicroMotion(clip.path.microMotion);
  let priorTime = -1;
  for (const key of clip.path.keyframes) {
    if (!key || typeof key.id !== 'string' || !key.id || keys.has(key.id)) throw new Error('相机片段关键帧 ID 无效或重复');
    if (key.roll !== undefined) validateCameraRoll(key.roll);
    if (key.composition !== undefined && !normalizeCameraComposition(key.composition)) throw new Error("关键帧构图比例无效");
    keys.add(key.id);
    if (!Number.isFinite(key.time) || key.time < 0 || key.time > 1) throw new Error('相机原始关键帧时间必须在 0–1 内');
    if (key.time < priorTime) throw new Error('相机原始关键帧必须按时间排序');
    priorTime = key.time;
    for (const vector of [key.position, key.target]) {
      if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite)) throw new Error('相机关键帧坐标无效');
    }
    if (!Number.isFinite(key.fov) || key.fov < 10 || key.fov > 120) throw new Error('相机关键帧 FOV 无效');
  }
}

/** One camera has one position at a time. Adjacent clips are allowed; overlaps
 * are refused rather than resolved by invisible layer priority. */
export function validateCameraMotionClips(clips: DirectorCameraMotionClip[]): DirectorCameraMotionClip[] {
  if (!Array.isArray(clips)) throw new Error('相机运动片段列表无效');
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  const ids = new Set<string>();
  const keyIds = new Set<string>();
  for (let index = 0; index < ordered.length; index++) {
    const clip = ordered[index]; validateCameraMotionClip(clip);
    if (ids.has(clip.id)) throw new Error(`相机运动片段 ID 重复：${clip.id}`);
    ids.add(clip.id);
    for (const key of clip.path.keyframes) {
      if (keyIds.has(key.id)) throw new Error(`相机轨道关键帧 ID 重复：${key.id}`);
      keyIds.add(key.id);
    }
    if (index && clip.start < ordered[index - 1].end - 1e-9) throw new Error(`相机运动片段重叠：${ordered[index - 1].id} / ${clip.id}`);
  }
  return ordered;
}

/** Pure, idempotent project v6 migration. Empty routes keep
 * their authoring settings; nonempty routes keep every original control point. */
export function migrateCameraMotionTrack(camera: DirectorCameraShot | DirectorCameraWithMotionClips): DirectorCameraWithMotionClips {
  if (camera.microMotion !== undefined) validateCameraMicroMotion(camera.microMotion);
  if (camera.filmGate !== undefined) validateFilmGate(camera.filmGate);
  if (camera.roll !== undefined) validateCameraRoll(camera.roll);
  if (camera.composition !== undefined && !normalizeCameraComposition(camera.composition)) throw new Error("机位构图比例无效");
  if ('motionClips' in camera) {
    if (camera.motionDefaults && 'microMotion' in camera.motionDefaults) throw new Error('微运动必须保存在机位或运动片段，不在路线默认值中');
    if ('motionPath' in camera && camera.motionPath !== undefined) throw new Error('机位同时包含旧路线和运动片段，拒绝猜测数据来源');
    return { ...camera, motionClips: validateCameraMotionClips(camera.motionClips) };
  }
  const { motionPath: _legacy, ...rest } = camera;
  const path = getCameraMotionPath(camera);
  const { keyframes, preset: _preset, microMotion: _micro, ...motionDefaults } = path;
  return { ...rest, motionDefaults, motionClips: keyframes.length ? [{
    id: `${camera.id}_motion_1`, start: 0, end: path.duration, path,
    source: { duration: path.duration, in: 0, out: path.duration, origin: 0 },
  }] : [] };
}

/** An explicit adapter for the existing pure curve sampler and the point editor.
 * Never save this derived view back into the project. */
export function cameraForMotionClip(camera: DirectorCameraWithMotionClips, clip: DirectorCameraMotionClip | null): DirectorCameraShot {
  const { motionClips: _clips, motionDefaults, ...base } = camera;
  return { ...base, motionPath: clip?.path ?? { ...DEFAULT_CAMERA_MOTION_PATH, ...motionDefaults, keyframes: [] } };
}

export interface CameraMotionClipSample {
  clip: DirectorCameraMotionClip | null;
  mode: 'base' | 'playing' | 'holding';
  sourceSeconds: number | null;
  progress: number;
}
export function resolveCameraMotionClip(camera: DirectorCameraWithMotionClips, seconds: number): CameraMotionClipSample {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('相机采样需要非负场景秒数');
  // Stored tracks are validated on writes/import. The resolver never sorts on a frame.
  let previous: DirectorCameraMotionClip | null = null;
  for (const clip of camera.motionClips) {
    if (seconds < clip.start) break;
    previous = clip;
    if (seconds < clip.end) {
      const sourceSeconds = motionClipSourceSeconds(clip, seconds);
      return { clip, mode: 'playing', sourceSeconds, progress: sourceSeconds / clip.path.duration };
    }
  }
  if (!previous) return { clip: null, mode: 'base', sourceSeconds: null, progress: 0 };
  return { clip: previous, mode: 'holding', sourceSeconds: previous.source.out, progress: previous.source.out / previous.path.duration };
}

/** Lens motion consumes clip source time. Live subject tracking consumes scene
 * time even after a clip is moved, trimmed, stretched, or has ended. */
export function getCameraMotionTrackSnapshot(camera: DirectorCameraWithMotionClips, objects: DirectorObject[], seconds: number,
  scene?: SceneSettings, resolveObjectFocus?: CameraObjectFocusResolver, aspect = cameraFrameAspect(camera), fovOverride?: number | null): CameraMotionSnapshot {
  const sample = resolveCameraMotionClip(camera, seconds);
  return getCameraPlaybackSnapshot(cameraForMotionClip(camera, sample.clip), objects, sample.progress, scene, resolveObjectFocus, seconds, aspect, fovOverride, sample.clip ? sample.clip.source.in / sample.clip.path.duration : 0);
}

export function cameraMotionClipKeyframeSeconds(clip: DirectorCameraMotionClip, index: number) {
  const key = clip.path.keyframes[index];
  if (!key) return null;
  const sourceSeconds = (getCameraPathTimingPlan(clip.path)?.arrivals[index] ?? key.time) * clip.path.duration;
  const source = motionClipSource(clip);
  if (sourceSeconds < source.in - 1e-9 || sourceSeconds > source.out + 1e-9) return null;
  return clip.start + (sourceSeconds - source.in) / motionClipRate(clip);
}

/** Keep a curve's source clock and holds intact; retiming belongs to its window. */
export function createCameraMotionClip(id: string, path: DirectorCameraMotionPath, start: number, end = start + path.duration): DirectorCameraMotionClip {
  const clip = { id, start, end, path: normalizeCameraMotionPath(path), source: { duration: path.duration, in: 0, out: path.duration, origin: start } };
  validateCameraMotionClip(clip);
  return clip;
}

/** Display only the retained interval without modifying its original control points. */
export function sampleCameraMotionClipPath(camera: DirectorCameraWithMotionClips, clip: DirectorCameraMotionClip, count = 64) {
  const curve = cameraForMotionClip(camera, clip);
  const points = Math.max(2, Math.floor(count));
  return Array.from({ length: points }, (_, index) => getCameraMotionSnapshot(curve,
    (clip.source.in + (clip.source.out - clip.source.in) * index / (points - 1)) / clip.path.duration).position);
}
