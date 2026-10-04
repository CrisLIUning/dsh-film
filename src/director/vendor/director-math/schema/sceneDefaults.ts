// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorProject, GroundMaterialPresetId, SceneSettings } from "./directorProject.js";
import { DIRECTOR_PROJECT_VERSION } from "./directorProjectMigration.js";

/**
 * What a scene looks like before anyone touches it.
 *
 * Kept out of the store so the daemon's vendored copy can start a scene that
 * looks exactly like one the desk started: same ground, same background, same
 * collision setting. A scene an agent lays out should not be recognisable as
 * "the agent's" by its floor colour.
 */
export const DEFAULT_SCENE_SETTINGS: SceneSettings = {
  scale: 1,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  backgroundColor: "#000000",
  backgroundBrightness: 1,
  panoramaYaw: 0,
  panoramaRadius: 60,
  showLabels: true,
  snapToGrid: false,
  showGrid: true,
  showGround: true,
  groundMaterialPreset: "studio" as GroundMaterialPresetId,
  groundTextureScale: 1,
  groundColor: "#303640",
  groundBrightness: 1,
  groundOpacity: 0.4,
  groundHeight: 0,
  pathCollisionEnabled: false,
};

/** A scene with nothing in it — where an agent starts when a node has never been opened as a desk. */
export function createEmptyDirectorProject(): DirectorProject {
  return {
    version: DIRECTOR_PROJECT_VERSION,
    shots: [],
    timeline: { duration: 6 },
    scene: { ...DEFAULT_SCENE_SETTINGS },
    assets: [],
    animationAssets: [],
    objects: [],
    cameras: [],
    activeCameraId: null,
    panoramaAssetId: null,
  };
}
