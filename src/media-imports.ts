/**
 * The film's import record, `film/canvas/imports.json`: which workspace media
 * files the film took in (copied into `film/canvas/media/`), and as what. The
 * libraries that offer the workspace's own media (the editing desk's
 * material, the canvas's workspace files) leave out a file the film already
 * has, until that file changes or the film's copy goes.
 *
 * Imports of one workspace take turns under {@link withImportLock}, so two
 * imports of the same file at once end with one copy, not `x.png` and `x-2.png`.
 * @module dsh-film/media-imports
 */

import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock } from './file-writes.js'
import { FILM_DIR } from './project.js'

/** The import record, relative to the workspace. */
export const IMPORTS_FILE = `${FILM_DIR}/canvas/imports.json`

/** One workspace file the film took in. */
export interface ImportRecord {
  /** Film-relative path of the film's file. */
  target: string
  /** The source as it was imported: an import whose source changed since is offered again. */
  size: number
  modifiedAt: string
  importedAt: string
}

interface ImportsFile {
  version: 1
  /** By workspace-relative source path. */
  imports: Record<string, ImportRecord>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const validRecord = (value: unknown): value is ImportRecord =>
  isRecord(value) && typeof value.target === 'string' && typeof value.size === 'number' && typeof value.modifiedAt === 'string'

const recordFile = (cwd: string): string => join(cwd, ...IMPORTS_FILE.split('/'))

/**
 * The film's import record. A missing or unreadable record is empty: it only
 * decides what the libraries offer, never what the film holds.
 * @param cwd - the workspace directory.
 * @returns the imports by workspace-relative source path.
 */
export async function readImports(cwd: string): Promise<Map<string, ImportRecord>> {
  try {
    const value = JSON.parse(await readFile(recordFile(cwd), 'utf8')) as unknown
    const imports = isRecord(value) && isRecord(value.imports) ? value.imports : {}
    return new Map(Object.entries(imports).filter((entry): entry is [string, ImportRecord] => validRecord(entry[1])))
  } catch {
    return new Map()
  }
}

/**
 * Run one import of a workspace while no other import of it runs.
 * @param cwd - the workspace directory.
 * @param action - finds or makes the film's copy and notes it.
 * @returns what the action returns.
 */
export function withImportLock<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  return withFileLock(recordFile(cwd), action)
}

/**
 * Note an import in the record, written whole. The caller holds
 * {@link withImportLock}. Failing to note it does not undo the import: the
 * libraries just offer the file again.
 * @param cwd - the workspace directory.
 * @param source - the imported file's workspace-relative path and its stats as imported.
 * @param target - its film-relative path in the film.
 */
export async function noteImport(cwd: string, source: { path: string; stats: Pick<Stats, 'size' | 'mtime'> }, target: string): Promise<void> {
  const file = recordFile(cwd)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const imports = Object.fromEntries(await readImports(cwd))
    imports[source.path] = { target, size: source.stats.size, modifiedAt: source.stats.mtime.toISOString(), importedAt: new Date().toISOString() }
    const state: ImportsFile = { version: 1, imports }
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } catch {
    // The import stands; only the libraries' hint is lost.
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/** A workspace file as a listing describes it. */
export interface ListedFile {
  /** Relative to the workspace, `/`-separated. */
  path: string
  bytes: number
  /** ISO 8601. */
  modifiedAt: string
}

/**
 * The listed workspace files the film has not taken in: a file imported
 * before, unchanged since (same size and modification time) and whose film
 * copy is still there, is left out.
 * @param cwd - the workspace directory.
 * @param files - the workspace files, as listed.
 * @param filmFiles - the film's media files (film-relative), when already listed; otherwise each copy is checked on disk.
 * @returns the files still to offer, in their order.
 */
export async function withoutImported<T extends ListedFile>(cwd: string, files: readonly T[], filmFiles?: ReadonlySet<string>): Promise<T[]> {
  const imports = await readImports(cwd)
  if (imports.size === 0) return [...files]
  const kept = await Promise.all(files.map(async (file) => {
    const record = imports.get(file.path)
    if (record === undefined || record.size !== file.bytes || record.modifiedAt !== file.modifiedAt) return true
    if (filmFiles !== undefined) return !filmFiles.has(record.target)
    const copy = await lstat(join(cwd, FILM_DIR, ...record.target.split('/'))).catch(() => undefined)
    return copy?.isFile() !== true
  }))
  return files.filter((_, index) => kept[index])
}
