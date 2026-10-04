// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { expandSpatialPlane, spatialPlaneDistance, spatialVolumeShapes } from './spatialGeometry.js';
import { spatialSupportHeight, SPATIAL_STEP_HEIGHT } from './spatialTerrain.js';
import type { DirectorObject, DirectorProject, DirectorTransform } from "./directorProject.js";
import { hasObjectMotion } from "./objectMotion.js";
import { validateModelBounds, type ModelBounds } from "./modelCalibration.js";
import { add, applyEulerXYZ, multiply, sub, type Vec3 } from "./vec3.js";

/** Metres in the object's local frame, AFTER model calibration, BEFORE instance transforms.
 * Authored proxies, not measured mesh topology. Changing model calibration requires review. */
export interface SpatialOpening { id: string; name: string; bounds: ModelBounds }
export interface SpatialVolume {
  id: string; name: string; role: "wall" | "floor" | "ceiling" | "obstacle";
  bounds: ModelBounds; openings?: SpatialOpening[];
  /** Floor only: rise from bounds.min.y to bounds.max.y along a local axis.
   * Omit steps for a ramp; an integer gives actual step treads (not foot IK). */
  surface?: {axis: "x" | "z"; direction: 1 | -1; steps?: number};
}
export interface SpatialAnchor {
  id: string; name: string; purpose: "entry" | "mark" | "camera" | "prop"; position: Vec3;
}
export interface SpatialProfile { volumes: SpatialVolume[]; anchors: SpatialAnchor[] }
export interface SpatialProfileCommand { type: "set_spatial_profile"; objectId: string; profile: SpatialProfile | null }
const axes = [0, 1, 2] as const;
const vector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
function named(value: {id: string;name: string}, ids: Set<string>) {
  if (!value || typeof value.id !== "string" || !value.id.trim() || typeof value.name !== "string" || !value.name.trim()) throw new Error("空间标注需要 ID 和名称");
  if (ids.has(value.id)) throw new Error(`空间标注 ID 重复：${value.id}`);
  ids.add(value.id);
}
function volume(bounds: ModelBounds) {
  validateModelBounds(bounds);
  if (bounds.min.some((v,i) => v >= bounds.max[i])) throw new Error("空间体积的宽、高、深必须大于零");
}
export function validateSpatialProfile(value: unknown): asserts value is SpatialProfile {
  const p = value as SpatialProfile;
  if (!p || !Array.isArray(p.volumes) || !Array.isArray(p.anchors)) throw new Error("空间标注需要 volumes 和 anchors 列表");
  const ids = new Set<string>();
  for (const v of p.volumes) {
    named(v, ids); volume(v.bounds);
    if (!["wall", "floor", "ceiling", "obstacle"].includes(v.role)) throw new Error("空间体积类型无效");
    if (v.surface !== undefined) {
      const surface = v.surface;
      if (!surface || v.role !== "floor" || !["x", "z"].includes(surface.axis) || ![1,-1].includes(surface.direction)) throw new Error("坡面或楼梯需要楼面类型、X/Z 方向和正反方向");
      if (surface.steps !== undefined && (!Number.isInteger(surface.steps) || surface.steps < 1 || surface.steps > 256)) throw new Error("台阶数需要 1–256 的整数");
      if (v.openings?.length) throw new Error("坡面和楼梯不支持开口；请分段标注平台开口");
    }
    if (v.openings !== undefined && !Array.isArray(v.openings)) throw new Error("门洞需要列表");
    for (const opening of v.openings ?? []) {
      named(opening, ids); volume(opening.bounds);
      if (opening.bounds.min.some((n,i) => n < v.bounds.min[i]) || opening.bounds.max.some((n,i) => n > v.bounds.max[i])) throw new Error("开口必须位于所属体积内；贯通方向与墙厚边界对齐");
    }
  }
  for (const anchor of p.anchors) {
    named(anchor, ids);
    if (!vector(anchor.position) || !["entry", "mark", "camera", "prop"].includes(anchor.purpose)) throw new Error("定位点需要有效坐标和用途");
  }
}
export function parseSpatialProfile(value: unknown): SpatialProfileCommand {
  const raw = value as SpatialProfileCommand;
  if (!raw || raw.type !== "set_spatial_profile" || typeof raw.objectId !== "string" || !raw.objectId.trim()) throw new Error("空间标注需要 objectId");
  if (raw.profile !== null) validateSpatialProfile(raw.profile);
  return {type:"set_spatial_profile",objectId:raw.objectId,profile:raw.profile === null ? null : structuredClone(raw.profile)};
}
export function applySpatialProfile(project: DirectorProject, input: SpatialProfileCommand): DirectorProject {
  const edit = parseSpatialProfile(input), object = project.objects.find(o => o.id === edit.objectId);
  if (!object || !["scene", "prop"].includes(object.kind)) throw new Error("请选择场景或静态道具标注空间");
  if (object.locked || hasObjectMotion(object)) throw new Error("空间标注需要解锁且没有移动片段的对象");
  if (!spatialInverseRows(object.transform)) throw new Error("对象变换无效，空间标注需要非零比例");
  if (!object.spatialNeedsReview && JSON.stringify(object.spatial ?? null) === JSON.stringify(edit.profile)) return project;
  const updated = {...object};
  delete updated.spatialNeedsReview;
  if (edit.profile === null) delete updated.spatial; else updated.spatial = edit.profile;
  return {...project,objects:project.objects.map(o => o === object ? updated : o)};
}

export function spatialPointToScene(point: Vec3, transform: DirectorTransform): Vec3 {
  return add(transform.position, applyEulerXYZ(multiply(point, transform.scale), transform.rotation));
}
/** Inverse affine rows. Dot products against the orthonormal rotation basis avoid Euler-order inversion errors. */
export function spatialInverseRows(transform: DirectorTransform): Vec3[] | null {
  if (![...transform.position,...transform.rotation,...transform.scale].every(Number.isFinite) || transform.scale.some(s => Math.abs(s) < 1e-12)) return null;
  return axes.map(i => {
    const basis: Vec3 = [0,0,0]; basis[i] = 1;
    return applyEulerXYZ(basis,transform.rotation).map(n => n/transform.scale[i]) as Vec3;
  });
}
const dot = (a: Vec3,b: Vec3) => a.reduce((sum,n,i) => sum+n*b[i],0);
export function spatialPointToLocal(point: Vec3, transform: DirectorTransform): Vec3 | null {
  return spatialInverseRows(transform)?.map(row => dot(row,sub(point,transform.position))) as Vec3 ?? null;
}
/** Subtract an axis-aligned opening, retaining disjoint wall/header/sill pieces. */
export function subtractSpatialOpening(box: ModelBounds, opening: ModelBounds): ModelBounds[] {
  const min = axes.map(i => Math.max(box.min[i],opening.min[i])) as Vec3;
  const max = axes.map(i => Math.min(box.max[i],opening.max[i])) as Vec3;
  if (axes.some(i => min[i] >= max[i])) return [box];
  const pieces: ModelBounds[] = [], core = structuredClone(box);
  for (const i of axes) {
    if (core.min[i] < min[i]) { const piece=structuredClone(core);piece.max[i]=min[i];pieces.push(piece);core.min[i]=min[i]; }
    if (core.max[i] > max[i]) { const piece=structuredClone(core);piece.min[i]=max[i];pieces.push(piece);core.max[i]=max[i]; }
  }
  return pieces;
}
export function spatialVolumeSolids(volume: SpatialVolume): ModelBounds[] {
  return (volume.openings ?? []).reduce((boxes,opening) => boxes.flatMap(box => subtractSpatialOpening(box,opening.bounds)),[volume.bounds]);
}
export function spatialGroundAt(point: Vec3, objects: DirectorObject[], fallback: number, mode: "nearest" | "below" = "nearest"): number {
  const heights = [fallback];
  for (const object of objects) {
    if (!object.visible || !object.spatial || object.spatialNeedsReview || hasObjectMotion(object)) continue;
    const rows = spatialInverseRows(object.transform);
    if (!rows || Math.abs(rows[1][1]) < 1e-9) continue;
    for (const floor of object.spatial.volumes.filter(v => v.role === "floor")) {
      if (!floor.surface) {
        // Preserve v11's explicit top plane, including reflected Y and partial
        // openings. Only new walking surfaces opt into the terrain shape model.
        const y=object.transform.position[1]+(floor.bounds.max[1]-rows[1][0]*(point[0]-object.transform.position[0])-rows[1][2]*(point[2]-object.transform.position[2]))/rows[1][1];
        const local=spatialPointToLocal([point[0],y,point[2]],object.transform)!;
        if([0,2].some(i=>local[i]<floor.bounds.min[i]||local[i]>floor.bounds.max[i]))continue;
        if((floor.openings??[]).some(o=>o.bounds.max[1]>=floor.bounds.max[1]&&[0,2].every(i=>local[i]>o.bounds.min[i]&&local[i]<o.bounds.max[i])))continue;
        if(mode==='nearest'||y<=point[1]+1e-9)heights.push(y);
        continue;
      }
      for (const shape of spatialVolumeShapes(floor)) {
      const height=spatialSupportHeight(shape.top,rows,object.transform.position);
      if(!height)continue;
      const y=height.normal[0]*point[0]+height.normal[2]*point[2]+height.offset;
      const local=spatialPointToLocal([point[0],y,point[2]],object.transform)!;
      if(shape.planes.some(p=>spatialPlaneDistance(p,local)>1e-8))continue;
      if (mode === "nearest" || y <= point[1]+1e-9) heights.push(y);
      }
    }
  }
  // Authored route height selects the intended storey; never choose the topmost floor blindly.
  return heights.reduce((best,y) => Math.abs(y-point[1]) < Math.abs(best-point[1]) ? y : best);
}
/** Conservative axis-aligned body envelope in scene metres, tested against each local solid.
 * This is point-sample depenetration, not swept collision/pathfinding or posed mesh collision. */
export function constrainSpatialPoint(point: Vec3, object: DirectorObject, body: {min: Vec3;max: Vec3}, horizontal: boolean, walking = false): Vec3 {
  const rows = spatialInverseRows(object.transform);
  if (!rows || !object.spatial) return point;
  let next = point;
  for (const v of object.spatial.volumes) {
    const shapes=spatialVolumeShapes(v);
    // Static/manual placement needs the same own-support rule as route sampling.
    // Only feet actually on this reviewed surface qualify; approaching its side
    // or standing under it must retain collision with the full solid.
    if(walking&&v.role==='floor'&&v.surface&&shapes.some(shape=>{
      const top=spatialSupportHeight(shape.top,rows,object.transform.position);
      if(!top||Math.abs(top.normal[0]*next[0]+top.normal[2]*next[2]+top.offset-next[1])>1e-8)return false;
      const local=spatialPointToLocal(next,object.transform)!;
      return shape.planes.every(p=>spatialPlaneDistance(p,local)<=1e-8);
    }))continue;
    for (const shape of shapes) {
    if(walking&&v.role==='floor') {
      const top=spatialSupportHeight(shape.top,rows,object.transform.position);
      if(top&&top.normal[0]*next[0]+top.normal[2]*next[2]+top.offset<=next[1]+SPATIAL_STEP_HEIGHT+1e-9)continue;
    }
    const local = spatialPointToLocal(next,object.transform)!;
    const planes=shape.planes.map(p=>expandSpatialPlane(p,rows,body));
    if(planes.some(p=>spatialPlaneDistance(p,local)>=-1e-9))continue;
    const exits=planes.flatMap(p=>{
      const gradient=axes.map(i=>i===1&&horizontal?0:p.normal.reduce((s,n,j)=>s+n*rows[j][i],0)) as Vec3;
      const norm=dot(gradient,gradient);if(norm<1e-12)return [];
      const distance=-spatialPlaneDistance(p,local);
      return [{length:distance/Math.sqrt(norm),delta:gradient.map(n=>n*distance/norm) as Vec3}];
    }).sort((a,b)=>a.length-b.length);
    if(exits.length)next=add(next,exits[0].delta);
    }
  }
  return next;
}
export function spatialObjectSummary(object: DirectorObject) {
  const supported = object.visible && !object.spatialNeedsReview && !hasObjectMotion(object) && spatialInverseRows(object.transform) !== null;
  return {mode: object.spatial?.volumes.length ? "authored-proxy" as const : "legacy-bounds" as const,
    collisionEligible: Boolean(object.spatial?.volumes.length && supported),needsReview:object.spatialNeedsReview===true,
    ...(object.spatial ? {profile:object.spatial,anchors:object.spatial.anchors.map(a => ({...a,scenePosition:spatialPointToScene(a.position,object.transform)}))} : {}),
  };
}
