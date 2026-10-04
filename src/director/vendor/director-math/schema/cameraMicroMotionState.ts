// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorCameraShot, DirectorCameraWithMotionClips, DirectorObject, SceneSettings } from './directorProject.js';
import type { CameraViewSnapshot } from './cameraGeometry.js';
import { resolveCameraMotionClip } from './cameraMotionClips.js';
import { applyCameraMicroMotion } from './cameraMicroMotion.js';
import { constrainCameraMicroMotion } from './cameraMicroMotionCollision.js';
import { cameraProgressAtSeconds } from './sceneTime.js';
import { getCameraMotionPath } from './cameraMotion.js';

export function resolveCameraMicroMotion(camera: DirectorCameraShot | DirectorCameraWithMotionClips, seconds:number) {
  const resolved = 'motionClips' in camera ? resolveCameraMotionClip(camera,seconds) : null;
  const path = 'motionClips' in camera ? resolved?.clip?.path : camera.motionPath;
  const settings = path?.microMotion ?? camera.microMotion;
  if (!settings) return null;
  const sourceSeconds = resolved?.sourceSeconds ?? (!('motionClips' in camera) && path
    ? cameraProgressAtSeconds(camera,seconds) * getCameraMotionPath(camera).duration : seconds);
  return {settings,scope:path?.microMotion ? 'clip' as const : 'camera' as const,
    seconds:settings.clock === 'source' ? sourceSeconds : seconds};
}

/** One saved layer for previews, clean output and daemon queries. Disabled or
 * absent settings preserve the exact unmodified authored view. */
export function applyCameraMicroMotionAtSeconds<T extends CameraViewSnapshot>(view:T,
  camera:DirectorCameraShot | DirectorCameraWithMotionClips, seconds:number, scene?:SceneSettings, objects:DirectorObject[]=[]):T {
  const state = resolveCameraMicroMotion(camera,seconds);
  return applyCameraMicroMotion(view,state?.settings,seconds,state?.seconds,
    scene ? (from,to) => constrainCameraMicroMotion(from,to,scene,objects) : undefined);
}
