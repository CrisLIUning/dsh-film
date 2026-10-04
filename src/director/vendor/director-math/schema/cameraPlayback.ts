// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { cameraFrameAspect } from "./cameraOptics.js";
import { composeCameraView, sampleCameraComposition } from "./cameraComposition.js";
import { sampleCameraRoll } from './cameraRoll.js';
import { getCameraMotionTrackSnapshot } from './cameraMotionClips.js';
import { cameraProgressAtSeconds } from "./sceneTime.js";
import type { CameraMotionSnapshot } from "./cameraMotion.js";
import { getCameraMotionPath, getCameraMotionSnapshot } from "./cameraMotion.js";
import { getAnimatedCameraFocusSample, type CameraObjectFocusResolver } from "./cameraTarget.js";
import type { DirectorCameraShot, DirectorObject, SceneSettings } from "./directorProject.js";
import { getCameraViewSnapshotFromShot } from "./cameraGeometry.js";
import { hasSpatialObstacles } from "./spatialSweep.js";
import { constrainCameraPosition } from "./pathCollision.js";
import { getConstrainedCameraMotionPosition, getConstrainedObjectMotionSnapshot } from "./routeCollision.js";

/** Tracking uses the same collision-resolved actor transform as camera playback. */
export function getCameraPlaybackTrackingSample(
  camera: DirectorCameraShot, objects: DirectorObject[], progress: number,
  scene?: SceneSettings, resolveObjectFocus?: CameraObjectFocusResolver,
  sceneSeconds = progress * getCameraMotionPath(camera).duration,
) {
  const spatial = hasSpatialObstacles(objects);
  const constrainedObjects = scene?.pathCollisionEnabled
    ? objects.map((object) => ({
        ...object,
        // Authored spatial scenes supply already-sampled transforms. The focus
        // resolver must not replay the raw route and aim beyond a stopped actor.
        // Unannotated legacy projects retain their historical target sampling.
        ...(spatial ? {motionClips: []} : {}),
        transform: getConstrainedObjectMotionSnapshot(
          object,
          sceneSeconds,
          scene,
          objects,
        ),
      }))
    : objects;
  return getAnimatedCameraFocusSample(camera, constrainedObjects, progress, resolveObjectFocus, sceneSeconds);
}

export function getCameraPlaybackSnapshot(
  camera: DirectorCameraShot,
  objects: DirectorObject[],
  progress: number,
  scene?: SceneSettings,
  resolveObjectFocus?: CameraObjectFocusResolver,
  sceneSeconds = progress * getCameraMotionPath(camera).duration,
  aspect = cameraFrameAspect(camera),
  fovOverride?: number | null,
  sourceStartProgress = 0,
  trackingTargetOverride?: [number, number, number],
): CameraMotionSnapshot {
  const motionPath = getCameraMotionPath(camera);
  const base = motionPath.keyframes.length >= 2
    ? getCameraMotionSnapshot(camera, progress)
    : getCameraViewSnapshotFromShot(camera);
  const trackingTarget = trackingTargetOverride ?? getCameraPlaybackTrackingSample(camera, objects, progress, scene, resolveObjectFocus, sceneSeconds)?.target;
  const position = scene ? motionPath.keyframes.length >= 2
    ? getConstrainedCameraMotionPosition(camera,progress,scene,objects,sourceStartProgress)
    : constrainCameraPosition(base.position,scene,objects) : base.position;

  const roll = sampleCameraRoll(camera, progress);
  const view = { ...base, position, ...(roll !== undefined ? {roll} : {}), ...(trackingTarget ? {target: trackingTarget} : {}), ...(fovOverride != null ? {fov: fovOverride} : {}) };
  return composeCameraView(view, sampleCameraComposition(camera, progress), aspect);
}

/** Raw authored-curve sampling, without temporal follow damping. The lens holds
 * after its path ends while the target follows scene time. Render/query callers
 * use cameraTemporalPlayback; authoring and migration can inspect this curve. */
export function getCameraPlaybackAtSeconds(camera: DirectorCameraShot | import('./directorProject').DirectorCameraWithMotionClips, objects: DirectorObject[], seconds: number, scene?: SceneSettings, resolveObjectFocus?: CameraObjectFocusResolver, aspect = cameraFrameAspect(camera), fovOverride?: number | null) {
  if ('motionClips' in camera) return getCameraMotionTrackSnapshot(camera, objects, seconds, scene, resolveObjectFocus, aspect, fovOverride);
  return getCameraPlaybackSnapshot(camera, objects, cameraProgressAtSeconds(camera, seconds), scene, resolveObjectFocus, seconds, aspect, fovOverride);
}
