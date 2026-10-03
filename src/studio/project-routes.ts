/**
 * Studio's project file endpoints over the workspace's `film/` folder (the
 * Studio project): uploads, raw file reads with byte ranges, and the project
 * event stream. Plus the media catalogue the canvas loads at start, empty
 * until generation is connected.
 * @module dsh-film/studio/project-routes
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { appFileType } from '../apps.js'
import { CanvasAssetStore } from '../canvas/assets.js'
import type { CanvasAsset } from '../canvas/assets.js'
import { serveFile } from '../files.js'
import type { ProjectEvents } from './events.js'
import { StudioApiError } from './router.js'
import type { StudioRouter } from './router.js'
import { eventStream } from './sse.js'
import { projectOf } from './canvas-routes.js'

/** The Studio project folder inside a workspace. */
export const PROJECT_DIR = 'film'
/** Studio's upload limit. */
export const UPLOAD_LIMIT = 20 * 1024 * 1024

/** Documents a browser could run scripts from; served in a sandbox. */
const UNTRUSTED_DOCUMENTS = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml'])

/**
 * Resolve a project-relative path inside the workspace's project folder.
 * @param cwd - the workspace directory.
 * @param path - the path the app sent, with `/` separators.
 * @returns the absolute path.
 */
export function projectPath(cwd: string, path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.')
  if (path.includes('\0') || isAbsolute(path) || parts.length === 0 || parts.some(part => part === '..')) {
    throw new StudioApiError(400, 'BAD_REQUEST', 'A path inside the project is required.')
  }
  return join(cwd, PROJECT_DIR, ...parts)
}

async function insideProject(cwd: string, target: string): Promise<boolean> {
  const root = await realpath(join(cwd, PROJECT_DIR)).catch(() => undefined)
  const real = await realpath(target).catch(() => undefined)
  if (root === undefined || real === undefined) return false
  const offset = relative(root, real)
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset)
}

/**
 * Add the project routes to a router.
 * @param router - the Studio-compatible router.
 * @param events - the project event bus.
 */
export function addProjectRoutes(router: StudioRouter, events: ProjectEvents): void {
  router.add('GET', '/api/projects/:projectId/events', async request => eventStream(request.raw, (stream) => {
    stream.send('ready', {})
    return events.subscribe(request.cwd, event => { stream.send(event.type, event) })
  }))

  router.add('GET', '/api/projects/:projectId/raw/*path', async (request) => {
    const path = projectPath(request.cwd, request.params.path!)
    const info = await lstat(path).catch(() => undefined)
    if (info === undefined || !info.isFile() || !await insideProject(request.cwd, path)) {
      throw new StudioApiError(404, 'NOT_FOUND', 'File not found.')
    }
    const headers: Record<string, string> = { 'Cache-Control': 'private, no-cache' }
    if (UNTRUSTED_DOCUMENTS.has(extname(path).toLowerCase())) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"
    return serveFile(request.raw, { path, size: info.size, modified: info.mtime, type: appFileType(path), headers })
  })

  router.add('POST', '/api/projects/:projectId/files', async (request) => {
    let form: FormData
    try {
      form = await request.raw.formData()
    } catch {
      throw new StudioApiError(400, 'BAD_REQUEST', 'A multipart upload with name and file is required.')
    }
    const name = form.get('name')
    const file = form.get('file')
    if (typeof name !== 'string' || name.trim() === '' || typeof file === 'string' || file === null) {
      throw new StudioApiError(400, 'BAD_REQUEST', 'A multipart upload with name and file is required.')
    }
    if (file.size > UPLOAD_LIMIT) throw new StudioApiError(413, 'PAYLOAD_TOO_LARGE', 'The file exceeds the 20 MB upload limit.')
    const target = projectPath(request.cwd, name)
    await mkdir(dirname(target), { recursive: true })
    if (!await insideProject(request.cwd, dirname(target))) throw new StudioApiError(400, 'BAD_REQUEST', 'A path inside the project is required.')
    const existing = await lstat(target).catch(() => undefined)
    if (existing?.isSymbolicLink() === true || existing?.isDirectory() === true) throw new StudioApiError(409, 'CONFLICT', 'The path is not a regular file.')
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, new Uint8Array(await file.arrayBuffer()))
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
    const relativeName = relative(join(request.cwd, PROJECT_DIR), target).split(sep).join('/')
    events.emit(request.cwd, { type: 'file-changed', projectId: projectOf(request), path: relativeName })
    return { file: { name: relativeName, size: file.size, mime: file.type || appFileType(target) } }
  })

  // The asset library: the project's media, wearing the overlay the canvas saves.
  router.add('GET', '/api/canvas/assets/:boardId', async request =>
    new CanvasAssetStore(request.cwd).read(request.params.boardId!, projectOf(request)))
  router.add('PUT', '/api/canvas/assets/:boardId', async (request) => {
    const body = await request.json()
    if (!Array.isArray(body.assets)) throw new StudioApiError(400, 'BAD_REQUEST', 'assets must be an array.')
    return new CanvasAssetStore(request.cwd).write(request.params.boardId!, projectOf(request), body.assets as CanvasAsset[])
  })
}
