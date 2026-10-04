/**
 * Files of the film (the workspace's `film/` folder, Studio's project folder)
 * read by path and by content: resolution that tells a missing file from one
 * outside the film, and SHA-256 digests with a cache for listings.
 * @module dsh-film/film-files
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
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

/** `real` is `root` or below it (both real paths). */
function inside(root: string, real: string): boolean {
  const offset = relative(root, real)
  return !(offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset))
}

/**
 * Make the folders a film file is written into, proving on real paths that
 * they stay inside the film: the nearest folder that already exists is checked
 * before any folder is made, so a link under `film/` cannot make folders
 * elsewhere, and the parent is checked again once it exists. Fails with
 * `EPATHESCAPE` like `resolveFilmFile`.
 * @param cwd - the workspace directory.
 * @param path - the path relative to `film/`, `/`-separated.
 * @returns the file's path under its real parent, to write to.
 */
export async function filmWriteTarget(cwd: string, path: string): Promise<string> {
  const parts = path.split('/')
  if (path === '' || path.includes('\0') || path.includes('\\') || isAbsolute(path) || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw fileError('EPATHESCAPE', `${path} is not a path inside the film.`)
  }
  await mkdir(join(cwd, FILM_DIR), { recursive: true })
  const root = await realpath(join(cwd, FILM_DIR))
  const parent = join(root, ...parts.slice(0, -1))
  for (let existing = parent; ; existing = dirname(existing)) {
    const real = await realpath(existing).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (real !== undefined) {
      if (!inside(root, real)) throw fileError('EPATHESCAPE', `${path} leaves the film.`)
      break
    }
    if (existing === root || dirname(existing) === existing) break
  }
  await mkdir(parent, { recursive: true })
  const realParent = await realpath(parent)
  if (!inside(root, realParent)) throw fileError('EPATHESCAPE', `${path} leaves the film.`)
  return join(realParent, parts[parts.length - 1] ?? '')
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
