// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { sub, normalize, lengthSq, type Vec3 } from './vec3.js';

export function dot(a: Vec3, b: Vec3) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
}

/** Three's lookAt basis, including its exact pole fallback, with authored roll.
 * forward points into the shot; right/up are the displayed image axes. */
export function cameraFrameBasis(view: {position:Vec3;target:Vec3;roll?:number}) {
  let z=sub(view.position,view.target);
  if(lengthSq(z)===0)z=[0,0,1];
  z=normalize(z);
  let right=cross([0,1,0],z);
  if(lengthSq(right)===0){z=normalize([z[0],z[1],z[2]+.0001]);right=cross([0,1,0],z);}
  right=normalize(right);
  const up=cross(z,right), r=(view.roll??0)*Math.PI/180, c=Math.cos(r), s=Math.sin(r);
  return {
    right: [right[0]*c+up[0]*s,right[1]*c+up[1]*s,right[2]*c+up[2]*s] as Vec3,
    up: [up[0]*c-right[0]*s,up[1]*c-right[1]*s,up[2]*c-right[2]*s] as Vec3,
    forward: [-z[0],-z[1],-z[2]] as Vec3,
  };
}

export function rotateAroundAxis(vector:Vec3,axis:Vec3,degrees:number):Vec3 {
  const radians=degrees*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians),perpendicular=cross(axis,vector),parallel=dot(axis,vector)*(1-c);
  return [vector[0]*c+perpendicular[0]*s+axis[0]*parallel,vector[1]*c+perpendicular[1]*s+axis[1]*parallel,vector[2]*c+perpendicular[2]*s+axis[2]*parallel];
}

export function cameraRollFromBasis(position:Vec3,target:Vec3,up:Vec3) {
  const basis=cameraFrameBasis({position,target});
  return Math.atan2(-dot(up,basis.right),dot(up,basis.up))*180/Math.PI;
}
