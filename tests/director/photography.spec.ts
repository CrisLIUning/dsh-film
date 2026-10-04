/** Camera photography: gates, focal length, roll. Ported from Studio's apps/daemon/tests/director-photography.test.ts (paths only; async diagnostics awaited). */
import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {directorSample,directorDiagnostics} from '../../src/director/query.js';
import {parseDirectorStagePlan,stageDirectorScene} from '../../src/director/staging.js';
import {projectToScreen} from '../../src/director/framing.js';
import {character,lockedCamera,project,prop,type Vec3} from './fixtures.js';
import {upgradeDirectorProject} from '../../src/director/vendor/director-math/schema/directorProjectMigration.js';

it('matches actual Three projection for rolled landscape, portrait and vertical cameras',()=>{
  const golden=JSON.parse(readFileSync(new URL('./fixtures/photography/projection.json',import.meta.url),'utf8')) as {
    cases:Array<{view:{position:Vec3;target:Vec3;fov:number;roll:number};aspect:number;point:Vec3;screen:{x:number;y:number}}>};
  for(const item of golden.cases){const sample=projectToScreen(item.view,item.aspect,item.point)!;
    expect(sample.x).toBeCloseTo(item.screen.x,8);expect(sample.y).toBeCloseTo(item.screen.y,8);}
});
it('stages linked optics, samples saved gates by default and honours an explicit query override',async()=>{
  const source=project([prop('subject',[0,1,0],[1,1,1])],[lockedCamera('cam',[0,2,9],[0,1,0],50)],{pathCollisionEnabled:false});
  const staged=stageDirectorScene(source,parseDirectorStagePlan({ops:[{type:'camera_photography',cameraId:'cam',filmGate:{widthMm:20.25,heightMm:36},focalLengthMm:35,roll:30}]}));
  expect(source.cameras[0]!.filmGate).toBeUndefined();
  expect(staged.applied).toMatchObject([{type:'camera_photography',cameraId:'cam'}]);
  const saved=upgradeDirectorProject(JSON.parse(JSON.stringify(staged.project)));
  const sample=directorSample(saved,{kind:'sample',at:[0,4]});
  for(const frame of sample.frames)expect(frame.cameras[0]).toMatchObject({aspect:9/16,roll:30,focalLengthMm:35});
  expect(directorSample(saved,{kind:'sample',at:[0],aspect:2.39}).frames[0]!.cameras[0]!.aspect).toBe(2.39);
  expect((await directorDiagnostics(saved,{kind:'diagnostics'})).findings).toEqual((await directorDiagnostics(saved,{kind:'diagnostics',aspect:9/16})).findings);
  expect(()=>stageDirectorScene(saved,parseDirectorStagePlan({ops:[{type:'camera_photography',cameraId:'cam',filmGate:{widthMm:36,heightMm:24}}]}))).toThrow('保持');
});

it('preserves camera-wide photography when the Agent restages a shot or route',()=>{
  const scene=project([character('actor',[0,0,0])],[lockedCamera('cam',[0,2,9],[0,1,0],50)],{pathCollisionEnabled:false});
  scene.cameras[0]!.filmGate={widthMm:20.25,heightMm:36};scene.cameras[0]!.roll=15;
  for(const op of [
    {type:'shot',cameraId:'cam',shot:{subject:'actor',size:'full'},seconds:4},
    {type:'follow',cameraId:'cam',shot:{subject:'actor',size:'full'},seconds:4},
    {type:'camera_move',cameraId:'cam',keyframes:[{at:0,shot:{subject:'actor',size:'full'}},{at:4,shot:{subject:'actor',size:'medium'}}]},
  ]) {
    const updated=stageDirectorScene(scene,parseDirectorStagePlan({ops:[op]}));
    expect(updated.project.cameras[0]).toMatchObject({filmGate:{widthMm:20.25,heightMm:36},roll:15});
    expect(directorSample(updated.project,{kind:'sample',at:[0,2,4]}).frames.every(f=>f.cameras[0]!.aspect===9/16)).toBe(true);
  }
});
