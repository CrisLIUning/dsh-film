/** Camera micro-motion ops. Ported from Studio's apps/daemon/tests/director-micro-motion.test.ts (paths only; async diagnostics awaited). */
import { expect,it } from 'vitest';
import { directorSample,directorStructure } from '../../src/director/query.js';
import { parseDirectorStagePlan,stageDirectorScene } from '../../src/director/staging.js';
import { CAMERA_MICRO_MOTION_PRESETS } from '../../src/director/vendor/director-math/schema/cameraMicroMotion.js';
import { upgradeDirectorProject } from '../../src/director/vendor/director-math/schema/directorProjectMigration.js';
import { character,lockedCamera,project } from './fixtures.js';

it('stages, saves and queries one effective layer with repeatable source timing and explicit clip off',()=>{
  const source=project([character('actor',[0,0,0])],[lockedCamera('cam',[0,2,8],[0,1,0],50,{motionPath:{duration:4,loop:false,interpolation:'linear',easing:'linear',keyframes:[0,1].map((time,i)=>({id:String(i),time,position:[0,2,8],target:[0,1,0],fov:50}))}})],{pathCollisionEnabled:false});
  const settings=structuredClone(CAMERA_MICRO_MOTION_PRESETS[1]!.settings),clip=source.cameras[0]!.motionClips[0]!;
  const plan=(value:unknown)=>parseDirectorStagePlan({ops:[value]});
  const base=stageDirectorScene(source,plan({type:'camera_micro_motion',cameraId:'cam',settings}));
  expect(base.applied[0]).toMatchObject({type:'camera_micro_motion',cameraId:'cam'});
  expect(source.cameras[0]!.microMotion).toBeUndefined();
  const saved=upgradeDirectorProject(JSON.parse(JSON.stringify(base.project)));
  expect(directorStructure(saved).cameras[0]!.microMotion).toEqual(settings);
  const frame=(p:typeof source,t:number)=>directorSample(p,{kind:'sample',at:[t]}).frames[0]!.cameras[0]!;
  const at=frame(saved,1.25);expect(at.microMotion).toMatchObject({scope:'camera',seconds:1.25,settings});
  expect(at.position).not.toEqual(frame(source,1.25).position);expect(at.fov).toBe(50);
  for(const t of [0,8,3,1.25]){frame(saved,t);expect(frame(saved,1.25)).toEqual(at);}
  expect(frame(saved,8).position).toEqual(frame(saved,4).position);
  const off=stageDirectorScene(saved,plan({type:'camera_micro_motion',cameraId:'cam',clipId:clip.id,settings:{...settings,enabled:false}})).project;
  expect(frame(off,1.25).position).toEqual(frame(source,1.25).position);
  expect(directorStructure(off).cameras[0]!.clips[0]!.microMotion?.enabled).toBe(false);
  const inherit=stageDirectorScene(off,plan({type:'camera_micro_motion',cameraId:'cam',clipId:clip.id,settings:null})).project;
  expect(frame(inherit,1.25)).toEqual(at);
  const restaged=stageDirectorScene(saved,plan({type:'shot',cameraId:'cam',shot:{subject:'actor',size:'full'},seconds:4})).project;
  expect(restaged.cameras[0]!.microMotion).toEqual(settings);
  expect(()=>plan({type:'camera_micro_motion',cameraId:'cam',settings:{...settings,seed:-1}})).toThrow('种子');
});
