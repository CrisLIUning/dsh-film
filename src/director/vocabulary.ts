/**
 * The shot vocabulary (sizes, angles, sides, over-the-shoulder) turned into
 * lens positions. Ported from Studio's apps/daemon/src/director/vocabulary.ts
 * (unchanged but for import paths).
 * @module dsh-film/director/vocabulary
 */

// The shot vocabulary: what a director says, turned into where a lens goes.
//
// An agent does not write camera coordinates. It says "a medium close-up of
// 甲 from her front-left, at eye level", or "over 乙's shoulder onto 甲", and
// this turns that into the position, target and field of view the desk draws
// — including the part nobody gets right by hand: the desk stores a camera's
// RIG, which sits VIEWPORT_CAMERA_FRUSTUM_DEPTH behind the lens, while a
// motion keyframe stores the lens itself.
import type { DirectorObject, DirectorTransform } from './vendor/director-math/schema/directorProject.js';
import { getCameraRigPositionFromViewSnapshot } from './vendor/director-math/schema/cameraGeometry.js';
import type { Vec3 } from './vendor/director-math/schema/vec3.js';
import type { DirectorShotAngle, DirectorShotSide, DirectorShotSize } from './contracts/index.js';

import { getDirectorObjectFocusTarget } from './vendor/director-math/schema/cameraTarget.js';
import { BODY_PART_HEIGHT, characterHeight, type CameraView } from './framing.js';

/**
 * How much of a standing character each size shows, as fractions of their
 * height: the span from `low` to `high` fills the frame vertically. Numbers
 * are the usual cutting points — full shot with headroom, knees, waist,
 * chest, shoulders, face — not anything the desk defines.
 */
export const SHOT_SIZES: Record<DirectorShotSize, { low: number; high: number; label: string; bodyPart: string }> = {
  'extreme-wide': { low: -2.6, high: 3.4, label: '大远景', bodyPart: 'center' },
  wide: { low: -0.9, high: 2.1, label: '远景', bodyPart: 'center' },
  full: { low: -0.08, high: 1.12, label: '全景', bodyPart: 'center' },
  'medium-full': { low: 0.28, high: 1.1, label: '中全景', bodyPart: 'center' },
  medium: { low: 0.55, high: 1.09, label: '中景', bodyPart: 'chest' },
  'medium-close': { low: 0.72, high: 1.07, label: '中近景', bodyPart: 'chest' },
  close: { low: 0.82, high: 1.05, label: '近景', bodyPart: 'head' },
  'extreme-close': { low: 0.88, high: 1.01, label: '特写', bodyPart: 'head' },
};

export const SHOT_SIZE_IDS = Object.keys(SHOT_SIZES) as DirectorShotSize[];

/** Pitch in degrees; negative looks down. */
export const SHOT_ANGLES: Record<DirectorShotAngle, { pitch: number; label: string }> = {
  eye: { pitch: 0, label: '平视' },
  high: { pitch: -22, label: '俯拍' },
  low: { pitch: 16, label: '仰拍' },
  top: { pitch: -62, label: '顶拍' },
};

/** Where the camera stands, as a turn away from the subject's facing. */
export const SHOT_SIDES: Record<DirectorShotSide, { turn: number; label: string }> = {
  front: { turn: 0, label: '正面' },
  'three-quarter-left': { turn: 45, label: '左前侧' },
  'three-quarter-right': { turn: -45, label: '右前侧' },
  left: { turn: 90, label: '左侧' },
  right: { turn: -90, label: '右侧' },
  'back-left': { turn: 135, label: '左后侧' },
  'back-right': { turn: -135, label: '右后侧' },
  back: { turn: 180, label: '背面' },
};

export const DEFAULT_SHOT_FOV = 40;
/** The frame an over-the-shoulder composes for; the desk's viewport aspect. */
const OVER_SHOULDER_ASPECT = 16 / 9;

/** What the subject's body part is called when the camera tracks this size. */
export function trackedBodyPartFor(size: DirectorShotSize) {
  return SHOT_SIZES[size].bodyPart;
}

export interface ShotSpec {
  size: DirectorShotSize;
  angle?: DirectorShotAngle;
  side?: DirectorShotSide;
  fov?: number;
  /** Extra metres between lens and subject, on top of what the size implies. */
  distance?: number;
  /** Whether the camera will follow the subject (the default). A locked-off shot frames the size's span exactly. */
  tracked?: boolean;
}

export type TrackableBodyPart = 'center' | keyof typeof BODY_PART_HEIGHT;

/**
 * How a tracked camera frames a size.
 *
 * Tracking aims the lens at a joint of the rig, so that joint is the middle
 * of the frame whatever the size wanted there. The frame is widened just
 * enough for the size's whole span to fit around the joint, and the joint is
 * the one needing the least widening: the head for the tight sizes, the
 * chest for a medium-full, the body's centre for the wide ones — kept
 * whenever it is within a tenth of the best, since it follows a walk with
 * the least bob. Aiming a medium close-up at the chest joint, as the size's
 * own middle would suggest, put the head outside the frame.
 */
export function trackedFraming(
  size: DirectorShotSize,
  standingHeight: number,
  centreHeight: number,
): { bodyPart: TrackableBodyPart; centreHeight: number; spanMetres: number } {
  const span = SHOT_SIZES[size];
  const fits = (fraction: number) => 2 * Math.max(span.high - fraction, fraction - span.low) * standingHeight;
  const candidates = (['center', 'head', 'chest', 'waist'] as const).map((bodyPart) => {
    const centre = bodyPart === 'center' ? centreHeight : BODY_PART_HEIGHT[bodyPart] * standingHeight;
    return { bodyPart, centre, span: fits(centre / standingHeight) };
  });
  const best = candidates.reduce((winner, candidate) => (candidate.span < winner.span ? candidate : winner));
  const centre = candidates[0]!;
  const chosen = centre.span <= best.span * 1.1 ? centre : best;
  return { bodyPart: chosen.bodyPart, centreHeight: chosen.centre, spanMetres: chosen.span };
}

export interface ResolvedShot {
  view: CameraView;
  /** Where the desk stores the camera: the rig, behind the lens. */
  rig: Vec3;
  /** Lens-to-subject distance the size worked out to, metres. */
  distance: number;
  bodyPart: string;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** The desk's yaw: 0 faces +Z, 90° faces +X. */
function facingVector(yawRadians: number): Vec3 {
  return [Math.sin(yawRadians), 0, Math.cos(yawRadians)];
}

function rotateYaw(vector: Vec3, degrees: number): Vec3 {
  const r = toRadians(degrees);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // A positive turn goes counter-clockwise seen from above, from +Z toward +X:
  // the same sense as the desk's yaw.
  return [vector[0] * cos + vector[2] * sin, vector[1], -vector[0] * sin + vector[2] * cos];
}

function round(value: number) {
  return Number(value.toFixed(4));
}

/**
 * How far a lens has to be for a vertical span to fill the frame. Frame
 * height at distance d is 2·d·tan(fov/2); solve for d.
 */
export function distanceForSpan(spanMetres: number, fov: number) {
  return spanMetres / 2 / Math.tan(toRadians(fov) / 2);
}

/**
 * A shot of one subject: the lens is placed on the subject's `side`, tilted
 * to the `angle`, far enough away that the size's body span fills the frame,
 * looking at the middle of that span.
 */
export function resolveShot(subject: DirectorObject, transform: DirectorTransform, spec: ShotSpec): ResolvedShot {
  const size = SHOT_SIZES[spec.size];
  const height = subject.kind === 'character' ? characterHeight({ ...subject, transform }) : Math.max(0.5, transform.scale[1]);
  const fov = spec.fov ?? DEFAULT_SHOT_FOV;
  const locked = { bodyPart: size.bodyPart as TrackableBodyPart, centreHeight: ((size.high + size.low) / 2) * height, spanMetres: (size.high - size.low) * height };
  const framing = (spec.tracked ?? true) && subject.kind === 'character'
    ? trackedFraming(spec.size, height, getDirectorObjectFocusTarget({ ...subject, transform })[1] - transform.position[1])
    : locked;
  const centreHeight = framing.centreHeight;
  const target: Vec3 = [transform.position[0], transform.position[1] + centreHeight, transform.position[2]];

  const facing = facingVector(transform.rotation[1]);
  const towardCamera = rotateYaw(facing, SHOT_SIDES[spec.side ?? 'front'].turn);
  const pitch = toRadians(SHOT_ANGLES[spec.angle ?? 'eye'].pitch);
  // At pitch p, a point y metres above the target has camera-space height
  // y*cos(p) and depth d+y*sin(p). Fit both requested endpoints against the
  // perspective frustum, not a plane at target depth: on a high shot the
  // head is closer to the lens and needs extra room. At eye level this is
  // exactly the previous span formula. An explicit distance remains a dolly
  // offset; neither the requested pitch nor the FOV changes to hide a crop.
  const tanHalfFov = Math.tan(toRadians(fov) / 2);
  const fittedDistance = Math.max(...[size.low, size.high].map(fraction => {
    const y = fraction * height - centreHeight;
    return Math.abs(y * Math.cos(pitch)) / tanHalfFov - y * Math.sin(pitch);
  }));
  const distance = fittedDistance + (spec.distance ?? 0);
  // Camera sits `distance` from the target along the chosen side, then rises
  // (or drops) for the angle while keeping the same distance to the target.
  const horizontal = distance * Math.cos(pitch);
  const rise = -distance * Math.sin(pitch);
  const position: Vec3 = [
    target[0] + towardCamera[0] * horizontal,
    target[1] + rise,
    target[2] + towardCamera[2] * horizontal,
  ];
  const view: CameraView = { position: position.map(round) as Vec3, target: target.map(round) as Vec3, fov };
  return {
    view,
    rig: getCameraRigPositionFromViewSnapshot(view),
    distance: round(distance),
    bodyPart: framing.bodyPart,
  };
}

export interface OverShoulderSpec extends ShotSpec {
  /** Which side of the frame the foreground shoulder sits on. */
  shoulder?: 'left' | 'right';
}

/**
 * Over one character's shoulder onto another. The lens goes behind the
 * foreground character, off to one side, at their shoulder height, and looks
 * at the subject at the size asked for. With the shoulder on frame-left the
 * lens stands behind the foreground's RIGHT shoulder — behind your right
 * shoulder, you are to my left.
 */
export function resolveOverShoulder(
  subject: DirectorObject,
  subjectTransform: DirectorTransform,
  foreground: DirectorObject,
  foregroundTransform: DirectorTransform,
  spec: OverShoulderSpec,
): ResolvedShot {
  const size = SHOT_SIZES[spec.size];
  const subjectHeight = subject.kind === 'character' ? characterHeight({ ...subject, transform: subjectTransform }) : Math.max(0.5, subjectTransform.scale[1]);
  const foregroundHeight = foreground.kind === 'character' ? characterHeight({ ...foreground, transform: foregroundTransform }) : Math.max(0.5, foregroundTransform.scale[1]);
  const fov = spec.fov ?? DEFAULT_SHOT_FOV;
  const spanMetres = (size.high - size.low) * subjectHeight;
  const distance = distanceForSpan(spanMetres, fov) + (spec.distance ?? 0);
  const target: Vec3 = [
    subjectTransform.position[0],
    subjectTransform.position[1] + ((size.high + size.low) / 2) * subjectHeight,
    subjectTransform.position[2],
  ];

  // The line from the foreground to the subject is the axis the lens sits
  // behind; sideways is perpendicular to it on the ground.
  const dx = subjectTransform.position[0] - foregroundTransform.position[0];
  const dz = subjectTransform.position[2] - foregroundTransform.position[2];
  const span = Math.hypot(dx, dz) || 1;
  const along: Vec3 = [dx / span, 0, dz / span];
  const leftOfAxis: Vec3 = [along[2], 0, -along[0]];
  const shoulderSide = spec.shoulder ?? 'left';
  const sideways = shoulderSide === 'left' ? [-leftOfAxis[0], 0, -leftOfAxis[2]] as Vec3 : leftOfAxis;
  // Behind the foreground by a third of the lens distance, but never inside them.
  const behind = Math.max(0.6, distance - span);
  const sideOffset = 0.35 + foregroundHeight * 0.12;
  const shoulderHeight = foregroundTransform.position[1] + foregroundHeight * 0.86;
  const position: Vec3 = [
    foregroundTransform.position[0] - along[0] * behind + sideways[0] * sideOffset,
    shoulderHeight,
    foregroundTransform.position[2] - along[2] * behind + sideways[2] * sideOffset,
  ];
  // Aimed past the subject, away from the shoulder, so the subject sits on
  // the opposite third of the frame rather than dead centre with the shoulder
  // crowding it. A third of the half-width, at the subject's distance.
  const lensDistance = Math.hypot(target[0] - position[0], target[1] - position[1], target[2] - position[2]);
  const thirdOffset = lensDistance * Math.tan(toRadians(fov) / 2) * OVER_SHOULDER_ASPECT * 0.33;
  const aim: Vec3 = [target[0] - sideways[0] * thirdOffset, target[1], target[2] - sideways[2] * thirdOffset];
  const view: CameraView = { position: position.map(round) as Vec3, target: aim.map(round) as Vec3, fov };
  return {
    view,
    rig: getCameraRigPositionFromViewSnapshot(view),
    distance: round(lensDistance),
    bodyPart: size.bodyPart,
  };
}
