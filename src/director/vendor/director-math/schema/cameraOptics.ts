// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorCameraFilmGate } from './directorProject.js';

export const DEFAULT_CAMERA_FILM_GATE: DirectorCameraFilmGate = { widthMm: 36, heightMm: 20.25 };

export function validateFilmGate(gate: DirectorCameraFilmGate): void {
  if (!gate || !Number.isFinite(gate.widthMm) || !Number.isFinite(gate.heightMm)
    || gate.widthMm <= 0 || gate.heightMm <= 0 || gate.widthMm / gate.heightMm < .1 || gate.widthMm / gate.heightMm > 10)
    throw new Error('有效画幅需要正数毫米尺寸，宽高比须在 1:10–10:1 之间');
}
export function validateCameraRoll(roll: number): void {
  if (!Number.isFinite(roll) || roll < -180 || roll > 180) throw new Error('横滚角须在 -180°–180° 之间');
}
export function validateCameraFov(fov: number): void {
  if (!Number.isFinite(fov) || fov < 10 || fov > 120) throw new Error('垂直 FOV 须在 10°–120° 之间');
}
export function focalLengthFromFov(fov: number, gate: DirectorCameraFilmGate): number {
  validateFilmGate(gate); validateCameraFov(fov);
  return gate.heightMm / (2 * Math.tan(fov * Math.PI / 360));
}
export function fovFromFocalLength(focalLengthMm: number, gate: DirectorCameraFilmGate): number {
  validateFilmGate(gate);
  if (!Number.isFinite(focalLengthMm) || focalLengthMm <= 0) throw new Error('焦距必须是正数毫米值');
  const fov = 2 * Math.atan(gate.heightMm / (2 * focalLengthMm)) * 180 / Math.PI;
  validateCameraFov(fov);
  return fov;
}
/** Explicit query/preview aspect wins; otherwise a saved gate wins over window
 * dimensions. Legacy cameras keep the caller's fallback. */
export function cameraFrameAspect(camera: {filmGate?: DirectorCameraFilmGate}, fallback = 16 / 9, override?: number): number {
  return override ?? (camera.filmGate ? camera.filmGate.widthMm / camera.filmGate.heightMm : fallback);
}
