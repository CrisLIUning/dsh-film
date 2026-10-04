// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { Quaternion, Vector3 } from './motionMath.js';

export type MotionInterpolation = 'smooth' | 'continuous';
export type TimedMotionKey = { at: number; stop?: boolean };
type RotationKey = TimedMotionKey & { degrees: [number, number, number] };
type PositionKey = TimedMotionKey & { position: [number, number, number] };
const ease = (u: number) => u*u*(3-2*u);

function interval(keys: TimedMotionKey[], seconds: number) {
  const right = keys.findIndex(key => key.at >= seconds);
  const i = right <= 0 ? 0 : right-1;
  return {i, span:keys[i+1].at-keys[i].at, u:(seconds-keys[i].at)/(keys[i+1].at-keys[i].at)};
}

// Monotone cubic Hermite: continuous velocity without overshooting position
// bounds or disturbing a constant planted interval. Uneven key times matter.
function tangent(keys: PositionKey[], i: number, axis: number) {
  if (!i || i===keys.length-1 || keys[i].stop) return 0;
  const hp=keys[i].at-keys[i-1].at, hn=keys[i+1].at-keys[i].at;
  const before=(keys[i].position[axis]-keys[i-1].position[axis])/hp;
  const after=(keys[i+1].position[axis]-keys[i].position[axis])/hn;
  if (before*after<=0) return 0;
  const w1=2*hn+hp, w2=hn+2*hp;
  return (w1+w2)/(w1/before+w2/after);
}

export function sampleMotionPosition(keys: PositionKey[], seconds: number, mode: MotionInterpolation = 'smooth') {
  if (seconds<=keys[0].at) return new Vector3(...keys[0].position);
  if (seconds>=keys[keys.length-1].at) return new Vector3(...keys[keys.length-1].position);
  const {i,span,u}=interval(keys,seconds), a=keys[i], b=keys[i+1];
  if (mode==='smooth') return new Vector3(...a.position).lerp(new Vector3(...b.position),ease(u));
  const values=a.position.map((v,axis) => (2*u**3-3*u*u+1)*v+(u**3-2*u*u+u)*span*tangent(keys,i,axis)
    +(-2*u**3+3*u*u)*b.position[axis]+(u**3-u*u)*span*tangent(keys,i+1,axis));
  return new Vector3(values[0],values[1],values[2]);
}

function logDelta(a: Quaternion, b: Quaternion) {
  const q=a.clone().invert().multiply(b);
  if(q.w<0) q.fromArray(q.toArray().map(n=>-n));
  const length=Math.hypot(q.x,q.y,q.z), angle=Math.atan2(length,Math.max(-1,Math.min(1,q.w)));
  return length<1e-12 ? new Vector3() : new Vector3(q.x*angle/length,q.y*angle/length,q.z*angle/length);
}
function exp(v: Vector3) {
  const angle=v.length(), scale=angle<1e-12 ? 1 : Math.sin(angle)/angle;
  return new Quaternion().fromArray([v.x*scale,v.y*scale,v.z*scale,Math.cos(angle)]).normalize();
}
function angularTangent(keys: RotationKey[], i: number) {
  if(!i || i===keys.length-1 || keys[i].stop) return new Vector3();
  const hp=keys[i].at-keys[i-1].at, hn=keys[i+1].at-keys[i].at;
  const q=new Quaternion().setFromDegrees(keys[i].degrees);
  const before=logDelta(q,new Quaternion().setFromDegrees(keys[i-1].degrees));
  const after=logDelta(q,new Quaternion().setFromDegrees(keys[i+1].degrees));
  const left=new Vector3().addScaledVector(before,-1/hp), right=new Vector3().addScaledVector(after,1/hn);
  if(left.dot(right)<=0) return new Vector3(); // hold or reversal is a natural stop
  const v=new Vector3().addScaledVector(left,hn/(hp+hn)).addScaledVector(right,hp/(hp+hn));
  const limit=Math.min(left.length(),right.length());
  return v.length()>limit ? new Vector3().addScaledVector(v,limit/v.length()) : v;
}

/** Spherical Bezier with time-scaled, shared angular tangents. Local quaternion
 * tangents avoid Euler wrap discontinuities; endpoints/explicit stops rest.
 * This is curve continuity, not a dynamics or balance solver. */
export function sampleMotionRotation(keys: RotationKey[], seconds: number, mode: MotionInterpolation = 'smooth') {
  if(seconds<=keys[0].at) return new Quaternion().setFromDegrees(keys[0].degrees);
  if(seconds>=keys[keys.length-1].at) return new Quaternion().setFromDegrees(keys[keys.length-1].degrees);
  const {i,span,u}=interval(keys,seconds);
  const a=new Quaternion().setFromDegrees(keys[i].degrees), b=new Quaternion().setFromDegrees(keys[i+1].degrees);
  if(mode==='smooth') return a.slerp(b,ease(u)).normalize();
  const c=a.clone().multiply(exp(new Vector3().addScaledVector(angularTangent(keys,i),span/3)));
  const d=b.clone().multiply(exp(new Vector3().addScaledVector(angularTangent(keys,i+1),-span/3)));
  const ab=a.clone().slerp(c,u), bc=c.clone().slerp(d,u), cd=d.clone().slerp(b,u);
  return ab.slerp(bc,u).slerp(bc.clone().slerp(cd,u),u).normalize();
}
