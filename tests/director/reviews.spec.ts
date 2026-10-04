/** Versioned director reviews (the service, with a scripted renderer). Ported from Studio's apps/daemon/tests/director-review.test.ts (paths only; async diagnostics awaited). */
import {beforeEach,afterEach,it,expect,vi,type Mock} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createDirectorReviewService,type ReviewScene,type DirectorReviewDeps} from '../../src/director/reviews.js';
import {getDirectorProjectFingerprint} from '../../src/director/vendor/director-math/schema/projectFingerprint.js';
import {character,lockedCamera,project} from './fixtures.js';
import type {DirectorReviewRequest,DirectorRenderResponse} from '../../src/director/contracts/index.js';
let root:string,scene:ReviewScene,render:Mock<DirectorReviewDeps['render']>,service:ReturnType<typeof createDirectorReviewService>;
const source={boardId:'board',nodeId:'director',project:'film'};
const call=(command:Omit<DirectorReviewRequest,'source'>|Record<string,unknown>)=>service.execute({...command,source} as DirectorReviewRequest);
function setup(){return createDirectorReviewService({projectRoot:path.join(root,'external-media'),readScene:async requested=>({...scene,source:{...source,...requested}}),render});}
beforeEach(async()=>{
  root=await mkdtemp(path.join(tmpdir(),'director-review-'));await mkdir(path.join(root,'external-media'));
  const p=project([character('actor',[0,0,0])],[lockedCamera('cam',[0,2,6],[0,1,0])]);
  p.timeline.duration=8;p.shots=[{id:'a',name:'近景',cameraId:'cam',sourceIn:3,sourceOut:5},{id:'b',name:'同机位再取',cameraId:'cam',sourceIn:0,sourceOut:2}];
  scene={source,project:p,fingerprint:getDirectorProjectFingerprint(p)};
  render=vi.fn<DirectorReviewDeps['render']>(async(_source,request)=>{
    const fingerprint=request.expectedFingerprint;
    if(!fingerprint)throw new Error('Review output must pin its source fingerprint');
    const files:DirectorRenderResponse['files']=[];
    for(const [i,shot] of p.shots.entries())files.push({kind:'frame',path:`frame-${i}.png`,url:`/api/projects/film/raw/frame-${i}.png`,fileName:`frame-${i}.png`,shotId:shot.id,width:1280,height:720,directorFingerprint:fingerprint});
    files.push({kind:'sheet',path:'sheet.png',url:'/api/projects/film/raw/sheet.png',fileName:'sheet.png',width:1280,height:720,directorFingerprint:fingerprint});
    for(const file of files)await writeFile(path.join(root,'external-media',file.path),file.path+'-'+request.expectedFingerprint);
    return {source,project:'film',desk:'open' as const,files};
  });service=setup();
});
afterEach(async()=>rm(root,{recursive:true,force:true}));
const create=async()=> (await call({action:'create',name:'走位审核',expectedFingerprint:scene.fingerprint})).versions[0]!;
it('freezes the scene and ordered takes, persists outside browser autosave, and survives a new service',async()=>{
  const v=await create();expect(v).toMatchObject({number:1,revision:1,decision:'unreviewed',name:'走位审核',fingerprint:scene.fingerprint});
  expect(v.shots.map(s=>[s.shotId,s.cameraId,s.sourceIn,s.start])).toEqual([['a','cam',3,0],['b','cam',0,2]]);
  expect(render.mock.calls[0]![1]).toMatchObject({expectedFingerprint:scene.fingerprint,frames:[{shotId:'a',position:'first'},{shotId:'b',position:'first'}],sheet:{sequence:true}});
  expect(v.files.every(f=>f.sha256.length===64&&f.bytes>0)).toBe(true);
  scene.project.objects[0]!.name='后来改名';scene.fingerprint=getDirectorProjectFingerprint(scene.project);
  service=setup();const saved=await call({action:'get',versionId:v.id,includeProject:true});
  expect((saved.project as typeof scene.project).objects[0]!.name).not.toBe('后来改名');
  expect(saved.currentFingerprint).not.toBe(v.fingerprint);
  expect((await call({action:'list'})).versions).toHaveLength(1);
});
it('uses revision compare-and-swap for concurrent comments',async()=>{
  const v=await create();const attempts=await Promise.allSettled(['A','B'].map(text=>call({action:'comment',versionId:v.id,expectedRevision:1,text,shotId:'a',at:4})));
  expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((attempts.find(r=>r.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({status:409,code:'DIRECTOR_REVIEW_CONFLICT'});
  const saved=(await call({action:'get',versionId:v.id})).versions[0]!;
  expect(saved.comments).toHaveLength(1);expect(saved.revision).toBe(2);
});
it('requires resolved comments and unchanged scene before confirming; a new comment clears approval',async()=>{
  let v=await create();v=(await call({action:'comment',versionId:v.id,expectedRevision:v.revision,text:'机位再往左',shotId:'a',at:4})).versions[0]!;
  await expect(call({action:'confirm',versionId:v.id,expectedRevision:v.revision,expectedFingerprint:scene.fingerprint})).rejects.toMatchObject({code:'DIRECTOR_REVIEW_OPEN_COMMENTS'});
  v=(await call({action:'resolve',versionId:v.id,expectedRevision:v.revision,commentId:v.comments[0]!.id,resolved:true})).versions[0]!;
  v=(await call({action:'confirm',versionId:v.id,expectedRevision:v.revision,expectedFingerprint:scene.fingerprint})).versions[0]!;
  expect(v.decision).toBe('approved');expect(v.approvedAt).toBeTruthy();
  v=(await call({action:'comment',versionId:v.id,expectedRevision:v.revision,text:'还有一个问题'})).versions[0]!;
  expect(v.decision).toBe('changes_requested');expect(v.approvedAt).toBeUndefined();
});
it.each([{shotId:'missing'},{shotId:'a',at:0},{at:4},{shotId:'a',at:Infinity}])('refuses a comment outside its frozen take %j',async patch=>{
  const v=await create();await expect(call({action:'comment',versionId:v.id,expectedRevision:1,text:'note',...patch})).rejects.toMatchObject({status:400});
  expect((await call({action:'get',versionId:v.id})).versions[0]!.revision).toBe(1);
});
it('refuses stale create before output, and retains output files if the scene changes during generation',async()=>{
  await expect(call({action:'create',expectedFingerprint:'stale'})).rejects.toMatchObject({code:'DIRECTOR_REVIEW_SOURCE_CHANGED'});expect(render).not.toHaveBeenCalled();
  const old=render.getMockImplementation()!;render.mockImplementationOnce(async(...args)=>{const files=await old(...args);scene.fingerprint='changed';return files;});
  const expected=scene.fingerprint;await expect(call({action:'create',expectedFingerprint:expected})).rejects.toMatchObject({code:'DIRECTOR_REVIEW_SOURCE_CHANGED'});
  expect((await readdir(path.join(root,'external-media'))).length).toBe(3);expect((await call({action:'list'})).versions).toHaveLength(0);
});
it.each(['fingerprint','project','incomplete'])('refuses mismatched or incomplete output receipts: %s',async kind=>{
  const old=render.getMockImplementation()!;render.mockImplementationOnce(async(...args)=>{const result=await old(...args);if(kind==='fingerprint')result.files[0]!.directorFingerprint='other';if(kind==='project')result.files[0]!.url='/api/projects/other/raw/frame-0.png';if(kind==='incomplete')result.files=result.files.filter(f=>f.kind!=='sheet');return result;});
  await expect(create()).rejects.toMatchObject({status:409});expect((await call({action:'list'})).versions).toHaveLength(0);
});
it.each(['changed','missing','escaped'])('rechecks real file bytes and project containment before approval: %s',async kind=>{
  const v=await create(),file=path.join(root,'external-media',v.files[0]!.path);
  if(kind==='changed')await writeFile(file,'different bytes');else await rm(file);
  if(kind==='escaped'){const external=path.join(root,'not-media');await writeFile(external,'outside');await symlink(external,file);}
  await expect(call({action:'confirm',versionId:v.id,expectedRevision:1,expectedFingerprint:scene.fingerprint})).rejects.toBeTruthy();
  expect((await call({action:'get',versionId:v.id})).versions[0]!.decision).toBe('unreviewed');
});
it('keeps node-specific libraries and refuses malformed archive data without overwriting it',async()=>{
  await create();expect((await service.execute({action:'list',source:{...source,nodeId:'another'}})).versions).toHaveLength(0);
  const dir=path.join(root,'external-media','canvas','director-reviews'),file=path.join(dir,(await readdir(dir))[0]!);await writeFile(file,'{"schemaVersion":1,"boardId":"board","nodeId":"director","versions":[null]}');
  await expect(call({action:'list'})).rejects.toMatchObject({code:'DIRECTOR_REVIEW_DAMAGED'});expect(await readFile(file,'utf8')).toContain('[null]');
});
