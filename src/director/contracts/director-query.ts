/**
 * Asking a director-desk scene questions: the query kinds (structure, sample,
 * diagnostics, events, actions) and their answers. Copied from Studio's
 * packages/contracts/src/api/director-query.ts.
 * @module dsh-film/director/contracts/director-query
 */

import type { DirectorLightSettings } from "./director-stage.js";
import type { DirectorModelCalibration, DirectorModelBounds, DirectorSpatialProfile, DirectorCameraMicroMotionSettings } from "./director-stage.js";
/**
 * Asking questions of a director-desk scene without the desk being open.
 *
 * A director does not want a screenshot of the blocking, they want to know
 * things: who is where at three seconds, what the second camera is looking
 * at, whether the subject ever leaves the frame, whether two set-ups sit on
 * opposite sides of the line. The scene document already holds all of it;
 * this is the daemon answering from that document with the desk's own motion
 * math, so the numbers are the ones the desk would draw.
 *
 * Time is scene seconds. Every camera is a shot that starts at 0 and runs for
 * its own `seconds`; objects move on the same clock. A moment past a shot's
 * end is reported with that camera `ended`.
 */

export type DirectorVec3 = [number, number, number];

/** The director node of a board, or a scene document handed over inline. */
export type DirectorQuerySource =
  | {
      boardId: string;
      /** The director node to read. Optional when the board has exactly one. */
      nodeId?: string;
      /** The film project the board is embedded in, when it is not on its own. */
      project?: string;
    }
  | {
      /** A desk project (any version it knows how to upgrade) or a desk document envelope's `project`. */
      directorProject: unknown;
    };

export interface DirectorStructureQuery {
  kind: 'structure';
  /** Opt in to the static preset catalogue; regular structure stays compact. */
  includeCameraPresets?: boolean;
}

export type DirectorEventTime = number | {eventId:string;offset?:number};
export interface DirectorEventsQuery {kind:'events';objectId?:string;includeDerived?:boolean}
export interface DirectorEventsResponse {
  kind:'events';source:DirectorQuerySourceEcho;fingerprint:string;
  events:Array<{id:string;name:string;kind:'arrival'|'departure'|'marker';time:number|null;objectId?:string;clipId?:string;keyframeId?:string;issue?:string;
    anchor?:{objectId:string;clipId:string;keyframeId:string;edge:'arrival'|'departure';offset?:number}}>;
}

/** Model-specific choices. Compatibility is not proof that external bytes are loaded. */
export interface DirectorActionChoice {
  id: string | null; label: string; duration: number;
  kind: 'pose' | 'preset' | 'imported' | 'legacy'; available: boolean; detail: string;
  renderedAs?: string; requiresLibrary?: boolean;
}
export interface DirectorActionClip {
  id: string; name?: string; start: number; end: number; actionId: string | null;
  /** Retained animation-clock seconds; can span several native cycles. */
  source: { duration: number; in: number; out: number }; loop?: boolean; muted?: boolean;
  /** Fade durations in retained source-clock seconds. */
  blendIn?: number; blendOut?: number;
  layer?: 'base' | 'override'; freezeAt?: number; automaticLocomotion?: boolean; endExclusive?: boolean;
}
export interface DirectorActionsQuery { kind: 'actions'; objectId: string }
export interface DirectorActionsResponse {
  kind: 'actions'; source: DirectorQuerySourceEcho; fingerprint: string;
  objectId: string; actions: DirectorActionChoice[]; clips: DirectorActionClip[];
  /** Horizontal skeletal travel is constrained at the pelvis; this is not animation-to-route extraction. */
  motionPolicy: { horizontal: 'route'; vertical: 'animation'; heading: 'route-when-path-facing'; requiresPelvisMapping: true };
}

export interface DirectorSampleQuery {
  kind: 'sample';
  /** Absolute scene seconds or an event resolved against the current scene. */
  at: DirectorEventTime[];
  /** Frame aspect used for framing; the desk's viewport default when absent. */
  aspect?: number;
}

export interface DirectorDiagnosticsQuery {
  kind: 'diagnostics';
  /** Limit to these cameras; all when absent. */
  cameraIds?: string[];
  /** Seconds between samples when scanning a shot. */
  step?: number;
  aspect?: number;
}

export type DirectorQuery = DirectorActionsQuery | DirectorStructureQuery | DirectorSampleQuery | DirectorDiagnosticsQuery | DirectorEventsQuery;

export interface DirectorQueryRequest {
  source: DirectorQuerySource;
  query: DirectorQuery;
}

export interface DirectorQuerySourceEcho {
  boardId?: string;
  nodeId?: string;
}

/* ── structure ────────────────────────────────────────────────────────────── */

export interface DirectorStructureClip {
  id: string;
  name?: string;
  start: number;
  end: number;
  points: number;
  holds: number;
  /** Original source range, clock anchor, and playback rate. Cropped points stay in the source. */
  source: { duration: number; in: number; out: number; origin: number };
  rate: number;
  visiblePoints: number;
  /** Scene seconds for all original points, including points outside the retained span. */
  arrivals: number[];
}

export interface DirectorStructureObject {
  spatial?: {mode:'authored-proxy'|'legacy-bounds';collisionEligible:boolean;needsReview:boolean;profile?:DirectorSpatialProfile;anchors?:Array<DirectorSpatialProfile['anchors'][number]&{scenePosition:DirectorVec3}>};
  actionClips?: DirectorActionClip[];
  lookClips?: DirectorLookClip[];
  id: string;
  name: string;
  kind: 'character' | 'prop' | 'scene' | 'panorama' | 'light';
  light?:DirectorLightSettings;
  direction?:[number,number,number];
  visible: boolean;
  bodyType?: string;
  /** Standing reference height after object Y scaling, before scene transform; not posed bounds. */
  height?: number;
  heightSource?: 'declared' | 'normalized-import' | 'legacy-estimate';
  heightApproximate?: boolean;
  /** Declared standing height before object/scene transforms. */
  heightMetres?: number;
  /** Where it stands before any route plays. */
  position: DirectorVec3;
  /** Degrees; 0 faces +Z, 90 faces +X. */
  yaw: number;
  /** The rig's own action, played when no route point overrides it. */
  action: string | null;
  clips: DirectorStructureClip[];
  crowdId?: string;
}

export interface DirectorCameraSubject {
  objectId: string;
  bodyPart: string;
}

export interface DirectorStructureCamera {
  microMotion?: DirectorCameraMicroMotionSettings;
  id: string;
  name: string;
  fov: number;
  filmGate?: {widthMm:number;heightMm:number};
  aspect?: number;
  focalLengthMm?: number;
  roll?: number;
  /** End of camera motion on the scene clock, or the default duration for a static camera. */
  seconds: number;
  keyframeCount: number;
  /** Editable camera-motion ranges; source points outside a trim are retained. */
  clips: Array<DirectorStructureClip & {microMotion?:DirectorCameraMicroMotionSettings; composition?: {x:number;y:number}; compositionOverrides?: number}>;
  active: boolean;
  /** What the lens sees at the start of the shot. */
  view: { position: DirectorVec3; target: DirectorVec3 };
  composition?: {x:number;y:number};
  /** What it tracks at the start, if anything. */
  subject: DirectorCameraSubject | null;
  /** Every object it tracks at any point of the shot. */
  subjects: DirectorCameraSubject[];
}

export interface DirectorStructureResponse {
  kind: 'structure';
  version: number;
  source: DirectorQuerySourceEcho;
  timeline: { seconds: number; activeCameraId: string | null; loop: boolean; loopRange?: { start: number; end: number } };
  scene: { collision: boolean; groundHeight: number; lighting?:{ambient:number;color:string} };
  objects: DirectorStructureObject[];
  cameras: DirectorStructureCamera[];
  /** Shared with the desk UI; versions and contribution metadata identify the recipe. */
  cameraPresets?: Array<{ id: string; label: string; description: string; duration: number; group: 'official' | 'community'; suitableFor: string; version: string;
    contribution?: { contributorName: string | null; contact: string | null; sourceUrl: string | null; license: string } }>;

  /** Ordered takes: source range is scene time, start/end is the derived cut sequence. */
  shots: Array<{ id: string; name: string; cameraId: string; sourceIn: number; sourceOut: number; start: number; end: number; duration: number; locked?: boolean }>;
  /** Placeable model references, including unused assets. Older daemons may omit this list. */
  assets?: Array<{ contentSha256?: string; resourceVersion?: number; modelFormat?: string; id: string; name: string; fileName: string; kind: string; instances: string[]; characterHeightMetres?: number; modelCalibration?: DirectorModelCalibration; modelBounds?: DirectorModelBounds; modelSize?: [number, number, number]; scaleMode: "physical" | "legacy-fit" | "character" | "builtin" }>;
  /** Buildings and other scene models in the project. */
  spaces: Array<{ id: string; name: string; fileName: string }>;
}

/* ── sample ───────────────────────────────────────────────────────────────── */

export type DirectorFraming = 'full' | 'partial' | 'out';

export interface DirectorFramedObject {
  objectId: string;
  name: string;
  framing: DirectorFraming;
  /** Frame position, -1..1 on each axis, left→right and bottom→top; null when behind the lens. */
  screen: [number, number] | null;
  /** Metres from the lens along its axis. */
  distance: number | null;
}

export interface DirectorSampleObject {
  id: string;
  name: string;
  kind: 'character' | 'prop' | 'scene' | 'panorama' | 'light';
  light?:DirectorLightSettings;
  direction?:[number,number,number];
  position: DirectorVec3;
  yaw: number;
  action: string | null;
  moving: boolean;
  /** Metres per second. */
  speed: number;
  /** Index of the route point being held at, when holding. */
  holding: number | null;
  clipId: string | null;
  look?: DirectorLookSample | null;
  /** Character performance clock, independent of world travel. Optional for older daemons. */
  performance?: {
    /** Route-facing suppresses animation yaw; manual orientation retains animated turns. */
    headingSource: 'route' | 'animation';
    actionClipId: string | null;
    source: 'clip' | 'route' | 'locomotion' | 'base';
    /** Fully sampled lower and override layers; head aiming is applied afterwards. */
    layers?: Array<{actionPresetId:string|null;actionClipId:string|null;source:'clip'|'route'|'locomotion'|'base';animationTimeSeconds:number;loop:boolean;holdingPointIndex:number|null;weight:number}>;
    /** Seconds into the retained animation source; native cycle duration is model-dependent. */
    animationTimeSeconds: number;
    loop: boolean;
  };
}

export interface DirectorSampleCamera {
  microMotion?: {settings:DirectorCameraMicroMotionSettings;scope:'camera'|'clip';seconds:number};
  id: string;
  name: string;
  /** 0–1 through this camera's own motion path; scene time continues past its end. */
  progress: number;
  /** Whether the motion path has ended, not whether the scene has ended. */
  ended: boolean;
  position: DirectorVec3;
  target: DirectorVec3;
  fov: number;
  /** The actual aspect used for this camera, before fitting into a sequence output. */
  aspect: number;
  filmGate?: {widthMm:number;heightMm:number};
  focalLengthMm?: number;
  roll?: number;
  /** Requested anchor cannot be reached without roll at this elevation. */
  compositionClamped?: boolean;
  subject: DirectorCameraSubject | null;
  /** Left to right as they appear; objects behind the lens last. */
  framing: DirectorFramedObject[];
}

export interface DirectorSampleFrame {
  t: number;
  objects: DirectorSampleObject[];
  cameras: DirectorSampleCamera[];
}

export interface DirectorSampleResponse {
  kind: 'sample';
  source: DirectorQuerySourceEcho;
  aspect: number;
  frames: DirectorSampleFrame[];
}

/* ── diagnostics ──────────────────────────────────────────────────────────── */

export type DirectorFindingCode =
  | 'event-unresolved'
  | 'composition-unreachable'
  | 'subject-out-of-frame'
  /** A character is in the frame but their head is not. */
  | 'subject-head-cut'
  | 'axis-crossed'
  | 'route-blocked'
  | 'arrives-late'
  | 'route-after-shot'
  | 'screen-order';

export interface DirectorFinding {
  code: DirectorFindingCode;
  severity: 'warning' | 'info';
  cameraId?: string;
  cameraIds?: string[];
  objectId?: string;
  objectIds?: string[];
  /** Scene seconds the finding spans, when it is about a stretch of time. */
  from?: number;
  to?: number;
  message: string;
}

export interface DirectorDiagnosticsResponse {
  kind: 'diagnostics';
  source: DirectorQuerySourceEcho;
  step: number;
  aspect: number;
  cameraIds: string[];
  findings: DirectorFinding[];
  summary: { warnings: number; infos: number };
}

export type DirectorQueryResponse = DirectorActionsResponse | DirectorStructureResponse | DirectorSampleResponse | DirectorDiagnosticsResponse | DirectorEventsResponse;

/** Head aiming intent. Exact bone pose is rendered in the desk, not inferred by the daemon. */
export type DirectorLookTarget = {kind:'point';position:DirectorVec3}|{kind:'object';objectId:string;bodyPart:'head'|'center'};
export interface DirectorLookClip { id:string;name?:string;start:number;end:number;target:DirectorLookTarget;
 source:{duration:number;in:number;out:number};blendIn:number;blendOut:number;strength:number;muted?:boolean }
export interface DirectorLookSample {clipId:string;target:DirectorVec3|null;weight:number;approximate:boolean;issue:'self-target'|'missing-target'|null}
