// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorCameraShot, DirectorCameraWithMotionClips, DirectorObject, SceneSettings } from './directorProject.js';
import type { CameraObjectFocusResolver } from './cameraTarget.js';
import { cameraForMotionClip, resolveCameraMotionClip } from './cameraMotionClips.js';
import { cameraProgressAtSeconds } from './sceneTime.js';
import { cameraFrameAspect } from './cameraOptics.js';
import { motionClipSourceSeconds } from './motionClipTime.js';
import { getCameraPlaybackSnapshot, getCameraPlaybackTrackingSample } from './cameraPlayback.js';
import { sampleCameraTrackingFilter } from './cameraTrackingFilter.js';
import { getCameraMotionPath, getCameraMotionSnapshot } from './cameraMotion.js';
import { getCameraViewSnapshotFromShot } from './cameraGeometry.js';
import { applyCameraMicroMotionAtSeconds } from './cameraMicroMotionState.js';

/** Render-time tracking, also used by daemon queries with their explicit body
 * approximation. The resolver must read the requested historical pose; its
 * availability is a runtime/resource concern, not a different damping formula.
 * Existing raw curve sampling remains available for authoring and migration. */
export function getCameraTemporalPlaybackAtSeconds(
  camera: DirectorCameraShot | DirectorCameraWithMotionClips, objects: DirectorObject[], seconds: number,
  scene?: SceneSettings, resolveObjectFocus?: CameraObjectFocusResolver,
  aspect = cameraFrameAspect(camera), fovOverride?: number | null,
) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('镜头采样需要非负有限场景秒');
  const clip = 'motionClips' in camera ? resolveCameraMotionClip(camera, seconds).clip : null;
  const curve = 'motionClips' in camera ? cameraForMotionClip(camera, clip) : camera;
  const progressAt = (at: number) => clip ? motionClipSourceSeconds(clip, at) / clip.path.duration
    : 'motionClips' in camera ? 0 : cameraProgressAtSeconds(curve, at);
  const progress = progressAt(seconds);
  const tracking = getCameraPlaybackTrackingSample(curve, objects, progress, scene, resolveObjectFocus, seconds);
  const shouldSmooth = tracking && (tracking.followMode === 'smooth' || tracking.stabilizationEnabled);
  const target = shouldSmooth ? sampleCameraTrackingFilter({
    seconds, startSeconds: clip?.start ?? 0, response: tracking.stabilizationEnabled ? 2.4 : 6,
    sampleTarget: at => getCameraPlaybackTrackingSample(curve, objects, progressAt(at), scene, resolveObjectFocus, at)?.target
      ?? (getCameraMotionPath(curve).keyframes.length >= 2 ? getCameraMotionSnapshot(curve, progressAt(at)) : getCameraViewSnapshotFromShot(curve)).target,
  }) : undefined;
  // Follow first, compose at the current lens/FOV second. Damping a previously
  // composed aim would drift the selected subject anchor as the camera moves.
  const composed = getCameraPlaybackSnapshot(curve, objects, progress, scene, resolveObjectFocus, seconds,
    aspect, fovOverride, clip ? clip.source.in / clip.path.duration : 0, target);
  return applyCameraMicroMotionAtSeconds(composed,camera,seconds,scene,objects);
}
