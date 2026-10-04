// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { sceneEventContentEnd, validateSceneEvents } from './sceneEvents.js';
import type { DirectorProject } from './directorProject.js';
import { getCameraMotionPath } from './cameraMotion.js';

export const DEFAULT_SCENE_DURATION = 6;
export const MIN_SCENE_DURATION = 0.01;
type TimedProject = Pick<DirectorProject, 'cameras' | 'objects'> & { timeline?: DirectorProject['timeline']; shots?: { sourceOut: number }[] };
/** Scene time is independent of the camera selected for monitoring. */
export function getSceneContentEnd(project: TimedProject) {
  return Math.max(MIN_SCENE_DURATION, sceneEventContentEnd(project),
    ...(project.shots ?? []).map(shot => Number.isFinite(shot.sourceOut) ? shot.sourceOut : 0),
    ...project.objects.flatMap(object => (object.lookClips ?? []).map(clip => Number.isFinite(clip.end) ? clip.end : 0)),
    ...project.objects.flatMap(object => (object.actionClips ?? []).map(clip => Number.isFinite(clip.end) ? clip.end : 0)),
    ...project.objects.flatMap(object => (object.motionClips ?? []).map(clip => Number.isFinite(clip.end) ? clip.end : 0)),
    ...project.cameras.flatMap(camera => camera.motionClips.map(clip => clip.path.keyframes.length >= 2 ? clip.end : 0)),
  );
}
export function getSceneDuration(project: TimedProject) {
  const duration = project.timeline?.duration;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= MIN_SCENE_DURATION) return duration;
  return Math.max(DEFAULT_SCENE_DURATION, getSceneContentEnd(project));
}
/** Import/mutations may extend the scene, but never retime another object's or camera's path. */
export function ensureSceneTimeline<T extends TimedProject>(project: T): T & { timeline: { duration: number } } {
  validateSceneEvents(project.timeline?.events);
  const duration = Math.max(getSceneDuration(project), getSceneContentEnd(project));
  return project.timeline?.duration === duration ? project as T & { timeline: { duration: number } } : { ...project, timeline: { ...project.timeline, duration } };
}
export type SceneTimePatch = { duration?: number; loop?: boolean; loopRange?: { start: number; end: number } | null };
/** One atomic edit shared by the desk and daemon; clearing a range may accompany a shrink. */
export function setSceneTime(project: DirectorProject, patch: SceneTimePatch): DirectorProject {
  const timeline = { ...project.timeline, duration: patch.duration ?? getSceneDuration(project),
    ...(patch.loop !== undefined ? { loop: patch.loop } : {}), ...(patch.loopRange !== undefined ? { loopRange: patch.loopRange } : {}) };
  if (timeline.loopRange == null) delete timeline.loopRange;
  const { duration, loopRange } = timeline;
  if (!Number.isFinite(duration) || duration < MIN_SCENE_DURATION) throw new Error('场景时长必须是大于零的秒数');
  const contentEnd = getSceneContentEnd(project);
  if (duration < contentEnd - 1e-9) throw new Error(`场景已有内容到 ${contentEnd.toFixed(2)} 秒，请先裁剪内容再缩短场景`);
  if (timeline.loop !== undefined && typeof timeline.loop !== 'boolean') throw new Error('循环开关必须是布尔值');
  if (loopRange !== undefined && (!loopRange || typeof loopRange !== 'object' || Array.isArray(loopRange) || !Number.isFinite(loopRange.start) || !Number.isFinite(loopRange.end) || loopRange.start < 0
    || loopRange.end - loopRange.start < MIN_SCENE_DURATION - 1e-9 || loopRange.end > duration)) {
    throw new Error('循环区间必须位于场景内，且至少长 0.01 秒');
  }
  const prior = project.timeline;
  if (prior?.duration === duration && prior.loop === timeline.loop && prior.loopRange?.start === loopRange?.start && prior.loopRange?.end === loopRange?.end) return project;
  return { ...project, timeline: timeline as DirectorProject['timeline'] };
}
export function setSceneDuration(project: DirectorProject, duration: number): DirectorProject {
  return setSceneTime(project, { duration });
}
/** A take has priority over scene rehearsal loops. Output never consumes this playback setting. */
export function getScenePlaybackRange(project: DirectorProject, previewShotId?: string | null) {
  const shot = project.shots.find(item => item.id === previewShotId);
  if (shot) return { start: shot.sourceIn, end: shot.sourceOut, loop: false };
  const range = project.timeline.loop && project.timeline.loopRange;
  return { start: range ? range.start : 0, end: range ? range.end : getSceneDuration(project), loop: Boolean(project.timeline.loop) };
}
/** Retains overrun at loop boundaries, including frames delayed by a background tab. */
export function samplePlaybackSeconds(seconds: number, range: { start: number; end: number; loop: boolean }) {
  const span = range.end - range.start;
  if (seconds < range.start) return { seconds: range.start, ended: false };
  if (seconds < range.end) return { seconds, ended: false };
  return range.loop && span > 0
    ? { seconds: range.start + (seconds - range.start) % span, ended: false }
    : { seconds: range.end, ended: true };
}
export function cameraProgressAtSeconds(camera: import('./directorProject').DirectorCameraShot, seconds: number) {
  return Math.max(0, Math.min(1, seconds / getCameraMotionPath(camera).duration));
}
