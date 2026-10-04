// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { Quaternion, Vector3 } from './motionMath.js';
import { sampleMotionPosition, type MotionInterpolation } from './authoredMotionCurves.js';

export const MOTION_FINGERS = ['Thumb','Index','Middle','Ring','Pinky'] as const;
export type MotionFinger = typeof MOTION_FINGERS[number];
export type MotionHand = 'LeftHand'|'RightHand';
export type MotionHandPose = 'open'|'relaxed'|'fist'|'point'|'victory';
export type MotionHandKey = {
  at:number; pose:MotionHandPose; stop?:boolean;
  /** 0 = rest extension, 1 = closed; overrides the selected pose per finger. */
  curl?:Partial<Record<MotionFinger,number>>;
  /** 0..1, fans the four fingers at their base. */
  spread?:number;
  /** 0..1, brings the thumb across the palm, separately from thumb curl. */
  thumbOpposition?:number;
};
export type MotionHandPoses = Partial<Record<MotionHand,MotionHandKey[]>>;
const presets:Record<MotionHandPose,{curl:number[];spread:number;thumbOpposition:number}>={
  open:{curl:[0,0,0,0,0],spread:0,thumbOpposition:0},
  relaxed:{curl:[.15,.18,.24,.3,.34],spread:0,thumbOpposition:.1},
  fist:{curl:[.65,1,1,1,1],spread:0,thumbOpposition:1},
  point:{curl:[.65,0,1,1,1],spread:0,thumbOpposition:1},
  victory:{curl:[.65,0,0,1,1],spread:.7,thumbOpposition:1},
};
export function validateMotionHands(input:unknown,duration:number):asserts input is MotionHandPoses|undefined {
  if(input===undefined)return;
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='LeftHand'&&k!=='RightHand'))throw new Error('Invalid handPoses');
  const unit=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
  for(const [hand,keys] of Object.entries(input)){
    if(!Array.isArray(keys)||keys.length<2||keys.length>128)throw new Error(`${hand}: needs 2–128 hand pose keys`);
    let previous=-1;
    for(const key of keys){
      if(!key||!Number.isFinite(key.at)||key.at<0||key.at>duration||key.at<=previous||!Object.prototype.hasOwnProperty.call(presets,key.pose))throw new Error(`${hand}: invalid hand pose/time`);
      if(key.stop!==undefined&&typeof key.stop!=='boolean')throw new Error(`${hand}: invalid stop marker`);
      if(key.curl!==undefined&&(!key.curl||typeof key.curl!=='object'||Array.isArray(key.curl)||Object.entries(key.curl).some(([finger,v])=>!MOTION_FINGERS.includes(finger as MotionFinger)||!unit(v))))throw new Error(`${hand}: invalid finger curl (0..1)`);
      if((key.spread!==undefined&&!unit(key.spread))||(key.thumbOpposition!==undefined&&!unit(key.thumbOpposition)))throw new Error(`${hand}: invalid spread/opposition (0..1)`);
      previous=key.at;
    }
    if(keys[0].at!==0||keys[keys.length-1].at!==duration)throw new Error(`${hand}: hand pose keys must cover duration`);
  }
}

/** Only requested hands add finger chains. Old body clips remain byte-compatible
 * in topology and never start resetting a character's unauthored fingers. */
export function motionFingerRig(hands:MotionHandPoses={}) {
  const rig:Array<[string,string,[number,number,number]]>=[];
  for(const hand of ['LeftHand','RightHand'] as const){
    if(!hands[hand])continue;
    const sign=hand==='LeftHand'?1:-1;
    for(const finger of MOTION_FINGERS){
      const offsets:Record<MotionFinger,number[][]>={
        Thumb:[[.03,-.008,.025],[.024,0,.025],[.022,0,.022],[.019,0,.019]],
        Index:[[.078,0,.025],[.034,0,0],[.025,0,0],[.022,0,0]],
        Middle:[[.083,0,0],[.037,0,0],[.028,0,0],[.023,0,0]],
        Ring:[[.078,0,-.022],[.034,0,0],[.026,0,0],[.022,0,0]],
        Pinky:[[.07,0,-.041],[.027,0,0],[.021,0,0],[.019,0,0]],
      };
      offsets[finger].forEach(([x,y,z],i)=>rig.push([`${hand}${finger}${i+1}`,i?`${hand}${finger}${i}`:hand,[sign*x,y,z]]));
    }
  }
  return rig;
}

export function sampleMotionHand(keys:MotionHandKey[],time:number,mode?:MotionInterpolation){
  // Interpolate bounded anatomical controls, not discrete preset names. Held
  // poses/stops retain the same semantics as the body's continuous curves.
  const sample=(get:(k:MotionHandKey)=>number)=>sampleMotionPosition(keys.map(k=>({at:k.at,stop:k.stop,position:[get(k),0,0] as [number,number,number]})),time,mode).x;
  return {
    curl:MOTION_FINGERS.map((finger,i)=>sample(k=>k.curl?.[finger]??presets[k.pose].curl[i])),
    spread:sample(k=>k.spread??presets[k.pose].spread),
    thumbOpposition:sample(k=>k.thumbOpposition??presets[k.pose].thumbOpposition),
  };
}

export function sampleFingerRotations(hands:MotionHandPoses|undefined,time:number,mode?:MotionInterpolation){
  const result=new Map<string,Quaternion>();
  for(const [hand,keys] of Object.entries(hands??{})){
    const sign=hand==='LeftHand'?1:-1, state=sampleMotionHand(keys,time,mode);
    for(const [i,finger] of MOTION_FINGERS.entries())for(let segment=1;segment<=3;segment++){
      const curl=state.curl[i];let rotation:Quaternion;
      if(finger==='Thumb'){
        // Thumb has opposition at the saddle joint, not the four fingers'
        // simple hinge. Later phalanges flex in their own rest direction plane.
        rotation=segment===1?new Quaternion().setFromDegrees([0,sign*50*state.thumbOpposition,-sign*48*curl])
          :new Quaternion().setFromAxisAngle(new Vector3(0,sign,0),(segment===2?45:55)*curl*Math.PI/180);
      }else{
        const bend=[72,92,62][segment-1]*curl;
        rotation=new Quaternion().setFromDegrees([0,segment===1?-sign*[0,12,0,-9,-17][i]*state.spread:0,-sign*bend]);
      }
      result.set(`${hand}${finger}${segment}`,rotation);
    }
  }
  return result;
}
