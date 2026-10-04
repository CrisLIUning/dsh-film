/** Small director scenes built the way the desk saves them. Ported from Studio's apps/daemon/tests/director-fixtures.ts (paths only; async diagnostics awaited). */
import { migrateCameraMotionTrack, cameraForMotionClip } from '../../src/director/vendor/director-math/schema/cameraMotionClips.js';
import { getCameraMotionPath } from '../../src/director/vendor/director-math/schema/cameraMotion.js';
// Small scenes for the query-layer specs, built the way the desk would save
// them. Cameras are placed by where the LENS should be: the desk stores the
// rig, which sits behind the lens, so a spec that says "camera at (0, 1.5, 5)"
// gets exactly that view.
import type {
  DirectorCameraShot,
  DirectorCameraWithMotionClips,
  DirectorObject,
  DirectorObjectMotionClip,
  DirectorProject,
  SceneSettings,
} from '../../src/director/vendor/director-math/schema/directorProject.js';
import { getCameraRigPositionFromViewSnapshot } from '../../src/director/vendor/director-math/schema/cameraGeometry.js';

export type Vec3 = [number, number, number];

export const SCENE: SceneSettings = {
  scale: 1,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  backgroundColor: '#000000',
  backgroundBrightness: 1,
  panoramaYaw: 0,
  panoramaRadius: 50,
  showLabels: true,
  snapToGrid: false,
  showGrid: true,
  showGround: true,
  groundMaterialPreset: 'studio',
  groundTextureScale: 1,
  groundColor: '#333333',
  groundBrightness: 1,
  groundOpacity: 1,
  groundHeight: 0,
  pathCollisionEnabled: true,
};

export function transform(position: Vec3, rotation: Vec3 = [0, 0, 0], scale: Vec3 = [1, 1, 1]) {
  return { position, rotation, scale };
}

export function character(id: string, position: Vec3, extra: Partial<DirectorObject> = {}): DirectorObject {
  return {
    id,
    name: id,
    kind: 'character',
    visible: true,
    locked: false,
    bodyType: 'mannequin',
    transform: transform(position),
    characterRig: { rigType: 'ue4-mannequin', posePresetId: 'stand', controls: {} },
    ...extra,
  };
}

export function prop(id: string, position: Vec3, scale: Vec3, extra: Partial<DirectorObject> = {}): DirectorObject {
  return {
    id,
    name: id,
    kind: 'prop',
    visible: true,
    locked: false,
    geometryType: 'box',
    transform: transform(position, [0, 0, 0], scale),
    ...extra,
  };
}

/** A straight walk from `from` to `to` filling [start, end], uniform pace. */
export function walk(id: string, start: number, end: number, from: Vec3, to: Vec3, extra: Partial<DirectorObjectMotionClip> = {}): DirectorObjectMotionClip {
  return {
    id,
    start,
    end,
    interpolation: 'linear',
    speedMode: 'uniform',
    keyframes: [
      { id: `${id}_a`, time: 0, transform: transform(from), actionPresetId: 'walk-cycle', facingMode: 'path' },
      { id: `${id}_b`, time: end - start, transform: transform(to), facingMode: 'path' },
    ],
    ...extra,
  };
}

/** A locked-off camera whose lens sits at `lens`, looking at `target`. */
export function lockedCamera(id: string, lens: Vec3, target: Vec3, fov = 50, extra: Partial<DirectorCameraShot> = {}): DirectorCameraShot {
  return {
    id,
    name: id,
    fov,
    transform: transform(getCameraRigPositionFromViewSnapshot({ fov, position: lens, target })),
    targetMode: 'manual',
    target,
    ...extra,
  };
}

export function project(objects: DirectorObject[], cameras: DirectorCameraShot[], scene: Partial<SceneSettings> = {}): DirectorProject {
  return {
    version:15,
    shots: [],
    timeline: { duration: Math.max(6, ...objects.flatMap(object => (object.motionClips ?? []).map(clip => clip.end)), ...cameras.map(camera => (camera.motionPath?.keyframes.length ?? 0) >= 2 ? camera.motionPath!.duration : 0)) },
    scene: { ...SCENE, ...scene },
    assets: [],
    animationAssets: [],
    objects,
    cameras: cameras.map(migrateCameraMotionTrack),
    activeCameraId: cameras[0]?.id ?? null,
    panoramaAssetId: null,
  };
}

export function cameraPath(camera: DirectorCameraWithMotionClips) {
  return getCameraMotionPath(cameraForMotionClip(camera, camera.motionClips[0] ?? null));
}
