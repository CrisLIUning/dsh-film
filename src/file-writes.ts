/**
 * Two ways the film's stores write a file safely: create it only where
 * nothing is yet, and change it under a per-file lock so writers in this
 * process take turns.
 * @module dsh-film/file-writes
 */

import { randomUUID } from 'node:crypto'
import { link, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Write a file only if nothing is at its path yet. The content goes to a
 * temporary file first and is linked into place, so the final name never
 * holds a partial file; file systems without hard links — each answers in its
 * own way (FAT32/exFAT on Windows: EISDIR; others EPERM, ENOTSUP, EXDEV,
 * ENOSYS, EINVAL) — fall back to an exclusive create, which a real problem
 * with the path fails too.
 * @param path - the final path.
 * @param data - the content.
 * @returns whether the file was created (`false`: something was already there).
 */
export async function createExclusive(path: string, data: string): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, data, { flag: 'wx' })
  try {
    await link(temporary, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
  } finally {
    await rm(temporary, { force: true })
  }
  try {
    await writeFile(path, data, { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

const locks = new Map<string, Promise<void>>()

/**
 * Run an action while holding a file's lock: actions on the same file run one
 * after another, in the order they asked.
 * @param file - the file the action reads and writes.
 * @param action - the action.
 * @returns what the action returns.
 */
export async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
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
