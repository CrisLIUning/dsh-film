// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorObjectMotionClip, DirectorProject } from './directorProject.js';
import { getObjectMotionClips, MIN_OBJECT_MOTION_CLIP_SECONDS } from './objectMotion.js';
import { motionClipSource, motionClipSourceSeconds, validateMotionClipSource } from './motionClipTime.js';
import { ensureSceneTimeline } from './sceneTime.js';

export type MotionClipEdit = { type: 'edit_motion_clip'; objectId: string; clipId: string } & (
  | { action: 'move'; start: number }
  | { action: 'trim'; start?: number; end?: number }
  | { action: 'stretch'; start?: number; end?: number }
  | { action: 'duplicate'; start?: number; id?: string }
  | { action: 'split'; at: number; id?: string }
  | { action: 'remove' }
);
const text = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`);
  return value.trim();
};
export function parseMotionClipEdit(value: unknown): MotionClipEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('移动片段操作格式无效');
  const raw = value as Record<string, unknown>;
  const base = { type: 'edit_motion_clip' as const, objectId: text(raw.objectId, 'objectId'), clipId: text(raw.clipId, 'clipId') };
  const number = (key: string) => { if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw new Error(`${key} 必须是有限秒数`); return raw[key] as number; };
  switch (raw.action) {
    case 'move': return { ...base, action: 'move', start: number('start') };
    case 'trim': case 'stretch':
      if (raw.start === undefined && raw.end === undefined) throw new Error('请指定片段起点或终点');
      return { ...base, action: raw.action, ...(raw.start === undefined ? {} : { start: number('start') }), ...(raw.end === undefined ? {} : { end: number('end') }) };
    case 'duplicate': return { ...base, action: 'duplicate', ...(raw.start === undefined ? {} : { start: number('start') }), ...(raw.id === undefined ? {} : { id: text(raw.id, 'id') }) };
    case 'split': return { ...base, action: 'split', at: number('at'), ...(raw.id === undefined ? {} : { id: text(raw.id, 'id') }) };
    case 'remove': return { ...base, action: 'remove' };
    default: throw new Error(`未知移动片段操作：${raw.action}`);
  }
}
function validateSpan(start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < MIN_OBJECT_MOTION_CLIP_SECONDS - 1e-9) throw new Error('移动片段起点不能早于 0，两端至少相隔 0.01 秒');
}
/** Nondestructive edits retain original curve control points, pacing, holds and action phase. */
export function editMotionClip(project: DirectorProject, input: MotionClipEdit): { project: DirectorProject; clipId: string | null } {
  const edit = parseMotionClipEdit(input);
  const object = project.objects.find(item => item.id === edit.objectId);
  if (!object || object.kind === 'camera' || object.kind === 'panorama') throw new Error(`没有可编辑路线的对象：${edit.objectId}`);
  if (object.locked) throw new Error('对象已锁定，请先解锁');
  const clips = getObjectMotionClips(object);
  const clip = clips.find(item => item.id === edit.clipId);
  if (!clip) throw new Error(`移动片段不存在：${edit.clipId}`);
  let next: DirectorObjectMotionClip | null = clip, extra: DirectorObjectMotionClip | null = null;
  const source = motionClipSource(clip);
  if (edit.action === 'remove') next = null;
  else if (edit.action === 'move' || edit.action === 'stretch' || edit.action === 'trim') {
    const start = edit.start ?? clip.start;
    const end = edit.action === 'move' ? start + clip.end - clip.start : edit.end ?? clip.end;
    validateSpan(start, end);
    if (start === clip.start && end === clip.end) return { project, clipId: clip.id };
    const sourceWindow = edit.action === 'trim'
      ? { ...source, in: motionClipSourceSeconds(clip, start, false), out: motionClipSourceSeconds(clip, end, false) }
      : source;
    if (Math.abs(sourceWindow.in) < 1e-10) sourceWindow.in = 0;
    if (Math.abs(sourceWindow.out - sourceWindow.duration) < 1e-10) sourceWindow.out = sourceWindow.duration;
    // Clip-edge pointer movement is bounded by the UI; structured commands reject overshoot.
    validateMotionClipSource(sourceWindow);
    next = { ...clip, start, end, source: sourceWindow };
  } else {
    const requested = edit.id;
    let n = 1; while (clips.some(item => item.id === `${object.id}_clip_${n}`)) n++;
    const id = requested ?? `${object.id}_clip_${n}`;
    if (clips.some(item => item.id === id)) throw new Error(`移动片段 ID 已存在：${id}`);
    const keys = new Set(clips.flatMap(item => item.keyframes.map(key => key.id)));
    const keyframes = clip.keyframes.map((key, index) => {
      let keyId = `${id}_p${index + 1}`;
      while (keys.has(keyId)) keyId += '_copy'; keys.add(keyId);
      return { ...key, id: keyId, transform: { position: [...key.transform.position], rotation: [...key.transform.rotation], scale: [...key.transform.scale] } } as typeof key;
    });
    if (edit.action === 'duplicate') {
      const start = edit.start ?? Math.max(...clips.map(item => item.end));
      validateSpan(start, start + clip.end - clip.start);
      extra = { ...clip, id, name: `${clip.name ?? clip.id} 副本`, start, end: start + clip.end - clip.start, source: { ...source }, keyframes };
    } else {
      validateSpan(clip.start, edit.at); validateSpan(edit.at, clip.end);
      const at = motionClipSourceSeconds(clip, edit.at, false);
      next = { ...clip, end: edit.at, source: { ...source, out: at } };
      extra = { ...clip, id, name: `${clip.name ?? clip.id} 后段`, start: edit.at, source: { ...source, in: at }, keyframes };
    }
  }
  const motionClips = [...clips.flatMap(item => item.id === clip.id ? next ? [next] : [] : [item]), ...(extra ? [extra] : [])].sort((a, b) => a.start - b.start);
  return { project: ensureSceneTimeline({ ...project, objects: project.objects.map(item => item.id === object.id ? { ...item, motionClips } : item) }), clipId: extra?.id ?? next?.id ?? null };
}
