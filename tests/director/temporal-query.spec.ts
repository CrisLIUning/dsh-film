/** Camera clips sampled on the scene clock. Ported from Studio's apps/daemon/tests/director-temporal-query.test.ts (paths only; async diagnostics awaited). */
import { expect, it } from 'vitest';
import { directorSample } from '../../src/director/query.js';
import { character, lockedCamera, project, walk, type Vec3 } from './fixtures.js';

it('query applies the same causal tracking semantics to scene seconds, independent of query order and source cut', () => {
  const actor = character('actor', [0, 0, 0], {motionClips:[walk('walk',0,20,[0,0,0],[20,0,0])]});
  const cam = lockedCamera('cam',[0,2,8],[0,1,0],50,{motionPath:{duration:8,loop:false,interpolation:'linear',easing:'linear',keyframes:[0,1].map((time,i)=>({id:String(i),time,position:[0,2,8] as Vec3,target:[0,1,0] as Vec3,fov:50,targetMode:'object',targetObjectId:'actor',targetFollowMode:'smooth'}))}});
  const scene = project([actor],[cam],{pathCollisionEnabled:false}), clip = scene.cameras[0]!.motionClips[0]!;
  clip.start=5;clip.end=9;clip.source={duration:8,in:2,out:6,origin:0};
  const at=(time:number)=>directorSample(scene,{kind:'sample',at:[time]}).frames[0]!.cameras[0]!;
  expect(at(5).target[0]).toBe(5);
  expect(at(6).target[0]).toBeCloseTo(6-(1-Math.exp(-6))/6,6);
  const expected=at(6.137);
  for(const t of [20,5,8,7,0,6.137]) {at(t);expect(at(6.137)).toEqual(expected);}
  const stable=structuredClone(scene);stable.cameras[0]!.motionClips[0]!.path.keyframes.forEach(k=>{k.targetStabilizationEnabled=true;});
  expect(directorSample(stable,{kind:'sample',at:[6]}).frames[0]!.cameras[0]!.target[0]).toBeCloseTo(6-(1-Math.exp(-2.4))/2.4,6);
  expect(at(12).position).toEqual(at(9).position);
  expect(at(12).target[0]).toBeGreaterThan(11.8);
});
