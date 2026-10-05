/**
 * Prompt skills (提示词技能, spec C1/C3) as the agent's tools write and read
 * them: a node's `metadata.promptSkills` (frozen snapshots of catalogue
 * skills with their variables) and a skill node's `metadata.skillSnapshot` /
 * `skillVars` — one skill applied to every image, video and generation node it
 * is wired into directly.
 *
 * A skill is a node setting, never prompt text: the page composes it into the
 * prompt when the node is sent. The page owns what it means, so this module
 * writes and reads exactly what the canvas does — ported from the canvas's
 * web/src/lib/canvas/prompt-skills.ts and the skill part of
 * prompt-composition.ts (VibeDev's own code, canvas W10): the snapshot a node
 * freezes (variables included, C.4), the sanitizers (an unknown id, a broken
 * snapshot or a value of the wrong type is dropped, never thrown on), the
 * template rendering of C2, and which skills a node composes in a mode (one
 * wrap skill — the node's own beats a wired skill node's — and up to two
 * append skills). Pure; the catalogue is passed in.
 * @module dsh-film/canvas/prompt-skills
 */

import type { BoardConnection, BoardNode } from './board-ops.js'
import { PROMPT_SKILL_RESERVED, PROMPT_SKILL_TARGETS, PROMPT_SKILL_TEMPLATE_LIMIT, VIDEO_MODES } from './catalog.js'
import type { Bilingual, PromptSkillCompose, PromptSkillEntry, PromptSkillKind, PromptSkillTarget, PromptSkillVariable, VideoMode } from './catalog.js'
import { STORY_PRODUCTION_PURPOSES } from '../screenwriter/contracts/production.js'
import type { StoryProductionPurpose } from '../screenwriter/contracts/production.js'

export type SkillLanguage = 'zh' | 'en'

/** The frozen part a node keeps (C1 + C.4): it renders without the catalogue. */
export interface PromptSkillSnapshot {
  name: Bilingual
  kind: PromptSkillKind
  appliesTo: PromptSkillTarget[]
  videoModes?: string[]
  template: string
  negative?: string
  composes: { motion: PromptSkillCompose; camera: PromptSkillCompose }
  purpose?: StoryProductionPurpose
  variables: PromptSkillVariable[]
}

/** metadata.promptSkills[] (C1): at most one wrap and two append skills per node. */
export interface NodePromptSkill {
  id: string
  version: number
  /** Pre-filled with the defaults at attach time; an auto variable is left out so the node's value applies. */
  vars: Record<string, string>
  snapshot: PromptSkillSnapshot
  /** The prompt writer (帮我写) already wrote the text in this skill's structure; only the page sets it. */
  appliedBy?: 'writer'
}

/** metadata.skillSnapshot on a skill node (C1). */
export type SkillNodeSnapshot = PromptSkillSnapshot & { id: string; version: number; catalogVersion: string; frozenAt: string }

/** A skill node as composition reads it. */
export interface SkillNodeState {
  id: string
  version: number
  catalogVersion: string
  frozenAt: string
  snapshot: PromptSkillSnapshot
  vars: Record<string, string>
}

export const PROMPT_SKILL_WRAP_LIMIT = 1
export const PROMPT_SKILL_APPEND_LIMIT = 2
/** A variable value's longest length (the canvas keeps no more). */
export const SKILL_VALUE_LIMIT = 2000
/** The node types a skill node applies to when wired straight into them (C1). */
export const SKILL_TARGET_TYPES: readonly string[] = ['image', 'video', 'config']

const SKILL_ID = /^vd\.[a-z0-9]+(?:-[a-z0-9]+)*$/u
const VAR_KEY = /^[a-z][a-z0-9_]*$/u
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/gu
const NEGATIVE_LIMIT = 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const isEmpty = (value: string | undefined): boolean => value === undefined || value.trim() === ''

function readBilingual(value: unknown): Bilingual | null {
  return isRecord(value) && text(value.zh) && text(value.en) ? { zh: value.zh, en: value.en } : null
}

/**
 * A video mode as the canvas reads it ('frames' is an older name of first-last-frame).
 * @param value - metadata.videoMode.
 * @returns the mode, or undefined when it is not one.
 */
export function normalizeVideoMode(value: unknown): VideoMode | undefined {
  if (value === 'frames') return 'first-last-frame'
  return typeof value === 'string' && (VIDEO_MODES as readonly string[]).includes(value) ? value as VideoMode : undefined
}

/**
 * The placeholder keys of a text, in order (repeats kept).
 * @param value - the text.
 * @returns the keys.
 */
export function placeholderKeys(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map(match => match[1]!)
}

/**
 * A catalogue skill as the frozen snapshot a node keeps (C1 + C.4).
 * @param entry - the catalogue entry.
 * @returns the snapshot.
 */
export function snapshotOfSkill(entry: PromptSkillEntry): PromptSkillSnapshot {
  return {
    name: { ...entry.name },
    kind: entry.kind,
    appliesTo: [...entry.appliesTo],
    ...(entry.videoModes !== undefined && entry.videoModes.length > 0 ? { videoModes: [...entry.videoModes] } : {}),
    template: entry.template,
    ...(entry.negative !== undefined && entry.negative !== '' ? { negative: entry.negative } : {}),
    composes: { ...entry.composes },
    ...(entry.purpose !== undefined ? { purpose: entry.purpose } : {}),
    variables: entry.variables.map(variable => ({ ...variable, label: { ...variable.label } })),
  }
}

const sanitizeCompose = (value: unknown): PromptSkillCompose => (value === 'slot' || value === 'append' || value === 'drop' ? value : 'append')

function sanitizeVariables(value: unknown): PromptSkillVariable[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const variables: PromptSkillVariable[] = []
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.key !== 'string' || !VAR_KEY.test(raw.key) || seen.has(raw.key) || PROMPT_SKILL_RESERVED.includes(raw.key)) continue
    seen.add(raw.key)
    variables.push({
      key: raw.key,
      label: readBilingual(raw.label) ?? { zh: raw.key, en: raw.key },
      ...(typeof raw.default === 'string' ? { default: raw.default.slice(0, SKILL_VALUE_LIMIT) } : {}),
      ...(raw.required === true ? { required: true } : {}),
      ...(raw.auto === 'video.seconds' ? { auto: 'video.seconds' as const } : {}),
    })
  }
  return variables
}

/**
 * A frozen snapshot as composition reads it, or null when it is not one.
 * @param value - a snapshot as stored.
 * @returns the snapshot.
 */
export function sanitizeSkillSnapshot(value: unknown): PromptSkillSnapshot | null {
  if (!isRecord(value)) return null
  const name = readBilingual(value.name)
  const kind = value.kind === 'wrap' || value.kind === 'append' ? value.kind : null
  const appliesTo = Array.isArray(value.appliesTo) ? PROMPT_SKILL_TARGETS.filter(target => (value.appliesTo as unknown[]).includes(target)) : []
  if (name === null || kind === null || appliesTo.length === 0 || !text(value.template) || value.template.length > PROMPT_SKILL_TEMPLATE_LIMIT) return null
  const videoModes = Array.isArray(value.videoModes)
    ? [...new Set(value.videoModes.map(normalizeVideoMode).filter((mode): mode is VideoMode => mode !== undefined))]
    : []
  const composes = isRecord(value.composes) ? value.composes : {}
  return {
    name,
    kind,
    appliesTo,
    ...(videoModes.length > 0 ? { videoModes } : {}),
    template: value.template,
    ...(text(value.negative) ? { negative: value.negative.trim().slice(0, NEGATIVE_LIMIT) } : {}),
    composes: { motion: sanitizeCompose(composes.motion), camera: sanitizeCompose(composes.camera) },
    ...(typeof value.purpose === 'string' && (STORY_PRODUCTION_PURPOSES as readonly string[]).includes(value.purpose) ? { purpose: value.purpose as StoryProductionPurpose } : {}),
    variables: sanitizeVariables(value.variables),
  }
}

/** Variable values kept as strings, for declared keys only. */
function sanitizeVars(value: unknown, snapshot: PromptSkillSnapshot): Record<string, string> {
  if (!isRecord(value)) return {}
  const vars: Record<string, string> = {}
  for (const variable of snapshot.variables) {
    const raw = value[variable.key]
    if (typeof raw === 'string') vars[variable.key] = raw.slice(0, SKILL_VALUE_LIMIT)
    else if (typeof raw === 'number' && Number.isFinite(raw)) vars[variable.key] = String(raw)
  }
  return vars
}

/**
 * metadata.promptSkills as generation uses it: [] for none or a cleared null.
 * Unknown ids, broken snapshots and repeats are dropped; the first wrap skill
 * and the first two append skills are kept (C1).
 * @param value - metadata.promptSkills.
 * @returns the skills.
 */
export function sanitizePromptSkills(value: unknown): NodePromptSkill[] {
  if (!Array.isArray(value)) return []
  const skills: NodePromptSkill[] = []
  let wraps = 0
  let appends = 0
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !SKILL_ID.test(raw.id) || skills.some(skill => skill.id === raw.id)) continue
    const snapshot = sanitizeSkillSnapshot(raw.snapshot)
    if (snapshot === null) continue
    if (snapshot.kind === 'wrap' ? wraps >= PROMPT_SKILL_WRAP_LIMIT : appends >= PROMPT_SKILL_APPEND_LIMIT) continue
    if (snapshot.kind === 'wrap') wraps++
    else appends++
    skills.push({
      id: raw.id,
      version: Number.isSafeInteger(raw.version) && (raw.version as number) >= 1 ? raw.version as number : 1,
      vars: sanitizeVars(raw.vars, snapshot),
      snapshot,
      ...(raw.appliedBy === 'writer' ? { appliedBy: 'writer' as const } : {}),
    })
  }
  return skills
}

/**
 * The value to store: null once the last skill is gone (amendments C.8: update_node cannot delete a key).
 * @param skills - the node's skills.
 * @returns the stored value.
 */
export function storedPromptSkills(skills: readonly NodePromptSkill[]): NodePromptSkill[] | null {
  return skills.length > 0 ? [...skills] : null
}

/**
 * The defaults a new attachment starts with (C.4); auto variables stay out so the node's value applies.
 * @param snapshot - the skill's snapshot.
 * @returns the variables.
 */
export function defaultSkillVars(snapshot: PromptSkillSnapshot): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const variable of snapshot.variables) if (variable.default !== undefined && variable.auto === undefined) vars[variable.key] = variable.default
  return vars
}

/**
 * A node attachment of a catalogue skill: its snapshot, the defaults and the values given (never appliedBy).
 * @param entry - the catalogue entry.
 * @param vars - values given, already checked.
 * @returns the attachment.
 */
export function newNodePromptSkill(entry: PromptSkillEntry, vars: Record<string, string> = {}): NodePromptSkill {
  const snapshot = snapshotOfSkill(entry)
  return { id: entry.id, version: entry.version, vars: { ...defaultSkillVars(snapshot), ...sanitizeVars(vars, snapshot) }, snapshot }
}

/** What attaching a skill to a node's skills came to (the canvas's attachPromptSkill). */
export interface PromptSkillAttach {
  skills: NodePromptSkill[]
  /** added; replaced (a node takes one wrap skill: the old one went); limit (two append skills already); exists (already attached). */
  outcome: 'added' | 'replaced' | 'limit' | 'exists'
  replaced?: NodePromptSkill
}

/**
 * Attach a catalogue skill to a node's skills, as the canvas's picker and
 * presets do: the wrap skill comes first and replaces another wrap skill; a
 * third append skill is refused; an attached skill stays as it is.
 * @param skills - the node's skills, sanitized.
 * @param entry - the catalogue entry.
 * @param vars - values given, already checked.
 * @returns the skills and the outcome.
 */
export function attachPromptSkill(skills: readonly NodePromptSkill[], entry: PromptSkillEntry, vars?: Record<string, string>): PromptSkillAttach {
  if (skills.some(skill => skill.id === entry.id)) return { skills: [...skills], outcome: 'exists' }
  const skill = newNodePromptSkill(entry, vars)
  if (entry.kind === 'wrap') {
    const replaced = skills.find(item => item.snapshot.kind === 'wrap')
    return { skills: [skill, ...skills.filter(item => item.snapshot.kind !== 'wrap')], outcome: replaced !== undefined ? 'replaced' : 'added', ...(replaced !== undefined ? { replaced } : {}) }
  }
  if (skills.filter(item => item.snapshot.kind === 'append').length >= PROMPT_SKILL_APPEND_LIMIT) return { skills: [...skills], outcome: 'limit' }
  return { skills: [...skills, skill], outcome: 'added' }
}

/**
 * The metadata a skill node holds for a catalogue skill (C1).
 * @param entry - the catalogue entry.
 * @param catalogVersion - the catalogue's version.
 * @param vars - values given, already checked.
 * @param frozenAt - when the snapshot was taken.
 * @returns skillSnapshot and skillVars.
 */
export function skillNodeMetadata(entry: PromptSkillEntry, catalogVersion: string, vars: Record<string, string> = {}, frozenAt = new Date().toISOString()): { skillSnapshot: SkillNodeSnapshot; skillVars: Record<string, string> } {
  const snapshot = snapshotOfSkill(entry)
  return {
    skillSnapshot: { ...snapshot, id: entry.id, version: entry.version, catalogVersion, frozenAt },
    skillVars: { ...defaultSkillVars(snapshot), ...sanitizeVars(vars, snapshot) },
  }
}

/**
 * A skill node's skill, or null for any other node or one without a readable skill.
 * @param node - the node.
 * @returns the skill.
 */
export function readSkillNode(node: BoardNode | undefined): SkillNodeState | null {
  if (node === undefined || node.type !== 'skill') return null
  const raw = node.metadata?.skillSnapshot
  const snapshot = sanitizeSkillSnapshot(raw)
  if (snapshot === null || !isRecord(raw) || typeof raw.id !== 'string' || !SKILL_ID.test(raw.id)) return null
  return {
    id: raw.id,
    version: Number.isSafeInteger(raw.version) && (raw.version as number) >= 1 ? raw.version as number : 1,
    catalogVersion: typeof raw.catalogVersion === 'string' ? raw.catalogVersion : '',
    frozenAt: typeof raw.frozenAt === 'string' ? raw.frozenAt : '',
    snapshot,
    vars: sanitizeVars(node.metadata?.skillVars, snapshot),
  }
}

/** What a skill's variables read from the node: the duration the request sends ('video.seconds'). */
export interface SkillContext {
  seconds?: string
}

/**
 * Each declared variable's value: typed, else its default, else its auto value, else empty (C2).
 * @param snapshot - the skill's snapshot.
 * @param vars - the values typed.
 * @param context - what auto variables read.
 * @returns the values.
 */
export function skillVariableValues(snapshot: PromptSkillSnapshot, vars: Record<string, string>, context: SkillContext = {}): Record<string, string> {
  const values: Record<string, string> = {}
  for (const variable of snapshot.variables) {
    const typed = vars[variable.key]
    values[variable.key] = typed !== undefined ? typed : variable.default !== undefined ? variable.default : variable.auto === 'video.seconds' ? context.seconds?.trim() ?? '' : ''
  }
  return values
}

/**
 * Required variables without a value: the keys, in declaration order.
 * @param snapshot - the skill's snapshot.
 * @param vars - the values typed.
 * @param context - what auto variables read.
 * @returns the keys.
 */
export function missingSkillVars(snapshot: PromptSkillSnapshot, vars: Record<string, string>, context: SkillContext = {}): string[] {
  const values = skillVariableValues(snapshot, vars, context)
  return snapshot.variables.filter(variable => variable.required === true && isEmpty(values[variable.key])).map(variable => variable.key)
}

/**
 * Whether a skill is made for a generation mode at all (appliesTo), whatever
 * the node's video mode — what a node can take, as the canvas's picker lists
 * skills (promptSkillsForMode); {@link skillApplies} says whether it composes.
 * @param skill - the skill (snapshot or catalogue entry).
 * @param mode - the generation mode.
 * @returns whether it is.
 */
export function skillTakesMode(skill: Pick<PromptSkillSnapshot, 'appliesTo'>, mode: string | undefined): boolean {
  return mode !== undefined && (skill.appliesTo as readonly string[]).includes(mode)
}

/**
 * Whether a skill applies to a generation in this mode (and, for video, the node's explicit video mode) — C.6.
 * @param snapshot - the skill (snapshot or catalogue entry).
 * @param mode - the generation mode.
 * @param videoMode - the node's saved video mode.
 * @returns whether it applies.
 */
export function skillApplies(snapshot: Pick<PromptSkillSnapshot, 'appliesTo' | 'videoModes'>, mode: string | undefined, videoMode?: unknown): boolean {
  if (mode === undefined || !(snapshot.appliesTo as readonly string[]).includes(mode)) return false
  if (mode !== 'video' || snapshot.videoModes === undefined || snapshot.videoModes.length === 0) return true
  const explicit = normalizeVideoMode(videoMode)
  return explicit !== undefined && snapshot.videoModes.includes(explicit)
}

// ---------------------------------------------------------------------------
// Rendering (C2), as the canvas renders a template
// ---------------------------------------------------------------------------

/** A run of rendered skill text: template text, or the person's prompt where {{prompt}} stood. */
interface Piece {
  text: string
  kind: 'skill' | 'prompt'
}

const AFTER_EMPTY = /^[：。；，:;,.]/u
const DANGLING = /[，；,;]$/u
const TERMINAL = /[。！？.!?]$/u

const piecesText = (pieces: readonly Piece[]): string => pieces.map(piece => piece.text).join('')

function pushPiece(pieces: Piece[], value: string, kind: Piece['kind']): void {
  if (value === '') return
  const last = pieces[pieces.length - 1]
  if (last !== undefined && last.kind === kind) last.text += value
  else pieces.push({ text: value, kind })
}

/** The line holding {{prompt}}: an empty placeholder goes with the one punctuation mark after it; a dangling '，' or '；' at the end goes too. */
function renderPromptLine(line: string, values: Record<string, string | undefined>): Piece[] | null {
  const pieces: Piece[] = []
  let cursor = 0
  let dropPunctuation = false
  let endsEmpty = false
  for (const match of line.matchAll(PLACEHOLDER)) {
    let literal = line.slice(cursor, match.index)
    if (dropPunctuation) literal = literal.replace(AFTER_EMPTY, '')
    pushPiece(pieces, literal, 'skill')
    const value = values[match[1]!]
    dropPunctuation = isEmpty(value)
    if (!dropPunctuation) pushPiece(pieces, value!.trim(), match[1] === 'prompt' ? 'prompt' : 'skill')
    cursor = match.index + match[0].length
    endsEmpty = dropPunctuation
  }
  let tail = line.slice(cursor)
  if (dropPunctuation) tail = tail.replace(AFTER_EMPTY, '')
  if (tail !== '') endsEmpty = false
  pushPiece(pieces, tail, 'skill')
  if (endsEmpty) {
    const last = pieces[pieces.length - 1]
    if (last?.kind === 'skill') last.text = last.text.replace(DANGLING, '')
  }
  const kept = pieces.filter(piece => piece.text !== '')
  return piecesText(kept).trim() !== '' ? kept : null
}

/** Any other line: segments between '；' or ';' whose placeholders are all empty go; a line left empty is dropped; a final '。' that went is put back. */
function renderPlainLine(line: string, values: Record<string, string | undefined>): Piece[] | null {
  const parts = line.split(/([；;])/u)
  const segments: Array<{ text: string; separator?: string }> = []
  for (let index = 0; index < parts.length; index += 2) segments.push({ text: parts[index]!, ...(parts[index + 1] !== undefined ? { separator: parts[index + 1] } : {}) })
  const keep = segments.map((segment) => {
    const keys = placeholderKeys(segment.text)
    return keys.length === 0 || keys.some(key => !isEmpty(values[key]))
  })
  const kept = segments.filter((_, index) => keep[index])
  if (kept.length === 0) return null
  const pieces: Piece[] = []
  kept.forEach((segment, index) => {
    let cursor = 0
    for (const match of segment.text.matchAll(PLACEHOLDER)) {
      pushPiece(pieces, segment.text.slice(cursor, match.index), 'skill')
      const value = values[match[1]!]
      if (!isEmpty(value)) pushPiece(pieces, value!.trim(), 'skill')
      cursor = match.index + match[0].length
    }
    pushPiece(pieces, segment.text.slice(cursor), 'skill')
    if (index < kept.length - 1) pushPiece(pieces, segment.separator ?? '；', 'skill')
  })
  if (!keep[segments.length - 1] && /。\s*$/u.test(line) && !TERMINAL.test(piecesText(pieces).trimEnd())) pushPiece(pieces, '。', 'skill')
  return piecesText(pieces).trim() !== '' ? pieces : null
}

/**
 * A template with its placeholders filled (the C2 rendering rules).
 * @param template - the template.
 * @param values - the values, by placeholder key.
 * @returns the text.
 */
export function renderSkillTemplate(template: string, values: Record<string, string | undefined>): string {
  const pieces: Piece[] = []
  let first = true
  for (const line of template.split(/\r?\n/u)) {
    const keys = placeholderKeys(line)
    const rendered = keys.length === 0 ? [{ text: line, kind: 'skill' as const }] : keys.includes('prompt') ? renderPromptLine(line, values) : renderPlainLine(line, values)
    if (rendered === null) continue
    if (!first) pushPiece(pieces, '\n', 'skill')
    first = false
    for (const piece of rendered) pushPiece(pieces, piece.text, piece.kind)
  }
  return piecesText(pieces.filter(piece => piece.text !== ''))
}

/** What composition fills a skill's reserved slots with. */
export interface SkillSlots extends SkillContext {
  /** The person's text, for a wrap skill's {{prompt}}. */
  prompt?: string
  /** The bare camera-move sentence, for {{motion}} when the skill composes it as a slot. */
  motion?: string
  /** The bare camera sentence, for {{camera}} when the skill composes it as a slot. */
  camera?: string
}

/**
 * A skill's text from its snapshot alone: variables, then the reserved slots (C2, C.4, C.6).
 * @param snapshot - the skill's snapshot.
 * @param vars - its variables.
 * @param slots - the prompt and the motion and camera sentences.
 * @returns the text.
 */
export function renderPromptSkill(snapshot: PromptSkillSnapshot, vars: Record<string, string>, slots: SkillSlots = {}): string {
  return renderSkillTemplate(snapshot.template, {
    ...skillVariableValues(snapshot, vars, slots),
    prompt: snapshot.kind === 'wrap' ? slots.prompt ?? '' : '',
    motion: snapshot.composes.motion === 'slot' ? slots.motion ?? '' : '',
    camera: snapshot.composes.camera === 'slot' ? slots.camera ?? '' : '',
  })
}

/**
 * Whether a skill's template has a {{motion}} or {{camera}} slot that composition fills.
 * @param snapshot - the skill's snapshot.
 * @param slot - the slot.
 * @returns whether it does.
 */
export function skillSlotsLine(snapshot: PromptSkillSnapshot, slot: 'motion' | 'camera'): boolean {
  return snapshot.kind === 'wrap' && snapshot.composes[slot] === 'slot' && placeholderKeys(snapshot.template).includes(slot)
}

/**
 * The one merged avoid line (C2): zh '避免：a、b、c', en 'Avoid: a, b, c'; empty without terms.
 * @param snapshots - the active skills.
 * @param language - the prompt's language.
 * @returns the line.
 */
export function avoidLine(snapshots: ReadonlyArray<Pick<PromptSkillSnapshot, 'negative'>>, language: SkillLanguage): string {
  const terms: string[] = []
  for (const snapshot of snapshots) {
    for (const term of (snapshot.negative ?? '').split(/[、，,；;\n]+/u)) {
      const clean = term.trim().replace(/[。.]$/u, '')
      if (clean !== '' && !terms.includes(clean)) terms.push(clean)
    }
  }
  if (terms.length === 0) return ''
  return language === 'zh' ? `避免：${terms.join('、')}` : `Avoid: ${terms.join(', ')}`
}

/**
 * The node patch for attaching a skill with a purpose: the node's 制作类型
 * follows it, and a design sheet is one image per click (the canvas's skillPurposePatch).
 * @param snapshot - the skill.
 * @returns promptPurpose and count, when the skill has a purpose.
 */
export function skillPurposePatch(snapshot: Pick<PromptSkillSnapshot, 'purpose'>): { promptPurpose?: StoryProductionPurpose; count?: number } {
  if (snapshot.purpose === undefined) return {}
  return { promptPurpose: snapshot.purpose, ...(snapshot.purpose.endsWith('-sheet') ? { count: 1 } : {}) }
}

// ---------------------------------------------------------------------------
// Which skills a node composes (prompt-composition.ts promptSkillUses)
// ---------------------------------------------------------------------------

/**
 * Whether a node takes prompt skills in this mode: image and video modes on
 * image, video and config nodes; text mode on a config node or a text node
 * without content. Plugin nodes keep their own panels.
 * @param node - the node.
 * @param mode - the generation mode.
 * @returns whether it does.
 */
export function acceptsPromptSkills(node: BoardNode | undefined, mode: string | undefined): boolean {
  if (node === undefined) return false
  if (mode === 'image' || mode === 'video') return SKILL_TARGET_TYPES.includes(node.type)
  if (mode === 'text') return node.type === 'config' || (node.type === 'text' && !(typeof node.metadata?.content === 'string' && node.metadata.content.trim() !== ''))
  return false
}

/**
 * The skill nodes wired straight into a node, in connection order, each once.
 * @param node - the node.
 * @param nodes - the board's nodes.
 * @param connections - the board's connections.
 * @returns each skill node and its skill.
 */
export function wiredSkillNodes(node: BoardNode | undefined, nodes: readonly BoardNode[], connections: readonly BoardConnection[]): Array<{ node: BoardNode; skill: SkillNodeState }> {
  if (node === undefined || !SKILL_TARGET_TYPES.includes(node.type)) return []
  const wired: Array<{ node: BoardNode; skill: SkillNodeState }> = []
  for (const connection of connections) {
    if (connection.toNodeId !== node.id || wired.some(item => item.node.id === connection.fromNodeId)) continue
    const source = nodes.find(item => item.id === connection.fromNodeId)
    const skill = readSkillNode(source)
    if (source !== undefined && skill !== null) wired.push({ node: source, skill })
  }
  return wired
}

/** A skill as composition applies it: the node's own (source 'node') or a wired skill node's ('upstream'). */
export interface ComposedSkill {
  id: string
  version: number
  vars: Record<string, string>
  snapshot: PromptSkillSnapshot
  source: 'node' | 'upstream'
  /** The skill node, for an upstream skill. */
  nodeId?: string
}

/**
 * How one skill takes part in a node's prompt: active (composed in), writer
 * (帮我写 already followed it), mode / video-mode (it does not apply here),
 * duplicate (a skill node repeats one the node has), wrap-ignored (another wrap
 * skill is used), append-limit (beyond two append skills). missing lists the
 * required variables left empty.
 */
export interface SkillUse extends ComposedSkill {
  state: 'active' | 'writer' | 'mode' | 'video-mode' | 'duplicate' | 'wrap-ignored' | 'append-limit'
  missing: string[]
}

/**
 * The skills of a node, in order — its own, then the skill nodes wired into
 * it — and how each takes part (C2): one wrap skill, the node's own beating a
 * wired one; up to two append skills, the node's own first. A skill the writer
 * followed still holds its place.
 * @param node - the node.
 * @param nodes - the board's nodes.
 * @param connections - the board's connections.
 * @param mode - the generation mode.
 * @param videoSeconds - the duration the request sends; the node's own seconds when not given.
 * @returns the uses.
 */
export function promptSkillUses(node: BoardNode | undefined, nodes: readonly BoardNode[], connections: readonly BoardConnection[], mode: string | undefined, videoSeconds?: string): SkillUse[] {
  if (node === undefined || !acceptsPromptSkills(node, mode)) return []
  const explicitMode = mode === 'video' ? node.metadata?.videoMode : undefined
  const seconds = videoSeconds ?? (typeof node.metadata?.seconds === 'string' ? node.metadata.seconds : undefined)
  const uses: SkillUse[] = [
    ...sanitizePromptSkills(node.metadata?.promptSkills).map((skill): SkillUse => ({
      id: skill.id, version: skill.version, vars: skill.vars, snapshot: skill.snapshot, source: 'node', state: skill.appliedBy === 'writer' ? 'writer' : 'active', missing: [],
    })),
    ...wiredSkillNodes(node, nodes, connections).map(({ node: source, skill }): SkillUse => ({
      id: skill.id, version: skill.version, vars: skill.vars, snapshot: skill.snapshot, source: 'upstream', nodeId: source.id, state: 'active', missing: [],
    })),
  ]
  let wraps = 0
  let appends = 0
  const placed = new Set<string>()
  for (const use of uses) {
    if (!skillApplies(use.snapshot, mode, explicitMode)) {
      use.state = mode === 'video' && use.snapshot.videoModes !== undefined && use.snapshot.videoModes.length > 0 && use.snapshot.appliesTo.includes('video') ? 'video-mode' : 'mode'
      continue
    }
    if (placed.has(use.id)) {
      use.state = 'duplicate'
      continue
    }
    if (use.snapshot.kind === 'wrap' ? wraps >= PROMPT_SKILL_WRAP_LIMIT : appends >= PROMPT_SKILL_APPEND_LIMIT) {
      use.state = use.snapshot.kind === 'wrap' ? 'wrap-ignored' : 'append-limit'
      continue
    }
    placed.add(use.id)
    if (use.snapshot.kind === 'wrap') wraps++
    else appends++
    if (use.state === 'active') use.missing = missingSkillVars(use.snapshot, use.vars, seconds !== undefined ? { seconds } : {})
  }
  return uses
}

// ---------------------------------------------------------------------------
// Compact views for the agent's reads
// ---------------------------------------------------------------------------

/**
 * A node's prompt skills as the agent reads them: id, version, kind, name and
 * variables (the frozen template is left out), as the page reads them.
 * @param value - metadata.promptSkills.
 * @returns the skills, or undefined when there are none (cleared with null, none readable).
 */
export function compactPromptSkills(value: unknown): Array<Record<string, unknown>> | undefined {
  const skills = sanitizePromptSkills(value)
  if (skills.length === 0) return undefined
  return skills.map(skill => ({
    id: skill.id, version: skill.version, kind: skill.snapshot.kind, name: skill.snapshot.name.zh, vars: skill.vars,
    ...(skill.appliedBy !== undefined ? { appliedBy: skill.appliedBy } : {}),
  }))
}

const skillNodeOf = (metadata: Record<string, unknown>): SkillNodeState | null =>
  readSkillNode({ id: '', type: 'skill', position: { x: 0, y: 0 }, width: 0, height: 0, metadata })

const compactState = (state: SkillNodeState): Record<string, unknown> => ({
  id: state.id, version: state.version, ...(state.catalogVersion !== '' ? { catalogVersion: state.catalogVersion } : {}), kind: state.snapshot.kind, name: state.snapshot.name.zh,
  appliesTo: state.snapshot.appliesTo, ...(state.snapshot.videoModes !== undefined ? { videoModes: state.snapshot.videoModes } : {}),
})

/**
 * A skill node's skill as the agent reads it (the frozen template left out).
 * @param snapshot - metadata.skillSnapshot.
 * @returns the skill, or undefined when it is not readable.
 */
export function compactSkillSnapshot(snapshot: unknown): Record<string, unknown> | undefined {
  const state = skillNodeOf({ skillSnapshot: snapshot })
  return state === null ? undefined : compactState(state)
}

/**
 * A skill node's skill and its variables, as the saved board's summary shows them.
 * @param metadata - the skill node's metadata.
 * @returns the skill, or undefined when it is not readable.
 */
export function compactSkillNode(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const state = skillNodeOf(metadata)
  return state === null ? undefined : { ...compactState(state), vars: state.vars }
}
