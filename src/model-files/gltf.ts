/**
 * The bounding box of a glTF scene from its JSON, the way three.js's
 * GLTFLoader and `Box3.setFromObject` compute it in the desk, so the size the
 * Host reports is the size the desk shows:
 *
 * - The scene is `scenes[scene ?? 0]` (what GLTFLoader loads); without scenes,
 *   the roots are the nodes nobody lists as a child.
 * - A node's world matrix is its parent's times its own (`matrix`, else T·R·S).
 * - A primitive's box is its POSITION accessor's min/max, scaled for
 *   normalized (quantized) accessors and expanded by the largest morph target
 *   displacement per axis — GLTFLoader's `computeBounds`. Its 8 corners go
 *   through the world matrix and the union is taken, as `Box3.setFromObject` does.
 * - Missing min/max on a float VEC3 accessor that can be read is scanned from
 *   the data; anything else (compressed, sparse, external buffers) is left out
 *   and the answer is marked approximate.
 * - A skinned mesh's corners go through world(joint)·inverseBind for every
 *   joint; an instanced node (EXT_mesh_gpu_instancing) through every
 *   instance's T·R·S. Both are exact only in the plain case and say so.
 *
 * Draco- and meshopt-compressed files still carry min/max (the glTF spec
 * requires it on POSITION), so no decoder is needed here. A `.gltf` is read
 * from its JSON file; its external `.bin` is never opened.
 * @module dsh-film/model-files/gltf
 */

import { open, readFile, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { ModelReadError } from './types.js'
import type { ModelBox, ModelCompression, Vec3 } from './types.js'

/** The answer for one glTF file. */
export interface GltfMeasure {
  /** The scene's box in source units, if any geometry could be measured. */
  bounds?: ModelBox
  hasSkin: boolean
  compression: ModelCompression[]
  /** Some geometry was left out or measured only roughly. */
  approximate: boolean
  /** What made it approximate, or why there is no box. */
  problems: string[]
}

export interface GltfReadOptions {
  /** The largest JSON chunk (or `.gltf` file) read; a larger one is a {@link ModelTooLargeError}. */
  maxJsonBytes: number
  /** The most accessor bytes scanned for a POSITION accessor without min/max (and for a skin's or an instancing's float data). */
  maxScanBytes?: number
  /**
   * Data over `maxScanBytes` throws {@link ModelTooLargeError} (a listing
   * measures the file later, in full) instead of being left out of an
   * approximate box.
   */
  deferLargeScans?: boolean
}

/** A file over a reading limit: the caller decides whether that is a problem or a later measurement. */
export class ModelTooLargeError extends ModelReadError {
  override name = 'ModelTooLargeError'
}

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const DEFAULT_SCAN_BYTES = 64 * 1024 * 1024
/** How many bytes of positions one read of a min/max scan takes: the scan never holds more, and waits for the disk between reads. */
const SCAN_CHUNK_BYTES = 1024 * 1024

const COMPRESSION_EXTENSIONS: Readonly<Record<string, ModelCompression>> = {
  KHR_draco_mesh_compression: 'draco',
  EXT_meshopt_compression: 'meshopt',
  KHR_meshopt_compression: 'meshopt',
  KHR_texture_basisu: 'ktx2',
}

/** GLTFLoader's getNormalizedComponentScale, by componentType. */
const NORMALIZED_SCALE: Readonly<Record<number, number>> = {
  5120: 1 / 127, // BYTE
  5121: 1 / 255, // UNSIGNED_BYTE
  5122: 1 / 32767, // SHORT
  5123: 1 / 65535, // UNSIGNED_SHORT
}

const FLOAT = 5126

// ---------------------------------------------------------------------------
// 4×4 matrices, column-major as glTF stores them.

type Mat4 = number[]

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16)
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!
      out[column * 4 + row] = sum
    }
  }
  return out
}

/** T·R·S, as three's Matrix4.compose builds it (rotation a unit quaternion x, y, z, w). */
function compose(t: readonly number[], q: readonly number[], s: readonly number[]): Mat4 {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!]
  const [sx, sy, sz] = [s[0]!, s[1]!, s[2]!]
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ]
}

function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ]
}

function sameMatrix(a: Mat4, b: Mat4): boolean {
  const scale = 1 + Math.max(...a.map(Math.abs), ...b.map(Math.abs))
  return a.every((value, index) => Math.abs(value - b[index]!) <= 1e-6 * scale)
}

// ---------------------------------------------------------------------------
// Boxes.

function emptyBox(): ModelBox {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
}

const isEmpty = (box: ModelBox): boolean => !(box.min[0] <= box.max[0] && box.min[1] <= box.max[1] && box.min[2] <= box.max[2])

function expandByPoint(box: ModelBox, p: Vec3): void {
  for (let axis = 0; axis < 3; axis++) {
    box.min[axis] = Math.min(box.min[axis]!, p[axis]!)
    box.max[axis] = Math.max(box.max[axis]!, p[axis]!)
  }
}

/** The 8 corners of a box through a matrix, into `into` (Box3.applyMatrix4 then union). */
function expandByTransformedBox(into: ModelBox, box: ModelBox, m: Mat4): void {
  for (let mask = 0; mask < 8; mask++) {
    expandByPoint(into, transformPoint(m, [
      mask & 1 ? box.max[0] : box.min[0],
      mask & 2 ? box.max[1] : box.min[1],
      mask & 4 ? box.max[2] : box.min[2],
    ]))
  }
}

// ---------------------------------------------------------------------------
// The JSON as far as the measurement reads it.

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const records = (value: unknown): Json[] => Array.isArray(value) ? value.map(item => isRecord(item) ? item : {}) : []
const numbers = (value: unknown, length: number): number[] | undefined =>
  Array.isArray(value) && value.length >= length && value.slice(0, length).every(item => typeof item === 'number' && Number.isFinite(item)) ? value.slice(0, length) as number[] : undefined
const index = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/** Reads bytes of buffer `buffer`; `undefined` when that buffer cannot be read here. */
export type BufferReader = (buffer: number, offset: number, length: number) => Promise<Uint8Array | undefined>

const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

/**
 * Measure a parsed glTF document.
 * @param document - the glTF JSON.
 * @param read - reads its buffers (the GLB's BIN chunk, data: URIs).
 * @param options - the scan limit.
 * @returns the measurement.
 */
export async function measureGltf(document: unknown, read: BufferReader, options: Pick<GltfReadOptions, 'maxScanBytes' | 'deferLargeScans'> = {}): Promise<GltfMeasure> {
  if (!isRecord(document) || !isRecord(document.asset)) throw new ModelReadError('不是 glTF 2.0 文档（没有 asset）')
  const nodes = records(document.nodes)
  const meshes = records(document.meshes)
  const accessors = records(document.accessors)
  const bufferViews = records(document.bufferViews)
  const skins = records(document.skins)
  const problems = new Set<string>()
  let approximate = false
  const rough = (problem: string): void => { approximate = true; problems.add(problem) }
  const maxScanBytes = options.maxScanBytes ?? DEFAULT_SCAN_BYTES

  const compression = new Set<ModelCompression>()
  for (const name of [...(Array.isArray(document.extensionsUsed) ? document.extensionsUsed : []), ...(Array.isArray(document.extensionsRequired) ? document.extensionsRequired : [])]) {
    const kind = typeof name === 'string' ? COMPRESSION_EXTENSIONS[name] : undefined
    if (kind !== undefined) compression.add(kind)
  }

  // Parents, for the world matrix of any node (joints may sit outside the scene's tree).
  const parent = new Map<number, number>()
  for (const [at, node] of nodes.entries()) {
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const childIndex = index(child)
      if (childIndex !== undefined && childIndex < nodes.length && !parent.has(childIndex)) parent.set(childIndex, at)
    }
  }
  const localOf = (node: Json): Mat4 => {
    const matrix = numbers(node.matrix, 16)
    if (matrix !== undefined) return matrix
    return compose(numbers(node.translation, 3) ?? [0, 0, 0], numbers(node.rotation, 4) ?? [0, 0, 0, 1], numbers(node.scale, 3) ?? [1, 1, 1])
  }
  const worlds = new Map<number, Mat4>()
  const worldOf = (start: number): Mat4 => {
    const chain: number[] = []
    const seen = new Set<number>()
    let at: number | undefined = start
    while (at !== undefined && !worlds.has(at)) {
      if (seen.has(at)) {
        rough('节点层级有循环')
        break
      }
      seen.add(at)
      chain.push(at)
      at = parent.get(at)
    }
    let world = at !== undefined && worlds.has(at) ? worlds.get(at)! : IDENTITY
    for (const node of chain.reverse()) {
      world = multiply(world, localOf(nodes[node] ?? {}))
      worlds.set(node, world)
    }
    return worlds.get(start) ?? world
  }

  /** Where a float accessor's elements are, when they can be read plainly. */
  const floatLayout = (accessorIndex: number, type: string): { buffer: number; start: number; stride: number; elementSize: number; count: number; length: number } | undefined => {
    const accessor = accessors[accessorIndex]
    const components = COMPONENTS[type]
    if (accessor === undefined || components === undefined || accessor.type !== type || accessor.componentType !== FLOAT || accessor.sparse !== undefined) return undefined
    const viewIndex = index(accessor.bufferView)
    const view = viewIndex === undefined ? undefined : bufferViews[viewIndex]
    const count = index(accessor.count)
    const buffer = index(view?.buffer)
    if (view === undefined || count === undefined || count === 0 || buffer === undefined) return undefined
    if (isRecord(view.extensions) && (view.extensions.EXT_meshopt_compression !== undefined || view.extensions.KHR_meshopt_compression !== undefined)) return undefined
    const elementSize = components * 4
    const stride = index(view.byteStride) ?? elementSize
    const start = (index(view.byteOffset) ?? 0) + (index(accessor.byteOffset) ?? 0)
    const length = stride * (count - 1) + elementSize
    const viewLength = index(view.byteLength) ?? 0
    if (stride < elementSize || (index(accessor.byteOffset) ?? 0) + length > viewLength) return undefined
    if (length > maxScanBytes) {
      if (options.deferLargeScans === true) throw new ModelTooLargeError(`glTF 的访问器有 ${length} 字节要扫描，超过 ${maxScanBytes} 字节的读取上限`)
      return undefined
    }
    return { buffer, start, stride, elementSize, count, length }
  }

  /** The bytes of an accessor's elements, as floats, when they can be read plainly (a skin's matrices, instance transforms: small). */
  const readFloats = async (accessorIndex: number, type: string): Promise<{ values: Float32Array[]; count: number } | undefined> => {
    const layout = floatLayout(accessorIndex, type)
    if (layout === undefined) return undefined
    const { buffer, start, stride, count, length } = layout
    const components = layout.elementSize / 4
    const bytes = await read(buffer, start, length)
    if (bytes === undefined || bytes.byteLength < length) return undefined
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const values: Float32Array[] = []
    for (let item = 0; item < count; item++) {
      const element = new Float32Array(components)
      for (let component = 0; component < components; component++) element[component] = data.getFloat32(item * stride + component * 4, true)
      values.push(element)
    }
    return { values, count }
  }

  /**
   * The min/max of a float VEC3 accessor, folded straight from the bytes a
   * chunk at a time: nothing is allocated per vertex, and a large scan waits
   * for the disk between chunks instead of holding the event loop.
   */
  const scanBox = async (accessorIndex: number): Promise<ModelBox | undefined> => {
    const layout = floatLayout(accessorIndex, 'VEC3')
    if (layout === undefined) return undefined
    const { buffer, start, stride, elementSize, count } = layout
    const box = emptyBox()
    const perChunk = Math.max(1, Math.floor(SCAN_CHUNK_BYTES / stride))
    for (let first = 0; first < count; first += perChunk) {
      const items = Math.min(perChunk, count - first)
      const length = stride * (items - 1) + elementSize
      const bytes = await read(buffer, start + first * stride, length)
      if (bytes === undefined || bytes.byteLength < length) return undefined
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let item = 0; item < items; item++) {
        const at = item * stride
        for (let axis = 0; axis < 3; axis++) {
          const value = data.getFloat32(at + axis * 4, true)
          box.min[axis] = Math.min(box.min[axis]!, value)
          box.max[axis] = Math.max(box.max[axis]!, value)
        }
      }
    }
    return box
  }

  /** One primitive's box in its mesh's space, as GLTFLoader computes it. */
  const primitiveBox = async (primitive: Json): Promise<ModelBox | undefined> => {
    const attributes = isRecord(primitive.attributes) ? primitive.attributes : {}
    const position = index(attributes.POSITION)
    if (position === undefined) return undefined
    const accessor = accessors[position]
    if (accessor === undefined) {
      rough('POSITION 指向不存在的访问器')
      return undefined
    }
    let box: ModelBox
    const min = numbers(accessor.min, 3)
    const max = numbers(accessor.max, 3)
    if (min !== undefined && max !== undefined) {
      box = { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] }
      if (accessor.normalized === true) {
        const scale = NORMALIZED_SCALE[accessor.componentType as number] ?? 1
        box = { min: box.min.map(value => value * scale) as Vec3, max: box.max.map(value => value * scale) as Vec3 }
      }
    } else {
      const scanned = await scanBox(position)
      if (scanned === undefined) {
        rough('有网格的 POSITION 缺少 min/max 且数据无法直接读取（压缩、稀疏或外部缓冲），尺寸是估计值')
        return undefined
      }
      box = scanned
    }
    const targets = records(primitive.targets)
    if (targets.length > 0) {
      const displacement: Vec3 = [0, 0, 0]
      for (const target of targets) {
        const targetAccessor = accessors[index(target.POSITION) ?? -1]
        const targetMin = numbers(targetAccessor?.min, 3)
        const targetMax = numbers(targetAccessor?.max, 3)
        if (targetAccessor === undefined || targetMin === undefined || targetMax === undefined) continue
        const scale = targetAccessor.normalized === true ? NORMALIZED_SCALE[targetAccessor.componentType as number] ?? 1 : 1
        for (let axis = 0; axis < 3; axis++) {
          displacement[axis] = Math.max(displacement[axis]!, Math.max(Math.abs(targetMin[axis]!), Math.abs(targetMax[axis]!)) * scale)
        }
      }
      box = { min: box.min.map((value, axis) => value - displacement[axis]!) as Vec3, max: box.max.map((value, axis) => value + displacement[axis]!) as Vec3 }
    }
    return box
  }

  const meshBoxCache = new Map<number, ModelBox[]>()
  const meshBoxes = async (meshIndex: number): Promise<ModelBox[]> => {
    const known = meshBoxCache.get(meshIndex)
    if (known !== undefined) return known
    const boxes: ModelBox[] = []
    for (const primitive of records(meshes[meshIndex]?.primitives)) {
      const box = await primitiveBox(primitive)
      if (box !== undefined && !isEmpty(box)) boxes.push(box)
    }
    meshBoxCache.set(meshIndex, boxes)
    return boxes
  }

  /** The matrices a skinned mesh's vertices go through: world(joint)·inverseBind per joint. */
  const skinMatrices = async (skin: Json, meshWorld: Mat4): Promise<Mat4[]> => {
    const joints = (Array.isArray(skin.joints) ? skin.joints : []).map(index).filter((joint): joint is number => joint !== undefined && joint < nodes.length)
    if (joints.length === 0) return [meshWorld]
    let inverses: Mat4[] | undefined
    const ibmIndex = index(skin.inverseBindMatrices)
    if (ibmIndex === undefined) {
      inverses = joints.map(() => IDENTITY)
    } else {
      const read = await readFloats(ibmIndex, 'MAT4')
      if (read !== undefined && read.count >= joints.length) inverses = read.values.slice(0, joints.length).map(value => Array.from(value))
    }
    if (inverses === undefined) {
      rough('蒙皮的逆绑定矩阵读不出来，按网格节点的变换估计')
      return [meshWorld]
    }
    const matrices = joints.map((joint, at) => multiply(worldOf(joint), inverses[at]!))
    if (!matrices.every(matrix => sameMatrix(matrix, matrices[0]!)) || !sameMatrix(meshWorld, IDENTITY)) rough('蒙皮网格的绑定姿势不是单一变换，尺寸是估计值')
    return matrices
  }

  /** The instance transforms of EXT_mesh_gpu_instancing, from float accessors. */
  const instanceMatrices = async (extension: Json, world: Mat4): Promise<Mat4[]> => {
    const attributes = isRecord(extension.attributes) ? extension.attributes : {}
    const read = async (name: string, type: string): Promise<{ values: Float32Array[]; count: number } | 'absent' | undefined> => {
      const at = index(attributes[name])
      return at === undefined ? 'absent' : readFloats(at, type)
    }
    const [translation, rotation, scale] = [await read('TRANSLATION', 'VEC3'), await read('ROTATION', 'VEC4'), await read('SCALE', 'VEC3')]
    if (translation === undefined || rotation === undefined || scale === undefined) {
      rough('实例化网格的变换不是浮点数据，按节点变换估计')
      return [world]
    }
    const counts = [translation, rotation, scale].flatMap(item => item === 'absent' ? [] : [item.count])
    if (counts.length === 0) return [world]
    const count = Math.min(...counts)
    const matrices: Mat4[] = []
    for (let at = 0; at < count; at++) {
      const t = translation === 'absent' ? [0, 0, 0] : Array.from(translation.values[at]!)
      const r = rotation === 'absent' ? [0, 0, 0, 1] : Array.from(rotation.values[at]!)
      const s = scale === 'absent' ? [1, 1, 1] : Array.from(scale.values[at]!)
      matrices.push(multiply(world, compose(t, r, s)))
    }
    return matrices
  }

  // The scene GLTFLoader loads, or the root nodes.
  let roots: number[]
  const scenes = records(document.scenes)
  if (scenes.length > 0) {
    const chosen = document.scene === undefined ? 0 : index(document.scene)
    const scene = chosen === undefined ? undefined : scenes[chosen]
    if (scene === undefined) throw new ModelReadError(`glTF 的 scene ${String(document.scene)} 不存在`)
    roots = (Array.isArray(scene.nodes) ? scene.nodes : []).map(index).filter((node): node is number => node !== undefined && node < nodes.length)
  } else {
    roots = nodes.map((_, at) => at).filter(at => !parent.has(at))
  }

  const total = emptyBox()
  const visited = new Set<number>()
  const stack = [...roots].reverse()
  while (stack.length > 0) {
    const at = stack.pop()!
    if (visited.has(at)) {
      rough('节点层级有循环或重复引用')
      continue
    }
    visited.add(at)
    const node = nodes[at] ?? {}
    for (const child of [...(Array.isArray(node.children) ? node.children : [])].reverse()) {
      const childIndex = index(child)
      if (childIndex !== undefined && childIndex < nodes.length) stack.push(childIndex)
    }
    const meshIndex = index(node.mesh)
    if (meshIndex === undefined || meshes[meshIndex] === undefined) continue
    const boxes = await meshBoxes(meshIndex)
    if (boxes.length === 0) continue
    const world = worldOf(at)
    const skinIndex = index(node.skin)
    const instancing = isRecord(node.extensions) && isRecord(node.extensions.EXT_mesh_gpu_instancing) ? node.extensions.EXT_mesh_gpu_instancing : undefined
    const matrices = skinIndex !== undefined && skins[skinIndex] !== undefined
      ? await skinMatrices(skins[skinIndex]!, world)
      : instancing !== undefined ? await instanceMatrices(instancing, world) : [world]
    for (const box of boxes) for (const matrix of matrices) expandByTransformedBox(total, box, matrix)
  }

  const finite = !isEmpty(total) && [...total.min, ...total.max].every(Number.isFinite)
  if (!finite) problems.add('场景里没有可测量的网格')
  return {
    ...(finite ? { bounds: total } : {}),
    hasSkin: skins.length > 0,
    compression: [...compression],
    approximate,
    problems: [...problems],
  }
}

function parseJson(bytes: Uint8Array): unknown {
  let text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  // GLB pads its JSON chunk with spaces; some writers pad with zero bytes.
  text = text.replace(/\0+$/u, '')
  try {
    return JSON.parse(text)
  } catch {
    throw new ModelReadError('glTF 的 JSON 读不出来')
  }
}

/** A reader for data: URIs (both containers) and, in a GLB, the BIN chunk as buffer 0. */
function bufferReader(document: unknown, bin?: { handle: FileHandle; start: number; length: number }): BufferReader {
  const buffers = isRecord(document) ? records(document.buffers) : []
  const decoded = new Map<number, Buffer | undefined>()
  return async (buffer, offset, length) => {
    const entry = buffers[buffer]
    if (entry === undefined) return undefined
    if (entry.uri === undefined) {
      if (buffer !== 0 || bin === undefined || offset < 0 || offset + length > bin.length) return undefined
      const bytes = new Uint8Array(length)
      const { bytesRead } = await bin.handle.read(bytes, 0, length, bin.start + offset)
      return bytesRead === length ? bytes : undefined
    }
    if (typeof entry.uri !== 'string' || !entry.uri.startsWith('data:')) return undefined
    if (!decoded.has(buffer)) {
      const comma = entry.uri.indexOf(',')
      decoded.set(buffer, comma > 0 && entry.uri.slice(0, comma).endsWith(';base64') ? Buffer.from(entry.uri.slice(comma + 1), 'base64') : undefined)
    }
    const data = decoded.get(buffer)
    if (data === undefined || offset < 0 || offset + length > data.length) return undefined
    return data.subarray(offset, offset + length)
  }
}

/**
 * Measure a GLB: the 12-byte header, the JSON chunk, and the BIN chunk read
 * lazily through the file handle (only for data the JSON does not summarise).
 * @param path - the file.
 * @param options - the limits.
 * @returns the measurement; throws {@link ModelReadError} for a file that is not a readable GLB.
 */
export async function readGlbFacts(path: string, options: GltfReadOptions): Promise<GltfMeasure> {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const header = Buffer.alloc(20)
    const { bytesRead } = await handle.read(header, 0, 20, 0)
    if (bytesRead < 20) throw new ModelReadError('GLB 文件不完整')
    if (header.readUInt32LE(0) !== GLB_MAGIC) throw new ModelReadError('不是 GLB 文件（文件头不对）')
    if (header.readUInt32LE(4) !== 2) throw new ModelReadError(`只支持 glTF 2.0 的 GLB（这是版本 ${header.readUInt32LE(4)}）`)
    const jsonLength = header.readUInt32LE(12)
    if (header.readUInt32LE(16) !== CHUNK_JSON) throw new ModelReadError('GLB 的第一块不是 JSON')
    if (jsonLength > options.maxJsonBytes) throw new ModelTooLargeError(`GLB 的 JSON 有 ${jsonLength} 字节，超过 ${options.maxJsonBytes} 字节的读取上限`)
    if (20 + jsonLength > size) throw new ModelReadError('GLB 文件不完整（JSON 块被截断）')
    const json = Buffer.alloc(jsonLength)
    await handle.read(json, 0, jsonLength, 20)
    const document = parseJson(json)
    let bin: { handle: FileHandle; start: number; length: number } | undefined
    const binHeaderAt = 20 + jsonLength
    if (binHeaderAt + 8 <= size) {
      const binHeader = Buffer.alloc(8)
      await handle.read(binHeader, 0, 8, binHeaderAt)
      if (binHeader.readUInt32LE(4) === CHUNK_BIN) {
        const length = Math.min(binHeader.readUInt32LE(0), size - binHeaderAt - 8)
        bin = { handle, start: binHeaderAt + 8, length }
      }
    }
    return await measureGltf(document, bufferReader(document, bin), options)
  } finally {
    await handle.close()
  }
}

/**
 * Measure a `.gltf` from its JSON file (min/max need no `.bin`; data: URIs are read).
 * @param path - the file.
 * @param options - the limits.
 * @returns the measurement.
 */
export async function readGltfFacts(path: string, options: GltfReadOptions): Promise<GltfMeasure> {
  const { size } = await stat(path)
  if (size > options.maxJsonBytes) throw new ModelTooLargeError(`glTF 文件有 ${size} 字节，超过 ${options.maxJsonBytes} 字节的读取上限`)
  const document = parseJson(await readFile(path))
  return measureGltf(document, bufferReader(document), options)
}
