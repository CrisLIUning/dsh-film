/**
 * The editing desk's material: the film's media as the editor's authorized
 * assets, the workspace's own media as files it may import, and the import
 * that brings a workspace file into the film.
 *
 * An import copies the file into `film/canvas/media/` — a clone where the file
 * system offers one (copy-on-write: no space used until either side changes),
 * a full copy elsewhere, never a hard link, so a tool editing the workspace
 * file in place leaves the film's copy as it was. It answers an earlier import
 * of the same bytes instead of making `x-2`, and is recorded in
 * `film/canvas/imports.json` (media-imports.ts) so the libraries stop offering
 * a file the film already has, until the file changes.
 * @module dsh-film/studio/material
 */

import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { listFilmMedia, listWorkspaceMedia, mediaTypeOf, resolveWorkspaceMedia, workspaceMediaUrl } from '../media.js'
import type { MediaKind, ResolvedWorkspaceMedia } from '../media.js'
import { noteImport, withImportLock, withoutImported } from '../media-imports.js'
import { CANVAS_FILE_VERSION_PREFIX, projectRawUrl } from '../timeline/commands.js'
import { freeProjectPath, projectPath } from './project-routes.js'

/** Media the editor can place: Studio's list for a board. */
const EDITOR_MEDIA = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'm4a', 'mp4', 'webm', 'mov'])
/** Where imported and generated material is kept, relative to `film/`. */
export const MATERIAL_DIR = 'canvas/media'

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
  const [film, workspace] = await Promise.all([listFilmMedia(cwd), listWorkspaceMedia(cwd)])
  const assets: AuthorizedAsset[] = []
  for (const file of film) {
    const type = mediaTypeOf(file.path)
    if (!editorMedia(file.path) || type === undefined) continue
    const identity = `${CANVAS_FILE_VERSION_PREFIX}${file.path}`
    assets.push({ assetId: identity, versionId: identity, kind: file.kind, name: basename(file.path), url: projectRawUrl(projectId, file.path), mimeType: type.type, sizeBytes: file.bytes })
  }
  const projectFiles: WorkspaceMediaFile[] = []
  for (const file of await withoutImported(cwd, workspace.files, new Set(film.map(entry => entry.path)))) {
    const type = mediaTypeOf(file.path)
    if (!editorMedia(file.path) || type === undefined) continue
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
 * for `path` (x.png, x-2.png, ...) up to the first free one, the first that
 * matches the source's size and digest.
 * @param cwd - the workspace.
 * @param path - the import's film-relative name.
 * @param source - the file being imported.
 * @returns the earlier copy's film-relative name, if there is one.
 */
async function identicalCopy(cwd: string, path: string, source: ResolvedWorkspaceMedia): Promise<string | undefined> {
  const match = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(path)
  const stem = match?.[1] ?? path
  const extension = match?.[2] ?? ''
  let sourceDigest: string | undefined
  for (let index = 1; index < 10_000; index++) {
    const candidate = index === 1 ? path : `${stem}-${index}${extension}`
    const info = await lstat(projectPath(cwd, candidate)).catch(() => undefined)
    if (info === undefined) return undefined
    if (!info.isFile() || info.size !== source.stats.size) continue
    sourceDigest ??= await sha256File(source.absolute)
    if (await sha256File(projectPath(cwd, candidate)).catch(() => undefined) === sourceDigest) return candidate
  }
  return undefined
}

/**
 * Copy a file into the film under the first free name: a clone where the
 * file system offers one (`COPYFILE_FICLONE`: shared blocks, copy-on-write), a
 * full copy elsewhere — never a hard link, so editing either file in place
 * leaves the other as it was. The copy never replaces an existing name.
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
      await copyFile(source, absolute, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      // Not EEXIST: whatever is at the free name now is this copy's unfinished file.
      await rm(absolute, { force: true }).catch(() => {})
      throw error
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
 * Bring a workspace media file into the film, as a copy. A file already under
 * `film/` is answered with its film-relative path and not copied. Imports of
 * one workspace take turns, so the same file imported twice at once is copied once.
 * @param cwd - the workspace directory.
 * @param path - the workspace-relative path; refused as {@link resolveWorkspaceMedia} refuses it.
 * @returns the film's file.
 */
export async function importWorkspaceMedia(cwd: string, path: string): Promise<ImportedMedia> {
  const source = await resolveWorkspaceMedia(cwd, path)
  const size = source.stats.size
  if (source.filmPath !== undefined) return { file: { name: source.filmPath, size, mime: source.type }, created: false }
  const wanted = `${MATERIAL_DIR}/${basename(source.path)}`
  return withImportLock(cwd, async (): Promise<ImportedMedia> => {
    // Importing the same bytes again answers the earlier copy, so a retried bind or attach does not pile up x-2, x-3, ...
    const earlier = await identicalCopy(cwd, wanted, source)
    if (earlier !== undefined) {
      await noteImport(cwd, source, earlier)
      return { file: { name: earlier, size, mime: mediaTypeOf(earlier)?.type ?? source.type }, reused: true, created: false }
    }
    const target = await placeInFilm(cwd, wanted, source.absolute)
    await noteImport(cwd, source, target)
    return { file: { name: target, size, mime: mediaTypeOf(target)?.type ?? source.type }, created: true }
  })
}
