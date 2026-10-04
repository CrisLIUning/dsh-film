/**
 * The editing desk's material: the film's media as the editor's authorized
 * assets, the workspace's own media as files it may import, and the import
 * that brings a workspace file into the film.
 *
 * An import hard-links the file into `film/canvas/media/` (a copy where the
 * file system cannot link: another volume, a cloud placeholder…), answers an
 * earlier import of the same bytes instead of making `x-2`, and is recorded in
 * `film/canvas/imports.json` so the library stops offering a file the film
 * already has, until the file changes.
 * @module dsh-film/studio/material
 */

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { listFilmMedia, listWorkspaceMedia, mediaTypeOf, resolveWorkspaceMedia, workspaceMediaUrl } from '../media.js'
import type { MediaAsset, MediaKind, ResolvedWorkspaceMedia } from '../media.js'
import { FILM_DIR } from '../project.js'
import { CANVAS_FILE_VERSION_PREFIX, projectRawUrl } from '../timeline/commands.js'
import { freeProjectPath, projectPath } from './project-routes.js'

/** Media the editor can place: Studio's list for a board. */
const EDITOR_MEDIA = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'm4a', 'mp4', 'webm', 'mov'])
/** Where imported and generated material is kept, relative to `film/`. */
export const MATERIAL_DIR = 'canvas/media'
/** The import record, relative to the workspace. */
export const IMPORTS_FILE = `${FILM_DIR}/canvas/imports.json`

/** An asset the editor may play and place (the bridge's `VideoEditorAuthorizedAsset`). */
export interface AuthorizedAsset {
  assetId: string
  versionId: string
  kind: MediaKind
  name: string
  url: string
  mimeType: string
  sizeBytes?: number
}

/** A workspace file the editor lists for import (the bridge's `VideoEditorProjectFile`). */
export interface WorkspaceMediaFile {
  id: string
  path: string
  name: string
  kind: MediaKind
  url: string
  mimeType: string
  sizeBytes?: number
  mtime?: number
}

export const editorMedia = (path: string): boolean => EDITOR_MEDIA.has(extname(path).slice(1).toLowerCase())

/**
 * The SHA-256 of a file, hex.
 * @param path - the file.
 * @returns the digest.
 */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => { resolve(hash.digest('hex')) })
  })
}

// ---------------------------------------------------------------------------
// The import record.

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

/**
 * The film's import record. A missing or unreadable record is empty: it only
 * decides what the library offers, never what the film holds.
 * @param cwd - the workspace directory.
 * @returns the imports by workspace-relative source path.
 */
export async function readImports(cwd: string): Promise<Map<string, ImportRecord>> {
  try {
    const value = JSON.parse(await readFile(join(cwd, ...IMPORTS_FILE.split('/')), 'utf8')) as unknown
    const imports = isRecord(value) && isRecord(value.imports) ? value.imports : {}
    return new Map(Object.entries(imports).filter((entry): entry is [string, ImportRecord] => validRecord(entry[1])))
  } catch {
    return new Map()
  }
}

const recordWrites = new Map<string, Promise<unknown>>()

/**
 * Note an import in the record (one writer per workspace, written whole).
 * Failing to note it does not undo the import: the library just offers the file again.
 * @param cwd - the workspace directory.
 * @param source - the imported file.
 * @param target - its film-relative path in the film.
 */
async function recordImport(cwd: string, source: ResolvedWorkspaceMedia, target: string): Promise<void> {
  const file = join(cwd, ...IMPORTS_FILE.split('/'))
  const previous = recordWrites.get(file) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    const imports = Object.fromEntries(await readImports(cwd))
    imports[source.path] = { target, size: source.stats.size, modifiedAt: source.stats.mtime.toISOString(), importedAt: new Date().toISOString() }
    const state: ImportsFile = { version: 1, imports }
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
  })
  recordWrites.set(file, next)
  try {
    await next
  } catch {
    // The import stands; only the library's hint is lost.
  } finally {
    if (recordWrites.get(file) === next) recordWrites.delete(file)
  }
}

/** Whether a workspace file is already in the film, unchanged since it was imported. */
function alreadyImported(record: ImportRecord | undefined, file: MediaAsset, filmFiles: ReadonlySet<string>): boolean {
  return record !== undefined && record.size === file.bytes && record.modifiedAt === file.modifiedAt && filmFiles.has(record.target)
}

// ---------------------------------------------------------------------------
// The material listing.

/**
 * The film's media as the editor's authorization list, and the workspace's
 * own media as files it may import. Every editor-playable file under `film/`
 * is in the list — one left out is a clip the editor drops on its next save —
 * so the film has a full scan of its own, apart from the workspace's capped one.
 * A workspace file imported before and unchanged since is not offered again.
 * @param cwd - the workspace directory.
 * @param projectId - the film project's id.
 * @returns the assets and the importable files, newest first, and whether the workspace scan stopped early.
 */
export async function timelineMaterial(cwd: string, projectId: string): Promise<{ assets: AuthorizedAsset[]; projectFiles: WorkspaceMediaFile[]; truncated: boolean }> {
  const [film, workspace, imports] = await Promise.all([listFilmMedia(cwd), listWorkspaceMedia(cwd), readImports(cwd)])
  const filmFiles = new Set(film.map(file => file.path))
  const assets: AuthorizedAsset[] = []
  for (const file of film) {
    const type = mediaTypeOf(file.path)
    if (!editorMedia(file.path) || type === undefined) continue
    const identity = `${CANVAS_FILE_VERSION_PREFIX}${file.path}`
    assets.push({ assetId: identity, versionId: identity, kind: file.kind, name: basename(file.path), url: projectRawUrl(projectId, file.path), mimeType: type.type, sizeBytes: file.bytes })
  }
  const projectFiles: WorkspaceMediaFile[] = []
  for (const file of workspace.files) {
    const type = mediaTypeOf(file.path)
    if (!editorMedia(file.path) || type === undefined || alreadyImported(imports.get(file.path), file, filmFiles)) continue
    projectFiles.push({
      id: `workspace:${file.path}`,
      path: file.path,
      name: basename(file.path),
      kind: file.kind,
      url: workspaceMediaUrl(cwd, file.path),
      mimeType: type.type,
      sizeBytes: file.bytes,
      mtime: Date.parse(file.modifiedAt),
    })
  }
  return { assets, projectFiles, truncated: workspace.truncated }
}

// ---------------------------------------------------------------------------
// The import.

/**
 * An earlier import of the same bytes: the names `freeProjectPath` hands out
 * for `path` (x.png, x-2.png, ...) up to the first free one, the first that is
 * the source itself (a hard link) or matches its size and digest.
 * @param cwd - the workspace.
 * @param path - the import's film-relative name.
 * @param source - the file being imported.
 * @returns the earlier copy's film-relative name, if there is one.
 */
async function identicalCopy(cwd: string, path: string, source: ResolvedWorkspaceMedia): Promise<string | undefined> {
  const match = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(path)
  const stem = match?.[1] ?? path
  const extension = match?.[2] ?? ''
  const identity = await stat(source.absolute, { bigint: true }).catch(() => undefined)
  let sourceDigest: string | undefined
  for (let index = 1; index < 10_000; index++) {
    const candidate = index === 1 ? path : `${stem}-${index}${extension}`
    const info = await lstat(projectPath(cwd, candidate), { bigint: true }).catch(() => undefined)
    if (info === undefined) return undefined
    if (!info.isFile() || info.size !== BigInt(source.stats.size)) continue
    if (identity !== undefined && identity.ino !== 0n && info.ino === identity.ino && info.dev === identity.dev) return candidate
    sourceDigest ??= await sha256File(source.absolute)
    if (await sha256File(projectPath(cwd, candidate)).catch(() => undefined) === sourceDigest) return candidate
  }
  return undefined
}

/**
 * Put a file into the film under the first free name: a hard link, or a copy
 * (a clone where the file system offers one) where linking is not possible.
 * Neither replaces an existing name, so two imports cannot take the same one.
 * @param cwd - the workspace.
 * @param wanted - the film-relative name asked for.
 * @param source - the absolute path of the file.
 * @returns the film-relative name it got.
 */
async function placeInFilm(cwd: string, wanted: string, source: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const target = await freeProjectPath(cwd, wanted)
    const absolute = projectPath(cwd, target)
    await mkdir(dirname(absolute), { recursive: true })
    try {
      await link(source, absolute)
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
    }
    try {
      await copyFile(source, absolute, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`No free name for ${wanted} in the film.`)
}

/** An import's answer. */
export interface ImportedMedia {
  file: { name: string; size: number; mime: string }
  /** The film already had these bytes under `file.name`. */
  reused?: true
  /** A new file was made in the film. */
  created: boolean
}

/**
 * Bring a workspace media file into the film. A file already under `film/` is
 * answered with its film-relative path and not copied.
 * @param cwd - the workspace directory.
 * @param path - the workspace-relative path; refused as {@link resolveWorkspaceMedia} refuses it.
 * @returns the film's file.
 */
export async function importWorkspaceMedia(cwd: string, path: string): Promise<ImportedMedia> {
  const source = await resolveWorkspaceMedia(cwd, path)
  const size = source.stats.size
  if (source.filmPath !== undefined) return { file: { name: source.filmPath, size, mime: source.type }, created: false }
  const wanted = `${MATERIAL_DIR}/${basename(source.path)}`
  // Importing the same bytes again answers the earlier copy, so a retried bind or attach does not pile up x-2, x-3, ...
  const earlier = await identicalCopy(cwd, wanted, source)
  if (earlier !== undefined) {
    await recordImport(cwd, source, earlier)
    return { file: { name: earlier, size, mime: mediaTypeOf(earlier)?.type ?? source.type }, reused: true, created: false }
  }
  const target = await placeInFilm(cwd, wanted, source.absolute)
  await recordImport(cwd, source, target)
  return { file: { name: target, size, mime: mediaTypeOf(target)?.type ?? source.type }, created: true }
}
