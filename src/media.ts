/**
 * Media files of the workspace: which files count as media, the workspace's
 * own media (everything outside `film/` that a person or another plugin put
 * there), the film's media, and byte-range responses so a video can be played
 * and scrubbed in the browser without loading the whole file.
 *
 * Every path that crosses a route here is workspace-relative and checked the
 * same way ({@link resolveWorkspaceMedia}): no absolute paths, no `.`/`..`, no
 * hidden, ignored or credential folders, media only (or media and the GLB, FBX
 * and OBJ models where the caller asks for them), and the real path must be
 * the path asked for inside the workspace (no links out). The workspace itself
 * must be a film workspace outside hidden and credential folders
 * ({@link requireFilmWorkspace}), so the caller-chosen `cwd` cannot widen that.
 * @module dsh-film/media
 */

import { lstat, readdir, realpath } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { performance } from 'node:perf_hooks'
import { FilmError } from './errors.js'
import { serveFile } from './files.js'
import { modelTypeOf } from './model-files/types.js'
import type { ModelFormat } from './model-files/types.js'
import { foldedName as folded, isCredentialDirName } from './path-rules.js'
import { FILM_DIR, requireFilmWorkspace, workspaceDirectory } from './project.js'

export type MediaKind = 'image' | 'video' | 'audio'

/** Extensions served as media, with their content types. */
const MEDIA_TYPES: Readonly<Record<string, { kind: MediaKind; type: string }>> = {
  '.png': { kind: 'image', type: 'image/png' },
  '.jpg': { kind: 'image', type: 'image/jpeg' },
  '.jpeg': { kind: 'image', type: 'image/jpeg' },
  '.webp': { kind: 'image', type: 'image/webp' },
  '.gif': { kind: 'image', type: 'image/gif' },
  '.avif': { kind: 'image', type: 'image/avif' },
  '.mp4': { kind: 'video', type: 'video/mp4' },
  '.m4v': { kind: 'video', type: 'video/mp4' },
  '.mov': { kind: 'video', type: 'video/quicktime' },
  '.webm': { kind: 'video', type: 'video/webm' },
  '.mp3': { kind: 'audio', type: 'audio/mpeg' },
  '.wav': { kind: 'audio', type: 'audio/wav' },
  '.m4a': { kind: 'audio', type: 'audio/mp4' },
  '.aac': { kind: 'audio', type: 'audio/aac' },
  '.ogg': { kind: 'audio', type: 'audio/ogg' },
  '.opus': { kind: 'audio', type: 'audio/ogg' },
  '.flac': { kind: 'audio', type: 'audio/flac' },
}

/**
 * The media kind and content type of a file, from its extension.
 * @param path - a file path.
 * @returns the kind and type, or `undefined` for anything that is not media.
 */
export function mediaTypeOf(path: string): { kind: MediaKind; type: string } | undefined {
  return MEDIA_TYPES[extname(path).toLowerCase()]
}

/** The model formats the workspace scan lists and the import copies: one file each. */
export type WorkspaceModelFormat = Exclude<ModelFormat, 'gltf'>

/**
 * The model format and content type of a file the workspace scan lists, from
 * its extension: GLB, FBX and OBJ. A `.gltf` is not one: its `.bin` and
 * textures are separate files that a one-file copy would leave behind.
 * @param path - a file path.
 * @returns the format and type, or `undefined`.
 */
export function workspaceModelTypeOf(path: string): { format: WorkspaceModelFormat; type: string } | undefined {
  const type = modelTypeOf(path)
  return type === undefined || type.format === 'gltf' ? undefined : { format: type.format, type: type.type }
}

/** One media file of the workspace. */
export interface MediaAsset {
  /** Relative to the workspace (or to `film/` for {@link listFilmMedia}), with `/` separators. */
  path: string
  kind: MediaKind
  bytes: number
  /** ISO 8601. */
  modifiedAt: string
}

// ---------------------------------------------------------------------------
// What is never listed. Ported from Studio (apps/daemon/src/project-ignored-dirs.ts),
// so the film sees a workspace the way Studio's file panel does.

/** Generated, installed and cache trees: no person's material lives there. */
const IGNORED_DIR_NAMES = new Set([
  '.git', '.file-versions', '.live-artifacts', '.od-skills', '.vibedev', 'node_modules', 'vendor', '.od', 'debug', 'dist', 'build',
  '.build', 'deriveddata', 'target', '.next', '.nuxt', '.turbo', '.cache', '.output', 'out', 'coverage', '.gradle', '.swiftpm', '.tmp',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.ruff_cache',
])
/** Families of the same (each prefix ends in a separator, so `pack-` never swallows `packages`). */
const IGNORED_DIR_NAME_PREFIXES = ['pack-', '.tmp-', 'wt-', 'deriveddata-'] as const
/** Ignored wherever they appear in a path. */
const IGNORED_PATH_PREFIXES = [['.claude', 'worktrees'], ['.claude', 'projects'], ['.claude', 'cache'], ['.vibedev']] as const

/**
 * Whether a folder of this name is never entered: hidden, generated or
 * installed trees, and credential stores.
 * @param name - the folder's name.
 * @returns true when the scan skips it.
 */
export function isSkippedDirName(name: string): boolean {
  const key = folded(name)
  return name.startsWith('.') || IGNORED_DIR_NAMES.has(key) || isCredentialDirName(name)
    || IGNORED_DIR_NAME_PREFIXES.some(prefix => key.startsWith(prefix))
}

/**
 * Folders the film's own listing does not enter below `film/`, besides hidden
 * ones. The film's folders are the film's: a capture under `film/…/build/` or
 * `film/…/out/` is its material, unlike a build tree elsewhere in the workspace.
 */
const FILM_SKIPPED = new Set(['node_modules'])

/** Whether the film's own listing skips a folder of this name below `film/`. */
const isFilmSkippedDirName = (name: string): boolean => name.startsWith('.') || FILM_SKIPPED.has(folded(name))

/** Whether a run of folder names contains one of the ignored path prefixes. */
function hasIgnoredPrefix(folders: readonly string[]): boolean {
  const keys = folders.map(folded)
  return IGNORED_PATH_PREFIXES.some(prefix => keys.some((_, start) => prefix.every((part, offset) => keys[start + offset] === part)))
}

const caseInsensitiveFiles = process.platform === 'win32' || process.platform === 'darwin'

/** The workspace's top-level `film/` folder, which only the film's own listing reads. */
const isFilmFolder = (name: string): boolean => caseInsensitiveFiles ? name.toLowerCase() === FILM_DIR : name === FILM_DIR

// ---------------------------------------------------------------------------
// One path, checked.

export type WorkspaceMediaProblem = 'invalid' | 'not-media' | 'not-found'

/** A workspace media path that is refused, and why. */
export class WorkspaceMediaError extends Error {
  override name = 'WorkspaceMediaError'

  constructor(readonly problem: WorkspaceMediaProblem, message: string) {
    super(message)
  }
}

/**
 * Check a workspace-relative media path without touching the disk: what the
 * scanners could list, and nothing else — the workspace scan outside `film/`,
 * the film's own listing ({@link listFilmMedia}) below it.
 * @param raw - the path as sent, with `/` or `\` separators.
 * @returns the path with `/` separators and no leading `./`.
 */
export function checkWorkspaceMediaPath(raw: string): string {
  return checkWorkspaceFilePath(raw)
}

/**
 * Check a workspace-relative path the way {@link checkWorkspaceMediaPath}
 * does, accepting model files (GLB, FBX, OBJ) too when asked.
 * @param raw - the path as sent, with `/` or `\` separators.
 * @param options - `models: true` to accept the model formats the scan lists.
 * @returns the path with `/` separators and no leading `./`.
 */
export function checkWorkspaceFilePath(raw: string, options: { models?: boolean } = {}): string {
  const path = raw.replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '')
  const invalid = (why: string): never => { throw new WorkspaceMediaError('invalid', `"${raw}" ${why}`) }
  if (path === '' || raw.includes('\0')) invalid('is not a workspace-relative path.')
  if (posix.isAbsolute(path) || win32.isAbsolute(raw) || /^[A-Za-z]:/u.test(path)) invalid('must be relative to the workspace.')
  const segments = path.split('/')
  if (segments.some(part => part === '' || part === '.' || part === '..')) invalid('must stay inside the workspace (no empty, "." or ".." parts).')
  if (segments.some(part => part.startsWith('.'))) invalid('is in a hidden folder or is a hidden file.')
  if (process.platform === 'win32' && segments.some(part => part.includes(':'))) invalid('names an alternate data stream.')
  const folders = segments.slice(0, -1)
  const skipped = folders.length > 0 && isFilmFolder(folders[0]!)
    ? folders.slice(1).some(isFilmSkippedDirName)
    : folders.some(isSkippedDirName) || hasIgnoredPrefix(folders)
  if (skipped) invalid('is in a folder that is never listed (generated, installed or credential files).')
  if (mediaTypeOf(path) !== undefined) return path
  if (options.models !== true) throw new WorkspaceMediaError('not-media', `"${raw}" is not an image, video or audio file.`)
  if (workspaceModelTypeOf(path) !== undefined) return path
  if (modelTypeOf(path)?.format === 'gltf') {
    throw new WorkspaceMediaError('not-media', `"${raw}" is a .gltf, whose .bin and texture files are separate: convert it to a GLB first.`)
  }
  throw new WorkspaceMediaError('not-media', `"${raw}" is not an image, video, audio or model (GLB, FBX, OBJ) file.`)
}

/** A workspace media file, proven to be where it was asked for. */
export interface ResolvedWorkspaceMedia {
  /** Relative to the workspace, as the file system spells it, with `/` separators. */
  path: string
  /** The real path. */
  absolute: string
  /** Relative to `film/` when the file is the film's own. */
  filmPath?: string
  kind: MediaKind
  type: string
  stats: Stats
}

const samePath = (left: string, right: string): boolean => caseInsensitiveFiles
  ? left.normalize('NFC').toLowerCase() === right.normalize('NFC').toLowerCase()
  : left.normalize('NFC') === right.normalize('NFC')

const inside = (root: string, path: string): string | undefined => {
  const offset = relative(root, path)
  return offset === '' || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset) ? undefined : offset
}

/** A workspace media or model file, proven to be where it was asked for. */
export interface ResolvedWorkspaceFile extends Omit<ResolvedWorkspaceMedia, 'kind'> {
  kind: MediaKind | 'model'
  /** The model format, for a model file. */
  format?: WorkspaceModelFormat
}

/**
 * Find a workspace media file: the path is checked ({@link checkWorkspaceMediaPath}),
 * then its real path must be exactly that path under the real workspace — a
 * link anywhere on the way, or a path that leaves the workspace, is refused.
 * @param cwd - the workspace directory.
 * @param raw - the workspace-relative path as sent.
 * @returns the file.
 */
export async function resolveWorkspaceMedia(cwd: string, raw: string): Promise<ResolvedWorkspaceMedia> {
  return await resolveWorkspaceFile(cwd, raw) as ResolvedWorkspaceMedia
}

/**
 * Find a workspace media file, or a model file when asked, under the same
 * rules as {@link resolveWorkspaceMedia}.
 * @param cwd - the workspace directory.
 * @param raw - the workspace-relative path as sent.
 * @param options - `models: true` to accept GLB, FBX and OBJ files.
 * @returns the file.
 */
export async function resolveWorkspaceFile(cwd: string, raw: string, options: { models?: boolean } = {}): Promise<ResolvedWorkspaceFile> {
  const path = checkWorkspaceFilePath(raw, options)
  const segments = path.split('/')
  const missing = (): WorkspaceMediaError => new WorkspaceMediaError('not-found', `There is no ${options.models === true ? 'media or model' : 'media'} file "${path}" in the workspace.`)
  const root = await realpath(cwd).catch(() => undefined)
  if (root === undefined) throw missing()
  const expected = join(root, ...segments)
  const real = await realpath(expected).catch(() => undefined)
  if (real === undefined) throw missing()
  if (!samePath(real, expected)) throw new WorkspaceMediaError('invalid', `"${raw}" goes through a link or leaves the workspace.`)
  const stats = await lstat(real).catch(() => undefined)
  if (stats?.isFile() !== true) throw missing()
  const film = await realpath(join(root, FILM_DIR)).catch(() => undefined)
  const filmOffset = film === undefined ? undefined : inside(film, real)
  const media = mediaTypeOf(path)
  const model = media === undefined ? workspaceModelTypeOf(path) : undefined
  return {
    path: relative(root, real).split(sep).join('/'),
    absolute: real,
    ...(filmOffset !== undefined ? { filmPath: filmOffset.split(sep).join('/') } : {}),
    kind: media?.kind ?? 'model',
    ...(model !== undefined ? { format: model.format } : {}),
    type: media?.type ?? model!.type,
    stats,
  }
}

// ---------------------------------------------------------------------------
// Listing.

/** The scanner's limits: folders deeper than this below the workspace are not entered. */
export const WORKSPACE_MEDIA_DEPTH = 12
/** The most media files one listing returns. */
export const WORKSPACE_MEDIA_LIMIT = 2000
/** The most directory entries one listing reads. */
export const WORKSPACE_ENTRY_LIMIT = 50_000
/** How long one listing may read, in milliseconds. */
export const WORKSPACE_SCAN_BUDGET_MS = 1500
/** How long a listing is reused: a file put in the workspace from outside is listed within this long. */
export const WORKSPACE_CACHE_MS = 3000
/** Folders read at once. */
const READ_BATCH = 16

interface WalkLimits {
  depth: number
  files: number
  /** The most model files collected (beside the media, not counted against `files`); none when left out. */
  models?: number
  entries: number
  /** `performance.now()` past which the walk stops. */
  deadline: number
  /** Folders of the walk's root that are not entered. */
  skipTop?: (name: string) => boolean
  /** Folders not entered anywhere. */
  skip: (name: string) => boolean
}

export type EntryKind = 'file' | 'dir' | 'other'

/**
 * What a directory entry is to a scan. Windows reports every reparse point as
 * a link, OneDrive's cloud files among them, so a link is asked again with
 * lstat: only a real symbolic link or junction is left out.
 * @param entry - the entry as readdir gave it.
 * @param path - its absolute path.
 * @returns its kind, with its lstat when that was needed.
 */
export async function entryKind(entry: Pick<Dirent, 'isDirectory' | 'isFile' | 'isSymbolicLink'>, path: string): Promise<{ kind: EntryKind; stats?: Stats }> {
  if (entry.isDirectory()) return { kind: 'dir' }
  if (entry.isFile()) return { kind: 'file' }
  if (!entry.isSymbolicLink()) return { kind: 'other' }
  const stats = await lstat(path).catch(() => undefined)
  if (stats === undefined || stats.isSymbolicLink()) return { kind: 'other' }
  return stats.isDirectory() ? { kind: 'dir' } : stats.isFile() ? { kind: 'file', stats } : { kind: 'other' }
}

/** One model file of the workspace (GLB, FBX or OBJ), as the scan lists it. */
export interface WorkspaceModelFile {
  /** Relative to the workspace, with `/` separators. */
  path: string
  format: WorkspaceModelFormat
  bytes: number
  /** ISO 8601. */
  modifiedAt: string
}

/**
 * Breadth first through a folder: its media files (and model files, when
 * asked), hidden names and skipped folders left out, links never followed.
 * @param root - the folder.
 * @param limits - when to stop.
 * @returns the files and models (relative to `root`, unsorted) and whether the walk stopped early.
 */
async function walkMedia(root: string, limits: WalkLimits): Promise<{ files: MediaAsset[]; models: WorkspaceModelFile[]; truncated: boolean }> {
  const files: MediaAsset[] = []
  const models: WorkspaceModelFile[] = []
  const modelLimit = limits.models ?? 0
  let entries = 0
  let truncated = false
  let level: string[] = ['']
  for (let depth = 0; level.length > 0 && !truncated; depth++) {
    const next: string[] = []
    for (let start = 0; start < level.length && !truncated; start += READ_BATCH) {
      if (performance.now() > limits.deadline) {
        truncated = true
        break
      }
      const batch = level.slice(start, start + READ_BATCH)
      const listings = await Promise.all(batch.map(folder => readdir(join(root, ...folder.split('/').filter(Boolean)), { withFileTypes: true }).catch(() => [] as Dirent[])))
      const candidates: Array<{ relative: string; entry: Dirent }> = []
      for (const [index, listing] of listings.entries()) {
        const folder = batch[index]!
        for (const entry of listing.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
          if (++entries > limits.entries) {
            truncated = true
            break
          }
          if (entry.name.startsWith('.')) continue
          candidates.push({ relative: folder === '' ? entry.name : `${folder}/${entry.name}`, entry })
        }
        if (truncated) break
      }
      const kinds = await Promise.all(candidates.map(({ relative: path, entry }) => entryKind(entry, join(root, ...path.split('/')))))
      const media: Array<{ path: string; kind: MediaKind; stats?: Stats }> = []
      const found: Array<{ path: string; format: WorkspaceModelFormat; stats?: Stats }> = []
      for (const [index, { relative: path, entry }] of candidates.entries()) {
        const { kind, stats } = kinds[index]!
        if (kind === 'dir') {
          if (depth < limits.depth && !limits.skip(entry.name) && !(depth === 0 && limits.skipTop?.(entry.name) === true)) next.push(path)
        } else if (kind === 'file') {
          const type = mediaTypeOf(entry.name)
          if (type !== undefined) media.push({ path, kind: type.kind, ...(stats !== undefined ? { stats } : {}) })
          else if (models.length + found.length < modelLimit) {
            const model = workspaceModelTypeOf(entry.name)
            if (model !== undefined) found.push({ path, format: model.format, ...(stats !== undefined ? { stats } : {}) })
          }
        }
      }
      const modelStats = await Promise.all(found.map(file => file.stats ?? lstat(join(root, ...file.path.split('/'))).catch(() => undefined)))
      for (const [index, file] of found.entries()) {
        const info = modelStats[index]
        if (info?.isFile() === true) models.push({ path: file.path, format: file.format, bytes: info.size, modifiedAt: info.mtime.toISOString() })
      }
      const room = limits.files - files.length
      if (media.length > room) {
        truncated = true
        media.length = Math.max(0, room)
      }
      const stats = await Promise.all(media.map(file => file.stats ?? lstat(join(root, ...file.path.split('/'))).catch(() => undefined)))
      for (const [index, file] of media.entries()) {
        const info = stats[index]
        if (info?.isFile() === true) files.push({ path: file.path, kind: file.kind, bytes: info.size, modifiedAt: info.mtime.toISOString() })
      }
    }
    level = next
  }
  return { files, models, truncated }
}

const newestFirst = (left: { path: string; modifiedAt: string }, right: { path: string; modifiedAt: string }): number =>
  right.modifiedAt.localeCompare(left.modifiedAt) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)

/** The most model files one workspace listing returns. */
export const WORKSPACE_MODEL_LIMIT = 300

/** A workspace's media listing. */
export interface WorkspaceMediaListing {
  /** Newest first; paths relative to the workspace. */
  files: MediaAsset[]
  /** The GLB, FBX and OBJ files the same scan found (at most {@link WORKSPACE_MODEL_LIMIT}), newest first. */
  models: WorkspaceModelFile[]
  /** The scan stopped at a limit (files, entries or time) before it read everything. */
  truncated: boolean
}

const cache = new Map<string, { listing: Promise<WorkspaceMediaListing>; expires: number }>()

/** Limits of one workspace scan; each defaults to the scanner's own. */
export interface WorkspaceScanLimits {
  depth?: number
  files?: number
  models?: number
  entries?: number
  budgetMs?: number
}

/**
 * Read the workspace's own media now, without the cache (see {@link listWorkspaceMedia}).
 * @param cwd - the workspace directory.
 * @param limits - other limits than the scanner's (tests).
 * @returns the listing.
 */
export async function scanWorkspaceMedia(cwd: string, limits: WorkspaceScanLimits = {}): Promise<WorkspaceMediaListing> {
  const { files, models, truncated } = await walkMedia(cwd, {
    depth: limits.depth ?? WORKSPACE_MEDIA_DEPTH,
    files: limits.files ?? WORKSPACE_MEDIA_LIMIT,
    models: limits.models ?? WORKSPACE_MODEL_LIMIT,
    entries: limits.entries ?? WORKSPACE_ENTRY_LIMIT,
    deadline: performance.now() + (limits.budgetMs ?? WORKSPACE_SCAN_BUDGET_MS),
    skip: isSkippedDirName,
    skipTop: isFilmFolder,
  })
  return { files: files.sort(newestFirst), models: models.sort(newestFirst), truncated }
}

/**
 * The workspace's own media: image, video and audio files outside `film/`,
 * newest first, and beside them the GLB, FBX and OBJ models the same scan
 * found (at most {@link WORKSPACE_MODEL_LIMIT}). Hidden entries, generated and installed trees, credential
 * folders and links are skipped; the scan is breadth first and stops at
 * {@link WORKSPACE_MEDIA_LIMIT} files, {@link WORKSPACE_ENTRY_LIMIT} entries or
 * {@link WORKSPACE_SCAN_BUDGET_MS}, and says so. A listing is reused for
 * {@link WORKSPACE_CACHE_MS} unless {@link invalidateWorkspaceMedia} is called.
 * The plugin's own writes do not call it: they all land under `film/`, which
 * this scan never reads, so a canvas autosave keeps the listing.
 * @param cwd - the workspace directory.
 * @returns the listing (a fresh array each call).
 */
export async function listWorkspaceMedia(cwd: string): Promise<WorkspaceMediaListing> {
  // Only a film workspace in a place a film may be is listed, like playing and importing: a caller-chosen
  // cwd must not turn the listing routes into a directory listing of any folder on the machine.
  try {
    await requireFilmWorkspace(cwd)
  } catch {
    return { files: [], models: [], truncated: false }
  }
  const key = resolve(cwd)
  const now = performance.now()
  for (const [other, entry] of cache) if (entry.expires <= now) cache.delete(other)
  let entry = cache.get(key)
  if (entry === undefined) {
    const listing = scanWorkspaceMedia(key)
    const created = { listing, expires: Number.POSITIVE_INFINITY }
    cache.set(key, entry = created)
    listing.then(
      () => { created.expires = performance.now() + WORKSPACE_CACHE_MS },
      () => { if (cache.get(key) === created) cache.delete(key) },
    )
  }
  const { files, models, truncated } = await entry.listing
  return { files: [...files], models: [...models], truncated }
}

/**
 * Forget the cached listing of a workspace (or of all), so the next one reads the disk.
 * @param cwd - the workspace; every workspace when left out.
 */
export function invalidateWorkspaceMedia(cwd?: string): void {
  if (cwd === undefined) cache.clear()
  else cache.delete(resolve(cwd))
}

/**
 * Every media file of the film (under `film/`), newest first, with paths
 * relative to `film/`. No count limit: a film file left out of the editing
 * desk's list is a clip it drops on its next save. Only hidden entries and
 * `node_modules` are skipped, the same rule {@link checkWorkspaceMediaPath}
 * applies below `film/`, so every file listed here can be played.
 * @param cwd - the workspace directory.
 * @returns the files.
 */
export async function listFilmMedia(cwd: string): Promise<MediaAsset[]> {
  const { files } = await walkMedia(join(cwd, FILM_DIR), {
    depth: 32,
    files: Number.POSITIVE_INFINITY,
    entries: Number.POSITIVE_INFINITY,
    deadline: Number.POSITIVE_INFINITY,
    skip: isFilmSkippedDirName,
  })
  return files.sort(newestFirst)
}

/** The workbench shelf lists at most this many files. */
export const ASSET_LIMIT = 500

/**
 * The workbench shelf: the film's media (as `film/…`) and the workspace's own,
 * newest first.
 * @param cwd - the workspace directory.
 * @param limit - the most files to return.
 * @returns the files and whether the list is incomplete.
 */
export async function listAssets(cwd: string, limit = ASSET_LIMIT): Promise<{ assets: MediaAsset[]; truncated: boolean }> {
  const [film, workspace] = await Promise.all([listFilmMedia(cwd), listWorkspaceMedia(cwd)])
  const all = [...film.map(file => ({ ...file, path: `${FILM_DIR}/${file.path}` })), ...workspace.files].sort(newestFirst)
  return { assets: all.slice(0, limit), truncated: workspace.truncated || all.length > limit }
}

/** The route that plays workspace media. */
const MEDIA_ROUTE = '/api/dsh-film/media'

/**
 * The URL a page plays a workspace media file from.
 * @param cwd - the workspace directory.
 * @param path - the file, relative to the workspace.
 * @returns the URL, rooted at the Host.
 */
export function workspaceMediaUrl(cwd: string, path: string): string {
  return `${MEDIA_ROUTE}?${new URLSearchParams({ cwd, path }).toString()}`
}

const MEDIA_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

const FILM_ERRORS = { 'invalid': 'BAD_REQUEST', 'not-media': 'NOT_MEDIA', 'not-found': 'FILE_NOT_FOUND' } as const

/**
 * Answer a GET or HEAD for one media file of a workspace, honouring a single byte range.
 * @param request - the request; its query names the workspace (`cwd`, a film
 *   workspace outside hidden and credential folders) and the file relative to it (`path`).
 * @returns the response.
 */
export async function serveMedia(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const cwd = await workspaceDirectory(query.get('cwd'))
  await requireFilmWorkspace(cwd)
  let media: ResolvedWorkspaceMedia
  try {
    media = await resolveWorkspaceMedia(cwd, query.get('path') ?? '')
  } catch (error) {
    if (error instanceof WorkspaceMediaError) throw new FilmError(FILM_ERRORS[error.problem], error.message)
    throw error
  }
  return serveFile(request, { path: media.absolute, size: media.stats.size, modified: media.stats.mtime, type: media.type, headers: MEDIA_HEADERS })
}
