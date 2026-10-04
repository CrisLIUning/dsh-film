/**
 * Stairs resolved from a plan, the floor-rectangle arithmetic shared by mesh
 * generation and support checks, and the access inspection run on the compiled
 * solids (stair outside the floor, landing without floor, blocked clearance,
 * unreachable floor). Ported verbatim from Studio
 * (apps/daemon/src/space-plan/access.ts), keeping its style; only imports changed.
 * @module dsh-film/space-plan/access
 */

import type { SpacePlan, SpacePlanDefaults } from './types.js';
import type { SpacePart } from './compile.js';
import type { SpacePlanAccessReport, SpacePlanStairAccess, SpacePlanAccessIssue } from './types.js';
export type PlanRect = [number, number, number, number];
/** Two plan rectangles share area (touching edges do not count). */
export const planRectsOverlap=(a:PlanRect,b:PlanRect)=>a[0]<b[2]-1e-6&&a[2]>b[0]+1e-6&&a[1]<b[3]-1e-6&&a[3]>b[1]+1e-6;
/** Disjoint rectangles covering base minus every cut; shared by mesh generation and support checks. */
export function subtractPlanRects(base:PlanRect,cuts:PlanRect[]):PlanRect[] {
  let pieces=[base];
  for(const cut of cuts)pieces=pieces.flatMap(r=>{
    if(!planRectsOverlap(r,cut))return [r];
    const x0=Math.max(r[0],cut[0]),z0=Math.max(r[1],cut[1]),x1=Math.min(r[2],cut[2]),z1=Math.min(r[3],cut[3]);
    return [[r[0],r[1],x0,r[3]],[x1,r[1],r[2],r[3]],[x0,r[1],x1,z0],[x0,z1,x1,r[3]]].filter(p=>p[2]!-p[0]!>1e-6&&p[3]!-p[1]!>1e-6) as PlanRect[];
  });return pieces;
}
/** The floor of a level: the footprint plus every wing on that level, as plan rectangles. */
export function planFloorRects(plan:SpacePlan,levelId:string):PlanRect[] {
  return [[-plan.footprint.width/2,-plan.footprint.depth/2,plan.footprint.width/2,plan.footprint.depth/2],...(plan.wings??[]).filter(w=>w.levels.includes(levelId)).map(w=>[Math.min(w.rect[0],w.rect[2]),Math.min(w.rect[1],w.rect[3]),Math.max(w.rect[0],w.rect[2]),Math.max(w.rect[1],w.rect[3])] as PlanRect)];
}
/** Each stair as a flight: steps, rise, going, footprint and both landings (mm); stairs naming unknown or non-climbing levels are dropped. */
export function resolveSpacePlanStairs(plan:SpacePlan,d:SpacePlanDefaults):SpacePlanStairAccess[] {
  return (plan.stairs??[]).flatMap(stair=>{
    const from=plan.levels.find(l=>l.id===stair.from),to=plan.levels.find(l=>l.id===stair.to);
    if(!from||!to||to.elevation<=from.elevation)return [];
    const steps=Math.max(1,Math.round((to.elevation-from.elevation)/175)),going=stair.run??d.stepRun;
    const axis=stair.direction==='east'||stair.direction==='west'?0:1,sign=stair.direction==='north'||stair.direction==='west'?-1:1;
    const start=stair.at,end=[...start] as [number,number];end[axis]+=sign*steps*going;
    const rectangle=(a:number,b:number):PlanRect=>axis===0?[Math.min(a,b),start[1]-stair.width/2,Math.max(a,b),start[1]+stair.width/2]:[start[0]-stair.width/2,Math.min(a,b),start[0]+stair.width/2,Math.max(a,b)];
    const landingDepth=stair.landingDepth??stair.width,headroom=stair.headroom??d.doorHeight;
    return [{id:stair.id,from:from.id,to:to.id,start:[start[0],from.elevation,start[1]],end:[end[0],to.elevation,end[1]],steps,rise:(to.elevation-from.elevation)/steps,going,width:stair.width,headroom,landingDepth,
      footprint:rectangle(start[axis],end[axis]),lowerLanding:rectangle(start[axis]-sign*landingDepth,start[axis]),upperLanding:rectangle(end[axis],end[axis]+sign*landingDepth)}];
  });
}
/** The stair footprints a floor at this elevation must leave open. */
export function stairOpeningsAt(stairs:SpacePlanStairAccess[],elevation:number):PlanRect[] {
  // Open every intersected upper floor, including skipped intermediate storeys.
  return stairs.filter(s=>elevation>s.start[1]&&elevation<=s.end[1]).map(s=>s.footprint);
}
/** Checks the actual compiled solids, not just whether floor IDs were mentioned. All dimensions are mm. */
export function inspectSpacePlanAccess(plan:SpacePlan,stairs:SpacePlanStairAccess[],parts:SpacePart[]):SpacePlanAccessReport {
  const issues:SpacePlanAccessIssue[]=[];
  const add=(stair:SpacePlanStairAccess,code:SpacePlanAccessIssue['code'],message:string,partNames:string[]=[],levelId?:string)=>issues.push({code,message,stairId:stair.id,partNames,...(levelId?{levelId}:{})});
  for(const stair of stairs){
    for(const levelId of [stair.from,stair.to])if(subtractPlanRects(stair.footprint,planFloorRects(plan,levelId)).length)add(stair,'stair-outside-floor',`${stair.id} 楼梯越出 ${levelId} 的楼面范围；请修改脚点、方向或建筑尺寸`,[],levelId);
    for(const [rect,levelId,elevation,label] of [[stair.lowerLanding,stair.from,stair.start[1],'下'],[stair.upperLanding,stair.to,stair.end[1],'上']] as const){
      const supports=parts.filter(p=>p.role==='slab'&&Math.abs((p.position[1]+p.size[1]/2)*1000-elevation)<1e-5).map(p=>[(p.position[0]-p.size[0]/2)*1000,(p.position[2]-p.size[2]/2)*1000,(p.position[0]+p.size[0]/2)*1000,(p.position[2]+p.size[2]/2)*1000] as PlanRect);
      if(subtractPlanRects(rect,supports).length)add(stair,'landing-without-floor',`${stair.id} ${label}平台缺少完整楼面支撑（需要 ${stair.landingDepth} mm 深度）；请检查边缘或其他楼梯洞`,[],levelId);
    }
    const ascendingX=stair.start[0]!==stair.end[0],axis=ascendingX?0:2,sign=stair.end[axis]>stair.start[axis]?1:-1;
    const prisms=[{rect:stair.lowerLanding,y:stair.start[1]},{rect:stair.upperLanding,y:stair.end[1]},...Array.from({length:stair.steps},(_,i)=>{
      const a=stair.start[axis]+sign*i*stair.going,b=a+sign*stair.going;
      return {rect:(ascendingX?[Math.min(a,b),stair.footprint[1],Math.max(a,b),stair.footprint[3]]:[stair.footprint[0],Math.min(a,b),stair.footprint[2],Math.max(a,b)]) as PlanRect,y:stair.start[1]+(i+1)*stair.rise};
    })];
    const blocked=parts.filter(p=>!(p.role==='step'&&p.group===stair.id)&&prisms.some(({rect,y})=>{
      const bottom=(p.position[1]-p.size[1]/2)*1000,top=(p.position[1]+p.size[1]/2)*1000;
      if(top<=y+1e-5||bottom>=y+stair.headroom-1e-5)return false;
      const halfX=(p.kind==='box'?p.size[0]/2:p.size[0])*1000,halfZ=(p.kind==='box'?p.size[2]/2:p.size[2])*1000;
      return planRectsOverlap(rect,[p.position[0]*1000-halfX,p.position[2]*1000-halfZ,p.position[0]*1000+halfX,p.position[2]*1000+halfZ]);
    }));
    if(blocked.length)add(stair,'stair-clearance-blocked',`${stair.id} 楼梯或平台的 ${stair.headroom} mm 净空被墙体/顶板等构件阻挡，共 ${blocked.length} 处，请查看相关构件`,blocked.map(p=>p.name));
  }
  // Reachability means a path from the lowest floor, not membership in any disconnected pair.
  const lowest=[...plan.levels].sort((a,b)=>a.elevation-b.elevation)[0];
  const reached=new Set(lowest?[lowest.id]:[]),valid=stairs.filter(s=>!issues.some(i=>i.stairId===s.id));
  let changed=true;while(changed){changed=false;for(const s of valid)if(reached.has(s.from)!==reached.has(s.to)){reached.add(s.from);reached.add(s.to);changed=true;}}
  for(const level of plan.levels)if(!reached.has(level.id))issues.push({code:'floor-unreachable',levelId:level.id,partNames:[],message:`${level.name} 没有楼梯可达（从最低层连续连接），请检查楼梯连接、平台和净空`});
  return {units:'mm',stairs,issues};
}
