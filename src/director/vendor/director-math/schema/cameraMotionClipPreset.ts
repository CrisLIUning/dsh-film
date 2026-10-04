// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { CAMERA_PATH_TEMPLATES } from './cameraPathTemplates.js';
import type { DirectorProject } from './directorProject.js';
import { compileCameraPreset, parseCameraPresetInput, type CameraPresetInput } from './cameraPreset.js';
import { getCameraPlaybackSnapshot } from './cameraPlayback.js';
import { migrateCameraMotionTrack, cameraForMotionClip, createCameraMotionClip, getCameraMotionTrackSnapshot, type DirectorCameraMotionClip, type DirectorCameraWithMotionClips } from './cameraMotionClips.js';
import { putCameraMotionClip } from './cameraMotionClipEditing.js';
import { ensureSceneTimeline } from './sceneTime.js';
import { DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT, getCameraRigPositionFromViewSnapshot, type CameraViewSnapshot } from './cameraGeometry.js';

export interface CameraPresetClipInput extends Omit<CameraPresetInput, 'cameraId' | 'duration' | 'replaceExisting'> {
  id: string;
  start: number;
  end: number;
  replaceClipId?: string;
  connectStart?: boolean;
  connectEnd?: boolean;
}

/** Shared range compiler: retains other clips and never mutates the supplied project. */
export function stageCameraPresetClip(project: DirectorProject, camera: DirectorCameraWithMotionClips, input: CameraPresetClipInput) {
  if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.start < 0 || input.end - input.start < .5) throw new Error('运镜预设时段至少 0.5 秒，起点不能早于 0');
  for (const join of [input.connectStart, input.connectEnd]) if (join !== undefined && typeof join !== 'boolean') throw new Error('运镜衔接选项必须是布尔值');
  const path = compileCameraPreset({ ...project, cameras: project.cameras.map(item => item.id === camera.id ? camera : item) }, {
    ...input, cameraId: camera.id, duration: input.end - input.start,
    snapshot: input.snapshot ?? getCameraMotionTrackSnapshot(camera, project.objects, input.start, project.scene),
  }, input.start);
  const usedKeys = new Set(camera.motionClips.filter(item => item.id !== input.replaceClipId).flatMap(item => item.path.keyframes.map(key => key.id)));
  path.keyframes = path.keyframes.map((key, index) => {
    let id = `${input.id}_k${index + 1}`;
    while (usedKeys.has(id)) id += '_copy'; usedKeys.add(id);
    return { ...key, id };
  });
  const clip = { ...createCameraMotionClip(input.id, path, input.start, input.end),
    name: camera.motionClips.find(item => item.id === input.replaceClipId)?.name ?? CAMERA_PATH_TEMPLATES.find(item => item.id === input.presetId)!.label };
  const others = camera.motionClips.filter(item => item.id !== input.replaceClipId);
  const connect = (edge: 'start' | 'end', neighbour: DirectorCameraMotionClip | undefined) => {
    if (!neighbour || !neighbour.path.keyframes.length) throw new Error(`没有相邻的${edge === 'start' ? '前一段' : '后一段'}可衔接`);
    const at = edge === 'start' ? input.start : input.end;
    const source = edge === 'start' ? neighbour.source.out : neighbour.source.in;
    const view = getCameraPlaybackSnapshot(cameraForMotionClip(camera, neighbour), project.objects, source / neighbour.path.duration, project.scene, undefined, at);
    const index = edge === 'start' ? 0 : clip.path.keyframes.length - 1;
    // Snapshot continuity is an explicit endpoint edit, not a permanent hidden constraint.
    clip.path.keyframes[index] = { ...clip.path.keyframes[index], ...view, targetMode: 'manual', targetObjectId: null, targetFollowMode: 'immediate', targetStabilizationEnabled: false };
  };
  if (input.connectStart) connect('start', others.find(item => Math.abs(item.end - input.start) < 1e-9));
  if (input.connectEnd) connect('end', others.find(item => Math.abs(item.start - input.end) < 1e-9));
  const updated = putCameraMotionClip(camera, clip, input.replaceClipId);
  return { camera: updated, clip };
}


export interface CameraPresetClipCommand extends Omit<CameraPresetClipInput, 'id'> {
  type: 'camera_preset_clip';
  /** Omit to create a new visible camera on apply; an unknown supplied id is an error. */
  cameraId?: string;
  cameraName?: string;
  clipId?: string;
}

export function parseCameraPresetClipCommand(raw: unknown): CameraPresetClipCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('运镜片段预设参数必须是对象');
  const value = raw as Record<string, unknown>;
  const text = (key: string) => {
    if (value[key] === undefined) return undefined;
    if (typeof value[key] !== 'string' || !(value[key] as string).trim()) throw new Error(`${key} 必须是非空字符串`);
    return (value[key] as string).trim();
  };
  const cameraId = text('cameraId'), cameraName = text('cameraName'), clipId = text('clipId'), replaceClipId = text('replaceClipId');
  if (cameraId && cameraName) throw new Error('cameraName 仅用于新建机位');
  if (!cameraId && replaceClipId) throw new Error('替换片段需要指定已有 cameraId');
  if (clipId && replaceClipId && clipId !== replaceClipId) throw new Error('替换相机片段必须保留片段 id');
  if (value.duration !== undefined || value.replaceExisting !== undefined) throw new Error('片段预设使用 start/end 和 replaceClipId，不使用 duration/replaceExisting');
  const start = value.start, end = value.end;
  if (typeof start !== 'number' || !Number.isFinite(start) || typeof end !== 'number' || !Number.isFinite(end) || start < 0 || end - start < .5 || end - start > 3600)
    throw new Error('运镜预设需要有效的场景 start/end，时段须为 0.5–3600 秒');
  for (const key of ['connectStart','connectEnd']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
  const { cameraId: _id, duration: _duration, replaceExisting: _replace, ...preset } = parseCameraPresetInput({ ...value, cameraId: cameraId ?? 'new-camera', duration: end - start });
  return { ...preset, type: 'camera_preset_clip', start, end,
    ...(cameraId ? { cameraId } : {}), ...(cameraName ? { cameraName } : {}), ...(clipId ? { clipId } : {}), ...(replaceClipId ? { replaceClipId } : {}),
    ...(value.connectStart === undefined ? {} : { connectStart: value.connectStart as boolean }),
    ...(value.connectEnd === undefined ? {} : { connectEnd: value.connectEnd as boolean }) };
}

function availableId(ids: string[], prefix: string) {
  let n = 1; while (ids.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** A proposed camera/object pair; constructing it never adds it to a scene. */
export function createPresetCamera(project: DirectorProject, snapshot: CameraViewSnapshot = DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT, name?: string) {
  const id = availableId([...project.cameras.map(camera => camera.id), ...project.objects.map(object => object.id)], 'cam_');
  const camera = migrateCameraMotionTrack({ id, name: name ?? `机位 ${project.cameras.length + 1}`, fov: snapshot.fov,
    ...(snapshot.roll !== undefined ? {roll:snapshot.roll} : {}),
    transform: { position: getCameraRigPositionFromViewSnapshot(snapshot), rotation: [0,0,0], scale: [1,1,1] },
    target: [...snapshot.target], targetMode: 'manual', captures: [], lastCaptureUrl: null });
  const object: DirectorProject['objects'][number] = { id: availableId([id, ...project.cameras.map(item => item.id), ...project.objects.map(item => item.id)], 'cam_object_'), name: camera.name,
    kind: 'camera', visible: true, locked: false, linkedCameraId: id, transform: structuredClone(camera.transform) };
  return { camera, object };
}

/** UI/HTTP/CLI/MCP all compile the same project, including atomic new-camera creation. */
export function stageCameraPresetClipCommand(project: DirectorProject, raw: CameraPresetClipCommand) {
  const input = parseCameraPresetClipCommand(raw);
  const existing = input.cameraId ? project.cameras.find(camera => camera.id === input.cameraId) : undefined;
  if (input.cameraId && !existing) throw new Error(`机位不存在：${input.cameraId}`);
  const created = existing ? null : createPresetCamera(project, input.snapshot, input.cameraName);
  const camera = existing ?? created!.camera;
  const candidate = created ? { ...project, cameras: [...project.cameras, camera], objects: [...project.objects, created.object],
    activeCameraId: project.activeCameraId ?? camera.id } : project;
  const id = input.clipId ?? input.replaceClipId ?? availableId(camera.motionClips.map(clip => clip.id), `${camera.id}_motion_`);
  const result = stageCameraPresetClip(candidate, camera, { ...input, id });
  return { ...result, createdCamera: Boolean(created), project: ensureSceneTimeline({ ...candidate,
    cameras: candidate.cameras.map(item => item.id === camera.id ? result.camera : item) }) };
}
