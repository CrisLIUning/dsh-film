// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorObject } from './directorProject.js';
import type { ModelBounds } from './modelCalibration.js';
import { hasObjectMotion } from './objectMotion.js';
import { spatialInverseRows } from './spatialProfile.js';
import { curvePoint, planePolynomial, roots, routeCurvePieces, valueAt, type Polynomial, type SpatialCurvePiece } from './spatialCurve.js';
import { expandSpatialPlane, spatialVolumeShapes, type SpatialPlane } from './spatialGeometry.js';
import { spatialSupportHeight, SPATIAL_STEP_HEIGHT } from './spatialTerrain.js';
import type { Vec3 } from './vec3.js';

export interface SpatialSweepHit {
  reason?: "support-ended";
  objectId: string;
  volumeId: string;
  /** Geometric curve cursor: segment index + local parameter. Independent of FPS. */
  cursor: number;
  position: Vec3;
}
type Interval = [number, number];
function firstInside(curve: Polynomial[], planes: SpatialPlane[], lo: number, hi: number, gates: Polynomial[] = [], contacts: Interval[] = []): number | null {
  const distances=[...planes.map(p=>planePolynomial(curve,p.normal,p.offset)),...gates];
  for(const [a,b,c,d] of distances) {
    if(Math.min(a,a+b/3,a+2*b/3+c/3,a+b+c+d)>=-1e-10)return null;
  }
  const cuts=[lo,hi,...contacts.flat(),...distances.flatMap(p=>roots(p,lo,hi))].sort((a,b)=>a-b);
  for(let i=1;i<cuts.length;i++) {
    if(cuts[i]-cuts[i-1]<1e-13)continue;
    const middle=(cuts[i]+cuts[i-1])/2;
    if(contacts.some(([a,b])=>middle>=a&&middle<=b))continue;
    if(distances.every(p=>valueAt(p,middle)<-1e-10))return cuts[i-1];
  }
  return null;
}
interface SupportContact { objectId:string; volumeId:string; interval:Interval }
function connectedStep(a:SpatialCurvePiece,b:SpatialCurvePiece) {
  if(!a.walking||!b.walking||Math.abs(a.segment+a.hi-b.segment-b.lo)>1e-8)return false;
  const end=curvePoint(a.curve,a.hi),start=curvePoint(b.curve,b.lo);
  return Math.hypot(end[0]-start[0],end[2]-start[2])<1e-8&&Math.abs(end[1]-start[1])<=SPATIAL_STEP_HEIGHT+1e-8;
}
/** Only the continuous approach/departure inside the body's horizontal reach.
 * A later visit to the same floor cannot make an earlier collision disappear. */
function contactInterval(piece:SpatialCurvePiece,point:Vec3,body:ModelBounds,forward:boolean):Interval|null {
  const planes=[0,2].flatMap(axis=>[-1,1].map(sign=>{
    const n:Vec3=[0,0,0];n[axis]=sign;
    const edge=point[axis]-(sign===1?body.min[axis]:body.max[axis]);
    return planePolynomial(piece.curve,n,sign*edge);
  }));
  const cuts=[piece.lo,piece.hi,...planes.flatMap(p=>roots(p,piece.lo,piece.hi))].sort((a,b)=>a-b);
  let edge=forward?piece.lo:piece.hi;
  for(let j=1;j<cuts.length;j++) {
    const i=forward?j:cuts.length-j,a=cuts[i-1],b=cuts[i];
    if(b-a<1e-13)continue;
    if(!planes.every(p=>valueAt(p,(a+b)/2)<=1e-10))break;
    edge=forward?b:a;
  }
  const interval:Interval=forward?[piece.lo,edge]:[edge,piece.hi];
  return interval[1]-interval[0]>1e-13?interval:null;
}
/** Terrain has already verified the step heights along the authored route.
 * Let the conservative torso envelope overlap that connected floor while feet
 * enter/leave it. Walls, ceilings, sideways approaches and unreachable risers
 * retain their normal sweep; there is no global exemption for a future floor. */
function walkingContacts(pieces:SpatialCurvePiece[],body:ModelBounds):SupportContact[][] {
  const contacts:SupportContact[][]=pieces.map(()=>[]);
  for(let boundary=1;boundary<pieces.length;boundary++) {
    const a=pieces[boundary-1],b=pieces[boundary];
    if(!connectedStep(a,b)||a.support?.objectId===b.support?.objectId&&a.support?.volumeId===b.support?.volumeId)continue;
    const point=curvePoint(a.curve,a.hi);
    for(const direction of [-1,1]) {
      const support=direction===-1?b.support:a.support;if(!support)continue;
      for(let i=direction===-1?boundary-1:boundary;i>=0&&i<pieces.length;i+=direction) {
        const piece=pieces[i],interval=contactInterval(piece,point,body,direction===1);
        if(!interval)break;
        contacts[i].push({...support,interval});
        if(direction===1?interval[1]<piece.hi:interval[0]>piece.lo)break;
        const next=pieces[i+direction];
        if(!next||!(direction===1?connectedStep(piece,next):connectedStep(next,piece)))break;
      }
    }
  }
  return contacts;
}
export function hasSpatialObstacles(objects: DirectorObject[], exceptId?: string) {
  return objects.some(o => o.id !== exceptId && o.visible && !o.spatialNeedsReview && !!o.spatial?.volumes.length && !hasObjectMotion(o));
}
/** First intersection of the actual linear/Catmull-Rom curve and authored static
 * proxies, expanded by a conservative scene-axis body envelope. No previous-frame
 * state or frame-rate-dependent integration. */
export function sweepSpatialCurve(points: Vec3[], smooth: boolean, start: number, end: number,
  body: ModelBounds, objects: DirectorObject[], exceptId?: string): SpatialSweepHit | null {
  return sweepSpatialPieces(routeCurvePieces(points,smooth,start,end),body,objects,exceptId);
}
export function sweepSpatialPieces(pieces:SpatialCurvePiece[],body:ModelBounds,objects:DirectorObject[],exceptId?:string):SpatialSweepHit|null {
  let best:SpatialSweepHit|null=null;
  const contacts=walkingContacts(pieces,body);
  for(const object of objects) {
    if(object.id===exceptId || !object.visible || object.spatialNeedsReview || !object.spatial?.volumes.length || hasObjectMotion(object))continue;
    const rows=spatialInverseRows(object.transform);if(!rows)continue;
    for(const [index,piece] of pieces.entries()) {
      if(best&&piece.segment+piece.lo>best.cursor)continue;
      const local=rows.map(row=>planePolynomial(piece.curve,row,row.reduce((s,n,j)=>s+n*object.transform.position[j],0)));
      for(const volume of object.spatial.volumes) {
        // A character standing on an explicitly resolved support may overlap the
        // next tread with its conservative body envelope; it must not hit its own ground.
        if(piece.support?.objectId===object.id && piece.support.volumeId===volume.id)continue;
        const allowed=piece.walking&&volume.role==='floor'
          ?contacts[index].filter(c=>c.objectId===object.id&&c.volumeId===volume.id).map(c=>c.interval):[];
        for(const shape of spatialVolumeShapes(volume)) {
          const gates:Polynomial[]=[];
          if(piece.walking&&volume.role==='floor') {
            const top=spatialSupportHeight(shape.top,rows,object.transform.position);
            if(top) gates.push(planePolynomial(piece.curve,[-top.normal[0],1,-top.normal[2]],top.offset-SPATIAL_STEP_HEIGHT));
          }
          const hit=firstInside(local,shape.planes.map(p=>expandSpatialPlane(p,rows,body)),piece.lo,piece.hi,gates,allowed);
          if(hit===null||(best&&piece.segment+hit>=best.cursor))continue;
          best={objectId:object.id,volumeId:volume.id,cursor:piece.segment+hit,
            position:curvePoint(piece.curve,Math.max(piece.lo,hit-1e-9))};
        }
      }
    }
  }
  return best;
}
