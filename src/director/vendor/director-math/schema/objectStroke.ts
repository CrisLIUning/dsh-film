// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorProject } from './directorProject.js';
import { createClipFromRouteStroke, type RouteStrokeSample } from './routeStroke.js';
import { ensureSceneTimeline } from './sceneTime.js';

export interface ObjectStrokeCommand {
  type: 'object_stroke'; objectId: string; clipId?: string; start: number; end: number;
  pace?: 'uniform' | 'drawn'; samples: RouteStrokeSample[];
}
export function parseObjectStrokeCommand(raw: unknown): ObjectStrokeCommand {
  const v = raw as ObjectStrokeCommand;
  if (!v || typeof v !== 'object' || typeof v.objectId !== 'string' || !v.objectId.trim()) throw new Error('人物绘线需要 objectId');
  if (![v.start, v.end].every(Number.isFinite) || v.start < 0 || v.end - v.start < .1 || v.end - v.start > 3600) throw new Error('绘线时段须为 0.1–3600 秒');
  if (v.clipId !== undefined && (typeof v.clipId !== 'string' || !v.clipId.trim())) throw new Error('clipId 必须为非空字符串');
  if (v.pace !== undefined && v.pace !== 'uniform' && v.pace !== 'drawn') throw new Error('pace 须为 uniform 或 drawn');
  if (!Array.isArray(v.samples) || v.samples.length < 2 || v.samples.length > 2048) throw new Error('绘线需要 2–2048 个采样点');
  let last = -1;
  for (const sample of v.samples) {
    if (!sample || !Array.isArray(sample.position) || sample.position.length !== 3 || !sample.position.every(Number.isFinite) || !Number.isFinite(sample.time) || sample.time < 0 || sample.time <= last) throw new Error('绘线需要有限坐标和递增的非负时间');
    last = sample.time;
  }
  return {type:'object_stroke',objectId:v.objectId,start:v.start,end:v.end,...(v.clipId ? {clipId:v.clipId} : {}),...(v.pace ? {pace:v.pace}:{}),samples:v.samples.map(sample=>({position:[...sample.position],time:sample.time}))};
}
export function stageObjectStroke(project: DirectorProject, raw: ObjectStrokeCommand) {
  const input = parseObjectStrokeCommand(raw);
  const object = project.objects.find(o => o.id === input.objectId);
  if (!object || object.kind === 'camera' || object.kind === 'panorama' || object.kind === 'light') throw new Error('请选择可移动的人物或物体');
  if (object.locked) throw new Error('物体已锁定');
  const clips = object.motionClips ?? [];
  if (input.clipId && !clips.some(c => c.id === input.clipId)) throw new Error('要替换的片段不存在');
  let n = clips.length + 1;
  while (clips.some(c => c.id === `${object.id}_clip_${n}`)) n++;
  const id = input.clipId ?? `${object.id}_clip_${n}`;
  const clip = createClipFromRouteStroke({id,object,samples:input.samples,start:input.start,duration:input.end-input.start,pace:input.pace});
  if (!clip) throw new Error('请画一条至少 0.3 米的路线');
  // Existing overlap semantics remain: later-starting clips take precedence.
  const motionClips = [...clips.filter(c=>c.id!==id),clip].sort((a,b)=>a.start-b.start);
  return {clip,objectId:object.id,project:ensureSceneTimeline({...project,objects:project.objects.map(o=>o.id===object.id?{...o,motionClips}:o)})};
}
