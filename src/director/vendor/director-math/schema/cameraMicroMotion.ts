// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { CameraViewSnapshot } from './cameraGeometry.js';
import { cameraFrameBasis, cameraRollFromBasis, rotateAroundAxis } from './cameraFrameBasis.js';
import { add, sub, length, multiplyScalar, type Vec3 } from './vec3.js';

export interface CameraMicroMotionSettings {
  enabled: boolean;
  /** Stable uint32 seed; changing it is an explicit new variation. */
  seed: number;
  /** Lens-local right/up/forward amplitudes in metres. */
  translation: Vec3;
  /** Local pitch/yaw/roll amplitudes in degrees. */
  rotation: Vec3;
  /** Base noise frequency in Hz; the additional octaves stay bounded. */
  frequency: number;
  clock: 'scene' | 'source';
}

export const CAMERA_MICRO_MOTION_PRESETS: ReadonlyArray<{
  id: 'breathing' | 'handheld'; name: string; settings: CameraMicroMotionSettings;
}> = [
  {id:'breathing',name:'轻微呼吸',settings:{enabled:true,seed:1,translation:[.003,.006,.002],rotation:[.12,.1,.06],frequency:.45,clock:'scene'}},
  {id:'handheld',name:'平稳手持',settings:{enabled:true,seed:1,translation:[.015,.02,.008],rotation:[.45,.35,.25],frequency:1.2,clock:'source'}},
];

export function validateCameraMicroMotion(value:CameraMicroMotionSettings):void {
  if(!value || typeof value.enabled!=='boolean')throw new Error('微运动需要明确启用状态');
  if(!Number.isInteger(value.seed)||value.seed<0||value.seed>0xffffffff)throw new Error('微运动种子必须是 0–4294967295 的整数');
  for(const [key,limit,unit] of [['translation',.25,'米'],['rotation',5,'度']] as const){
    const vector=value[key];
    if(!Array.isArray(vector)||vector.length!==3||!vector.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=limit))throw new Error(`微运动 ${key} 三轴幅度必须在 0–${limit} ${unit}之间`);
  }
  if(!Number.isFinite(value.frequency)||value.frequency<.05||value.frequency>5)throw new Error('微运动频率必须在 0.05–5 Hz 之间');
  if(value.clock!=='scene'&&value.clock!=='source')throw new Error('微运动时钟必须是 scene 或 source');
}

function lattice(seed:number,channel:number,index:number) {
  let h=(seed^Math.imul(channel+1,0x9e3779b9)^Math.imul(index,0x85ebca6b))>>>0;
  h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);
  return ((h^(h>>>16))>>>0)/0xffffffff*2-1;
}
function noise(seed:number,channel:number,time:number) {
  const i=Math.floor(time),t=time-i;
  // Quintic interpolation has continuous first/second derivatives at the grid.
  const a=t*t*t*(t*(t*6-15)+10), left=lattice(seed,channel,i);
  return left+(lattice(seed,channel,i+1)-left)*a;
}
function channel(settings:CameraMicroMotionSettings,id:number,seconds:number) {
  const t=seconds*settings.frequency;
  return (noise(settings.seed,id,t)+.5*noise(settings.seed,id+6,t*2.03)+.25*noise(settings.seed,id+12,t*4.11))/1.75;
}

/** All random variation is a function of the saved seed and resolved seconds.
 * There is no frame counter, wall clock, accumulated transform or random state. */
export function sampleCameraMicroMotion(settings:CameraMicroMotionSettings,sceneSeconds:number,sourceSeconds?:number) {
  validateCameraMicroMotion(settings);
  if(!Number.isFinite(sceneSeconds)||sceneSeconds<0||sourceSeconds!==undefined&&(!Number.isFinite(sourceSeconds)||sourceSeconds<0))throw new Error('微运动采样需要非负有限秒数');
  const seconds=settings.clock==='source'&&sourceSeconds!==undefined?sourceSeconds:sceneSeconds;
  if(!Number.isSafeInteger(Math.ceil(seconds*settings.frequency*4.11)))throw new Error('微运动采样超出可精确计算的时间范围');
  const translation=settings.translation.map((amplitude,axis)=>settings.enabled?amplitude*channel(settings,axis,seconds):0) as Vec3;
  const rotation=settings.rotation.map((amplitude,axis)=>settings.enabled?amplitude*channel(settings,axis+3,seconds):0) as Vec3;
  return {seconds,translation,rotation};
}

/** Apply after authored motion and composition. A caller may constrain the short
 * lens translation against the same scene envelope used by camera trajectories. */
export function applyCameraMicroMotion<T extends CameraViewSnapshot>(view:T, settings:CameraMicroMotionSettings|undefined,
  sceneSeconds:number,sourceSeconds?:number,constrain?: (from:Vec3,to:Vec3)=>Vec3):T {
  if(!settings?.enabled)return view;
  const sampled=sampleCameraMicroMotion(settings,sceneSeconds,sourceSeconds);
  if([...sampled.translation,...sampled.rotation].every(value=>value===0))return view;
  const basis=cameraFrameBasis(view),right=basis.right;
  let {up,forward}=basis;
  const offset=add(add(multiplyScalar(right,sampled.translation[0]),multiplyScalar(up,sampled.translation[1])),multiplyScalar(forward,sampled.translation[2]));
  const desired=add(view.position,offset),position=constrain?constrain(view.position,desired):desired;
  forward=rotateAroundAxis(forward,right,sampled.rotation[0]);up=rotateAroundAxis(up,right,sampled.rotation[0]);
  forward=rotateAroundAxis(forward,up,sampled.rotation[1]);
  up=rotateAroundAxis(up,forward,-sampled.rotation[2]);
  // A coincident position/target uses Three's default -Z orientation. Retain a
  // nonzero aim distance so rotations are not lost when serializing that view.
  const target=add(position,multiplyScalar(forward,length(sub(view.target,view.position)) || 1));
  return {...view,position,target,roll:cameraRollFromBasis(position,target,up)};
}
