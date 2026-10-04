/**
 * The staging compiler: a plan in a director's words becomes the desk's
 * project document. Ported from Studio's apps/daemon/src/director/staging.ts
 * (unchanged but for import paths).
 * @module dsh-film/director/staging
 */

import {stageObjectStroke,parseObjectStrokeCommand} from "./vendor/director-math/schema/objectStroke.js";
import { parseLightingCommand, stageLighting } from "./vendor/director-math/schema/sceneLighting.js";
import { parseCameraMicroMotionCommand, stageCameraMicroMotion } from './vendor/director-math/schema/cameraMicroMotionEditing.js';
import { parseCameraPhotography, stageCameraPhotography } from './vendor/director-math/schema/cameraPhotography.js';
import { getConstrainedObjectMotionSnapshot } from './vendor/director-math/schema/routeCollision.js';
import { importAnimationAsset, parseImportAnimation } from './vendor/director-math/schema/animationImport.js';
import { importModelAsset, parseImportModel } from './vendor/director-math/schema/modelImport.js';
import { relinkAsset, parseAssetRelink } from './vendor/director-math/schema/assetRelink.js';
import { applyCharacterHeight, parseCharacterHeight, defaultCharacterHeight } from './vendor/director-math/schema/characterSizing.js';
import { applyModelCalibration, parseCalibrateAsset } from "./vendor/director-math/schema/modelCalibration.js";
import { applySpatialProfile, parseSpatialProfile } from "./vendor/director-math/schema/spatialProfile.js";
import { editCharacterLook, parseCharacterLookEdit } from './vendor/director-math/schema/characterLookEditing.js';
import { editCharacterAction, parseCharacterActionEdit } from './vendor/director-math/schema/characterActionEditing.js';
import { parseSceneEventCommand, editSceneEvent, parseCameraEventAlignment, alignCameraClipToEvents } from './vendor/director-math/schema/sceneEventEditing.js';
import { parseCameraCompositionCommand, stageCameraComposition } from './vendor/director-math/schema/cameraCompositionEdit.js';
import { parseCameraKeyframeCommand, stageCameraKeyframe } from './vendor/director-math/schema/cameraKeyframe.js';
import {stageCameraStroke, parseCameraStrokeCommand} from './vendor/director-math/schema/cameraStroke.js';
import { stageCameraPresetClipCommand, parseCameraPresetClipCommand } from './vendor/director-math/schema/cameraMotionClipPreset.js';
import { editProjectCameraMotionClip, parseCameraMotionClipCommand } from './vendor/director-math/schema/cameraMotionClipEditing.js';
import { migrateCameraMotionTrack } from './vendor/director-math/schema/cameraMotionClips.js';
import { applyCameraPreset, parseCameraPresetInput } from './vendor/director-math/schema/cameraPreset.js';
import { editMotionClip, parseMotionClipEdit } from './vendor/director-math/schema/motionClipEditing.js';
import { editShotSequence, parseShotEdit } from './vendor/director-math/schema/shotSequence.js';
import { ensureSceneTimeline, getSceneDuration, setSceneTime } from './vendor/director-math/schema/sceneTime.js';
import { createSceneObjectFromAsset } from './vendor/director-math/schema/assetPlacement.js';
import { applyObjectTransformEdit, parseObjectTransformEdit } from './vendor/director-math/schema/objectTransformEdit.js';
// The staging compiler: a plan in a director's words becomes the desk's
// project document. Deterministic, pure, and additive — every op names what
// it touches, and nothing else in the scene moves.
import type {
  DirectorCameraMotionKeyframe,
  DirectorCameraShot,
  DirectorObject,
  DirectorObjectMotionClip,
  DirectorObjectMotionKeyframe,
  DirectorProject,
  DirectorTransform,
} from './vendor/director-math/schema/directorProject.js';
import { getObjectMotionClipSpans, getObjectMotionClips } from './vendor/director-math/schema/objectMotion.js';
import { normalizeBodyType } from './vendor/director-math/runtime/mannequin/bodyTypes.js';
import type { Vec3 } from './vendor/director-math/schema/vec3.js';
import type {
  DirectorGroundPoint,
  DirectorShotSpec,
  DirectorStageApplied,
  DirectorStageOp,
  DirectorStagePlan,
} from './contracts/index.js';

import { isFramableObject, openQueryScene, sampleObjectsAt, shotSeconds, type QueryScene } from './scene.js';
import {
  resolveOverShoulder,
  resolveShot,
  SHOT_ANGLES,
  SHOT_SIDES,
  SHOT_SIZE_IDS,
  SHOT_SIZES,
  type ResolvedShot,
} from './vocabulary.js';

export class DirectorStageError extends Error {
  readonly code = 'DIRECTOR_STAGE_INVALID';
  constructor(message: string, readonly op: number | null = null) {
    super(op == null ? message : `第 ${op + 1} 步:${message}`);
    this.name = 'DirectorStageError';
  }
}

export interface DirectorStageResult {
  project: DirectorProject;
  applied: DirectorStageApplied[];
  warnings: string[];
  /** Cameras the plan created or changed. */
  cameraIds: string[];
}

const CHARACTER_COLORS = ['#4F8EF7', '#E0524D', '#22A06B', '#F2A93B', '#8E5CF6', '#E91E63', '#0EA5E9', '#A16207'];
const PROP_GEOMETRIES = new Set(['box', 'sphere', 'cylinder', 'torus', 'cone', 'pyramid']);
const MAX_OPS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPoint(value: unknown): value is DirectorGroundPoint {
  return Array.isArray(value) && (value.length === 2 || value.length === 3) && value.every(finite);
}

function optionalString(value: unknown, what: string, op: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new DirectorStageError(`${what} 要是非空字符串`, op);
  return value;
}

function optionalNumber(value: unknown, what: string, op: number, min = -Infinity, max = Infinity): number | undefined {
  if (value === undefined) return undefined;
  if (!finite(value) || value < min || value > max) throw new DirectorStageError(`${what} 要是 ${min} 到 ${max} 之间的数`, op);
  return value;
}

function parseShotSpec(value: unknown, op: number): DirectorShotSpec {
  if (!isRecord(value)) throw new DirectorStageError('shot 要是对象:{ subject, size, side?, angle?, over? }', op);
  const subject = optionalString(value.subject, 'shot.subject', op);
  if (!subject) throw new DirectorStageError('shot.subject 要写拍谁', op);
  if (typeof value.size !== 'string' || !(value.size in SHOT_SIZES)) {
    throw new DirectorStageError(`shot.size 只能是 ${SHOT_SIZE_IDS.join(' / ')}`, op);
  }
  if (value.angle !== undefined && !(typeof value.angle === 'string' && value.angle in SHOT_ANGLES)) {
    throw new DirectorStageError(`shot.angle 只能是 ${Object.keys(SHOT_ANGLES).join(' / ')}`, op);
  }
  if (value.side !== undefined && !(typeof value.side === 'string' && value.side in SHOT_SIDES)) {
    throw new DirectorStageError(`shot.side 只能是 ${Object.keys(SHOT_SIDES).join(' / ')}`, op);
  }
  if (value.shoulder !== undefined && value.shoulder !== 'left' && value.shoulder !== 'right') {
    throw new DirectorStageError('shot.shoulder 只能是 left 或 right', op);
  }
  const spec: DirectorShotSpec = { subject, size: value.size as DirectorShotSpec['size'] };
  if (value.angle !== undefined) spec.angle = value.angle as NonNullable<DirectorShotSpec['angle']>;
  if (value.side !== undefined) spec.side = value.side as NonNullable<DirectorShotSpec['side']>;
  const over = optionalString(value.over, 'shot.over', op);
  if (over) spec.over = over;
  if (value.shoulder !== undefined) spec.shoulder = value.shoulder as 'left' | 'right';
  const fov = optionalNumber(value.fov, 'shot.fov', op, 10, 120);
  if (fov !== undefined) spec.fov = fov;
  const distance = optionalNumber(value.distance, 'shot.distance', op, -20, 200);
  if (distance !== undefined) spec.distance = distance;
  const at = optionalNumber(value.at, 'shot.at', op, 0, 3600);
  if (at !== undefined) spec.at = at;
  return spec;
}

/** The plan as the wire allows it, or a `DirectorStageError` naming the step and what is wrong. */
export function parseDirectorStagePlan(value: unknown): DirectorStagePlan {
  if (!isRecord(value) || !Array.isArray(value.ops)) throw new DirectorStageError('plan 要是 { ops: [...] }');
  if (value.ops.length === 0) throw new DirectorStageError('plan.ops 是空的:没有要做的事');
  if (value.ops.length > MAX_OPS) throw new DirectorStageError(`一份计划最多 ${MAX_OPS} 步`);
  const ops = value.ops.map((raw, index): DirectorStageOp => {
    if (!isRecord(raw) || typeof raw.type !== 'string') throw new DirectorStageError('每一步要有 type', index);
    switch (raw.type) {
      case 'set_scene_event': case 'remove_scene_event':
        try {return parseSceneEventCommand(raw);}catch(error){throw new DirectorStageError((error as Error).message,index);}
      case 'align_camera_clip':
        try {return parseCameraEventAlignment(raw);}catch(error){throw new DirectorStageError((error as Error).message,index);}
      case 'camera_photography':
        try { return parseCameraPhotography(raw); }
        catch(error){throw new DirectorStageError((error as Error).message,index);}
      case 'light': case 'lighting': case 'lighting_preset':
        try { return parseLightingCommand(raw); }
        catch(error){throw new DirectorStageError((error as Error).message,index);}
      case 'camera_micro_motion':
        try {return parseCameraMicroMotionCommand(raw);}
        catch(error){throw new DirectorStageError((error as Error).message,index);}
      case 'camera_composition':
        try { return parseCameraCompositionCommand(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'camera_keyframe':
        try {return parseCameraKeyframeCommand(raw);}
        catch(error){throw new DirectorStageError((error as Error).message,index);}
      case 'object_stroke':
        try { return parseObjectStrokeCommand(raw); }
        catch(error) { throw new DirectorStageError((error as Error).message,index); }
      case 'camera_stroke':
        try { return parseCameraStrokeCommand(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message,index); }
      case 'camera_preset_clip':
        try { return parseCameraPresetClipCommand(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'camera_preset':
        try { return { type: 'camera_preset', ...parseCameraPresetInput(raw) }; }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'edit_camera_motion_clip':
        try { return parseCameraMotionClipCommand(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'set_look_clip': case 'edit_look_clip':
        try { return parseCharacterLookEdit(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'set_action_clip': case 'edit_action_clip': case 'extract_hold_actions':
        try { return parseCharacterActionEdit(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'edit_motion_clip':
        try { return parseMotionClipEdit(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'set_shot': case 'remove_shot': case 'move_shot': case 'duplicate_shot': case 'split_shot':
        try { return parseShotEdit(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'set_character_height':
        try { return parseCharacterHeight(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'import_animation':
        try { return parseImportAnimation(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'import_asset':
        try { return parseImportModel(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'relink_asset':
        try { return parseAssetRelink(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'calibrate_asset':
        try { return parseCalibrateAsset(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'set_spatial_profile':
        try { return parseSpatialProfile(raw); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      case 'place_asset': {
        const assetId = optionalString(raw.assetId, 'assetId', index);
        if (!assetId || !isPoint(raw.at)) throw new DirectorStageError('place_asset 需要 assetId 和 at:[x,z] 或 [x,y,z]', index);
        const id = optionalString(raw.id, 'id', index);
        return { type: 'place_asset', assetId, at: raw.at, ...(id ? { id } : {}) };
      }
      case 'transform_objects': {
        try { return { type: 'transform_objects', ...parseObjectTransformEdit(raw) }; }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
      }
      case 'place_character': {
        if (!isPoint(raw.at)) throw new DirectorStageError('place_character 需要 at:[x, z] 或 [x, y, z]', index);
        const facing = raw.facing === undefined
          ? undefined
          : finite(raw.facing)
            ? raw.facing
            : isRecord(raw.facing) && typeof raw.facing.toward === 'string' && raw.facing.toward
              ? { toward: raw.facing.toward }
              : null;
        if (facing === null) throw new DirectorStageError('facing 要是角度数,或 { toward: 对象 id }', index);
        if (raw.action !== undefined && raw.action !== null && typeof raw.action !== 'string') {
          throw new DirectorStageError('action 要是动作 id 或 null', index);
        }
        return {
          type: 'place_character',
          at: raw.at,
          ...(optionalString(raw.id, 'id', index) ? { id: raw.id as string } : {}),
          ...(optionalString(raw.name, 'name', index) ? { name: raw.name as string } : {}),
          ...(optionalString(raw.bodyType, 'bodyType', index) ? { bodyType: raw.bodyType as string } : {}),
          ...(facing !== undefined ? { facing } : {}),
          ...(raw.action !== undefined ? { action: raw.action as string | null } : {}),
          ...(optionalString(raw.color, 'color', index) ? { color: raw.color as string } : {}),
        };
      }
      case 'place_prop': {
        if (!isPoint(raw.at)) throw new DirectorStageError('place_prop 需要 at:[x, z] 或 [x, y, z]', index);
        if (raw.geometry !== undefined && !(typeof raw.geometry === 'string' && PROP_GEOMETRIES.has(raw.geometry))) {
          throw new DirectorStageError(`geometry 只能是 ${[...PROP_GEOMETRIES].join(' / ')}`, index);
        }
        if (raw.size !== undefined && !(Array.isArray(raw.size) && raw.size.length === 3 && raw.size.every((n) => finite(n) && n > 0))) {
          throw new DirectorStageError('size 要是 [宽, 高, 深],都大于 0', index);
        }
        const facing = optionalNumber(raw.facing, 'facing', index);
        return {
          type: 'place_prop',
          at: raw.at,
          ...(optionalString(raw.id, 'id', index) ? { id: raw.id as string } : {}),
          ...(optionalString(raw.name, 'name', index) ? { name: raw.name as string } : {}),
          ...(raw.geometry !== undefined ? { geometry: raw.geometry as 'box' } : {}),
          ...(raw.size !== undefined ? { size: raw.size as [number, number, number] } : {}),
          ...(facing !== undefined ? { facing } : {}),
          ...(optionalString(raw.color, 'color', index) ? { color: raw.color as string } : {}),
        };
      }
      case 'move': {
        const objectId = optionalString(raw.objectId, 'objectId', index);
        if (!objectId) throw new DirectorStageError('move 需要 objectId', index);
        if (!finite(raw.start) || raw.start < 0) throw new DirectorStageError('start 要是不为负的秒数', index);
        if (!finite(raw.end) || raw.end <= raw.start) throw new DirectorStageError('end 要晚于 start', index);
        if (!Array.isArray(raw.path) || raw.path.length === 0 || !raw.path.every(isPoint)) {
          throw new DirectorStageError('path 要是一个或多个 [x, z] / [x, y, z]', index);
        }
        if (raw.pace !== undefined && raw.pace !== 'uniform' && raw.pace !== 'soft' && raw.pace !== 'custom') {
          throw new DirectorStageError('pace 只能是 uniform / soft / custom', index);
        }
        if (raw.facing !== undefined && raw.facing !== 'path' && raw.facing !== 'manual') {
          throw new DirectorStageError('facing 只能是 path 或 manual', index);
        }
        for (const key of ['action', 'arriveAction'] as const) {
          if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== 'string') {
            throw new DirectorStageError(`${key} 要是动作 id 或 null`, index);
          }
        }
        const holds = raw.holds === undefined ? undefined : raw.holds;
        if (holds !== undefined) {
          if (!Array.isArray(holds)) throw new DirectorStageError('holds 要是数组', index);
          for (const hold of holds) {
            if (!isRecord(hold) || !Number.isInteger(hold.point) || !finite(hold.seconds) || (hold.seconds as number) <= 0) {
              throw new DirectorStageError('每个 hold 要有 point(路线点序号)和 seconds', index);
            }
            if (hold.action !== undefined && typeof hold.action !== 'string') throw new DirectorStageError('hold.action 要是字符串', index);
          }
        }
        return {
          type: 'move',
          objectId,
          start: raw.start,
          end: raw.end,
          path: raw.path as DirectorGroundPoint[],
          ...(optionalString(raw.clipId, 'clipId', index) ? { clipId: raw.clipId as string } : {}),
          ...(optionalString(raw.name, 'name', index) ? { name: raw.name as string } : {}),
          ...(raw.pace !== undefined ? { pace: raw.pace as 'uniform' } : {}),
          ...(raw.facing !== undefined ? { facing: raw.facing as 'path' } : {}),
          ...(raw.action !== undefined ? { action: raw.action as string | null } : {}),
          ...(raw.arriveAction !== undefined ? { arriveAction: raw.arriveAction as string | null } : {}),
          ...(holds !== undefined ? { holds: holds as Array<{ point: number; seconds: number; action?: string }> } : {}),
        };
      }
      case 'shot': {
        const shot = parseShotSpec(raw.shot, index);
        const seconds = optionalNumber(raw.seconds, 'seconds', index, 0.5, 3600);
        if (raw.track !== undefined && typeof raw.track !== 'boolean') throw new DirectorStageError('track 要是布尔', index);
        if (raw.active !== undefined && typeof raw.active !== 'boolean') throw new DirectorStageError('active 要是布尔', index);
        return {
          type: 'shot',
          shot,
          ...(optionalString(raw.cameraId, 'cameraId', index) ? { cameraId: raw.cameraId as string } : {}),
          ...(optionalString(raw.name, 'name', index) ? { name: raw.name as string } : {}),
          ...(seconds !== undefined ? { seconds } : {}),
          ...(raw.track !== undefined ? { track: raw.track as boolean } : {}),
          ...(raw.active !== undefined ? { active: raw.active as boolean } : {}),
        };
      }
      case 'camera_move': {
        if (!Array.isArray(raw.keyframes) || raw.keyframes.length < 2) throw new DirectorStageError('camera_move 至少要两个 keyframes', index);
        const keyframes = raw.keyframes.map((entry) => {
          if (!isRecord(entry) || !finite(entry.at) || entry.at < 0) throw new DirectorStageError('每个 keyframe 要有 at(秒)和 shot', index);
          const hold = optionalNumber(entry.hold, 'keyframe.hold', index, 0, 3600);
          return { at: entry.at, shot: parseShotSpec(entry.shot, index), ...(hold !== undefined ? { hold } : {}) };
        });
        const seconds = optionalNumber(raw.seconds, 'seconds', index, 0.5, 3600);
        if (raw.pace !== undefined && raw.pace !== 'uniform' && raw.pace !== 'soft' && raw.pace !== 'custom') {
          throw new DirectorStageError('pace 只能是 uniform / soft / custom', index);
        }
        if (raw.interpolation !== undefined && raw.interpolation !== 'linear' && raw.interpolation !== 'smooth') {
          throw new DirectorStageError('interpolation 只能是 linear 或 smooth', index);
        }
        return {
          type: 'camera_move',
          keyframes,
          ...(optionalString(raw.cameraId, 'cameraId', index) ? { cameraId: raw.cameraId as string } : {}),
          ...(optionalString(raw.name, 'name', index) ? { name: raw.name as string } : {}),
          ...(seconds !== undefined ? { seconds } : {}),
          ...(raw.pace !== undefined ? { pace: raw.pace as 'custom' } : {}),
          ...(raw.interpolation !== undefined ? { interpolation: raw.interpolation as 'smooth' } : {}),
          ...(typeof raw.track === 'boolean' ? { track: raw.track } : {}),
          ...(typeof raw.active === 'boolean' ? { active: raw.active } : {}),
        };
      }
      case 'follow': {
        const shot = parseShotSpec(raw.shot, index);
        const seconds = optionalNumber(raw.seconds, 'seconds', index, 0.5, 3600);
        const every = optionalNumber(raw.every, 'every', index, 0.1, 10);
        return {
          type: 'follow',
          shot,
          ...(optionalString(raw.cameraId, 'cameraId', index) ? { cameraId: raw.cameraId as string } : {}),
          ...(optionalString(raw.name, 'name', index) ? { name: raw.name as string } : {}),
          ...(seconds !== undefined ? { seconds } : {}),
          ...(every !== undefined ? { every } : {}),
          ...(typeof raw.active === 'boolean' ? { active: raw.active } : {}),
        };
      }
      case 'remove': {
        const objectId = optionalString(raw.objectId, 'objectId', index);
        const cameraId = optionalString(raw.cameraId, 'cameraId', index);
        if (!objectId && !cameraId) throw new DirectorStageError('remove 需要 objectId 或 cameraId', index);
        return { type: 'remove', ...(objectId ? { objectId } : {}), ...(cameraId ? { cameraId } : {}) };
      }
      case 'set_active_camera': {
        const cameraId = optionalString(raw.cameraId, 'cameraId', index);
        if (!cameraId) throw new DirectorStageError('set_active_camera 需要 cameraId', index);
        return { type: 'set_active_camera', cameraId };
      }
      case 'set_scene_time': {
        const duration = optionalNumber(raw.duration, 'duration', index, 0.01);
        if (raw.loop !== undefined && typeof raw.loop !== 'boolean') throw new DirectorStageError('loop 要是布尔', index);
        let loopRange: { start: number; end: number } | null | undefined;
        if (raw.loopRange === null) loopRange = null;
        else if (raw.loopRange !== undefined) {
          const range = raw.loopRange as Record<string, unknown>;
          if (!range || typeof range !== 'object' || Array.isArray(range)) throw new DirectorStageError('loopRange 需要 {start,end} 或 null', index);
          const start = optionalNumber(range.start, 'loopRange.start', index, 0);
          const end = optionalNumber(range.end, 'loopRange.end', index, 0.01);
          if (start === undefined || end === undefined || end - start < 0.01 - 1e-9) throw new DirectorStageError('loopRange 需要有效的起止秒数', index);
          loopRange = { start, end };
        }
        if (duration === undefined && raw.loop === undefined && loopRange === undefined) throw new DirectorStageError('set_scene_time 需要 duration、loop 或 loopRange', index);
        return { type: 'set_scene_time', ...(duration !== undefined ? { duration } : {}), ...(typeof raw.loop === 'boolean' ? { loop: raw.loop } : {}), ...(loopRange !== undefined ? { loopRange } : {}) };
      }
      case 'set_scene': {
        if (raw.collision !== undefined && typeof raw.collision !== 'boolean') throw new DirectorStageError('collision 要是布尔', index);
        return { type: 'set_scene', ...(typeof raw.collision === 'boolean' ? { collision: raw.collision } : {}) };
      }
      default:
        throw new DirectorStageError(`不认识的 type:${raw.type}`, index);
    }
  });
  return { ops };
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function freeId(prefix: string, taken: Set<string>) {
  let n = 1;
  while (taken.has(`${prefix}_${n}`)) n += 1;
  return `${prefix}_${n}`;
}

function takenIds(project: DirectorProject) {
  const ids = new Set<string>();
  for (const object of project.objects) {
    ids.add(object.id);
    for (const clip of getObjectMotionClips(object)) ids.add(clip.id);
  }
  for (const camera of project.cameras) ids.add(camera.id);
  return ids;
}

function groundPoint(point: DirectorGroundPoint, groundY: number): Vec3 {
  return point.length === 3 ? [point[0], point[1], point[2]] : [point[0], groundY, point[1]];
}

function fmt(value: number) {
  return Number(value.toFixed(2)).toString();
}

function fmtPoint(point: Vec3) {
  return `(${fmt(point[0])}, ${fmt(point[2])})`;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => Number(((radians * 180) / Math.PI).toFixed(1));

function yawToward(from: Vec3, to: Vec3, fallback: number) {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  return Math.hypot(dx, dz) > 1e-6 ? Math.atan2(dx, dz) : fallback;
}

function label(item: { name?: string; id: string }) {
  return item.name?.trim() || item.id;
}

function describeShot(spec: DirectorShotSpec, subject: DirectorObject, foreground: DirectorObject | null, resolved: ResolvedShot) {
  const size = SHOT_SIZES[spec.size].label;
  if (foreground) {
    return `越过「${label(foreground)}」的${spec.shoulder === 'right' ? '右' : '左'}肩看「${label(subject)}」的${size},距 ${fmt(resolved.distance)} m`;
  }
  const side = SHOT_SIDES[spec.side ?? 'front'].label;
  const angle = SHOT_ANGLES[spec.angle ?? 'eye'].label;
  return `「${label(subject)}」的${size},${side},${angle},距 ${fmt(resolved.distance)} m`;
}

interface Staging {
  project: DirectorProject;
  applied: DirectorStageApplied[];
  warnings: string[];
  cameraIds: Set<string>;
  taken: Set<string>;
}

function findObject(staging: Staging, id: string, op: number, what = '对象') {
  const object = staging.project.objects.find((item) => item.id === id && item.kind !== 'camera');
  if (!object) throw new DirectorStageError(`没有${what} ${id}`, op);
  return object;
}

function scene(staging: Staging): QueryScene {
  return openQueryScene(staging.project);
}

function transformOf(position: Vec3, yaw: number, scale: Vec3 = [1, 1, 1]): DirectorTransform {
  return { position: [...position] as Vec3, rotation: [0, yaw, 0], scale: [...scale] as Vec3 };
}

/** Where a framable object is at a moment, after the desk's collision pass. */
function objectAt(staging: Staging, id: string, seconds: number, op: number) {
  const object = findObject(staging, id, op);
  if (!isFramableObject(object)) throw new DirectorStageError(`${label(object)} 不是能拍的东西(要是人物或道具)`, op);
  const sampled = sampleObjectsAt(scene(staging), seconds).find((item) => item.object.id === id)!;
  return { object, transform: sampled.transform };
}

function resolveSpec(staging: Staging, spec: DirectorShotSpec, op: number, at = spec.at ?? 0, tracked = true) {
  const subject = objectAt(staging, spec.subject, at, op);
  if (spec.over) {
    if (spec.over === spec.subject) throw new DirectorStageError('over 不能是拍摄对象自己', op);
    const foreground = objectAt(staging, spec.over, at, op);
    return {
      subject: subject.object,
      foreground: foreground.object,
      resolved: resolveOverShoulder(subject.object, subject.transform, foreground.object, foreground.transform, spec),
    };
  }
  return { subject: subject.object, foreground: null, resolved: resolveShot(subject.object, subject.transform, { ...spec, tracked }) };
}

function replaceOrAppend<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((entry) => entry.id === item.id) ? list.map((entry) => (entry.id === item.id ? item : entry)) : [...list, item];
}

function cameraKeyframe(
  id: string,
  time: number,
  resolved: ResolvedShot,
  subjectId: string,
  track: boolean,
  hold = 0,
): DirectorCameraMotionKeyframe {
  return {
    id,
    time,
    position: [...resolved.view.position] as Vec3,
    target: [...resolved.view.target] as Vec3,
    fov: resolved.view.fov,
    targetMode: track ? 'object' : 'manual',
    targetObjectId: track ? subjectId : null,
    targetBodyPart: resolved.bodyPart as NonNullable<DirectorCameraMotionKeyframe['targetBodyPart']>,
    targetFollowMode: 'immediate',
    targetStabilizationEnabled: false,
    pointBehavior: hold > 0 ? 'hold' : 'pass',
    holdSeconds: hold,
  };
}

/** A camera and the helper object the desk lists it by, placed into the project. */
function putCamera(staging: Staging, camera: DirectorCameraShot, active: boolean | undefined) {
  const existing = staging.project.objects.find(item => item.kind === 'camera' && item.linkedCameraId === camera.id);
  const preferredId = `${camera.id}_object`;
  const helperId = existing?.id ?? (staging.taken.has(preferredId) ? freeId(preferredId, staging.taken) : preferredId);
  const helper: DirectorObject = {
    id: helperId,
    name: camera.name,
    kind: 'camera',
    visible: existing?.visible ?? true,
    locked: existing?.locked ?? false,
    linkedCameraId: camera.id,
    transform: camera.transform,
  };
  const previousCamera = staging.project.cameras.find(item => item.id === camera.id);
  // Re-staging a shot changes its pose/path, not the camera-wide film gate or roll.
  const cameras = replaceOrAppend(staging.project.cameras, migrateCameraMotionTrack({
    ...(previousCamera?.filmGate ? {filmGate:previousCamera.filmGate} : {}),
    ...(previousCamera?.roll !== undefined ? {roll:previousCamera.roll} : {}),
    ...(previousCamera?.microMotion ? {microMotion:previousCamera.microMotion} : {}),
    ...camera,
  }));
  const objects = replaceOrAppend(staging.project.objects, helper);
  const activeCameraId = active === true || !staging.project.activeCameraId ? camera.id : staging.project.activeCameraId;
  staging.project = { ...staging.project, cameras, objects, activeCameraId };
  staging.cameraIds.add(camera.id);
  staging.taken.add(camera.id);
  staging.taken.add(helperId);
}

function cameraIdFor(staging: Staging, requested: string | undefined) {
  if (requested) {
    const existing = staging.project.cameras.find(camera => camera.id === requested) ?? null;
    if (!existing && staging.taken.has(requested)) throw new DirectorStageError(`ID 已存在：${requested}`);
    return {id:requested,existing};
  }
  return { id: freeId('cam', staging.taken), existing: null };
}

function cameraNameFor(staging: Staging, requested: string | undefined, existing: DirectorCameraShot | null) {
  if (requested) return requested;
  if (existing) return existing.name;
  return `机位 ${staging.project.cameras.length + 1}`;
}

/* ── the ops ──────────────────────────────────────────────────────────────── */

function placeCharacter(staging: Staging, op: Extract<DirectorStageOp, { type: 'place_character' }>, index: number) {
  const groundY = staging.project.scene.groundHeight ?? 0;
  const position = groundPoint(op.at, groundY);
  const existing = op.id ? staging.project.objects.find((item) => item.id === op.id) : null;
  if (!existing && op.id && staging.taken.has(op.id)) throw new DirectorStageError(`ID 已存在：${op.id}`, index);
  if (existing?.locked) throw new DirectorStageError(`人物已锁定：${existing.name}`, index);
  if (existing && existing.kind !== 'character') throw new DirectorStageError(`${op.id} 已经是一个${existing.kind},不是人物`, index);
  const id = op.id ?? freeId('char', staging.taken);
  const bodyType = op.bodyType ? normalizeBodyType(op.bodyType) : existing?.bodyType ?? 'mannequin';
  if (op.bodyType && bodyType !== op.bodyType) staging.warnings.push(`第 ${index + 1} 步:不认识体型 ${op.bodyType},用了 ${bodyType}`);
  const yaw = op.facing === undefined
    ? existing?.transform.rotation[1] ?? 0
    : typeof op.facing === 'number'
      ? toRadians(op.facing)
      : yawToward(position, findObject(staging, op.facing.toward, index).transform.position, existing?.transform.rotation[1] ?? 0);
  const characterCount = staging.project.objects.filter((item) => item.kind === 'character').length;
  const character: DirectorObject = {
    ...(existing ?? {}),
    id,
    name: op.name ?? existing?.name ?? `角色 ${characterCount + 1}`,
    kind: 'character',
    visible: existing?.visible ?? true,
    locked: existing?.locked ?? false,
    bodyType: bodyType as NonNullable<DirectorObject['bodyType']>,
    ...(!existing ? {heightMetres: defaultCharacterHeight(bodyType)} : {}),
    color: op.color ?? existing?.color ?? CHARACTER_COLORS[characterCount % CHARACTER_COLORS.length]!,
    transform: transformOf(position, yaw, existing?.transform.scale),
    characterRig: {
      ...existing?.characterRig,
      rigType: existing?.characterRig?.rigType ?? 'ue4-mannequin',
      posePresetId: existing?.characterRig?.posePresetId ?? 'stand',
      controls: existing?.characterRig?.controls ?? {},
      ...(op.action !== undefined || !existing ? {actionPresetId: op.action ?? null} : {}),
    },
  };
  staging.project = { ...staging.project, objects: replaceOrAppend(staging.project.objects, character) };
  staging.taken.add(id);
  staging.applied.push({
    op: index,
    type: op.type,
    id,
    summary: `${existing ? '挪动' : '放置'}人物「${character.name}」到 ${fmtPoint(position)},朝 ${toDegrees(yaw)}°`,
  });
}

function placeProp(staging: Staging, op: Extract<DirectorStageOp, { type: 'place_prop' }>, index: number) {
  const groundY = staging.project.scene.groundHeight ?? 0;
  const position = groundPoint(op.at, groundY);
  const existing = op.id ? staging.project.objects.find((item) => item.id === op.id) : null;
  if (!existing && op.id && staging.taken.has(op.id)) throw new DirectorStageError(`ID 已存在：${op.id}`, index);
  if (existing && existing.kind !== 'prop') throw new DirectorStageError(`${op.id} 已经是一个${existing.kind},不是道具`, index);
  const id = op.id ?? freeId('prop', staging.taken);
  const size = op.size ?? (existing?.transform.scale as Vec3 | undefined) ?? [1, 1, 1];
  const prop: DirectorObject = {
    ...(existing ?? {}),
    id,
    name: op.name ?? existing?.name ?? `道具 ${staging.project.objects.filter((item) => item.kind === 'prop').length + 1}`,
    kind: 'prop',
    visible: existing?.visible ?? true,
    locked: existing?.locked ?? false,
    geometryType: (op.geometry ?? existing?.geometryType ?? 'box') as NonNullable<DirectorObject['geometryType']>,
    color: op.color ?? existing?.color ?? '#9AA3AF',
    transform: transformOf(position, op.facing !== undefined ? toRadians(op.facing) : existing?.transform.rotation[1] ?? 0, size),
  };
  staging.project = { ...staging.project, objects: replaceOrAppend(staging.project.objects, prop) };
  staging.taken.add(id);
  staging.applied.push({
    op: index,
    type: op.type,
    id,
    summary: `${existing ? '挪动' : '放置'}道具「${prop.name}」(${prop.geometryType},${size.map(fmt).join('×')} m)到 ${fmtPoint(position)}`,
  });
}

function move(staging: Staging, op: Extract<DirectorStageOp, { type: 'move' }>, index: number) {
  const object = findObject(staging, op.objectId, index);
  if (!isFramableObject(object) && object.kind !== 'prop') throw new DirectorStageError(`${label(object)} 不能走路线`, index);
  const groundY = staging.project.scene.groundHeight ?? 0;
  const clips = getObjectMotionClips(object);
  const clipId = op.clipId ?? freeId(`${object.id}_clip`, staging.taken);
  const replacing = clips.find((clip) => clip.id === clipId) ?? null;
  const others = clips.filter((clip) => clip.id !== clipId);
  const from = getConstrainedObjectMotionSnapshot({ ...object, motionClips: others }, op.start, staging.project.scene, staging.project.objects).position;
  let points = op.path.map((point) => groundPoint(point, groundY));
  if (points.length === 1) points = [from, points[0]!];
  const isCharacter = object.kind === 'character';
  const startGap = Math.hypot(points[0]![0] - from[0], points[0]![2] - from[2]);
  if (startGap > 0.3) {
    staging.warnings.push(`第 ${index + 1} 步:路线起点 ${fmtPoint(points[0]!)} 离「${label(object)}」在 ${fmt(op.start)} 秒时的位置 ${fmtPoint(from)} 有 ${fmt(startGap)} m,片段开始时它会跳过去`);
  }
  const duration = op.end - op.start;
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    cumulative.push(cumulative[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = cumulative[cumulative.length - 1]!;
  const facingMode = op.facing ?? (isCharacter ? 'path' : 'manual');
  const walkAction = op.action === undefined ? (isCharacter ? 'walk-cycle' : null) : op.action;
  const keyframes: DirectorObjectMotionKeyframe[] = points.map((point, i) => {
    const last = i === points.length - 1;
    const next = points[Math.min(points.length - 1, i + 1)]!;
    const previous = points[Math.max(0, i - 1)]!;
    const yaw = last ? yawToward(previous, point, object.transform.rotation[1]) : yawToward(point, next, object.transform.rotation[1]);
    return {
      id: `${clipId}_p${i + 1}`,
      time: total > 1e-6 ? (cumulative[i]! / total) * duration : (i / (points.length - 1)) * duration,
      transform: transformOf(point, facingMode === 'path' ? yaw : object.transform.rotation[1], object.transform.scale as Vec3),
      actionPresetId: last ? op.arriveAction ?? null : walkAction,
      facingMode,
      pointBehavior: 'pass',
      holdSeconds: 0,
      holdAction: 'current',
      holdActionPresetId: null,
    };
  });
  let holdTotal = 0;
  for (const hold of op.holds ?? []) {
    const keyframe = keyframes[hold.point];
    if (!keyframe) throw new DirectorStageError(`hold.point ${hold.point} 超出路线点范围(0–${keyframes.length - 1})`, index);
    if (hold.point === keyframes.length - 1) {
      staging.warnings.push(`第 ${index + 1} 步:最后一点的停留不会生效,到点后本来就停在那里;想让它做动作用 arriveAction`);
      continue;
    }
    keyframe.pointBehavior = 'hold';
    keyframe.holdSeconds = hold.seconds;
    keyframe.holdAction = hold.action === 'stand' ? 'stand' : !hold.action || hold.action === 'current' ? 'current' : 'custom';
    keyframe.holdActionPresetId = keyframe.holdAction === 'custom' ? hold.action ?? null : null;
    holdTotal += hold.seconds;
  }
  if (holdTotal >= duration) {
    staging.warnings.push(`第 ${index + 1} 步:停留共 ${fmt(holdTotal)} 秒,不短于片段的 ${fmt(duration)} 秒,导演台会把停留按比例压短`);
  }
  const clip: DirectorObjectMotionClip = {
    id: clipId,
    ...(op.name ? { name: op.name } : {}),
    start: op.start,
    end: op.end,
    interpolation: points.length >= 3 ? 'smooth' : 'linear',
    speedMode: op.pace ?? 'uniform',
    ...(op.pace === 'custom' ? { customEasing: [0.42, 0, 0.58, 1] as [number, number, number, number] } : {}),
    keyframes,
  };
  for (const other of others) {
    if (clip.start < other.end && other.start < clip.end) {
      staging.warnings.push(`第 ${index + 1} 步:片段 ${clipId}(${fmt(clip.start)}–${fmt(clip.end)} 秒)和 ${other.id}(${fmt(other.start)}–${fmt(other.end)} 秒)在时间上重叠,晚开始的那段说了算`);
    }
  }
  const motionClips = [...others, clip].sort((a, b) => a.start - b.start);
  staging.project = {
    ...staging.project,
    objects: staging.project.objects.map((item) => (item.id === object.id ? { ...item, motionClips } : item)),
  };
  staging.taken.add(clipId);
  staging.applied.push({
    op: index,
    type: op.type,
    id: clipId,
    summary: `「${label(object)}」${replacing ? '改走' : '走'} ${points.map(fmtPoint).join(' → ')},${fmt(op.start)}–${fmt(op.end)} 秒(${fmt(total)} m${holdTotal ? `,停 ${fmt(holdTotal)} 秒` : ''})`,
  });
}

function shot(staging: Staging, op: Extract<DirectorStageOp, { type: 'shot' }>, index: number) {
  // A tracked camera re-centres its subject every frame. An over-the-shoulder
  // is composed off-centre on purpose, so it is locked off unless asked.
  const track = op.track ?? !op.shot.over;
  const { subject, foreground, resolved } = resolveSpec(staging, op.shot, index, op.shot.at ?? 0, track);
  const { id, existing } = cameraIdFor(staging, op.cameraId);
  const seconds = op.seconds ?? (existing ? shotSeconds(existing) : 6);
  const bodyPart = resolved.bodyPart;
  const keyframes = track && bodyPart !== 'center'
    ? [cameraKeyframe(`${id}_start`, 0, resolved, subject.id, true), cameraKeyframe(`${id}_end`, 1, resolved, subject.id, true)]
    : [];
  const camera: DirectorCameraShot = {
    id,
    name: cameraNameFor(staging, op.name, existing),
    fov: resolved.view.fov,
    transform: transformOf(resolved.rig, 0),
    targetMode: track ? 'object' : 'manual',
    targetObjectId: track ? subject.id : null,
    target: [...resolved.view.target] as Vec3,
    lastCaptureUrl: null,
    captures: existing?.captures ?? [],
    motionPath: {
      duration: seconds,
      loop: false,
      interpolation: 'smooth',
      easing: 'ease-in-out',
      speedMode: 'soft',
      customEasing: [0, 0, 1, 1],
      keyframes,
    },
  };
  putCamera(staging, camera, op.active);
  staging.applied.push({
    op: index,
    type: op.type,
    id,
    summary: `机位「${camera.name}」${existing ? '改为' : ''}:${describeShot(op.shot, subject, foreground, resolved)}${track ? `,跟 ${bodyPart}` : ''},${fmt(seconds)} 秒`,
  });
}

function cameraMove(staging: Staging, op: Extract<DirectorStageOp, { type: 'camera_move' }>, index: number) {
  const ordered = [...op.keyframes].sort((a, b) => a.at - b.at);
  const duration = op.seconds ?? Math.max(0.5, ordered[ordered.length - 1]!.at);
  if (ordered[ordered.length - 1]!.at > duration + 1e-9) throw new DirectorStageError(`最后一个 keyframe 的 at 超过了镜头时长 ${duration} 秒`, index);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.at - ordered[i - 1]!.at < 0.05) throw new DirectorStageError('两个 keyframe 的 at 至少要隔 0.05 秒', index);
  }
  const { id, existing } = cameraIdFor(staging, op.cameraId);
  const track = op.track ?? true;
  const shots = ordered.map((entry, i) => {
    const { subject, foreground, resolved } = resolveSpec(staging, entry.shot, index, entry.at, track);
    return { entry, subject, foreground, resolved, keyframe: cameraKeyframe(`${id}_k${i + 1}`, entry.at / duration, resolved, subject.id, track, entry.hold ?? 0) };
  });
  const first = shots[0]!;
  const camera: DirectorCameraShot = {
    id,
    name: cameraNameFor(staging, op.name, existing),
    fov: first.resolved.view.fov,
    transform: transformOf(first.resolved.rig, 0),
    targetMode: track ? 'object' : 'manual',
    targetObjectId: track ? first.subject.id : null,
    target: [...first.resolved.view.target] as Vec3,
    lastCaptureUrl: null,
    captures: existing?.captures ?? [],
    motionPath: {
      duration,
      loop: false,
      interpolation: op.interpolation ?? 'smooth',
      easing: 'ease-in-out',
      speedMode: op.pace ?? 'custom',
      customEasing: [0.42, 0, 0.58, 1],
      keyframes: shots.map((item) => item.keyframe),
    },
  };
  putCamera(staging, camera, op.active);
  staging.applied.push({
    op: index,
    type: op.type,
    id,
    summary: `机位「${camera.name}」运镜 ${fmt(duration)} 秒:${shots.map((item) => `${fmt(item.entry.at)}s ${describeShot(item.entry.shot, item.subject, item.foreground, item.resolved)}`).join(';')}`,
  });
}

function follow(staging: Staging, op: Extract<DirectorStageOp, { type: 'follow' }>, index: number) {
  const subject = findObject(staging, op.shot.subject, index);
  const clips = getObjectMotionClips(subject);
  const arrivals = clips.flatMap((clip) => getObjectMotionClipSpans(clip).arrivals);
  const lastArrival = arrivals.length ? Math.max(...arrivals) : 0;
  const duration = op.seconds ?? Math.max(0.5, lastArrival, getSceneDuration(staging.project));
  if (clips.length === 0) staging.warnings.push(`第 ${index + 1} 步:「${label(subject)}」没有路线,跟随机位不会动`);
  const every = op.every ?? 0.5;
  const times = new Set<number>();
  for (let t = 0; t < duration; t += every) times.add(Number(t.toFixed(4)));
  times.add(Number(duration.toFixed(4)));
  for (const arrival of arrivals) if (arrival <= duration) times.add(Number(arrival.toFixed(4)));
  const ordered = [...times].sort((a, b) => a - b);
  const { id, existing } = cameraIdFor(staging, op.cameraId);
  const shots = ordered.map((t, i) => {
    const { resolved } = resolveSpec(staging, { ...op.shot, at: t }, index, t);
    return { t, resolved, keyframe: cameraKeyframe(`${id}_f${i + 1}`, t / duration, resolved, subject.id, true) };
  });
  const first = shots[0]!;
  const camera: DirectorCameraShot = {
    id,
    name: cameraNameFor(staging, op.name, existing),
    fov: first.resolved.view.fov,
    transform: transformOf(first.resolved.rig, 0),
    targetMode: 'object',
    targetObjectId: subject.id,
    target: [...first.resolved.view.target] as Vec3,
    lastCaptureUrl: null,
    captures: existing?.captures ?? [],
    motionPath: {
      duration,
      loop: false,
      interpolation: 'linear',
      easing: 'linear',
      speedMode: 'custom',
      customEasing: [0, 0, 1, 1],
      keyframes: shots.map((item) => item.keyframe),
    },
  };
  putCamera(staging, camera, op.active);
  staging.applied.push({
    op: index,
    type: op.type,
    id,
    summary: `机位「${camera.name}」跟随「${label(subject)}」${fmt(duration)} 秒,保持${SHOT_SIZES[op.shot.size].label}、${SHOT_SIDES[op.shot.side ?? 'front'].label}(${shots.length} 个关键帧)`,
  });
}

function remove(staging: Staging, op: Extract<DirectorStageOp, { type: 'remove' }>, index: number) {
  if (op.objectId) {
    const object = findObject(staging, op.objectId, index);
    if (object.kind === 'camera' && object.linkedCameraId) { remove(staging, { type: 'remove', cameraId: object.linkedCameraId }, index); return; }
    const watchers = staging.project.cameras.filter((camera) =>
      camera.targetObjectId === object.id || camera.motionClips.some(clip => clip.path.keyframes.some(keyframe => keyframe.targetObjectId === object.id)));
    for (const camera of watchers) staging.warnings.push(`第 ${index + 1} 步:机位「${label(camera)}」在跟拍「${label(object)}」,它没了以后那台机位会看向空处`);
    staging.project = { ...staging.project, objects: staging.project.objects.filter((item) => item.id !== object.id) };
    staging.applied.push({ op: index, type: op.type, id: object.id, summary: `移除「${label(object)}」` });
  }
  if (op.cameraId) {
    const camera = staging.project.cameras.find((item) => item.id === op.cameraId);
    if (!camera) throw new DirectorStageError(`没有机位 ${op.cameraId}`, index);
    if (staging.project.shots.some(shot => shot.cameraId === camera.id && shot.locked)) throw new DirectorStageError('机位被已锁定镜头使用，请先解锁镜头', index);
    const cameras = staging.project.cameras.filter((item) => item.id !== camera.id);
    staging.project = {
      ...staging.project,
      cameras,
      shots: staging.project.shots.filter(shot => shot.cameraId !== camera.id),
      objects: staging.project.objects.filter((item) => !(item.kind === 'camera' && item.linkedCameraId === camera.id)),
      activeCameraId: staging.project.activeCameraId === camera.id ? cameras[0]?.id ?? null : staging.project.activeCameraId,
    };
    staging.cameraIds.delete(camera.id);
    staging.applied.push({ op: index, type: op.type, id: camera.id, summary: `移除机位「${label(camera)}」` });
  }
}

/* ── the compiler ─────────────────────────────────────────────────────────── */

export function stageDirectorScene(project: DirectorProject, plan: DirectorStagePlan): DirectorStageResult {
  const staging: Staging = {
    project: { ...project, objects: [...project.objects], cameras: [...project.cameras] },
    applied: [],
    warnings: [],
    cameraIds: new Set(),
    taken: takenIds(project),
  };
  plan.ops.forEach((op, index) => {
    switch (op.type) {
      case 'set_scene_event': case 'remove_scene_event': {
        try {const result=editSceneEvent(staging.project,op);staging.project=result.project;
          staging.applied.push({op:index,type:op.type,id:result.eventId,summary:`${op.type==='set_scene_event'?'保存':'移除'}事件 ${op.type==='set_scene_event'?op.name:op.eventId}`});
        }catch(error){throw new DirectorStageError((error as Error).message,index);}break;
      }
      case 'align_camera_clip': {
        try {const result=alignCameraClipToEvents(staging.project,op);staging.project=result.project;staging.cameraIds.add(op.cameraId);
          staging.applied.push({op:index,type:op.type,id:op.clipId,cameraId:op.cameraId,clipId:op.clipId,summary:`按事件对齐运镜 ${result.start}–${result.end} 秒`});
        }catch(error){throw new DirectorStageError((error as Error).message,index);}break;
      }
      case 'camera_photography': {
        try {
          const result=stageCameraPhotography(staging.project,op);
          staging.project=result.project;staging.cameraIds.add(result.camera.id);
          staging.applied.push({op:index,type:op.type,id:result.camera.id,cameraId:result.camera.id,
            ...(result.clipId ? {clipId:result.clipId} : {}),
            summary:`${result.camera.name}：${op.keyframeIds ? '所选关键帧' : op.clipId ? '当前片段' : '基础机位'}摄影参数`});
        }catch(error){throw new DirectorStageError((error as Error).message,index);}break;
      }
      case 'light': case 'lighting': case 'lighting_preset': {
        try {
          const result=stageLighting(staging.project,op);staging.project=result.project;
          for(const id of takenIds(result.project))staging.taken.add(id);
          staging.applied.push({op:index,type:op.type,id:result.ids.join(',')||'lighting',summary:`${op.type==='lighting_preset'?'采用布光预设':op.type==='lighting'?'调整环境补光':'更新灯具'}，其他场景对象保持不变`});
        } catch(error){throw new DirectorStageError((error as Error).message,index);}break;
      }
      case 'camera_micro_motion': {
        try {
          const result=stageCameraMicroMotion(staging.project,op);
          staging.project=result.project;staging.cameraIds.add(result.camera.id);
          staging.applied.push({op:index,type:op.type,id:result.camera.id,cameraId:result.camera.id,
            ...(result.clipId?{clipId:result.clipId}:{}),summary:`${result.camera.name}：${op.clipId?'当前片段':'机位默认'}微运动${op.settings===null?'移除覆盖':op.settings.enabled?'已开启':'已关闭'}`});
        }catch(error){throw new DirectorStageError((error as Error).message,index);}break;
      }
      case 'camera_composition': {
        try {
          const result = stageCameraComposition(staging.project, op);
          staging.project = result.project;
          staging.cameraIds.add(result.camera.id);
          staging.applied.push({op:index, type:op.type, id:result.camera.id, cameraId:result.camera.id,
            ...(result.clipId ? {clipId:result.clipId} : {}),
            summary:`${result.camera.name}：${op.keyframeIds ? '所选关键帧' : op.clipId ? '当前片段' : '基础机位'}构图${op.composition === null ? '继承上级' : ` ${op.composition.x}, ${op.composition.y}`}`});
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'camera_keyframe': {
        try {
          const result=stageCameraKeyframe(staging.project,parseCameraKeyframeCommand(op));
          staging.project=result.project;staging.cameraIds.add(result.camera.id);
          for(const id of takenIds(result.project))staging.taken.add(id);
          staging.applied.push({op:index,type:op.type,id:result.keyframe.id,cameraId:result.camera.id,clipId:result.clip.id,summary:`${result.camera.name}：${op.at} 秒录点`});
        }catch(error){throw new DirectorStageError((error as Error).message,index);}break;
      }
      case 'object_stroke': {
        try {
          const result = stageObjectStroke(staging.project, op);
          staging.project = result.project;
          for (const id of takenIds(result.project)) staging.taken.add(id);
          staging.applied.push({op:index,type:op.type,id:result.clip.id,objectId:result.objectId,clipId:result.clip.id,summary:`绘制路线 ${op.start}–${op.end} 秒`});
        } catch(error) { throw new DirectorStageError((error as Error).message,index); }
        break;
      }
      case 'camera_stroke': {
        try {
          const result=stageCameraStroke(staging.project,parseCameraStrokeCommand(op));
          staging.project=result.project;staging.cameraIds.add(result.camera.id);
          for(const id of takenIds(result.project))staging.taken.add(id);
          staging.applied.push({op:index,type:op.type,id:result.clip.id,cameraId:result.camera.id,clipId:result.clip.id,
            summary:`${result.camera.name}：手绘运镜 ${op.start}–${op.end} 秒，离地 ${op.height} 米`});
        } catch(error){throw new DirectorStageError((error as Error).message,index);}
        break;
      }
      case 'camera_preset_clip': {
        try {
          const result = stageCameraPresetClipCommand(staging.project, parseCameraPresetClipCommand(op));
          staging.project = result.project;
          staging.cameraIds.add(result.camera.id);
          for (const id of takenIds(result.project)) staging.taken.add(id);
          staging.applied.push({op:index,type:op.type,id:result.clip.id,cameraId:result.camera.id,clipId:result.clip.id,
            summary:`${result.createdCamera ? '新建机位' : '机位'}「${result.camera.name}」：${op.replaceClipId ? '替换' : '添加'}运镜片段 ${result.clip.id}（${op.start}–${op.end} 秒）`});
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'camera_preset': {
        try { staging.project = applyCameraPreset(staging.project, parseCameraPresetInput(op)); }
        catch (error) { throw new DirectorStageError((error as Error).message, index); }
        staging.cameraIds.add(op.cameraId);
        staging.applied.push({ op: index, type: op.type, id: op.cameraId, summary: `运镜预设 ${op.presetId} → ${op.cameraId}（${op.replaceExisting ? '替换当前路线' : '添加路线'}）` });
        break;
      }
      case 'edit_camera_motion_clip': {
        try {
          const result = editProjectCameraMotionClip(staging.project, op);
          staging.project = result.project;
          staging.cameraIds.add(op.cameraId);
          staging.applied.push({ op: index, type: op.type, id: result.clipId ?? op.clipId, summary: `相机运镜片段 ${op.action}: ${result.clipId ?? op.clipId}` });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'set_look_clip': case 'edit_look_clip': {
        try {
          const result = editCharacterLook(staging.project, op);
          staging.project = result.project;
          staging.applied.push({ op: index, type: op.type, id: result.clipId ?? op.clipId ?? '', summary: `看向片段 ${op.type === 'set_look_clip' ? '设置' : op.action}: ${result.clipId ?? op.clipId}` });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'extract_hold_actions': {
        try {
          const result = editCharacterAction(staging.project, op);
          staging.project = result.project;
          staging.applied.push({ op: index, type: op.type, id: op.objectId, summary: `停留动作已整理到基础动作轨：${op.objectId}` });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'set_action_clip': case 'edit_action_clip': {
        try {
          const result = editCharacterAction(staging.project, op);
          staging.project = result.project;
          staging.applied.push({ op: index, type: op.type, id: result.clipId ?? op.clipId ?? '', summary: `动作片段 ${op.type === 'set_action_clip' ? '设置' : op.action}: ${result.clipId ?? op.clipId}` });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'edit_motion_clip': {
        try {
          const result = editMotionClip(staging.project, op);
          staging.project = result.project;
          staging.applied.push({ op: index, type: op.type, id: result.clipId ?? op.clipId, summary: `移动片段 ${op.action}: ${result.clipId ?? op.clipId}` });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'set_shot': case 'remove_shot': case 'move_shot': case 'duplicate_shot': case 'split_shot': {
        try {
          const result = editShotSequence(staging.project, op);
          staging.project = result.project;
          staging.applied.push({ op: index, type: op.type, id: result.shotId ?? op.shotId ?? '', summary: `镜头编排 ${op.type}: ${result.shotId ?? op.shotId}` });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'set_character_height': {
        try {
          staging.project = applyCharacterHeight(staging.project, op);
          staging.applied.push({ op: index, type: op.type, id: op.objectIds.join(','), summary: `调整 ${op.objectIds.length} 个人物的站立身高：${op.heightMetres === null ? '恢复原模型尺寸' : op.heightMetres + ' m'}` });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'import_animation': {
        try {
          const result = importAnimationAsset(staging.project, op);
          staging.project = result.project;
          staging.taken.add(result.animationAssetId);
          staging.applied.push({ op: index, type: op.type, id: result.animationAssetId, animationAssetId: result.animationAssetId,
            actionIds: result.actionIds, reused: result.reused, summary: `${result.reused ? '复用' : '导入'}动作素材「${op.name}」；尚需预览检查骨架适配和动作质量` });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'import_asset': {
        try {
          const result = importModelAsset(staging.project, op);
          staging.project = result.project;
          for (const id of takenIds(result.project)) staging.taken.add(id);
          staging.applied.push({op:index,type:op.type,id:result.objectId ?? result.assetId,assetId:result.assetId,reused:result.reused,...(result.objectId?{objectId:result.objectId}:{}),...(result.animationAssetId?{animationAssetId:result.animationAssetId}:{}),summary:`${result.reused ? '复用' : '导入'}素材「${op.name}」${result.objectId ? '并放入场景' : '到素材库'}`});
        } catch(error) { throw new DirectorStageError((error as Error).message,index); }
        break;
      }
      case 'relink_asset': {
        try {
          staging.project = relinkAsset(staging.project, op);
          staging.applied.push({ op: index, type: op.type, id: op.assetId, summary: `重新关联素材「${op.assetId}」的原文件，保留实例与表演` });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'calibrate_asset': {
        try {
          staging.project = applyModelCalibration(staging.project, op);
          staging.applied.push({ op: index, type: op.type, id: op.assetId, summary: `校正素材「${op.assetId}」的单位、朝向和落点` });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'set_spatial_profile': {
        try {
          staging.project=applySpatialProfile(staging.project,op);
          staging.applied.push({op:index,type:op.type,id:op.objectId,summary:`${op.profile ? '更新':'清除'}空间标注「${op.objectId}」`});
        } catch(error) { throw new DirectorStageError((error as Error).message,index); }
        break;
      }
      case 'place_asset': {
        const asset = staging.project.assets.find(asset => asset.id === op.assetId);
        if (!asset) throw new DirectorStageError(`素材不存在：${op.assetId}`, index);
        if (op.id && staging.taken.has(op.id)) throw new DirectorStageError(`ID 已存在：${op.id}`, index);
        try {
          const object = createSceneObjectFromAsset(asset, staging.project.objects, { position: groundPoint(op.at, staging.project.scene.groundHeight), id: op.id ?? freeId('obj', staging.taken) });
          staging.project.objects.push(object);
          staging.taken.add(object.id);
          staging.applied.push({ op: index, type: op.type, id: object.id, summary: `放置素材「${asset.name ?? asset.fileName}」` });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'transform_objects': {
        try {
          const before = staging.project;
          const result = applyObjectTransformEdit(before, op);
          staging.project = result.project;
          for (const id of result.changedIds) staging.applied.push({ op: index, type: op.type, id, summary: `更新对象「${id}」的基础变换` });
          for (const id of result.skippedIds) staging.warnings.push(`跳过锁定或全景对象「${id}」`);
          result.project.cameras.forEach((camera, cameraIndex) => { if (camera !== before.cameras[cameraIndex]) staging.cameraIds.add(camera.id); });
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        break;
      }
      case 'place_character':
        placeCharacter(staging, op, index);
        break;
      case 'place_prop':
        placeProp(staging, op, index);
        break;
      case 'move':
        move(staging, op, index);
        break;
      case 'shot':
        shot(staging, op, index);
        break;
      case 'camera_move':
        cameraMove(staging, op, index);
        break;
      case 'follow':
        follow(staging, op, index);
        break;
      case 'remove':
        remove(staging, op, index);
        break;
      case 'set_active_camera': {
        if (!staging.project.cameras.some((camera) => camera.id === op.cameraId)) throw new DirectorStageError(`没有机位 ${op.cameraId}`, index);
        staging.project = { ...staging.project, activeCameraId: op.cameraId };
        staging.applied.push({ op: index, type: op.type, id: op.cameraId, summary: `活动机位改为 ${op.cameraId}` });
        break;
      }
      case 'set_scene_time': {
        try {
          staging.project = setSceneTime(staging.project, op);
        } catch (error) { throw new DirectorStageError((error as Error).message, index); }
        staging.applied.push({ op: index, type: op.type, id: 'scene', summary: `场景时长 ${getSceneDuration(staging.project)} 秒，循环${staging.project.timeline.loop ? '开' : '关'}，范围${staging.project.timeline.loopRange ? `${staging.project.timeline.loopRange.start}–${staging.project.timeline.loopRange.end} 秒` : '全场景'}` });
        break;
      }
      case 'set_scene': {
        if (op.collision !== undefined) {
          staging.project = { ...staging.project, scene: { ...staging.project.scene, pathCollisionEnabled: op.collision } };
        }
        staging.applied.push({ op: index, type: op.type, id: 'scene', summary: `场景:碰撞${op.collision === undefined ? '不变' : op.collision ? '开' : '关'}` });
        break;
      }
    }
    staging.project = ensureSceneTimeline(staging.project);
  });
  return {
    project: staging.project,
    applied: staging.applied,
    warnings: staging.warnings,
    cameraIds: [...staging.cameraIds],
  };
}
