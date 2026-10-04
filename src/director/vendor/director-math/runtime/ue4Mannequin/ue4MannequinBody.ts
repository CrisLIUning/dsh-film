// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { CharacterBodyType } from "../mannequin/bodyTypes.js";

/**
 * The UE4 mannequin's body metrics, and nothing else.
 *
 * `ue4MannequinRig` builds the model URL from `import.meta.env` at module
 * load, which makes it a Vite module — importable in the desk, fatal anywhere
 * else. The camera-target math only needs to know how tall each body type
 * stands, so that lives here, where the daemon's vendored motion math can
 * reach it. The rig re-exports both, so nothing in the desk moved.
 */

export function getUE4ModelScale(bodyType?: CharacterBodyType): [number, number, number] {
  switch (bodyType) {
    case "teen":
      return [0.88, 0.88, 0.88];
    case "child":
      return [0.72, 0.72, 0.72];
    case "chibi":
      return [0.56, 0.56, 0.56];
    default:
      return [1, 1, 1];
  }
}

export function getUE4GroundedLabelY(bodyType?: CharacterBodyType): number {
  switch (bodyType) {
    case "female":
    case "slim":
      return 1.98;
    case "broad":
    case "muscular":
      return 2.08;
    case "teen":
      return 1.78;
    case "child":
      return 1.46;
    case "chibi":
      return 1.18;
    default:
      return 2.04;
  }
}
