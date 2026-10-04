// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { ModelBounds, ModelCalibration } from "./modelCalibration.js";
import type { SpatialProfile } from "./spatialProfile.js";
import type {
  DirectorCharacterBoneMap,
  DirectorCameraTargetBodyPart,
  DirectorCameraTargetFollowMode,
} from "./semanticBody.js";

export type ViewMode = "director" | "camera";
export type RightPanelKind = "scene" | "character" | "prop" | "camera" | "light";
export type DirectorObjectKind = "character" | "scene" | "prop" | "camera" | "panorama" | "light";
export const GEOMETRY_PRIMITIVE_OPTIONS = [
  { type: "box", label: "立方体" },
  { type: "sphere", label: "球体" },
  { type: "cylinder", label: "圆柱体" },
  { type: "torus", label: "环状体" },
  { type: "cone", label: "圆锥" },
  { type: "pyramid", label: "棱锥" },
] as const;
export type GeometryPrimitiveType = (typeof GEOMETRY_PRIMITIVE_OPTIONS)[number]["type"];
export type CharacterRigType = "mannequin" | "ue4-mannequin" | "mixamo" | "vrm" | "custom-humanoid";
export type CharacterBodyType =
  | "mannequin"
  | "female"
  | "broad"
  | "muscular"
  | "slim"
  | "teen"
  | "child"
  | "chibi";
export type DirectorAssetKind = "character" | "scene" | "prop" | "panorama";
export type DirectorAssetSource = "local" | "library";
export type PanoramaProjectionMode = "equirectangular" | "backdrop";
export type DirectorModelFormat = "fbx" | "obj" | "glb";
export type GroundMaterialPresetId = "studio" | "concrete" | "asphalt" | "wood" | "grass";
export type CharacterRigProfile = "mixamo" | "mixamo-alt" | "bip" | "cc-base" | "generic-humanoid" | "unknown";
export type CharacterImportReadiness = "ready" | "native-only" | "manual-mapping" | "static-only";

export interface DirectorTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface SceneSettings {
  lighting?: import("./sceneLighting").SceneLightingSettings;
  scale: number;
  position: [number, number, number];
  rotation: [number, number, number];
  backgroundColor: string;
  backgroundBrightness: number;
  panoramaYaw: number;
  panoramaRadius: number;
  showLabels: boolean;
  snapToGrid: boolean;
  showGrid: boolean;
  showGround: boolean;
  groundMaterialPreset: GroundMaterialPresetId;
  /** Multiplier for the world-space size of each ground texture tile. */
  groundTextureScale: number;
  groundColor: string;
  groundBrightness: number;
  groundOpacity: number;
  groundHeight: number;
  pathCollisionEnabled: boolean;
}

export interface CharacterRigState {
  rigType: CharacterRigType;
  posePresetId: string | null;
  actionPresetId?: string | null;
  controls: Record<string, number>;
}

export interface DirectorAssetRef {
  contentSha256?: string;
  resourceVersion?: number;
  characterHeightMetres?: number;
  modelCalibration?: ModelCalibration;
  modelBounds?: ModelBounds;
  id: string;
  kind: DirectorAssetKind;
  sourceType: "model" | "image";
  fileName: string;
  name?: string;
  url: string;
  assetSource?: DirectorAssetSource;
  projectionMode?: PanoramaProjectionMode;
  modelFormat?: DirectorModelFormat;
  storageKey?: string;
  byteLength?: number;
  characterRigProfile?: CharacterRigProfile;
  characterImportReadiness?: CharacterImportReadiness;
  characterOrientationCorrection?: [number, number, number];
  characterBoneMap?: DirectorCharacterBoneMap;
}

export interface DirectorAnimationClipRef {
  id: string;
  name: string;
  duration: number;
  trackCount: number;
}

export interface DirectorAnimationAssetRef {
  contentSha256?: string;
  resourceVersion?: number;
  id: string;
  name: string;
  fileName: string;
  url: string;
  modelFormat: Extract<DirectorModelFormat, "fbx" | "glb">;
  storageKey?: string;
  byteLength?: number;
  rigProfile: CharacterRigProfile;
  sourceCharacterAssetId?: string;
  clips: DirectorAnimationClipRef[];
}

/** Head orientation overlays the sampled full-body pose; it never owns travel. */
export type DirectorCharacterLookTarget =
  | { kind: "point"; position: [number, number, number] }
  | { kind: "object"; objectId: string; bodyPart: "head" | "center" };
export interface DirectorCharacterLookClip {
  id: string;
  name?: string;
  start: number;
  end: number;
  target: DirectorCharacterLookTarget;
  source: { duration: number; in: number; out: number };
  /** Fades are measured on the retained source clock, so splitting does not restart a turn. */
  blendIn: number;
  blendOut: number;
  strength: number;
  muted?: boolean;
}

/** Independent full-body performance. Route transforms remain the only source of travel. */
export interface DirectorCharacterActionClip {
  id: string;
  name?: string;
  start: number;
  end: number;
  actionId: string | null;
  source: { duration: number; in: number; out: number };
  loop?: boolean;
  muted?: boolean;
  /** Base performances sit below the existing full-body override track. */
  layer?: "base" | "override";
  /** Freeze the animation clock without freezing the editable clip/envelope clock. */
  freezeAt?: number;
  /** Preserve legacy automatic walk/base-pose selection at route boundaries. */
  automaticLocomotion?: boolean;
  /** Legacy holds depart at the endpoint; ordinary clips retain their final frame. */
  endExclusive?: boolean;
  /** Fade envelope in retained source-clock seconds; zero/absent keeps a hard cut. */
  blendIn?: number;
  blendOut?: number;
}

export interface DirectorObject {
  light?: import("./sceneLighting").DirectorLight;
  /** Authored spatial proxies in calibrated object-local metres. */
  spatial?: SpatialProfile;
  /** Source model calibration changed after the proxies were authored. */
  spatialNeedsReview?: boolean;
  /** Explicit standing reference height, metres before instance transforms. */
  heightMetres?: number;
  id: string;
  name: string;
  kind: DirectorObjectKind;
  visible: boolean;
  locked: boolean;
  transform: DirectorTransform;
  bodyType?: CharacterBodyType;
  color?: string;
  assetRefId?: string;
  geometryType?: GeometryPrimitiveType;
  crowdId?: string;
  crowdLabel?: string;
  linkedCameraId?: string | null;
  characterRig?: CharacterRigState;
  /** The object's route on the scene timeline, in seconds. See objectMotion.ts. */
  motionClips?: DirectorObjectMotionClip[];
  actionClips?: DirectorCharacterActionClip[];
  lookClips?: DirectorCharacterLookClip[];
}

export interface DirectorObjectMotionKeyframe {
  id: string;
  /** Seconds from the clip's start. (Version 1: 0–1 of the active camera's shot.) */
  time: number;
  transform: DirectorTransform;
  /** Character action played from this route point until the next point. */
  actionPresetId?: string | null;
  /** Path-facing turns toward the next route point; manual keeps the point rotation. */
  facingMode?: "path" | "manual";
  /** Pass-through keeps moving; hold pauses at this point for holdSeconds. */
  pointBehavior?: DirectorRoutePointBehavior;
  holdSeconds?: number;
  /** Character pose/action used while this point is holding. */
  holdAction?: DirectorRouteHoldAction;
  holdActionPresetId?: string | null;
}

/**
 * A version-1 route. Its keyframes were timed 0–1 against whichever camera was
 * playing, so the same walk changed length with the shot. Kept so the
 * migration can read it; nothing writes it.
 */
export interface DirectorObjectMotionPath {
  interpolation: CameraMotionInterpolation;
  speedMode?: DirectorRouteSpeedMode;
  customEasing?: DirectorRouteCubicBezier;
  keyframes: DirectorObjectMotionKeyframe[];
}

/**
 * A span of an object's route on the scene timeline.
 *
 * `start` and `end` are scene seconds; each keyframe's `time` is seconds from
 * `start` unless `source` retains an original route clock. Between clips the object stands where the previous one left it.
 * The pacing (`speedMode`, `customEasing`, `interpolation`) belongs to the
 * clip, so one walk can be uniform and the next eased.
 */
export interface DirectorMotionClipSource {
  /** Original route duration and retained in/out, all in source seconds. */
  duration: number;
  in: number;
  out: number;
  /** Original scene start, preserving the phase of legacy absolute-clock actions. */
  origin: number;
}

export interface DirectorObjectMotionClip {
  id: string;
  name?: string;
  start: number;
  end: number;
  source?: DirectorMotionClipSource;
  interpolation: CameraMotionInterpolation;
  speedMode?: DirectorRouteSpeedMode;
  customEasing?: DirectorRouteCubicBezier;
  keyframes: DirectorObjectMotionKeyframe[];
}

export interface DirectorCameraCapture {
  id: string;
  index: number;
  name: string;
  /**
   * The bytes, while the desk is open.
   *
   * A screenshot is a megabyte-scale PNG, and the whole project — captures
   * included — used to be written into localStorage on every edit. Browser
   * storage is shared by every desk on one origin, so a handful of them filled
   * the quota and the desk silently stopped saving anything. The bytes now live
   * in IndexedDB under `storageKey` and are read back into this field when the
   * scene loads, which is why it can be briefly absent.
   */
  dataUrl?: string;
  /** Where the bytes are kept. Absent on a capture taken where IndexedDB is
   *  unavailable — that one keeps its bytes inline, as they all used to. */
  storageKey?: string;
}

export type CameraMotionInterpolation = "linear" | "smooth";
export type CameraMotionEasing = "linear" | "ease-in-out";
export type DirectorRouteSpeedMode = "uniform" | "soft" | "custom";
export type DirectorRoutePointBehavior = "pass" | "hold";
export type DirectorRouteHoldAction = "stand" | "current" | "custom" | "track";
export type DirectorRouteCubicBezier = [number, number, number, number];

/** Screen position of the target: left/top 0, right/bottom 1. */
export interface DirectorCameraComposition { x: number; y: number; }

/** Effective film gate after cropping, in millimetres. FOV remains the single
 * stored projection value; focal length is derived from its vertical extent. */
export interface DirectorCameraFilmGate { widthMm: number; heightMm: number; }

export interface DirectorCameraMotionKeyframe {
  /** Degrees about the lens axis; positive rotates the image clockwise. */
  roll?: number;
  composition?: DirectorCameraComposition;
  id: string;
  time: number;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** Each waypoint may independently aim at a moving scene subject. */
  targetMode?: "manual" | "object";
  targetObjectId?: string | null;
  /** Semantic animated body part used when the target is a character. */
  targetBodyPart?: DirectorCameraTargetBodyPart;
  /** Immediate follows exactly; smooth applies temporal damping in each render view. */
  targetFollowMode?: DirectorCameraTargetFollowMode;
  /** Suppresses high-frequency body animation shake while retaining subject movement. */
  targetStabilizationEnabled?: boolean;
  /** Pass-through keeps moving; hold pauses at this point for holdSeconds. */
  pointBehavior?: DirectorRoutePointBehavior;
  holdSeconds?: number;
}

export interface DirectorCameraMotionPath {
  /** Overrides camera-wide settings; enabled:false explicitly disables them. */
  microMotion?: import('./cameraMicroMotion').CameraMicroMotionSettings;
  roll?: number;
  composition?: DirectorCameraComposition;
  /** Provenance only; changing parameters never regenerates an applied route. */
  preset?: { id: string; version: string };
  duration: number;
  loop: boolean;
  interpolation: CameraMotionInterpolation;
  easing: CameraMotionEasing;
  speedMode?: DirectorRouteSpeedMode;
  customEasing?: DirectorRouteCubicBezier;
  keyframes: DirectorCameraMotionKeyframe[];
}

export interface DirectorCameraShot {
  microMotion?: import('./cameraMicroMotion').CameraMicroMotionSettings;
  filmGate?: DirectorCameraFilmGate;
  roll?: number;
  composition?: DirectorCameraComposition;
  id: string;
  name: string;
  /** Internal camera created for the beginner motion workflow. It has no scene helper object. */
  isVirtual?: boolean;
  fov: number;
  transform: DirectorTransform;
  targetMode: "manual" | "object";
  targetObjectId?: string | null;
  target: [number, number, number];
  lastCaptureUrl?: string | null;
  captures?: DirectorCameraCapture[];
  motionPath?: DirectorCameraMotionPath;
}

/** A retained camera curve played over a scene-time window. */
export interface DirectorCameraMotionClip {
  id: string;
  name?: string;
  start: number;
  end: number;
  path: DirectorCameraMotionPath;
  source: DirectorMotionClipSource;
}
export type CameraMotionDefaults = Omit<DirectorCameraMotionPath, "keyframes" | "preset" | "microMotion">;
/** Persisted v6 camera. DirectorCameraShot remains the legacy/derived curve view. */
export interface DirectorCameraWithMotionClips extends Omit<DirectorCameraShot, "motionPath"> {
  motionClips: DirectorCameraMotionClip[];
  motionDefaults: CameraMotionDefaults;
}

/** A non-destructive take from a camera at scene seconds. Array order is edit order. */
export interface DirectorShotClip {
  id: string;
  name: string;
  cameraId: string;
  sourceIn: number;
  sourceOut: number;
  locked?: boolean;
}

export interface DirectorRouteEventAnchor {
  objectId:string; clipId:string; keyframeId:string;
  edge:'arrival'|'departure'; offset?:number;
}
/** Named performance beats can follow a planned route point or a fixed scene second. */
export interface DirectorSceneEvent {id:string;name:string;at:number|DirectorRouteEventAnchor}

export interface DirectorProject {
  /** Bumped when the saved shape changes meaning; see directorProjectMigration.ts. */
  version: 15;
  shots: DirectorShotClip[];
  /** Primary scene clock in seconds, independent of monitoring camera. */
  timeline: { duration: number; loop?: boolean; loopRange?: { start: number; end: number }; events?: DirectorSceneEvent[] };
  scene: SceneSettings;
  assets: DirectorAssetRef[];
  animationAssets?: DirectorAnimationAssetRef[];
  objects: DirectorObject[];
  cameras: DirectorCameraWithMotionClips[];
  activeCameraId: string | null;
  panoramaAssetId: string | null;
}
