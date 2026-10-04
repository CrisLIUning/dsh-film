// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { validateSceneLighting } from "./sceneLighting.js";
import { validateCharacterHeight } from "./characterSizing.js";
import { validateSpatialProfile } from "./spatialProfile.js";
import { canCalibrateModel, validateModelBounds, validateModelCalibration } from "./modelCalibration.js";
import { migrateCharacterActionSemantics } from "./characterNativeActions.js";
import { validateCharacterLookClips } from "./characterLook.js";
import { validateCharacterActionClips } from './characterPerformance.js';
import { migrateCameraMotionTrack } from './cameraMotionClips.js';
import { validateShot } from "./shotSequence.js";
import { ensureSceneTimeline, setSceneTime } from "./sceneTime.js";
import type {
  DirectorCameraShot,
  DirectorObject,
  DirectorObjectMotionClip,
  DirectorObjectMotionPath,
  DirectorProject,
} from "./directorProject.js";
import { getTimelineDurationSeconds } from "./cameraMotion.js";
import { migrateObjectMotionPath, normalizeObjectMotionClips } from "./objectMotion.js";

/**
 * Project versions and how an older one becomes the current one.
 *
 * Version 2 gave object routes their own time. A version-1 project kept each
 * route as one `motionPath` timed 0–1 against the active camera's shot, so it
 * stretched to fit whichever camera was playing. It becomes one clip spanning
 * exactly the seconds it was being stretched over when it was saved — which
 * is why a migrated project plays back the same frames it did.
 * Version 3 stores a scene clock independent of monitoring. Migration retains
 * the former active camera duration and loop, extending only to include content.
 * Camera and object arrival times stay unchanged in seconds.
 * Version 4 adds ordered camera takes referencing source scene seconds. Legacy
 * cameras retain full-scene takes; existing motion and scene time are unchanged.
 * Version 5 retains a source clock/window for nondestructive route edits;
 * old clips have an implicit full source and preserve their existing samples.
 * Version 7 makes mismatched imported-character preset mappings explicit legacy
 * actions. Old source clocks and rendered clips survive; new presets use their
 * actual semantic animation, or report that no compatible source exists.
 * Version 15 adds optional scene lighting and selectable light objects.
 * Existing projects retain their legacy world-space lighting until adoption.
 * Version 14 adds optional camera/clip micro-motion. Missing settings preserve
 * the existing view; no noise or presets are assigned while migrating.
 * Version 13 adds opt-in film gates and source-clock camera roll. Missing
 * settings preserve legacy projection and the world horizon.
 * Version 12 adds floor ramps and stair treads. Existing flat floors and routes
 * without these explicit surfaces retain their prior sampling.
 * Version 11 adds optional authored spatial proxies and review state. Older
 * projects keep their collision samples; no mesh topology is inferred.
 * Version 10 adds explicit standing heights without rescaling legacy characters.
 * Version 9 records explicit static-model units, orientation and anchors. Missing
 * calibration retains the old 2 m fit; existing geometry never changes on load.
 * Version 8 adds an explicit base action layer and frozen animation sampling.
 * Legacy holds remain untouched until the user extracts them. A `track` hold
 * retains route timing while yielding performance ownership to the action track.
 */

export const DIRECTOR_PROJECT_VERSION = 15 as const;

export interface DirectorObjectV1 extends Omit<DirectorObject, "motionClips"> {
  motionPath?: DirectorObjectMotionPath;
}

/** The shape a desk before the clip model saved. */
export interface DirectorProjectV1 extends Omit<DirectorProject, "version" | "objects" | "timeline" | "shots" | "cameras"> {
  version: 1;
  cameras: DirectorCameraShot[];
  objects: DirectorObjectV1[];
}

export interface DirectorProjectV2 extends Omit<DirectorProject, "version" | "timeline" | "shots" | "cameras"> { version: 2; cameras: DirectorCameraShot[]; }
export interface DirectorProjectV3 extends Omit<DirectorProject, "version" | "shots" | "cameras"> { version: 3; cameras: DirectorCameraShot[]; }
export interface DirectorProjectV4 extends Omit<DirectorProject, "version" | "cameras"> { version: 4; cameras: DirectorCameraShot[]; }
export interface DirectorProjectV5 extends Omit<DirectorProject, "version" | "cameras"> { version: 5; cameras: DirectorCameraShot[]; }
export interface DirectorProjectV6 extends Omit<DirectorProject, "version"> { version: 6; }
export interface DirectorProjectV7 extends Omit<DirectorProject, "version"> { version: 7; }
export interface DirectorProjectV8 extends Omit<DirectorProject, "version"> { version: 8; }
export interface DirectorProjectV9 extends Omit<DirectorProject, "version"> { version: 9; }
export interface DirectorProjectV10 extends Omit<DirectorProject, "version"> { version: 10; }
export interface DirectorProjectV11 extends Omit<DirectorProject, "version"> { version: 11; }
export interface DirectorProjectV12 extends Omit<DirectorProject, "version"> { version: 12; }
export interface DirectorProjectV13 extends Omit<DirectorProject, "version"> { version: 13; }
export interface DirectorProjectV14 extends Omit<DirectorProject, "version"> { version: 14; }
export type AnyVersionDirectorProject = DirectorProjectV1 | DirectorProjectV2 | DirectorProjectV3 | DirectorProjectV4 | DirectorProjectV5 | DirectorProjectV6 | DirectorProjectV7 | DirectorProjectV8 | DirectorProjectV9 | DirectorProjectV10 | DirectorProjectV11 | DirectorProjectV12 | DirectorProjectV13 | DirectorProjectV14 | DirectorProject;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A project this desk can open: the current version or one it knows how to bring forward. */
export function isAnyVersionDirectorProjectShape(value: unknown): value is AnyVersionDirectorProject {
  if (!isRecord(value)) return false;
  return (value.version === 1 || value.version === 2 || value.version === 3 || value.version === 4 || value.version === 5 || value.version === 6 || value.version === 7 || value.version === 8 || value.version === 9 || value.version === 10 || value.version === 11 || value.version === 12 || value.version === 13 || value.version === 14 || value.version === DIRECTOR_PROJECT_VERSION)
    && isRecord(value.scene)
    && typeof value.scene.backgroundColor === "string"
    && Array.isArray(value.assets)
    && Array.isArray(value.objects)
    && Array.isArray(value.cameras);
}

function upgradeObject(
  object: DirectorObjectV1 | DirectorObject,
  timelineSeconds: number,
): DirectorObject {
  const { motionPath, motionClips: rawClips, ...rest } = object as DirectorObjectV1 & { motionClips?: unknown };
  const clips: DirectorObjectMotionClip[] = normalizeObjectMotionClips(rawClips, rest.transform);
  // A `motionPath` is a v1 route wherever it turns up, including on an object
  // inside a project that already calls itself version 2: it can only have
  // been written by a desk that timed routes against the camera.
  const migrated = motionPath
    ? migrateObjectMotionPath(motionPath, rest.transform, timelineSeconds, `${rest.id}_clip_${clips.length + 1}`)
    : null;
  if (migrated) clips.push(migrated);
  if (rest.heightMetres !== undefined) validateCharacterHeight(rest.heightMetres);
  if (rest.spatial !== undefined) {
    validateSpatialProfile(rest.spatial);
    if (!["scene", "prop"].includes(rest.kind)) throw new Error("只有场景和静态道具可含空间标注");
  }
  validateCharacterActionClips(rest.actionClips);
  validateCharacterLookClips(rest.lookClips);
  const upgraded: DirectorObject = { ...rest };
  if (clips.length > 0) upgraded.motionClips = clips.sort((a, b) => a.start - b.start);
  return upgraded;
}

/** The current shape of a project of any known version. Does not mutate its input. */
export function upgradeDirectorProject(project: AnyVersionDirectorProject): DirectorProject {
  validateSceneLighting(project);
  project.assets.forEach(asset => {
    if (asset.characterHeightMetres !== undefined) validateCharacterHeight(asset.characterHeightMetres);
    if (asset.modelCalibration !== undefined) {
      validateModelCalibration(asset.modelCalibration);
      if (!canCalibrateModel(asset) || project.objects.some(o => o.assetRefId === asset.id && o.kind === "character")) throw new Error("静态模型校正不能用于人物骨架或内置形体");
    }
    if (asset.modelBounds !== undefined) validateModelBounds(asset.modelBounds);
  });
  const timelineSeconds = 'timeline' in project ? project.timeline.duration : getTimelineDurationSeconds(project.cameras, project.activeCameraId);
  const upgraded = ensureSceneTimeline({
    ...project,
    version: DIRECTOR_PROJECT_VERSION,
    cameras: project.cameras.map(migrateCameraMotionTrack),
    objects: project.objects.map((object) => {
      const upgraded = upgradeObject(object, timelineSeconds);
      return project.version < 7 ? migrateCharacterActionSemantics(upgraded, project.assets.find(a => a.id === object.assetRefId)) : upgraded;
    }),
    ...(project.version < 3 ? { timeline: { duration: timelineSeconds, loop: (project.cameras.find(camera => camera.id === project.activeCameraId) as DirectorCameraShot | undefined ?? project.cameras[0] as DirectorCameraShot | undefined)?.motionPath?.loop ?? false } } : {}),
  });
  // Existing cameras used to be the only addressable shots. Preserve their full
  // scene takes on migration; new cameras do not automatically join the edit.
  const shots = 'shots' in project ? project.shots : upgraded.cameras.map((camera, index) => ({
    id: `shot_legacy_${index + 1}`, name: camera.name, cameraId: camera.id, sourceIn: 0, sourceOut: upgraded.timeline.duration,
  }));
  if (!Array.isArray(shots)) throw new Error("工程镜头列表格式无效");
  const result = { ...upgraded, shots };
  const ids = new Set<string>();
  for (const shot of shots) {
    validateShot(result, shot);
    if (ids.has(shot.id)) throw new Error(`镜头 ID 重复：${shot.id}`);
    ids.add(shot.id);
  }
  return setSceneTime(result, {});
}
