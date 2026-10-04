// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { consolidateStairCandidates, type TaggedStairPart } from "./modelStructureStairs.js";
import type { DirectorAssetRef } from "./directorProject.js";
import { resolveModelCalibration, validateModelBounds, type ModelBounds } from "./modelCalibration.js";
import { validateSpatialProfile, type SpatialProfile, type SpatialVolume } from "./spatialProfile.js";
import { applyEulerXYZ, type Vec3 } from "./vec3.js";

/** Source-model coordinates, before asset calibration or scene instance transforms. */
export interface ModelStructurePart {
  id:string; name:string; group:string; corners:Vec3[];
  role:"wall"|"slab"|"roof"|"step"|null; shape:"box"|"cylinder"|"cone"|null;
}
export interface ModelStructureSourceCheck { code:string;message:string;partNames:string[];stairId?:string;levelId?:string }
export interface ModelStructureInspection { bounds:ModelBounds; parts:ModelStructurePart[];sourceChecks?:ModelStructureSourceCheck[] }
/** Generator findings are source evidence, never a claim about a resized instance. */
export function readStructureSourceChecks(value:unknown):ModelStructureSourceCheck[] {
  if(!Array.isArray(value))return [];
  return value.filter((v):v is ModelStructureSourceCheck=>!!v&&typeof v==='object'&&typeof v.code==='string'&&typeof v.message==='string'&&Array.isArray(v.partNames)&&v.partNames.every((n:unknown)=>typeof n==='string')&&(v.stairId===undefined||typeof v.stairId==='string')&&(v.levelId===undefined||typeof v.levelId==='string'))
    .map(v=>({code:v.code,message:v.message,partNames:[...v.partNames],...(v.stairId!==undefined?{stairId:v.stairId}:{}),...(v.levelId!==undefined?{levelId:v.levelId}:{})}));
}
export interface SpatialStructureCandidate {
  volume:SpatialVolume; group:string; evidence:"metadata"|"name"|"bounds";
  recommended:boolean; warnings:string[]; sourcePartIds:string[];
  composition?:{kind:"stair-flight";parts:number;sourceVolumeIds:string[]};
}
export function validateModelStructure(value:unknown):asserts value is ModelStructureInspection {
  const raw=value as ModelStructureInspection;
  if(!raw||!Array.isArray(raw.parts))throw new Error("模型结构需要 bounds 和 parts");
  if(raw.sourceChecks!==undefined&&(!Array.isArray(raw.sourceChecks)||readStructureSourceChecks(raw.sourceChecks).length!==raw.sourceChecks.length))throw new Error("模型检查信息无效");
  validateModelBounds(raw.bounds);const ids=new Set<string>();
  for(const p of raw.parts){
    if(!p||typeof p.id!=="string"||!p.id||ids.has(p.id)||typeof p.name!=="string"||!p.name.trim()||typeof p.group!=="string")throw new Error("模型结构部件 ID 或名称无效");
    ids.add(p.id);
    if(!Array.isArray(p.corners)||p.corners.length!==8||!p.corners.every(v=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==="number"&&Number.isFinite(n))))throw new Error("模型结构部件需要 8 个有效包围角点");
    if(![null,"wall","slab","roof","step"].includes(p.role)||![null,"box","cylinder","cone"].includes(p.shape))throw new Error("模型结构类型无效");
  }
}
function namedRole(name:string):SpatialVolume["role"]|null {
  if(/ceiling|roof|顶板|屋顶|天花/i.test(name))return "ceiling";
  if(/(?:^|[^a-z])(floor|slab)(?:[^a-z]|$)|楼面|楼板|地板/i.test(name))return "floor";
  if(/(?:^|[^a-z])wall(?:[^a-z]|$)|墙/i.test(name))return "wall";
  return null;
}
export function spatialStructureCandidates(inspection:ModelStructureInspection,asset:DirectorAssetRef):SpatialStructureCandidate[] {
  validateModelStructure(inspection);
  const calibration=resolveModelCalibration(inspection.bounds,asset.modelCalibration);
  const result:SpatialStructureCandidate[]=[],stairs:TaggedStairPart[]=[];
  const incompleteStairGroups=new Set(inspection.parts.filter(p=>p.role!=="step").map(p=>p.group));
  for(const part of inspection.parts){
    const corners=part.corners.map(p=>applyEulerXYZ(p,calibration.rotation).map((v,i)=>v*calibration.scale+calibration.position[i]) as Vec3);
    const bounds={min:[0,1,2].map(i=>Math.min(...corners.map(p=>p[i]))) as Vec3,max:[0,1,2].map(i=>Math.max(...corners.map(p=>p[i]))) as Vec3};
    const edges=[1,2,4].map(index=>part.corners[index].map((v,i)=>v-part.corners[0][i]) as Vec3);
    const [a,b,c]=edges;
    const determinant=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
    const edgeProduct=edges.reduce((product,e)=>product*Math.hypot(...e),1);
    const flat=Math.abs(determinant)<=edgeProduct*1e-10;
    // A zero-thickness surface is evidence for inspection, not a solid collision volume.
    if(flat){if(part.role==="step")incompleteStairGroups.add(part.group);continue;}
    const inferred=namedRole(part.name),role=part.role==="wall"?"wall":part.role==="slab"?"floor":part.role==="roof"?"ceiling":inferred??"obstacle";
    const evidence=part.role?"metadata":inferred?"name":"bounds";
    const aligned=corners.every(p=>p.every((v,i)=>Math.min(Math.abs(v-bounds.min[i]),Math.abs(v-bounds.max[i]))<1e-6));
    const warnings:string[]=[];
    if(evidence==="name")warnings.push("类型根据构件名称推测，请核对用途与开口");
    if(evidence==="bounds")warnings.push("未识别构件用途，默认不选中");
    if(part.shape!=="box"||!aligned)warnings.push("仅有包围范围，可能包含可通行空隙；请拆分或补开口后再应用");
    if(part.role==="step")warnings.push("台阶需要按整段标注楼梯支撑，单个踏面不能代替连续上下楼");
    const candidate:SpatialStructureCandidate={volume:{id:`model:${asset.id}:${part.id}`,name:part.name,role,bounds},group:part.group,evidence,recommended:evidence==="metadata"&&part.role!=="step"&&aligned&&part.shape==="box",warnings,sourcePartIds:[part.id]};
    result.push(candidate);
    if(part.role==="step")stairs.push({candidate,alignedBox:aligned&&part.shape==="box"});
  }
  return consolidateStairCandidates(result,stairs,incompleteStairGroups);
}
/** A flight cannot be adopted on top of its individually reviewed source treads. */
export function spatialCandidateConflicts(profile:SpatialProfile|null,candidate:SpatialStructureCandidate):string[] {
  const sources=new Set(candidate.composition?.sourceVolumeIds??[]);
  return (profile?.volumes??[]).filter(v=>sources.has(v.id)).map(v=>v.id);
}
/** Append explicitly reviewed candidates, preserving every existing proxy and anchor. */
export function appendSpatialCandidates(base:SpatialProfile|null,candidates:SpatialStructureCandidate[],ids:string[]):SpatialProfile {
  const profile=base??{volumes:[],anchors:[]};validateSpatialProfile(profile);
  const selected=new Set(ids);
  if(selected.size!==ids.length||ids.some(id=>!candidates.some(c=>c.volume.id===id)))throw new Error("所选结构候选已不存在或 ID 重复，请重新提取");
  const existing=new Set([...profile.volumes,...profile.anchors].map(v=>v.id));
  if(ids.some(id=>existing.has(id)))throw new Error("已有同来源空间标注，请编辑现有条目或删除后重新提取");
  if(candidates.some(c=>selected.has(c.volume.id)&&spatialCandidateConflicts(profile,c).length))throw new Error("已有单级台阶标注。请先复核并移除这些标注，再采用整段楼梯，避免重复支撑。");
  const result={volumes:[...profile.volumes,...candidates.filter(c=>selected.has(c.volume.id)).map(c=>structuredClone(c.volume))],anchors:profile.anchors};
  validateSpatialProfile(result);return result;
}
