/**
 * What a lens can see: screen projection and in-frame tests for characters
 * and props. Ported from Studio's apps/daemon/src/director/framing.ts
 * (unchanged but for import paths).
 * @module dsh-film/director/framing
 */

// What a lens can see. The desk's cameras are three.js perspective cameras:
// `fov` is the vertical field of view in degrees and the frame is `aspect`
// times as wide as it is tall. A point is in frame when it lies inside that
// pyramid in front of the lens; a character is fully in frame when its feet,
// its middle and its head all are.
import type { CameraObjectFocusResolver } from './vendor/director-math/schema/cameraTarget.js';
import type { DirectorObject, DirectorTransform } from './vendor/director-math/schema/directorProject.js';
import type { Vec3 } from './vendor/director-math/schema/vec3.js';
import { cameraFrameBasis, dot } from './vendor/director-math/schema/cameraFrameBasis.js';
import { characterStandingSize } from './vendor/director-math/schema/characterSizing.js';
import { getDirectorObjectFocusTarget } from './vendor/director-math/schema/cameraTarget.js';
import type { DirectorFraming } from './contracts/index.js';

export interface CameraView {
  position: Vec3;
  target: Vec3;
  fov: number;
  roll?: number;
  compositionClamped?: boolean;
}

export interface ScreenPoint {
  /** -1..1, left to right. */
  x: number;
  /** -1..1, bottom to top. */
  y: number;
  /** Metres along the lens axis. */
  depth: number;
}

/** Reference standing height in scene coordinates; current pose and occlusion are separate. */
export function characterHeight(object: DirectorObject): number {
  return characterStandingSize(object).height * Math.abs(object.transform.scale[1]);
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

interface FrameBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  tanHalfV: number;
  tanHalfH: number;
}

function frameBasis(view: CameraView, aspect: number): FrameBasis {
  const { forward, right, up } = cameraFrameBasis(view);
  const tanHalfV = Math.tan((view.fov * Math.PI) / 360);
  return { forward, right, up, tanHalfV, tanHalfH: tanHalfV * aspect };
}

/** Where a point lands in the frame, or null when it is behind the lens. */
export function projectToScreen(view: CameraView, aspect: number, point: Vec3): ScreenPoint | null {
  const basis = frameBasis(view, aspect);
  const offset = sub(point, view.position);
  const depth = dot(offset, basis.forward);
  if (depth <= 1e-6) return null;
  return {
    x: dot(offset, basis.right) / depth / basis.tanHalfH,
    y: dot(offset, basis.up) / depth / basis.tanHalfV,
    depth,
  };
}

export function isInsideFrame(point: ScreenPoint | null): point is ScreenPoint {
  return Boolean(point) && Math.abs(point!.x) <= 1 && Math.abs(point!.y) <= 1;
}

export interface FramingResult {
  framing: DirectorFraming;
  /** The object's middle in the frame; null when that is behind the lens. */
  screen: [number, number] | null;
  distance: number | null;
  /** A character's head: in the frame or not. A frame that has the body and not the head is the one a director rejects first. */
  head?: 'in' | 'out';
}

/**
 * Where the desk aims when it tracks a part: the rig's joint, as a fraction
 * of standing height. Measured on the UE4 mannequin — the head joint sits at
 * the base of the skull, the chest at the upper spine, the waist at the
 * pelvis — and the fallback body is drawn to the same proportions.
 */
export const BODY_PART_HEIGHT: Record<'head' | 'chest' | 'waist', number> = { head: 0.88, chest: 0.74, waist: 0.52 };

/**
 * The desk resolves a tracked part from the character's rig. The daemon has
 * no rig, so it aims where the joint would be; without this every tracked
 * part collapsed to the body's centre and a close-up was sampled as if it
 * framed the waist.
 */
export const approximateBodyPartFocus: CameraObjectFocusResolver = (object, bodyPart) => {
  if (object.kind !== 'character' || bodyPart === 'center') return null;
  const fraction = (BODY_PART_HEIGHT as Record<string, number | undefined>)[bodyPart];
  if (fraction === undefined) return null;
  const feet = object.transform.position;
  return [feet[0], feet[1] + fraction * characterHeight(object), feet[2]];
};

/**
 * The points that have to be in frame for an object to count as fully in it:
 * a character's feet, middle and head; a prop's middle. Positions come from
 * the moment being asked about, not the object's resting transform.
 */
export function framingPoints(object: DirectorObject, transform: DirectorTransform): { middle: Vec3; points: Vec3[] } {
  const posed = { ...object, transform };
  const middle = getDirectorObjectFocusTarget(posed);
  if (object.kind !== 'character') return { middle, points: [middle] };
  const feet = transform.position;
  const head: Vec3 = [feet[0], feet[1] + characterHeight(object), feet[2]];
  return { middle, points: [feet, middle, head] };
}

export function frameObject(view: CameraView, aspect: number, object: DirectorObject, transform: DirectorTransform): FramingResult {
  const { middle, points } = framingPoints(object, transform);
  const projected = points.map((point) => projectToScreen(view, aspect, point));
  const inside = projected.filter(isInsideFrame).length;
  const centre = projectToScreen(view, aspect, middle);
  const head = object.kind === 'character' ? (isInsideFrame(projected[projected.length - 1] ?? null) ? 'in' : 'out') : undefined;
  return {
    framing: inside === points.length ? 'full' : inside > 0 ? 'partial' : 'out',
    screen: centre ? [round(centre.x), round(centre.y)] : null,
    distance: centre ? round(centre.depth) : null,
    ...(head ? { head } : {}),
  };
}

function round(value: number) {
  return Number(value.toFixed(4));
}
