// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorCameraFilmGate, DirectorProject } from './directorProject.js';
import { cameraMotionClipKeyframeSeconds } from './cameraMotionClips.js';
import { focalLengthFromFov, fovFromFocalLength, validateCameraFov, validateCameraRoll, validateFilmGate } from './cameraOptics.js';

export interface CameraPhotographyCommand {
  type: 'camera_photography';
  cameraId: string;
  clipId?: string;
  keyframeIds?: string[];
  /** Camera-wide; null returns to legacy workspace framing. */
  filmGate?: DirectorCameraFilmGate | null;
  /** Required when changing an existing gate. Adopting the first gate retains
   * FOV unless a focal length is explicitly supplied. */
  preserve?: 'fov' | 'focal-length';
  focalLengthMm?: number;
  fov?: number;
  /** null removes the selected override, inheriting the parent (base: zero). */
  roll?: number | null;
}

export function parseCameraPhotography(raw: unknown): CameraPhotographyCommand {
  const v = raw as CameraPhotographyCommand;
  if (!v || v.type !== 'camera_photography' || typeof v.cameraId !== 'string' || !v.cameraId.trim()) throw new Error('摄影参数需要机位 ID');
  if (v.clipId !== undefined && (typeof v.clipId !== 'string' || !v.clipId.trim())) throw new Error('摄影片段 ID 无效');
  if (v.keyframeIds !== undefined && (!v.clipId || !Array.isArray(v.keyframeIds) || !v.keyframeIds.length || !v.keyframeIds.every(id => typeof id === 'string' && id.trim()) || new Set(v.keyframeIds).size !== v.keyframeIds.length)) throw new Error('摄影选点需要片段和不重复的关键帧 ID');
  if (v.filmGate !== undefined && v.clipId) throw new Error('有效画幅属于整台机位，不能仅修改片段或关键帧');
  if (v.filmGate !== undefined && v.filmGate !== null) validateFilmGate(v.filmGate);
  if (v.fov !== undefined) validateCameraFov(v.fov);
  if (v.focalLengthMm !== undefined && (!Number.isFinite(v.focalLengthMm) || v.focalLengthMm <= 0)) throw new Error('焦距必须是正数毫米值');
  if (v.fov !== undefined && v.focalLengthMm !== undefined) throw new Error('焦距与 FOV 是同一投影，只能指定一个');
  if (v.roll !== undefined && v.roll !== null) validateCameraRoll(v.roll);
  if (v.preserve !== undefined && (!['fov','focal-length'].includes(v.preserve) || v.filmGate === undefined || v.filmGate === null)) throw new Error('保持方式只用于有效画幅修改');
  if (v.filmGate === undefined && v.fov === undefined && v.focalLengthMm === undefined && v.roll === undefined) throw new Error('没有摄影参数修改');
  return { type: v.type, cameraId: v.cameraId,
    ...(v.clipId ? {clipId:v.clipId} : {}), ...(v.keyframeIds ? {keyframeIds:[...v.keyframeIds]} : {}),
    ...(v.filmGate !== undefined ? {filmGate:v.filmGate ? {...v.filmGate} : null} : {}),
    ...(v.preserve !== undefined ? {preserve:v.preserve} : {}),
    ...(v.focalLengthMm !== undefined ? {focalLengthMm:v.focalLengthMm} : {}),
    ...(v.fov !== undefined ? {fov:v.fov} : {}), ...(v.roll !== undefined ? {roll:v.roll} : {}) };
}

export function stageCameraPhotography(project: DirectorProject, raw: CameraPhotographyCommand) {
  const input = parseCameraPhotography(raw);
  const camera = project.cameras.find(c => c.id === input.cameraId);
  if (!camera) throw new Error('机位不存在');
  if (project.objects.some(o => o.linkedCameraId === camera.id && o.locked)) throw new Error('机位已锁定');
  const clip = camera.motionClips.find(c => c.id === input.clipId);
  if (input.clipId && !clip) throw new Error('片段不存在');
  for (const id of input.keyframeIds ?? []) {
    const index = clip!.path.keyframes.findIndex(k => k.id === id);
    if (index < 0) throw new Error('关键帧不在当前片段');
    if (cameraMotionClipKeyframeSeconds(clip!, index) === null) throw new Error('不能修改已裁出的摄影关键帧');
  }
  const gate = input.filmGate === undefined ? camera.filmGate : input.filmGate ?? undefined;
  if (input.focalLengthMm !== undefined && !gate) throw new Error('设置焦距前需要采用有效画幅');
  const gateChanged = input.filmGate && (!camera.filmGate || input.filmGate.widthMm !== camera.filmGate.widthMm || input.filmGate.heightMm !== camera.filmGate.heightMm);
  if (gateChanged && camera.filmGate && !input.preserve) throw new Error('改变有效画幅需要选择保持焦距或保持 FOV');
  if (gateChanged && input.preserve === 'focal-length' && !camera.filmGate) throw new Error('旧机位尚无有效画幅，无法推断原焦距');
  const convert = (fov: number) => gateChanged && input.preserve === 'focal-length'
    ? fovFromFocalLength(focalLengthFromFov(fov, camera.filmGate!), gate!) : fov;
  const projection = (fov: number) => input.focalLengthMm !== undefined ? fovFromFocalLength(input.focalLengthMm,gate!) : input.fov ?? fov;
  const changeRoll = <T extends {roll?:number}>(item:T):T => {
    if (input.roll === undefined) return item;
    const {roll: _old, ...rest} = item;
    return {...rest, ...(input.roll !== null ? {roll:input.roll} : {})} as T;
  };
  // Changing gate while holding focal length transforms every retained source
  // point, including trimmed points. One invalid conversion rejects the whole edit.
  let updated = {...camera, fov:convert(camera.fov), motionClips:camera.motionClips.map(c => ({...c,path:{...c.path,keyframes:c.path.keyframes.map(k => ({...k,fov:convert(k.fov)}))}}))};
  if (input.filmGate !== undefined) {
    if (gate) updated.filmGate = gate; else delete updated.filmGate;
  }
  if (!clip) updated = {...changeRoll(updated), fov:projection(updated.fov)};
  else updated.motionClips = updated.motionClips.map(c => c.id !== clip.id ? c : {...c,path:{
    ...(input.keyframeIds ? c.path : changeRoll(c.path)),
    keyframes:c.path.keyframes.map(k => {
      if (input.keyframeIds && !input.keyframeIds.includes(k.id)) return k;
      const changed = input.keyframeIds ? changeRoll(k) : input.roll === undefined ? k : (({roll: _old,...rest})=>rest)(k);
      return {...changed,fov:projection(k.fov)};
    }),
  }});
  return {project:{...project,cameras:project.cameras.map(c=>c===camera?updated:c)},camera:updated,clipId:clip?.id};
}
