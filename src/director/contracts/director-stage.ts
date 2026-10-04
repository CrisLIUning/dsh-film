/**
 * Staging a director-desk scene from a plan: the op vocabulary and the answer.
 * Copied from Studio's packages/contracts/src/api/director-stage.ts.
 * @module dsh-film/director/contracts/director-stage
 */

import type { DirectorLookTarget } from './director-query.js';
/**
 * Staging a scene: what an agent says, and what the daemon makes of it.
 *
 * The agent does not write coordinates. It places characters, sends them
 * along routes, and asks for shots in a director's words — "a medium
 * close-up of 甲 from her front-left", "over 乙's shoulder onto 甲" — and the
 * daemon turns that into the desk's project document with the desk's own
 * geometry. Words are testable; coordinates are not.
 *
 * Every op names what it touches and leaves the rest of the scene alone: a
 * plan appends or explicitly replaces a named route. Lengths are metres, time is scene seconds,
 * and each camera has motion clips on the same scene clock.
 * Scene duration is independent of camera path duration.
 */
import type { DirectorEventTime, DirectorDiagnosticsResponse, DirectorQuerySource, DirectorQuerySourceEcho } from './director-query.js';

export type DirectorShotSize =
  | 'extreme-wide'
  | 'wide'
  | 'full'
  | 'medium-full'
  | 'medium'
  | 'medium-close'
  | 'close'
  | 'extreme-close';

export type DirectorShotAngle = 'eye' | 'high' | 'low' | 'top';

export type DirectorShotSide =
  | 'front'
  | 'three-quarter-left'
  | 'three-quarter-right'
  | 'left'
  | 'right'
  | 'back-left'
  | 'back-right'
  | 'back';

export type DirectorPropGeometry = 'box' | 'sphere' | 'cylinder' | 'torus' | 'cone' | 'pyramid';

/** A point on the ground as [x, z], or in space as [x, y, z]. */
export type DirectorGroundPoint = [number, number] | [number, number, number];

export interface DirectorShotSpec {
  /** The object the shot is of. */
  subject: string;
  size: DirectorShotSize;
  angle?: DirectorShotAngle;
  /** Where the camera stands, relative to the way the subject faces. */
  side?: DirectorShotSide;
  /** Over this character's shoulder onto the subject; `side` is then ignored. */
  over?: string;
  /** Which side of the frame the foreground shoulder sits on. Default left. */
  shoulder?: 'left' | 'right';
  fov?: number;
  /** Extra metres between lens and subject on top of what the size implies. */
  distance?: number;
  /** The moment of the subject's route the shot is framed on. Default 0. */
  at?: number;
}

export interface DirectorRouteHold {
  /** Index of the point in `path`. */
  point: number;
  seconds: number;
  /** `stand`, `current`, or an action preset id to play while holding. */
  action?: string;
}

/** Absolute base transforms, not animated path points. Missing axes retain each object's value. */
export interface DirectorTransformObjectsOp {
  type: 'transform_objects';
  objectIds: string[];
  position?: Partial<Record<'x' | 'y' | 'z', number>>;
  /** Degrees; the project continues storing radians. */
  rotation?: Partial<Record<'x' | 'y' | 'z', number>>;
  /** Positive absolute axis scales. Locked objects and panoramas are skipped and reported. */
  scale?: Partial<Record<'x' | 'y' | 'z', number>>;
}

/** Static asset calibration before instance transforms. */
export interface DirectorModelCalibration {
  metresPerUnit: number;
  /** XYZ radians before instance transforms. */
  rotation: [number, number, number];
  anchor: 'source' | 'center' | 'ground-center';
}
export interface DirectorModelBounds { min: [number, number, number]; max: [number, number, number] }
/** Authored proxies in calibrated object-local metres; not inferred mesh topology. */
export interface DirectorSpatialProfile {
  volumes: Array<{id:string;name:string;role:'wall'|'floor'|'ceiling'|'obstacle';bounds:DirectorModelBounds;openings?:Array<{id:string;name:string;bounds:DirectorModelBounds}>;surface?:{axis:'x'|'z';direction:1|-1;steps?:number}}>;
  anchors: Array<{id:string;name:string;purpose:'entry'|'mark'|'camera'|'prop';position:[number,number,number]}>;
}
export interface DirectorSpatialProfileOp {type:'set_spatial_profile';objectId:string;profile:DirectorSpatialProfile|null}
/** Register a checked model and optionally place an instance, atomically with embedded actions. */
export interface DirectorImportAssetOp {
  type: 'import_asset'; assetId?: string; name: string; kind: 'character' | 'prop' | 'scene';
  source: {url:string;fileName:string;modelFormat:'glb'|'fbx'|'obj';contentSha256:string;byteLength:number;storageKey?:string};
  addToScene?: boolean; position?: [number,number,number]; calibration?: DirectorModelCalibration;
  /** Rig inspection is supplied by the importer; the daemon verifies bytes, not a guessed skeleton. */
  character?: {heightMetres:number;rigProfile:'mixamo'|'mixamo-alt'|'bip'|'cc-base'|'generic-humanoid'|'unknown';readiness:'ready'|'native-only';orientation:[number,number,number];boneMap:Partial<Record<'head'|'chest'|'waist'|'leftUpperArm'|'leftForearm'|'leftHand'|'rightUpperArm'|'rightForearm'|'rightHand'|'leftThigh'|'leftCalf'|'leftFoot'|'rightThigh'|'rightCalf'|'rightFoot',string>>};
  animations?: Array<{id:string;name:string;duration:number;trackCount:number}>;
}

/** Register independently generated/inspected skeletal motion; does not certify retargeting quality. */
export interface DirectorImportAnimationOp {
  type: 'import_animation'; animationAssetId?: string; name: string;
  /** HTTP/CLI/MCP verify an owning-project raw file; never an expiring provider URL. */
  source: {url:string;fileName:string;modelFormat:'glb'|'fbx';contentSha256:string;byteLength:number;storageKey?:string};
  rigProfile: 'mixamo'|'mixamo-alt'|'bip'|'cc-base'|'generic-humanoid'|'unknown';
  /** Only when these clips are embedded in the exact registered character file. */
  sourceCharacterAssetId?: string;
  clips: Array<{id:string;name:string;duration:number;trackCount:number}>;
}

export interface DirectorRelinkAssetOp {
  type: 'relink_asset'; assetId: string;
  /** HTTP/CLI/MCP require an owning-project raw URL and verify its bytes before staging. */
  source: { url: string; fileName: string; modelFormat: 'glb' | 'fbx' | 'obj'; contentSha256: string; byteLength: number; storageKey?: string };
  /** Required for old assets without a stored digest, after reviewing the original file. */
  acceptUnverified?: boolean;
}

export interface DirectorCalibrateAssetOp {
  type: 'calibrate_asset'; assetId: string;
  /** null restores the historical 2 m fit. Applies to static model assets and all their instances. */
  calibration: DirectorModelCalibration | null;
  bounds?: DirectorModelBounds;
}

/** Add another scene instance of a model already registered in the project. */
export interface DirectorPlaceAssetOp {
  type: 'place_asset';
  assetId: string;
  /** New object id; existing ids are rejected. */
  id?: string;
  at: DirectorGroundPoint;
}

/** Ordered takes reference scene seconds; destination positions derive from array order. */
export type DirectorShotEditOp =
  | { type: 'set_shot'; shotId?: string; name?: string; cameraId?: string; sourceIn?: number; sourceOut?: number; locked?: boolean }
  | { type: 'remove_shot'; shotId: string }
  | { type: 'move_shot'; shotId: string; beforeId?: string | null }
  | { type: 'duplicate_shot'; shotId: string; id?: string }
  | { type: 'split_shot'; shotId: string; at: number; id?: string };

/** Nondestructive route editing. Bounds/at are scene seconds; source curves are retained. */
export type DirectorMotionClipEditOp = { type: 'edit_motion_clip'; objectId: string; clipId: string } & (
  | { action: 'move'; start: number }
  | { action: 'trim'; start?: number; end?: number }
  | { action: 'stretch'; start?: number; end?: number }
  | { action: 'duplicate'; start?: number; id?: string }
  | { action: 'split'; at: number; id?: string }
  | { action: 'remove' }
);

/** Camera source/window edits. Same scene-second semantics as object clips; overlaps are rejected. */
export type DirectorCameraMotionClipEditOp = { type: 'edit_camera_motion_clip'; cameraId: string; clipId: string } & (
  | { action: 'move'; start: number }
  | { action: 'trim' | 'stretch'; start?: number; end?: number }
  | { action: 'duplicate'; start?: number; id?: string }
  | { action: 'split'; at: number; id?: string }
  | { action: 'remove' }
);

/** Compile the shared preset at scene 0; existing camera paths require explicit replacement. */
export interface DirectorCameraPresetOp {
  type: 'camera_preset';
  cameraId: string;
  /** IDs, names, versions and credits are in query structure.cameraPresets. */
  presetId: string;
  duration?: number;
  scale?: number;
  targetObjectId?: string | null;
  targetBodyPart?: 'center' | 'head' | 'chest' | 'waist' | 'leftUpperArm' | 'leftForearm' | 'leftHand' | 'rightUpperArm' | 'rightForearm' | 'rightHand' | 'leftThigh' | 'leftCalf' | 'leftFoot' | 'rightThigh' | 'rightCalf' | 'rightFoot';
  /** Lens coordinates, not rig coordinates; defaults to saved camera at scene 0. */
  snapshot?: { position: [number, number, number]; target: [number, number, number]; fov: number; roll?:number };
  replaceExisting?: boolean;
}

/** Compile a preset into a scene-time range; omitted cameraId creates one camera atomically. */
export interface DirectorCameraPresetClipOp extends Omit<DirectorCameraPresetOp, 'type' | 'cameraId' | 'duration' | 'replaceExisting'> {
  type: 'camera_preset_clip';
  cameraId?: string;
  /** Only valid when creating a new camera. */
  cameraName?: string;
  /** Lens reference composition; omitted uses the existing camera at start or a default new viewpoint. */
  snapshot?: { position: [number, number, number]; target: [number, number, number]; fov: number; roll?:number };
  clipId?: string;
  start: number;
  end: number;
  /** Explicitly replace this clip, keeping its ID and all other clips. */
  replaceClipId?: string;
  /** Copy neighbouring endpoint views; these are editable samples, not constraints. */
  connectStart?: boolean;
  connectEnd?: boolean;
}

/** Ground stroke in scene-local X/Z, then lifted to a lens height above scene ground. */
/** Insert or update a single lens pose without redistributing other arrival times. */
export interface DirectorCameraKeyframeOp {
  type: 'camera_keyframe'; cameraId?: string; clipId?: string; keyframeId?: string;
  start?: number; end?: number; at: number;
  snapshot: {position:[number,number,number];target:[number,number,number];fov:number;roll?:number};
}

export interface DirectorCameraStrokeOp {
  type: 'camera_stroke';
  cameraId?: string;
  cameraName?: string;
  clipId?: string;
  replaceClipId?: string;
  start: number;
  end: number;
  height: number;
  aim: 'direction' | 'point' | 'object';
  targetObjectId?: string;
  targetBodyPart?: DirectorCameraPresetOp['targetBodyPart'];
  pace?: 'uniform' | 'drawn';
  snapshot?: {position: [number,number,number]; target: [number,number,number]; fov: number; roll?:number};
  samples: Array<{point:[number,number]; time:number}>;
}

/** Opt-in effective sensor gate, linked focal/FOV and source-time camera roll. */
export interface DirectorCameraPhotographyOp {
  type:'camera_photography'; cameraId:string; clipId?:string; keyframeIds?:string[];
  filmGate?:{widthMm:number;heightMm:number}|null;
  preserve?:'fov'|'focal-length'; focalLengthMm?:number; fov?:number; roll?:number|null;
}

export interface DirectorCameraMicroMotionSettings {
  enabled:boolean; seed:number; frequency:number; clock:'scene'|'source';
  /** Lens-local metres, right/up/forward. */
  translation:[number,number,number];
  /** Local pitch/yaw/roll amplitudes, in degrees. */
  rotation:[number,number,number];
}
export interface DirectorCameraMicroMotionOp {
  type:'camera_micro_motion'; cameraId:string; clipId?:string;
  /** null removes the override; enabled:false explicitly disables inheritance. */
  settings:DirectorCameraMicroMotionSettings|null;
}

/** Subject anchor in the output frame: x left→right and y top→bottom, 0–1.
 * Omitting clipId edits the base camera. A whole-clip edit clears point overrides.
 * null removes an override; {x:.5,y:.5} explicitly centres the subject. */
export interface DirectorCameraCompositionOp {
  type: 'camera_composition';
  cameraId: string;
  clipId?: string;
  keyframeIds?: string[];
  composition: {x:number;y:number} | null;
}

export type DirectorSceneEventOp =
  | {type:'set_scene_event';eventId?:string;name:string;at:number|{objectId:string;clipId:string;keyframeId:string;edge:'arrival'|'departure';offset?:number}}
  | {type:'remove_scene_event';eventId:string};
/** One explicit alignment. Omit end to move, or provide both bounds to stretch. */
export interface DirectorCameraEventAlignmentOp {type:'align_camera_clip';cameraId:string;clipId:string;start:DirectorEventTime;end?:DirectorEventTime}

/** Independent full-body performance, in scene seconds; never edits route transforms. */
export type DirectorCharacterActionOp =
  | { type: 'set_action_clip'; objectId: string; clipId?: string; name?: string; start: number; end: number;
      actionId: string | null; source?: {duration:number;in:number;out:number}; loop?: boolean; muted?: boolean; blendIn?: number; blendOut?: number;
      layer?: 'base' | 'override'; freezeAt?: number | null; automaticLocomotion?: boolean; endExclusive?: boolean }
  | { type: 'extract_hold_actions'; objectId: string; motionClipId?: string }
  | { type: 'edit_action_clip'; objectId: string; clipId: string;
      action: 'move' | 'trim' | 'stretch' | 'duplicate' | 'split' | 'remove'; start?: number; end?: number; at?: number; id?: string };

export type DirectorCharacterLookOp =
 | {type:'set_look_clip';objectId:string;clipId?:string;name?:string;start:number;end:number;target:DirectorLookTarget;
    source?:{duration:number;in:number;out:number};blendIn?:number;blendOut?:number;strength?:number;muted?:boolean}
 | {type:'edit_look_clip';objectId:string;clipId:string;action:'move'|'trim'|'stretch'|'duplicate'|'split'|'remove';start?:number;end?:number;at?:number;id?:string};
export type DirectorCharacterHeightOp = { type: 'set_character_height'; objectIds: string[]; heightMetres: number | null };
export interface DirectorLightSettings {
  kind:'directional'|'point'|'spot'; enabled:boolean; role:'key'|'fill'|'rim'|'other';
  color:string; temperatureK:number|null; intensity:number; distance:number; decay:number; angle:number; penumbra:number;
  shadow:{enabled:boolean;mapSize:512|1024|2048;extent:number;far:number};
}
export type DirectorLightingOp =
  | {type:'light';id:string;name?:string;visible?:boolean;locked?:boolean;position?:[number,number,number];rotation?:[number,number,number];settings:DirectorLightSettings}
  | {type:'lighting';ambient:number;color:string}
  | {type:'lighting_preset';preset:'daylight'|'window'|'three-point';at:[number,number,number]};

export interface DirectorObjectStrokeOp {
  type: "object_stroke"; objectId: string; clipId?: string; start: number; end: number;
  pace?: "uniform" | "drawn";
  /** Scene-local metres and relative drawing seconds. */
  samples: Array<{position:[number,number,number];time:number}>;
}

export type DirectorStageOp =
  | DirectorObjectStrokeOp
  | DirectorLightingOp
  | DirectorImportAssetOp
  | DirectorImportAnimationOp
  | DirectorRelinkAssetOp
  | DirectorCharacterHeightOp
  | DirectorCalibrateAssetOp
  | DirectorSpatialProfileOp
  | DirectorCharacterLookOp
  | DirectorCharacterActionOp
  | DirectorSceneEventOp
  | DirectorCameraEventAlignmentOp
  | DirectorCameraCompositionOp
  | DirectorCameraPhotographyOp
  | DirectorCameraMicroMotionOp
  | DirectorCameraStrokeOp
  | DirectorCameraKeyframeOp
  | DirectorCameraMotionClipEditOp
  | DirectorCameraPresetClipOp
  | DirectorCameraPresetOp
  | DirectorMotionClipEditOp
  | DirectorShotEditOp
  | DirectorPlaceAssetOp
  | DirectorTransformObjectsOp
  | {
      type: 'place_character';
      id?: string;
      name?: string;
      bodyType?: string;
      at: DirectorGroundPoint;
      /** Degrees (0 faces +Z, 90 faces +X), or another object to face. */
      facing?: number | { toward: string };
      /** The rig's own action when no route point overrides it. */
      action?: string | null;
      color?: string;
    }
  | {
      type: 'place_prop';
      id?: string;
      name?: string;
      geometry?: DirectorPropGeometry;
      at: DirectorGroundPoint;
      /** Metres, [width, height, depth]. */
      size?: [number, number, number];
      facing?: number;
      color?: string;
    }
  | {
      type: 'move';
      objectId: string;
      /** Replace this clip instead of adding one. */
      clipId?: string;
      name?: string;
      start: number;
      end: number;
      /** One point walks there from where the object stands; more is the route itself. */
      path: DirectorGroundPoint[];
      pace?: 'uniform' | 'soft' | 'custom';
      facing?: 'path' | 'manual';
      /** Played from each point to the next. Characters walk by default. */
      action?: string | null;
      /** Played on arriving at the last point. */
      arriveAction?: string | null;
      holds?: DirectorRouteHold[];
    }
  | {
      type: 'shot';
      cameraId?: string;
      name?: string;
      shot: DirectorShotSpec;
      /** How long the shot runs. */
      seconds?: number;
      /** Keep the lens on the subject as it moves. Default true. */
      track?: boolean;
      active?: boolean;
    }
  | {
      type: 'camera_move';
      cameraId?: string;
      name?: string;
      seconds?: number;
      keyframes: Array<{ at: number; shot: DirectorShotSpec; hold?: number }>;
      pace?: 'uniform' | 'soft' | 'custom';
      interpolation?: 'linear' | 'smooth';
      track?: boolean;
      active?: boolean;
    }
  | {
      type: 'follow';
      cameraId?: string;
      name?: string;
      /** The framing to keep, relative to the subject, as it moves. */
      shot: DirectorShotSpec;
      seconds?: number;
      /** Seconds between the keyframes that carry the lens along. Default 0.5. */
      every?: number;
      active?: boolean;
    }
  | { type: 'remove'; objectId?: string; cameraId?: string }
  | { type: 'set_active_camera'; cameraId: string }
  | { type: 'set_scene'; collision?: boolean }
  | { type: 'set_scene_time'; duration?: number; loop?: boolean; loopRange?: { start: number; end: number } | null };

export interface DirectorStagePlan {
  ops: DirectorStageOp[];
}

export interface DirectorStageRequest {
  source: DirectorQuerySource;
  plan: DirectorStagePlan;
  /** Compile, check and report; write nothing. */
  dryRun?: boolean;
  /** The fingerprint the caller read; the write is refused if the scene has moved on. */
  expectedFingerprint?: string;
  /** Return the resulting project. Always on for a dry run. */
  includeProject?: boolean;
}

export interface DirectorStageApplied {
  /** Index of the op in the plan. */
  op: number;
  type: string;
  /** The object, clip or camera the op produced or changed. */
  id: string;
  summary: string;
  /** Import results report actual IDs after content/configuration reuse. */
  assetId?: string; objectId?: string; animationAssetId?: string; reused?: boolean;
  /** Actual imported action IDs after deduplication, usable by set_action_clip. */
  actionIds?: string[];
  /** Ranged preset result IDs, including a newly created camera. */
  cameraId?: string;
  clipId?: string;
}

export interface DirectorStageResponse {
  written: boolean;
  source: DirectorQuerySourceEcho;
  /** Fingerprint of the scene as stored after the write, or of the result of a dry run. */
  fingerprint: string;
  applied: DirectorStageApplied[];
  warnings: string[];
  /** The compiled scene checked as a director would. */
  diagnostics: DirectorDiagnosticsResponse;
  /** Whether the scene was read from and written into an open desk. */
  desk: 'open' | 'closed' | 'none';
  project?: unknown;
}

export interface DirectorSceneResponse {
  source: DirectorQuerySourceEcho;
  version: number;
  fingerprint: string;
  /** Whether a desk currently has this scene open. */
  desk: 'open' | 'closed' | 'none';
  project: unknown;
}

export interface DirectorSceneWriteRequest {
  project: unknown;
  expectedFingerprint?: string;
}

export interface DirectorSceneWriteResponse {
  source: DirectorQuerySourceEcho;
  fingerprint: string;
  desk: 'open' | 'closed' | 'none';
}
