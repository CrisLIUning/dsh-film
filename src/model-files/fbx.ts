/**
 * The unit an FBX file declares: `GlobalSettings › Properties70 › P
 * "UnitScaleFactor"`, in centimetres per unit (1 for centimetres, 100 for
 * metres), from the first 4 MiB of the file. three's FBXLoader reads the
 * same value into `userData.unitScaleFactor` without applying it, which is
 * why a centimetre FBX lands a hundred times too big unless someone does.
 *
 * Bounds are not read here: an FBX's geometry needs the full scene graph
 * (pivots, pre/post rotations, connections), which the desk measures.
 * @module dsh-film/model-files/fbx
 */

import { open } from 'node:fs/promises'

/** How much of the file is read. */
export const FBX_HEAD_BYTES = 4 * 1024 * 1024

const BINARY_MAGIC = 'Kaydara FBX Binary  '
const RECORDS_START = 27
const ASCII_UNIT = /P:\s*"UnitScaleFactor"\s*,\s*"double"\s*,\s*"Number"\s*,\s*"[^"]*"\s*,\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/u

interface RecordHeader {
  /** Absolute offset just past the record; 0 for the null record that ends a list. */
  end: number
  properties: number
  propertyBytes: number
  name: string
  /** Where the first property starts. */
  propertiesAt: number
}

/** A binary FBX's records, as far as the buffer holds them. */
class BinaryFbx {
  private readonly wide: boolean
  readonly nullSize: number

  constructor(private readonly bytes: Buffer, version: number) {
    this.wide = version >= 7500
    this.nullSize = this.wide ? 25 : 13
  }

  private number(at: number): number {
    return this.wide ? Number(this.bytes.readBigUInt64LE(at)) : this.bytes.readUInt32LE(at)
  }

  header(at: number): RecordHeader | undefined {
    const width = this.wide ? 8 : 4
    if (at + width * 3 + 1 > this.bytes.length) return undefined
    const end = this.number(at)
    const properties = this.number(at + width)
    const propertyBytes = this.number(at + width * 2)
    const nameLength = this.bytes.readUInt8(at + width * 3)
    const nameAt = at + width * 3 + 1
    if (nameAt + nameLength > this.bytes.length) return undefined
    return { end, properties, propertyBytes, name: this.bytes.toString('latin1', nameAt, nameAt + nameLength), propertiesAt: nameAt + nameLength }
  }

  /** The records of a list from `at` to `end` (a nested list ends with the null record). */
  *records(at: number, end: number): Generator<RecordHeader> {
    let offset = at
    while (offset < end) {
      const record = this.header(offset)
      if (record === undefined || record.end === 0 || record.end <= offset) return
      yield record
      offset = record.end
    }
  }

  child(parent: RecordHeader, name: string): RecordHeader | undefined {
    const nested = parent.propertiesAt + parent.propertyBytes
    if (parent.end > this.bytes.length) return undefined
    for (const record of this.records(nested, parent.end)) if (record.name === name) return record
    return undefined
  }

  /** The properties of a record: strings as text, numbers as numbers, anything else skipped as `undefined`. */
  properties(record: RecordHeader): Array<string | number | undefined> | undefined {
    const values: Array<string | number | undefined> = []
    let at = record.propertiesAt
    const stop = record.propertiesAt + record.propertyBytes
    const bytes = this.bytes
    for (let count = 0; count < record.properties; count++) {
      if (at >= stop || at >= bytes.length) return undefined
      const code = String.fromCharCode(bytes[at]!)
      at += 1
      const need = (length: number): boolean => at + length <= bytes.length
      switch (code) {
        case 'Y': if (!need(2)) return undefined; values.push(bytes.readInt16LE(at)); at += 2; break
        case 'C': if (!need(1)) return undefined; values.push(bytes[at]!); at += 1; break
        case 'I': if (!need(4)) return undefined; values.push(bytes.readInt32LE(at)); at += 4; break
        case 'F': if (!need(4)) return undefined; values.push(bytes.readFloatLE(at)); at += 4; break
        case 'D': if (!need(8)) return undefined; values.push(bytes.readDoubleLE(at)); at += 8; break
        case 'L': if (!need(8)) return undefined; values.push(Number(bytes.readBigInt64LE(at))); at += 8; break
        case 'S': case 'R': {
          if (!need(4)) return undefined
          const length = bytes.readUInt32LE(at)
          at += 4
          if (!need(length)) return undefined
          values.push(code === 'S' ? bytes.toString('utf8', at, at + length) : undefined)
          at += length
          break
        }
        case 'f': case 'd': case 'l': case 'i': case 'b': {
          if (!need(12)) return undefined
          const compressed = bytes.readUInt32LE(at + 8)
          at += 12 + compressed
          values.push(undefined)
          break
        }
        default:
          return undefined
      }
    }
    return values
  }
}

/** UnitScaleFactor of a binary FBX, or `undefined`. */
function binaryUnit(bytes: Buffer): number | undefined {
  if (bytes.length < RECORDS_START) return undefined
  const fbx = new BinaryFbx(bytes, bytes.readUInt32LE(23))
  for (const record of fbx.records(RECORDS_START, bytes.length)) {
    if (record.name !== 'GlobalSettings') continue
    const properties = fbx.child(record, 'Properties70')
    if (properties === undefined) return undefined
    for (const p of fbx.records(properties.propertiesAt + properties.propertyBytes, Math.min(properties.end, bytes.length))) {
      if (p.name !== 'P') continue
      const values = fbx.properties(p)
      if (values?.[0] !== 'UnitScaleFactor') continue
      return typeof values[4] === 'number' ? values[4] : undefined
    }
    return undefined
  }
  return undefined
}

/**
 * The UnitScaleFactor an FBX declares (centimetres per unit), binary or ASCII.
 * @param path - the file.
 * @returns the factor, or `undefined` when it is absent, unreadable or not positive.
 */
export async function readFbxUnit(path: string): Promise<number | undefined> {
  const handle = await open(path, 'r')
  let head: Buffer
  try {
    const buffer = Buffer.alloc(FBX_HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, FBX_HEAD_BYTES, 0)
    head = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  let unit: number | undefined
  try {
    unit = head.toString('latin1', 0, BINARY_MAGIC.length) === BINARY_MAGIC
      ? binaryUnit(head)
      : Number(ASCII_UNIT.exec(head.toString('latin1'))?.[1] ?? Number.NaN)
  } catch {
    unit = undefined
  }
  return unit !== undefined && Number.isFinite(unit) && unit > 0 ? unit : undefined
}
