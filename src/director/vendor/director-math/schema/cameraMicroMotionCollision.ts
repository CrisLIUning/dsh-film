// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorObject, SceneSettings } from './directorProject.js';
import type { Vec3 } from './vec3.js';
import { constrainCameraPosition } from './pathCollision.js';
import { sweepSpatialCurve } from './spatialSweep.js';

/** Micro-motion is relative to the authored lens, never to the previously
 * rendered frame. Sweep the entire short offset before the existing point/floor
 * constraint, so a narrow reviewed wall cannot be crossed between endpoints. */
export function constrainCameraMicroMotion(
  from: Vec3, to: Vec3, scene: SceneSettings, objects: DirectorObject[],
): Vec3 {
  if (!scene.pathCollisionEnabled) return to;
  const hit = sweepSpatialCurve([from, to], false, 0, 1, {
    min: [-.18, -.18, -.18], max: [.18, .18, .18],
  }, objects);
  return constrainCameraPosition(hit?.position ?? to, scene, objects);
}
