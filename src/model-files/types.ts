/**
 * What the Host knows about a 3D model file without a renderer: its format,
 * its role in the film, whether the desk can place it, its source-unit
 * bounding box and, when the units are known, its size in metres. Shared by
 * the asset listing (C6), the workspace import (C8), the agent's
 * director_models tool (C11) and place_model (C10).
 * @module dsh-film/model-files/types
 */

import { extname } from 'node:path'

export type ModelFormat = 'glb' | 'gltf' | 'fbx' | 'obj'

export type Vec3 = [number, number, number]

/** An axis-aligned box in the file's own units. */
export interface ModelBox {
  min: Vec3
  max: Vec3
}

export type ModelCompression = 'draco' | 'meshopt' | 'ktx2'

/** The facts a listing or a placement reports about one model file. */
export interface ModelFacts {
  format: ModelFormat
  /** `space` for a file under `film/spaces/` (a compiled or delivered set), `model` otherwise. */
  role: 'space' | 'model'
  /** Whether the desk can import it as one file: never a `.gltf`, never an unreadable file. */
  placeable: boolean
  /** `auto` lets the desk's rig check choose character or prop. */
  suggestedKind: 'scene' | 'prop' | 'auto'
  /** Source units, after the glTF node hierarchy or of the raw OBJ vertices; never for FBX. */
  bounds?: ModelBox
  /** Known units only: glb/gltf 1, FBX UnitScaleFactor/100. */
  metresPerUnit?: number
  /** OBJ only: a guess from its span. */
  suggestedMetresPerUnit?: number
  /** Width, height and depth in metres, only with known units. */
  sizeMetres?: Vec3
  hasSkin?: true
  compression?: ModelCompression[]
  /** The box is not exact (skinned, instanced or compressed geometry the Host cannot read exactly). */
  approximate?: true
  /** Not measured within this listing's budget. */
  pending?: true
  problem?: string
}

/** Model file types by extension, with their content types (as src/canvas/assets.ts serves them). */
export const MODEL_TYPES: Readonly<Record<string, { format: ModelFormat; type: string }>> = {
  '.glb': { format: 'glb', type: 'model/gltf-binary' },
  '.gltf': { format: 'gltf', type: 'model/gltf+json' },
  '.fbx': { format: 'fbx', type: 'application/vnd.autodesk.fbx' },
  '.obj': { format: 'obj', type: 'model/obj' },
}

/**
 * The model format and content type of a file, from its extension.
 * @param path - a file path.
 * @returns the format and type, or `undefined` for anything that is not a model.
 */
export function modelTypeOf(path: string): { format: ModelFormat; type: string } | undefined {
  return MODEL_TYPES[extname(path).toLowerCase()]
}

/** A model file that cannot be read as what its name says. */
export class ModelReadError extends Error {
  override name = 'ModelReadError'
}
