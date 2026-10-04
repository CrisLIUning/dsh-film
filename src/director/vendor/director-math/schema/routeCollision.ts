// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { coefficients, type Polynomial } from './spatialCurve.js';
import type { DirectorCameraShot, DirectorObject, SceneSettings } from './directorProject.js';
import { getCameraMotionCurveCursor, getCameraMotionPath, getCameraMotionSnapshot } from './cameraMotion.js';
import { getObjectMotionCurveCursor, getObjectMotionSnapshot, getObjectMotionSpeed } from './objectMotion.js';
import { characterStandingSize } from './characterSizing.js';
import { constrainCameraPosition, constrainObjectMotionTransform } from './pathCollision.js';
import { spatialGroundAt } from './spatialProfile.js';
import { hasSpatialTerrain, spatialTerrainRoute, sampleSpatialTerrain, type SpatialTerrainRoute } from './spatialTerrain.js';
import { hasSpatialObstacles, sweepSpatialCurve, sweepSpatialPieces, type SpatialSweepHit } from './spatialSweep.js';
import type { Vec3 } from './vec3.js';

// Project edits replace object/scene/array identities. These bounded weak caches
// memoize derived geometry, never playback history; seek order cannot change a hit.
const objectHits = new WeakMap<DirectorObject,{objects:DirectorObject[];scene:SceneSettings;clips:DirectorObject['motionClips'];hits:Map<number,{hit:SpatialSweepHit|null;terrain?:SpatialTerrainRoute}>}>();
const cameraHits = new WeakMap<object,{objects:DirectorObject[];start:number;hit:SpatialSweepHit|null}>();

/** A clip is an authored take. A later clip may deliberately start elsewhere;
 * trimmed-away source travel is never replayed as hidden collision history.
 * Position holds at the first obstruction; this does not rewrite keys or plan a detour. */
function objectRoute(object: DirectorObject, seconds: number, scene: SceneSettings, objects: DirectorObject[]) {
  if (!hasSpatialObstacles(objects,object.id)) return null;
  const sample = getObjectMotionCurveCursor(object,seconds);
  if (!sample) return null;
  let cache=objectHits.get(object);
  if(!cache||cache.objects!==objects||cache.scene!==scene||cache.clips!==object.motionClips){
    cache={objects,scene,clips:object.motionClips,hits:new Map()};objectHits.set(object,cache);
  }
  if(cache.hits.has(sample.index))return cache.hits.get(sample.index)!;
  const points = sample.clip.keyframes.map(k => k.transform.position);
  // Existing character grounding projects level routes onto the chosen storey.
  // Multi-level/stair routing remains a separate terrain resolver, not physics.
  const level = object.kind === 'character' && points.every(p => Math.abs(p[1]-points[0][1]) < 1e-9);
  const route = level ? points.map(p => [p[0],spatialGroundAt(p,objects,scene.groundHeight),p[2]] as Vec3) : points;
  const isolated={...object,motionClips:[sample.clip]};
  const end=getObjectMotionCurveCursor(isolated,sample.clip.end)!.cursor;
  const scales = [getObjectMotionSnapshot(isolated,sample.clip.start).scale,getObjectMotionSnapshot(isolated,sample.clip.end).scale,
    ...sample.clip.keyframes.filter((_,i)=>i>=sample.start&&i<=end).map(k => k.transform.scale)];
  const radius = .32 * Math.max(...scales.flatMap(s => [Math.abs(s[0]),Math.abs(s[2])]));
  const height = (object.kind === 'character' ? characterStandingSize(object).height : 1.2) * Math.max(...scales.map(s => Math.abs(s[1])));
  const body={min:[-radius,0,-radius] as Vec3,max:[radius,height,radius] as Vec3};
  const terrain=object.kind==='character'&&hasSpatialTerrain(objects)
    // Keep the source take's approach contacts beyond a trimmed endpoint. Hits
    // there remain outside the retained cursor and never stop this clip early.
    ?spatialTerrainRoute(points,sample.clip.interpolation==='smooth',sample.start,points.length-1,objects,scene.groundHeight):undefined;
  let hit=terrain?sweepSpatialPieces(terrain.pieces,body,objects,object.id)
    :sweepSpatialCurve(route,sample.clip.interpolation==='smooth',sample.start,end,body,objects,object.id);
  if(terrain?.stop&&(!hit||terrain.stop.cursor<hit.cursor))hit=terrain.stop;
  const result={hit,terrain};cache.hits.set(sample.index,result);return result;
}
export function getObjectRouteCollision(object:DirectorObject,seconds:number,scene:SceneSettings,objects:DirectorObject[]):SpatialSweepHit|null {
  const sample=getObjectMotionCurveCursor(object,seconds),hit=objectRoute(object,seconds,scene,objects)?.hit;
  return hit&&sample&&hit.cursor<sample.cursor?hit:null;
}
export function getObjectTerrainPosition(object:DirectorObject,seconds:number,scene:SceneSettings,objects:DirectorObject[]):Vec3|null {
  const terrain=objectRoute(object,seconds,scene,objects)?.terrain,sample=getObjectMotionCurveCursor(object,seconds);
  return terrain&&sample?sampleSpatialTerrain(terrain,sample.cursor):null;
}
/** Continuous support-surface speed. Stair riser snapping is not a physical
 * impulse or a change to the animation clock. Legacy routes retain their speed. */
export function getConstrainedObjectMotionSpeed(object:DirectorObject,seconds:number,scene:SceneSettings,objects:DirectorObject[]):number {
  const speed=getObjectMotionSpeed(object,seconds);
  if(!scene.pathCollisionEnabled)return speed;
  if(getObjectRouteCollision(object,seconds,scene,objects))return 0;
  const route=objectRoute(object,seconds,scene,objects)?.terrain,sample=getObjectMotionCurveCursor(object,seconds);
  if(!route||!sample)return speed;
  const piece=[...route.pieces].reverse().find(p=>sample.cursor>=p.segment+p.lo-1e-9);if(!piece)return speed;
  const t=Math.max(piece.lo,Math.min(piece.hi,sample.cursor-piece.segment));
  const derivative=(p:Polynomial)=>p[1]+2*p[2]*t+3*p[3]*t*t;
  const points=sample.clip.keyframes.map(k=>k.transform.position);
  const rawLength=Math.hypot(...[0,1,2].map(axis=>derivative(coefficients(points,piece.segment,axis,sample.clip.interpolation==='smooth'))));
  return rawLength>1e-12?speed*Math.hypot(...piece.curve.map(derivative))/rawLength:0;
}
export function getConstrainedObjectMotionSnapshot(object: DirectorObject, seconds: number, scene: SceneSettings, objects: DirectorObject[]) {
  const raw = getObjectMotionSnapshot(object,seconds);
  if(!scene.pathCollisionEnabled)return raw;
  const derived=objectRoute(object,seconds,scene,objects),sample=getObjectMotionCurveCursor(object,seconds);
  const hit=derived?.hit&&sample&&derived.hit.cursor<sample.cursor?derived.hit:null;
  const terrainPosition=derived?.terrain&&sample?sampleSpatialTerrain(derived.terrain,sample.cursor):null;
  const position=hit?.position??terrainPosition??raw.position;
  return constrainObjectMotionTransform(object,{...raw,position},scene,objects,!!terrainPosition);
}
export function getCameraRouteCollision(camera: DirectorCameraShot, progress: number, startProgress: number, objects: DirectorObject[]) {
  if (!hasSpatialObstacles(objects)) return null;
  const path = getCameraMotionPath(camera);
  const key=camera.motionPath??camera;
  let cache=cameraHits.get(key);
  if(!cache||cache.objects!==objects||cache.start!==startProgress){
    cache={objects,start:startProgress,hit:sweepSpatialCurve(path.keyframes.map(k=>k.position),path.interpolation==='smooth',
      getCameraMotionCurveCursor(camera,startProgress),Math.max(0,path.keyframes.length-1),
      {min:[-.18,-.18,-.18],max:[.18,.18,.18]},objects)};
    cameraHits.set(key,cache);
  }
  return cache.hit&&cache.hit.cursor<getCameraMotionCurveCursor(camera,progress)?cache.hit:null;
}
export function getConstrainedCameraMotionPosition(camera: DirectorCameraShot, progress: number, scene: SceneSettings, objects: DirectorObject[], startProgress=0) {
  const position = getCameraMotionSnapshot(camera,progress).position;
  const hit = scene.pathCollisionEnabled ? getCameraRouteCollision(camera,progress,startProgress,objects) : null;
  return constrainCameraPosition(hit?.position??position,scene,objects);
}
