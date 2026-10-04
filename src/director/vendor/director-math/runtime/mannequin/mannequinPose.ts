// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { CharacterBodyType } from "./bodyTypes.js";
import { normalizeBodyType } from "./bodyTypes.js";

export function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function getBodyTypePoseLimit(bodyType?: string | null): number {
  switch (normalizeBodyType(bodyType)) {
    case "chibi":
      return 58;
    case "child":
      return 72;
    default:
      return 90;
  }
}

export function getRotationFromControls(
  controls: Record<string, number>,
  prefix: string,
  bodyType?: CharacterBodyType
): [number, number, number] {
  const limit = getBodyTypePoseLimit(bodyType);

  return [
    degreesToRadians(clamp(controls[`${prefix}.pitch`] ?? 0, -limit, limit)),
    degreesToRadians(clamp(controls[`${prefix}.yaw`] ?? 0, -limit, limit)),
    degreesToRadians(clamp(controls[`${prefix}.roll`] ?? 0, -limit, limit)),
  ];
}

export function getSingleAxisRotation(
  controls: Record<string, number>,
  key: string,
  bodyType?: CharacterBodyType
): [number, number, number] {
  const limit = getBodyTypePoseLimit(bodyType);
  return [degreesToRadians(clamp(controls[key] ?? 0, -limit, limit)), 0, 0];
}
