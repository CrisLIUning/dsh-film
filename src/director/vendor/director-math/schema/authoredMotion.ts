// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { Quaternion, Vector3 } from './motionMath.js';
import { motionFingerRig, sampleFingerRotations, validateMotionHands, type MotionHandPoses } from './authoredMotionHands.js';
import { sampleMotionPosition, sampleMotionRotation, type MotionInterpolation } from './authoredMotionCurves.js';

export type MotionRotationKey = { at: number; degrees: [number, number, number]; stop?: boolean };
export type MotionPositionKey = { at: number; position: [number, number, number]; stop?: boolean };
export type MotionEffectorKey = MotionPositionKey & {
  /** Desired world orientation in source-rig coordinates; omitted = identity. */
  degrees?: [number, number, number];
  /** Foot-local pivot relative to the ankle; position remains the neutral ankle.
   * The world contact point is position + pivot, not a translated scene route. */
  pivot?: [number, number, number];
};
export interface AuthoredMotionSpec {
  schemaVersion: 1; name: string; duration: number; fps: number;
  interpolation?: MotionInterpolation;
  joints: Record<string, MotionRotationKey[]>;
  hips?: MotionPositionKey[];
  /** Local pelvis balance offset, at most .2m per horizontal axis. Route stays authoritative. */
  bodyOffset?: MotionPositionKey[];
  feet?: Partial<Record<'LeftFoot'|'RightFoot', MotionEffectorKey[]>>;
  hands?: Partial<Record<'LeftHand'|'RightHand', MotionEffectorKey[]>>;
  /** Anatomical finger poses; independent of world-space wrist targets. */
  handPoses?: MotionHandPoses;
}
type Pose = { position: Vector3; rotation: Quaternion };

// A small, owned, metre/Y-up T-pose rig. No character geometry or provider data.
export const MOTION_RIG: Array<[string, string | null, [number, number, number]]> = [
  ['Hips', null, [0, .94, 0]], ['Spine', 'Hips', [0, .16, 0]],
  ['Spine2', 'Spine', [0, .22, 0]], ['Neck', 'Spine2', [0, .18, 0]], ['Head', 'Neck', [0, .12, 0]],
  ['LeftArm', 'Spine2', [.17, .13, 0]], ['LeftForeArm', 'LeftArm', [.27, 0, 0]], ['LeftHand', 'LeftForeArm', [.25, 0, 0]],
  ['RightArm', 'Spine2', [-.17, .13, 0]], ['RightForeArm', 'RightArm', [-.27, 0, 0]], ['RightHand', 'RightForeArm', [-.25, 0, 0]],
  ['LeftUpLeg', 'Hips', [.10, -.04, 0]], ['LeftLeg', 'LeftUpLeg', [0, -.43, 0]], ['LeftFoot', 'LeftLeg', [0, -.43, 0]], ['LeftToeBase', 'LeftFoot', [0, -.04, .14]],
  ['RightUpLeg', 'Hips', [-.10, -.04, 0]], ['RightLeg', 'RightUpLeg', [0, -.43, 0]], ['RightFoot', 'RightLeg', [0, -.43, 0]], ['RightToeBase', 'RightFoot', [0, -.04, .14]],
];
const names = new Set(MOTION_RIG.map(([name]) => name));


/** Declarative keyframes, never eval or generated executable code. */
export function validateAuthoredMotion(input: unknown): AuthoredMotionSpec {
  const raw = input as AuthoredMotionSpec;
  if (!raw || raw.schemaVersion !== 1 || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 120) throw new Error('Motion needs schemaVersion:1 and a name');
  if (!Number.isFinite(raw.duration) || raw.duration < .1 || raw.duration > 30 || !Number.isInteger(raw.fps) || raw.fps < 15 || raw.fps > 60) throw new Error('Motion duration must be 0.1–30 seconds; fps must be 15–60');
  if (raw.interpolation !== undefined && raw.interpolation !== 'smooth' && raw.interpolation !== 'continuous') throw new Error('Invalid motion interpolation');
  if (!raw.joints || typeof raw.joints !== 'object' || Array.isArray(raw.joints) || !Object.keys(raw.joints).length) throw new Error('Motion needs joint keyframes');
  for (const [name, keys] of Object.entries(raw.joints)) {
    if (!names.has(name)) throw new Error(`Unknown joint: ${name}`);
    if (!Array.isArray(keys) || keys.length < 2 || keys.length > 128) throw new Error(`${name}: needs 2–128 keys`);
    let previous = -1;
    for (const key of keys) {
      if (!key || !Number.isFinite(key.at) || key.at < 0 || key.at > raw.duration || key.at <= previous
        || !Array.isArray(key.degrees) || key.degrees.length !== 3 || key.degrees.some(v => !Number.isFinite(v) || Math.abs(v) > 360)) throw new Error(`${name}: invalid time/XYZ degree key`);
      if (key.stop !== undefined && typeof key.stop !== 'boolean') throw new Error(`${name}: invalid stop marker`);
      previous = key.at;
    }
    if (keys[0].at !== 0 || keys[keys.length - 1].at !== raw.duration) throw new Error(`${name}: keys must cover 0 through duration`);
  }
  for (const [field, allowed] of [['feet', ['LeftFoot', 'RightFoot']], ['hands', ['LeftHand', 'RightHand']]] as Array<['feet' | 'hands', string[]]>) {
    if (raw[field] !== undefined && (!raw[field] || typeof raw[field] !== 'object' || Array.isArray(raw[field]) || Object.keys(raw[field]).some(k => !allowed.includes(k)))) throw new Error(`Invalid ${field} targets`);
  }
  for (const [name, keys] of Object.entries({ ...(raw.feet ?? {}), ...(raw.hands ?? {}), ...(raw.hips !== undefined ? { Hips: raw.hips } : {}), ...(raw.bodyOffset !== undefined ? { bodyOffset: raw.bodyOffset } : {}) })) {
    if (!Array.isArray(keys) || keys.length < 2 || keys.length > 128) throw new Error(`Invalid position keys: ${name}`);
    let previous = -1;
    for (const key of keys as MotionEffectorKey[]) {
      if (!key || !Number.isFinite(key.at) || key.at <= previous || key.at < 0 || key.at > raw.duration || !Array.isArray(key.position) || key.position.length !== 3 || key.position.some(n => !Number.isFinite(n) || Math.abs(n) > 2)) throw new Error(`Invalid position sample: ${name}`);
      if (key.stop !== undefined && typeof key.stop !== 'boolean') throw new Error(`${name}: invalid stop marker`);
      if (name === 'bodyOffset' && (key.position[1] !== 0 || Math.abs(key.position[0]) > .2 || Math.abs(key.position[2]) > .2)) throw new Error('bodyOffset must be horizontal and bounded to .2m per axis');
      if (key.degrees !== undefined && (!name.endsWith('Foot') && !name.endsWith('Hand') || !Array.isArray(key.degrees) || key.degrees.length !== 3 || key.degrees.some(n => !Number.isFinite(n) || Math.abs(n) > 360))) throw new Error(`${name}: invalid effector degrees`);
      if (key.pivot !== undefined && (!name.endsWith('Foot') || !Array.isArray(key.pivot) || key.pivot.length !== 3 || key.pivot.some(n => !Number.isFinite(n) || Math.abs(n) > .2))) throw new Error(`${name}: invalid foot pivot`);
      if (name === 'Hips' && (key.position[0] !== 0 || key.position[2] !== 0)) throw new Error('Horizontal travel belongs to the director route; authored hips may only change height');
      if (name.endsWith('Foot') && key.position[1] < .04 - 1e-6) throw new Error('Foot target goes below the ground');
      previous = key.at;
    }
    if (keys[0].at !== 0 || keys[keys.length - 1].at !== raw.duration) throw new Error(`${name}: position keys must cover duration`);
    if (name === 'bodyOffset' && [keys[0],keys[keys.length-1]].some(k => k.position.some(n => n !== 0))) throw new Error('bodyOffset must return to neutral at both clip boundaries');
  }
  validateMotionHands(raw.handPoses,raw.duration);
  return raw;
}

function sampleEffector(keys: MotionEffectorKey[], seconds: number, mode?: MotionInterpolation) {
  const neutral = sampleMotionPosition(keys, seconds, mode);
  const orientation = sampleMotionRotation(keys.map(k => ({...k, degrees:k.degrees ?? [0,0,0]})), seconds, mode);
  const pivot = sampleMotionPosition(keys.map(k => ({...k, position:k.pivot ?? [0,0,0]})), seconds, mode);
  // Rotate the foot around the contact, not around its ankle. This preserves a
  // toe/heel plant while the ankle lifts. Pivot changes must be authored explicitly.
  return { position:neutral.add(pivot).sub(pivot.clone().applyQuaternion(orientation)), orientation };
}

export function authoredWorldPose(rotations: Map<string, Quaternion>, hips: Vector3, rig = MOTION_RIG) {
  const result = new Map<string, Pose>();
  for (const [name, parent, translation] of rig) {
    const p = parent ? result.get(parent) : undefined, q = rotations.get(name) ?? new Quaternion();
    const position = new Vector3(...translation); if (name === 'Hips') position.add(hips);
    if (p) position.applyQuaternion(p.rotation).add(p.position);
    result.set(name, { position, rotation: (p?.rotation.clone() ?? new Quaternion()).multiply(q) });
  }
  return result;
}

/** CPU two-bone IK: declarative ankle targets control contact, rather than
 * expecting the LLM to guess joint angles that happen to keep a foot planted. */
export function sampleAuthoredPose(spec: AuthoredMotionSpec, seconds: number) {
  const rotations = new Map(Object.entries(spec.joints).map(([name, keys]) => [name, new Quaternion().fromArray(sampleAuthoredJoint(keys, seconds, spec.interpolation))]));
  const hips = spec.hips ? sampleMotionPosition(spec.hips, seconds, spec.interpolation) : new Vector3();
  if (spec.bodyOffset) hips.add(sampleMotionPosition(spec.bodyOffset,seconds,spec.interpolation));
  const initial = authoredWorldPose(rotations, hips);
  for (const [hand, keys] of Object.entries(spec.hands ?? {})) {
    const side = hand.startsWith('Left') ? 'Left' : 'Right', upper = `${side}Arm`, lower = `${side}ForeArm`;
    const effector=sampleEffector(keys,seconds,spec.interpolation);
    const start = initial.get(upper)!.position, target = effector.position, vector = target.clone().sub(start);
    const distance = vector.length(), a = .27, b = .25;
    if (distance > a+b+1e-5 || distance < .025) throw new Error(`${hand}: unreachable at ${seconds.toFixed(3)}s`);
    const direction = vector.normalize(), pole = new Vector3(side === 'Left' ? .3 : -.3,-1,-.15);
    pole.addScaledVector(direction, -pole.dot(direction));
    if (pole.length() < 1e-5) throw new Error(`${hand}: ambiguous elbow bend plane`);
    const along = (a*a - b*b + distance*distance) / (2*distance);
    const elbow = start.clone().addScaledVector(direction, along).addScaledVector(pole.normalize(), Math.sqrt(Math.max(0,a*a-along*along)));
    const restDirection = new Vector3(side === 'Left' ? 1 : -1,0,0);
    const upperWorld = new Quaternion().setFromUnitVectors(restDirection, elbow.clone().sub(start).normalize());
    const lowerWorld = new Quaternion().setFromUnitVectors(restDirection, target.clone().sub(elbow).normalize());
    rotations.set(upper, initial.get('Spine2')!.rotation.clone().invert().multiply(upperWorld));
    rotations.set(lower, upperWorld.clone().invert().multiply(lowerWorld));
    rotations.set(hand, lowerWorld.clone().invert().multiply(effector.orientation));
  }
  for (const [foot, keys] of Object.entries(spec.feet ?? {})) {
    const side = foot.startsWith('Left') ? 'Left' : 'Right', upper = `${side}UpLeg`, lower = `${side}Leg`;
    const effector=sampleEffector(keys,seconds,spec.interpolation);
    const start = initial.get(upper)!.position, target = effector.position, vector = target.clone().sub(start);
    if (target.y < -1e-6) throw new Error(`${foot}: rotated ankle goes below ground at ${seconds.toFixed(3)}s`);
    const distance = vector.length(), length = .43;
    if (distance > 2 * length + 1e-5 || distance < .03) throw new Error(`${foot}: unreachable at ${seconds.toFixed(3)}s (${distance.toFixed(3)}m)`);
    const direction = vector.normalize();
    const pole = new Vector3(0,0,1).applyQuaternion(initial.get('Hips')!.rotation).addScaledVector(direction, -new Vector3(0,0,1).applyQuaternion(initial.get('Hips')!.rotation).dot(direction));
    if (pole.length() < 1e-5) throw new Error(`${foot}: ambiguous knee bend plane`);
    const knee = start.clone().addScaledVector(direction, distance/2).addScaledVector(pole.normalize(), Math.sqrt(Math.max(0, length*length-distance*distance/4)));
    const upperWorld = new Quaternion().setFromUnitVectors(new Vector3(0,-1,0), knee.clone().sub(start).normalize());
    const lowerWorld = new Quaternion().setFromUnitVectors(new Vector3(0,-1,0), target.clone().sub(knee).normalize());
    rotations.set(upper, initial.get('Hips')!.rotation.clone().invert().multiply(upperWorld));
    rotations.set(lower, upperWorld.clone().invert().multiply(lowerWorld));
    rotations.set(foot, lowerWorld.clone().invert().multiply(effector.orientation));
  }
  for(const [name,rotation] of sampleFingerRotations(spec.handPoses,seconds,spec.interpolation))rotations.set(name,rotation);
  return { rotations, hips, world: authoredWorldPose(rotations, hips, [...MOTION_RIG,...motionFingerRig(spec.handPoses)]) };
}

export function sampleAuthoredJoint(keys: MotionRotationKey[], seconds: number, mode?: MotionInterpolation) {
  return sampleMotionRotation(keys,seconds,mode).toArray();
}

/** Mark only explicit, unchanged ground contacts. A moving target/pivot is not
 * inferred to be planted merely because it happens to pass near the floor. */
function footContactIntervals(spec: AuthoredMotionSpec) {
  const intervals:Array<{foot:string;start:number;end:number;pivot:number[]}>=[];
  const same=(a:number[],b:number[])=>a.every((v,i)=>Math.abs(v-b[i])<1e-7);
  for(const [foot,keys] of Object.entries(spec.feet??{})) {
    for(let i=0;i<keys.length-1;i++) {
      const a=keys[i],b=keys[i+1],pivot=a.pivot??[0,0,0];
      if(Math.abs(a.position[1]-.04)>1e-7 || !same(a.position,b.position) || !same(pivot,b.pivot??[0,0,0]))continue;
      const last=intervals[intervals.length-1];
      if(last?.foot===foot && last.end===a.at && same(last.pivot,pivot))last.end=b.at;
      else intervals.push({foot,start:a.at,end:b.at,pivot});
    }
  }
  return intervals;
}

/** Emit a real glTF 2 binary animation, using CPU maths only. No mesh, no weights. */
export function compileAuthoredMotion(raw: unknown) {
  const spec = validateAuthoredMotion(raw);
  const rig=[...MOTION_RIG,...motionFingerRig(spec.handPoses)];
  const nodes: Array<{name: string; translation: number[]; children?: number[]}> = rig.map(([name, , translation]) => ({ name: `mixamorig${name}`, translation: [...translation] }));
  rig.forEach(([, parent], index) => {
    if (parent) { const p = nodes[rig.findIndex(([name]) => name === parent)]; (p.children ??= []).push(index); }
  });
  const sampledTimes = Float32Array.from({ length: Math.ceil(spec.duration * spec.fps) + 1 }, (_, index) => Math.min(index / spec.fps, spec.duration));
  const times = Float32Array.from(Array.from(sampledTimes).filter((value, index) => index === 0 || value > sampledTimes[index - 1]));
  const frameCount = times.length;
  const poses = Array.from(times, t => sampleAuthoredPose(spec, t));
  const views: Record<string, unknown>[] = [], accessors: Record<string, unknown>[] = [], chunks: Uint8Array[] = [], channels: Record<string, unknown>[] = [], samplers: Record<string, unknown>[] = [];
  let offset = 0;
  const append = (array: Float32Array, type: string, components: number, bounds: Record<string, unknown> = {}) => {
    const bytes = new Uint8Array(array.length * 4), view = new DataView(bytes.buffer);
    array.forEach((value, index) => view.setFloat32(index * 4, value, true));
    chunks.push(bytes); views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }); offset += bytes.length;
    accessors.push({ bufferView: views.length - 1, componentType: 5126, count: array.length / components, type, ...bounds });
    return accessors.length - 1;
  };
  const input = append(times, 'SCALAR', 1, { min: [0], max: [times[times.length - 1]] });
  const animated = new Set(Object.keys(spec.joints));
  for (const foot of Object.keys(spec.feet ?? {})) {
    const side = foot.startsWith('Left') ? 'Left' : 'Right';
    for (const suffix of ['UpLeg', 'Leg', 'Foot']) animated.add(`${side}${suffix}`);
  }
  for (const hand of Object.keys(spec.hands ?? {})) {
    const side = hand.startsWith('Left') ? 'Left' : 'Right';
    for (const suffix of ['Arm', 'ForeArm', 'Hand']) animated.add(`${side}${suffix}`);
  }
  for(const name of sampleFingerRotations(spec.handPoses,0).keys())animated.add(name);
  for (const name of animated) {
    const values = Float32Array.from(poses.flatMap(p => p.rotations.get(name)!.toArray()));
    const output = append(values, 'VEC4', 4);
    channels.push({ sampler: samplers.length, target: { node: rig.findIndex(([joint]) => joint === name), path: 'rotation' } });
    samplers.push({ input, output, interpolation: 'LINEAR' });
  }
  if (spec.hips || spec.bodyOffset) {
    const output = append(Float32Array.from(poses.flatMap(p => [p.hips.x, .94+p.hips.y, p.hips.z])), 'VEC3', 3);
    channels.push({ sampler: samplers.length, target: { node: 0, path: 'translation' } }); samplers.push({ input, output, interpolation: 'LINEAR' });
  }
  const contactAware=spec.interpolation==='continuous' || !!spec.bodyOffset || Object.values(spec.feet??{}).some(keys=>keys.some(k=>k.pivot||k.degrees));
  const contract = { schemaVersion: 1, rig: 'vibedev-humanoid-tpose-v1', coordinates: 'metres-y-up-z-forward', rotationSpace: 'local', fps: spec.fps, ...(Object.keys(spec.handPoses??{}).length?{fingerRig:'anatomical-v1',hands:Object.keys(spec.handPoses!)}:{}), ...(spec.bodyOffset ? {pelvisTranslation:'local-balance'} : {}), ...(contactAware?{footContacts:footContactIntervals(spec)}:{}) };
  const document = { asset: { version: '2.0', generator: 'VibeDev authored-motion v3' }, scene: 0, scenes: [{ nodes: [0], extras: { vibedevAuthoredMotion: contract } }], nodes,
    buffers: [{ byteLength: offset }], bufferViews: views, accessors, animations: [{ name: spec.name, channels, samplers }],
    extras: { authoredMotion: { schemaVersion: 1, source: 'keyframes', fps: spec.fps, rootMotion: 'in-place', reviewRequired: true } } };
  const json = new TextEncoder().encode(JSON.stringify(document)), jsonLength = Math.ceil(json.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + offset), header = new DataView(bytes.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.length, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + jsonLength); bytes.set(json, 20);
  header.setUint32(20 + jsonLength, offset, true); header.setUint32(24 + jsonLength, 0x004e4942, true);
  let position = 28 + jsonLength;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  return { bytes, document, report: { name: spec.name, duration: spec.duration, fps: spec.fps, frameCount, trackCount: channels.length, rigProfile: 'mixamo', rootMotion: 'in-place', interpolation: spec.interpolation ?? 'smooth', localBalance: Boolean(spec.bodyOffset), fingerHands:Object.keys(spec.handPoses??{}), reviewRequired: true } };
}
