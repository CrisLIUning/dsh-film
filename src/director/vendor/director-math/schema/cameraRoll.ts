// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorCameraShot } from './directorProject.js';
import { getCameraMotionPath, getCameraMotionCurveCursor } from './cameraMotion.js';

/** Source-clock roll with the same holds/easing as lens motion. Missing points
 * inherit the clip, then the camera; old scenes retain no extra snapshot field. */
export function sampleCameraRoll(camera: DirectorCameraShot, progress: number): number | undefined {
  const path = getCameraMotionPath(camera), keys = path.keyframes;
  const fallback = path.roll ?? camera.roll;
  if (!keys.some(k => k.roll !== undefined)) return fallback;
  const at = (index: number) => keys[index].roll ?? fallback ?? 0;
  if (keys.length === 1 || progress <= keys[0].time) return at(0);
  if (progress >= keys[keys.length - 1].time) return at(keys.length - 1);
  const cursor = getCameraMotionCurveCursor(camera, progress);
  const index = Math.min(keys.length - 2, Math.floor(cursor)), t = cursor - index;
  const from = at(index), to = at(index + 1);
  const difference = ((to - from + 540) % 360) - 180;
  const value = from + difference * t;
  return value > 180 ? value - 360 : value < -180 ? value + 360 : value;
}
