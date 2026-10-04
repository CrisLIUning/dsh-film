/**
 * A compiled space plan, written as a GLB.
 *
 * Without a dependency: glTF is JSON plus one binary blob, and this only has to
 * emit three shapes. Adding a browser 3D library to the daemon to write a few
 * hundred boxes would be several hundred kilobytes of runtime for geometry that
 * fits in this file.
 *
 * The whole building shares three unit meshes — a box, a cylinder, a cone — and
 * every wall is a node that scales one of them. A castle with seven hundred
 * wall segments therefore carries three meshes' worth of vertices, not seven
 * hundred. Node names carry the level a part belongs to, so the desk can show
 * one floor, and the director can address `f3-宴会层` in a shot.
 *
 * Ported verbatim from Studio (apps/daemon/src/space-plan-glb.ts), keeping its
 * style; only the import changed.
 * @module dsh-film/space-plan/glb
 */

import type { CompiledSpacePlan, SpacePart, SpacePartRole } from './compile.js';

interface Primitive {
  positions: number[];
  normals: number[];
  indices: number[];
}

/** A 1×1×1 box centred on the origin, flat-shaded: four vertices per face so
 *  each face keeps its own normal instead of averaging into a sphere. */
function unitBox(): Primitive {
  const faces: Array<{ normal: [number, number, number]; corners: Array<[number, number, number]> }> = [
    { normal: [0, 0, 1], corners: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { normal: [0, 0, -1], corners: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
    { normal: [1, 0, 0], corners: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
    { normal: [-1, 0, 0], corners: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
    { normal: [0, 1, 0], corners: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { normal: [0, -1, 0], corners: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  ];
  const primitive: Primitive = { positions: [], normals: [], indices: [] };
  for (const face of faces) {
    const base = primitive.positions.length / 3;
    for (const corner of face.corners) {
      primitive.positions.push(...corner);
      primitive.normals.push(...face.normal);
    }
    primitive.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return primitive;
}

/** Radius 1, height 1, centred on the origin. Open at both ends: a tower shaft
 *  is seen from outside, and closing it would hide a camera placed inside. */
function unitCylinder(segments = 24): Primitive {
  const primitive: Primitive = { positions: [], normals: [], indices: [] };
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    primitive.positions.push(x, -0.5, z, x, 0.5, z);
    primitive.normals.push(x, 0, z, x, 0, z);
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    primitive.indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  return primitive;
}

/** Radius 1 at the base, height 1, apex up, centred on the origin. */
function unitCone(segments = 24): Primitive {
  const primitive: Primitive = { positions: [], normals: [], indices: [] };
  const slope = 1 / Math.hypot(1, 1);
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const mid = (a0 + a1) / 2;
    const base = primitive.positions.length / 3;
    primitive.positions.push(
      Math.cos(a0), -0.5, Math.sin(a0),
      Math.cos(a1), -0.5, Math.sin(a1),
      0, 0.5, 0,
    );
    const n: [number, number, number] = [Math.cos(mid) * slope, slope, Math.sin(mid) * slope];
    primitive.normals.push(...n, ...n, ...n);
    primitive.indices.push(base, base + 1, base + 2);
  }
  // A closed underside, so a cone read from below is not a hole.
  const centre = primitive.positions.length / 3;
  primitive.positions.push(0, -0.5, 0);
  primitive.normals.push(0, -1, 0);
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const base = primitive.positions.length / 3;
    primitive.positions.push(Math.cos(a0), -0.5, Math.sin(a0), Math.cos(a1), -0.5, Math.sin(a1));
    primitive.normals.push(0, -1, 0, 0, -1, 0);
    primitive.indices.push(centre, base + 1, base);
  }
  return primitive;
}

const MATERIALS: Record<SpacePartRole, { name: string; colour: [number, number, number]; roughness: number }> = {
  wall: { name: 'stone', colour: [0.725, 0.698, 0.643], roughness: 0.95 },
  slab: { name: 'floor', colour: [0.561, 0.522, 0.471], roughness: 0.9 },
  roof: { name: 'slate', colour: [0.290, 0.322, 0.361], roughness: 0.8 },
  step: { name: 'step', colour: [0.659, 0.627, 0.580], roughness: 0.9 },
};

const ROLES: SpacePartRole[] = ['wall', 'slab', 'roof', 'step'];

function align4(value: number): number {
  return (4 - (value % 4)) % 4;
}

/**
 * Write a compiled plan as a binary glTF: three unit meshes per role material,
 * one group node per level, one scaled node per part tagged with
 * `extras.vibedevStructure`, and the access issues in the scene's
 * `extras.vibedevSpacePlan`.
 * @param compiled - the compiled plan.
 * @param name - the scene name.
 * @returns the GLB bytes.
 */
export function spacePlanToGlb(compiled: CompiledSpacePlan, name: string): Buffer {
  const primitives = [unitBox(), unitCylinder(), unitCone()];
  const kindToMesh: Record<SpacePart['kind'], number> = { box: 0, cylinder: 1, cone: 2 };

  const bin: Buffer[] = [];
  const bufferViews: Array<Record<string, number>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  let offset = 0;

  const pushView = (data: Buffer, target: number) => {
    const pad = align4(data.length);
    bin.push(data, Buffer.alloc(pad));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target });
    offset += data.length + pad;
    return bufferViews.length - 1;
  };

  const meshes = primitives.map((primitive, index) => {
    const positions = Buffer.from(new Float32Array(primitive.positions).buffer);
    const normals = Buffer.from(new Float32Array(primitive.normals).buffer);
    const indices = Buffer.from(new Uint16Array(primitive.indices).buffer);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < primitive.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = primitive.positions[i + axis]!;
        min[axis] = Math.min(min[axis]!, value);
        max[axis] = Math.max(max[axis]!, value);
      }
    }

    const positionAccessor = accessors.push({
      bufferView: pushView(positions, 34962),
      componentType: 5126,
      count: primitive.positions.length / 3,
      type: 'VEC3',
      min,
      max,
    }) - 1;
    const normalAccessor = accessors.push({
      bufferView: pushView(normals, 34962),
      componentType: 5126,
      count: primitive.normals.length / 3,
      type: 'VEC3',
    }) - 1;
    const indexAccessor = accessors.push({
      bufferView: pushView(indices, 34963),
      componentType: 5123,
      count: primitive.indices.length,
      type: 'SCALAR',
    }) - 1;

    // One mesh per (shape, material) pair: glTF puts the material on the
    // primitive, and a wall and a roof must not share one.
    return ROLES.map((role) => ({
      name: `${['box', 'cylinder', 'cone'][index]}-${role}`,
      primitives: [{
        attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
        indices: indexAccessor,
        material: ROLES.indexOf(role),
      }],
    }));
  });

  const meshList = meshes.flat();
  const meshIndex = (kind: SpacePart['kind'], role: SpacePartRole) =>
    kindToMesh[kind] * ROLES.length + ROLES.indexOf(role);

  /* One group node per level, so a shot can address a floor and the desk can
   * show one storey at a time. */
  const nodes: Array<Record<string, unknown>> = [];
  const groups = new Map<string, number>();
  for (const part of compiled.parts) {
    if (groups.has(part.group)) continue;
    groups.set(part.group, nodes.push({ name: part.group, children: [] as number[] }) - 1);
  }
  for (const part of compiled.parts) {
    const index = nodes.push({
      name: part.name,
      mesh: meshIndex(part.kind, part.role),
      extras: { vibedevStructure: { version: 1, role: part.role, shape: part.kind, group: part.group } },
      translation: part.position,
      scale: part.size,
    }) - 1;
    (nodes[groups.get(part.group)!]!.children as number[]).push(index);
  }

  const json = {
    asset: { version: '2.0', generator: 'vibedev space-plan' },
    scene: 0,
    scenes: [{ name, nodes: [...groups.values()], extras: {vibedevSpacePlan:{version:1,sourceChecks:compiled.access.issues}} }],
    nodes,
    meshes: meshList,
    materials: ROLES.map((role) => ({
      name: MATERIALS[role].name,
      pbrMetallicRoughness: {
        baseColorFactor: [...MATERIALS[role].colour, 1],
        metallicFactor: 0,
        roughnessFactor: MATERIALS[role].roughness,
      },
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };

  const jsonChunk = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = Buffer.alloc(align4(jsonChunk.length), 0x20);
  const binChunk = Buffer.concat(bin);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // glTF
  header.writeUInt32LE(2, 4);
  const total = 12 + 8 + jsonChunk.length + jsonPad.length + 8 + binChunk.length;
  header.writeUInt32LE(total, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length + jsonPad.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // JSON
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // BIN

  return Buffer.concat([header, jsonHeader, jsonChunk, jsonPad, binHeader, binChunk]);
}
