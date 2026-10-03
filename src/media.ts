/**
 * Media files of the workspace: which files count as media, the listing the
 * workbench picks from, and byte-range responses so a video can be played
 * and scrubbed in the browser without loading the whole file.
 * @module dsh-film/media
 */

import { readdir, stat } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { FilmError } from './errors.js'
import { serveFile } from './files.js'

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

/** One media file of the workspace. */
export interface MediaAsset {
  /** Relative to the workspace, with `/` separators. */
  path: string
  kind: MediaKind
  bytes: number
  /** ISO 8601. */
  modifiedAt: string
}

/** Folders of the workspace the listing looks in: dsh-media's outputs, then the film's own. */
export const ASSET_ROOTS = ['media', 'film'] as const
/** The listing stops after this many files and says it did. */
export const ASSET_LIMIT = 500
/** Folders deeper than this under a root are not entered. */
const ASSET_DEPTH = 6

/**
 * List the media files under the asset roots, newest first. Hidden folders,
 * `node_modules` and symbolic links are skipped.
 * @param cwd - the workspace directory.
 * @param limit - the most files to return.
 * @returns the files and whether the listing stopped early.
 */
export async function listAssets(cwd: string, limit = ASSET_LIMIT): Promise<{ assets: MediaAsset[]; truncated: boolean }> {
  const assets: MediaAsset[] = []
  let truncated = false
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (truncated) return
    const entries = await readdir(join(cwd, relative), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (depth < ASSET_DEPTH && entry.name !== 'node_modules') await visit(child, depth + 1)
      } else if (entry.isFile()) {
        const media = mediaTypeOf(entry.name)
        if (media === undefined) continue
        if (assets.length >= limit) {
          truncated = true
          return
        }
        const info = await stat(join(cwd, child)).catch(() => undefined)
        if (info === undefined) continue
        assets.push({ path: child, kind: media.kind, bytes: info.size, modifiedAt: info.mtime.toISOString() })
      }
      if (truncated) return
    }
  }
  for (const root of ASSET_ROOTS) await visit(root, 1)
  assets.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.path.localeCompare(right.path))
  return { assets, truncated }
}

const MEDIA_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

/**
 * Answer a GET or HEAD for one media file, honouring a single byte range.
 * @param request - the request; `path` in its query is the absolute file path.
 * @returns the response.
 */
export async function serveMedia(request: Request): Promise<Response> {
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path === '' || path.includes('\0') || !isAbsolute(path)) {
    throw new FilmError('BAD_REQUEST', 'An absolute media path is required.')
  }
  const media = mediaTypeOf(path)
  if (media === undefined) throw new FilmError('NOT_MEDIA', 'Only image, video and audio files are served here.')
  const info = await stat(path).catch(() => undefined)
  if (info?.isFile() !== true) throw new FilmError('FILE_NOT_FOUND', 'The media file does not exist.')
  return serveFile(request, { path, size: info.size, modified: info.mtime, type: media.type, headers: MEDIA_HEADERS })
}
