// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorObject } from './directorProject.js';
import { hasObjectMotion } from './objectMotion.js';
import { spatialInverseRows } from './spatialProfile.js';
import { spatialVolumeShapes, type SpatialPlane } from './spatialGeometry.js';
import { curvePoint, planePolynomial, roots, routeCurvePieces, type SpatialCurvePiece } from './spatialCurve.js';
import type { Vec3 } from './vec3.js';

/** Maximum vertical step between connected supports, in scene metres.
 * This is blocking previs, not foot planting, jumping, falling or navigation. */
export const SPATIAL_STEP_HEIGHT = .25;
interface Support {
  objectId:string;volumeId:string;transition?:boolean;
  height:{normal:Vec3;offset:number};footprint:SpatialPlane[];
}
export interface SpatialTerrainRoute { pieces:SpatialCurvePiece[]; stop?: {objectId:string;volumeId:string;cursor:number;position:Vec3;reason:'support-ended'} }
export function hasSpatialTerrain(objects:DirectorObject[]) {
  return objects.some(o=>o.visible&&!o.spatialNeedsReview&&!hasObjectMotion(o)&&o.spatial?.volumes.some(v=>v.surface));
}
/** World height equation of a local support plane; refuses vertical/downward faces. */
export function spatialSupportHeight(top:SpatialPlane,rows:Vec3[],position:Vec3) {
  const normal=[0,1,2].map(i=>top.normal.reduce((s,n,j)=>s+n*rows[j][i],0)) as Vec3;
  if(normal[1]<=1e-9)return null;
  const offset=top.offset+normal.reduce((s,n,i)=>s+n*position[i],0);
  return {normal:[-normal[0]/normal[1],0,-normal[2]/normal[1]] as Vec3,offset:offset/normal[1]};
}
const heightAt=(support:Support,point:Vec3)=>support.height.normal[0]*point[0]+support.height.normal[2]*point[2]+support.height.offset;
const contains=(support:Support,point:Vec3)=>support.footprint.every(p=>p.normal[0]*point[0]+p.normal[2]*point[2]<=p.offset+1e-8);
const cache=new WeakMap<DirectorObject[],Support[]>();
function supportsFor(objects:DirectorObject[]):Support[] {
  const saved=cache.get(objects);if(saved)return saved;
  const supports:Support[]=[];
  for(const object of objects) {
    if(!object.visible||object.spatialNeedsReview||!object.spatial||hasObjectMotion(object))continue;
    const rows=spatialInverseRows(object.transform);if(!rows)continue;
    for(const volume of object.spatial.volumes)if(volume.role==='floor') {
      spatialVolumeShapes(volume).forEach(shape=>{
        const height=spatialSupportHeight(shape.top,rows,object.transform.position);if(!height)return;
        const footprint=shape.planes.map(plane=>{
          const n=[0,1,2].map(i=>plane.normal.reduce((s,v,j)=>s+v*rows[j][i],0)) as Vec3;
          return {normal:[n[0]+n[1]*height.normal[0],0,n[2]+n[1]*height.normal[2]] as Vec3,
            offset:plane.offset+n.reduce((s,v,i)=>s+v*object.transform.position[i],0)-n[1]*height.offset};
        });
        supports.push({objectId:object.id,volumeId:volume.id,transition:!!volume.surface,height,footprint});
      });
    }
  }
  cache.set(objects,supports);return supports;
}
/** Resolve the retained take from its authored start, once, not from the last
 * displayed frame. Exact curve/footprint intersections keep narrow treads and
 * reversed/smooth routes independent of playback rate and seek order. */
export function spatialTerrainRoute(points:Vec3[],smooth:boolean,start:number,end:number,objects:DirectorObject[],ground:number):SpatialTerrainRoute {
  const raw=routeCurvePieces(points,smooth,start,end),pieces:SpatialCurvePiece[]=[];
  const groundSupport:Support={objectId:'',volumeId:'',height:{normal:[0,0,0],offset:ground},footprint:[]};
  const supports=[...supportsFor(objects),groundSupport];
  let active:Support|undefined;
  // Trimming changes the retained travel, not the source take's chosen storey.
  // Seed height from source terrain only; walls/collisions before the trim are not replayed.
  const prefix=start>0?spatialTerrainRoute(points,smooth,0,start,objects,ground):null;
  const initialHeight=prefix&&!prefix.stop?sampleSpatialTerrain(prefix,start)?.[1]:undefined;
  for(const piece of raw) {
    const cuts=[piece.lo,piece.hi,...supports.flatMap(s=>s.footprint.flatMap(p=>roots(planePolynomial(piece.curve,p.normal,p.offset),piece.lo,piece.hi)))].sort((a,b)=>a-b);
    for(let i=1;i<cuts.length;i++) {
      const lo=cuts[i-1],hi=cuts[i];if(hi-lo<1e-10)continue;
      const entry=curvePoint(piece.curve,lo),middle=curvePoint(piece.curve,(lo+hi)/2);
      const candidates=supports.filter(s=>contains(s,middle));
      const previousHeight=active?heightAt(active,entry):(initialHeight??entry[1]);
      const closest=candidates.filter(s=>!active||Math.abs(heightAt(s,entry)-previousHeight)<=SPATIAL_STEP_HEIGHT+1e-8)
        .sort((a,b)=>{
          const distance=Math.abs(heightAt(a,entry)-previousHeight)-Math.abs(heightAt(b,entry)-previousHeight);
          if(!active)return distance;
          const sameVolume=(s:Support)=>s.objectId===active!.objectId&&s.volumeId===active!.volumeId;
          return Number(a===groundSupport)-Number(b===groundSupport)
            ||Number(!sameVolume(a))-Number(!sameVolume(b))||distance;
        });
      // Stay on the current storey until it ends. Ground yields to an explicitly
      // connected support; an overlapping ceiling cannot steal a lower route.
      const enterTransition=active&&!active.transition?closest.find(s=>s.transition):undefined;
      const next=enterTransition??(active&&active!==groundSupport&&candidates.includes(active)?active:closest[0]);
      if(!next) {
        const position=[entry[0],previousHeight,entry[2]] as Vec3;
        return {pieces,stop:{objectId:active!.objectId,volumeId:active!.volumeId,cursor:piece.segment+lo,position,reason:'support-ended'}};
      }
      active=next;
      const curve=[...piece.curve];
      curve[1]=planePolynomial(piece.curve,active.height.normal,-active.height.offset);
      pieces.push({...piece,lo,hi,curve,walking:true,...(active===groundSupport?{}:{support:{objectId:active.objectId,volumeId:active.volumeId}})});
    }
  }
  return {pieces};
}
export function sampleSpatialTerrain(route:SpatialTerrainRoute,cursor:number):Vec3|null {
  if(route.stop&&cursor>=route.stop.cursor)return route.stop.position;
  const piece=[...route.pieces].reverse().find(p=>cursor>=p.segment+p.lo-1e-9);
  return piece?curvePoint(piece.curve,Math.min(piece.hi,Math.max(piece.lo,cursor-piece.segment))):null;
}
