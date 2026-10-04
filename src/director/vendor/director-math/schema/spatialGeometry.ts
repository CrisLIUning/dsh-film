// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { ModelBounds } from './modelCalibration.js';
import type { SpatialVolume } from './spatialProfile.js';
import { spatialVolumeSolids } from './spatialProfile.js';
import type { Vec3 } from './vec3.js';

/** Convex solid: dot(normal, point) <= offset. All coordinates are object-local. */
export interface SpatialPlane { normal: Vec3; offset: number }
export interface SpatialShape { bounds: ModelBounds; planes: SpatialPlane[]; top: SpatialPlane; edges: Vec3[] }
const axes = [0,1,2] as const;
const dot = (a:Vec3,b:Vec3)=>a.reduce((s,n,i)=>s+n*b[i],0);
function boxShape(bounds:ModelBounds):SpatialShape {
  const planes:SpatialPlane[]=axes.flatMap(i=>[-1,1].map(sign=>{
    const normal:Vec3=[0,0,0];normal[i]=sign;
    return {normal,offset:sign*(sign===1?bounds.max[i]:bounds.min[i])};
  }));
  const corners=Array.from({length:8},(_,mask)=>axes.map(i=>mask&(1<<i)?bounds.max[i]:bounds.min[i]) as Vec3);
  const edges=corners.flatMap((p,mask)=>axes.flatMap(i=>mask&(1<<i)?[]:[p,corners[mask|(1<<i)]]));
  return {bounds,planes,top:{normal:[0,1,0],offset:bounds.max[1]},edges};
}
// Volume edits replace their identity. Retain derived proxy geometry without
// allocating every tread, plane and overlay edge again on each playback frame.
const shapeCache=new WeakMap<SpatialVolume,SpatialShape[]>();
export function spatialVolumeShapes(volume:SpatialVolume):SpatialShape[] {
  let shapes=shapeCache.get(volume);
  if(!shapes){shapes=buildVolumeShapes(volume);shapeCache.set(volume,shapes);}
  return shapes;
}
function buildVolumeShapes(volume:SpatialVolume):SpatialShape[] {
  if (!volume.surface) return spatialVolumeSolids(volume).map(boxShape);
  const {bounds,surface}=volume,axis=surface.axis==='x'?0:2,other=axis===0?2:0;
  const run=bounds.max[axis]-bounds.min[axis],rise=bounds.max[1]-bounds.min[1];
  if(surface.steps) return Array.from({length:surface.steps},(_,i)=>{
    const min=[...bounds.min] as Vec3,max=[...bounds.max] as Vec3;
    const index=surface.direction===1?i:surface.steps!-i-1;
    min[axis]+=run*index/surface.steps!;max[axis]=bounds.min[axis]+run*(index+1)/surface.steps!;
    max[1]=bounds.min[1]+rise*(i+1)/surface.steps!;
    return boxShape({min,max});
  });
  const slope=rise/run*surface.direction;
  const normal:Vec3=[0,1,0];normal[axis]=-slope;
  const entry=surface.direction===1?bounds.min[axis]:bounds.max[axis];
  const top={normal,offset:bounds.min[1]-slope*entry};
  const shape=boxShape(bounds);shape.top=top;shape.planes.push(top);
  const low:Vec3=[...bounds.min],high:Vec3=[...bounds.min],bottom:Vec3=[...bounds.min];
  low[axis]=entry;high[axis]=bottom[axis]=surface.direction===1?bounds.max[axis]:bounds.min[axis];high[1]=bounds.max[1];
  const a=[low,high,bottom],b=a.map(p=>{const q=[...p] as Vec3;q[other]=bounds.max[other];return q;});
  shape.edges=a.flatMap((p,i)=>[p,a[(i+1)%3],b[i],b[(i+1)%3],p,b[i]]);
  return [shape];
}
/** Expand any local convex plane by a scene-axis body. This handles ramp normals,
 * rotation, reflection and nonuniform scale without turning a wedge into a box. */
export function expandSpatialPlane(plane:SpatialPlane,rows:Vec3[],body:ModelBounds):SpatialPlane {
  const sceneNormal=axes.map(i=>plane.normal.reduce((s,n,j)=>s+n*rows[j][i],0)) as Vec3;
  const minimum=sceneNormal.reduce((s,n,i)=>s+n*(n>=0?body.min[i]:body.max[i]),0);
  return {...plane,offset:plane.offset-minimum};
}
export const spatialPlaneDistance=(plane:SpatialPlane,point:Vec3)=>dot(plane.normal,point)-plane.offset;
