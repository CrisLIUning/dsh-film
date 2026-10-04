// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
/** Small CPU-only vector/quaternion operations. No renderer or DOM dependency. */
export class Vector3 {
  x: number; y: number; z: number;
  constructor(x=0,y=0,z=0) { this.x=x; this.y=y; this.z=z; }
  clone() { return new Vector3(this.x,this.y,this.z); }
  toArray() { return [this.x,this.y,this.z]; }
  add(v: Vector3) { this.x+=v.x; this.y+=v.y; this.z+=v.z; return this; }
  sub(v: Vector3) { this.x-=v.x; this.y-=v.y; this.z-=v.z; return this; }
  addScaledVector(v: Vector3,s: number) { this.x+=v.x*s; this.y+=v.y*s; this.z+=v.z*s; return this; }
  dot(v: Vector3) { return this.x*v.x+this.y*v.y+this.z*v.z; }
  length() { return Math.sqrt(this.dot(this)); }
  normalize() { const n=this.length() || 1; this.x/=n; this.y/=n; this.z/=n; return this; }
  distanceTo(v: Vector3) { return this.clone().sub(v).length(); }
  lerp(v: Vector3,t: number) { this.x+=(v.x-this.x)*t; this.y+=(v.y-this.y)*t; this.z+=(v.z-this.z)*t; return this; }
  applyQuaternion(q: Quaternion) {
    const tx=2*(q.y*this.z-q.z*this.y), ty=2*(q.z*this.x-q.x*this.z), tz=2*(q.x*this.y-q.y*this.x);
    this.x+=q.w*tx+q.y*tz-q.z*ty; this.y+=q.w*ty+q.z*tx-q.x*tz; this.z+=q.w*tz+q.x*ty-q.y*tx; return this;
  }
}
export class Quaternion {
  x=0; y=0; z=0; w=1;
  clone() { return new Quaternion().fromArray(this.toArray()); }
  toArray() { return [this.x,this.y,this.z,this.w]; }
  fromArray(a: number[]) { [this.x,this.y,this.z,this.w]=a; return this; }
  normalize() { const n=Math.hypot(this.x,this.y,this.z,this.w); if (!n) throw new Error('Zero quaternion'); this.x/=n;this.y/=n;this.z/=n;this.w/=n;return this; }
  invert() { this.x=-this.x;this.y=-this.y;this.z=-this.z;return this; }
  multiply(q: Quaternion) {
    const {x,y,z,w}=this;
    return this.fromArray([w*q.x+x*q.w+y*q.z-z*q.y,w*q.y-x*q.z+y*q.w+z*q.x,w*q.z+x*q.y-y*q.x+z*q.w,w*q.w-x*q.x-y*q.y-z*q.z]);
  }
  setFromAxisAngle(axis: Vector3, radians: number) {
    const s=Math.sin(radians/2);return this.fromArray([axis.x*s,axis.y*s,axis.z*s,Math.cos(radians/2)]);
  }
  setFromDegrees(d: number[]) {
    const [x,y,z]=d.map(v=>v*Math.PI/360), cx=Math.cos(x),cy=Math.cos(y),cz=Math.cos(z),sx=Math.sin(x),sy=Math.sin(y),sz=Math.sin(z);
    return this.fromArray([sx*cy*cz+cx*sy*sz,cx*sy*cz-sx*cy*sz,cx*cy*sz+sx*sy*cz,cx*cy*cz-sx*sy*sz]);
  }
  setFromUnitVectors(a: Vector3,b: Vector3) {
    const w=a.dot(b)+1;
    if (w<Number.EPSILON) return this.fromArray(Math.abs(a.x)>Math.abs(a.z)?[-a.y,a.x,0,0]:[0,-a.z,a.y,0]).normalize();
    return this.fromArray([a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x,w]).normalize();
  }
  slerp(q: Quaternion,t: number) {
    const a=this.toArray(), b=q.toArray(); let dot=a.reduce((sum,v,i)=>sum+v*b[i],0);
    if(dot<0){dot=-dot; for(let i=0;i<4;i++) b[i]=-b[i];}
    if(dot>=1) return this;
    const theta=Math.acos(dot),sin=Math.sin(theta);
    return this.fromArray(a.map((v,i)=>sin<1e-7 ? v*(1-t)+b[i]*t : (v*Math.sin((1-t)*theta)+b[i]*Math.sin(t*theta))/sin)).normalize();
  }
}
