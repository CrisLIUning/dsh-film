/** Takes (shot sequence) staging. Ported from Studio's apps/daemon/tests/director-shots.test.ts (paths only; async diagnostics awaited). */
import { expect, it } from 'vitest';
import { parseDirectorStagePlan, stageDirectorScene } from '../../src/director/staging.js';
import { directorStructure } from '../../src/director/query.js';
import { character, lockedCamera, project, walk } from './fixtures.js';
const source=()=>project([character('actor',[0,0,0],{motionClips:[walk('walk',0,12,[0,0,0],[12,0,0])]})],[lockedCamera('cam',[0,2,10],[0,1,0])]);
it('stages an ordered cut with source ranges using shared take operations',()=>{
  const initial=source(); const result=stageDirectorScene(initial,parseDirectorStagePlan({ops:[
    {type:'set_shot',shotId:'first',cameraId:'cam',sourceIn:8,sourceOut:10},
    {type:'duplicate_shot',shotId:'first',id:'copy'},
    {type:'split_shot',shotId:'copy',at:9,id:'tail'},
    {type:'move_shot',shotId:'tail',beforeId:'first'},
    {type:'remove_shot',shotId:'copy'},
  ]}));
  expect(directorStructure(result.project).shots.map(s=>[s.id,s.sourceIn,s.sourceOut,s.start,s.end])).toEqual([['tail',9,10,0,1],['first',8,10,1,3]]);
  expect(result.project.objects).toEqual(initial.objects);expect(result.project.cameras).toEqual(initial.cameras);
  expect(initial.shots).toEqual([]);expect(result.applied).toHaveLength(5);
});
it('protects take locks through camera removal and clears unlocked references atomically',()=>{
  const locked=stageDirectorScene(source(),parseDirectorStagePlan({ops:[{type:'set_shot',shotId:'s',cameraId:'cam',locked:true}]})).project;
  expect(()=>stageDirectorScene(locked,parseDirectorStagePlan({ops:[{type:'remove',cameraId:'cam'}]}))).toThrow('已锁定');
  const unlocked=stageDirectorScene(locked,parseDirectorStagePlan({ops:[{type:'set_shot',shotId:'s',locked:false},{type:'remove',cameraId:'cam'}]})).project;
  expect(unlocked.shots).toEqual([]);expect(unlocked.cameras).toEqual([]);
});
it.each([{type:'set_shot',sourceOut:'8'}, {type:'move_shot',shotId:12}, {type:'split_shot',shotId:'s',at:null}, {type:'set_shot',locked:'false'}])('refuses malformed take edits before compiling %j',op=>expect(()=>parseDirectorStagePlan({ops:[op]})).toThrow());
