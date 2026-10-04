/** Model files built in the test, the way spacePlanToGlb writes GLBs: JSON plus one BIN chunk. */

/** A glTF document being built, with its binary buffer. */
export class Gltf {
  readonly json: Record<string, any> = { asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [] }
  private readonly chunks: Buffer[] = []
  private offset = 0

  /** Add a buffer view over `data` in the BIN chunk. */
  view(data: Buffer, byteStride?: number): number {
    const pad = (4 - (data.length % 4)) % 4
    this.chunks.push(data, Buffer.alloc(pad))
    this.json.bufferViews.push({ buffer: 0, byteOffset: this.offset, byteLength: data.length, ...(byteStride !== undefined ? { byteStride } : {}) })
    this.offset += data.length + pad
    return this.json.bufferViews.length - 1
  }

  /** A float accessor over `values` (flat), with min/max unless told otherwise. */
  floats(values: number[], type: 'VEC3' | 'VEC4' | 'MAT4', options: { minMax?: boolean } = {}): number {
    const components = { VEC3: 3, VEC4: 4, MAT4: 16 }[type]
    const view = this.view(Buffer.from(new Float32Array(values).buffer))
    const accessor: Record<string, unknown> = { bufferView: view, componentType: 5126, count: values.length / components, type }
    if (options.minMax !== false && type === 'VEC3') {
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < values.length; i += 3) {
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis]!, values[i + axis]!)
          max[axis] = Math.max(max[axis]!, values[i + axis]!)
        }
      }
      accessor.min = min
      accessor.max = max
    }
    return this.json.accessors.push(accessor) - 1
  }

  /** An accessor described by min/max alone (no data), as a Draco primitive's POSITION is. */
  bare(min: number[], max: number[], extra: Record<string, unknown> = {}): number {
    return this.json.accessors.push({ componentType: 5126, count: 8, type: 'VEC3', min, max, ...extra }) - 1
  }

  /** The 8 corners of a box as a POSITION accessor. */
  box(min: number[], max: number[], options: { minMax?: boolean } = {}): number {
    const values: number[] = []
    for (let mask = 0; mask < 8; mask++) values.push(mask & 1 ? max[0]! : min[0]!, mask & 2 ? max[1]! : min[1]!, mask & 4 ? max[2]! : min[2]!)
    return this.floats(values, 'VEC3', options)
  }

  mesh(...primitives: Array<Record<string, unknown>>): number {
    return this.json.meshes.push({ primitives }) - 1
  }

  node(node: Record<string, unknown>): number {
    return this.json.nodes.push(node) - 1
  }

  /** One scene with these root nodes. */
  scene(...nodes: number[]): this {
    this.json.scenes = [{ nodes }]
    this.json.scene = 0
    return this
  }

  /** The BIN chunk's bytes. */
  binary(): Buffer {
    return Buffer.concat(this.chunks)
  }

  /** The GLB file. */
  glb(): Buffer {
    const bin = this.binary()
    if (bin.length > 0) this.json.buffers = [{ byteLength: bin.length }]
    return glb(this.json, bin)
  }
}

/** A GLB from a JSON document and an optional BIN chunk. */
export function glb(json: unknown, bin: Buffer = Buffer.alloc(0)): Buffer {
  const text = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonChunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
  const parts = [jsonHeader(jsonChunk.length, 0x4e4f534a), jsonChunk]
  if (bin.length > 0) parts.push(jsonHeader(bin.length, 0x004e4942), bin)
  const body = Buffer.concat(parts)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + body.length, 8)
  return Buffer.concat([header, body])
}

function jsonHeader(length: number, type: number): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32LE(length, 0)
  header.writeUInt32LE(type, 4)
  return header
}

/** A glTF quaternion for a rotation about Y. */
export const aboutY = (degrees: number): number[] => [0, Math.sin(degrees * Math.PI / 360), 0, Math.cos(degrees * Math.PI / 360)]

/** A column-major translation matrix. */
export const translation = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]

/** A binary FBX with GlobalSettings › Properties70 › P "UnitScaleFactor" (and a few properties before it). */
export function binaryFbx(version: number, unitScaleFactor?: number): Buffer {
  const wide = version >= 7500
  const number = (value: number): Buffer => {
    const out = Buffer.alloc(wide ? 8 : 4)
    if (wide) out.writeBigUInt64LE(BigInt(value))
    else out.writeUInt32LE(value)
    return out
  }
  const nullRecord = Buffer.alloc(wide ? 25 : 13)
  const string = (text: string): Buffer => {
    const bytes = Buffer.from(text, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(bytes.length)
    return Buffer.concat([Buffer.from('S'), length, bytes])
  }
  const double = (value: number): Buffer => {
    const out = Buffer.alloc(9)
    out.write('D', 0)
    out.writeDoubleLE(value, 1)
    return out
  }
  const int = (value: number): Buffer => {
    const out = Buffer.alloc(5)
    out.write('I', 0)
    out.writeInt32LE(value, 1)
    return out
  }
  // Records are laid out at absolute offsets, so build them back to front from a known start.
  const record = (at: number, name: string, properties: Buffer[], children: Array<(at: number) => Buffer>): Buffer => {
    const props = Buffer.concat(properties)
    const headerLength = (wide ? 24 : 12) + 1 + name.length
    let offset = at + headerLength + props.length
    const nested: Buffer[] = []
    for (const child of children) {
      const built = child(offset)
      nested.push(built)
      offset += built.length
    }
    if (children.length > 0) {
      nested.push(nullRecord)
      offset += nullRecord.length
    }
    return Buffer.concat([number(offset), number(properties.length), number(props.length), Buffer.from([name.length]), Buffer.from(name, 'latin1'), props, ...nested])
  }
  const p = (name: string, type: string, value: Buffer) => (at: number) => record(at, 'P', [string(name), string(type), string('Number'), string(''), value], [])
  const head = Buffer.concat([Buffer.from('Kaydara FBX Binary  \0', 'latin1'), Buffer.from([0x1a, 0x00]), Buffer.alloc(4)])
  head.writeUInt32LE(version, 23)
  let at = head.length
  const header = record(at, 'FBXHeaderExtension', [], [(offset) => record(offset, 'FBXVersion', [int(version)], [])])
  at += header.length
  const settings = record(at, 'GlobalSettings', [], [
    (offset) => record(offset, 'Version', [int(1000)], []),
    (offset) => record(offset, 'Properties70', [], [
      p('UpAxis', 'int', int(1)),
      ...(unitScaleFactor !== undefined ? [p('UnitScaleFactor', 'double', double(unitScaleFactor))] : []),
      p('OriginalUnitScaleFactor', 'double', double(1)),
    ]),
  ])
  return Buffer.concat([head, header, settings, nullRecord])
}
