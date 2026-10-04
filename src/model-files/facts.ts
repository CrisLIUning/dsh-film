/**
 * The facts of one model file (C6): format, role, whether it can be placed,
 * the suggested kind, its box and, with known units, its size in metres.
 *
 * Measurements are cached by absolute path, size and modification time. A
 * listing (the asset library is read again on every file change) measures
 * files it has not seen only within a time budget and within smaller reading
 * limits; whatever it leaves out comes back `pending`, to be measured by a
 * later listing or in full when the file is imported or placed.
 * @module dsh-film/model-files/facts
 */

import { stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { readFbxUnit } from './fbx.js'
import { ModelTooLargeError, readGlbFacts, readGltfFacts } from './gltf.js'
import { readObjFacts, suggestObjMetresPerUnit } from './obj.js'
import { ModelReadError, modelTypeOf } from './types.js'
import type { ModelBox, ModelCompression, ModelFacts, ModelFormat, Vec3 } from './types.js'

const MiB = 1024 * 1024

/**
 * Reading limits of a listing and of a full measurement: a GLB's JSON, an OBJ,
 * and the glTF float data scanned where an accessor has no min/max (a listing
 * leaves a file over its scan limit pending, to be measured in full on import
 * or placement).
 */
export const LISTING_LIMITS = { glbJson: 16 * MiB, obj: 8 * MiB, scan: 8 * MiB } as const
export const FULL_LIMITS = { glbJson: 64 * MiB, obj: Number.POSITIVE_INFINITY, scan: 64 * MiB } as const

/** How long one listing may spend measuring files it has not seen, in milliseconds. */
export const LISTING_BUDGET_MS = 1000

/** A span this wide (metres, across X or Z) suggests a set rather than a prop. */
export const SCENE_SPAN_METRES = 6

/** Measured files remembered. */
const CACHE_LIMIT = 500

/** The space folder: a file under it is a set. */
const SPACES_PREFIX = 'film/spaces/'

/** One listing's time budget, shared by all the files it measures. */
export interface ListingBudget {
  /** `performance.now()` past which uncached files are not measured. */
  deadline: number
}

/**
 * A fresh listing budget.
 * @param ms - how long the listing may measure.
 * @returns the budget.
 */
export function listingBudget(ms = LISTING_BUDGET_MS): ListingBudget {
  return { deadline: performance.now() + ms }
}

export interface ModelFactsOptions {
  /** Listing mode: measure uncached files only within this budget and the listing limits. */
  listing?: ListingBudget
}

/** What reading the file found, independent of where it sits. */
interface Measured {
  bounds?: ModelBox
  metresPerUnit?: number
  suggestedMetresPerUnit?: number
  hasSkin?: true
  compression?: ModelCompression[]
  approximate?: true
  problem?: string
  /** The file cannot be imported as what its name says. */
  unreadable?: true
}

const cache = new Map<string, { size: number; mtimeMs: number; measured: Measured }>()

/** Forget every cached measurement (tests). */
export function clearModelFactsCache(): void {
  cache.clear()
}

/** How many measurements are cached (tests). */
export function modelFactsCacheSize(): number {
  return cache.size
}

const problemOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

async function measure(format: ModelFormat, absolute: string, size: number, limits: { glbJson: number; obj: number; scan: number }): Promise<Measured> {
  switch (format) {
    case 'glb':
    case 'gltf': {
      try {
        const read = format === 'glb' ? readGlbFacts : readGltfFacts
        const listing = limits.glbJson < FULL_LIMITS.glbJson
        const found = await read(absolute, { maxJsonBytes: limits.glbJson, maxScanBytes: limits.scan, deferLargeScans: listing })
        return {
          ...(found.bounds !== undefined ? { bounds: found.bounds } : {}),
          metresPerUnit: 1,
          ...(found.hasSkin ? { hasSkin: true as const } : {}),
          ...(found.compression.length > 0 ? { compression: found.compression } : {}),
          ...(found.approximate ? { approximate: true as const } : {}),
          ...(found.problems.length > 0 ? { problem: found.problems.join('；') } : {}),
        }
      } catch (error) {
        if (error instanceof ModelTooLargeError && limits.glbJson < FULL_LIMITS.glbJson) throw error
        return { unreadable: true, problem: problemOf(error) }
      }
    }
    case 'obj': {
      if (size > limits.obj) throw new ModelTooLargeError(`OBJ 有 ${size} 字节，超过列表时的读取上限`)
      try {
        const found = await readObjFacts(absolute)
        if (found.bounds === undefined) return { unreadable: true, problem: found.problem ?? 'OBJ 里没有顶点' }
        return { bounds: found.bounds, suggestedMetresPerUnit: suggestObjMetresPerUnit(found.bounds) }
      } catch (error) {
        return { unreadable: true, problem: problemOf(error) }
      }
    }
    case 'fbx': {
      try {
        const unit = await readFbxUnit(absolute)
        return unit === undefined ? {} : { metresPerUnit: unit / 100 }
      } catch (error) {
        return { unreadable: true, problem: problemOf(error) }
      }
    }
  }
}

const span = (bounds: ModelBox): Vec3 => bounds.max.map((value, axis) => value - bounds.min[axis]!) as Vec3

const isSpacePath = (path: string): boolean => path.replaceAll('\\', '/').toLowerCase().startsWith(SPACES_PREFIX)

/** The facts from a measurement and the file's place. */
function factsFrom(format: ModelFormat, role: ModelFacts['role'], measured: Measured): ModelFacts {
  const units = measured.metresPerUnit
  const sizeMetres = measured.bounds !== undefined && units !== undefined ? span(measured.bounds).map(value => value * units) as Vec3 : undefined
  const guess = units ?? measured.suggestedMetresPerUnit
  const horizontal = measured.bounds !== undefined && guess !== undefined ? Math.max(span(measured.bounds)[0], span(measured.bounds)[2]) * guess : undefined
  const suggestedKind: ModelFacts['suggestedKind'] = role === 'space'
    ? 'scene'
    : measured.hasSkin === true || (format === 'fbx' && measured.unreadable !== true)
      // A rig decides between character and prop, and only the desk can inspect one; an FBX may hold one.
      ? 'auto'
      : horizontal !== undefined && horizontal >= SCENE_SPAN_METRES ? 'scene' : 'prop'
  return {
    format,
    role,
    placeable: format !== 'gltf' && measured.unreadable !== true,
    suggestedKind,
    ...(measured.bounds !== undefined ? { bounds: { min: [...measured.bounds.min] as Vec3, max: [...measured.bounds.max] as Vec3 } } : {}),
    ...(units !== undefined ? { metresPerUnit: units } : {}),
    ...(measured.suggestedMetresPerUnit !== undefined ? { suggestedMetresPerUnit: measured.suggestedMetresPerUnit } : {}),
    ...(sizeMetres !== undefined ? { sizeMetres } : {}),
    ...(measured.hasSkin === true ? { hasSkin: true as const } : {}),
    ...(measured.compression !== undefined ? { compression: [...measured.compression] } : {}),
    ...(measured.approximate === true ? { approximate: true as const } : {}),
    ...(format === 'gltf' ? { problem: [measured.problem, '.gltf 要先转成 GLB 才能导入（外部的 .bin 和贴图不会随它复制）'].filter(Boolean).join('；') } : measured.problem !== undefined ? { problem: measured.problem } : {}),
  }
}

/**
 * The facts of one model file.
 * @param absolute - the file's real path.
 * @param path - the file relative to the workspace (`film/…` for the film's own), which decides its role.
 * @param options - listing mode, or a full measurement.
 * @returns the facts.
 */
export async function modelFacts(absolute: string, path: string, options: ModelFactsOptions = {}): Promise<ModelFacts> {
  const type = modelTypeOf(path) ?? modelTypeOf(absolute)
  if (type === undefined) throw new ModelReadError(`${path} is not a model file.`)
  const role: ModelFacts['role'] = isSpacePath(path) ? 'space' : 'model'
  const info = await stat(absolute)
  const known = cache.get(absolute)
  if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs) {
    // Most recently used last, so the oldest is dropped first.
    cache.delete(absolute)
    cache.set(absolute, known)
    return factsFrom(type.format, role, known.measured)
  }
  const pending = (): ModelFacts => ({
    format: type.format,
    role,
    placeable: type.format !== 'gltf',
    suggestedKind: role === 'space' ? 'scene' : type.format === 'fbx' ? 'auto' : 'prop',
    ...(type.format === 'glb' || type.format === 'gltf' ? { metresPerUnit: 1 } : {}),
    pending: true,
  })
  if (options.listing !== undefined && performance.now() > options.listing.deadline) return pending()
  let measured: Measured
  try {
    measured = await measure(type.format, absolute, info.size, options.listing !== undefined ? LISTING_LIMITS : FULL_LIMITS)
  } catch (error) {
    if (error instanceof ModelTooLargeError && options.listing !== undefined) return pending()
    throw error
  }
  cache.delete(absolute)
  cache.set(absolute, { size: info.size, mtimeMs: info.mtimeMs, measured })
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  return factsFrom(type.format, role, measured)
}

/**
 * Run `task` over `items`, at most `limit` at a time, keeping the order.
 * @param items - the inputs.
 * @param limit - how many run at once.
 * @param task - the work for one input.
 * @returns the results, in the order of the inputs.
 */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++
      results[at] = await task(items[at]!, at)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
