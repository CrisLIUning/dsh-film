/**
 * Files of the film (the workspace's `film/` folder, Studio's project folder)
 * read by path and by content: resolution that tells a missing file from one
 * outside the film, and SHA-256 digests with a cache for listings.
 * @module dsh-film/film-files
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { appFileType } from './apps.js'
import { FILM_DIR } from './project.js'

const fileError = (code: string, message: string): NodeJS.ErrnoException => Object.assign(new Error(message), { code })

/** A file of the film, proven (on real paths) to be inside it. */
export interface FilmFile {
  absolute: string
  size: number
  mtimeMs: number
  mime: string
}

/**
 * Resolve a film-relative path (`/` separators, as stored in boards and
 * screenplays). A missing file fails with `ENOENT`; a path that leaves the
 * film, by `..` or a link, with `EPATHESCAPE`; a folder with `EISDIR`.
 * @param cwd - the workspace directory.
 * @param path - the path relative to `film/`.
 * @returns the file.
 */
export async function resolveFilmFile(cwd: string, path: string): Promise<FilmFile> {
  const parts = path.split('/')
  if (path === '' || path.includes('\0') || path.includes('\\') || isAbsolute(path) || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw fileError('EPATHESCAPE', `${path} is not a path inside the film.`)
  }
  const root = await realpath(join(cwd, FILM_DIR))
  const real = await realpath(join(root, ...parts))
  const offset = relative(root, real)
  if (offset === '' || offset === '..' || offset.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(offset)) {
    throw fileError('EPATHESCAPE', `${path} leaves the film.`)
  }
  const info = await stat(real)
  if (!info.isFile()) throw fileError('EISDIR', `${path} is not a file.`)
  return { absolute: real, size: info.size, mtimeMs: info.mtimeMs, mime: appFileType(path) }
}

/**
 * A file's SHA-256, streamed.
 * @param path - the absolute path.
 * @returns lower-case hex.
 */
export async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Digests remembered by path, size and modification time, for listings that
 * would otherwise hash every image of the film on every call. A check of the
 * exact bytes being bound or read never goes through it.
 */
export class DigestCache {
  private readonly entries = new Map<string, { size: number; mtimeMs: number; sha256: string }>()

  constructor(private readonly limit = 4096) {}

  async digest(file: Pick<FilmFile, 'absolute' | 'size' | 'mtimeMs'>): Promise<string> {
    const known = this.entries.get(file.absolute)
    if (known !== undefined && known.size === file.size && known.mtimeMs === file.mtimeMs) return known.sha256
    const sha256 = await digestFile(file.absolute)
    this.entries.delete(file.absolute)
    this.entries.set(file.absolute, { size: file.size, mtimeMs: file.mtimeMs, sha256 })
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value as string)
    return sha256
  }
}
