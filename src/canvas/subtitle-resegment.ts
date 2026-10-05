/**
 * Splitting long subtitle cues (自动断句) for the agent's subtitle tools —
 * the storyboard page's rules (canvas `web/src/lib/subtitles/srt-resegment.ts`,
 * VibeDev's own; C1: 20–60 characters per cue, 35 by default), so a list the
 * agent writes is split where the page's 导入 would split it.
 *
 * Where to cut: after a line break or Chinese punctuation first, then after
 * Latin punctuation that a space follows, then at a space, and only then at
 * the limit itself, moved back a few units when that keeps a closing mark off
 * the next piece's start or an opening mark off this piece's end. Never
 * inside one visible character (an emoji, a letter with combining marks) or a
 * run of closing marks; the blank space at a cut is trimmed off both pieces.
 * Lengths are counted in UTF-16 units, like the 2000-character text limit.
 *
 * How long each piece shows: a share of the cue's time by its length, at least
 * {@link MIN_SEGMENT_DURATION_MS} per piece when the cue is long enough for
 * that, else as even as whole milliseconds allow; a cue too short to give
 * every piece a millisecond stays whole. The first piece keeps the cue's id,
 * later pieces get new ones, and a highlight moves to the piece it lies in (it
 * is dropped when a cut runs through it).
 * @module dsh-film/canvas/subtitle-resegment
 */

import type { SubtitleEntry } from './subtitles.js'

export const DEFAULT_MAX_CHARS_PER_ENTRY = 35
export const MIN_CHARS_PER_ENTRY = 20
export const MAX_CHARS_PER_ENTRY_LIMIT = 60
export const MIN_SEGMENT_DURATION_MS = 300

/** Full-width marks a piece may end on: clause and sentence marks, dashes, ellipses, closing brackets and quotes. */
const CJK_BREAK_AFTER = new Set([...'，。、；：！？…—～）］｝】」』》〉〕”’'])
/** Latin marks a piece may end on when a space or the end of the text follows. */
const LATIN_BREAK_AFTER = new Set([...',.;:!?'])
/** Marks that belong to the end of the piece before them: a piece should not start with one. */
const TRAILING_MARKS = new Set([...CJK_BREAK_AFTER, ...LATIN_BREAK_AFTER, ...')]}"\''])
/** Marks that belong to the start of the piece after them: a piece should not end with one. */
const OPENING_MARKS = new Set([...'（［｛【「『《〈〔“‘([{'])
const SPACE = /\s/u
/** How far a forced cut may move back to keep marks with their words. */
const TIDY_REACH = 4

/** How good a cut is: lower is better. */
const RANK_LINE_OR_CJK = 0
const RANK_LATIN = 1
const RANK_SPACE = 2
const NOT_A_BREAK = 3

interface Piece { start: number; end: number }

const isSpace = (char: string | undefined): boolean => char !== undefined && SPACE.test(char)
const isHighSurrogate = (code: number): boolean => code >= 0xD800 && code <= 0xDBFF
const isLowSurrogate = (code: number): boolean => code >= 0xDC00 && code <= 0xDFFF

/** Whether an index of `text` falls between two visible characters (grapheme clusters, or at least whole code points). */
function boundaryTest(text: string): (index: number) => boolean {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const starts = new Set<number>([text.length])
    for (const segment of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) starts.add(segment.index)
    return index => starts.has(index)
  }
  return index => index <= 0 || index >= text.length || !(isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index)))
}

function rankOfCut(text: string, cut: number): number {
  const before = text[cut - 1]
  const after = text[cut]
  if (before === '\n' || after === '\n') return RANK_LINE_OR_CJK
  if (before !== undefined && CJK_BREAK_AFTER.has(before) && !(after !== undefined && TRAILING_MARKS.has(after))) return RANK_LINE_OR_CJK
  if (before !== undefined && LATIN_BREAK_AFTER.has(before) && (after === undefined || isSpace(after))) return RANK_LATIN
  if (isSpace(before) || isSpace(after)) return RANK_SPACE
  return NOT_A_BREAK
}

/** A forced cut that keeps a closing mark off the next piece's start and an opening mark off this piece's end. */
const isTidy = (text: string, cut: number): boolean => !TRAILING_MARKS.has(text[cut] ?? '') && !OPENING_MARKS.has(text[cut - 1] ?? '')

function skipSpace(text: string, index: number): number {
  let at = index
  while (at < text.length && isSpace(text[at])) at++
  return at
}

function trimmedEnd(text: string, start: number, end: number): number {
  let at = end
  while (at > start && isSpace(text[at - 1])) at--
  return at
}

/**
 * Where a piece starting at `from`, at most `limit` units long, should end:
 * the latest cut of the best rank; else the limit, moved back to a character
 * boundary (and a few units further when that keeps marks with their words).
 */
function cutAfter(text: string, from: number, limit: number, isBoundary: (index: number) => boolean): number {
  const last = from + limit
  if (text.length <= last) return text.length
  // A cut must leave something besides blank space before it.
  const firstContent = skipSpace(text, from)
  let best = -1
  let bestRank = NOT_A_BREAK
  for (let cut = last; cut > firstContent && bestRank > RANK_LINE_OR_CJK; cut--) {
    if (!isBoundary(cut)) continue
    const rank = rankOfCut(text, cut)
    if (rank < bestRank) {
      best = cut
      bestRank = rank
    }
  }
  if (best > from) return best
  for (let cut = last; cut > Math.max(firstContent, last - TIDY_REACH); cut--) if (isBoundary(cut) && isTidy(text, cut)) return cut
  for (let cut = last; cut > from; cut--) if (isBoundary(cut)) return cut
  // Even the first character is longer than the limit: it goes whole into this piece.
  for (let cut = last + 1; cut < text.length; cut++) if (isBoundary(cut)) return cut
  return text.length
}

/** The pieces of `text` at most `limit` units long, as [start, end) ranges with the blank space at each cut left out. */
function piecesOf(text: string, limit: number): Piece[] {
  const isBoundary = boundaryTest(text)
  const pieces: Piece[] = []
  let from = skipSpace(text, 0)
  while (from < text.length) {
    const cut = cutAfter(text, from, limit, isBoundary)
    const end = trimmedEnd(text, from, cut)
    if (end > from) pieces.push({ start: from, end })
    from = skipSpace(text, cut)
  }
  return pieces
}

/** The times between `count` pieces of [startMs, endMs] (count − 1 of them), or null when the cue cannot give each piece a millisecond. */
function sharedTimes(startMs: number, endMs: number, weights: readonly number[]): number[] | null {
  const count = weights.length
  const span = endMs - startMs
  if (!(span >= count)) return null
  const times: number[] = []
  if (span < count * MIN_SEGMENT_DURATION_MS) {
    // Too short for the minimum everywhere: equal shares, the leftover milliseconds going to the first pieces.
    const share = Math.floor(span / count)
    const leftover = span - share * count
    let at = startMs
    for (let index = 0; index < count - 1; index++) {
      at += share + (index < leftover ? 1 : 0)
      times.push(at)
    }
    return times
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let before = 0
  let previous = startMs
  for (let index = 0; index < count - 1; index++) {
    before += weights[index]!
    const byLength = Math.round(startMs + (span * before) / total)
    // Room for this piece's minimum, and for the minimum of every piece still to come.
    const earliest = previous + MIN_SEGMENT_DURATION_MS
    const latest = endMs - (count - 1 - index) * MIN_SEGMENT_DURATION_MS
    previous = Math.min(latest, Math.max(earliest, byLength))
    times.push(previous)
  }
  return times
}

/** `entry` cut into `pieces` (ranges of its text), with their times, ids and highlight; the entry itself when that cannot be done. */
function entriesFromPieces(entry: SubtitleEntry, pieces: readonly Piece[], newId: () => string): SubtitleEntry[] {
  if (pieces.length < 2) return [entry]
  const texts = pieces.map(({ start, end }) => entry.text.slice(start, end))
  const times = sharedTimes(entry.startMs, entry.endMs, texts.map(text => Array.from(text).length))
  if (times === null) return [entry]
  const edges = [entry.startMs, ...times, entry.endMs]
  const mark = entry.highlight
  return pieces.map((piece, index) => {
    const highlight = mark !== undefined && mark.end > mark.start && mark.start >= piece.start && mark.end <= piece.end ? { start: mark.start - piece.start, end: mark.end - piece.start } : undefined
    return { id: index === 0 ? entry.id : newId(), startMs: edges[index]!, endMs: edges[index + 1]!, text: texts[index]!, ...(highlight !== undefined ? { highlight } : {}) }
  })
}

/**
 * A cue cut into pieces of at most `maxChars` units (the limit as given, not
 * clamped); a cue that fits, or is too short to share, comes back alone.
 * @param entry - the cue.
 * @param maxChars - the most UTF-16 units a piece holds.
 * @param newId - makes the id of each piece after the first.
 * @returns the pieces, in order.
 */
export function splitLongEntry(entry: SubtitleEntry, maxChars: number, newId: () => string): SubtitleEntry[] {
  if (!Number.isFinite(maxChars) || maxChars < 1) return [entry]
  const limit = Math.floor(maxChars)
  if (entry.text.length <= limit) return [entry]
  return entriesFromPieces(entry, piecesOf(entry.text, limit), newId)
}

/** The per-cue limit 自动断句 uses: rounded into 20–60, the default 35 when it is no number. */
const perCueLimit = (maxChars: number): number => Number.isFinite(maxChars)
  ? Math.min(MAX_CHARS_PER_ENTRY_LIMIT, Math.max(MIN_CHARS_PER_ENTRY, Math.round(maxChars)))
  : DEFAULT_MAX_CHARS_PER_ENTRY

/**
 * 自动断句: every cue longer than the per-cue limit split at its best cuts, in
 * the order given; shorter cues are kept as they are.
 * @param entries - the cues.
 * @param maxChars - the per-cue limit (rounded into 20–60).
 * @param newId - makes the ids of the new pieces.
 * @returns the cues.
 */
export function resegmentEntries(entries: readonly SubtitleEntry[], maxChars: number, newId: () => string): SubtitleEntry[] {
  const limit = perCueLimit(maxChars)
  return entries.flatMap(entry => entry.text.length > limit ? splitLongEntry(entry, limit, newId) : [entry])
}
