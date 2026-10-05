/**
 * The storyboard canvas's catalogues (spec C3): the static JSON the canvas
 * composes generation prompts from — camera moves (运镜), camera settings
 * (相机) and generation presets. The canvas bundles them, and its DSH build
 * copies them to `apps/canvas/catalog/<name>.json`, so the agent's tools read
 * the very files the page uses: a move the Agent lists or sets is one the
 * page renders, by the same id.
 *
 * Each file is read once per folder and checked against schema 1 before use.
 * A missing or broken file is a clear CANVAS_CATALOG_MISSING or
 * CANVAS_CATALOG_INVALID refusal of the tool that needed it, never a crash,
 * and tools that do not need it keep working; check-package refuses to pack
 * without the files the tools read.
 * @module dsh-film/canvas/catalog
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the packaged canvas build keeps its catalogues. */
export const PACKAGED_CATALOG_ROOT = fileURLToPath(new URL('../../apps/canvas/catalog/', import.meta.url))

export type Bilingual = { zh: string; en: string }

export type CameraMoveSpeed = 'slow' | 'steady' | 'fast'
export const CAMERA_MOVE_SPEEDS: readonly CameraMoveSpeed[] = ['slow', 'steady', 'fast']

export interface CameraMoveEntry {
  id: string
  category: string
  name: Bilingual
  summary: Bilingual
  /** The prompt sentence without the '运镜：' prefix; '{speed}' only when speedable. */
  sentence: Bilingual
  speedable: boolean
  defaultSpeed?: CameraMoveSpeed
  /** A locked-off move excludes every other move. */
  exclusive?: boolean
  /** Hard for current models; the picker says so. */
  bestEffort?: boolean
  preview?: string
}

export interface CameraMoveCatalog {
  schema: 1
  catalogVersion: string
  speeds: Record<CameraMoveSpeed, Bilingual>
  categories: Array<{ id: string } & Bilingual>
  moves: CameraMoveEntry[]
}

/** Shot sizes and angles are fixed by C1; the catalogue only labels them. */
export const CAMERA_SHOT_SIZES = ['extreme-wide', 'wide', 'full', 'medium-full', 'medium', 'medium-close', 'close', 'extreme-close'] as const
export const CAMERA_ANGLES = ['eye', 'high', 'low', 'top'] as const
export type CameraShotSize = (typeof CAMERA_SHOT_SIZES)[number]
export type CameraAngle = (typeof CAMERA_ANGLES)[number]

export interface CameraControlEntry {
  id: string
  name: Bilingual
  /** The words the camera line uses. */
  phrase: Bilingual
}

export interface CameraControlCatalog {
  schema: 1
  catalogVersion: string
  looks: CameraControlEntry[]
  lenses: CameraControlEntry[]
  focalLengths: Array<{ mm: number } & Bilingual>
  apertures: Array<{ f: number } & Bilingual>
  shotSizes: Array<{ id: CameraShotSize; label: Bilingual }>
  angles: Array<{ id: CameraAngle; label: Bilingual }>
  defaults: { look: string; lens: string; focalLength: number; aperture: number }
}

/** A built-in generation preset (C3): the settings it fills on a node of its mode. */
export interface GenerationPreset {
  id: string
  version: number
  name: Bilingual
  mode: 'image' | 'video'
  model?: string
  videoMode?: string
  size?: string
  resolution?: string
  seconds?: number
  generateAudio?: boolean
  count?: number
  /** C1 shapes, checked against their catalogues when the preset is applied. */
  cameraMove?: Record<string, unknown>
  cameraControl?: Record<string, unknown>
  skills?: Array<{ id: string; vars?: Record<string, string> }>
}

export interface GenerationPresetCatalog {
  schema: 1
  catalogVersion: string
  presets: GenerationPreset[]
}

/** The catalogues by file name. */
export interface CanvasCatalogFiles {
  'camera-moves': CameraMoveCatalog
  'camera-control': CameraControlCatalog
  'generation-presets': GenerationPresetCatalog
}

export type CanvasCatalogName = keyof CanvasCatalogFiles

export class CanvasCatalogError extends Error {
  override name = 'CanvasCatalogError'

  constructor(readonly code: 'CANVAS_CATALOG_MISSING' | 'CANVAS_CATALOG_INVALID', message: string) {
    super(message)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const bilingual = (value: unknown): boolean => isRecord(value) && text(value.zh) && text(value.en)
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/u

/** Entries of a list with slug ids, unique; problems pushed under `key`. */
function entries(value: unknown, key: string, problems: string[], idPattern = SLUG): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${key} must be a non-empty list`)
    return []
  }
  const seen = new Set<string>()
  const kept: Array<Record<string, unknown>> = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !idPattern.test(entry.id)) {
      problems.push(`${key} has an entry without a valid id (${isRecord(entry) ? String(entry.id) : typeof entry})`)
      continue
    }
    if (seen.has(entry.id)) problems.push(`${key} ${entry.id} is repeated`)
    seen.add(entry.id)
    kept.push(entry)
  }
  return kept
}

function checkCameraMoves(value: Record<string, unknown>, problems: string[]): void {
  const speeds = isRecord(value.speeds) ? value.speeds : {}
  for (const speed of CAMERA_MOVE_SPEEDS) if (!bilingual(speeds[speed])) problems.push(`speeds.${speed} needs zh and en`)
  const categories = entries(value.categories, 'categories', problems)
  for (const category of categories) if (!bilingual(category)) problems.push(`category ${String(category.id)} needs zh and en`)
  const categoryIds = new Set(categories.map(category => category.id))
  for (const move of entries(value.moves, 'moves', problems)) {
    const at = `move ${String(move.id)}`
    if (!categoryIds.has(move.category)) problems.push(`${at} has an unknown category`)
    for (const field of ['name', 'summary', 'sentence']) if (!bilingual(move[field])) problems.push(`${at} needs ${field}.zh and ${field}.en`)
    if (typeof move.speedable !== 'boolean') problems.push(`${at} needs speedable`)
    if (bilingual(move.sentence)) {
      for (const sentence of Object.values(move.sentence as Bilingual)) {
        if (sentence.includes('{speed}') !== (move.speedable === true)) problems.push(`${at} has {speed} in its sentence exactly when it is speedable`)
      }
    }
    if (move.defaultSpeed !== undefined && (!(CAMERA_MOVE_SPEEDS as readonly unknown[]).includes(move.defaultSpeed) || move.speedable !== true)) {
      problems.push(`${at} defaultSpeed needs a speedable move and a known speed`)
    }
    for (const flag of ['exclusive', 'bestEffort']) if (move[flag] !== undefined && typeof move[flag] !== 'boolean') problems.push(`${at} ${flag} must be true or false`)
  }
}

function checkCameraControl(value: Record<string, unknown>, problems: string[]): void {
  const ids: Record<string, Set<unknown>> = {}
  for (const key of ['looks', 'lenses']) {
    const list = entries(value[key], key, problems)
    for (const entry of list) for (const field of ['name', 'phrase']) if (!bilingual(entry[field])) problems.push(`${key} ${String(entry.id)} needs ${field}.zh and ${field}.en`)
    ids[key] = new Set(list.map(entry => entry.id))
  }
  for (const [key, field] of [['focalLengths', 'mm'], ['apertures', 'f']] as const) {
    const list = Array.isArray(value[key]) ? value[key] as unknown[] : []
    if (list.length === 0) problems.push(`${key} must be a non-empty list`)
    for (const stop of list) if (!isRecord(stop) || !positive(stop[field]) || !bilingual(stop)) problems.push(`${key} entries need a positive ${field} and zh and en`)
    ids[key] = new Set(list.map(stop => (isRecord(stop) ? stop[field] : undefined)))
  }
  for (const [key, fixed] of [['shotSizes', CAMERA_SHOT_SIZES], ['angles', CAMERA_ANGLES]] as const) {
    const list = Array.isArray(value[key]) ? value[key] as unknown[] : []
    if (JSON.stringify(list.map(entry => (isRecord(entry) ? entry.id : undefined))) !== JSON.stringify(fixed)) problems.push(`${key} must be ${fixed.join(', ')}`)
    for (const entry of list) if (!isRecord(entry) || !bilingual(entry.label)) problems.push(`${key} entries need label.zh and label.en`)
  }
  const defaults = isRecord(value.defaults) ? value.defaults : {}
  if (!ids.looks!.has(defaults.look)) problems.push('defaults.look must be a listed look')
  if (!ids.lenses!.has(defaults.lens)) problems.push('defaults.lens must be a listed lens')
  if (!ids.focalLengths!.has(defaults.focalLength)) problems.push('defaults.focalLength must be a listed focal length')
  if (!ids.apertures!.has(defaults.aperture)) problems.push('defaults.aperture must be a listed aperture')
}

function checkPresets(value: Record<string, unknown>, problems: string[]): void {
  for (const preset of entries(value.presets, 'presets', problems, /^p\.[a-z0-9]+(?:-[a-z0-9]+)*$/u)) {
    const at = `preset ${String(preset.id)}`
    if (!Number.isSafeInteger(preset.version) || (preset.version as number) < 1) problems.push(`${at} needs a version (a positive integer)`)
    if (!bilingual(preset.name)) problems.push(`${at} needs name.zh and name.en`)
    if (preset.mode !== 'image' && preset.mode !== 'video') problems.push(`${at} mode must be image or video`)
    for (const key of ['model', 'videoMode', 'size', 'resolution']) if (preset[key] !== undefined && !text(preset[key])) problems.push(`${at} ${key} must be text`)
    if (preset.seconds !== undefined && !positive(preset.seconds)) problems.push(`${at} seconds must be a positive number`)
    if (preset.count !== undefined && (!Number.isSafeInteger(preset.count) || (preset.count as number) < 1)) problems.push(`${at} count must be a positive integer`)
    if (preset.generateAudio !== undefined && typeof preset.generateAudio !== 'boolean') problems.push(`${at} generateAudio must be true or false`)
    for (const key of ['cameraMove', 'cameraControl']) if (preset[key] !== undefined && !isRecord(preset[key])) problems.push(`${at} ${key} must be an object`)
    if (preset.skills !== undefined && (!Array.isArray(preset.skills) || !preset.skills.every(skill => isRecord(skill) && text(skill.id)))) problems.push(`${at} skills must list { id }`)
  }
}

/**
 * Problems with a catalogue, empty when the tools can use it: schema 1, a
 * catalogVersion, and the fields the tools read in the C3 shapes. The canvas
 * holds its bundled copies to its own, stricter content rules.
 * @param name - the catalogue.
 * @param value - its parsed JSON.
 * @returns the problems.
 */
export function checkCanvasCatalog(name: CanvasCatalogName, value: unknown): string[] {
  if (!isRecord(value)) return ['the catalogue is not a JSON object']
  const problems: string[] = []
  if (value.schema !== 1) problems.push('schema must be 1')
  if (typeof value.catalogVersion !== 'string' || !VERSION.test(value.catalogVersion)) problems.push('catalogVersion must look like YYYY-MM-DD.n')
  if (name === 'camera-moves') checkCameraMoves(value, problems)
  else if (name === 'camera-control') checkCameraControl(value, problems)
  else checkPresets(value, problems)
  return problems
}

async function load<N extends CanvasCatalogName>(name: N, file: string): Promise<CanvasCatalogFiles[N]> {
  let source: string
  try {
    source = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new CanvasCatalogError('CANVAS_CATALOG_MISSING', `This build of the storyboard has no ${name} catalogue (apps/canvas/catalog/${name}.json), so these options cannot be `
        + 'listed or set. The installed dsh-film package is incomplete: reinstall or update it.')
    }
    throw new CanvasCatalogError('CANVAS_CATALOG_INVALID', `The ${name} catalogue could not be read (${code ?? String(error)}).`)
  }
  let value: unknown
  try {
    value = JSON.parse(source.replace(/^﻿/u, ''))
  } catch {
    throw new CanvasCatalogError('CANVAS_CATALOG_INVALID', `The ${name} catalogue (apps/canvas/catalog/${name}.json) is not valid JSON; reinstall or update dsh-film.`)
  }
  const problems = checkCanvasCatalog(name, value)
  if (problems.length > 0) {
    throw new CanvasCatalogError('CANVAS_CATALOG_INVALID', `The ${name} catalogue (apps/canvas/catalog/${name}.json) does not match schema 1: ${problems.slice(0, 3).join('; ')}`
      + `${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}. Reinstall or update dsh-film.`)
  }
  return value as CanvasCatalogFiles[N]
}

/** Catalogues read so far, by file; a failed read is not kept, so the next call reads again. */
const loaded = new Map<string, Promise<unknown>>()

/**
 * One of the canvas's catalogues, read once and checked (C3).
 * @param name - the catalogue.
 * @param root - the folder holding the catalogues; the packaged build's by default (tests pass a fixture folder).
 * @returns the catalogue.
 */
export function readCanvasCatalog<N extends CanvasCatalogName>(name: N, root: string = PACKAGED_CATALOG_ROOT): Promise<CanvasCatalogFiles[N]> {
  const file = join(root, `${name}.json`)
  const known = loaded.get(file)
  if (known !== undefined) return known as Promise<CanvasCatalogFiles[N]>
  const reading = load(name, file)
  loaded.set(file, reading)
  reading.catch(() => {
    if (loaded.get(file) === reading) loaded.delete(file)
  })
  return reading
}
