/**
 * Generation settings on storyboard nodes — the camera move (运镜,
 * `metadata.cameraMove`), the camera settings (相机, `metadata.cameraControl`),
 * the prompt skills (提示词技能, `metadata.promptSkills`, and skill nodes) and
 * the first and last frames (首帧 / 尾帧, `metadata.frameRoles`) of spec C1,
 * and the presets (C3) that fill a node's settings — for the agent's
 * canvas_set_generation_options and canvas_create_generation_flow (C11).
 *
 * The canvas owns what they mean: node metadata it composes into the prompt
 * when the node is sent (web/src/lib/canvas/prompt-composition.ts), never
 * prompt text. This module writes them as the canvas reads them, ported from
 * its sanitizers (camera-moves.ts, camera-direction.ts, prompt-skills.ts,
 * frame-roles.ts) with the catalogue passed in. An agent's value is checked
 * strictly — an unknown id is refused with the valid ones where the canvas
 * would quietly drop it — while a focal length or aperture snaps to the
 * nearest catalogue stop as the canvas does, and `null` means cleared
 * (update_node merges metadata and cannot delete a key; every canvas reader
 * treats null as absent, amendments C.8).
 *
 * It also composes the prompt a generation would send as the page does (C2:
 * the wrap skill around the person's text, the wired texts, the append
 * skills, then the motion, camera and avoid lines), so a run the page would
 * refuse in every setup because composition pushes the prompt over 4000
 * characters is refused here before the batch is sent. The page checks every
 * run of an agent's batch itself before it answers (generation-run.ts) and
 * refuses the whole batch with its own reasons, so a run only some setups
 * would refuse is left to it.
 * @module dsh-film/canvas/generation-options
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { applyBoardOps } from './board-ops.js'
import type { BoardConnection, BoardNode, BoardOp, BoardSnapshot } from './board-ops.js'
import { CAMERA_ANGLES, CAMERA_MOVE_SPEEDS, CAMERA_SHOT_SIZES } from './catalog.js'
import type {
  CameraAngle, CameraControlCatalog, CameraMoveCatalog, CameraMoveSpeed, CameraShotSize, GenerationPreset, GenerationPresetCatalog, PromptSkillCatalog, PromptSkillEntry,
} from './catalog.js'
import {
  PROMPT_SKILL_APPEND_LIMIT, SKILL_VALUE_LIMIT, attachPromptSkill, avoidLine, defaultSkillVars, missingSkillVars, normalizeVideoMode, promptSkillUses, readSkillNode,
  renderPromptSkill, sanitizePromptSkills, skillApplies, skillNodeMetadata, skillPurposePatch, skillSlotsLine, skillTakesMode, skillVariableValues, snapshotOfSkill,
  storedPromptSkills, wiredSkillNodes,
} from './prompt-skills.js'
import type { ComposedSkill, NodePromptSkill, PromptSkillSnapshot, SkillUse } from './prompt-skills.js'
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
  skills?: PromptSkillCatalog
}

/** At most this many moves on a node (C1). */
export const CAMERA_MOVE_LIMIT = 3
/** C2: a prompt that composition (not the person's own text) pushes past this is not sent. */
export const PROMPT_LIMIT_LENGTH = 4000
/** The settings canvas_set_generation_options can clear. */
export const CLEARABLE_OPTIONS = ['cameraMove', 'cameraControl', 'skills', 'frameRoles'] as const
export type ClearableOption = (typeof CLEARABLE_OPTIONS)[number]
/** The duration a request sends when the node names none: the canvas's default (the page may still fit it to the model). */
const DEFAULT_VIDEO_SECONDS = '6'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

const isSpeed = (value: unknown): value is CameraMoveSpeed => typeof value === 'string' && (CAMERA_MOVE_SPEEDS as readonly string[]).includes(value)

const MODES: readonly GenerationMode[] = ['text', 'image', 'video', 'audio']
const isMode = (value: unknown): value is GenerationMode => typeof value === 'string' && (MODES as readonly string[]).includes(value)

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

/**
 * The mode a run generates in when the caller names none, as the page's agent
 * bridge resolves it (generation-run.ts nodeRunMode): a generation (config)
 * node by its generationMode (image when unset), any other node by its type —
 * a video node without a generationMode runs as a video. A plugin node runs in
 * its built-in panel's mode, which is not known here; it composes nothing
 * (no camera, no skills), so the length check does not need it.
 * @param node - the node.
 * @param explicit - the mode the run names, if any.
 * @returns the mode.
 */
export function nodeRunMode(node: BoardNode | undefined, explicit?: unknown): GenerationMode {
  if (isMode(explicit)) return explicit
  if (node === undefined) return 'image'
  if (node.type === 'config') return isMode(node.metadata?.generationMode) ? node.metadata.generationMode : 'image'
  return node.type === 'text' ? 'text' : node.type === 'video' ? 'video' : node.type === 'audio' ? 'audio' : 'image'
}

/**
 * The text a run sends when the caller gives none: the node's editable draft, else its saved prompt (generation-run.ts nodeRunPrompt).
 * @param node - the node.
 * @param explicit - the prompt the run names, if any.
 * @returns the text.
 */
export function nodeRunPrompt(node: BoardNode | undefined, explicit?: unknown): string {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  return String(node?.metadata?.composerContent ?? node?.metadata?.prompt ?? '')
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

/**
 * Why a node does not take first and last frames (C1: video nodes and config nodes in video mode).
 * @param node - the node.
 * @param mode - the mode it generates in.
 * @returns the reason, or undefined when it takes them.
 */
export function frameRolesRefusal(node: BoardNode, mode = nodeGenerationMode(node)): string | undefined {
  if (mode !== 'video' || (node.type !== 'video' && node.type !== 'config')) return `first and last frames are for video; this ${nodeKind(node, mode)}`
  if (videoEditing(node, mode)) return 'this node edits a video (video-edit mode), which takes no first or last frame'
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
 * The bare camera-move sentence, without the '运镜：' prefix and the closing
 * period — what a skill's {{motion}} slot receives (C.6); empty when there is none.
 * @param value - metadata.cameraMove.
 * @param catalog - the camera-move catalogue.
 * @param language - the prompt's language.
 * @returns the sentence.
 */
export function renderCameraMoveSentence(value: unknown, catalog: CameraMoveCatalog, language: PromptLanguage): string {
  const setting = sanitizeCameraMove(value, catalog)
  if (setting === null) return ''
  const byId = new Map(catalog.moves.map(move => [move.id, move]))
  const sentences = setting.moves.map((step) => {
    const entry = byId.get(step.id)!
    const speed = entry.speedable ? step.speed ?? entry.defaultSpeed ?? 'steady' : undefined
    return speed !== undefined ? entry.sentence[language].replaceAll('{speed}', catalog.speeds[speed][language]) : entry.sentence[language]
  })
  const joiner = setting.combine === 'together' ? (language === 'zh' ? '，同时' : ', while ') : (language === 'zh' ? '；随后' : '; then ')
  return sentences.join(joiner)
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
  const sentence = renderCameraMoveSentence(value, catalog, language)
  if (sentence === '') return ''
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

const shortString = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined)

/**
 * A stored camera move as the saved board's summary shows it (canvas_get_document;
 * canvas_get_state shows the value whole): the moves, each an id and a speed
 * when it has one of the three, at most three, and how they combine — no
 * schema version, no other members. Read as stored, without the catalogue.
 * @param value - metadata.cameraMove.
 * @returns the compact move, or undefined when there is none (not an object, cleared with null, another schema version, no moves).
 */
export function compactCameraMove(value: unknown): { moves: Array<{ id: string; speed?: CameraMoveSpeed }>; combine: 'sequence' | 'together' } | undefined {
  if (!isRecord(value) || (value.v !== undefined && value.v !== 1) || !Array.isArray(value.moves)) return undefined
  const moves: Array<{ id: string; speed?: CameraMoveSpeed }> = []
  for (const raw of value.moves) {
    if (!isRecord(raw)) continue
    const id = shortString(raw.id, 80)
    if (id === undefined) continue
    moves.push(isSpeed(raw.speed) ? { id, speed: raw.speed } : { id })
    if (moves.length === CAMERA_MOVE_LIMIT) break
  }
  return moves.length === 0 ? undefined : { moves, combine: value.combine === 'together' ? 'together' : 'sequence' }
}

/**
 * Stored camera settings as the saved board's summary shows them
 * (canvas_get_document; canvas_get_state shows the value whole): enabled (a
 * setting without it applies), look, lens, focal length, aperture, and the
 * shot size and angle when they are listed ones — no schema version, no other
 * members. Read as stored, without the catalogue: an unknown look stays as it
 * is (the page would use its default), and a focal length or aperture is not snapped.
 * @param value - metadata.cameraControl.
 * @returns the compact settings, or undefined when there are none (not an object, cleared with null, another schema version).
 */
export function compactCameraControl(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || (value.v !== undefined && value.v !== 1)) return undefined
  const stop = (item: unknown): number | string | undefined => (typeof item === 'number' ? (Number.isFinite(item) ? item : undefined) : shortString(item, 16))
  const setting: Record<string, unknown> = { enabled: value.enabled !== false }
  const fields: Array<[string, unknown]> = [
    ['look', shortString(value.look, 80)], ['lens', shortString(value.lens, 80)], ['focalLength', stop(value.focalLength)], ['aperture', stop(value.aperture)],
  ]
  for (const [key, item] of fields) if (item !== undefined) setting[key] = item
  if ((CAMERA_SHOT_SIZES as readonly unknown[]).includes(value.shotSize)) setting.shotSize = value.shotSize
  if ((CAMERA_ANGLES as readonly unknown[]).includes(value.angle)) setting.angle = value.angle
  return setting
}

/** The prefix of the camera line (C3). */
const CAMERA_DIRECTION_PREFIX: Record<PromptLanguage, string> = {
  zh: '拍摄方式（只描述成像，不要在画面里出现相机或摄影器材）：',
  en: 'Camera direction (rendering only; show no camera or equipment): ',
}

/**
 * The bare camera sentence, without the '拍摄方式（…）：' prefix and the
 * closing period — what a skill's {{camera}} slot receives (C.6); empty when
 * the setting is cleared, off or not a setting.
 * @param value - metadata.cameraControl.
 * @param catalog - the camera catalogue.
 * @param language - the prompt's language.
 * @returns the sentence.
 */
export function renderCameraDirectionSentence(value: unknown, catalog: CameraControlCatalog, language: PromptLanguage): string {
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
  return parts.join(language === 'zh' ? '；' : '; ')
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
  const sentence = renderCameraDirectionSentence(value, catalog, language)
  return sentence === '' ? '' : `${CAMERA_DIRECTION_PREFIX[language]}${sentence}${language === 'zh' ? '。' : '.'}`
}

// ---------------------------------------------------------------------------
// First and last frames (frame-roles.ts, C1 frameRoles)
// ---------------------------------------------------------------------------

/** metadata.frameRoles: the image node of each role. */
export interface FrameRoles {
  first?: string
  last?: string
}

/**
 * A node's roles as the canvas reads them: string ids, never one id in both
 * roles (首帧 keeps it); null when there are none (null is "cleared").
 * @param value - metadata.frameRoles.
 * @returns the roles.
 */
export function readFrameRoles(value: unknown): FrameRoles | null {
  if (!isRecord(value)) return null
  const roles: FrameRoles = {}
  if (typeof value.first === 'string' && value.first !== '') roles.first = value.first
  if (typeof value.last === 'string' && value.last !== '' && value.last !== roles.first) roles.last = value.last
  return roles.first !== undefined || roles.last !== undefined ? roles : null
}

/**
 * Whether roles apply: only to a node saved in 图生视频 (image-to-video) or 首尾帧 (first-last-frame).
 * @param videoMode - metadata.videoMode.
 * @returns whether they apply.
 */
export function usesFrameRoles(videoMode: unknown): boolean {
  const mode = normalizeVideoMode(videoMode)
  return mode === 'image-to-video' || mode === 'first-last-frame'
}

/**
 * The image ids in sending order: the first frame, the last frame, then the
 * others; an empty role is filled from connection order and a role naming an
 * image not in the list is ignored.
 * @param imageIds - the images in connection order.
 * @param roles - the roles.
 * @returns the ids in order.
 */
export function frameOrder(imageIds: readonly string[], roles: FrameRoles | null): string[] {
  const first = roles?.first !== undefined && imageIds.includes(roles.first) ? roles.first : undefined
  const last = roles?.last !== undefined && imageIds.includes(roles.last) ? roles.last : undefined
  if (first === undefined && last === undefined) return [...imageIds]
  const rest = imageIds.filter(id => id !== first && id !== last)
  const head = first ?? rest.shift()
  return [...(head !== undefined ? [head] : []), ...(last !== undefined ? [last] : []), ...rest]
}

/** The agent's first and last frames: an image node id, or null to remove the role. */
export interface FrameRolesInput {
  first?: string | null
  last?: string | null
}

/**
 * Check the shape of an agent's frameRoles: a role is a node id or null, and one image cannot hold both roles.
 * @param input - frameRoles as the agent wrote it.
 * @returns the input.
 */
export function checkFrameRolesInput(input: FrameRolesInput): FrameRolesInput {
  const roles = (['first', 'last'] as const).filter(role => input[role] !== undefined)
  if (roles.length === 0) throw invalid('frameRoles names first, last or both (an image node id, or null to remove that role). To remove both, pass clear: ["frameRoles"].')
  for (const role of roles) if (typeof input[role] === 'string' && input[role]!.trim() === '') throw invalid(`frameRoles.${role} is an image node id from canvas_get_state, or null.`)
  if (typeof input.first === 'string' && input.first === input.last) throw invalid(`${input.first} cannot be both the first and the last frame.`)
  return input
}

/** Roles with `id` in `role`; when the other role held it, the two swap (the canvas's assignFrameRole). */
function assignFrameRole(roles: FrameRoles, role: 'first' | 'last', id: string): FrameRoles {
  const other = role === 'first' ? 'last' : 'first'
  const next: FrameRoles = { ...roles }
  if (next[other] === id) {
    if (next[role] !== undefined) next[other] = next[role]
    else delete next[other]
  }
  next[role] = id
  return next
}

/**
 * Compact roles for the saved board's summary.
 * @param value - metadata.frameRoles.
 * @returns the roles, or undefined when there are none.
 */
export function compactFrameRoles(value: unknown): FrameRoles | undefined {
  return readFrameRoles(value) ?? undefined
}

// ---------------------------------------------------------------------------
// The agent's values, checked strictly
// ---------------------------------------------------------------------------

function invalid(message: string): CanvasToolError {
  return new CanvasToolError('CANVAS_OPTION_INVALID', message)
}

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

/** A prompt skill as the agent passes it (C11): attached to the node ('attach', the default) or as a skill node wired into it ('node'). */
export interface SkillInput {
  id: string
  vars?: Record<string, unknown>
  as?: string
}

/** A prompt skill of a call, checked against the skill catalogue. */
export interface CheckedSkill {
  entry: PromptSkillEntry
  /** The values given, as text (declared keys only). */
  vars: Record<string, string>
  /** Auto variables given as empty: they go back to the node's own value. */
  unset: string[]
  as: 'attach' | 'node'
}

const skillName = (entry: { id: string; name: { zh: string } }): string => `${entry.id} (${entry.name.zh})`

/**
 * Check the prompt skills of a call against the catalogue: known ids, each
 * once, at most one wrap and two append skills (a node composes no more, its
 * own and its skill nodes' together), and variables the skill declares, as
 * text of at most 2000 characters. Required variables are checked where the
 * skill lands (a node's own values count).
 * @param inputs - the skills as the agent wrote them.
 * @param catalog - the skill catalogue.
 * @returns the checked skills.
 */
export function checkSkillInputs(inputs: readonly SkillInput[], catalog: PromptSkillCatalog): CheckedSkill[] {
  if (inputs.length === 0) throw invalid('skills lists 1–3 skills (ids from canvas_generation_options kind skills). To remove a node\'s skills, pass clear: ["skills"].')
  const byId = new Map(catalog.skills.map(skill => [skill.id, skill]))
  const unknown = inputs.map(input => input.id).filter(id => !byId.has(id))
  if (unknown.length > 0) {
    throw new CanvasToolError('CANVAS_OPTION_UNKNOWN', `Unknown prompt skill id${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. The valid ids: ${catalog.skills.map(skillName).join(', ')} `
      + '(canvas_generation_options kind skills lists them with what each does and its variables).')
  }
  const ids = inputs.map(input => input.id)
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index)
  if (repeated !== undefined) throw invalid(`${repeated} is listed twice; list each skill once.`)
  const entries = inputs.map(input => byId.get(input.id)!)
  const wraps = entries.filter(entry => entry.kind === 'wrap')
  const appends = entries.filter(entry => entry.kind === 'append')
  if (wraps.length > 1 || appends.length > PROMPT_SKILL_APPEND_LIMIT) {
    throw new CanvasToolError('CANVAS_SKILL_LIMIT', `A node composes at most one wrap skill and ${PROMPT_SKILL_APPEND_LIMIT} append skills (its own and its skill nodes' together); `
      + `this call names ${wraps.length} wrap (${wraps.map(entry => entry.id).join(', ') || 'none'}) and ${appends.length} append (${appends.map(entry => entry.id).join(', ') || 'none'}).`)
  }
  return inputs.map((input, index) => {
    const entry = entries[index]!
    const vars: Record<string, string> = {}
    const unset: string[] = []
    for (const [key, raw] of Object.entries(input.vars ?? {})) {
      const variable = entry.variables.find(item => item.key === key)
      if (variable === undefined) {
        throw new CanvasToolError('CANVAS_SKILL_VARS', `${skillName(entry)} has no variable "${key}". ${declared(entry)}`)
      }
      const value = typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : undefined
      if (value === undefined) throw new CanvasToolError('CANVAS_SKILL_VARS', `${skillName(entry)} variable ${key} takes text.`)
      if (value.length > SKILL_VALUE_LIMIT) throw new CanvasToolError('CANVAS_SKILL_VARS', `${skillName(entry)} variable ${key} is ${value.length} characters; it takes at most ${SKILL_VALUE_LIMIT}.`)
      // An auto variable left empty reads the node's own value (the duration the request sends).
      if (variable.auto !== undefined && value.trim() === '') unset.push(key)
      else vars[key] = value
    }
    return { entry, vars, unset, as: input.as === 'node' ? 'node' : 'attach' }
  })
}

/** The variables a skill declares, for a refusal. */
function declared(entry: PromptSkillEntry): string {
  if (entry.variables.length === 0) return 'It declares no variables.'
  return `It declares: ${entry.variables.map(variable => `${variable.key} (${variable.label.zh}${variable.required === true ? ', required' : ''}${variable.default !== undefined ? `, default "${variable.default}"` : ''}${variable.auto !== undefined ? ', defaults to the duration sent' : ''})`).join(', ')}.`
}

/** What a skill still needs: its required variables left empty, named with their labels, and how to pass them. */
function missingVarsText(snapshot: PromptSkillSnapshot, id: string, missing: readonly string[], where: string): string {
  const labels = missing.map((key) => {
    const variable = snapshot.variables.find(item => item.key === key)
    return `${key} (${variable?.label.zh ?? key})`
  })
  return `${id} (${snapshot.name.zh}) needs ${labels.join(', ')}${where}: pass ${missing.length > 1 ? 'them' : 'it'} in vars, e.g. skills [{ id: "${id}", vars: { ${missing.map(key => `${key}: "…"`).join(', ')} } }].`
}

/** A required variable left empty, refused (C11 CANVAS_SKILL_VARS). */
function missingVarsError(snapshot: PromptSkillSnapshot, id: string, missing: readonly string[], where: string): CanvasToolError {
  return new CanvasToolError('CANVAS_SKILL_VARS', missingVarsText(snapshot, id, missing, where))
}

/** The seconds a node's request sends, as far as the board says: its own, else the canvas's default. */
function nodeSeconds(node: BoardNode): string {
  const seconds = node.metadata?.seconds
  return typeof seconds === 'string' && seconds.trim() !== '' ? seconds : typeof seconds === 'number' && Number.isFinite(seconds) ? String(seconds) : DEFAULT_VIDEO_SECONDS
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
  /** The preset's prompt skills this build has and that apply in its mode, attached to each node as the canvas's presets attach them. */
  skills: Array<{ entry: PromptSkillEntry; vars: Record<string, string> }>
  skipped: Array<{ field: string; reason: string }>
}

/**
 * How the page reads a model the agent writes on a node (a preset's, or a
 * flow's `model`): the bare catalogue id, as media_models and the preset
 * catalogue name it, resolved when the node generates to the channel serving
 * that model — the VibeDev gateway's channel first, else the first channel that
 * serves it (canvas `resolveBareModel`, used by `resolveModelForCapability`).
 * The agent never writes a channel selection (`gateway:<channel>::<id>`): which
 * channels a person has is the page's to know.
 */
export const MODEL_RESOLUTION_NOTE = 'The node keeps the model\'s catalogue id, and when it generates the page uses the channel serving that model (the VibeDev '
  + 'gateway\'s first, else the first that serves it); a model no configured channel serves shows as not configured until the person picks one.'

/**
 * The node settings a preset fills, in the forms the canvas's panels write.
 * The page fits duration, ratio, resolution and count to the node's model
 * when it generates, so a value the model lacks is not sent; the model is
 * written as the preset names it, the catalogue id, which the page resolves
 * to the channel serving it ({@link MODEL_RESOLUTION_NOTE}).
 * @param preset - the preset.
 * @param catalogs - the camera and skill catalogues, for a preset that names a camera move, camera or skills.
 * @returns the metadata and what was skipped.
 */
export function presetSettings(preset: GenerationPreset, catalogs: OptionCatalogs): PresetSettings {
  const metadata: Record<string, unknown> = {}
  const skipped: PresetSettings['skipped'] = []
  const skills: PresetSettings['skills'] = []
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
    if (catalogs.skills === undefined) {
      skipped.push({ field: 'skills', reason: `prompt skills (${preset.skills.map(skill => skill.id).join(', ')}) could not be read: this build has no skill catalogue` })
    } else {
      for (const item of preset.skills) {
        const entry = catalogs.skills.skills.find(skill => skill.id === item.id)
        // As the canvas's presets: a skill this build lacks, or one that does not apply in the preset's mode, is left out.
        if (entry === undefined) skipped.push({ field: 'skills', reason: `${item.id} is not in this build's skill catalogue` })
        else if (!skillApplies(entry, preset.mode)) skipped.push({ field: 'skills', reason: `${item.id} does not apply in ${preset.mode} mode` })
        else skills.push({ entry, vars: Object.fromEntries(Object.entries(item.vars ?? {}).filter((pair): pair is [string, string] => typeof pair[1] === 'string')) })
      }
    }
  }
  return { preset, metadata, skills, skipped }
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
  /** Prompt skills: attached to each node, or one skill node per skill wired into the nodes. */
  skills?: CheckedSkill[]
  frameRoles?: FrameRolesInput
  clear: ClearableOption[]
  catalogs: OptionCatalogs
}

/** How one skill takes part in a node's prompt after the call (prompt-composition.ts promptSkillUses). */
export interface SkillReport {
  id: string
  /** The node's own skill, or a skill node wired into it. */
  source: 'node' | 'skill-node'
  /** The skill node. */
  nodeId?: string
  state: SkillUse['state']
  /** Required variables still empty: the lines that use them are left out. */
  missing?: string[]
}

/** What happened on one node. */
export interface AppliedOptions {
  nodeId: string
  /** Settings the node now holds from this call (some may have held that value already); its prompt skills are "skills". */
  set: string[]
  /** Settings removed (stored as null). */
  cleared: string[]
  /** Settings this node does not take, and why. */
  skipped: Array<{ field: string; reason: string }>
  /** Whether the node's metadata changed. */
  changed: boolean
  /** When the call touched its skills: each skill the node has and how it takes part when the node is generated. */
  skills?: SkillReport[]
  /** Skill nodes this call wired into the node. */
  skillNodes?: string[]
  notes?: string[]
}

/** A skill node a call added (or reused) and wired. */
export interface PlannedSkillNode {
  id: string
  skill: string
  version: number
  /** false: an existing skill node with the same skill, version and variables was wired instead. */
  created: boolean
  wiredTo: string[]
}

const TARGET_TYPES = ['image', 'video', 'config']
const SKILL_NODE_SIZE = { width: 300, height: 220 }

/** Report labels: a node's prompt skills are "skills", as the tool names them. */
const reportLabel = (key: string): string => (key === 'promptSkills' ? 'skills' : key)

/** Why a video skill a node takes does not compose yet: the node's saved video mode is not one of its videoModes (C.6). */
function videoModeNote(entry: PromptSkillEntry, node: BoardNode, mode: GenerationMode | undefined): string | undefined {
  if (mode !== 'video' || skillApplies(entry, 'video', node.metadata?.videoMode)) return undefined
  return `${entry.id} applies only in video mode ${entry.videoModes!.join(' or ')}; this node's video mode is ${normalizeVideoMode(node.metadata?.videoMode) ?? 'not set'}, so the skill is `
    + 'kept but not composed until it is'
}

/**
 * The ops that apply checked options to their nodes, and what each node takes:
 * a preset first (its settings, then its skills), then an explicit camera move
 * or camera (camera fields over the node's current setting), then the
 * attached skills, the frame roles and the clears; then one skill node per
 * skill given as: 'node', wired into the nodes it applies to. clear "skills"
 * removes a node's own skills before any are attached, so passing both
 * replaces them. A node that does not take a setting skips it with the reason;
 * a setting no node takes is refused (CANVAS_OPTION_MODE), as is a node that
 * is not an image, video or generation node (CANVAS_OPTION_TARGET), a skill
 * whose required variables stay empty (CANVAS_SKILL_VARS) and a node that
 * would hold a third append skill (CANVAS_SKILL_LIMIT). Unchanged settings
 * write nothing.
 * @param options - the checked options.
 * @param snapshot - the board as it is now (the page's, or the saved board under its lock).
 * @returns one update_node op per changed node and the skill nodes' add_node and connect_nodes ops, the per-node report, and the skill nodes.
 */
export function planGenerationOptions(options: CheckedGenerationOptions, snapshot: BoardSnapshot | null): { ops: BoardOp[]; applied: AppliedOptions[]; skillNodes: PlannedSkillNode[] } {
  const boardNodes = snapshot?.nodes ?? []
  const connections = snapshot?.connections ?? []
  const nodes = new Map(boardNodes.map(node => [node.id, node]))
  const takers = new Map<string, string[]>()
  const reasons = new Map<string, string[]>()
  const push = (map: Map<string, string[]>, key: string, value: string): void => { map.set(key, [...map.get(key) ?? [], value]) }
  const ops: BoardOp[] = []
  const attached = (options.skills ?? []).filter(skill => skill.as === 'attach')
  const skillNodeInputs = (options.skills ?? []).filter(skill => skill.as === 'node')
  const clearSkills = options.clear.includes('skills')
  /** Each node's own skills after the call, and whether the call touched them. */
  const finalSkills = new Map<string, NodePromptSkill[]>()
  const touched = new Set<string>()
  const applied = options.nodeIds.map((nodeId): AppliedOptions => {
    const node = nodes.get(nodeId)
    if (node === undefined) throw new CanvasToolError('CANVAS_NODE_NOT_FOUND', `The board has no node ${nodeId}. Re-read canvas_get_state.`)
    if (!TARGET_TYPES.includes(node.type)) {
      throw new CanvasToolError('CANVAS_OPTION_TARGET', `${nodeId} is a ${node.type} node; generation settings go on image, video and generation (config) nodes.`)
    }
    const mode = nodeGenerationMode(node)
    const patch: Record<string, unknown> = {}
    const skipped: AppliedOptions['skipped'] = []
    const notes: string[] = []
    const skip = (field: string, reason: string, key = field): void => {
      skipped.push({ field, reason })
      push(reasons, key, `${nodeId} (${reason})`)
    }
    let skills = clearSkills ? [] : sanitizePromptSkills(node.metadata?.promptSkills)
    let skillsTouched = clearSkills
    const seconds = nodeSeconds(node)
    const presetSkill = (entry: PromptSkillEntry, vars: Record<string, string>): void => {
      const result = attachPromptSkill(skills, entry, vars)
      if (result.outcome === 'limit') {
        skipped.push({ field: 'skills', reason: `${entry.id}: this node already has ${PROMPT_SKILL_APPEND_LIMIT} append skills` })
        return
      }
      if (result.outcome !== 'exists') {
        skills = result.skills
        skillsTouched = true
      }
      if (result.replaced !== undefined) notes.push(`${entry.id} replaced ${result.replaced.id} (a node takes one wrap skill)`)
      Object.assign(patch, skillPurposePatch(entry))
      // As the canvas's presets: attached without its required values, which the page leaves out until they are set.
      const skill = skills.find(item => item.id === entry.id)!
      const missing = missingSkillVars(skill.snapshot, skill.vars, { seconds })
      if (missing.length > 0) notes.push(`${missingVarsText(skill.snapshot, entry.id, missing, '')} Until then the lines that use ${missing.length > 1 ? 'them' : 'it'} are left out.`)
    }
    if (options.preset !== undefined) {
      const { preset } = options.preset
      if (preset.mode !== mode) skip('preset', `${preset.id} is a ${preset.mode} preset; this ${nodeKind(node, mode)}`)
      else {
        push(takers, 'preset', nodeId)
        for (const [key, value] of Object.entries(options.preset.metadata)) {
          const refusal = key === 'cameraMove' ? cameraMoveRefusal(node, mode) : key === 'cameraControl' ? cameraControlRefusal(node, mode) : undefined
          if (refusal !== undefined) skipped.push({ field: key, reason: refusal })
          else patch[key] = value
        }
        skipped.push(...options.preset.skipped)
        for (const item of options.preset.skills) presetSkill(item.entry, item.vars)
        // A sheet purpose asks for one image; the preset's own count still wins.
        if (options.preset.skills.length > 0 && preset.count !== undefined) patch.count = preset.count
      }
    }
    if (options.cameraMove !== undefined) {
      const refusal = cameraMoveRefusal(node, mode)
      if (refusal !== undefined) skip('cameraMove', refusal)
      else {
        push(takers, 'cameraMove', nodeId)
        patch.cameraMove = options.cameraMove
      }
    }
    if (options.cameraControl !== undefined) {
      const refusal = cameraControlRefusal(node, mode)
      if (refusal !== undefined) skip('cameraControl', refusal)
      else {
        push(takers, 'cameraControl', nodeId)
        patch.cameraControl = mergeCameraControl(options.cameraControl, patch.cameraControl ?? node.metadata?.cameraControl, options.catalogs.camera!)
      }
    }
    for (const item of attached) {
      const { entry } = item
      // Made for this mode (as the canvas's picker lists skills); a video skill outside its video modes is kept, with a note below.
      if (!skillTakesMode(entry, mode)) {
        skip('skills', `${entry.id} is for ${entry.appliesTo.join(' and ')} generation; this ${nodeKind(node, mode)}`, `skill:${entry.id}`)
        continue
      }
      push(takers, `skill:${entry.id}`, nodeId)
      const existing = skills.find(skill => skill.id === entry.id)
      if (existing !== undefined) {
        // Attached already: its frozen snapshot stays; the values given replace its own.
        const vars = { ...existing.vars, ...item.vars }
        for (const key of item.unset) delete vars[key]
        if (!isDeepStrictEqual(vars, existing.vars)) {
          skills = skills.map(skill => (skill.id === entry.id ? { ...skill, vars } : skill))
          if (existing.appliedBy === 'writer') {
            notes.push(`${entry.id} was written into the prompt by 帮我写, so the storyboard does not compose it again: the new values apply once the prompt is written again or the person chooses 发送时再套用 on it`)
          }
        }
        if (existing.version < entry.version) notes.push(`${entry.id} stays at version ${existing.version} on this node; the catalogue has version ${entry.version} (the person can update it on the node, or clear the node's skills and attach it again)`)
      } else {
        const result = attachPromptSkill(skills, entry, item.vars)
        if (result.outcome === 'limit') {
          const appends = skills.filter(skill => skill.snapshot.kind === 'append').map(skill => skill.id)
          throw new CanvasToolError('CANVAS_SKILL_LIMIT', `${nodeId} already has ${PROMPT_SKILL_APPEND_LIMIT} append skills (${appends.join(', ')}) and takes no third: pass clear: ["skills"] with the skills it `
            + 'should keep, or attach fewer. Nothing was changed.')
        }
        skills = result.skills
        if (result.replaced !== undefined) notes.push(`${entry.id} replaced ${result.replaced.id} (a node takes one wrap skill)`)
      }
      const skill = skills.find(candidate => candidate.id === entry.id)!
      const missing = missingSkillVars(skill.snapshot, skill.vars, { seconds })
      if (missing.length > 0) throw missingVarsError(skill.snapshot, entry.id, missing, ` on ${nodeId}`)
      skillsTouched = true
      Object.assign(patch, skillPurposePatch(entry))
      const outside = videoModeNote(entry, node, mode)
      if (outside !== undefined) notes.push(outside)
    }
    if (options.frameRoles !== undefined) {
      const refusal = frameRolesRefusal(node, mode)
      if (refusal !== undefined) skip('frameRoles', refusal)
      else {
        const images = frameImageIds(node, boardNodes, connections)
        const missing = (['first', 'last'] as const).map(role => options.frameRoles![role]).filter((id): id is string => typeof id === 'string' && !images.includes(id))
        if (missing.length > 0) {
          skip('frameRoles', `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not among the images this node takes (${images.length > 0 ? images.join(', ') : 'none yet: wire the frame images into it first'})`)
        } else {
          push(takers, 'frameRoles', nodeId)
          let roles: FrameRoles = { ...readFrameRoles(node.metadata?.frameRoles) }
          for (const role of ['first', 'last'] as const) {
            const value = options.frameRoles[role]
            if (value === null) delete roles[role]
            else if (typeof value === 'string') roles = assignFrameRole(roles, role, value)
          }
          patch.frameRoles = roles.first !== undefined || roles.last !== undefined ? roles : null
          if (!usesFrameRoles(node.metadata?.videoMode)) {
            notes.push(`first and last frames apply only once the node's video mode is image-to-video (图生视频) or first-last-frame (首尾帧); this node's is ${normalizeVideoMode(node.metadata?.videoMode) ?? 'not set'}. `
              + 'Save one of them with canvas_apply_ops update_node metadata.videoMode if the node\'s model offers it (media_models lists a model\'s modes).')
          }
        }
      }
    }
    for (const field of options.clear) if (field !== 'skills') patch[field] = null
    if (skillsTouched) {
      patch.promptSkills = storedPromptSkills(skills)
      touched.add(nodeId)
    }
    finalSkills.set(nodeId, skills)
    const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => {
      const current = node.metadata?.[key]
      return value === null ? current !== undefined && current !== null : !isDeepStrictEqual(current, value)
    }))
    if (Object.keys(changes).length > 0) ops.push({ type: 'update_node', id: nodeId, metadata: changes })
    return {
      nodeId,
      set: Object.keys(patch).filter(key => patch[key] !== null).map(reportLabel),
      cleared: Object.keys(patch).filter(key => patch[key] === null).map(reportLabel),
      skipped,
      changed: Object.keys(changes).length > 0,
      ...(notes.length > 0 ? { notes } : {}),
    }
  })

  // One skill node per skill given as: 'node', wired straight into the nodes it applies to (C1).
  const skillNodes: PlannedSkillNode[] = []
  const already = new Set<string>()
  const right = boardNodes.length > 0 ? Math.max(...boardNodes.map(node => node.position.x + node.width)) + 80 : 0
  for (const item of skillNodeInputs) {
    const { entry } = item
    const snapshot = snapshotOfSkill(entry)
    const vars = { ...defaultSkillVars(snapshot), ...item.vars }
    for (const key of item.unset) delete vars[key]
    // Required variables: an auto one reads each node's duration when it is sent.
    const values = skillVariableValues(snapshot, vars)
    const missing = snapshot.variables.filter(variable => variable.required === true && variable.auto === undefined && values[variable.key]!.trim() === '').map(variable => variable.key)
    if (missing.length > 0) throw missingVarsError(snapshot, entry.id, missing, ' (the skill node)')
    const targets: string[] = []
    for (const entryReport of applied) {
      const node = nodes.get(entryReport.nodeId)!
      const mode = nodeGenerationMode(node)
      if (!skillTakesMode(entry, mode)) {
        entryReport.skipped.push({ field: 'skills', reason: `${entry.id} is for ${entry.appliesTo.join(' and ')} generation; this ${nodeKind(node, mode)}` })
        push(reasons, `skill:${entry.id}`, `${node.id} (${entry.id} is for ${entry.appliesTo.join(' and ')} generation; this ${nodeKind(node, mode)})`)
        continue
      }
      if (finalSkills.get(node.id)?.some(skill => skill.id === entry.id) === true) {
        entryReport.skipped.push({ field: 'skills', reason: `already has ${entry.id} attached` })
        already.add(entry.id)
        continue
      }
      const wired = wiredSkillNodes(node, boardNodes, connections).find(source => source.skill.id === entry.id)
      if (wired !== undefined) {
        entryReport.skipped.push({ field: 'skills', reason: `already takes ${entry.id} from skill node ${wired.node.id}` })
        already.add(entry.id)
        continue
      }
      push(takers, `skill:${entry.id}`, node.id)
      targets.push(node.id)
      const outside = videoModeNote(entry, node, mode)
      if (outside !== undefined) entryReport.notes = [...entryReport.notes ?? [], outside]
    }
    if (targets.length === 0) continue
    // A skill node with this skill, version and values already on the board serves the new nodes too.
    const reuse = boardNodes.find((node) => {
      const state = readSkillNode(node)
      return state !== null && state.id === entry.id && state.version === entry.version && isDeepStrictEqual(state.vars, vars)
    })
    const id = reuse?.id ?? `skill-${randomUUID()}`
    if (reuse === undefined) {
      const top = Math.min(...targets.map(target => nodes.get(target)!.position.y))
      const created = skillNodes.filter(planned => planned.created).length
      ops.push({
        type: 'add_node',
        id,
        nodeType: 'skill',
        title: entry.name.zh,
        position: { x: right, y: top + created * (SKILL_NODE_SIZE.height + 40) },
        metadata: { status: 'idle', ...skillNodeMetadata(entry, options.catalogs.skills?.catalogVersion ?? '', vars) },
      })
    }
    for (const target of targets) ops.push({ type: 'connect_nodes', fromNodeId: id, toNodeId: target })
    for (const report of applied) if (targets.includes(report.nodeId)) report.skillNodes = [...report.skillNodes ?? [], id]
    skillNodes.push({ id, skill: entry.id, version: entry.version, created: reuse === undefined, wiredTo: targets })
  }

  const requested: Array<[string, string]> = [
    ...(options.preset !== undefined ? [['preset', 'preset'] as [string, string]] : []),
    ...(options.cameraMove !== undefined ? [['cameraMove', 'cameraMove'] as [string, string]] : []),
    ...(options.cameraControl !== undefined ? [['cameraControl', 'cameraControl'] as [string, string]] : []),
    ...(options.frameRoles !== undefined ? [['frameRoles', 'frameRoles'] as [string, string]] : []),
    ...(options.skills ?? []).filter(skill => !already.has(skill.entry.id)).map((skill): [string, string] => [`skill:${skill.entry.id}`, `skill ${skill.entry.id}`]),
  ]
  for (const [key, name] of requested) {
    if ((takers.get(key) ?? []).length === 0) {
      throw new CanvasToolError('CANVAS_OPTION_MODE', `None of these nodes takes ${name}: ${(reasons.get(key) ?? []).join('; ')}. Nothing was changed.`)
    }
  }

  // How each touched node's skills take part when it is generated, on the board the call leaves.
  const reported = applied.filter(entry => touched.has(entry.nodeId) || entry.skillNodes !== undefined)
  if (reported.length > 0 && snapshot !== null) {
    let after: BoardSnapshot | undefined
    try {
      after = applyBoardOps(snapshot, ops)
    } catch {
      after = undefined
    }
    for (const entry of after !== undefined ? reported : []) {
      const node = after!.nodes!.find(item => item.id === entry.nodeId)!
      entry.skills = promptSkillUses(node, after!.nodes ?? [], after!.connections ?? [], nodeGenerationMode(node), nodeSeconds(node)).map(use => ({
        id: use.id,
        source: use.source === 'node' ? 'node' : 'skill-node',
        ...(use.nodeId !== undefined ? { nodeId: use.nodeId } : {}),
        state: use.state,
        ...(use.missing.length > 0 ? { missing: use.missing } : {}),
      }))
    }
  }
  return { ops, applied, skillNodes }
}

// ---------------------------------------------------------------------------
// canvas_create_generation_flow: the new generation node's skills and frames
// ---------------------------------------------------------------------------

/** The prompt skills of a new generation node: its own skills, the 制作类型 they set, the skill nodes wired into it, and notes. */
export interface FlowSkills {
  skills: NodePromptSkill[]
  purpose: ReturnType<typeof skillPurposePatch>
  nodes: Array<{ title: string; metadata: Record<string, unknown> }>
  notes: string[]
}

/**
 * The skills a flow's generation node starts with: the preset's (attached as
 * the canvas's presets attach them, required values may follow), then the
 * call's attached skills (required values must be given), and one skill node
 * per skill given as: 'node'.
 * @param skills - the call's skills, checked.
 * @param preset - the preset, if any.
 * @param seconds - the duration the node will send, if set.
 * @param catalogVersion - the skill catalogue's version, for skill nodes.
 * @returns the skills, purpose, skill nodes and notes.
 */
export function flowSkills(skills: readonly CheckedSkill[], preset: PresetSettings | undefined, seconds: string | undefined, catalogVersion: string): FlowSkills {
  let attached: NodePromptSkill[] = []
  const purpose: FlowSkills['purpose'] = {}
  const notes: string[] = []
  const context = { seconds: seconds ?? DEFAULT_VIDEO_SECONDS }
  for (const item of preset?.skills ?? []) {
    const result = attachPromptSkill(attached, item.entry, item.vars)
    if (result.outcome === 'limit') {
      notes.push(`${item.entry.id} was left out: the generation node already has ${PROMPT_SKILL_APPEND_LIMIT} append skills`)
      continue
    }
    attached = result.skills
    Object.assign(purpose, skillPurposePatch(item.entry))
    const skill = attached.find(candidate => candidate.id === item.entry.id)!
    const missing = missingSkillVars(skill.snapshot, skill.vars, context)
    if (missing.length > 0) notes.push(`${missingVarsText(skill.snapshot, item.entry.id, missing, '')} Until then the lines that use ${missing.length > 1 ? 'them' : 'it'} are left out.`)
  }
  for (const item of skills.filter(skill => skill.as === 'attach')) {
    const { entry } = item
    const existing = attached.find(skill => skill.id === entry.id)
    if (existing !== undefined) {
      const vars = { ...existing.vars, ...item.vars }
      for (const key of item.unset) delete vars[key]
      attached = attached.map(skill => (skill.id === entry.id ? { ...skill, vars } : skill))
    } else {
      const result = attachPromptSkill(attached, entry, item.vars)
      if (result.outcome === 'limit') {
        throw new CanvasToolError('CANVAS_SKILL_LIMIT', `With the preset's skills the generation node would hold more than ${PROMPT_SKILL_APPEND_LIMIT} append skills `
          + `(${[...attached.filter(skill => skill.snapshot.kind === 'append').map(skill => skill.id), entry.id].join(', ')}); attach fewer.`)
      }
      attached = result.skills
      if (result.replaced !== undefined) notes.push(`${entry.id} replaced the preset's ${result.replaced.id} (a node takes one wrap skill)`)
    }
    const skill = attached.find(candidate => candidate.id === entry.id)!
    const missing = missingSkillVars(skill.snapshot, skill.vars, context)
    if (missing.length > 0) throw missingVarsError(skill.snapshot, entry.id, missing, '')
    Object.assign(purpose, skillPurposePatch(entry))
  }
  const nodes = skills.filter(skill => skill.as === 'node').map((item) => {
    const { entry } = item
    const snapshot = snapshotOfSkill(entry)
    const vars = { ...defaultSkillVars(snapshot), ...item.vars }
    for (const key of item.unset) delete vars[key]
    const values = skillVariableValues(snapshot, vars)
    const missing = snapshot.variables.filter(variable => variable.required === true && variable.auto === undefined && values[variable.key]!.trim() === '').map(variable => variable.key)
    if (missing.length > 0) throw missingVarsError(snapshot, entry.id, missing, ' (the skill node)')
    if (attached.some(skill => skill.id === entry.id)) notes.push(`${entry.id} is attached to the generation node too, which uses its own: the skill node adds nothing to it`)
    return { title: entry.name.zh, metadata: { status: 'idle', ...skillNodeMetadata(entry, catalogVersion, vars) } }
  })
  return { skills: attached, purpose, nodes, notes }
}

/**
 * Put a flow's first and last frames on its generation node: each id must be
 * an image the node takes once the flow is built (one of referenceNodeIds, or
 * an image of a group or screenplay source among them).
 * @param ops - the flow's ops; the generation node's add_node gets metadata.frameRoles.
 * @param snapshot - the board before the flow.
 * @param input - the roles, checked for shape.
 */
export function flowFrameRoles(ops: BoardOp[], snapshot: BoardSnapshot | null, input: FrameRolesInput): void {
  const config = ops.find(op => op.type === 'add_node' && op.nodeType === 'config')
  if (config === undefined || typeof config.id !== 'string') return
  const board = applyBoardOps(snapshot ?? { nodes: [], connections: [] }, ops.filter(op => op.type !== 'run_generation'))
  const node = board.nodes!.find(item => item.id === config.id)!
  const images = frameImageIds(node, board.nodes ?? [], board.connections ?? [])
  const roles: FrameRoles = {}
  for (const role of ['first', 'last'] as const) {
    const id = input[role]
    if (typeof id !== 'string') continue
    if (!images.includes(id)) {
      throw invalid(`frameRoles.${role} ${id} is not among the images this flow wires in (${images.length > 0 ? images.join(', ') : 'none: pass the frame images in referenceNodeIds'}).`)
    }
    roles[role] = id
  }
  if (roles.first !== undefined || roles.last !== undefined) config.metadata = { ...record(config.metadata), frameRoles: roles }
}

// ---------------------------------------------------------------------------
// The prompt a generation would send (C2's 4000-character rule)
// ---------------------------------------------------------------------------

/** One input of a generation, as the canvas reads it (canvas-node-generation.ts readNodeGenerationResource). */
interface Resource {
  nodeId: string
  kind: 'text' | 'image' | 'video' | 'audio'
  text?: string
  /** A screenplay scene's text, which the canvas wraps in a source-context frame. */
  scene?: boolean
}

type GenerationInput = Resource | { nodeId: string; kind: 'group'; children: Resource[] }

/** The canvas's frame around a screenplay scene's text (canvas-node-generation.ts generationTextBlock). */
const SCENE_CONTEXT = ['【剧本来源上下文】以下整场资料用于人物、空间和剧情溯源，不代表本次全部演出。仅执行本次制作脚本指定的时间范围、动作和对白，不补入范围外情节或台词。', '【剧本来源上下文结束】'] as const

function storySnapshot(node: BoardNode): Record<string, unknown> | undefined {
  const snapshot = record(node.metadata?.storySource).snapshot
  return isRecord(snapshot) ? snapshot : undefined
}

/** A node's kind as a reference (canvas-resource-references.ts resourceKind; plugin node definitions other than the screenplay source are not known here; a skill node is never one). */
function resourceKind(node: BoardNode): Resource['kind'] | null {
  const metadata = node.metadata ?? {}
  if (node.type === 'image' && Boolean(metadata.content)) return 'image'
  if (node.type === 'video' && Boolean(metadata.content)) return 'video'
  if (node.type === 'audio' && Boolean(metadata.content)) return 'audio'
  if (node.type === 'text' && Boolean(metadata.content || metadata.prompt)) return 'text'
  if ((node.type === 'story-source' || node.type === 'text') && storySnapshot(node) !== undefined) return 'text'
  return null
}

function readResource(node: BoardNode): Resource[] {
  const snapshot = storySnapshot(node)
  if (snapshot !== undefined) {
    const references = Array.isArray(snapshot.references) ? snapshot.references.filter(isRecord) : []
    return [
      { nodeId: node.id, kind: 'text', text: String((node.type === 'text' || node.type === 'story-source' ? node.metadata?.content : undefined) ?? snapshot.productionText ?? snapshot.markdown ?? ''), scene: record(node.metadata?.storySource).objectKind === 'scene' },
      ...references.filter(reference => Boolean(reference.url) && ['available', 'relocated'].includes(String(reference.status)))
        .map((reference): Resource => ({ nodeId: `${node.id}:asset:${String(reference.assetId)}:${String(reference.assetVersionId)}`, kind: 'image' })),
    ]
  }
  const kind = resourceKind(node)
  if (kind === 'image' || kind === 'video' || kind === 'audio') return [{ nodeId: node.id, kind }]
  const text = String(node.metadata?.content || node.metadata?.prompt || '')
  return kind === 'text' && text !== '' ? [{ nodeId: node.id, kind: 'text', text }] : []
}

/** The inputs of a generation node (buildNodeGenerationInputs with getGenerationResourceNodes). */
function generationInputs(target: BoardNode, nodes: readonly BoardNode[], connections: readonly BoardConnection[]): GenerationInput[] {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const groupResources = (groupId: string): BoardNode[] => nodes.filter(node => node.metadata?.groupId === groupId && resourceKind(node) !== null)
  const isReference = (node: BoardNode): boolean => resourceKind(node) !== null || (node.type === 'group' && groupResources(node.id).length > 0)
  const contextInputs = (id: string): BoardNode[] => connections.filter(link => link.toNodeId === id)
    .map(link => byId.get(link.fromNodeId)).filter((node): node is BoardNode => node !== undefined && isReference(node))
  let sources: BoardNode[]
  if (target.type === 'video' && Boolean(target.metadata?.videoInputsInitialized)) sources = contextInputs(target.id)
  else {
    // An output used in a downstream config takes that config's other inputs.
    const toConfig = connections.find(link => link.fromNodeId === target.id && byId.get(link.toNodeId)?.type === 'config')
    const configInputs = toConfig !== undefined ? contextInputs(toConfig.toNodeId).filter(node => node.id !== target.id) : []
    sources = configInputs.length > 0 ? configInputs : contextInputs(target.id)
  }
  return sources.flatMap((node): GenerationInput[] => {
    if (node.type === 'group') {
      const children = groupResources(node.id).flatMap(readResource)
      return children.length > 0 ? [{ nodeId: node.id, kind: 'group', children }] : []
    }
    const resources = readResource(node)
    return storySnapshot(node) !== undefined && resources.length > 1 ? [{ nodeId: node.id, kind: 'group', children: resources }] : resources
  })
}

function flatten(inputs: readonly GenerationInput[]): Resource[] {
  const resources = inputs.flatMap(input => (input.kind === 'group' ? input.children : [input]))
  return [...new Map(resources.map(resource => [resource.nodeId, resource])).values()]
}

/**
 * The images a node takes, in connection order (groups and screenplay sources
 * expanded): what its frame roles may name (canvas-node-generation.ts frameImageIds).
 * @param node - the node.
 * @param nodes - the board's nodes.
 * @param connections - the board's connections.
 * @returns the image ids.
 */
export function frameImageIds(node: BoardNode, nodes: readonly BoardNode[], connections: readonly BoardConnection[]): string[] {
  return flatten(generationInputs(node, nodes, connections)).filter(resource => resource.kind === 'image').map(resource => resource.nodeId)
}

/** A reference's label in the generated prompt, in the page's UI language (its i18n strings). */
function referenceLabel(kind: Resource['kind'], index: number, isVideo: boolean, ui: PromptLanguage): string {
  const n = index + 1
  if (isVideo && kind !== 'text') return `@${kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : 'Audio'}${n}`
  if (kind === 'image') return ui === 'zh' ? `图片${n}` : `Image ${n}`
  if (kind === 'video') return ui === 'zh' ? `参考视频 ${n}` : `Reference videos ${n}`
  if (kind === 'audio') return ui === 'zh' ? `参考音频 ${n}` : `Reference audio ${n}`
  return ui === 'zh' ? `文本${n}` : `Text ${n}`
}

function textBlock(name: string, resource: Resource): string {
  const text = resource.text ?? ''
  return `【${name}】\n${resource.scene === true ? `${SCENE_CONTEXT[0]}\n${text}\n${SCENE_CONTEXT[1]}` : text}`
}

/** Node references and their rendered labels carry no language (prompt-composition.ts stripReferenceLabels). */
function detectLanguage(texts: readonly string[]): PromptLanguage | undefined {
  for (const text of texts) {
    const plain = text.replace(/@\[node:[^\]]+\]/gu, ' ').replace(/@(?:Image|Video|Audio)\d+/giu, ' ').replace(/【[^】\n]*】/gu, ' ')
    if (/\p{Script=Han}/u.test(plain)) return 'zh'
    if (/\p{L}/u.test(plain)) return 'en'
  }
  return undefined
}

/** What composition starts from: the person's text and the wired text blocks, and the texts the language is read from. */
export interface PromptParts {
  userText: string
  upstreamText: string
  languageText: string[]
}

type Assembled = PromptParts

/**
 * The prompt before composition, as buildNodeGenerationContext assembles it,
 * or undefined when the page would refuse the run for another reason (a video
 * prompt mentioning a node it cannot find).
 */
function assemble(target: BoardNode, prompt: string, inputs: readonly GenerationInput[], isVideo: boolean, compiled: boolean, ui: PromptLanguage, roles: FrameRoles | null): Assembled | undefined {
  const metadata = target.metadata ?? {}
  const composer = !compiled && target.type === 'config' && String(metadata.composerContent ?? '').trim() !== ''
    && (!metadata.videoPromptCompilation || /@\[node:[^\]]+\]/u.test(prompt))
  if (composer) {
    // buildComposerGenerationContext: each mention becomes its label, the mentioned texts follow as blocks.
    const byId = new Map(inputs.map(input => [input.nodeId, input]))
    const counts = { image: 0, video: 0, audio: 0, text: 0 }
    const labels = new Map<string, string>()
    const used: Resource[] = []
    const blocks: string[] = []
    // With frame roles the images are labelled in frame order first: the role images and the mentioned ones.
    if (roles !== null) {
      const images = new Map<string, Resource>()
      for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/gu)) {
        const input = byId.get(match[1]!)
        if (input !== undefined) for (const resource of flatten([input])) if (resource.kind === 'image' && !images.has(resource.nodeId)) images.set(resource.nodeId, resource)
      }
      for (const resource of flatten(inputs)) {
        if (resource.kind === 'image' && (resource.nodeId === roles.first || resource.nodeId === roles.last) && !images.has(resource.nodeId)) images.set(resource.nodeId, resource)
      }
      for (const id of frameOrder([...images.keys()], roles)) {
        labels.set(id, referenceLabel('image', counts.image++, isVideo, ui))
        used.push(images.get(id)!)
      }
    }
    let hasToken = false
    let last = 0
    let next = ''
    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/gu)) {
      hasToken = true
      next += prompt.slice(last, match.index)
      const input = byId.get(match[1]!)
      if (input !== undefined) {
        next += flatten([input]).map((resource) => {
          let name = labels.get(resource.nodeId)
          if (name === undefined) {
            name = referenceLabel(resource.kind, counts[resource.kind]++, isVideo, ui)
            labels.set(resource.nodeId, name)
            used.push(resource)
            if (resource.kind === 'text') blocks.push(textBlock(name, resource))
          }
          return resource.kind === 'text' ? `【${name}】` : name
        }).join('、')
      } else if (isVideo) return undefined // The page refuses a video prompt that mentions a node it cannot find.
      last = match.index + match[0].length
    }
    next += prompt.slice(last)
    if (blocks.length > 0) next = `${next.trim()}\n\n${blocks.join('\n\n')}`
    // The expanded text is the person's text here, so a wrap skill's {{prompt}} holds the blocks too (C.3).
    return { userText: hasToken ? next : prompt, upstreamText: '', languageText: [prompt, ...used.map(resource => resource.text ?? '')] }
  }
  const resources = flatten(inputs)
  const upstream = compiled ? '' : resources.filter(resource => resource.text).map((resource, index) => textBlock(referenceLabel('text', index, isVideo, ui), resource)).join('\n\n')
  return { userText: prompt, upstreamText: upstream, languageText: [prompt, ...(compiled ? [] : resources.map(resource => resource.text ?? ''))] }
}

/** The settings that change one run's prompt (prompt-composition.ts readPromptDirectives), read with the catalogues. */
interface Directives {
  mode: GenerationMode
  videoSeconds: string
  cameraMove?: CameraMoveSetting
  cameraControl?: CameraControlSetting
  wrap?: ComposedSkill
  appends: ComposedSkill[]
}

/** The run's directives; null when nothing composes; undefined when a catalogue a setting needs is not loaded (no estimate). */
function readDirectives(node: BoardNode, nodes: readonly BoardNode[], connections: readonly BoardConnection[], mode: GenerationMode, videoSeconds: string, catalogs: OptionCatalogs): Directives | null | undefined {
  const metadata = node.metadata ?? {}
  const directives: Directives = { mode, videoSeconds, appends: [] }
  if (cameraMoveRefusal(node, mode) === undefined && isRecord(metadata.cameraMove)) {
    if (catalogs.moves === undefined) return undefined
    const move = sanitizeCameraMove(metadata.cameraMove, catalogs.moves)
    if (move !== null) directives.cameraMove = move
  }
  if (cameraControlRefusal(node, mode) === undefined && isRecord(metadata.cameraControl)) {
    if (catalogs.camera === undefined) return undefined
    const camera = sanitizeCameraControl(metadata.cameraControl, catalogs.camera)
    if (camera !== null && camera.enabled) directives.cameraControl = camera
  }
  const uses = promptSkillUses(node, nodes, connections, mode, videoSeconds)
  const composed = ({ state: _state, missing: _missing, ...skill }: SkillUse): ComposedSkill => skill
  const active = uses.filter(use => use.state === 'active')
  const wrap = active.find(use => use.snapshot.kind === 'wrap')
  if (wrap !== undefined) directives.wrap = composed(wrap)
  directives.appends = active.filter(use => use.snapshot.kind === 'append').map(composed)
  const writer = uses.some(use => use.state === 'writer')
  return directives.cameraMove !== undefined || directives.cameraControl !== undefined || directives.wrap !== undefined || directives.appends.length > 0 || writer ? directives : null
}

const hasLine = (text: string, line: string): boolean => text.split(/\r?\n/u).some(existing => existing.trim() === line)

/** A block after content, one blank line apart (the canvas's SegmentBuilder.block); an empty text takes the block alone. */
const appendBlock = (text: string, block: string): string => (/\S/u.test(text) ? `${text.replace(/\s+$/u, '')}\n\n${block}` : block)

/**
 * The prompt a run sends (prompt-composition.ts composeGenerationPrompt): one
 * wrap skill around the person's text (its {{motion}} / {{camera}} slots
 * filled), the wired text blocks, up to two append skills, then the motion
 * line, the camera line and one merged avoid line — each line once, and left
 * out when a slot took it or an active skill drops it.
 */
function composePrompt(assembled: Assembled, directives: Directives, language: PromptLanguage, catalogs: OptionCatalogs): ComposedPrompt {
  const { userText, upstreamText } = assembled
  const base = upstreamText !== '' ? `${userText}\n\n${upstreamText}` : userText
  const wrap = directives.wrap
  const appends = directives.appends.slice(0, PROMPT_SKILL_APPEND_LIMIT)
  const active = [...(wrap !== undefined ? [wrap] : []), ...appends]
  const seconds = directives.videoSeconds
  const motion = directives.cameraMove !== undefined ? renderCameraMoveSentence(directives.cameraMove, catalogs.moves!, language) : ''
  const camera = directives.cameraControl !== undefined ? renderCameraDirectionSentence(directives.cameraControl, catalogs.camera!, language) : ''
  let text = wrap !== undefined ? renderPromptSkill(wrap.snapshot, wrap.vars, { prompt: userText, motion, camera, seconds }) : userText
  if (upstreamText !== '') text += `\n\n${upstreamText}`
  for (const skill of appends) {
    const block = renderPromptSkill(skill.snapshot, skill.vars, { seconds })
    // Exactly once: a block already in the text is not appended again.
    if (block.trim() !== '' && !text.includes(block)) text = appendBlock(text, block)
  }
  const slotted = (slot: 'motion' | 'camera', sentence: string): boolean => wrap !== undefined && sentence !== '' && skillSlotsLine(wrap.snapshot, slot)
  const dropped = (slot: 'motion' | 'camera'): boolean => active.some(skill => skill.snapshot.composes[slot] === 'drop')
  const body = text
  const lines: string[] = []
  const appendOnce = (line: string): void => {
    if (line !== '' && !hasLine(body, line) && !lines.includes(line)) lines.push(line)
  }
  if (directives.cameraMove !== undefined && !slotted('motion', motion) && !dropped('motion')) appendOnce(renderCameraMove(directives.cameraMove, catalogs.moves!, language))
  if (directives.cameraControl !== undefined && !slotted('camera', camera) && !dropped('camera')) appendOnce(renderCameraDirection(directives.cameraControl, catalogs.camera!, language))
  // One merged avoid line from the active skills; never in text mode.
  if (directives.mode !== 'text') appendOnce(avoidLine(active.map(skill => skill.snapshot), language))
  if (lines.length > 0) text = appendBlock(text, lines.join('\n'))
  return { prompt: text, base, lines, skills: active.map(skill => skill.id) }
}

/**
 * What a run's prompt is composed from, as the page assembles it in one of
 * its setups (buildNodeGenerationContext): the person's text with mentions as
 * labels (frame images first when frame roles apply) and the wired text blocks.
 * @param snapshot - the board as the run will find it.
 * @param run - the run: node, and the mode and prompt it names, if any.
 * @param ui - the page's UI language (the labels).
 * @param compiled - whether a saved screenplay compilation matches (the wired texts are left out).
 * @returns the parts, or undefined when the node is missing or the page would refuse the run for a mention it cannot find.
 */
export function promptPartsForRun(snapshot: BoardSnapshot, run: { nodeId: string; mode?: unknown; prompt?: unknown }, ui: PromptLanguage, compiled = false): PromptParts | undefined {
  const nodes = snapshot.nodes ?? []
  const target = nodes.find(node => node.id === run.nodeId)
  if (target === undefined) return undefined
  const metadata = target.metadata ?? {}
  const isVideo = nodeRunMode(target, run.mode) === 'video'
  const prepared = isVideo && savedVideoInputs(target)
  const inputs = generationInputs(prepared ? { ...target, metadata: { ...metadata, videoInputsInitialized: true } } : target, nodes, snapshot.connections ?? [])
  const roles = isVideo && usesFrameRoles(metadata.videoMode) ? readFrameRoles(metadata.frameRoles) : null
  return assemble(target, nodeRunPrompt(target, run.prompt), inputs, isVideo, compiled, ui, roles)
}

/** A composed prompt: the text sent, the text before composition, the lines appended and the skills applied. */
export interface ComposedPrompt {
  prompt: string
  base: string
  lines: string[]
  skills: string[]
}

/**
 * The prompt the page composes for a run of a node from the parts it
 * assembled, with the node's settings and skills (readPromptDirectives, then
 * composeGenerationPrompt).
 * @param snapshot - the board.
 * @param nodeId - the node.
 * @param mode - the run's mode.
 * @param parts - the person's text, the wired text blocks and the texts the language is read from.
 * @param ui - the page's UI language, when the texts carry none.
 * @param catalogs - the camera catalogues.
 * @returns the composed prompt; null when nothing composes (the prompt is the base); undefined when the node is missing or a catalogue a setting needs is not loaded.
 */
export function composeGenerationText(snapshot: BoardSnapshot, nodeId: string, mode: GenerationMode, parts: PromptParts, ui: PromptLanguage, catalogs: OptionCatalogs): ComposedPrompt | null | undefined {
  const nodes = snapshot.nodes ?? []
  const node = nodes.find(item => item.id === nodeId)
  if (node === undefined) return undefined
  const directives = readDirectives(node, nodes, snapshot.connections ?? [], mode, nodeSeconds(node), catalogs)
  if (directives === undefined || directives === null) return directives
  return composePrompt(parts, directives, detectLanguage(parts.languageText) ?? ui, catalogs)
}

/** A generation the page would refuse for length. */
export interface PromptLimitCheck {
  nodeId: string
  /** certain: refused however the page is set up; possible: refused in some (the UI language, a saved screenplay compilation). */
  refused: 'certain' | 'possible'
  /** The composed prompt's length (the largest that is refused). */
  length: number
  limit: number
  /** The lines composition would append (motion, camera, avoid). */
  lines: string[]
  /** The prompt skills composition would apply (wrap first). */
  skills: string[]
}

/** An old video result the page prepares before it runs it again (video-generation-input.ts prepareVideoOutputEditing). */
const savedVideoInputs = (node: BoardNode): boolean => {
  const metadata = node.metadata ?? {}
  return node.type === 'video' && !metadata.videoInputsInitialized
    && (metadata.videoGenerationInput !== undefined || record(metadata.storyOutputSource).inputs !== undefined || record(metadata.directorReviewOutput).inputs !== undefined)
}

/**
 * Whether the page would refuse to run a generation because what it composes
 * in — prompt skills (the node's own and its skill nodes'), the camera move
 * and camera lines, the avoid line — pushes the prompt over the limit while
 * the prompt without them is within it (C2; the person's own longer text is
 * still sent). The estimate follows the page — the mode and prompt the agent
 * bridge resolves (nodeRunMode, nodeRunPrompt), the mentions rendered as
 * labels, the wired texts as blocks, the skills rendered from their frozen
 * snapshots, the lines added once — over the setups it cannot see: the page's
 * UI language (labels) and whether a saved screenplay compilation still
 * matches (wired texts left out). A skill's duration variable reads the
 * node's seconds (the canvas's default when it has none), which the page may
 * fit to the model.
 * @param snapshot - the board as the run will find it.
 * @param run - the run: node, and the mode and prompt run_generation passes, if any.
 * @param catalogs - the camera catalogues; without the one a setting needs, there is no estimate.
 * @returns the refusal, or undefined when the run would go (or cannot be estimated).
 */
export function promptLimitCheck(snapshot: BoardSnapshot, run: { nodeId: string; mode?: unknown; prompt?: unknown }, catalogs: OptionCatalogs): PromptLimitCheck | undefined {
  const nodes = snapshot.nodes ?? []
  const connections = snapshot.connections ?? []
  const target = nodes.find(node => node.id === run.nodeId)
  if (target === undefined) return undefined
  const mode = nodeRunMode(target, run.mode)
  if (mode === 'audio') return undefined
  const metadata = target.metadata ?? {}
  const prompt = nodeRunPrompt(target, run.prompt)
  const directives = readDirectives(target, nodes, connections, mode, nodeSeconds(target), catalogs)
  if (directives === undefined || directives === null) return undefined
  const isVideo = mode === 'video'
  // An old video result takes its own wired inputs once the page prepares it, and may get a compilation receipt.
  const prepared = isVideo && savedVideoInputs(target)
  const inputs = generationInputs(prepared ? { ...target, metadata: { ...metadata, videoInputsInitialized: true } } : target, nodes, connections)
  const roles = isVideo && usesFrameRoles(metadata.videoMode) ? readFrameRoles(metadata.frameRoles) : null
  const outcomes: Array<{ refused: boolean; length: number; lines: string[]; skills: string[] }> = []
  for (const ui of ['zh', 'en'] as const) {
    for (const compiled of isVideo && (isRecord(metadata.videoPromptCompilation) || prepared) ? [false, true] : [false]) {
      const assembled = assemble(target, prompt, inputs, isVideo, compiled, ui, roles)
      if (assembled === undefined) return undefined
      const composed = composePrompt(assembled, directives, detectLanguage(assembled.languageText) ?? ui, catalogs)
      const length = composed.prompt.trim().length
      outcomes.push({ refused: length > PROMPT_LIMIT_LENGTH && composed.base.trim().length <= PROMPT_LIMIT_LENGTH, length, lines: composed.lines, skills: composed.skills })
    }
  }
  const refusing = outcomes.filter(outcome => outcome.refused)
  if (refusing.length === 0) return undefined
  const longest = refusing.reduce((best, outcome) => (outcome.length > best.length ? outcome : best))
  return {
    nodeId: target.id, refused: refusing.length === outcomes.length ? 'certain' : 'possible', length: longest.length, limit: PROMPT_LIMIT_LENGTH,
    lines: longest.lines, skills: longest.skills,
  }
}
