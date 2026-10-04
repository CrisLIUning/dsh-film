/** Scene lighting ops. Ported from Studio's apps/daemon/tests/director-lighting.test.ts (paths only; async diagnostics awaited). */
import {expect,it} from 'vitest';
import {directorSample,directorStructure} from '../../src/director/query.js';
import {parseDirectorStagePlan,stageDirectorScene} from '../../src/director/staging.js';
import {defaultLight} from '../../src/director/vendor/director-math/schema/sceneLighting.js';
import {upgradeDirectorProject} from '../../src/director/vendor/director-math/schema/directorProjectMigration.js';
import {character,lockedCamera,project} from './fixtures.js';
it('stages a rig, exposes lamps and excludes them from framing and actor routes',()=>{
 const source=project([character('actor',[0,0,0])],[lockedCamera('cam',[0,2,8],[0,1,0],50)]);
 const staged=stageDirectorScene(source,parseDirectorStagePlan({ops:[{type:'lighting_preset',preset:'three-point',at:[0,0,0]}]}));
 const saved=upgradeDirectorProject(JSON.parse(JSON.stringify(staged.project)));
 expect(directorStructure(saved).scene.lighting).toEqual({ambient:.15,color:'#ffffff'});
 expect(directorStructure(saved).objects.filter(o=>o.light)).toHaveLength(3);
 const f=directorSample(saved,{kind:'sample',at:[2]}).frames[0]!;
 expect(f.objects.filter(o=>o.kind==='light')).toHaveLength(3);
 expect(f.cameras[0]!.framing.some(o=>o.objectId.startsWith('light'))).toBe(false);
 expect(saved.cameras).toEqual(source.cameras);expect(source.objects).toHaveLength(1);
 const lamp=saved.objects.find(o=>o.kind==='light')!;
 const off=stageDirectorScene(saved,parseDirectorStagePlan({ops:[{type:'light',id:lamp.id,visible:false,settings:{...defaultLight('spot'),enabled:false}}]})).project;
 expect(directorStructure(off).objects.find(o=>o.id===lamp.id)).toMatchObject({visible:false,light:{enabled:false}});
 expect(()=>parseDirectorStagePlan({ops:[{type:'light',id:'x',settings:{...defaultLight('spot'),intensity:-1}}]})).toThrow();
});
