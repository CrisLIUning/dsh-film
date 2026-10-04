// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { add, lengthSq, multiplyScalar, normalize, roundTuple, sub, type Vec3 } from "./vec3.js";
import type { DirectorCameraShot } from "./directorProject.js";

export interface CameraViewSnapshot {
  roll?: number;
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
}

export const VIEWPORT_CAMERA_ASPECT = 16 / 9;
export const VIEWPORT_CAMERA_VISUAL_SCALE = 0.35;
export const VIEWPORT_CAMERA_FRUSTUM_DEPTH = 5.2 * VIEWPORT_CAMERA_VISUAL_SCALE;
export const VIEWPORT_CAMERA_FRUSTUM_FRAME_WIDTH = 3.2 * VIEWPORT_CAMERA_VISUAL_SCALE;

export const DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT: CameraViewSnapshot = {
  fov: 50,
  position: [0, 1.55, 5.4],
  target: [0, 1.05, 0],
};

function getForwardDirection(position: Vec3, target: Vec3): Vec3 {
  const direction = sub(target, position);
  return lengthSq(direction) === 0 ? [0, 0, -1] : normalize(direction);
}

export function getCameraViewSnapshotFromShot(camera: DirectorCameraShot): CameraViewSnapshot {
  const forward = getForwardDirection(camera.transform.position, camera.target);
  const viewPosition = add(camera.transform.position, multiplyScalar(forward, VIEWPORT_CAMERA_FRUSTUM_DEPTH));

  return {
    ...(camera.roll !== undefined ? {roll:camera.roll} : {}),
    fov: camera.fov,
    position: roundTuple(viewPosition),
    target: camera.target,
  };
}

export function getCameraRigPositionFromViewSnapshot(snapshot: CameraViewSnapshot): [number, number, number] {
  const forward = getForwardDirection(snapshot.position, snapshot.target);
  const rigPosition = sub(snapshot.position, multiplyScalar(forward, VIEWPORT_CAMERA_FRUSTUM_DEPTH));

  return roundTuple(rigPosition);
}
