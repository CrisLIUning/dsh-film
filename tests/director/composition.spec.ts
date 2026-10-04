/** Subject composition across output ratios. Ported from Studio's apps/daemon/tests/director-composition.test.ts (paths only; async diagnostics awaited). */
import { expect, it } from 'vitest';
import { directorSample, directorDiagnostics } from '../../src/director/query.js';
import { parseDirectorStagePlan, stageDirectorScene } from '../../src/director/staging.js';
import { getDirectorObjectFocusTarget } from '../../src/director/vendor/director-math/schema/cameraTarget.js';
import { projectToScreen } from '../../src/director/framing.js';
import { lockedCamera, project, prop } from './fixtures.js';

it('stages and samples one subject anchor consistently across output ratios',()=>{
  const subject=prop('subject',[0,1,0],[1,1,1]);
  const focus=getDirectorObjectFocusTarget(subject);
  const scene=project([subject],[lockedCamera('cam',[0,2,9],focus,50,{targetMode:'object',targetObjectId:'subject'})],{pathCollisionEnabled:false});
  const result=stageDirectorScene(scene,parseDirectorStagePlan({ops:[{type:'camera_composition',cameraId:'cam',composition:{x:1/3,y:.4}}]}));
  expect(scene.cameras[0]!.composition).toBeUndefined();
  expect(result.applied).toMatchObject([{cameraId:'cam',type:'camera_composition'}]);
  for(const aspect of [16/9,9/16]){
    const sample=directorSample(result.project,{kind:'sample',at:[0,4],aspect});
    for(const frame of sample.frames){
      const cam=frame.cameras[0]!;
      const projected=projectToScreen(cam,aspect,focus)!;
      expect((projected.x+1)/2).toBeCloseTo(1/3,8);expect((1-projected.y)/2).toBeCloseTo(.4,8);
      expect(cam.compositionClamped).toBeUndefined();
    }
  }
});
it('reports impossible polar anchors and rejects invalid plans without mutation',async()=>{
  const scene=project([],[lockedCamera('cam',[0,5,0],[0,0,0],50)],{pathCollisionEnabled:false});
  const original=structuredClone(scene);
  expect(()=>stageDirectorScene(scene,parseDirectorStagePlan({ops:[{type:'camera_composition',cameraId:'cam',composition:{x:2,y:0}}]}))).toThrow('0–1');
  expect(scene).toEqual(original);
  const staged=stageDirectorScene(scene,parseDirectorStagePlan({ops:[{type:'camera_composition',cameraId:'cam',composition:{x:.1,y:.5}}]}));
  const diagnostic=(await directorDiagnostics(staged.project,{kind:'diagnostics',aspect:16/9,step:1}));
  expect(diagnostic.findings).toContainEqual(expect.objectContaining({code:'composition-unreachable',cameraId:'cam'}));
  expect(directorSample(staged.project,{kind:'sample',at:[0]}).frames[0]!.cameras[0]!.compositionClamped).toBe(true);
});
