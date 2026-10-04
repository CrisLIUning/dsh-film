/**
 * A director scene as the query layer sees it: upgraded, its objects sampled
 * at a moment, its cameras as shots. Ported from Studio's
 * apps/daemon/src/director/scene.ts (unchanged but for import paths).
 * @module dsh-film/director/scene
 */

import { cameraFrameAspect } from './vendor/director-math/schema/cameraOptics.js';
import { cameraForMotionClip, resolveCameraMotionClip } from './vendor/director-math/schema/cameraMotionClips.js';
import { sampleCharacterAction, type CharacterActionSample } from './vendor/director-math/schema/characterPerformance.js';
// The scene as the query layer sees it: a project brought to the current
// version, its objects sampled at a moment, its cameras as shots. Everything
// here is the desk's own vendored math; this file only decides what to ask it.
import type {
  DirectorCameraWithMotionClips as DirectorCameraShot,
  DirectorObject,
  DirectorProject,
  DirectorTransform,
  SceneSettings,
} from './vendor/director-math/schema/directorProject.js';
import {
  isAnyVersionDirectorProjectShape,
  upgradeDirectorProject,
} from './vendor/director-math/schema/directorProjectMigration.js';
import {
  getCameraMotionActiveKeyframeIndex,
  getCameraMotionPath,
} from './vendor/director-math/schema/cameraMotion.js';
import { getCameraTemporalPlaybackAtSeconds } from './vendor/director-math/schema/cameraTemporalPlayback.js';
import { approximateBodyPartFocus } from './framing.js';
import { isCameraFocusableObject } from './vendor/director-math/schema/cameraTarget.js';
import {
  findObjectMotionClipIndexAt,
  getObjectMotionClips,
  hasObjectMotion,
  OBJECT_MOTION_MOVING_SPEED,
} from './vendor/director-math/schema/objectMotion.js';
import { getConstrainedObjectMotionSnapshot, getConstrainedObjectMotionSpeed, getObjectRouteCollision } from './vendor/director-math/schema/routeCollision.js';
import { normalizeDirectorCameraTargetBodyPart } from './vendor/director-math/schema/semanticBody.js';
import type { DirectorCameraSubject } from './contracts/index.js';

import type { CameraView } from './framing.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A desk project from whatever was handed over: a bare project of any version
 * the desk can upgrade, or the envelope its `project.get` and its export
 * documents wrap one in. Null when it is neither.
 */
export function resolveDirectorProject(value: unknown): DirectorProject | null {
  const candidate = isRecord(value) && !isAnyVersionDirectorProjectShape(value) && isRecord(value.project)
    ? value.project
    : value;
  return isAnyVersionDirectorProjectShape(candidate) ? upgradeDirectorProject(candidate) : null;
}

function finite(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Scene settings with the fields the math reads guaranteed to be numbers. A
 * project saved by an older desk can lack `groundHeight`, and the collision
 * pass would put a character at `undefined`.
 */
export function normalizeQueryScene(scene: SceneSettings | undefined): SceneSettings {
  const source = (scene ?? {}) as Partial<SceneSettings>;
  return {
    ...(source as SceneSettings),
    groundHeight: finite(source.groundHeight, 0),
    pathCollisionEnabled: source.pathCollisionEnabled === true,
  };
}

export interface QueryScene {
  project: DirectorProject;
  scene: SceneSettings;
  /** Everything that is not a camera's helper object, in project order. */
  objects: DirectorObject[];
  cameras: DirectorCameraShot[];
}

export function openQueryScene(project: DirectorProject): QueryScene {
  return {
    project,
    scene: normalizeQueryScene(project.scene),
    objects: project.objects.filter((object) => object.kind !== 'camera'),
    cameras: project.cameras,
  };
}

export interface SampledObject {
  object: DirectorObject;
  /** Where it is at the moment, after the desk's collision pass. */
  transform: DirectorTransform;
  /** Metres per second; zero for an object with no route. */
  speed: number;
  moving: boolean;
  /** The runtime's full-body action after track, route and base-pose priority. */
  action: string | null;
  performance: CharacterActionSample;
  holding: number | null;
  clipId: string | null;
}

/** Every object at a scene time, the way the desk would draw it. */
export function sampleObjectsAt(scene: QueryScene, seconds: number): SampledObject[] {
  return scene.objects.map((object) => {
    const routed = hasObjectMotion(object);
    const transform = getConstrainedObjectMotionSnapshot(object,seconds,scene.scene,scene.project.objects);
    const blocked = scene.scene.pathCollisionEnabled && getObjectRouteCollision(object,seconds,scene.scene,scene.project.objects);
    const speed = routed && !blocked ? getConstrainedObjectMotionSpeed(object, seconds, scene.scene, scene.project.objects) : 0;
    const moving = routed && speed > OBJECT_MOTION_MOVING_SPEED;
    const sample = sampleCharacterAction(object, seconds);
    const action = sample.actionPresetId;
    const clips = getObjectMotionClips(object);
    const clipIndex = findObjectMotionClipIndexAt(clips, seconds);
    return {
      object,
      transform,
      speed,
      moving,
      action,
      performance: sample,
      holding: sample.holdingPointIndex,
      clipId: clipIndex >= 0 ? clips[clipIndex]!.id : null,
    };
  });
}

/** Objects a lens can be pointed at: characters and props, not buildings or the sky. */
export function isFramableObject(object: DirectorObject) {
  return isCameraFocusableObject(object) && object.kind !== 'scene';
}

export interface CameraMoment {
  camera: DirectorCameraShot;
  seconds: number;
  progress: number;
  ended: boolean;
  view: CameraView;
  aspect: number;
  subject: DirectorCameraSubject | null;
}

export function shotSeconds(camera: DirectorCameraShot) {
  return camera.motionClips.length ? camera.motionClips[camera.motionClips.length - 1]!.end : camera.motionDefaults.duration;
}

/** What a camera tracks at a point of its shot, if anything. */
export function cameraSubjectAt(track: DirectorCameraShot, seconds: number): DirectorCameraSubject | null {
  const sample = resolveCameraMotionClip(track, seconds);
  const camera = cameraForMotionClip(track, sample.clip);
  const progress = sample.progress;
  const path = getCameraMotionPath(camera);
  if (path.keyframes.length === 0) {
    return camera.targetMode === 'object' && camera.targetObjectId
      ? { objectId: camera.targetObjectId, bodyPart: 'center' }
      : null;
  }
  const index = Math.max(0, getCameraMotionActiveKeyframeIndex(camera, progress));
  const keyframe = path.keyframes[index];
  return keyframe?.targetMode === 'object' && keyframe.targetObjectId
    ? { objectId: keyframe.targetObjectId, bodyPart: normalizeDirectorCameraTargetBodyPart(keyframe.targetBodyPart) }
    : null;
}

/** Everything a camera tracks over its whole shot, each object once. */
export function cameraSubjects(camera: DirectorCameraShot): DirectorCameraSubject[] {
  const keys = camera.motionClips.flatMap(clip => clip.path.keyframes);
  const seen = new Map<string, DirectorCameraSubject>();
  const add = (subject: DirectorCameraSubject | null) => {
    if (subject && !seen.has(subject.objectId)) seen.set(subject.objectId, subject);
  };
  if (!camera.motionClips.length || camera.motionClips[0]!.start > 0) add(camera.targetMode === "object" && camera.targetObjectId ? { objectId: camera.targetObjectId, bodyPart: "center" } : null);
  for (const keyframe of keys) {
    add(keyframe.targetMode === 'object' && keyframe.targetObjectId
      ? { objectId: keyframe.targetObjectId, bodyPart: normalizeDirectorCameraTargetBodyPart(keyframe.targetBodyPart) }
      : null);
  }
  return [...seen.values()];
}

/**
 * A camera at a scene time. The active clip resolves the lens source clock;
 * gaps and the end hold the previous lens while tracking follows scene time.
 */
export function cameraMomentAt(scene: QueryScene, camera: DirectorCameraShot, seconds: number, aspect = cameraFrameAspect(camera)): CameraMoment {
  const duration = shotSeconds(camera);
  const progress = Math.min(1, Math.max(0, duration > 0 ? seconds / duration : 0));
  const snapshot = getCameraTemporalPlaybackAtSeconds(camera, scene.project.objects, seconds, scene.scene, approximateBodyPartFocus, aspect);
  return {
    camera,
    seconds: duration,
    progress,
    ended: seconds > duration + 1e-9,
    view: snapshot,
    aspect,
    subject: cameraSubjectAt(camera, seconds),
  };
}

/** Degrees in (-180, 180]; 0 faces +Z, 90 faces +X — the desk's yaw. */
export function yawDegrees(rotation: [number, number, number]) {
  let degrees = (rotation[1] * 180) / Math.PI;
  degrees = ((degrees + 180) % 360 + 360) % 360 - 180;
  return degrees === -180 ? 180 : Number(degrees.toFixed(3));
}
