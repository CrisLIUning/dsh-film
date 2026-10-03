/**
 * The workspace's storyboard canvas, stored the way Studio stores a film
 * project's board (apps/daemon/src/canvas-documents.ts) with the workspace's
 * `film/` folder as the project: `film/canvas/document.json`, written
 * atomically under a per-file lock, and a tombstone when the board is deleted
 * so a browser cache cannot push a deleted board back.
 *
 * The plugin stores and serves the document and does not interpret nodes:
 * the canvas owns that shape, and parsing it here is how an unknown field
 * would get dropped on a round trip.
 * @module dsh-film/canvas/documents
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

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

const locks = new Map<string, Promise<void>>()

async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(file)
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>((done) => { release = done })
  const chained = previous.then(() => pending, () => pending)
  locks.set(key, chained)
  await previous.catch(() => undefined)
  try {
    return await action()
  } finally {
    release()
    if (locks.get(key) === chained) locks.delete(key)
  }
}

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

  async write(id: string, document: CanvasDocument): Promise<CanvasDocumentSummary> {
    return withFileLock(this.file, () => this.writeFile({ ...document, id }))
  }

  /**
   * Change the board from its latest saved state, under the board's lock —
   * the path both browser saves (three-way merge) and host-side edits take.
   * @param change - computes the new board from the current one.
   * @returns the saved board and its summary.
   */
  async update(change: (current: CanvasDocument | null) => CanvasDocument | Promise<CanvasDocument>): Promise<{ document: CanvasDocument; summary: CanvasDocumentSummary }> {
    return withFileLock(this.file, async () => {
      const current = await this.readFile(true)
      if (current === null && await stat(this.tombstone).then(() => true, () => false)) {
        throw new CanvasDocumentUpdateError('CANVAS_DOCUMENT_DELETED', 'This canvas was deleted. Reopen the current project canvas before sending or saving changes.')
      }
      const document = await change(current)
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
