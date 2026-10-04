/** The independent scene clock. Ported from Studio's apps/daemon/tests/director-scene-time.test.ts (paths only; async diagnostics awaited). */
import { expect, it } from 'vitest';
import { parseDirectorStagePlan, stageDirectorScene } from '../../src/director/staging.js';
import { directorStructure } from '../../src/director/query.js';
import { cameraMomentAt, openQueryScene } from '../../src/director/scene.js';
import { character, lockedCamera, project, walk } from './fixtures.js';

it('shares an independent scene clock with the UI, without changing any route', () => {
  const actor=character('actor',[0,0,0],{motionClips:[walk('walk',0,12,[0,0,0],[12,0,0])]});
  const source=project([actor],[lockedCamera('cam',[0,2,10],[0,1,0])]);
  const result=stageDirectorScene(source,parseDirectorStagePlan({ops:[{type:'set_scene_time',duration:60,loop:true}]}));
  expect(result.project.timeline).toEqual({duration:60,loop:true});
  expect(result.project.objects).toEqual(source.objects);expect(result.project.cameras).toEqual(source.cameras);
  expect(source.timeline.duration).toBe(12);
  expect(directorStructure(result.project).timeline).toEqual({seconds:60,loop:true,activeCameraId:'cam'});
  expect(()=>stageDirectorScene(result.project,parseDirectorStagePlan({ops:[{type:'set_scene_time',duration:5}]}))).toThrow('先裁剪');
});

it('new content grows the scene even with no open browser or active camera', () => {
  const source=project([character('actor',[0,0,0])],[]);
  const result=stageDirectorScene(source,parseDirectorStagePlan({ops:[{type:'move',objectId:'actor',start:20,end:45,path:[[0,0],[4,0]]}]}));
  expect(result.project.timeline.duration).toBe(45);
  expect(directorStructure(result.project).timeline.seconds).toBe(45);
});

it('query tracks actual scene seconds after the camera motion has ended', () => {
  const actor=character('actor',[0,0,0],{motionClips:[walk('walk',0,12,[0,0,0],[12,0,0])]});
  const camera=lockedCamera('cam',[0,2,10],[0,1,0],50,{targetMode:'object',targetObjectId:'actor'});
  const source=project([actor],[camera]);
  const moment=cameraMomentAt(openQueryScene(source),source.cameras[0]!,8);
  expect(moment.progress).toBe(1);expect(moment.ended).toBe(true);
  expect(moment.view.target[0]).toBeCloseTo(8,4);
  expect(moment.view.position[0]).toBe(0);
});

it.each([{}, {duration:0}, {duration:Infinity}, {loop:'yes'}])('validates clock edits before any write: %j', fields => {
  expect(()=>parseDirectorStagePlan({ops:[{type:'set_scene_time',...fields}]})).toThrow();
});
