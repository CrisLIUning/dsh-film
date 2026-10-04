// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
/**
 * The few vector operations the motion math needs, without three.
 *
 * The schema's motion functions — where a character is at t, where a camera
 * looks — are pure arithmetic over the project document, and the only thing
 * that tied them to the browser was importing `Vector3` and `Euler` for a
 * handful of operations. The daemon needs the same answers without a 3D
 * library, so those operations live here, written to match three's own
 * implementations term for term: `normalize` multiplies by `1 / length`
 * rather than dividing, `applyEuler` goes through the XYZ quaternion, so a
 * value computed on either side rounds to the same digits.
 */

export type Vec3 = [number, number, number];

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function multiply(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

export function multiplyScalar(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function length(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

export function lengthSq(a: Vec3): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

/** three: `divideScalar(length || 1)` → `multiplyScalar(1 / scalar)`. */
export function normalize(a: Vec3): Vec3 {
  return multiplyScalar(a, 1 / (length(a) || 1));
}

export function lerp(a: Vec3, b: Vec3, alpha: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * alpha,
    a[1] + (b[1] - a[1]) * alpha,
    a[2] + (b[2] - a[2]) * alpha,
  ];
}

/**
 * Rotate by intrinsic XYZ Euler angles, radians — three's default order, and
 * the one every transform in the project uses. Built the way three does it:
 * `Quaternion.setFromEuler` (XYZ branch) then `Vector3.applyQuaternion`.
 */
export function applyEulerXYZ(v: Vec3, euler: Vec3): Vec3 {
  const [x, y, z] = euler;
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;

  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + qy * tz - qz * ty,
    vy + qw * ty + qz * tx - qx * tz,
    vz + qw * tz + qx * ty - qy * tx,
  ];
}

export function roundTuple(v: Vec3, digits = 6): Vec3 {
  return [v[0], v[1], v[2]].map((value) => Number(value.toFixed(digits))) as Vec3;
}
