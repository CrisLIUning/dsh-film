// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { Vec3 } from './vec3.js';
export type Polynomial = [number, number, number, number];
const axes = [0, 1, 2] as const;
export const valueAt = (p: Polynomial, t: number) => ((p[3] * t + p[2]) * t + p[1]) * t + p[0];
export function coefficients(points: Vec3[], segment: number, axis: number, smooth: boolean): Polynomial {
  const b = points[segment][axis], c = points[segment + 1][axis];
  if (!smooth || points.length < 3) return [b, c - b, 0, 0];
  const a = points[Math.max(0, segment - 1)][axis], d = points[Math.min(points.length - 1, segment + 2)][axis];
  return [b, (-a + c) / 2, (2 * a - 5 * b + 4 * c - d) / 2, (-a + 3 * b - 3 * c + d) / 2];
}
/** Split at derivative roots and bisect monotonic intervals. Thin solids and
 * curves returning to their start cannot disappear between frame samples. */
export function roots(p: Polynomial, lo: number, hi: number): number[] {
  const cuts = [lo, hi], a = 3 * p[3], b = 2 * p[2], c = p[1];
  if (Math.abs(a) < 1e-14) {
    if (Math.abs(b) > 1e-14) cuts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) cuts.push((-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a));
  }
  const split = [...new Set(cuts.filter(t => t >= lo && t <= hi))].sort((a,b) => a-b), out: number[] = [];
  for (const t of split) if (Math.abs(valueAt(p,t)) < 1e-12) out.push(t);
  for (let i = 1; i < split.length; i++) {
    let left = split[i-1], right = split[i], fl = valueAt(p,left);
    if (fl * valueAt(p,right) >= 0) continue;
    for (let k = 0; k < 52; k++) {
      const middle = (left+right)/2, fm = valueAt(p,middle);
      if (fl * fm <= 0) right = middle; else {left = middle; fl = fm;}
    }
    out.push((left+right)/2);
  }
  return out;
}

export interface SpatialCurvePiece {
  curve: Polynomial[]; segment: number; lo: number; hi: number;
  walking?: boolean;
  support?: {objectId:string;volumeId:string};
}
export const curvePoint=(curve:Polynomial[],t:number)=>curve.map(p=>valueAt(p,t)) as Vec3;
export function routeCurvePieces(points:Vec3[],smooth:boolean,start:number,end:number):SpatialCurvePiece[] {
  const pieces:SpatialCurvePiece[]=[];
  for(let segment=Math.floor(start);segment<Math.min(points.length-1,Math.ceil(end));segment++)
    pieces.push({curve:axes.map(axis=>coefficients(points,segment,axis,smooth)),segment,lo:Math.max(0,start-segment),hi:Math.min(1,end-segment)});
  return pieces;
}
export function planePolynomial(curve:Polynomial[],normal:Vec3,offset=0):Polynomial {
  const p=[0,1,2,3].map(i=>normal.reduce((s,n,j)=>s+n*curve[j][i],0)) as Polynomial;
  p[0]-=offset;return p;
}
