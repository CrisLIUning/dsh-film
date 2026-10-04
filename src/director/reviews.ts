/**
 * Versioned director reviews: a frozen scene with its per-shot frames,
 * contact sheet and optional video, comments, approval and handoff. Ported
 * from Studio's apps/daemon/src/director/reviews.ts; records live in
 * `film/canvas/director-reviews/<sha256([boardId,nodeId])>.json` (Studio's
 * project folder is the film folder here) and the media they seal are the
 * film's own files.
 * @module dsh-film/director/reviews
 */

import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DirectorReviewFile, DirectorReviewRequest, DirectorReviewResponse, DirectorReviewSource, DirectorReviewVersion, DirectorRenderRequest, DirectorRenderResponse, DirectorReviewHandoffRequest, DirectorReviewHandoffResult } from './contracts/index.js';
import type { DirectorProject } from './vendor/director-math/schema/directorProject.js';
import { getShotSequence, validateShot } from './vendor/director-math/schema/shotSequence.js';

export class DirectorReviewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string,unknown> = {}) {super(message);}
}
const fail = (message: string, status = 400, code = 'DIRECTOR_REVIEW_INVALID'): never => {throw new DirectorReviewError(status,code,message);};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown, label: string, max = 4000) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fail(`${label}不能为空，且最多 ${max} 字`);
const locks = new Map<string,Promise<void>>();
async function locked<T>(key: string, run: ()=>Promise<T>) {
  const prior=locks.get(key) ?? Promise.resolve();let release!:()=>void;
  const next=new Promise<void>(resolve=>{release=resolve;});const chain=prior.then(()=>next);locks.set(key,chain);
  await prior;try{return await run();}finally{release();if(locks.get(key)===chain)locks.delete(key);}
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function validStored(value: unknown): value is StoredVersion {
  if(!record(value)||!record(value.review)||!record(value.project))return false;
  const r=value.review;
  return typeof r.id==='string'&&typeof r.name==='string'&&typeof r.fingerprint==='string'&&r.projectSha256===hash(JSON.stringify(value.project))
    && Number.isSafeInteger(r.number)&&Number(r.number)>0&&Number.isSafeInteger(r.revision)&&Number(r.revision)>0
    && ['unreviewed','changes_requested','approved'].includes(String(r.decision))
    && Array.isArray(r.shots)&&r.shots.every(s=>record(s)&&typeof s.shotId==='string'&&typeof s.cameraId==='string'&&['start','end','sourceIn','sourceOut'].every(k=>typeof s[k]==='number'&&Number.isFinite(s[k])))
    && Array.isArray(r.files)&&r.files.every(f=>record(f)&&typeof f.path==='string'&&typeof f.sha256==='string'&&/^[a-f0-9]{64}$/.test(f.sha256))
    && Array.isArray(r.comments)&&r.comments.every(c=>record(c)&&typeof c.id==='string'&&typeof c.text==='string');
}
interface StoredVersion {review:DirectorReviewVersion; project:DirectorProject}
interface Library {schemaVersion:1; boardId:string; nodeId:string; versions:StoredVersion[]}
export interface ReviewScene {source:{boardId:string;nodeId:string;project:string};project:DirectorProject;fingerprint:string}
export interface DirectorReviewDeps {
  /** The film folder (`<workspace>/film`), Studio's project folder. */
  projectRoot:string;
  readScene:(source:DirectorReviewSource)=>Promise<ReviewScene>;
  render:(source:DirectorReviewSource,request:Omit<DirectorRenderRequest,'source'>)=>Promise<DirectorRenderResponse>;
  handoff?:(scene:ReviewScene,review:DirectorReviewVersion,request:DirectorReviewHandoffRequest)=>Promise<DirectorReviewHandoffResult>;
}

/** Review records are daemon-owned; a stale canvas autosave cannot overwrite
 * comments or approvals. Media bytes stay in the existing project library. */
export function createDirectorReviewService(deps:DirectorReviewDeps) {
  const location=(scene:ReviewScene)=>path.join(deps.projectRoot,'canvas','director-reviews',`${hash(JSON.stringify([scene.source.boardId,scene.source.nodeId]))}.json`);
  async function read(scene:ReviewScene):Promise<Library> {
    try {
      const value=JSON.parse(await readFile(location(scene),'utf8')) as Library;
      if(!record(value) || value.schemaVersion!==1 || value.boardId!==scene.source.boardId || value.nodeId!==scene.source.nodeId || !Array.isArray(value.versions) || !value.versions.every(validStored)) return fail('审阅存档损坏，已保留原文件',409,'DIRECTOR_REVIEW_DAMAGED');
      return value;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {schemaVersion:1,boardId:scene.source.boardId,nodeId:scene.source.nodeId,versions:[]};if(error instanceof SyntaxError)return fail('审阅存档损坏，已保留原文件',409,'DIRECTOR_REVIEW_DAMAGED');throw error;}
  }
  async function write(scene:ReviewScene,library:Library) {
    const file=location(scene),temporary=`${file}.${randomUUID()}.tmp`;await mkdir(path.dirname(file),{recursive:true});
    try{await writeFile(temporary,JSON.stringify(library));await rename(temporary,file);}finally{await rm(temporary,{force:true});}
  }
  async function mediaIdentity(_project:string,relative:string) {
    try {
      const root=await realpath(deps.projectRoot);
      if(!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part=>part==='..'||part===''))return fail('输出文件路径无效');
      const file=await realpath(path.join(root,relative));
      if(!file.startsWith(root+path.sep))return fail('输出文件不在当前项目');
      const digest=createHash('sha256');let bytes=0;
      for await (const chunk of createReadStream(file)){digest.update(chunk);bytes+=Buffer.byteLength(chunk);}
      return {sha256:digest.digest('hex'),bytes};
    } catch(error) {
      if(error instanceof DirectorReviewError)throw error;
      return fail('审阅文件缺失或无法读取，请重新生成',409,'DIRECTOR_REVIEW_MEDIA_MISSING');
    }
  }
  async function sealFiles(scene:ReviewScene,result:DirectorRenderResponse):Promise<DirectorReviewFile[]> {
    if(!result.files.length)return fail('没有已保存的审阅输出');
    return Promise.all(result.files.map(async file=>{
      if(file.directorFingerprint!==scene.fingerprint || !file.path || file.url!==`/api/projects/${encodeURIComponent(scene.source.project)}/raw/${file.path.split('/').map(encodeURIComponent).join('/')}`)return fail('输出与审阅工程版本或项目不一致',409,'DIRECTOR_REVIEW_SOURCE_CHANGED');
      return {...file,...await mediaIdentity(scene.source.project,file.path)};
    }));
  }
  const checkFingerprint=(scene:ReviewScene,expected:unknown)=>{
    if(expected!==scene.fingerprint)fail('工程已经修改，请刷新后重新生成或确认审阅版',409,'DIRECTOR_REVIEW_SOURCE_CHANGED');
  };
  return {
    async execute(input:DirectorReviewRequest):Promise<DirectorReviewResponse> {
      if(!input || !['list','get','create','comment','resolve','confirm','reopen','handoff'].includes(input.action))return fail('未知审阅操作');
      const scene=JSON.parse(JSON.stringify(await deps.readScene(input.source))) as ReviewScene;
      if(input.action!=="list"&&input.action!=="create")text(input.versionId,"版本编号",128);
      if(input.action==="get"&&input.includeProject!==undefined&&typeof input.includeProject!=="boolean")return fail("includeProject 必须是布尔值");
      const response=(versions:StoredVersion[],project?:DirectorProject):DirectorReviewResponse=>({source:scene.source,currentFingerprint:scene.fingerprint,versions:versions.map(item=>item.review),...(project?{project}:{})});
      if(input.action==='create') {
        checkFingerprint(scene,input.expectedFingerprint);
        if(input.video!==undefined&&typeof input.video!=='boolean')return fail('video 必须是布尔值');
        if(input.quality!==undefined&&!['720p','1080p'].includes(input.quality))return fail('画质必须为 720p 或 1080p');
        if(input.fps!==undefined&&![24,30,60].includes(input.fps))return fail('帧率必须为 24、30 或 60');
        const name=input.name===undefined?'预演审阅':text(input.name,'版本名称',120);
        if(!scene.project.shots?.length)return fail('先在镜头编排中添加镜头，再生成审阅版');
        scene.project.shots.forEach(shot=>validateShot(scene.project,shot));
        const shots=getShotSequence(scene.project).map(shot=>({shotId:shot.id,cameraId:shot.cameraId,name:shot.name,sourceIn:shot.sourceIn,sourceOut:shot.sourceOut,start:shot.start,end:shot.end}));
        const result=await deps.render(scene.source,{expectedFingerprint:scene.fingerprint,frames:shots.map(shot=>({shotId:shot.shotId,position:'first'})),sheet:{sequence:true},...(input.video?{video:{sequence:true,fps:input.fps??24}}:{}),quality:input.quality??'720p'});
        const files=await sealFiles(scene,result);
        if(!files.some(file=>file.kind==='sheet') || shots.some(shot=>!files.some(file=>file.kind==='frame'&&file.shotId===shot.shotId)) || (input.video&&!files.some(file=>file.kind==='video'&&file.sequence)))return fail('审阅输出不完整，已保存结果保留，请重新生成',409,'DIRECTOR_REVIEW_INCOMPLETE');
        checkFingerprint(await deps.readScene(scene.source),scene.fingerprint);
        return locked(location(scene),async()=>{
          const library=await read(scene);
          const review:DirectorReviewVersion={id:randomUUID(),number:library.versions.length+1,name,createdAt:new Date().toISOString(),fingerprint:scene.fingerprint,projectSha256:hash(JSON.stringify(scene.project)),shots,files,revision:1,comments:[],decision:'unreviewed'};
          const stored={review,project:scene.project};library.versions.push(stored);await write(scene,library);return response([stored]);
        });
      }
      return locked(location(scene),async()=>{
        const library=await read(scene);
        if(input.action==='list')return response([...library.versions].reverse());
        const stored=library.versions.find(item=>item.review.id===input.versionId);
        if(!stored)return fail('审阅版本不存在',404,'DIRECTOR_REVIEW_NOT_FOUND');
        if(input.action==='get')return response([stored],input.includeProject?stored.project:undefined);
        const review=stored.review;
        if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==review.revision)return fail('批注或确认已被其他操作更新，请刷新',409,'DIRECTOR_REVIEW_CONFLICT');
        if(input.action==='handoff') {
          checkFingerprint(scene,input.expectedFingerprint);checkFingerprint(scene,review.fingerprint);
          if(review.decision!=='approved'||review.comments.some(comment=>!comment.resolvedAt))return fail('先确认这一版预演，再交给画布生成',409,'DIRECTOR_REVIEW_NOT_APPROVED');
          if(typeof input.dryRun!=='boolean'||typeof input.operationId!=='string'||!input.operationId.trim()||input.operationId.length>200)return fail('交接需要 dryRun 和 operationId');
          for(const file of review.files){const identity=await mediaIdentity(scene.source.project,file.path);if(identity.sha256!==file.sha256||identity.bytes!==file.bytes)return fail('审阅文件已经改变，请重新生成这一版',409,'DIRECTOR_REVIEW_MEDIA_CHANGED');}
          checkFingerprint(await deps.readScene(scene.source),review.fingerprint);
          if(!deps.handoff)return fail('当前服务不支持审阅交接',503);
          return {...response([stored]),handoff:await deps.handoff(scene,review,input)};
        }
        if(input.action==='comment'){
          const body=text(input.text,'批注');
          const shot=input.shotId===undefined?undefined:review.shots.find(item=>item.shotId===input.shotId);
          if(input.shotId!==undefined&&!shot)return fail('批注镜头不属于这一版');
          if(input.at!==undefined&&(!shot||!Number.isFinite(input.at)||input.at<shot.sourceIn||input.at>shot.sourceOut))return fail('批注时间必须在所选镜头的源范围内');
          review.comments.push({id:randomUUID(),text:body,createdAt:new Date().toISOString(),...(shot?{shotId:shot.shotId}:{}),...(input.at!==undefined?{at:input.at}:{})});
          review.decision='changes_requested';delete review.approvedAt;
        }else if(input.action==='resolve'){
          const comment=review.comments.find(item=>item.id===input.commentId);
          if(!comment || typeof input.resolved!=='boolean')return fail('批注不存在或处理状态无效');
          if(input.resolved)comment.resolvedAt=new Date().toISOString();else {delete comment.resolvedAt;review.decision='changes_requested';delete review.approvedAt;}
        }else if(input.action==='confirm'){
          checkFingerprint(scene,input.expectedFingerprint);checkFingerprint(scene,review.fingerprint);
          if(review.comments.some(comment=>!comment.resolvedAt))return fail('仍有未处理的批注',409,'DIRECTOR_REVIEW_OPEN_COMMENTS');
          for(const file of review.files){const identity=await mediaIdentity(scene.source.project,file.path);if(identity.sha256!==file.sha256||identity.bytes!==file.bytes)return fail('审阅文件已经改变，请重新生成这一版',409,'DIRECTOR_REVIEW_MEDIA_CHANGED');}
          checkFingerprint(await deps.readScene(scene.source),review.fingerprint);
          review.decision='approved';review.approvedAt=new Date().toISOString();
        }else {review.decision='unreviewed';delete review.approvedAt;}
        review.revision++;await write(scene,library);return response([stored]);
      });
    },
  };
}
