// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type {
  DirectorCameraComposition,
  DirectorCameraShot,
} from "./directorProject.js";
import type { CameraMotionSnapshot } from "./cameraMotion.js";
import {
  getCameraMotionPath,
  getCameraMotionTimingSample,
} from "./cameraMotion.js";

export function normalizeCameraComposition(
  value: unknown,
): DirectorCameraComposition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y } = value as DirectorCameraComposition;
  return Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    x <= 1 &&
    y >= 0 &&
    y <= 1
    ? { x, y }
    : undefined;
}

/** A source point inherits the clip composition, then the static camera's. */
export function sampleCameraComposition(
  camera: DirectorCameraShot,
  progress: number,
): DirectorCameraComposition | undefined {
  const path = getCameraMotionPath(camera),
    keys = path.keyframes;
  const fallback = path.composition ?? camera.composition;
  if (!keys.length) return fallback;
  const at = (index: number) => keys[index].composition ?? fallback;
  if (keys.length === 1 || progress <= keys[0].time) return at(0);
  if (progress >= keys[keys.length - 1].time) return at(keys.length - 1);
  const timing = getCameraMotionTimingSample(camera, progress);
  const index = timing?.segment ?? 0;
  const a = at(index),
    b = at(index + 1);
  if (!a && !b) return undefined;
  const t = timing?.local ?? 0;
  return {
    x: (a?.x ?? 0.5) + ((b?.x ?? 0.5) - (a?.x ?? 0.5)) * t,
    y: (a?.y ?? 0.5) + ((b?.y ?? 0.5) - (a?.y ?? 0.5)) * t,
  };
}

/** Rotate the lens, preserving roll and position, so its subject projects onto
 * the requested screen anchor. x runs left→right, y top→bottom. Near a pole,
 * a horizontal offset may be impossible without roll; flag the closest view. */
export function composeCameraView(
  view: CameraMotionSnapshot,
  anchor: DirectorCameraComposition | undefined,
  aspect = 16 / 9,
): CameraMotionSnapshot {
  if (!anchor || (anchor.x === 0.5 && anchor.y === 0.5)) return view;
  const offset = view.target.map((v, i) => v - view.position[i]);
  const distance = Math.hypot(...offset);
  if (distance < 1e-9) return { ...view, compositionClamped: true };
  const tan = Math.tan((view.fov * Math.PI) / 360);
  const screenX = (anchor.x * 2 - 1) * tan * aspect,
    screenY = (1 - anchor.y * 2) * tan;
  const roll = (view.roll ?? 0) * Math.PI / 180;
  // Solve in the unrolled frame, then the renderer applies the authored roll.
  const u = screenX * Math.cos(roll) - screenY * Math.sin(roll),
    v = screenX * Math.sin(roll) + screenY * Math.cos(roll);
  const elevation = offset[1] / distance;
  const sine =
    (elevation * Math.sqrt(1 + u * u + v * v)) / Math.sqrt(1 + v * v);
  const pitch = Math.asin(Math.max(-1, Math.min(1, sine))) - Math.atan(v);
  const limit = Math.PI / 2 - 1e-6;
  const beta = Math.max(-limit, Math.min(limit, pitch));
  const alpha =
    Math.atan2(offset[0], offset[2]) +
    Math.atan2(u, Math.cos(beta) - v * Math.sin(beta));
  const forward = [
    Math.sin(alpha) * Math.cos(beta),
    Math.sin(beta),
    Math.cos(alpha) * Math.cos(beta),
  ];
  return {
    ...view,
    target: forward.map((v, i) => view.position[i] + v * distance) as [
      number,
      number,
      number,
    ],
    ...(Math.abs(sine) > 1 || pitch !== beta
      ? { compositionClamped: true }
      : {}),
  };
}
