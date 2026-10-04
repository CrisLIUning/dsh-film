/**
 * Structural checks of a plan before any geometry is allocated: a malformed
 * nested dimension is refused (SpacePlanInputError), while contradictions stay
 * warnings for the compiler to report. Ported verbatim from Studio
 * (apps/daemon/src/space-plan/input.ts), keeping its style; only the import changed.
 * @module dsh-film/space-plan/input
 */

import type { SpacePlan } from './types.js';
export class SpacePlanInputError extends Error {}
/** Reject malformed nested dimensions before geometry allocation; consistency issues remain warnings. */
export function assertSpacePlanInput(value:unknown):asserts value is SpacePlan {
  const fail=(path:string):never=>{throw new SpacePlanInputError(`平面字段无效：${path}`);};
  const record=(v:unknown,path:string):Record<string,unknown>=>!v||typeof v!=='object'||Array.isArray(v)?fail(path):v as Record<string,unknown>;
  const number=(v:unknown,path:string,min=-Infinity)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min)fail(path);};
  const positive=(v:unknown,path:string)=>{number(v,path);if((v as number)<=0)fail(path);};
  const string=(v:unknown,path:string)=>{if(typeof v!=='string'||!v.trim())fail(path);};
  const list=(v:unknown,path:string):unknown[]=>Array.isArray(v)?v:fail(path);
  const vector=(v:unknown,n:number,path:string)=>{const a=list(v,path);if(a.length!==n)fail(path);a.forEach((x,i)=>number(x,`${path}[${i}]`));};
  const p=record(value,'plan'),foot=record(p.footprint,'footprint');string(p.name,'name');positive(foot.width,'footprint.width');positive(foot.depth,'footprint.depth');
  const levels=list(p.levels,'levels');if(!levels.length)fail('levels');
  levels.forEach((v,i)=>{const l=record(v,`levels[${i}]`);string(l.id,`levels[${i}].id`);string(l.name,`levels[${i}].name`);number(l.elevation,`levels[${i}].elevation`);positive(l.height,`levels[${i}].height`);if(l.rooms!==undefined)list(l.rooms,'rooms').forEach(r=>string(r,'rooms'));});
  if(p.defaults!==undefined){const d=record(p.defaults,'defaults');for(const key of ['wallThickness','interiorWallThickness','slabThickness','doorWidth','doorHeight','windowWidth','windowHeight','stepRun'])if(d[key]!==undefined)positive(d[key],`defaults.${key}`);if(d.windowSill!==undefined)number(d.windowSill,'defaults.windowSill',0);}
  if(p.stairs!==undefined)list(p.stairs,'stairs').forEach((v,i)=>{const s=record(v,`stairs[${i}]`);for(const key of ['id','from','to'])string(s[key],`stairs[${i}].${key}`);vector(s.at,2,`stairs[${i}].at`);positive(s.width,`stairs[${i}].width`);for(const key of ['run','landingDepth','headroom'])if(s[key]!==undefined)positive(s[key],`stairs[${i}].${key}`);if(!['north','south','east','west'].includes(s.direction as string))fail(`stairs[${i}].direction`);});
  if(p.wings!==undefined)list(p.wings,'wings').forEach((v,i)=>{const w=record(v,`wings[${i}]`);string(w.id,'wing.id');vector(w.rect,4,'wing.rect');list(w.levels,'wing.levels').forEach(l=>string(l,'wing.level'));});
  if(p.towers!==undefined)list(p.towers,'towers').forEach((v,i)=>{const t=record(v,`towers[${i}]`);string(t.id,'tower.id');vector(t.at,2,'tower.at');positive(t.diameter,'tower.diameter');positive(t.top,'tower.top');if(t.roofHeight!==undefined)number(t.roofHeight,'tower.roofHeight',0);});
  if(p.interior!==undefined){const i=record(p.interior,'interior');for(const key of ['spineX','spineZ'])if(i[key]!==undefined)list(i[key],key).forEach(v=>number(v,key));if(i.hall!==undefined){const h=record(i.hall,'interior.hall');vector(h.rect,4,'hall.rect');list(h.levels,'hall.levels').forEach(l=>string(l,'hall.level'));}}
  if(p.openings!==undefined){const o=record(p.openings,'openings');if(o.exteriorWindowPitch!==undefined)number(o.exteriorWindowPitch,'exteriorWindowPitch',0);}
  if(p.entrance!==undefined){const e=record(p.entrance,'entrance');vector(e.at,2,'entrance.at');for(const key of ['width','stepRise','stepRun'])positive(e[key],`entrance.${key}`);number(e.steps,'entrance.steps',0);if(!Number.isInteger(e.steps))fail('entrance.steps');}
}
