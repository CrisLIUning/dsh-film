// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorObject, DirectorProject, SceneSettings } from './directorProject.js';
import { applyEulerXYZ, add, multiplyScalar, normalize, sub, type Vec3 } from './vec3.js';

export type LightKind = 'directional' | 'point' | 'spot';
export interface DirectorLight {
  kind: LightKind; enabled: boolean; role: 'key' | 'fill' | 'rim' | 'other';
  color: string; temperatureK: number | null; intensity: number;
  distance: number; decay: number; angle: number; penumbra: number;
  shadow: { enabled: boolean; mapSize: 512 | 1024 | 2048; extent: number; far: number };
}
export interface SceneLightingSettings { ambient: number; color: string }
export type LightingCommand =
  | {type:'light';id:string;name?:string;visible?:boolean;locked?:boolean;position?:Vec3;rotation?:Vec3;settings:DirectorLight}
  | {type:'lighting';ambient:number;color:string}
  | {type:'lighting_preset';preset:'daylight'|'window'|'three-point';at:Vec3};
export const LIGHT_NAMES:Record<LightKind,string>={directional:'平行光',point:'点光',spot:'聚光'};
export const LIGHTING_PRESETS = [{id:'daylight',name:'日光'},{id:'window',name:'窗光'},{id:'three-point',name:'三点布光'}] as const;
export function defaultLight(kind:LightKind):DirectorLight {
  return {kind,enabled:true,role:'other',color:'#ffffff',temperatureK:null,intensity:kind==='directional'?1.2:40,
    distance:0,decay:2,angle:35,penumbra:.5,shadow:{enabled:false,mapSize:1024,extent:10,far:50}};
}
const num=(v:unknown,min:number,max:number,label:string)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error(`${label}需要 ${min}–${max} 范围内的数字`);};
const color=(v:unknown)=>{if(typeof v!=='string'||!/^#[\da-f]{6}$/i.test(v))throw new Error('灯光颜色需要六位十六进制颜色');};
const vec=(v:unknown)=>{if(!Array.isArray(v)||v.length!==3||!v.every(n=>typeof n==='number'&&Number.isFinite(n)))throw new Error('灯光位置/旋转需要三个有限数字');};
export function validateLight(value:unknown):asserts value is DirectorLight {
  const s=value as DirectorLight;
  if(!s||!['directional','point','spot'].includes(s.kind)||typeof s.enabled!=='boolean'||!['key','fill','rim','other'].includes(s.role))throw new Error('灯光类型、开关或用途无效');
  color(s.color);if(s.temperatureK!==null)num(s.temperatureK,2000,10000,'近似色温 K');
  num(s.intensity,0,1e6,'灯光强度');num(s.distance,0,1e5,'照射距离 m');num(s.decay,0,4,'距离衰减');num(s.angle,1,89,'聚光半锥角 °');num(s.penumbra,0,1,'柔边');
  if(!s.shadow||typeof s.shadow.enabled!=='boolean'||![512,1024,2048].includes(s.shadow.mapSize))throw new Error('阴影设置无效');
  num(s.shadow.extent,.1,1e4,'阴影半宽 m');num(s.shadow.far,.1,1e5,'阴影最远距离 m');
}
export function validateSceneLighting(project:Pick<DirectorProject,'scene'|'objects'>){
  if(project.scene.lighting!==undefined){if(!project.scene.lighting)throw new Error("场景照明设置无效");num(project.scene.lighting.ambient,0,10,'环境补光');color(project.scene.lighting.color);}
  for(const o of project.objects){
    if(o.kind==='light'){
      if(!project.scene.lighting)throw new Error('灯具需要明确的场景照明设置');
      validateLight(o.light);vec(o.transform.position);vec(o.transform.rotation);
      if(o.motionClips?.length||o.actionClips?.length||o.lookClips?.length)throw new Error('灯具暂不支持动画轨道');
    }else if(o.light!==undefined)throw new Error('只有灯具对象可以包含灯光设置');
  }
}
export function parseLightingCommand(raw:unknown):LightingCommand {
  const v=raw as LightingCommand;
  if(v?.type==='lighting'){num(v.ambient,0,10,'环境补光');color(v.color);return {type:v.type,ambient:v.ambient,color:v.color};}
  if(v?.type==='lighting_preset'){
    if(!LIGHTING_PRESETS.some(p=>p.id===v.preset))throw new Error('布光预设无效');vec(v.at);return {type:v.type,preset:v.preset,at:[...v.at]};
  }
  if(v?.type!=='light'||typeof v.id!=='string'||!v.id.trim())throw new Error('灯具需要明确 ID');
  if(v.name!==undefined&&(typeof v.name!=='string'||!v.name.trim()))throw new Error('灯具名称不能为空');
  for(const key of ["visible","locked"] as const)if(v[key]!==undefined&&typeof v[key]!=="boolean")throw new Error("灯具显示/锁定应为布尔值");
  validateLight(v.settings);if(v.position!==undefined)vec(v.position);if(v.rotation!==undefined)vec(v.rotation);
  return {type:'light',id:v.id,...(v.visible!==undefined?{visible:v.visible}:{}),...(v.locked!==undefined?{locked:v.locked}:{}),settings:{...v.settings,shadow:{...v.settings.shadow}},...(v.name?{name:v.name}:{}),...(v.position?{position:[...v.position] as Vec3}:{}),...(v.rotation?{rotation:[...v.rotation] as Vec3}:{})};
}
function rotationTowards(direction:Vec3):Vec3 { const d=normalize(direction);return [Math.atan2(d[1],-d[2]),Math.asin(Math.max(-1,Math.min(1,-d[0]))),0]; }
function localPoint(world:Vec3,scene:SceneSettings):Vec3 {
  const d=multiplyScalar(sub(world,scene.position),1/scene.scale);
  return ([[1,0,0],[0,1,0],[0,0,1]] as Vec3[]).map(axis=>applyEulerXYZ(axis,scene.rotation).reduce((n,c,i)=>n+c*d[i],0)) as Vec3;
}
export function lightDirection(object:DirectorObject):Vec3 {return applyEulerXYZ([0,0,-1],object.transform.rotation);}
const makeLight=(id:string,name:string,position:Vec3,rotation:Vec3,light:DirectorLight):DirectorObject=>({id,name,kind:'light',visible:true,locked:false,transform:{position,rotation,scale:[1,1,1]},light});
/** First adoption makes the legacy world-space key selectable without changing its direction or brightness. */
function adopt(project:DirectorProject):DirectorProject {
  if(project.scene.lighting)return project;
  const p=localPoint([8,10,6],project.scene),target=localPoint([0,0,0],project.scene);
  const taken=new Set([...project.objects,...project.cameras,...project.assets,...(project.animationAssets??[])].map(item=>item.id));
  let id='light_default';while(taken.has(id))id+='_1';
  return {...project,scene:{...project.scene,lighting:{ambient:1.15,color:'#ffffff'}},objects:[...project.objects,makeLight(id,'原有主光',p,rotationTowards(sub(target,p)),defaultLight('directional'))]};
}
export function stageLighting(project:DirectorProject,raw:LightingCommand){
  const input=parseLightingCommand(raw);let next=adopt(project);const ids:string[]=[];
  if(input.type==='lighting')next={...next,scene:{...next.scene,lighting:{ambient:input.ambient,color:input.color}}};
  else if(input.type==='light'){
    const existing=next.objects.find(o=>o.id===input.id);
    if(!existing&&[...project.assets,...project.cameras,...(project.animationAssets??[])].some(item=>item.id===input.id))throw new Error('灯具 ID 已被使用');
    if(existing&&(existing.kind!=='light'||(existing.locked&&input.locked!==false)))throw new Error('灯具 ID 被其他对象占用或已锁定');
    const o=existing??makeLight(input.id,input.name??LIGHT_NAMES[input.settings.kind],input.position??[2,3,3],[0,0,0],input.settings);
    const updated={...o,...(input.visible!==undefined?{visible:input.visible}:{}),...(input.locked!==undefined?{locked:input.locked}:{}),name:input.name??o.name,light:input.settings,transform:{...o.transform,
      position:input.position??o.transform.position,rotation:input.rotation?.map(n=>n*Math.PI/180) as Vec3??o.transform.rotation}};
    next={...next,objects:existing?next.objects.map(o=>o===existing?updated:o):[...next.objects,updated]};ids.push(updated.id);
  }else{
    // Applying a rig is explicit replacement of lights, never of actors/cameras.
    if(next.objects.some(o=>o.kind==='light'&&o.locked))throw new Error('请先解锁现有灯具，再替换布光');
    const objects=next.objects.filter(o=>o.kind!=='light');
    const definitions:Array<{name:string;kind:LightKind;p:Vec3;intensity:number;temperature:number;role:DirectorLight['role']}> = input.preset==='daylight'
      ?[{name:'日光',kind:'directional',p:[8,10,6],intensity:3,temperature:5500,role:'key'}]
      :input.preset==='window'?[{name:'窗侧主光',kind:'spot',p:[-3,3,2],intensity:100,temperature:6500,role:'key'},{name:'室内补光',kind:'point',p:[2,2,2],intensity:8,temperature:3500,role:'fill'}]
      :[{name:'主光',kind:'spot',p:[-3,3,4],intensity:90,temperature:5500,role:'key'},{name:'补光',kind:'spot',p:[3,2,3],intensity:30,temperature:6500,role:'fill'},{name:'轮廓光',kind:'spot',p:[1,3,-3],intensity:100,temperature:4500,role:'rim'}];
    for(const d of definitions){let id=`light_${ids.length+1}`;while([...objects,...next.cameras,...next.assets,...(next.animationAssets??[])].some(o=>o.id===id))id+='_1';const p=add(input.at,d.p);
      const defaults=defaultLight(d.kind);const settings={...defaults,intensity:d.intensity,temperatureK:d.temperature,role:d.role,shadow:{...defaults.shadow,enabled:d.role==='key'}};
      objects.push(makeLight(id,d.name,p,rotationTowards(sub(add(input.at,[0,1,0]),p)),settings));ids.push(id);}
    next={...next,objects,scene:{...next.scene,lighting:{ambient:.15,color:'#ffffff'}}};
  }
  validateSceneLighting(next);return {project:next,ids};
}
