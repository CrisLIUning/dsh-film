/**
 * Subtitles on the board's video nodes (C1), by the storyboard page's rules
 * (canvas `web/src/lib/subtitles/subtitle-cues.ts`, VibeDev's own), so what
 * the agent's tools read and write — and what a cut or a join the Host lands
 * carries — reads the same in the page. A node keeps:
 * - `subtitleEntries`: cues in the time of its WHOLE source file (not of its
 *   clip), sorted by start, at most 5000, text up to 2000 characters, each with
 *   a stable id (`[A-Za-z0-9_-]{1,64}`; a nanoid of 10 for a new cue);
 * - `subtitleStyle`: how they are drawn (`v: 1`; the size is a % of the
 *   picture height);
 * - `subtitleUpdatedAt` and `subtitleMediaKey` (the video they were saved
 *   against: content|bytes|durationMs, an unknown part empty), so a replaced
 *   video can be flagged.
 *
 * Every reader goes through here: broken or unknown values are dropped, never
 * thrown, and `null` is "cleared" (amendments C.8: an agent's `update_node`
 * cannot delete a key). Cut, split and join results remap their cues through
 * canvas/media-time.ts, as the page's do.
 * @module dsh-film/canvas/subtitles
 */

import { createHash, randomBytes } from 'node:crypto'
import { cutCues, joinCues, siblingCues } from './media-time.js'
import type { TimeRange } from './media-time.js'
import { DEFAULT_MAX_CHARS_PER_ENTRY, MAX_CHARS_PER_ENTRY_LIMIT, MIN_CHARS_PER_ENTRY } from './subtitle-resegment.js'

export const MAX_SUBTITLE_ENTRIES = 5000
export const MAX_SUBTITLE_TEXT = 2000
/** A saved and a current length this close are the same video (players and probes round differently). */
export const SUBTITLE_DURATION_TOLERANCE_MS = 250

/** One cue (C1 `subtitleEntries[]`). */
export interface SubtitleEntry {
  id: string
  startMs: number
  endMs: number
  text: string
  highlight?: { start: number; end: number }
}

export type SubtitlePosition = 'bottom' | 'center' | 'top'
export type SubtitleBackdrop = 'none' | 'shadow' | 'box'

/** How cues are drawn (C1 `subtitleStyle`). */
export interface SubtitleStyle {
  v: 1
  /** Font size as a % of the displayed picture's height (2–12). */
  fontScale: number
  /** '#RRGGBB'. */
  color: string
  position: SubtitlePosition
  backdrop: SubtitleBackdrop
  /** 自动断句 splits longer cues at punctuation (20–60). */
  maxCharsPerEntry: number
  /** Split long cues when a file is imported. */
  autoResegment: boolean
}

export const SUBTITLE_FONT_SCALE_RANGE = { min: 2, max: 12 } as const
export const SUBTITLE_POSITIONS: readonly SubtitlePosition[] = ['top', 'center', 'bottom']
export const SUBTITLE_BACKDROPS: readonly SubtitleBackdrop[] = ['none', 'shadow', 'box']
export const DEFAULT_SUBTITLE_STYLE: Readonly<SubtitleStyle> = Object.freeze({
  v: 1,
  fontScale: 5,
  color: '#FFFFFF',
  position: 'bottom',
  backdrop: 'shadow',
  maxCharsPerEntry: DEFAULT_MAX_CHARS_PER_ENTRY,
  autoResegment: true,
})

type Metadata = Record<string, unknown> | undefined | null

export const SUBTITLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u
/** nanoid's alphabet: 64 characters, so a random byte's low six bits pick one evenly. */
const ID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const integerOf = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const isHighSurrogate = (code: number): boolean => code >= 0xD800 && code <= 0xDBFF

/**
 * The id of a new cue: a nanoid of 10.
 * @returns the id.
 */
export function newSubtitleId(): string {
  let id = ''
  for (const byte of randomBytes(10)) id += ID_ALPHABET[byte & 63]
  return id
}

/** A deterministic id (10 characters of nanoid's alphabet) for a cue that arrives without a usable one, so reading the same data twice gives the same ids. */
function derivedId(seed: string): string {
  let a = 0x811C9DC5
  let b = 0x9747B28C
  for (let index = 0; index < seed.length; index++) {
    const code = seed.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x5BD1E995)
    b ^= b >>> 13
  }
  let id = ''
  for (let index = 0; index < 10; index++) {
    const lane = index < 5 ? a >>> 0 : b >>> 0
    id += ID_ALPHABET[(lane >>> ((index % 5) * 6)) & 63]
  }
  return id
}

/**
 * Text with Unix line ends and no surrounding blank space.
 * @param value - the text.
 * @returns the normalized text.
 */
export function normalizeSubtitleText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/[ \t]+\n/gu, '\n').trim()
}

/** At most `max` UTF-16 units, never cutting a surrogate pair in two. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max)
}

function highlightIn(value: unknown, text: string): SubtitleEntry['highlight'] {
  if (!isRecord(value)) return undefined
  const start = integerOf(value.start)
  const end = integerOf(value.end)
  return start !== undefined && end !== undefined && start >= 0 && end > start && end <= text.length ? { start, end } : undefined
}

interface LegacyHighlight { start: number; end: number; highlightText: string }

/** Open AI Canvas keeps highlights beside the cues (`subtitleHighlights`, keyed by the cue's index); boards from it may carry them. */
function legacyHighlights(raw: unknown): Map<number, LegacyHighlight> {
  const map = new Map<number, LegacyHighlight>()
  if (!Array.isArray(raw)) return map
  for (const item of raw) {
    if (!isRecord(item)) continue
    const entryIndex = integerOf(item.entryIndex)
    const start = integerOf(item.start)
    const end = integerOf(item.end)
    if (entryIndex === undefined || start === undefined || end === undefined || typeof item.highlightText !== 'string' || map.has(entryIndex)) continue
    map.set(entryIndex, { start, end, highlightText: item.highlightText })
  }
  return map
}

export interface SubtitleSanitizeReport {
  entries: SubtitleEntry[]
  /** Items that were no cue: no times, end <= start, or no text. */
  dropped: number
  /** Cues whose text was cut to {@link MAX_SUBTITLE_TEXT}. */
  truncated: number
  /** Cues past {@link MAX_SUBTITLE_ENTRIES}, left out. */
  overLimit: number
}

/**
 * Cues as C1 stores them, from our shape or Open AI Canvas's (`SrtEntry[]`
 * with an `index`, plus `subtitleHighlights`): whole milliseconds, a start of
 * at least 0, end > start, trimmed non-empty text of at most 2000 characters,
 * a highlight only when it lies inside the text, sorted by start, at most
 * 5000, unique ids. Anything else is dropped and counted; nothing throws.
 * @param raw - the stored or given cues.
 * @param legacy - Open AI Canvas's `subtitleHighlights`, when there are any.
 * @returns the cues and what was dropped, cut or left out.
 */
export function sanitizeSubtitleEntries(raw: unknown, legacy?: unknown): SubtitleSanitizeReport {
  const report: SubtitleSanitizeReport = { entries: [], dropped: 0, truncated: 0, overLimit: 0 }
  if (!Array.isArray(raw)) return report
  const oldHighlights = legacyHighlights(legacy)
  const kept: Array<{ entry: SubtitleEntry; order: number }> = []
  raw.forEach((item: unknown, order) => {
    if (!isRecord(item) || typeof item.text !== 'string') {
      report.dropped++
      return
    }
    let startMs = integerOf(item.startMs)
    const endMs = integerOf(item.endMs)
    if (startMs === undefined || endMs === undefined) {
      report.dropped++
      return
    }
    startMs = Math.max(0, startMs)
    const full = normalizeSubtitleText(item.text)
    if (endMs <= startMs || full === '') {
      report.dropped++
      return
    }
    const text = cutText(full, MAX_SUBTITLE_TEXT)
    if (text.length < full.length) report.truncated++
    let highlight = highlightIn(item.highlight, text)
    const index = integerOf(item.index)
    const old = highlight === undefined && index !== undefined ? oldHighlights.get(index) : undefined
    if (old !== undefined && old.end > old.start && old.start >= 0 && text.slice(old.start, old.end) === old.highlightText) highlight = { start: old.start, end: old.end }
    const id = typeof item.id === 'string' && SUBTITLE_ID_PATTERN.test(item.id) ? item.id : derivedId(`${order}|${startMs}|${endMs}|${text}`)
    kept.push({ entry: { id, startMs, endMs, text, ...(highlight !== undefined ? { highlight } : {}) }, order })
  })
  kept.sort((a, b) => a.entry.startMs - b.entry.startMs || a.entry.endMs - b.entry.endMs || a.order - b.order)
  report.overLimit = Math.max(0, kept.length - MAX_SUBTITLE_ENTRIES)
  const seen = new Set<string>()
  for (const { entry } of kept.slice(0, MAX_SUBTITLE_ENTRIES)) {
    let id = entry.id
    for (let copy = 2; seen.has(id); copy++) id = `${entry.id.slice(0, 56)}-${copy}`
    seen.add(id)
    report.entries.push(id === entry.id ? entry : { ...entry, id })
  }
  return report
}

/**
 * A node's cues, sanitized. `null` (cleared) and anything that is no list read as none.
 * @param metadata - the node's metadata.
 * @returns the cues.
 */
export function readSubtitleEntries(metadata: Metadata): SubtitleEntry[] {
  const raw = metadata?.subtitleEntries
  if (!Array.isArray(raw) || raw.length === 0) return []
  return sanitizeSubtitleEntries(raw, metadata?.subtitleHighlights).entries
}

/**
 * '#RRGGBB' (upper case) from '#RGB' or '#RRGGBB'.
 * @param value - the colour as given.
 * @returns the colour, or `undefined` for anything else.
 */
export function normalizeSubtitleColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value.trim())
  if (match === null) return undefined
  const hex = match[1]!.length === 3 ? [...match[1]!].map(digit => digit + digit).join('') : match[1]!
  return `#${hex.toUpperCase()}`
}

/**
 * A style as C1 stores it; missing or broken fields take the defaults (Open AI
 * Canvas's pixel font size is not carried over).
 * @param raw - the stored or given style.
 * @returns the style.
 */
export function sanitizeSubtitleStyle(raw: unknown): SubtitleStyle {
  if (!isRecord(raw)) return { ...DEFAULT_SUBTITLE_STYLE }
  const fontScale = typeof raw.fontScale === 'number' && Number.isFinite(raw.fontScale)
    ? clamp(Math.round(raw.fontScale * 10) / 10, SUBTITLE_FONT_SCALE_RANGE.min, SUBTITLE_FONT_SCALE_RANGE.max)
    : DEFAULT_SUBTITLE_STYLE.fontScale
  const maxChars = integerOf(raw.maxCharsPerEntry)
  return {
    v: 1,
    fontScale,
    color: normalizeSubtitleColor(raw.color) ?? DEFAULT_SUBTITLE_STYLE.color,
    position: SUBTITLE_POSITIONS.includes(raw.position as SubtitlePosition) ? raw.position as SubtitlePosition : DEFAULT_SUBTITLE_STYLE.position,
    backdrop: SUBTITLE_BACKDROPS.includes(raw.backdrop as SubtitleBackdrop) ? raw.backdrop as SubtitleBackdrop : DEFAULT_SUBTITLE_STYLE.backdrop,
    maxCharsPerEntry: maxChars === undefined ? DEFAULT_SUBTITLE_STYLE.maxCharsPerEntry : clamp(maxChars, MIN_CHARS_PER_ENTRY, MAX_CHARS_PER_ENTRY_LIMIT),
    autoResegment: typeof raw.autoResegment === 'boolean' ? raw.autoResegment : DEFAULT_SUBTITLE_STYLE.autoResegment,
  }
}

/**
 * A node's subtitle style, sanitized: the page's defaults when it has none.
 * @param metadata - the node's metadata.
 * @returns the style.
 */
export function readSubtitleStyle(metadata: Metadata): SubtitleStyle {
  return sanitizeSubtitleStyle(metadata?.subtitleStyle)
}

const keyPart = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) ? String(value) : ''

/**
 * The video a node shows, as `subtitleMediaKey` records it: content + '|' +
 * bytes + '|' + durationMs, an unknown part empty.
 * @param metadata - the node's metadata (or a new file's facts).
 * @returns the key.
 */
export function subtitleMediaKeyOf(metadata: { content?: unknown; bytes?: unknown; durationMs?: unknown } | undefined | null): string {
  return `${typeof metadata?.content === 'string' ? metadata.content : ''}|${keyPart(metadata?.bytes)}|${keyPart(metadata?.durationMs)}`
}

/** The three parts of a media key, split from the right (an address may hold '|'). */
function mediaKeyParts(key: string): { content: string; bytes: string; durationMs: string } | null {
  const second = key.lastIndexOf('|')
  const first = second > 0 ? key.lastIndexOf('|', second - 1) : -1
  if (first < 0) return null
  return { content: key.slice(0, first), bytes: key.slice(first + 1, second), durationMs: key.slice(second + 1) }
}

/**
 * Whether the node's video is no longer the one its cues were saved against
 * (the page's 「字幕可能和视频不匹配」): another address, another size, or a
 * length more than {@link SUBTITLE_DURATION_TOLERANCE_MS} off. A part unknown
 * on either side is not compared; no cues, or no key (a node from before the
 * key, such as a cut an older Host landed), is never a mismatch.
 * @param metadata - the node's metadata.
 * @returns whether to warn.
 */
export function subtitleMediaChanged(metadata: Metadata): boolean {
  const saved = metadata?.subtitleMediaKey
  if (typeof saved !== 'string' || saved === '' || readSubtitleEntries(metadata).length === 0) return false
  const before = mediaKeyParts(saved)
  const now = mediaKeyParts(subtitleMediaKeyOf(metadata))
  if (before === null || now === null) return false
  if (before.content !== now.content) return true
  if (before.bytes !== '' && now.bytes !== '' && before.bytes !== now.bytes) return true
  return before.durationMs !== '' && now.durationMs !== '' && Math.abs(Number(before.durationMs) - Number(now.durationMs)) > SUBTITLE_DURATION_TOLERANCE_MS
}

/**
 * Cues as a clip plays them from its own start (the page's 按片段): those
 * inside [in, out], clamped and shifted by -in, as a rendered cut would carry them.
 * @param entries - the cues, in file time.
 * @param clip - the node's mark.
 * @returns the cues in clip time.
 */
export function cuesInClipTime(entries: readonly SubtitleEntry[], clip: { inMs: number; outMs: number }): SubtitleEntry[] {
  return cutCues(entries, { inMs: clip.inMs, outMs: clip.outMs }) as unknown as SubtitleEntry[]
}

/**
 * Cues timed from a clip's start (the page's 按片段 import), moved into file
 * time; past the file's end (when known) they are dropped or cut short.
 * @param cues - the cues in clip time.
 * @param clip - the node's mark (its in point).
 * @param durationMs - the file's length, when known.
 * @returns the cues in file time.
 */
export function cuesFromClipTime<T extends { startMs: number; endMs: number }>(cues: readonly T[], clip: { inMs: number }, durationMs?: number): T[] {
  const out: T[] = []
  for (const cue of cues) {
    const startMs = cue.startMs + clip.inMs
    let endMs = cue.endMs + clip.inMs
    if (durationMs !== undefined && durationMs > 0) {
      if (startMs >= durationMs) continue
      endMs = Math.min(endMs, durationMs)
    }
    if (endMs > startMs) out.push({ ...cue, startMs, endMs })
  }
  return out
}

/**
 * A digest of cues, so pages of two versions are never stitched together and
 * an edit of a list read earlier can be refused when the list changed meanwhile.
 * @param entries - the sanitized cues.
 * @returns the SHA-256, hex.
 */
export function subtitleDigest(entries: readonly SubtitleEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

/** A new file's facts, for its media key. */
export interface SubtitleMedia {
  content: string
  bytes?: number
  durationMs?: number
}

/** The subtitle fields of a derived node: its cues, its source's style, and the key and save time for a new file (else the source's). */
function subtitleFieldsFor(entries: SubtitleEntry[], source: Metadata, media: SubtitleMedia | undefined, now: string): Record<string, unknown> {
  if (entries.length === 0) return {}
  const style = isRecord(source?.subtitleStyle) ? { subtitleStyle: sanitizeSubtitleStyle(source.subtitleStyle) } : {}
  if (media !== undefined) return { subtitleEntries: entries, ...style, subtitleUpdatedAt: now, subtitleMediaKey: subtitleMediaKeyOf(media) }
  return {
    subtitleEntries: entries,
    ...style,
    ...(typeof source?.subtitleUpdatedAt === 'string' ? { subtitleUpdatedAt: source.subtitleUpdatedAt } : {}),
    ...(typeof source?.subtitleMediaKey === 'string' ? { subtitleMediaKey: source.subtitleMediaKey } : {}),
  }
}

/** How a derived node holds its source: a split sibling (the same file, its own clip) or a rendered cut (a new file of the range). */
export type SubtitleRemap = ({ kind: 'sibling' } | { kind: 'cut' }) & TimeRange

/**
 * The subtitle fields of a node made from `source`, as the page makes them
 * (canvas `derivedSubtitleFields`): its cues remapped — a split sibling keeps
 * the overlapping cues in source time, a rendered cut clamps and shifts them
 * by the in point — its style, and, for a new file (`media`), a key for that
 * file and a fresh save time, so the result is not flagged as mismatched. A
 * sibling keeps the same file, so it keeps the source's key and save time.
 * @param source - the source node's metadata.
 * @param op - the split or the cut.
 * @param media - the new file's facts (a cut); omitted for a sibling.
 * @param now - the save time for a new file.
 * @returns the fields to put on the new node (none when no cue survives).
 */
export function derivedSubtitleFields(source: Metadata, op: SubtitleRemap, media?: SubtitleMedia, now = new Date().toISOString()): Record<string, unknown> {
  const entries = readSubtitleEntries(source)
  const range: TimeRange = { inMs: op.inMs, outMs: op.outMs, ...(op.atMs !== undefined ? { atMs: op.atMs } : {}) }
  const remapped = (op.kind === 'sibling' ? siblingCues(entries, range) : cutCues(entries, range)) as unknown as SubtitleEntry[]
  return subtitleFieldsFor(remapped, source, media, now)
}

/**
 * The subtitle fields of a join (canvas `joinedSubtitleFields`): every
 * segment's cues cut and placed where it starts in the result, the first
 * styled segment's style, a key for the new file. Checked once more as C1
 * stores cues, since twenty sources can hold more than 5000 between them.
 * @param segments - each segment's range, where it starts in the result, and its source's metadata, in play order.
 * @param media - the new file's facts.
 * @param now - the save time.
 * @returns the fields to put on the new node (none when no cue survives).
 */
export function joinedSubtitleFields(segments: ReadonlyArray<TimeRange & { metadata?: Metadata }>, media: SubtitleMedia, now = new Date().toISOString()): Record<string, unknown> {
  const joined = joinCues(segments.map(({ metadata, ...range }) => ({ ...range, items: readSubtitleEntries(metadata) })))
  const entries = sanitizeSubtitleEntries(joined).entries
  const styled = segments.find(segment => readSubtitleEntries(segment.metadata).length > 0 && isRecord(segment.metadata?.subtitleStyle))
  return subtitleFieldsFor(entries, styled?.metadata, media, now)
}
