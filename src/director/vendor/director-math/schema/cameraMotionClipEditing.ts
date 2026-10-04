// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorProject } from './directorProject.js';
import { ensureSceneTimeline } from './sceneTime.js';
import type { DirectorCameraMotionClip, DirectorCameraWithMotionClips } from './cameraMotionClips.js';
import { validateCameraMotionClips, validateCameraMotionClip } from './cameraMotionClips.js';
import { clampTimelineClipBounds, motionClipSourceSeconds, validateMotionClipSource } from './motionClipTime.js';

export type CameraMotionClipEdit = { clipId: string } & (
  | { action: 'move'; start: number }
  | { action: 'trim' | 'stretch'; start?: number; end?: number }
  | { action: 'duplicate'; id?: string; start?: number }
  | { action: 'split'; at: number; id?: string }
  | { action: 'remove' }
);

/** No implicit ripple: edits that collide with another clip are rejected. */
export function editCameraMotionClip(camera: DirectorCameraWithMotionClips, edit: CameraMotionClipEdit): { camera: DirectorCameraWithMotionClips; clipId: string | null } {
  const clips = validateCameraMotionClips(camera.motionClips);
  const clip = clips.find(item => item.id === edit.clipId);
  if (!clip) throw new Error(`相机运动片段不存在：${edit.clipId}`);
  let next: DirectorCameraMotionClip | null = clip, extra: DirectorCameraMotionClip | null = null;
  if (edit.action === 'remove') next = null;
  else if (edit.action === 'move' || edit.action === 'trim' || edit.action === 'stretch') {
    if (edit.start === undefined && (edit.action === 'move' || edit.end === undefined)) throw new Error('请指定相机片段起点或终点');
    const start = edit.start ?? clip.start;
    const end = edit.action === 'move' ? start + clip.end - clip.start : edit.end ?? clip.end;
    if (start === clip.start && end === clip.end) return { camera, clipId: clip.id };
    const source = edit.action === 'trim' ? { ...clip.source, in: motionClipSourceSeconds(clip, start, false), out: motionClipSourceSeconds(clip, end, false) } : { ...clip.source };
    if (Math.abs(source.in) < 1e-10) source.in = 0;
    if (Math.abs(source.out - source.duration) < 1e-10) source.out = source.duration;
    validateMotionClipSource(source);
    next = { ...clip, start, end, source };
  } else if (edit.action === 'duplicate' || edit.action === 'split') {
    let n = 1; while (clips.some(item => item.id === `${camera.id}_motion_${n}`)) n++;
    const id = edit.id ?? `${camera.id}_motion_${n}`;
    if (typeof id !== 'string' || !id.trim() || clips.some(item => item.id === id)) throw new Error('相机运动片段 ID 无效或已存在');
    const copy = { ...clip, id, source: { ...clip.source }, path: structuredClone(clip.path) };
    const keys = new Set(clips.flatMap(item => item.path.keyframes.map(key => key.id)));
    copy.path.keyframes = copy.path.keyframes.map((key, index) => {
      let keyId = `${id}_k${index + 1}`;
      while (keys.has(keyId)) keyId += '_copy'; keys.add(keyId);
      return { ...key, id: keyId };
    });
    if (edit.action === 'duplicate') {
      const start = edit.start ?? Math.max(...clips.map(item => item.end));
      extra = { ...copy, name: `${clip.name ?? clip.id} 副本`, start, end: start + clip.end - clip.start };
    } else if (edit.action === 'split') {
      const sourceAt = motionClipSourceSeconds(clip, edit.at, false);
      next = { ...clip, end: edit.at, source: { ...clip.source, out: sourceAt } };
      extra = { ...copy, name: `${clip.name ?? clip.id} 后段`, start: edit.at, source: { ...clip.source, in: sourceAt } };
    }
  } else throw new Error('未知相机运动片段操作');
  const motionClips = validateCameraMotionClips([
    ...clips.flatMap(item => item.id === clip.id ? next ? [next] : [] : [item]), ...(extra ? [extra] : []),
  ]);
  return { camera: { ...camera, motionClips }, clipId: extra?.id ?? next?.id ?? null };
}

/** Adding/replacing a named motion segment is explicit; never discard intersecting clips. */
export function putCameraMotionClip(camera: DirectorCameraWithMotionClips, clip: DirectorCameraMotionClip, replaceId?: string): DirectorCameraWithMotionClips {
  // Replacing a generated route is not an instruction to reset the independent
  // lens layer. Remove that override explicitly with camera_micro_motion.
  const previous = camera.motionClips.find(c=>c.id===replaceId);
  if (previous?.path.microMotion && clip.path.microMotion === undefined)
    clip = {...clip,path:{...clip.path,microMotion:previous.path.microMotion}};
  validateCameraMotionClip(clip);
  if (replaceId !== undefined && !camera.motionClips.some(item => item.id === replaceId)) throw new Error(`要替换的相机片段不存在：${replaceId}`);
  if (replaceId !== undefined && clip.id !== replaceId) throw new Error('替换相机片段必须保留片段 id');
  return { ...camera, motionClips: validateCameraMotionClips([...camera.motionClips.filter(item => item.id !== replaceId), clip]) };
}

export type CameraMotionClipCommand = CameraMotionClipEdit & { type: 'edit_camera_motion_clip'; cameraId: string };
export function parseCameraMotionClipCommand(value: unknown): CameraMotionClipCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('相机片段操作格式无效');
  const raw = value as Record<string, unknown>;
  const text = (key: string) => { if (typeof raw[key] !== 'string' || !(raw[key] as string).trim()) throw new Error(`${key} 不能为空`); return (raw[key] as string).trim(); };
  const number = (key: string) => { if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw new Error(`${key} 必须是有限秒数`); return raw[key] as number; };
  const base = { type: 'edit_camera_motion_clip' as const, cameraId: text('cameraId'), clipId: text('clipId') };
  switch (raw.action) {
    case 'move': return { ...base, action: 'move', start: number('start') };
    case 'trim': case 'stretch':
      if (raw.start === undefined && raw.end === undefined) throw new Error('请指定相机片段起点或终点');
      return { ...base, action: raw.action, ...(raw.start === undefined ? {} : { start: number('start') }), ...(raw.end === undefined ? {} : { end: number('end') }) };
    case 'duplicate': return { ...base, action: 'duplicate', ...(raw.start === undefined ? {} : { start: number('start') }), ...(raw.id === undefined ? {} : { id: text('id') }) };
    case 'split': return { ...base, action: 'split', at: number('at'), ...(raw.id === undefined ? {} : { id: text('id') }) };
    case 'remove': return { ...base, action: 'remove' };
    default: throw new Error(`未知相机片段操作：${raw.action}`);
  }
}
/** Shared UI/CLI/MCP command: validate, enforce lock, edit, then extend the scene. */
export function editProjectCameraMotionClip(project: DirectorProject, input: CameraMotionClipCommand) {
  const edit = parseCameraMotionClipCommand(input);
  const camera = project.cameras.find(item => item.id === edit.cameraId);
  if (!camera) throw new Error(`相机不存在：${edit.cameraId}`);
  if (project.objects.some(object => object.linkedCameraId === camera.id && object.locked)) throw new Error('相机已锁定，请先解锁');
  const result = editCameraMotionClip(camera, edit);
  return { clipId: result.clipId, project: result.camera === camera ? project : ensureSceneTimeline({ ...project,
    cameras: project.cameras.map(item => item.id === camera.id ? result.camera : item) }) };
}

/** Pointer/arrow edits stop at neighbouring clips and available source. Typed commands reject invalid bounds. */
export function clampCameraMotionClipBounds(camera: DirectorCameraWithMotionClips, clipId: string,
  patch: { start?: number; end?: number }, mode: 'move' | 'trim' | 'stretch'): { start: number; end: number } {
  return clampTimelineClipBounds(camera.motionClips, clipId, patch, mode);
}
