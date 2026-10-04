// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { Vec3 } from './vec3.js';

export interface CameraTrackingFilterInput {
  seconds: number;
  /** Earliest retained history. Render playback resets this at the clip start. */
  startSeconds: number;
  /** Response in inverse seconds. Existing smooth/stabilized modes use 6 / 2.4. */
  response: number;
  /** Must sample the target at the requested scene second, including its pose.
   * A callback reading the currently rendered skeleton is NOT sufficient. */
  sampleTarget: (seconds: number) => Vec3;
}

/** Deterministic causal damping. Integrates linearly reconstructed target
 * samples analytically, with a bounded eight-time-constant history. A held
 * target before the retained interval defines the initial condition. There is
 * no dependence on frame rate, seek order, wall clock or a previous view.
 *
 * The fixed 1/120 s source grid permits pose caches across neighbouring queries;
 * the final partial cell is integrated at the exact requested time. At response
 * 2.4 at most 402 target samples are needed even after seeking into a long shot.
 * Runtime users must cache immutable pose samples, not accumulated filter state.
 */
export function sampleCameraTrackingFilter({ seconds, startSeconds, response, sampleTarget }: CameraTrackingFilterInput): Vec3 {
  if (!Number.isFinite(seconds) || !Number.isFinite(startSeconds) || !Number.isSafeInteger(Math.ceil(seconds * 120)) || startSeconds < 0 || seconds < startSeconds)
    throw new Error('镜头跟随采样需要有效场景秒和起点');
  if (!Number.isFinite(response) || response < 2.4 || response > 120)
    throw new Error('镜头跟随响应必须在 2.4–120 之间');
  const step = 1 / 120;
  const first = Math.max(startSeconds, Math.floor((seconds - 8 / response) / step) * step);
  const sample = (at: number): Vec3 => {
    const value = sampleTarget(at);
    if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite))
      throw new Error('镜头跟随目标坐标无效');
    return [...value];
  };
  let time = first, previous = sample(first), result = [...previous] as Vec3;
  // Integer grid indices avoid accumulating floating-point clock error.
  for (let index = Math.floor(first / step) + 1; time < seconds; index++) {
    const nextTime = Math.min(seconds, index * step);
    if (nextTime <= time) continue;
    const next = sample(nextTime), delta = nextTime - time;
    const decay = Math.exp(-response * delta);
    const gain = -Math.expm1(-response * delta);
    // Exact solution of y'=response*(x-y) for a linear x over this interval.
    const ramp = delta - gain / response;
    result = result.map((value, axis) => value * decay + previous[axis] * gain
      + (next[axis] - previous[axis]) / delta * ramp) as Vec3;
    previous = next; time = nextTime;
  }
  return result;
}
