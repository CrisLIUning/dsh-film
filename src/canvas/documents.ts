/**
 * The workspace's storyboard canvas, stored the way Studio stores a film
 * project's board (apps/daemon/src/canvas-documents.ts) with the workspace's
 * `film/` folder as the project: `film/canvas/document.json`, written
 * atomically under a per-file lock, and a tombstone when the board is deleted
 * so a browser cache cannot push a deleted board back.
 *
 * A tombstone stands for the one board it names. A film started after its
 * folder's film was deleted has a new id, and so a new board: the old board's
 * tombstone neither stops that board being made nor refuses its saves; it is
 * cleared when the new board is first written.
 *
 * The plugin stores and serves the document and does not interpret nodes:
 * the canvas owns that shape, and parsing it here is how an unknown field
 * would get dropped on a round trip.
 * @module dsh-film/canvas/documents
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createExclusive, withFileLock } from '../file-writes.js'

/** A board as the canvas saves it; only `id`, `nodes` and `connections` are relied on. */
export interface CanvasDocument {
  id: string
  title?: string
  updatedAt?: string
  nodes: unknown[]
  connections: unknown[]
  [key: string]: unknown
}

export interface CanvasDocumentSummary {
  id: string
  projectId: string
  title: string
  updatedAt: string
  size: number
}

export interface CanvasDeletedDocument {
  id: string
  deletedAt: string
  projectId: string
}

export const CANVAS_DOCUMENT_FILE = 'film/canvas/document.json'
export const CANVAS_TOMBSTONE_FILE = 'film/canvas/document.deleted.json'

export class CanvasDocumentUpdateError extends Error {
  override name = 'CanvasDocumentUpdateError'

  constructor(readonly code: 'CANVAS_DOCUMENT_DAMAGED' | 'CANVAS_DOCUMENT_DELETED', message: string) {
    super(message)
  }
}

/** What {@link CanvasDocumentStore.create} found: it saved the board, or left the board (or its tombstone) that was there. */
export type CanvasCreateResult = 'created' | 'exists' | 'deleted'

/** Ids a board can have: what Studio and the canvas accept as a stable board id. */
export const BOARD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

/**
 * A film's new, empty board, as Studio starts one, named after the film. Every
 * writer that starts a board starts it from this.
 * @param id - the board's id (the film's).
 * @param title - the film's title.
 * @param now - the creation time.
 * @returns the board.
 */
export function emptyFilmBoard(id: string, title: string, now: Date | string = new Date()): CanvasDocument {
  const time = typeof now === 'string' ? now : now.toISOString()
  return {
    id, title, createdAt: time, updatedAt: time,
    nodes: [], connections: [], chatSessions: [], activeChatId: null,
    backgroundMode: 'lines', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
  }
}

/**
 * The id of the board saved in a workspace, when its file is a JSON object
 * with an id a board can have (its nodes may still be damaged).
 * @param cwd - the workspace directory.
 * @returns the id, or `undefined` when there is no such board.
 */
export async function savedBoardId(cwd: string): Promise<string | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(cwd, ...CANVAS_DOCUMENT_FILE.split('/')), 'utf8'))
  } catch {
    return undefined
  }
  const id = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { id?: unknown }).id : undefined
  return typeof id === 'string' && BOARD_ID_PATTERN.test(id) ? id : undefined
}

const present = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)

const isDocument = (value: unknown): value is CanvasDocument =>
  typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
  && Array.isArray((value as { nodes?: unknown }).nodes)

function summaryOf(document: CanvasDocument, size: number, projectId: string): CanvasDocumentSummary {
  return {
    id: document.id,
    projectId,
    title: typeof document.title === 'string' && document.title.trim() !== '' ? document.title : document.id,
    updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : '',
    size,
  }
}

/** The one board of a workspace. */
export class CanvasDocumentStore {
  private readonly file: string
  private readonly tombstone: string

  /**
   * @param cwd - the workspace directory.
   * @param projectId - the project id the canvas addresses this workspace by, echoed in summaries.
   */
  constructor(cwd: string, private readonly projectId: string) {
    this.file = join(cwd, ...CANVAS_DOCUMENT_FILE.split('/'))
    this.tombstone = join(cwd, ...CANVAS_TOMBSTONE_FILE.split('/'))
  }

  private async readFile(strict = false): Promise<CanvasDocument | null> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const document: unknown = JSON.parse(text)
      if (isDocument(document)) return document
    } catch {
      // Damaged: below.
    }
    if (strict) throw new CanvasDocumentUpdateError('CANVAS_DOCUMENT_DAMAGED', 'The saved canvas cannot be read. Its file has been retained; restore it before merging changes.')
    return null
  }

  private async writeFile(document: CanvasDocument): Promise<CanvasDocumentSummary> {
    await mkdir(dirname(this.file), { recursive: true })
    const body = `${JSON.stringify(document, null, 2)}\n`
    const temporary = `${this.file}.tmp-${randomUUID()}`
    try {
      await writeFile(temporary, body, 'utf8')
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true })
    }
    await rm(this.tombstone, { force: true })
    return summaryOf(document, Buffer.byteLength(body), this.projectId)
  }

  /**
   * Read the board.
   * @param id - the board id the canvas asks for.
   * @returns the board, or `null` when there is none (or it is another board).
   */
  async read(id: string): Promise<CanvasDocument | null> {
    const document = await this.readFile()
    return document?.id === id ? document : null
  }

  /**
   * The board the tombstone names.
   * @returns `null` without a tombstone; its id, or `''` when it names no board (it cannot be read).
   */
  private async tombstoneId(): Promise<string | null> {
    let text: string
    try {
      text = await readFile(this.tombstone, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return ''
    }
    try {
      const id = (JSON.parse(text) as { id?: unknown } | null)?.id
      return typeof id === 'string' ? id : ''
    } catch {
      return ''
    }
  }

  async write(id: string, document: CanvasDocument): Promise<CanvasDocumentSummary> {
    return withFileLock(this.file, () => this.writeFile({ ...document, id }))
  }

  /**
   * Save a board only where there is none, under the board's lock. A board
   * already saved — even one that cannot be read — and this board's own
   * tombstone are left exactly as they are. A tombstone of another board (the
   * folder's earlier film, deleted) does not stand for this one: it is cleared
   * once this board is saved.
   * @param document - the new board.
   * @returns `created`, or what was there instead: `exists` or `deleted`.
   */
  async create(document: CanvasDocument): Promise<CanvasCreateResult> {
    return withFileLock(this.file, async () => {
      if (await present(this.file)) return 'exists'
      const deleted = await this.tombstoneId()
      if (deleted === document.id) return 'deleted'
      await mkdir(dirname(this.file), { recursive: true })
      // Exclusive even under the lock: another process may be writing the same workspace.
      if (!await createExclusive(this.file, `${JSON.stringify(document, null, 2)}\n`)) return 'exists'
      if (deleted !== null) await rm(this.tombstone, { force: true })
      return 'created'
    })
  }

  /**
   * Change the board from its latest saved state, under the board's lock —
   * the path both browser saves (three-way merge) and host-side edits take.
   * With no saved board, a board whose tombstone is there is refused (a cache
   * must not bring it back); a tombstone of another board does not refuse it.
   * @param change - computes the new board from the current one.
   * @returns the saved board and its summary.
   */
  async update(change: (current: CanvasDocument | null) => CanvasDocument | Promise<CanvasDocument>): Promise<{ document: CanvasDocument; summary: CanvasDocumentSummary }> {
    return withFileLock(this.file, async () => {
      const current = await this.readFile(true)
      const deleted = current === null ? await this.tombstoneId() : null
      const document = await change(current)
      if (deleted !== null && deleted === document.id) {
        throw new CanvasDocumentUpdateError('CANVAS_DOCUMENT_DELETED', 'This canvas was deleted. Reopen the current project canvas before sending or saving changes.')
      }
      return { document, summary: await this.writeFile(document) }
    })
  }

  /** Forget the board, keep its media; leave a tombstone. */
  async remove(id: string): Promise<void> {
    await withFileLock(this.file, async () => {
      await rm(this.file, { force: true })
      try {
        await mkdir(dirname(this.tombstone), { recursive: true })
        await writeFile(this.tombstone, `${JSON.stringify({ id, deletedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
      } catch {
        // Without a tombstone the board may come back from a cache; the delete still happened.
      }
    })
  }

  async tombstones(): Promise<CanvasDeletedDocument[]> {
    try {
      const parsed = JSON.parse(await readFile(this.tombstone, 'utf8')) as { id?: unknown; deletedAt?: unknown }
      if (typeof parsed.id !== 'string' || parsed.id === '') return []
      return [{ id: parsed.id, deletedAt: typeof parsed.deletedAt === 'string' ? parsed.deletedAt : '', projectId: this.projectId }]
    } catch {
      return []
    }
  }

  async list(): Promise<CanvasDocumentSummary[]> {
    const document = await this.readFile()
    if (document === null) return []
    const size = await stat(this.file).then(info => info.size, () => 0)
    return [summaryOf(document, size, this.projectId)]
  }
}
