/**
 * Sound into the timeline (ported from Studio's `canvas-timeline-sound.ts`).
 *
 * The cut is a shot list; its sound is what sits on those shots: a line and
 * its caption, an effect, one music bed under everything. This module turns
 * a list of such items — or a script — into the commands the cut already
 * takes: `asset.place_version` on the voice and music tracks, `caption.add` /
 * `caption.link_audio`, `music.automation.set` for ducking and fades,
 * `audio.set_loudness` for the render's target.
 *
 * It places files; it never generates. A script with no files becomes
 * captions on the shots, which is what the editor's voice generation wants:
 * it speaks a caption and puts the audio where the caption is.
 *
 * Scripts are text nodes on the board, as in Studio, and — in this
 * workbench — the screenplays of the 剧本 tab, whose dialogue blocks are the
 * lines and whose speech records name the speakers.
 * @module dsh-film/timeline/sound
 */

import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative as relativePath, resolve, sep } from 'node:path'
import type { VideoEditorCommandPlan } from '../../vendor/video-editor-bridge.mjs'
import { parseStoryMarkdown } from '../screenwriter/contracts/index.js'
import type { StoryDocument } from '../screenwriter/contracts/types.js'
import { STORY_DIRECTORY } from '../screenwriter/service.js'
import { CANVAS_FILE_VERSION_PREFIX, executeTimelineCommands } from './commands.js'
import type { TimelineCommandResult } from './commands.js'
import type { TimelineStore } from './store.js'

/** Where an item sits: on a shot (by its shot id or its visual clip id), at an offset within it. */
interface SoundAnchor {
  shotId?: string
  at?: number
}

export interface SpeechItem extends SoundAnchor {
  kind: 'speech'
  text: string
  speaker?: string
  file?: string
  durationSeconds?: number
  caption?: boolean
  captionId?: string
  volume?: number
}

export interface SfxItem extends SoundAnchor {
  kind: 'sfx'
  file: string
  name?: string
  durationSeconds?: number
  volume?: number
}

export interface MusicDucking {
  threshold?: number
  floorGain?: number
  attackMs?: number
  releaseMs?: number
}

export interface MusicItem {
  kind: 'music'
  file: string
  name?: string
  start?: number
  durationSeconds?: number
  volume?: number
  ducking?: boolean | MusicDucking
  fadeInSeconds?: number
  fadeOutSeconds?: number
}

export type SoundItem = SpeechItem | SfxItem | MusicItem

export interface SoundRequest {
  baseRevision?: number
  dryRun?: boolean
  operationId?: string
  items?: SoundItem[]
  /** A text node on the board, a screenplay of the 剧本 tab, or the script itself. */
  script?: { nodeId?: string; storyDocumentId?: string; text?: string }
  loudness?: number | null
}

export interface SoundPlaced {
  index: number
  kind: SoundItem['kind']
  clipId?: string
  captionId?: string
  shotId?: string
  start: number
  end: number
  path?: string
  text?: string
}

export interface SoundResponse {
  result: TimelineCommandResult
  items: SoundPlaced[]
  warnings: string[]
}

export interface ScriptLine {
  text: string
  speaker?: string
  shot?: { number?: number; id?: string }
}

/** A script the editor's 剧本 menu offers. */
export interface ScriptSource {
  /** A board node id, or `story:<document id>` for a screenplay. */
  id: string
  source: 'board' | 'story'
  title: string
  lineCount: number
  preview: string
}

export class TimelineSoundError extends Error {
  override name = 'TimelineSoundError'

  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

const INVALID = 'CANVAS_TIMELINE_SOUND_INVALID'

/** Silence between two items placed one after the other on a shot. */
const ITEM_GAP_SECONDS = 0.2
/** A caption that shares a shot with others is never shorter than this. */
const MIN_CAPTION_SECONDS = 0.5

/** The id prefix of a screenplay offered as a script. */
export const STORY_SCRIPT_PREFIX = 'story:'

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const invalid = (message: string): TimelineSoundError => new TimelineSoundError(400, INVALID, message)

// ---------------------------------------------------------------------------
// Scripts

/** What a text node says: its content, or its first generated text. */
function textOfNode(node: Record<string, unknown>): string {
  const metadata = record(node.metadata)
  if (typeof metadata?.content === 'string' && metadata.content.trim() !== '') return metadata.content
  const texts = Array.isArray(metadata?.texts) ? metadata.texts : []
  const primary = texts.find(item => record(item)?.id === metadata?.primaryTextId) ?? texts[0]
  const content = record(primary)?.content
  return typeof content === 'string' ? content : ''
}

const SHOT_MARK = /^\s*(?:第\s*(\d+)\s*镜|#\s*(\d+)|\[([^\]]+)\]|@(\S+))\s*[:：.。、,，-]?\s*(.*)$/u
const SPEAKER = /^([^\s:：]{1,24})\s*(?:：\s*|:\s+)(.+)$/u

/**
 * A script as lines: one line of dialogue per text line, `名字：台词` naming
 * the speaker, and `第 N 镜` / `#N` / `[shot-id]` / `@shot-id` on a line of
 * its own (or ahead of a line) naming the shot the lines after it sit on.
 * Lines before any marker follow the shot order, one per shot.
 * @param text - the script.
 */
export function parseScript(text: string): ScriptLine[] {
  const lines: ScriptLine[] = []
  let shot: ScriptLine['shot'] | undefined
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '') continue
    const mark = SHOT_MARK.exec(line)
    if (mark) {
      const number = mark[1] ?? mark[2]
      const id = mark[3] ?? mark[4]
      shot = number !== undefined ? { number: Number(number) } : { id: String(id).trim() }
      line = (mark[5] ?? '').trim()
      if (line === '') continue
    }
    const spoken = SPEAKER.exec(line)
    lines.push({
      text: spoken ? spoken[2]!.trim() : line,
      ...(spoken ? { speaker: spoken[1]!.trim() } : {}),
      ...(shot ? { shot: { ...shot } } : {}),
    })
  }
  return lines
}

/** A dialogue block's speaker label: `**名字**` on a line of its own, first. */
const SPEAKER_LABEL = /^[\t \r\n]*(\*\*|__)([^\r\n]*?)\1[\t ]*(?:\r?\n|$)/

const profileName = (markdown: string): string => markdown.trim().split('\n')[0]?.replace(/^#{1,6}\s*/, '').trim() ?? ''

/** A screenplay as the 剧本 menu reads it. */
export type StorySource = Pick<StoryDocument, 'documentId' | 'title' | 'content' | 'parsed'>

/**
 * The workspace's screenplays, read and parsed without touching their
 * version history (reading through the screenplay service records a version
 * of any edit made outside it).
 * @param cwd - the workspace directory.
 */
export async function readStories(cwd: string): Promise<StorySource[]> {
  const directory = join(cwd, ...STORY_DIRECTORY.split('/'))
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const stories: StorySource[] = []
  for (const name of names.sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.md$/u.test(name)) continue
    const path = join(directory, name)
    const info = await lstat(path).catch(() => undefined)
    if (info === undefined || !info.isFile()) continue
    const content = await readFile(path, 'utf8')
    const parsed = parseStoryMarkdown(content)
    const documentId = name.slice(0, -3)
    stories.push({ documentId, title: parsed.metadata?.document.title ?? documentId, content, parsed })
  }
  return stories
}

/**
 * A screenplay's dialogue as script lines: each dialogue block one line, its
 * speaker from the screenplay's speech record (or the block's own label).
 * A screenplay without structure is read as a plain script.
 * @param document - the screenplay.
 */
export function storyScriptLines(document: Pick<StoryDocument, 'content' | 'parsed'>): ScriptLine[] {
  const metadata = document.parsed.metadata
  if (metadata === null) return parseScript(document.content)
  const blocks = new Map(document.parsed.blocks.map(block => [block.id, block]))
  const speakers = new Map(metadata.speech.map(item => [item.blockId, item.speakerId]))
  const names = new Map(metadata.entities.map(entity => [entity.id, profileName(blocks.get(entity.profileBlockId)?.markdown ?? '')]))
  const lines: ScriptLine[] = []
  for (const block of document.parsed.blocks) {
    const labelled = SPEAKER_LABEL.exec(block.markdown)
    if (!speakers.has(block.id) && block.kind !== 'dialogue' && block.kind !== 'speech' && labelled === null) continue
    const text = (labelled ? block.markdown.slice(labelled[0].length) : block.markdown).split(/\r?\n/).map(line => line.trim()).filter(Boolean).join(' ')
    if (text === '') continue
    const speakerId = speakers.get(block.id)
    const speaker = (speakerId !== undefined ? names.get(speakerId) : undefined) || labelled?.[2]?.trim() || undefined
    lines.push({ text, ...(speaker ? { speaker } : {}) })
  }
  return lines
}

const previewOf = (line: ScriptLine): string => `${line.speaker ? `${line.speaker}：` : ''}${line.text}`.slice(0, 60)

/**
 * Every text node on the board with something written in it, as a script.
 * @param document - the board.
 */
export function listScriptNodes(document: unknown): ScriptSource[] {
  const nodes = record(document)?.nodes
  if (!Array.isArray(nodes)) return []
  const scripts: ScriptSource[] = []
  for (const raw of nodes) {
    const node = record(raw)
    if (node?.type !== 'text' || typeof node.id !== 'string') continue
    const lines = parseScript(textOfNode(node))
    if (lines.length === 0) continue
    const first = lines[0]!
    const title = typeof node.title === 'string' && node.title.trim() !== '' ? node.title.trim() : first.text.slice(0, 24)
    scripts.push({ id: node.id, source: 'board', title, lineCount: lines.length, preview: previewOf(first) })
  }
  return scripts
}

/**
 * The screenplays with dialogue, as scripts.
 * @param documents - the screenplays.
 */
export function listStoryScripts(documents: readonly StorySource[]): ScriptSource[] {
  return documents.flatMap((document) => {
    const lines = storyScriptLines(document)
    if (lines.length === 0) return []
    return [{ id: `${STORY_SCRIPT_PREFIX}${document.documentId}`, source: 'story' as const, title: document.title || document.documentId, lineCount: lines.length, preview: previewOf(lines[0]!) }]
  })
}

/** The text of one node on the board, or null when there is no such text node. */
export function scriptTextOfNode(document: unknown, nodeId: string): string | null {
  const nodes = record(document)?.nodes
  if (!Array.isArray(nodes)) return null
  const node = nodes.map(record).find(item => item?.id === nodeId && item.type === 'text')
  return node ? textOfNode(node) : null
}

// ---------------------------------------------------------------------------
// The cut as shots

export interface CutShot {
  index: number
  clipId: string
  shotId?: string
  name: string
  /** Seconds into the cut; visual clips play one after the other. */
  start: number
  duration: number
}

function segmentsOf(project: Record<string, unknown> | null, key: string): Record<string, unknown>[] {
  const value = project?.[key]
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : []
}

/**
 * The visual clips of a cut with where each starts, the way the editor lays them out.
 * @param document - the cut.
 */
export function shotsOfCut(document: unknown): CutShot[] {
  const project = record(record(document)?.project)
  let start = 0
  return segmentsOf(project, 'visualSegments').flatMap((clip, index) => {
    if (typeof clip.id !== 'string') return []
    const duration = finite(clip.duration) && clip.duration > 0 ? clip.duration : 0
    const director = record(clip.director)
    const shot: CutShot = {
      index,
      clipId: clip.id,
      ...(typeof director?.shotId === 'string' ? { shotId: director.shotId } : {}),
      name: typeof clip.name === 'string' && clip.name !== '' ? clip.name : clip.id,
      start,
      duration,
    }
    start += duration
    return [shot]
  })
}

function findShot(shots: CutShot[], id: string): CutShot {
  const shot = shots.find(item => item.shotId === id) ?? shots.find(item => item.clipId === id)
  if (shot === undefined) throw new TimelineSoundError(422, 'CANVAS_TIMELINE_SOUND_SHOT_NOT_FOUND', `剪辑里没有镜头“${id}”`)
  return shot
}

/**
 * Script lines as speech items on the cut's shots: a named shot by its
 * number or id, an unnamed line on the next shot in order, and lines past
 * the last shot on the last shot. Captions only — the files come later.
 * @param lines - the script.
 * @param shots - the cut's shots.
 */
export function speechItemsFromScript(lines: ScriptLine[], shots: CutShot[]): SpeechItem[] {
  if (shots.length === 0) throw new TimelineSoundError(422, 'CANVAS_TIMELINE_SOUND_NO_SHOTS', '剪辑里还没有画面，先把镜头放上时间线再放台词。')
  let next = 0
  return lines.map((line) => {
    let shot: CutShot
    if (line.shot?.id !== undefined) {
      shot = findShot(shots, line.shot.id)
    } else if (line.shot?.number !== undefined) {
      const found = shots[line.shot.number - 1]
      if (found === undefined) throw new TimelineSoundError(422, 'CANVAS_TIMELINE_SOUND_SHOT_NOT_FOUND', `剧本写了第 ${line.shot.number} 镜，剪辑里只有 ${shots.length} 个镜头`)
      shot = found
    } else {
      shot = shots[Math.min(next, shots.length - 1)]!
      next += 1
    }
    return { kind: 'speech', text: line.text, ...(line.speaker ? { speaker: line.speaker } : {}), shotId: shot.clipId }
  })
}

// ---------------------------------------------------------------------------
// Items as a plan

function relativeFile(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${what} needs a project-relative file`)
  const relative = value.trim().replaceAll('\\', '/').replace(/^\.\//, '')
  if (posix.isAbsolute(relative) || relative.split('/').some(part => part === '..' || part === '.' || part === '')) {
    throw invalid(`${what}: "${value}" must be a path inside the project`)
  }
  return relative
}

function bounded(value: unknown, what: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!finite(value) || value < min || value > max) throw invalid(`${what} must be between ${min} and ${max}`)
  return value
}

function positive(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined
  if (!finite(value) || value <= 0) throw invalid(`${what} must be a positive number of seconds`)
  return value
}

function anchorOf(item: Record<string, unknown>, what: string): SoundAnchor {
  const anchor: SoundAnchor = {}
  if (item.shotId !== undefined) {
    if (typeof item.shotId !== 'string' || item.shotId.trim() === '') throw invalid(`${what}: shotId must be a shot id or a visual clip id`)
    anchor.shotId = item.shotId.trim()
  }
  const at = bounded(item.at, `${what}: at`, 0, 24 * 3600)
  if (at !== undefined) anchor.at = at
  return anchor
}

/**
 * The items a request carries, each checked, after the speech items its script parses into.
 * @param request - the request.
 * @param boardDocument - the board, for a script on it.
 * @param cutDocument - the cut, for its shots.
 * @param storyLines - the lines of the screenplay the request names, when it names one.
 */
export function resolveSoundItems(request: SoundRequest, boardDocument: unknown, cutDocument: unknown, storyLines?: ScriptLine[]): SoundItem[] {
  const fromScript = scriptItemsOf(request, boardDocument, cutDocument, storyLines)
  if (!Array.isArray(request.items)) {
    if (fromScript) return fromScript
    if (request.loudness !== undefined) return []
    throw invalid('items or script is required')
  }
  const items = request.items.map((raw, index): SoundItem => {
    const item = record(raw)
    const what = `items[${index}]`
    if (item === null) throw invalid(`${what} must be an object`)
    if (item.kind === 'speech') {
      if (typeof item.text !== 'string' || item.text.trim() === '') throw invalid(`${what}: a line needs its text`)
      const speech: SpeechItem = { kind: 'speech', text: item.text.trim(), ...anchorOf(item, what) }
      if (item.speaker !== undefined) {
        if (typeof item.speaker !== 'string') throw invalid(`${what}: speaker must be a string`)
        if (item.speaker.trim() !== '') speech.speaker = item.speaker.trim()
      }
      if (item.file !== undefined) speech.file = relativeFile(item.file, `${what}: file`)
      const duration = positive(item.durationSeconds, `${what}: durationSeconds`)
      if (duration !== undefined) speech.durationSeconds = duration
      if (item.caption !== undefined) {
        if (typeof item.caption !== 'boolean') throw invalid(`${what}: caption must be a boolean`)
        speech.caption = item.caption
      }
      if (item.captionId !== undefined) {
        if (typeof item.captionId !== 'string' || item.captionId.trim() === '') throw invalid(`${what}: captionId must be a caption clip id`)
        speech.captionId = item.captionId.trim()
      }
      const volume = bounded(item.volume, `${what}: volume`, 0, 4)
      if (volume !== undefined) speech.volume = volume
      return speech
    }
    if (item.kind === 'sfx') {
      const sfx: SfxItem = { kind: 'sfx', file: relativeFile(item.file, `${what}: file`), ...anchorOf(item, what) }
      if (item.name !== undefined) {
        if (typeof item.name !== 'string') throw invalid(`${what}: name must be a string`)
        if (item.name.trim() !== '') sfx.name = item.name.trim()
      }
      const duration = positive(item.durationSeconds, `${what}: durationSeconds`)
      if (duration !== undefined) sfx.durationSeconds = duration
      const volume = bounded(item.volume, `${what}: volume`, 0, 4)
      if (volume !== undefined) sfx.volume = volume
      return sfx
    }
    if (item.kind === 'music') {
      const music: MusicItem = { kind: 'music', file: relativeFile(item.file, `${what}: file`) }
      if (item.name !== undefined) {
        if (typeof item.name !== 'string') throw invalid(`${what}: name must be a string`)
        if (item.name.trim() !== '') music.name = item.name.trim()
      }
      const start = bounded(item.start, `${what}: start`, 0, 24 * 3600)
      if (start !== undefined) music.start = start
      const duration = positive(item.durationSeconds, `${what}: durationSeconds`)
      if (duration !== undefined) music.durationSeconds = duration
      const volume = bounded(item.volume, `${what}: volume`, 0, 4)
      if (volume !== undefined) music.volume = volume
      if (item.ducking !== undefined) {
        if (typeof item.ducking === 'boolean') music.ducking = item.ducking
        else {
          const ducking = record(item.ducking)
          if (ducking === null) throw invalid(`${what}: ducking must be true, false, or { threshold, floorGain, attackMs, releaseMs }`)
          const threshold = bounded(ducking.threshold, `${what}: ducking.threshold`, 0.001, 1)
          const floorGain = bounded(ducking.floorGain, `${what}: ducking.floorGain`, 0.01, 1)
          const attackMs = bounded(ducking.attackMs, `${what}: ducking.attackMs`, 0.1, 2000)
          const releaseMs = bounded(ducking.releaseMs, `${what}: ducking.releaseMs`, 10, 9000)
          music.ducking = {
            ...(threshold !== undefined ? { threshold } : {}),
            ...(floorGain !== undefined ? { floorGain } : {}),
            ...(attackMs !== undefined ? { attackMs } : {}),
            ...(releaseMs !== undefined ? { releaseMs } : {}),
          }
        }
      }
      const fadeIn = bounded(item.fadeInSeconds, `${what}: fadeInSeconds`, 0, 600)
      if (fadeIn !== undefined) music.fadeInSeconds = fadeIn
      const fadeOut = bounded(item.fadeOutSeconds, `${what}: fadeOutSeconds`, 0, 600)
      if (fadeOut !== undefined) music.fadeOutSeconds = fadeOut
      return music
    }
    throw invalid(`${what}: kind must be speech, sfx, or music`)
  })
  return fromScript ? [...fromScript, ...items] : items
}

function scriptItemsOf(request: SoundRequest, boardDocument: unknown, cutDocument: unknown, storyLines: ScriptLine[] | undefined): SpeechItem[] | null {
  const script = record(request.script)
  if (script === null) return null
  let lines: ScriptLine[]
  if (typeof script.storyDocumentId === 'string' && script.storyDocumentId !== '') {
    if (storyLines === undefined) throw new TimelineSoundError(404, 'CANVAS_TIMELINE_SOUND_STORY_NOT_FOUND', `没有这个剧本：${script.storyDocumentId}`)
    lines = storyLines
  } else if (typeof script.nodeId === 'string' && script.nodeId !== '') {
    const text = scriptTextOfNode(boardDocument, script.nodeId)
    if (text === null) throw new TimelineSoundError(404, 'CANVAS_TIMELINE_SOUND_NODE_NOT_FOUND', `分镜画布上没有文字节点“${script.nodeId}”`)
    lines = parseScript(text)
  } else if (typeof script.text === 'string') {
    lines = parseScript(script.text)
  } else {
    throw invalid('script needs a nodeId on the board, a storyDocumentId, or the text itself')
  }
  if (lines.length === 0) throw invalid('这份剧本里没有台词')
  return speechItemsFromScript(lines, shotsOfCut(cutDocument))
}

function loudnessOf(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!finite(value) || value < -24 || value > -6) throw invalid('loudness must be between -24 and -6 LUFS, or null to reset')
  return value
}

function clipName(item: SoundItem, index: number): string {
  if (item.kind === 'speech') return `${item.speaker ? `${item.speaker}：` : ''}${item.text}`.slice(0, 24)
  if (item.name) return item.name
  return posix.basename(item.file) || `${item.kind} ${index + 1}`
}

export interface SoundPlanInput {
  baseRevision: number
  document: unknown
  items: SoundItem[]
  /** Seconds per project-relative file, as probed. */
  durations: Map<string, number>
  loudness?: number | null | undefined
  /** Distinguishes this placement's operation ids and clip ids from an earlier one's. */
  planId: string
}

/**
 * The plan: for each item, in order, the audio placed on its shot (or after
 * the previous item) and, for a line, its caption — written new and linked,
 * or an existing one attached and aligned; for music, one bed on the music
 * track with ducking under the voice track and its fades as an envelope.
 * A line with no file and no length shares what is left of its shot with
 * the other such lines on it.
 * @param input - the cut, the items and what is known about their files.
 */
export function buildSoundPlan(input: SoundPlanInput): { plan: VideoEditorCommandPlan; items: SoundPlaced[]; warnings: string[] } {
  const project = record(record(input.document)?.project)
  const shots = shotsOfCut(input.document)
  const cutEnd = shots.reduce((end, shot) => Math.max(end, shot.start + shot.duration), 0)
  const audio = segmentsOf(project, 'audioSegments')
  const captionIds = new Set(segmentsOf(project, 'captionSegments').map(caption => caption.id))
  const existingClipIds = new Set([...audio, ...segmentsOf(project, 'visualSegments'), ...segmentsOf(project, 'musicSegments')].map(clip => clip.id))
  const operations: VideoEditorCommandPlan['operations'] = []
  const placed: SoundPlaced[] = []
  const warnings: string[] = []
  const opId = (step: string, n: number | string): string => `sound:${input.planId}:${step}:${n}`
  const versionId = (relative: string): string => `${CANVAS_FILE_VERSION_PREFIX}${relative}`
  const cursors = new Map<string, number>()
  let appendCursor = audio.reduce((end, clip) => Math.max(end, (finite(clip.start) ? clip.start : 0) + (finite(clip.duration) ? clip.duration : 0)), 0)
  const hasVoiceAfter = audio.length > 0 || input.items.some(item => item.kind !== 'music' && item.file !== undefined)

  // Lines with no file and no length share their shot; count them first.
  const sharing = new Map<string, number>()
  for (const item of input.items) {
    if (item.kind === 'speech' && item.file === undefined && item.durationSeconds === undefined && item.shotId !== undefined) {
      const shot = findShot(shots, item.shotId)
      sharing.set(shot.clipId, (sharing.get(shot.clipId) ?? 0) + 1)
    }
  }

  input.items.forEach((item, index) => {
    const n = index + 1
    if (item.kind === 'music') {
      const relative = item.file
      const fileSeconds = input.durations.get(relative) ?? item.durationSeconds
      if (fileSeconds === undefined) throw new TimelineSoundError(422, 'CANVAS_TIMELINE_SOUND_DURATION', `读不出 ${relative} 的时长，请给出 durationSeconds`)
      const start = item.start ?? 0
      let duration = Math.min(item.durationSeconds ?? fileSeconds, fileSeconds)
      if (cutEnd > 0 && start + duration > cutEnd + 1e-3) {
        duration = Math.max(MIN_CAPTION_SECONDS, cutEnd - start)
        warnings.push(`配乐比剪辑长，按剪辑的 ${cutEnd.toFixed(1)} s 截断`)
      } else if (cutEnd > 0 && start + duration < cutEnd - 1e-3) {
        warnings.push(`配乐在 ${(start + duration).toFixed(1)} s 结束，剪辑到 ${cutEnd.toFixed(1)} s；需要铺满时换一段更长的，或在剪辑台里循环`)
      }
      const clipId = `${input.planId}-music-${n}`
      operations.push({
        id: opId('place', n),
        type: 'asset.place_version',
        clipId,
        assetId: versionId(relative),
        versionId: versionId(relative),
        track: 'music',
        start,
        duration,
        name: clipName(item, index),
        ...(item.volume !== undefined ? { volume: item.volume } : {}),
      } as never)
      const duck = item.ducking === undefined ? hasVoiceAfter : item.ducking !== false
      const tuning = typeof item.ducking === 'object' ? item.ducking : {}
      const fadeIn = item.fadeInSeconds ?? 0
      const fadeOut = item.fadeOutSeconds ?? 0
      const envelope: Array<{ time: number; gain: number }> = []
      if (fadeIn > 0 || fadeOut > 0) {
        if (fadeIn + fadeOut >= duration) {
          warnings.push(`配乐的淡入淡出（${fadeIn} + ${fadeOut} s）不短于配乐本身，已忽略`)
        } else {
          envelope.push({ time: 0, gain: fadeIn > 0 ? 0 : 1 })
          if (fadeIn > 0) envelope.push({ time: fadeIn, gain: 1 })
          if (fadeOut > 0) envelope.push({ time: duration - fadeOut, gain: 1 })
          envelope.push({ time: duration, gain: fadeOut > 0 ? 0 : 1 })
        }
      }
      operations.push({
        id: opId('automation', n),
        type: 'music.automation.set',
        clipId,
        ducking: duck ? { enabled: true, speechBus: 'voiceover', ...tuning } : { enabled: false },
        envelope,
      } as never)
      placed.push({ index, kind: 'music', clipId, start, end: start + duration, path: relative })
      return
    }

    const shot = item.shotId !== undefined ? findShot(shots, item.shotId) : null
    const what = item.kind === 'speech' ? '台词' : '音效'
    let start: number
    if (shot !== null) {
      start = item.at !== undefined ? shot.start + item.at : cursors.get(shot.clipId) ?? shot.start
    } else {
      start = item.at ?? appendCursor
    }
    let relative: string | null = null
    let duration: number
    if (item.file !== undefined) {
      relative = item.file
      const seconds = input.durations.get(relative) ?? item.durationSeconds
      if (seconds === undefined) throw new TimelineSoundError(422, 'CANVAS_TIMELINE_SOUND_DURATION', `读不出 ${relative} 的时长，请给出 durationSeconds`)
      duration = seconds
    } else if (item.kind === 'sfx') {
      throw invalid(`items[${index}]: an effect needs a file`)
    } else if (item.durationSeconds !== undefined) {
      duration = item.durationSeconds
    } else {
      if (shot === null) throw invalid(`items[${index}]: a line with no file needs a shot to sit on, or durationSeconds`)
      const left = Math.max(1, sharing.get(shot.clipId) ?? 1)
      const room = shot.start + shot.duration - start
      duration = room > 0 ? Math.max(MIN_CAPTION_SECONDS, room / left) : MIN_CAPTION_SECONDS * 2
      sharing.set(shot.clipId, left - 1)
    }
    const end = start + duration
    let clipId: string | undefined
    let captionId: string | undefined
    if (relative !== null) {
      clipId = `${input.planId}-${item.kind}-${n}`
      if (existingClipIds.has(clipId)) throw new TimelineSoundError(409, 'CANVAS_TIMELINE_SOUND_CLIP_EXISTS', `剪辑里已有片段“${clipId}”，请换一个 operationId`)
      operations.push({
        id: opId('place', n),
        type: 'asset.place_version',
        clipId,
        assetId: versionId(relative),
        versionId: versionId(relative),
        track: 'audio',
        start,
        duration,
        name: clipName(item, index),
        ...(item.volume !== undefined ? { volume: item.volume } : {}),
      } as never)
    }
    if (item.kind === 'speech') {
      if (item.captionId !== undefined) {
        if (!captionIds.has(item.captionId)) throw new TimelineSoundError(422, 'CANVAS_TIMELINE_SOUND_CAPTION_NOT_FOUND', `剪辑里没有字幕“${item.captionId}”`)
        captionId = item.captionId
        if (clipId !== undefined) operations.push({ id: opId('link', n), type: 'caption.link_audio', clipId: captionId, audioClipId: clipId, align: true } as never)
      } else if (item.caption !== false) {
        captionId = `${input.planId}-caption-${n}`
        if (captionIds.has(captionId)) throw new TimelineSoundError(409, 'CANVAS_TIMELINE_SOUND_CLIP_EXISTS', `剪辑里已有字幕“${captionId}”，请换一个 operationId`)
        operations.push({ id: opId('caption', n), type: 'caption.add', clipId: captionId, text: item.text, start, end, ...(clipId !== undefined ? { audioClipId: clipId } : {}) } as never)
      }
    }
    if (shot !== null) {
      cursors.set(shot.clipId, end + ITEM_GAP_SECONDS)
      const shotEnd = shot.start + shot.duration
      if (end > shotEnd + 1e-3) warnings.push(`第 ${shot.index + 1} 镜的${what}比镜头长 ${(end - shotEnd).toFixed(1)} s（到 ${end.toFixed(1)} s，镜头在 ${shotEnd.toFixed(1)} s 结束）`)
    } else {
      appendCursor = end + ITEM_GAP_SECONDS
    }
    placed.push({
      index,
      kind: item.kind,
      ...(clipId !== undefined ? { clipId } : {}),
      ...(captionId !== undefined ? { captionId } : {}),
      ...(shot !== null ? { shotId: shot.shotId ?? shot.clipId } : {}),
      start,
      end,
      ...(relative !== null ? { path: relative } : {}),
      ...(item.kind === 'speech' ? { text: item.text } : {}),
    })
  })

  if (input.loudness !== undefined) {
    operations.push({ id: opId('loudness', 0), type: 'audio.set_loudness', targetLoudnessLufs: input.loudness } as never)
  }
  return { plan: { schemaVersion: 1, baseRevision: input.baseRevision, operations }, items: placed, warnings }
}

// ---------------------------------------------------------------------------
// Placing on the real cut

/** The file behind a film-relative path, proven inside the film (symlinks resolved on both sides). */
async function ownedFile(projectRoot: string, relative: string): Promise<string | null> {
  try {
    const root = await realpath(resolve(projectRoot))
    const file = await realpath(resolve(root, ...relative.split('/')))
    const inside = relativePath(root, file)
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null
    return (await stat(file)).isFile() ? file : null
  } catch {
    return null
  }
}

export interface PlaceSoundInput {
  store: TimelineStore
  /** The film folder. */
  projectRoot: string
  projectId: string
  boardId: string
  boardDocument: unknown
  request: SoundRequest
  /** The lines of the screenplay the request names, when it names one that exists. */
  storyLines?: ScriptLine[]
  /** Required for an apply; a dry run defaults to the current revision. */
  baseRevision?: number
  dryRun: boolean
  operationId: string
  /** Seconds a file lasts, when it can be read. */
  probeDuration?: (absolutePath: string) => Promise<number | undefined>
}

/**
 * Place sound on the cut.
 * @param input - the store, the board, the request and the revision reviewed.
 */
export async function placeSoundOnTimeline(input: PlaceSoundInput): Promise<SoundResponse> {
  const current = await input.store.read()
  const baseRevision = input.baseRevision ?? current.revision
  const loudness = loudnessOf(input.request.loudness)
  const items = resolveSoundItems(input.request, input.boardDocument, current.document, input.storyLines)
  const durations = new Map<string, number>()
  for (const item of items) {
    const relative = item.file
    if (relative === undefined || durations.has(relative)) continue
    const absolute = await ownedFile(input.projectRoot, relative)
    if (absolute === null) throw new TimelineSoundError(422, 'CANVAS_TIMELINE_SOUND_FILE_NOT_FOUND', `${relative} 不是影视项目里的文件`)
    const seconds = await input.probeDuration?.(absolute)
    if (seconds !== undefined && seconds > 0) durations.set(relative, seconds)
  }
  const { plan, items: placed, warnings } = buildSoundPlan({ baseRevision, document: current.document, items, durations, loudness, planId: input.operationId })
  const result = await executeTimelineCommands({
    store: input.store,
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    boardId: input.boardId,
    dryRun: input.dryRun,
    plan,
  })
  return { result, items: placed, warnings }
}
