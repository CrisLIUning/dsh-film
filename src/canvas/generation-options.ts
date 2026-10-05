/**
 * Generation settings on storyboard nodes — the camera move (运镜,
 * `metadata.cameraMove`) and the camera settings (相机,
 * `metadata.cameraControl`) of spec C1, and the presets (C3) that fill a
 * node's settings — for the agent's canvas_set_generation_options and
 * canvas_create_generation_flow (C11).
 *
 * The canvas owns what they mean: node metadata it composes into the prompt
 * when the node is sent (web/src/lib/canvas/prompt-composition.ts), never
 * prompt text. This module writes them as the canvas reads them, ported from
 * its sanitizers (camera-moves.ts, camera-direction.ts) with the catalogue
 * passed in. An agent's value is checked strictly — an unknown id is refused
 * with the valid ones where the canvas would quietly drop it — while a focal
 * length or aperture snaps to the nearest catalogue stop as the canvas does,
 * and `null` means cleared (update_node merges metadata and cannot delete a
 * key; every canvas reader treats null as absent, amendments C.8).
 * @module dsh-film/canvas/generation-options
 */

import { isDeepStrictEqual } from 'node:util'
import type { BoardNode, BoardOp, BoardSnapshot } from './board-ops.js'
import { CAMERA_ANGLES, CAMERA_MOVE_SPEEDS, CAMERA_SHOT_SIZES } from './catalog.js'
import type { CameraAngle, CameraControlCatalog, CameraMoveCatalog, CameraMoveSpeed, CameraShotSize, GenerationPreset, GenerationPresetCatalog } from './catalog.js'
import { CanvasToolError } from './tool-error.js'

export type PromptLanguage = 'zh' | 'en'
export type GenerationMode = 'text' | 'image' | 'video' | 'audio'

/** metadata.cameraMove (C1): moves[0] is the main move. */
export interface CameraMoveSetting {
  v: 1
  moves: Array<{ id: string; speed?: CameraMoveSpeed }>
  combine: 'sequence' | 'together'
}

/** metadata.cameraControl (C1): enabled false keeps the choice without sending it. */
export interface CameraControlSetting {
  v: 1
  enabled: boolean
  look: string
  lens: string
  /** mm, a catalogue stop. */
  focalLength: number
  /** f-number, a catalogue stop. */
  aperture: number
  shotSize?: CameraShotSize
  angle?: CameraAngle
}

/** The catalogues a call has loaded; a setting whose catalogue is not loaded is not rendered. */
export interface OptionCatalogs {
  moves?: CameraMoveCatalog
  camera?: CameraControlCatalog
}

/** At most this many moves on a node (C1). */
export const CAMERA_MOVE_LIMIT = 3
/** The settings canvas_set_generation_options can clear. */
export const CLEARABLE_OPTIONS = ['cameraMove', 'cameraControl'] as const
export type ClearableOption = (typeof CLEARABLE_OPTIONS)[number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isSpeed = (value: unknown): value is CameraMoveSpeed => typeof value === 'string' && (CAMERA_MOVE_SPEEDS as readonly string[]).includes(value)

// ---------------------------------------------------------------------------
// Which nodes take which setting (C1)
// ---------------------------------------------------------------------------

/**
 * The mode a node generates in, as its panel does: image and video nodes by
 * type, a generation (config) node by its generationMode (image by default).
 * @param node - the node.
 * @returns the mode, or undefined for a node that does not generate media here.
 */
export function nodeGenerationMode(node: BoardNode): GenerationMode | undefined {
  if (node.type === 'image') return 'image'
  if (node.type === 'video') return 'video'
  if (node.type !== 'config') return undefined
  const mode = node.metadata?.generationMode
  return mode === 'text' || mode === 'video' || mode === 'audio' ? mode : 'image'
}

const videoEditing = (node: BoardNode, mode: GenerationMode | undefined): boolean => mode === 'video' && node.metadata?.videoMode === 'video-edit'

const nodeKind = (node: BoardNode, mode: GenerationMode | undefined): string =>
  node.type === 'config' ? `generation node is in ${mode ?? 'image'} mode` : `is ${/^[aeiou]/u.test(node.type) ? 'an' : 'a'} ${node.type} node`

/**
 * Why a node does not take a camera move (C1: video nodes and config nodes in video mode).
 * @param node - the node.
 * @param mode - the mode it generates in.
 * @returns the reason, or undefined when it takes one.
 */
export function cameraMoveRefusal(node: BoardNode, mode = nodeGenerationMode(node)): string | undefined {
  if (mode !== 'video' || (node.type !== 'video' && node.type !== 'config')) return `camera moves are for video; this ${nodeKind(node, mode)}`
  if (videoEditing(node, mode)) return 'this node edits a video (video-edit mode), which keeps the source\'s camera'
  return undefined
}

/**
 * Why a node does not take camera settings (C1: image, video and config nodes
 * in image or video mode; not panoramas, which show a whole environment).
 * @param node - the node.
 * @param mode - the mode it generates in.
 * @returns the reason, or undefined when it takes them.
 */
export function cameraControlRefusal(node: BoardNode, mode = nodeGenerationMode(node)): string | undefined {
  if ((mode !== 'image' && mode !== 'video') || (node.type !== 'image' && node.type !== 'video' && node.type !== 'config')) {
    return `camera settings are for image and video generation; this ${nodeKind(node, mode)}`
  }
  if (node.type === 'image' && node.metadata?.panoramaProjection === 'equirectangular') return 'a panorama shows a whole environment and takes no camera settings'
  if (videoEditing(node, mode)) return 'this node edits a video (video-edit mode), which keeps the source\'s picture'
  return undefined
}

// ---------------------------------------------------------------------------
// The canvas's readers, ported (camera-moves.ts, camera-direction.ts)
// ---------------------------------------------------------------------------

/**
 * A stored camera move as the generation uses it, or null when there is none:
 * unknown and repeated ids and speeds on moves without one are dropped, an
 * exclusive move (固定镜头) stands alone, at most three are kept.
 * @param value - metadata.cameraMove.
 * @param catalog - the camera-move catalogue.
 * @returns the setting.
 */
export function sanitizeCameraMove(value: unknown, catalog: CameraMoveCatalog): CameraMoveSetting | null {
  if (!isRecord(value) || (value.v !== undefined && value.v !== 1) || !Array.isArray(value.moves)) return null
  const byId = new Map(catalog.moves.map(move => [move.id, move]))
  const moves: CameraMoveSetting['moves'] = []
  for (const raw of value.moves) {
    const entry = isRecord(raw) && typeof raw.id === 'string' ? byId.get(raw.id) : undefined
    if (entry === undefined || moves.some(move => move.id === entry.id)) continue
    moves.push(entry.speedable && isRecord(raw) && isSpeed(raw.speed) ? { id: entry.id, speed: raw.speed } : { id: entry.id })
  }
  const exclusive = moves.find(move => byId.get(move.id)?.exclusive === true)
  const kept = exclusive !== undefined ? [exclusive] : moves.slice(0, CAMERA_MOVE_LIMIT)
  if (kept.length === 0) return null
  return { v: 1, moves: kept, combine: value.combine === 'together' ? 'together' : 'sequence' }
}

/**
 * The line composition appends for a camera move (C3), e.g.
 * '运镜：镜头平稳地向前推进，逐渐靠近主体。'; empty when there is none.
 * @param value - metadata.cameraMove.
 * @param catalog - the camera-move catalogue.
 * @param language - the prompt's language.
 * @returns the line.
 */
export function renderCameraMove(value: unknown, catalog: CameraMoveCatalog, language: PromptLanguage): string {
  const setting = sanitizeCameraMove(value, catalog)
  if (setting === null) return ''
  const byId = new Map(catalog.moves.map(move => [move.id, move]))
  const sentences = setting.moves.map((step) => {
    const entry = byId.get(step.id)!
    const speed = entry.speedable ? step.speed ?? entry.defaultSpeed ?? 'steady' : undefined
    return speed !== undefined ? entry.sentence[language].replaceAll('{speed}', catalog.speeds[speed][language]) : entry.sentence[language]
  })
  const joiner = setting.combine === 'together' ? (language === 'zh' ? '，同时' : ', while ') : (language === 'zh' ? '；随后' : '; then ')
  const sentence = sentences.join(joiner)
  return language === 'zh' ? `运镜：${sentence}。` : `Camera movement: ${sentence}.`
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  // '50', '50mm', 'f/2.8' from a hand-written value.
  if (typeof value === 'string') return Number.parseFloat(value.trim().replace(/^f\//iu, ''))
  return Number.NaN
}

/**
 * The stop nearest to a value (a tie goes to the smaller stop), or the fallback when it is not a number.
 * @param value - the value.
 * @param stops - the catalogue's stops, ascending.
 * @param fallback - the default.
 * @returns the stop.
 */
export function nearestStop(value: unknown, stops: readonly number[], fallback: number): number {
  const number = toNumber(value)
  if (!Number.isFinite(number) || stops.length === 0) return fallback
  return stops.reduce((best, stop) => (Math.abs(stop - number) < Math.abs(best - number) ? stop : best), stops[0]!)
}

/**
 * A stored camera setting, normalised, or null when there is none (not an
 * object, a cleared null, another schema version): an unknown look or lens
 * falls back to the default, a number snaps to the nearest stop, an unknown
 * shot size or angle is dropped, and a setting without `enabled` applies.
 * @param value - metadata.cameraControl.
 * @param catalog - the camera catalogue.
 * @returns the setting.
 */
export function sanitizeCameraControl(value: unknown, catalog: CameraControlCatalog): CameraControlSetting | null {
  if (!isRecord(value) || (value.v !== undefined && value.v !== 1)) return null
  const { defaults } = catalog
  const setting: CameraControlSetting = {
    v: 1,
    enabled: value.enabled !== false,
    look: typeof value.look === 'string' && catalog.looks.some(entry => entry.id === value.look) ? value.look : defaults.look,
    lens: typeof value.lens === 'string' && catalog.lenses.some(entry => entry.id === value.lens) ? value.lens : defaults.lens,
    focalLength: nearestStop(value.focalLength, catalog.focalLengths.map(stop => stop.mm), defaults.focalLength),
    aperture: nearestStop(value.aperture, catalog.apertures.map(stop => stop.f), defaults.aperture),
  }
  if ((CAMERA_SHOT_SIZES as readonly unknown[]).includes(value.shotSize)) setting.shotSize = value.shotSize as CameraShotSize
  if ((CAMERA_ANGLES as readonly unknown[]).includes(value.angle)) setting.angle = value.angle as CameraAngle
  return setting
}

/** The prefix of the camera line (C3). */
const CAMERA_DIRECTION_PREFIX: Record<PromptLanguage, string> = {
  zh: '拍摄方式（只描述成像，不要在画面里出现相机或摄影器材）：',
  en: 'Camera direction (rendering only; show no camera or equipment): ',
}

/**
 * The line composition appends for camera settings, after the motion line
 * (C3); empty when the setting is cleared, off or not a setting.
 * @param value - metadata.cameraControl.
 * @param catalog - the camera catalogue.
 * @param language - the prompt's language.
 * @returns the line.
 */
export function renderCameraDirection(value: unknown, catalog: CameraControlCatalog, language: PromptLanguage): string {
  const setting = sanitizeCameraControl(value, catalog)
  if (setting === null || !setting.enabled) return ''
  const look = catalog.looks.find(entry => entry.id === setting.look)!.phrase[language]
  const lens = catalog.lenses.find(entry => entry.id === setting.lens)!.phrase[language]
  const focal = catalog.focalLengths.find(stop => stop.mm === setting.focalLength)?.[language] ?? ''
  const aperture = catalog.apertures.find(stop => stop.f === setting.aperture)?.[language] ?? ''
  const parts = language === 'zh'
    ? [look, lens, `${setting.focalLength}mm，${focal}`, `光圈 f/${setting.aperture}，${aperture}`]
    : [look, lens, `${setting.focalLength}mm, ${focal}`, `f/${setting.aperture}, ${aperture}`]
  const label = (list: Array<{ id: string; label: { zh: string; en: string } }>, id: string): string => list.find(entry => entry.id === id)?.label[language] ?? id
  if (setting.shotSize !== undefined) parts.push(language === 'zh' ? `景别：${label(catalog.shotSizes, setting.shotSize)}` : `shot size: ${label(catalog.shotSizes, setting.shotSize)}`)
  if (setting.angle !== undefined) parts.push(language === 'zh' ? `机位：${label(catalog.angles, setting.angle)}` : `angle: ${label(catalog.angles, setting.angle)}`)
  return `${CAMERA_DIRECTION_PREFIX[language]}${parts.join(language === 'zh' ? '；' : '; ')}${language === 'zh' ? '。' : '.'}`
}

// ---------------------------------------------------------------------------
// The agent's values, checked strictly
// ---------------------------------------------------------------------------

const invalid = (message: string): CanvasToolError => new CanvasToolError('CANVAS_OPTION_INVALID', message)

/** The agent's camera move, as canvas_set_generation_options and canvas_create_generation_flow take it. */
export interface CameraMoveInput {
  moves: Array<{ id: string; speed?: string }>
  combine?: string
}

/**
 * Check an agent's camera move against the catalogue: 1–3 known moves, each
 * once, a locked-off move alone. A speed on a move that has none is left out
 * and reported.
 * @param input - the move as the agent wrote it.
 * @param catalog - the camera-move catalogue.
 * @returns the setting to store and what was adjusted.
 */
export function checkCameraMoveInput(input: CameraMoveInput, catalog: CameraMoveCatalog): { setting: CameraMoveSetting; adjusted: string[] } {
  const moves = input.moves
  if (moves.length === 0) throw invalid('cameraMove.moves needs 1–3 moves (the first is the main move). To remove a camera move, pass clear: ["cameraMove"].')
  if (moves.length > CAMERA_MOVE_LIMIT) throw invalid(`cameraMove takes at most ${CAMERA_MOVE_LIMIT} moves; ${moves.length} were given.`)
  const byId = new Map(catalog.moves.map(move => [move.id, move]))
  const unknown = moves.map(move => move.id).filter(id => !byId.has(id))
  if (unknown.length > 0) {
    throw new CanvasToolError('CANVAS_OPTION_UNKNOWN', `Unknown camera move id${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. The valid ids: ${catalog.moves.map(move => move.id).join(', ')} `
      + '(canvas_generation_options kind camera_moves lists them with names and what each does).')
  }
  const ids = moves.map(move => move.id)
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index)
  if (repeated !== undefined) throw invalid(`${repeated} is listed twice; list each move once.`)
  const exclusive = moves.find(move => byId.get(move.id)!.exclusive === true)
  if (exclusive !== undefined && moves.length > 1) throw invalid(`${exclusive.id} (${byId.get(exclusive.id)!.name.zh}) stands alone: pass it as the only move.`)
  const adjusted: string[] = []
  const setting: CameraMoveSetting = {
    v: 1,
    moves: moves.map((move) => {
      const entry = byId.get(move.id)!
      if (move.speed !== undefined && !entry.speedable) adjusted.push(`${move.id} has no speed; the speed was left out`)
      return entry.speedable && isSpeed(move.speed) ? { id: move.id, speed: move.speed } : { id: move.id }
    }),
    combine: input.combine === 'together' ? 'together' : 'sequence',
  }
  return { setting, adjusted }
}

/** The agent's camera settings: given fields replace the node's, a null shot size or angle removes it. */
export interface CameraControlInput {
  enabled?: boolean
  look?: string
  lens?: string
  focalLength?: number
  aperture?: number
  shotSize?: string | null
  angle?: string | null
}

/**
 * Check an agent's camera settings against the catalogue: a look, lens, shot
 * size or angle that is not listed is refused with the listed ones; a focal
 * length or aperture snaps to the nearest stop, and the snap is reported.
 * @param input - the settings as the agent wrote them.
 * @param catalog - the camera catalogue.
 * @returns the settings with snapped numbers, and what was adjusted.
 */
export function checkCameraControlInput(input: CameraControlInput, catalog: CameraControlCatalog): { input: CameraControlInput; adjusted: string[] } {
  const unknown = (field: string, value: string, listed: string): CanvasToolError =>
    new CanvasToolError('CANVAS_OPTION_UNKNOWN', `Unknown cameraControl.${field} "${value}". The valid ${field} values: ${listed} (canvas_generation_options kind camera lists them).`)
  if (input.look !== undefined && !catalog.looks.some(entry => entry.id === input.look)) {
    throw unknown('look', input.look, catalog.looks.map(entry => `${entry.id} (${entry.name.zh})`).join(', '))
  }
  if (input.lens !== undefined && !catalog.lenses.some(entry => entry.id === input.lens)) {
    throw unknown('lens', input.lens, catalog.lenses.map(entry => `${entry.id} (${entry.name.zh})`).join(', '))
  }
  if (typeof input.shotSize === 'string' && !(CAMERA_SHOT_SIZES as readonly string[]).includes(input.shotSize)) {
    throw unknown('shotSize', input.shotSize, catalog.shotSizes.map(entry => `${entry.id} (${entry.label.zh})`).join(', '))
  }
  if (typeof input.angle === 'string' && !(CAMERA_ANGLES as readonly string[]).includes(input.angle)) {
    throw unknown('angle', input.angle, catalog.angles.map(entry => `${entry.id} (${entry.label.zh})`).join(', '))
  }
  const adjusted: string[] = []
  const checked: CameraControlInput = { ...input }
  for (const [field, stops, unit] of [['focalLength', catalog.focalLengths.map(stop => stop.mm), 'mm'], ['aperture', catalog.apertures.map(stop => stop.f), '']] as const) {
    const value = input[field]
    if (value === undefined) continue
    const stop = nearestStop(value, stops, field === 'focalLength' ? catalog.defaults.focalLength : catalog.defaults.aperture)
    if (stop !== value) adjusted.push(`${field} ${value} became ${field === 'aperture' ? 'f/' : ''}${stop}${unit}, the nearest stop (${stops.join(', ')})`)
    checked[field] = stop
  }
  return { input: checked, adjusted }
}

/**
 * Camera settings for a node: the agent's fields over the node's current
 * setting, or over the catalogue defaults when it has none. `enabled`
 * defaults to true (C11): choosing a value turns the camera on.
 * @param input - the checked settings.
 * @param current - the node's metadata.cameraControl.
 * @param catalog - the camera catalogue.
 * @returns the setting to store.
 */
export function mergeCameraControl(input: CameraControlInput, current: unknown, catalog: CameraControlCatalog): CameraControlSetting {
  const base = sanitizeCameraControl(current, catalog) ?? { v: 1, enabled: true, ...catalog.defaults }
  const setting: CameraControlSetting = {
    v: 1,
    enabled: input.enabled ?? true,
    look: input.look ?? base.look,
    lens: input.lens ?? base.lens,
    focalLength: input.focalLength ?? base.focalLength,
    aperture: input.aperture ?? base.aperture,
  }
  const shotSize = input.shotSize === undefined ? base.shotSize : input.shotSize
  const angle = input.angle === undefined ? base.angle : input.angle
  if (typeof shotSize === 'string') setting.shotSize = shotSize as CameraShotSize
  if (typeof angle === 'string') setting.angle = angle as CameraAngle
  return setting
}

/**
 * A preset by id.
 * @param id - the preset id.
 * @param catalog - the preset catalogue.
 * @returns the preset.
 */
export function findPreset(id: string, catalog: GenerationPresetCatalog): GenerationPreset {
  const preset = catalog.presets.find(entry => entry.id === id)
  if (preset === undefined) {
    throw new CanvasToolError('CANVAS_OPTION_UNKNOWN', `Unknown preset "${id}". The valid presets: ${catalog.presets.map(entry => `${entry.id} (${entry.name.zh}, ${entry.mode})`).join(', ')}.`)
  }
  return preset
}

/** A preset turned into node metadata, with what it names that cannot be written. */
export interface PresetSettings {
  preset: GenerationPreset
  /** Canvas field names and forms: seconds and the audio switch as text, the resolution as vquality without its 'p'. */
  metadata: Record<string, unknown>
  skipped: Array<{ field: string; reason: string }>
}

/**
 * The node settings a preset fills, in the forms the canvas's panels write.
 * The page fits duration, ratio, resolution and count to the node's model
 * when it generates, so a value the model lacks is not sent.
 * @param preset - the preset.
 * @param catalogs - the camera catalogues, for a preset that names a camera move or camera.
 * @returns the metadata and what was skipped.
 */
export function presetSettings(preset: GenerationPreset, catalogs: OptionCatalogs): PresetSettings {
  const metadata: Record<string, unknown> = {}
  const skipped: PresetSettings['skipped'] = []
  if (preset.model !== undefined) metadata.model = preset.model
  if (preset.size !== undefined) metadata.size = preset.size
  if (preset.resolution !== undefined) metadata.vquality = preset.resolution.replace(/p$/iu, '')
  if (preset.seconds !== undefined) metadata.seconds = String(preset.seconds)
  if (preset.generateAudio !== undefined) metadata.generateAudio = String(preset.generateAudio)
  if (preset.count !== undefined) metadata.count = preset.count
  if (preset.videoMode !== undefined) metadata.videoMode = preset.videoMode
  if (preset.cameraMove !== undefined) {
    const setting = catalogs.moves === undefined ? null : sanitizeCameraMove(preset.cameraMove, catalogs.moves)
    if (setting !== null) metadata.cameraMove = setting
    else skipped.push({ field: 'cameraMove', reason: 'the preset\'s camera move is not in this build\'s camera-move catalogue' })
  }
  if (preset.cameraControl !== undefined) {
    const setting = catalogs.camera === undefined ? null : sanitizeCameraControl(preset.cameraControl, catalogs.camera)
    if (setting !== null) metadata.cameraControl = setting
    else skipped.push({ field: 'cameraControl', reason: 'the preset\'s camera settings could not be read with this build\'s camera catalogue' })
  }
  if (preset.skills !== undefined && preset.skills.length > 0) {
    skipped.push({ field: 'skills', reason: `prompt skills (${preset.skills.map(skill => skill.id).join(', ')}) cannot be attached by the agent's tools in this version` })
  }
  return { preset, metadata, skipped }
}

// ---------------------------------------------------------------------------
// canvas_set_generation_options: the plan
// ---------------------------------------------------------------------------

/** canvas_set_generation_options' arguments, checked against the catalogues. */
export interface CheckedGenerationOptions {
  nodeIds: string[]
  cameraMove?: CameraMoveSetting
  cameraControl?: CameraControlInput
  preset?: PresetSettings
  clear: ClearableOption[]
  catalogs: OptionCatalogs
}

/** What happened on one node. */
export interface AppliedOptions {
  nodeId: string
  /** Settings the node now holds from this call (some may have held that value already). */
  set: string[]
  /** Settings removed (stored as null). */
  cleared: string[]
  /** Settings this node does not take, and why. */
  skipped: Array<{ field: string; reason: string }>
  /** Whether the node's metadata changed. */
  changed: boolean
}

const TARGET_TYPES = ['image', 'video', 'config']

/**
 * The ops that apply checked options to their nodes, and what each node takes:
 * a preset first, then an explicit camera move or camera (camera fields over
 * the node's current setting), then clears. A node that does not take a
 * setting skips it with the reason; a setting no node takes is refused
 * (CANVAS_OPTION_MODE), as is a node that is not an image, video or
 * generation node (CANVAS_OPTION_TARGET). Unchanged settings write nothing.
 * @param options - the checked options.
 * @param snapshot - the board as it is now (the page's, or the saved board under its lock).
 * @returns one update_node op per changed node, and the per-node report.
 */
export function planGenerationOptions(options: CheckedGenerationOptions, snapshot: BoardSnapshot | null): { ops: BoardOp[]; applied: AppliedOptions[] } {
  const nodes = new Map((snapshot?.nodes ?? []).map(node => [node.id, node]))
  const takers: Record<'preset' | 'cameraMove' | 'cameraControl', string[]> = { preset: [], cameraMove: [], cameraControl: [] }
  const reasons: Record<'preset' | 'cameraMove' | 'cameraControl', string[]> = { preset: [], cameraMove: [], cameraControl: [] }
  const ops: BoardOp[] = []
  const applied = options.nodeIds.map((nodeId): AppliedOptions => {
    const node = nodes.get(nodeId)
    if (node === undefined) throw new CanvasToolError('CANVAS_NODE_NOT_FOUND', `The board has no node ${nodeId}. Re-read canvas_get_state.`)
    if (!TARGET_TYPES.includes(node.type)) {
      throw new CanvasToolError('CANVAS_OPTION_TARGET', `${nodeId} is a ${node.type} node; generation settings go on image, video and generation (config) nodes.`)
    }
    const mode = nodeGenerationMode(node)
    const patch: Record<string, unknown> = {}
    const skipped: AppliedOptions['skipped'] = []
    const skip = (field: 'preset' | 'cameraMove' | 'cameraControl', reason: string): void => {
      skipped.push({ field, reason })
      reasons[field].push(`${nodeId} (${reason})`)
    }
    if (options.preset !== undefined) {
      const { preset } = options.preset
      if (preset.mode !== mode) skip('preset', `${preset.id} is a ${preset.mode} preset; this ${nodeKind(node, mode)}`)
      else {
        takers.preset.push(nodeId)
        for (const [key, value] of Object.entries(options.preset.metadata)) {
          const refusal = key === 'cameraMove' ? cameraMoveRefusal(node, mode) : key === 'cameraControl' ? cameraControlRefusal(node, mode) : undefined
          if (refusal !== undefined) skipped.push({ field: key, reason: refusal })
          else patch[key] = value
        }
        skipped.push(...options.preset.skipped)
      }
    }
    if (options.cameraMove !== undefined) {
      const refusal = cameraMoveRefusal(node, mode)
      if (refusal !== undefined) skip('cameraMove', refusal)
      else {
        takers.cameraMove.push(nodeId)
        patch.cameraMove = options.cameraMove
      }
    }
    if (options.cameraControl !== undefined) {
      const refusal = cameraControlRefusal(node, mode)
      if (refusal !== undefined) skip('cameraControl', refusal)
      else {
        takers.cameraControl.push(nodeId)
        patch.cameraControl = mergeCameraControl(options.cameraControl, patch.cameraControl ?? node.metadata?.cameraControl, options.catalogs.camera!)
      }
    }
    for (const field of options.clear) patch[field] = null
    const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => {
      const current = node.metadata?.[key]
      return value === null ? current !== undefined && current !== null : !isDeepStrictEqual(current, value)
    }))
    if (Object.keys(changes).length > 0) ops.push({ type: 'update_node', id: nodeId, metadata: changes })
    return {
      nodeId,
      set: Object.keys(patch).filter(key => patch[key] !== null),
      cleared: Object.keys(patch).filter(key => patch[key] === null),
      skipped,
      changed: Object.keys(changes).length > 0,
    }
  })
  for (const field of ['preset', 'cameraMove', 'cameraControl'] as const) {
    const requested = field === 'preset' ? options.preset !== undefined : options[field] !== undefined
    if (requested && takers[field].length === 0) {
      throw new CanvasToolError('CANVAS_OPTION_MODE', `None of these nodes takes ${field}: ${reasons[field].join('; ')}. Nothing was changed.`)
    }
  }
  return { ops, applied }
}
