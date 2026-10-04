// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { hasSpatialTerrain } from './spatialTerrain.js';
import { hasObjectMotion } from "./objectMotion.js";
import { characterStandingSize } from "./characterSizing.js";
import { constrainSpatialPoint, spatialGroundAt } from "./spatialProfile.js";
import type { DirectorObject, DirectorTransform, SceneSettings } from "./directorProject.js";

type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
};

const CHARACTER_CLEARANCE = 0.32;
const CAMERA_CLEARANCE = 0.18;

function getObstacleBounds(object: DirectorObject): Bounds {
  const [x, y, z] = object.transform.position;
  const [sx, sy, sz] = object.transform.scale.map((value) => Math.max(0.05, Math.abs(value))) as [number, number, number];
  const halfX = sx * 0.55;
  const halfZ = sz * 0.55;
  const height = sy * (object.geometryType === "sphere" ? 1 : 1.2);
  return {
    min: [x - halfX, y, z - halfZ],
    max: [x + halfX, y + height, z + halfZ],
  };
}

function getObstacles(objects: DirectorObject[]) {
  return objects.filter((object) =>
    object.visible && !hasObjectMotion(object) && (object.kind === "prop" || object.kind === "scene")
  );
}

function pushOutside2D(position: [number, number, number], bounds: Bounds, clearance: number) {
  const minX = bounds.min[0] - clearance;
  const maxX = bounds.max[0] + clearance;
  const minZ = bounds.min[2] - clearance;
  const maxZ = bounds.max[2] + clearance;
  if (position[0] <= minX || position[0] >= maxX || position[2] <= minZ || position[2] >= maxZ) return position;

  const exits = [
    { axis: 0 as const, value: minX, distance: position[0] - minX },
    { axis: 0 as const, value: maxX, distance: maxX - position[0] },
    { axis: 2 as const, value: minZ, distance: position[2] - minZ },
    { axis: 2 as const, value: maxZ, distance: maxZ - position[2] },
  ].sort((left, right) => left.distance - right.distance);
  const next = [...position] as [number, number, number];
  next[exits[0].axis] = exits[0].value;
  return next;
}

function pushOutside3D(position: [number, number, number], bounds: Bounds, clearance: number, floorY: number) {
  const min = bounds.min.map((value) => value - clearance) as [number, number, number];
  const max = bounds.max.map((value) => value + clearance) as [number, number, number];
  if (position.some((value, axis) => value <= min[axis] || value >= max[axis])) return position;

  const exits = ([0, 1, 2] as const).flatMap((axis) => [
    { axis, value: min[axis], distance: position[axis] - min[axis] },
    { axis, value: max[axis], distance: max[axis] - position[axis] },
  ]).filter((exit) => exit.axis !== 1 || exit.value >= floorY)
    .sort((left, right) => left.distance - right.distance);
  const next = [...position] as [number, number, number];
  next[exits[0].axis] = exits[0].value;
  return next;
}

export function constrainObjectMotionTransform(
  object: DirectorObject,
  transform: DirectorTransform,
  scene: SceneSettings,
  objects: DirectorObject[],
  terrainResolved = false
): DirectorTransform {
  if (!scene.pathCollisionEnabled || object.kind === "light") return transform;
  // Authored static spatial proxies do not drift when another object overlaps them.
  if (object.spatial && !hasObjectMotion(object)) return transform;
  let position = [...transform.position] as [number, number, number];
  if (object.kind === "character" && !terrainResolved) position[1] = spatialGroundAt(position, objects, scene.groundHeight);
  const supportedWalking=terrainResolved||(object.kind==="character"&&hasSpatialTerrain(objects));
  for (const obstacle of getObstacles(objects).filter((item) => item.id !== object.id)) {
    if (obstacle.spatial?.volumes.length && !obstacle.spatialNeedsReview) {
      // The terrain route has already swept this body against these proxies,
      // including valid stair contacts. A second point-only pass loses that
      // context and pushes the actor away from the next tread.
      if (terrainResolved) continue;
      const radius = CHARACTER_CLEARANCE * Math.max(Math.abs(transform.scale[0]),Math.abs(transform.scale[2]));
      const height = (object.kind === "character" ? characterStandingSize(object).height : 1.2) * Math.abs(transform.scale[1]);
      position = constrainSpatialPoint(position,obstacle,{min:[-radius,0,-radius],max:[radius,height,radius]},true,supportedWalking);
    } else position = pushOutside2D(position, getObstacleBounds(obstacle), CHARACTER_CLEARANCE);
  }
  return { ...transform, position };
}

export function constrainCameraPosition(
  position: [number, number, number],
  scene: SceneSettings,
  objects: DirectorObject[]
) {
  if (!scene.pathCollisionEnabled) return position;
  const floorY = spatialGroundAt([position[0],position[1]-CAMERA_CLEARANCE,position[2]],objects,scene.groundHeight,"below") + CAMERA_CLEARANCE;
  let next: [number, number, number] = [position[0], Math.max(position[1], floorY), position[2]];
  for (const obstacle of getObstacles(objects)) {
    next = obstacle.spatial?.volumes.length && !obstacle.spatialNeedsReview
      ? constrainSpatialPoint(next,obstacle,{min:[-CAMERA_CLEARANCE,-CAMERA_CLEARANCE,-CAMERA_CLEARANCE],max:[CAMERA_CLEARANCE,CAMERA_CLEARANCE,CAMERA_CLEARANCE]},false)
      : pushOutside3D(next, getObstacleBounds(obstacle), CAMERA_CLEARANCE, floorY);
  }
  next[1] = Math.max(next[1],floorY);
  return next;
}
