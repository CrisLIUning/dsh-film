// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorProject } from './directorProject.js';
import { validateCameraMicroMotion, type CameraMicroMotionSettings } from './cameraMicroMotion.js';

export interface CameraMicroMotionCommand {
  type: 'camera_micro_motion';
  cameraId: string;
  clipId?: string;
  /** null removes the override. A disabled setting explicitly stops inheritance. */
  settings: CameraMicroMotionSettings | null;
}

export function parseCameraMicroMotionCommand(raw: unknown): CameraMicroMotionCommand {
  const value = raw as CameraMicroMotionCommand & {keyframeIds?: unknown};
  if (!value || value.type !== 'camera_micro_motion' || typeof value.cameraId !== 'string' || !value.cameraId.trim()) throw new Error('微运动需要机位 ID');
  if (value.clipId !== undefined && (typeof value.clipId !== 'string' || !value.clipId.trim())) throw new Error('微运动片段 ID 无效');
  if (value.keyframeIds !== undefined) throw new Error('微运动作用于机位或整个片段，不作用于单个关键帧');
  if (value.settings !== null) validateCameraMicroMotion(value.settings);
  const s = value.settings;
  return {type: 'camera_micro_motion', cameraId:value.cameraId, ...(value.clipId ? {clipId:value.clipId} : {}),
    settings: s === null ? null : {enabled:s.enabled,seed:s.seed,clock:s.clock,frequency:s.frequency,translation:[...s.translation],rotation:[...s.rotation]}};
}

export function stageCameraMicroMotion(project: DirectorProject, raw: CameraMicroMotionCommand) {
  const input = parseCameraMicroMotionCommand(raw);
  const camera = project.cameras.find(c => c.id === input.cameraId);
  if (!camera) throw new Error('机位不存在');
  if (project.objects.some(o => o.linkedCameraId === camera.id && o.locked)) throw new Error('机位已锁定');
  const clip = camera.motionClips.find(c => c.id === input.clipId);
  if (input.clipId && !clip) throw new Error('片段不存在');
  const change = <T extends {microMotion?: CameraMicroMotionSettings}>(item:T):T => {
    const {microMotion: _old, ...rest} = item;
    return {...rest, ...(input.settings ? {microMotion:input.settings} : {})} as T;
  };
  const updated = clip ? {...camera,motionClips:camera.motionClips.map(c => c === clip ? {...c,path:change(c.path)} : c)} : change(camera);
  return {project:{...project,cameras:project.cameras.map(c => c === camera ? updated : c)},camera:updated,clipId:clip?.id};
}
