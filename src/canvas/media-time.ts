/**
 * Moving timed things — subtitle cues (ms) and director shot times (seconds)
 * — with a split, a rendered cut or a join, by the storyboard page's rules
 * (canvas `web/src/lib/canvas/media-time-remap.ts`, VibeDev's own), so a node
 * the agent's tools make carries the same cues and shots as one the page
 * makes for the person.
 *
 * Cues are kept in the time of their node's whole source file (C1), so:
 * - a split sibling points at the same file: it keeps the items that overlap
 *   its clip, unchanged (still source time);
 * - a rendered cut holds [inMs, outMs] of its source from `atMs` (0) on:
 *   items that intersect it are clamped to it and shifted by `atMs - inMs`;
 * - a join places each segment as a cut at its `atMs` (as the Host reports
 *   it, else the running total of the segments before it).
 * Items shorter than 100 ms after clamping are dropped, and so is anything
 * malformed; `null` (cleared, amendments C.8) reads as none. A director shot
 * moves its sourceIn/sourceOut by the same amounts its start/end were clamped.
 * The board stores node metadata verbatim, so everything here reads unknown
 * values and keeps an item's other fields as they are.
 * @module dsh-film/canvas/media-time
 */

/** Shorter than this after clamping, an item is dropped. */
export const MIN_TIMED_MS = 100

/** The part of a source a result holds (ms of the source), and where it starts in the result. */
export interface TimeRange {
  inMs: number
  outMs: number
  atMs?: number
}

/** A subtitle cue (C1 `subtitleEntries[]`), its other fields kept. */
export type TimedItem = Record<string, unknown> & { startMs: number; endMs: number }

/** A shot of a director render's sequence (seconds), its other fields kept. */
export type DirectorShot = Record<string, unknown> & { start: number; end: number; sourceIn: number; sourceOut: number }

/** A director render's sequence (`directorSequence`), its identity fields kept. */
export type DirectorSequence = Record<string, unknown> & { shots: DirectorShot[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** The well-formed cues of a value: objects with finite times, ending after they start. */
function timedItems(value: unknown): TimedItem[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is TimedItem => isRecord(item) && finite(item.startMs) && finite(item.endMs) && item.endMs > item.startMs)
}

function cutItems(items: readonly TimedItem[], range: TimeRange): TimedItem[] {
  const at = range.atMs ?? 0
  const out: TimedItem[] = []
  for (const item of items) {
    const start = Math.max(item.startMs, range.inMs)
    const end = Math.min(item.endMs, range.outMs)
    if (end - start < MIN_TIMED_MS) continue
    out.push({ ...item, startMs: Math.round(start - range.inMs + at), endMs: Math.round(end - range.inMs + at) })
  }
  return out
}

/**
 * The cues a split sibling keeps: those overlapping its clip, unchanged.
 * @param value - the source node's `subtitleEntries`.
 * @param range - the sibling's clip.
 * @returns the cues, in their order.
 */
export function siblingCues(value: unknown, range: TimeRange): TimedItem[] {
  return timedItems(value).filter(item => Math.min(item.endMs, range.outMs) - Math.max(item.startMs, range.inMs) > 0)
}

/**
 * The cues of a rendered cut: clamped to the range and moved to the result's time.
 * @param value - the source node's `subtitleEntries`.
 * @param range - the part of the source the result holds, and where it starts.
 * @returns the cues, sorted by start.
 */
export function cutCues(value: unknown, range: TimeRange): TimedItem[] {
  return cutItems(timedItems(value), range).sort((left, right) => left.startMs - right.startMs)
}

/**
 * The cues of a join result: every segment's own cues, cut and placed where
 * the segment starts. One source may appear twice: cue ids stay unique.
 * @param segments - each segment's range and its source's cues, in play order.
 * @returns the cues, sorted by start.
 */
export function joinCues(segments: ReadonlyArray<TimeRange & { items?: unknown }>): TimedItem[] {
  const out: TimedItem[] = []
  const ids = new Set<string>()
  let cursor = 0
  segments.forEach((segment, index) => {
    const at = segment.atMs ?? cursor
    for (const item of cutItems(timedItems(segment.items), { ...segment, atMs: at })) {
      const id = typeof item.id === 'string' && ids.has(item.id) ? `${item.id}-${index + 1}` : item.id
      if (typeof id === 'string') ids.add(id)
      out.push(id === item.id ? item : { ...item, id })
    }
    cursor = at + (segment.outMs - segment.inMs)
  })
  return out.sort((left, right) => left.startMs - right.startMs)
}

/** A value's director sequence, when it has a list of shots. */
function sequenceOf(value: unknown): (Record<string, unknown> & { shots: unknown[] }) | undefined {
  return isRecord(value) && Array.isArray(value.shots) ? value as Record<string, unknown> & { shots: unknown[] } : undefined
}

const timedShot = (shot: unknown): shot is DirectorShot => isRecord(shot) && finite(shot.start) && finite(shot.end) && shot.end > shot.start

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000

function cutShotList(shots: readonly unknown[], range: TimeRange): DirectorShot[] {
  const from = range.inMs / 1000
  const to = range.outMs / 1000
  const at = (range.atMs ?? 0) / 1000
  const out: DirectorShot[] = []
  for (const shot of shots) {
    if (!timedShot(shot) || !finite(shot.sourceIn) || !finite(shot.sourceOut)) continue
    const start = Math.max(shot.start, from)
    const end = Math.min(shot.end, to)
    if ((end - start) * 1000 < MIN_TIMED_MS) continue
    out.push({ ...shot, start: round(start - from + at), end: round(end - from + at), sourceIn: round(shot.sourceIn + (start - shot.start)), sourceOut: round(shot.sourceOut - (shot.end - end)) })
  }
  return out
}

/**
 * The director sequence a split sibling keeps: the shots overlapping its clip, unchanged.
 * @param value - the source node's `directorSequence`.
 * @param range - the sibling's clip.
 * @returns the sequence, or `undefined` when no shot is left.
 */
export function siblingShots(value: unknown, range: TimeRange): DirectorSequence | undefined {
  const sequence = sequenceOf(value)
  if (sequence === undefined) return undefined
  const shots = sequence.shots.filter((shot): shot is DirectorShot => timedShot(shot) && Math.min(shot.end, range.outMs / 1000) - Math.max(shot.start, range.inMs / 1000) > 0)
  return shots.length > 0 ? { ...sequence, shots } : undefined
}

/**
 * The director sequence of a rendered cut: shots clamped to the range and moved to the result's time.
 * @param value - the source node's `directorSequence`.
 * @param range - the part of the source the result holds, and where it starts.
 * @returns the sequence, or `undefined` when no shot is left.
 */
export function cutShots(value: unknown, range: TimeRange): DirectorSequence | undefined {
  const sequence = sequenceOf(value)
  if (sequence === undefined) return undefined
  const shots = cutShotList(sequence.shots, range)
  return shots.length > 0 ? { ...sequence, shots } : undefined
}

/**
 * The director sequence of a join: every segment's shots, cut and placed. The
 * render identity (director node, render id…) is kept only when every segment
 * with a sequence came from the same render.
 * @param segments - each segment's range and its source's sequence, in play order.
 * @returns the sequence, or `undefined` when no shot is left.
 */
export function joinShots(segments: ReadonlyArray<TimeRange & { sequence?: unknown }>): DirectorSequence | undefined {
  const shots: DirectorShot[] = []
  let cursor = 0
  for (const segment of segments) {
    const at = segment.atMs ?? cursor
    const sequence = sequenceOf(segment.sequence)
    if (sequence !== undefined) shots.push(...cutShotList(sequence.shots, { ...segment, atMs: at }))
    cursor = at + (segment.outMs - segment.inMs)
  }
  if (shots.length === 0) return undefined
  const sources = segments.map(segment => sequenceOf(segment.sequence)).filter((sequence): sequence is Record<string, unknown> & { shots: unknown[] } => sequence !== undefined)
  const first = sources[0]!
  const sameRender = sources.every(sequence => sequence.renderId === first.renderId && sequence.directorNodeId === first.directorNodeId)
  const { shots: _shots, ...identity } = first
  return { ...(sameRender ? identity : {}), shots: shots.sort((left, right) => left.start - right.start) }
}
