/**
 * Hosting the original film apps — the storyboard canvas, with the director
 * desk inside it — inside the Host. Each app's built files live in
 * the package under `apps/<app>/` and are served from
 * `/api/dsh-film/apps/<app>/<path>`, which the workbench loads in a frame.
 *
 * The Host's API channel matches paths exactly, so every file gets its own
 * route. Path segments the channel cannot carry (characters outside
 * `[A-Za-z0-9_$.-]`) are skipped and reported; the app build must not
 * produce them.
 * @module dsh-film/apps
 */

import { readdirSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { serveFile } from './files.js'

export const APPS_PREFIX = '/api/dsh-film/apps'

/** One path segment the Host's API channel accepts. */
const SEGMENT = /^[A-Za-z0-9_$.-]+$/

const isSegment = (segment: string): boolean => SEGMENT.test(segment) && segment !== '.' && segment !== '..'

/** Content types by extension; anything else is served as bytes. */
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.hdr': 'image/vnd.radiance',
  '.ktx2': 'image/ktx2',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
}

/**
 * The content type of an app file.
 * @param path - the file path.
 * @returns the type.
 */
export function appFileType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** A bundler's content-hashed file name (`name-3fA9_kQ2.js`): safe to cache for good. */
const HASHED = /[-.][A-Za-z0-9_]{8,}\.[A-Za-z0-9]+$/

/**
 * How long a client may keep an app file: hashed bundles forever, everything
 * else (the app's pages above all) revalidated on each load.
 * @param relative - the file path inside the app.
 * @returns the `Cache-Control` value.
 */
export function appFileCaching(relative: string): string {
  return !relative.endsWith('.html') && HASHED.test(relative) ? 'private, max-age=31536000, immutable' : 'no-cache'
}

/** One servable file of an app. */
export interface AppFile {
  app: string
  /** Inside the app, with `/` separators. */
  relative: string
  /** Absolute path on disk. */
  path: string
  /** The route that serves it. */
  route: string
}

/**
 * List an app's files. Symbolic links are not followed.
 * @param app - the app's name (one path segment).
 * @param root - the app's directory.
 * @returns the servable files and the relative paths that were skipped.
 */
export function scanApp(app: string, root: string): { files: AppFile[]; skipped: string[] } {
  if (!isSegment(app)) throw new Error(`dsh-film: app name ${JSON.stringify(app)} cannot be a route segment`)
  const files: AppFile[] = []
  const skipped: string[] = []
  const visit = (directory: string, segments: readonly string[]): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = [...segments, entry.name]
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), relative)
      } else if (entry.isFile()) {
        if (relative.every(isSegment)) {
          files.push({ app, relative: relative.join('/'), path: join(directory, entry.name), route: `${APPS_PREFIX}/${app}/${relative.join('/')}` })
        } else {
          skipped.push(relative.join('/'))
        }
      }
    }
  }
  visit(root, [])
  files.sort((left, right) => left.relative.localeCompare(right.relative))
  return { files, skipped }
}

/**
 * Find the apps in the package's `apps/` directory: one per subdirectory that
 * holds an `index.html`.
 * @param root - the `apps/` directory.
 * @returns app names with their directories; none when the directory is missing.
 */
export function findApps(root: string): { app: string; directory: string }[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory() && isSegment(entry.name))
    .map(entry => ({ app: entry.name, directory: join(root, entry.name) }))
    .filter(({ directory }) => statSync(join(directory, 'index.html'), { throwIfNoEntry: false })?.isFile() === true)
}

/**
 * The routes serving an app's files.
 * @param files - the files from {@link scanApp}.
 * @returns one GET/HEAD route per file.
 */
export function appRoutes(files: readonly AppFile[]): ConnectionFetchRoute[] {
  return files.map(file => ({
    path: file.route,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      const info = await stat(file.path).catch(() => undefined)
      if (info?.isFile() !== true) return new Response(request.method === 'HEAD' ? null : 'not found', { status: 404 })
      const headers: Record<string, string> = { 'Cache-Control': appFileCaching(file.relative) }
      // App pages may only be framed by the Host's own pages.
      if (file.relative.endsWith('.html')) headers['Content-Security-Policy'] = "frame-ancestors 'self'"
      return serveFile(request, { path: file.path, size: info.size, modified: info.mtime, type: appFileType(file.path), headers })
    },
  }))
}
