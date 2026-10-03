/**
 * The editing desk's cut, kept beside the board in `film/canvas/timeline.json`
 * with the same file shape, revision rule and history as Studio's
 * `canvas-timeline.ts`, so a `film/` folder opens the same cut in both.
 *
 * Revisions are what has to be exact. The editor saves as the person edits,
 * an agent's command can land in the same moment, and a save written over
 * work it never saw is the one loss nobody can undo by hand: a save built on
 * an older revision is refused with the current state, and writes to one cut
 * are serialised so the check means what it says.
 * @module dsh-film/timeline/store
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isTimelineArchive } from './archive.js'

/** The cut's file, relative to the workspace. */
export const TIMELINE_FILE = 'film/canvas/timeline.json'
/** How many past cuts undo can reach. */
export const MAX_HISTORY = 50
/** Past this the archive is not a cut, it is a bug being persisted. */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

export class TimelineInvalidError extends Error {
  override name = 'TimelineInvalidError'
  readonly code = 'CANVAS_TIMELINE_INVALID'
}

export class TimelineConflictError extends Error {
  override name = 'TimelineConflictError'
  readonly code = 'CANVAS_TIMELINE_CONFLICT'

  constructor(readonly current: number, readonly received: number) {
    super(`timeline has moved on: expected revision ${received}, current is ${current}`)
  }
}

interface TimelineFile {
  revision: number
  /** Every saved cut, oldest first, capped at {@link MAX_HISTORY}. */
  history: unknown[]
  /** Index into `history` of the cut currently shown. */
  cursor: number
}

export interface TimelineState {
  document: unknown
  revision: number
  canUndo: boolean
  canRedo: boolean
  historyLength: number
}

/** A stable rendering of a value: same content, same text, whatever the key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Whether two cuts are the same cut (key order aside).
 * @param left - a cut.
 * @param right - another.
 * @returns whether they match.
 */
export function sameDocument(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

const stateOf = (file: TimelineFile): TimelineState => ({
  document: file.cursor >= 0 ? file.history[file.cursor] ?? null : null,
  revision: file.revision,
  canUndo: file.cursor > 0,
  canRedo: file.cursor >= 0 && file.cursor < file.history.length - 1,
  historyLength: file.history.length,
})

/** One writer at a time per cut, across every store instance of this process. */
const locks = new Map<string, Promise<unknown>>()

async function withWriteLock<T>(file: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve()
  const turn = previous.catch(() => {}).then(run)
  locks.set(file, turn)
  try {
    return await turn
  } finally {
    if (locks.get(file) === turn) locks.delete(file)
  }
}

export interface TimelineSaveInput {
  document: unknown
  baseRevision: number
  /** The cut before a first command, kept so that command can be undone. */
  initialDocument?: unknown
}

export class TimelineStore {
  readonly file: string

  /**
   * @param cwd - the workspace directory.
   * @param changed - told after every write, with the file relative to `film/`.
   */
  constructor(cwd: string, private readonly changed: (path: string) => void = () => {}) {
    this.file = join(cwd, ...TIMELINE_FILE.split('/'))
  }

  private async load(): Promise<TimelineFile> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<TimelineFile>
      if (!Array.isArray(parsed.history) || typeof parsed.revision !== 'number' || typeof parsed.cursor !== 'number') return { revision: 0, history: [], cursor: -1 }
      return { revision: parsed.revision, history: parsed.history, cursor: parsed.cursor }
    } catch {
      return { revision: 0, history: [], cursor: -1 }
    }
  }

  private async persist(state: TimelineFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true })
    }
    this.changed(TIMELINE_FILE.slice('film/'.length))
  }

  /** The cut as it is now. */
  async read(): Promise<TimelineState> {
    return stateOf(await this.load())
  }

  /**
   * Save a cut built on `baseRevision`. A save that changes nothing is not a
   * revision; editing after an undo abandons the branch ahead of the cursor.
   * @param input - the cut and the revision it was built on.
   * @returns the state after the save.
   */
  async save(input: TimelineSaveInput): Promise<TimelineState> {
    if (!isTimelineArchive(input.document)) throw new TimelineInvalidError('a timeline document must be a version 3 Timeline Studio archive')
    if (Buffer.byteLength(JSON.stringify(input.document), 'utf8') > MAX_DOCUMENT_BYTES) throw new TimelineInvalidError('timeline document exceeds the 16 MiB limit')
    return withWriteLock(this.file, async () => {
      const file = await this.load()
      if (input.baseRevision !== file.revision) throw new TimelineConflictError(file.revision, input.baseRevision)
      if (sameDocument(file.history[file.cursor], input.document)) return stateOf(file)
      const kept = file.history.slice(0, file.cursor + 1)
      if (kept.length === 0 && input.initialDocument !== undefined) {
        if (!isTimelineArchive(input.initialDocument)) throw new TimelineInvalidError('invalid initial timeline archive')
        kept.push(input.initialDocument)
      }
      kept.push(input.document)
      const trimmed = kept.slice(Math.max(0, kept.length - MAX_HISTORY))
      const next: TimelineFile = { revision: file.revision + 1, history: trimmed, cursor: trimmed.length - 1 }
      await this.persist(next)
      return stateOf(next)
    })
  }

  /** Step back one cut; at the beginning nothing changes. */
  undo(baseRevision?: number): Promise<TimelineState> {
    return this.step(-1, baseRevision)
  }

  /** Step forward one cut; at the end nothing changes. */
  redo(baseRevision?: number): Promise<TimelineState> {
    return this.step(1, baseRevision)
  }

  private step(delta: -1 | 1, baseRevision?: number): Promise<TimelineState> {
    return withWriteLock(this.file, async () => {
      const file = await this.load()
      if (baseRevision !== undefined && baseRevision !== file.revision) throw new TimelineConflictError(file.revision, baseRevision)
      const next = file.cursor + delta
      if (next < 0 || next >= file.history.length) return stateOf(file)
      const moved: TimelineFile = { ...file, cursor: next, revision: file.revision + 1 }
      await this.persist(moved)
      return stateOf(moved)
    })
  }
}
