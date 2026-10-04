// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorProject, DirectorShotClip } from './directorProject.js';
import { getSceneDuration } from './sceneTime.js';

export type ShotEdit =
  | { type: 'set_shot'; shotId?: string; name?: string; cameraId?: string; sourceIn?: number; sourceOut?: number; locked?: boolean }
  | { type: 'remove_shot'; shotId: string }
  | { type: 'move_shot'; shotId: string; beforeId?: string | null }
  | { type: 'duplicate_shot'; shotId: string; id?: string }
  | { type: 'split_shot'; shotId: string; at: number; id?: string };

export const MIN_SHOT_SECONDS = 0.01;
const seconds = (value: number) => Number(value.toFixed(6));
function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}

/** Shared command boundary for UI, HTTP, CLI and MCP. Reject malformed fields before editing. */
export function parseShotEdit(value: unknown): ShotEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('镜头操作格式无效');
  const raw = value as Record<string, unknown>;
  const text = (key: string) => raw[key] === undefined ? {} : { [key]: requiredId(raw[key], key) };
  const number = (key: string) => {
    if (raw[key] === undefined) return {};
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw new Error(`${key} 必须是有限秒数`);
    return { [key]: raw[key] };
  };
  const shotId = raw.type === 'set_shot' ? text('shotId') : { shotId: requiredId(raw.shotId, '镜头 ID') };
  switch (raw.type) {
    case 'set_shot':
      if (raw.locked !== undefined && typeof raw.locked !== 'boolean') throw new Error('locked 必须是布尔值');
      return { type: raw.type, ...shotId, ...text('name'), ...text('cameraId'), ...number('sourceIn'), ...number('sourceOut'), ...(raw.locked === undefined ? {} : { locked: raw.locked }) };
    case 'remove_shot': return { type: raw.type, shotId: requiredId(raw.shotId, '镜头 ID') };
    case 'move_shot': return { type: raw.type, shotId: requiredId(raw.shotId, '镜头 ID'), ...(raw.beforeId === null ? { beforeId: null } : text('beforeId')) };
    case 'duplicate_shot': return { type: raw.type, shotId: requiredId(raw.shotId, '镜头 ID'), ...text('id') };
    case 'split_shot':
      if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) throw new Error('分割点 at 必须是有限秒数');
      return { type: raw.type, shotId: requiredId(raw.shotId, '镜头 ID'), at: raw.at, ...text('id') };
    default: throw new Error(`未知镜头操作：${raw.type}`);
  }
}

export function validateShot(project: Pick<DirectorProject, 'cameras' | 'objects' | 'timeline'>, shot: DirectorShotClip) {
  if (!shot || typeof shot !== 'object') throw new Error('镜头格式无效');
  if (shot.locked !== undefined && typeof shot.locked !== 'boolean') throw new Error('镜头 locked 必须是布尔值');
  requiredId(shot.id, '镜头 ID'); requiredId(shot.name, '镜头名称');
  if (!project.cameras.some(camera => camera.id === shot.cameraId)) throw new Error(`镜头引用的机位不存在：${shot.cameraId}`);
  if (!Number.isFinite(shot.sourceIn) || !Number.isFinite(shot.sourceOut) || shot.sourceIn < 0 || shot.sourceOut - shot.sourceIn < MIN_SHOT_SECONDS - 1e-9) throw new Error('镜头源范围至少需要 0.01 秒，入点不能早于场景开头');
  if (shot.sourceOut > getSceneDuration(project) + 1e-9) throw new Error('镜头出点不能超出场景时长');
}

/** Ordered edits reference the original scene. Destination time is derived, never another source clock. */
export function getShotSequence(project: Pick<DirectorProject, 'shots'>) {
  let cursor = 0;
  return project.shots.map(shot => {
    const duration = seconds(shot.sourceOut - shot.sourceIn);
    const start = cursor; cursor = seconds(cursor + duration);
    return { ...shot, start, end: cursor, duration };
  });
}

export function resolveShot(project: DirectorProject, shotId: string) {
  const shot = project.shots.find(item => item.id === shotId);
  if (!shot) throw new Error(`镜头不存在：${shotId}`);
  validateShot(project, shot);
  return shot;
}

export function editShotSequence(project: DirectorProject, edit: ShotEdit): { project: DirectorProject; shotId: string | null } {
  const shots = project.shots;
  const nextId = (requested?: string) => {
    if (requested !== undefined) {
      const id = requiredId(requested, '镜头 ID');
      if (shots.some(shot => shot.id === id)) throw new Error(`镜头 ID 已存在：${id}`);
      return id;
    }
    let n=1; while(shots.some(shot => shot.id === `shot_${n}`)) n++;
    return `shot_${n}`;
  };
  const current = edit.shotId ? shots.find(shot => shot.id === edit.shotId) : undefined;
  if (edit.type !== 'set_shot' && !current) throw new Error(`镜头不存在：${edit.shotId}`);
  if (current?.locked && edit.type !== 'duplicate_shot') {
    const unlocking = edit.type === 'set_shot' && edit.locked === false && edit.name === undefined && edit.cameraId === undefined && edit.sourceIn === undefined && edit.sourceOut === undefined;
    if (!unlocking) throw new Error('镜头已锁定，请先解锁再编辑');
  }
  if (edit.type === 'set_shot') {
    const id = current?.id ?? nextId(edit.shotId);
    const shot: DirectorShotClip = {
      id, name: edit.name === undefined ? current?.name ?? `镜头 ${shots.length + 1}` : requiredId(edit.name,'镜头名称'),
      cameraId: edit.cameraId ?? current?.cameraId ?? project.activeCameraId ?? '',
      sourceIn: edit.sourceIn ?? current?.sourceIn ?? 0,
      sourceOut: edit.sourceOut ?? current?.sourceOut ?? getSceneDuration(project),
      locked: edit.locked ?? current?.locked ?? false,
    };
    validateShot(project, shot);
    return { project: { ...project, shots: current ? shots.map(item => item.id === id ? shot : item) : [...shots,shot] }, shotId:id };
  }
  const source = current!;
  const index = shots.indexOf(source);
  if (edit.type === 'remove_shot') return {project:{...project,shots:shots.filter(shot=>shot.id!==source.id)},shotId:null};
  if (edit.type === 'move_shot') {
    if (edit.beforeId === source.id) return {project,shotId:source.id};
    if (edit.beforeId && !shots.some(shot=>shot.id===edit.beforeId)) throw new Error(`目标镜头不存在：${edit.beforeId}`);
    const reordered=shots.filter(shot=>shot.id!==source.id);
    reordered.splice(edit.beforeId ? reordered.findIndex(shot=>shot.id===edit.beforeId) : reordered.length,0,source);
    return {project:{...project,shots:reordered},shotId:source.id};
  }
  const id=nextId(edit.id);
  if (edit.type === 'duplicate_shot') {
    const copy={...source,id,name:`${source.name} 副本`,locked:false};
    return {project:{...project,shots:[...shots.slice(0,index+1),copy,...shots.slice(index+1)]},shotId:id};
  }
  if (!Number.isFinite(edit.at) || edit.at-source.sourceIn < MIN_SHOT_SECONDS - 1e-9 || source.sourceOut-edit.at < MIN_SHOT_SECONDS - 1e-9) throw new Error('分割点必须在镜头内部，两段均至少 0.01 秒');
  const left={...source,sourceOut:edit.at};const right={...source,id,name:`${source.name} 后段`,sourceIn:edit.at};
  return {project:{...project,shots:[...shots.slice(0,index),left,right,...shots.slice(index+1)]},shotId:id};
}


/** Destination seconds resolve to one camera and one source moment. Cuts are right-continuous. */
export function sampleShotSequence(project: Pick<DirectorProject, 'shots'>, at: number) {
  if (!Number.isFinite(at)) throw new Error('编排时间必须是有限秒数');
  const entries = getShotSequence(project);
  const total = entries[entries.length - 1]?.end ?? 0;
  if (!entries.length || total <= 0) return null;
  const time = Math.max(0, Math.min(total, at));
  const index = time >= total ? entries.length - 1 : entries.findIndex(shot => time < shot.end);
  const shot = entries[index];
  return { shot, index, seconds: time, duration: total, sourceSeconds: Math.min(shot.sourceOut, shot.sourceIn + time - shot.start), ended: time >= total };
}
