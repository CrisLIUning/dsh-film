// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { sampleStroke, type StrokePace } from "./strokeSampling.js";
import type { DirectorObject, DirectorObjectMotionClip, DirectorObjectMotionKeyframe } from "./directorProject.js";
import { MIN_OBJECT_MOTION_CLIP_SECONDS } from "./objectMotion.js";

export interface RouteStrokeSample {
  position: [number, number, number];
  /** Seconds since the stroke began. */
  time: number;
}

/** A stroke shorter than this is a click, not a route. */
export const MIN_ROUTE_STROKE_METRES = 0.3;

function distance(a: [number, number, number], b: [number, number, number]) {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function heading(from: [number, number, number], to: [number, number, number]) {
  return Math.atan2(to[0] - from[0], to[2] - from[2]);
}

/** The length of a stroke along the ground, metres. */
export function routeStrokeLength(samples: RouteStrokeSample[]) {
  let total = 0;
  for (let index = 1; index < samples.length; index += 1) total += distance(samples[index - 1].position, samples[index].position);
  return total;
}

export interface CreateClipFromRouteStrokeOptions {
  id: string;
  object: Pick<DirectorObject, "kind" | "transform">;
  samples: RouteStrokeSample[];
  /** Scene seconds the clip begins at. */
  start: number;
  /** Total drawn duration divided by this rate. */
  speed?: number;
  pace?: StrokePace;
  duration?: number;
}

/** New strokes default to uniform distance timing. Existing clips are untouched. */
export function createClipFromRouteStroke({
  id,
  object,
  samples,
  start,
  speed = 1,
  pace = "uniform",
  duration,
}: CreateClipFromRouteStrokeOptions): DirectorObjectMotionClip | null {
  const points = sampleStroke(samples, pace);
  if (points.length < 2 || routeStrokeLength(points) < MIN_ROUTE_STROKE_METRES) return null;
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const origin = points[0].time;
  const length = Math.max(MIN_OBJECT_MOTION_CLIP_SECONDS, duration ?? (points[points.length - 1].time - origin) / rate);
  const distances = points.map((_, index) => routeStrokeLength(points.slice(0, index + 1)));
  const totalDistance = distances[distances.length - 1];
  const isCharacter = object.kind === "character";
  const yawAt = (index: number) => {
    const from = points[Math.max(0, index - 1)].position;
    const to = points[Math.min(points.length - 1, index + 1)].position;
    const current = points[index].position;
    const target = index === points.length - 1 ? current : to;
    const source = index === points.length - 1 ? from : current;
    return distance(source, target) > 1e-6 ? heading(source, target) : object.transform.rotation[1];
  };
  const keyframes: DirectorObjectMotionKeyframe[] = points.map((point, index) => ({
    id: `${id}_p${index + 1}`,
    time: length * (pace === "drawn" ? (point.time - origin) / (points[points.length - 1].time - origin || 1) : distances[index] / totalDistance),
    transform: {
      position: [...point.position] as [number, number, number],
      rotation: [object.transform.rotation[0], isCharacter ? yawAt(index) : object.transform.rotation[1], object.transform.rotation[2]],
      scale: [...object.transform.scale] as [number, number, number],
    },
    actionPresetId: index < points.length - 1 && isCharacter ? "walk-cycle" : null,
    facingMode: isCharacter ? "path" : "manual",
    pointBehavior: "pass",
    holdSeconds: 0,
    holdAction: "current",
    holdActionPresetId: null,
  }));
  keyframes[keyframes.length - 1] = { ...keyframes[keyframes.length - 1], time: length };
  return {
    id,
    start: Math.max(0, start),
    end: Math.max(0, start) + length,
    interpolation: "linear",
    speedMode: pace === "drawn" ? "custom" : "uniform",
    customEasing: [0, 0, 1, 1],
    keyframes,
  };
}
