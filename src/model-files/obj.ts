/**
 * The box of a Wavefront OBJ: the min/max of its `v x y z [w | r g b]` lines,
 * streamed. Texture, normal and parameter vertices (`vt`, `vn`, `vp`) are not
 * positions. OBJ carries no units, so the size in metres is only suggested
 * from the span ({@link suggestObjMetresPerUnit}); the desk's import panel
 * lets the person change it, and place_model refuses to guess.
 * @module dsh-film/model-files/obj
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { ModelBox, Vec3 } from './types.js'

/** The OBJ's vertex box, or a problem. */
export interface ObjMeasure {
  bounds?: ModelBox
  vertices: number
  problem?: string
}

const VERTEX = /^v\s+(\S+)\s+(\S+)\s+(\S+)/u

/**
 * Read an OBJ's vertex box.
 * @param path - the file.
 * @returns the box (with the vertex count), or a problem when it has no vertices.
 */
export async function readObjFacts(path: string): Promise<ObjMeasure> {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  let vertices = 0
  const lines = createInterface({ input: createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity })
  for await (const line of lines) {
    const match = VERTEX.exec(line.trimStart())
    if (match === null) continue
    const point = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (!point.every(Number.isFinite)) continue
    vertices++
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, point[axis]!)
      max[axis] = Math.max(max[axis]!, point[axis]!)
    }
  }
  if (vertices === 0) return { vertices, problem: 'OBJ 里没有顶点（v 行）' }
  return { bounds: { min, max }, vertices }
}

/**
 * A unit guess from the span: a model over 10000 units across is probably in
 * millimetres, over 100 in centimetres, else in metres.
 * @param bounds - the box in source units.
 * @returns metres per unit.
 */
export function suggestObjMetresPerUnit(bounds: ModelBox): number {
  const span = Math.max(...bounds.max.map((value, axis) => value - bounds.min[axis]!))
  return span > 10000 ? 0.001 : span > 100 ? 0.01 : 1
}
