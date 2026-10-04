/**
 * Bringing a workspace file into the film: the import behind the canvas
 * library's "insert", the agent's media binds and attaches, and place_model.
 *
 * An import copies the file into the film — media into `film/canvas/media/`,
 * GLB, FBX and OBJ models into `film/canvas/models/` — as a clone where the
 * file system offers one (copy-on-write: no space used until either side
 * changes), a full copy elsewhere, never a hard link, so a tool editing the
 * workspace file in place leaves the film's copy as it was. It answers an
 * earlier import of the same bytes instead of making `x-2`, and is recorded in
 * `film/canvas/imports.json` (media-imports.ts) so the libraries stop offering
 * a file the film already has, until the file changes. A file already under
 * `film/` is answered with its own name, without a copy. A `.gltf` is refused:
 * its `.bin` and textures are separate files a one-file copy would leave behind.
 * @module dsh-film/canvas/workspace-import
 */

import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { mediaTypeOf, resolveWorkspaceFile } from '../media.js'
import type { MediaKind, ResolvedWorkspaceFile, WorkspaceModelFormat } from '../media.js'
import { noteImport, withImportLock } from '../media-imports.js'
import { freeProjectPath, projectPath } from '../studio/project-routes.js'

/** Where imported and generated media are kept, relative to `film/`. */
export const MATERIAL_DIR = 'canvas/media'
/** Where imported models are kept, relative to `film/`. */
export const MODEL_DIR = 'canvas/models'

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

/** The film-relative name a workspace file is imported as, before any `-N`. */
export function importTarget(source: Pick<ResolvedWorkspaceFile, 'path' | 'kind'>): string {
  return `${source.kind === 'model' ? MODEL_DIR : MATERIAL_DIR}/${basename(source.path)}`
}

/**
 * An earlier import of the same bytes: the names `freeProjectPath` hands out
 * for `path` (x.png, x-2.png, ...) up to the first free one, the first that
 * matches the source's size and digest.
 * @param cwd - the workspace.
 * @param path - the import's film-relative name.
 * @param source - the file being imported.
 * @returns the earlier copy's film-relative name, if there is one.
 */
export async function identicalCopy(cwd: string, path: string, source: { absolute: string; stats: { size: number } }): Promise<string | undefined> {
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
export async function placeInFilm(cwd: string, wanted: string, source: string): Promise<string> {
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
export interface ImportedFile {
  file: { name: string; size: number; mime: string }
  kind: MediaKind | 'model'
  /** The model format, for a model. */
  format?: WorkspaceModelFormat
  /** The film already had these bytes under `file.name`. */
  reused?: true
  /** A new file was made in the film. */
  created: boolean
}

/**
 * Bring a workspace media or model file into the film, as a copy. A file
 * already under `film/` is answered with its film-relative path and not
 * copied. Imports of one workspace take turns, so the same file imported
 * twice at once is copied once.
 * @param cwd - the workspace directory.
 * @param path - the workspace-relative path; refused as {@link resolveWorkspaceFile} refuses it (models included).
 * @returns the film's file.
 */
export async function importWorkspaceFile(cwd: string, path: string): Promise<ImportedFile> {
  const source = await resolveWorkspaceFile(cwd, path, { models: true })
  const size = source.stats.size
  const kind = { kind: source.kind, ...(source.format !== undefined ? { format: source.format } : {}) }
  if (source.filmPath !== undefined) return { file: { name: source.filmPath, size, mime: source.type }, ...kind, created: false }
  const wanted = importTarget(source)
  const mimeOf = (name: string): string => mediaTypeOf(name)?.type ?? source.type
  return withImportLock(cwd, async (): Promise<ImportedFile> => {
    // Importing the same bytes again answers the earlier copy, so a retried bind or attach does not pile up x-2, x-3, ...
    const earlier = await identicalCopy(cwd, wanted, source)
    if (earlier !== undefined) {
      await noteImport(cwd, source, earlier)
      return { file: { name: earlier, size, mime: mimeOf(earlier) }, ...kind, reused: true, created: false }
    }
    const target = await placeInFilm(cwd, wanted, source.absolute)
    await noteImport(cwd, source, target)
    return { file: { name: target, size, mime: mimeOf(target) }, ...kind, created: true }
  })
}

/**
 * The film-relative name an import of this file would get now, without
 * copying: the earlier copy of the same bytes, or the first free name.
 * @param cwd - the workspace directory.
 * @param source - the resolved workspace file.
 * @returns the name and whether it is an earlier copy.
 */
export async function predictWorkspaceImport(cwd: string, source: ResolvedWorkspaceFile): Promise<{ name: string; reused: boolean }> {
  if (source.filmPath !== undefined) return { name: source.filmPath, reused: true }
  const wanted = importTarget(source)
  const earlier = await identicalCopy(cwd, wanted, source)
  return earlier !== undefined ? { name: earlier, reused: true } : { name: await freeProjectPath(cwd, wanted), reused: false }
}
