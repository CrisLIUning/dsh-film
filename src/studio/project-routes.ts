/**
 * Studio's project file endpoints over the workspace's `film/` folder (the
 * Studio project): uploads, raw file reads with byte ranges, and the project
 * event stream. Plus the media catalogue the canvas loads at start, empty
 * until generation is connected.
 * @module dsh-film/studio/project-routes
 */

import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { appFileType } from '../apps.js'
import { CanvasAssetStore, withModelFacts, workspaceAssetFiles, workspaceModelFiles } from '../canvas/assets.js'
import type { CanvasAsset } from '../canvas/assets.js'
import { serveFile } from '../files.js'
import { listingBudget } from '../model-files/facts.js'
import type { ProjectEvents } from './events.js'
import { StudioApiError } from './router.js'
import type { StudioRouter } from './router.js'
import { eventStream } from './sse.js'
import { projectOf } from './canvas-routes.js'

/** The Studio project folder inside a workspace. */
export const PROJECT_DIR = 'film'
/** Studio's upload limit. */
export const UPLOAD_LIMIT = 20 * 1024 * 1024
/** The limit of a raw upload (an exported cut, a generated clip), streamed to disk. */
export const RAW_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024

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

/**
 * A project path nothing holds yet: `path` itself, or `<stem>-2.<ext>`,
 * `-3`... A name is taken whatever its case, as on Windows.
 * @param cwd - the workspace directory.
 * @param path - the wanted project-relative path.
 * @returns the first free path.
 */
export async function freeProjectPath(cwd: string, path: string): Promise<string> {
  const match = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(path)
  const stem = match?.[1] ?? path
  const extension = match?.[2] ?? ''
  for (let index = 1; index < 10_000; index++) {
    const candidate = index === 1 ? path : `${stem}-${index}${extension}`
    if (await lstat(projectPath(cwd, candidate)).catch(() => undefined) === undefined) return candidate
  }
  throw new StudioApiError(409, 'CONFLICT', `No free name for ${path}.`)
}

/** Stream a request body into a new file, refusing it past `limit` bytes; returns the size. */
async function writeBody(request: Request, path: string, limit: number): Promise<number> {
  const handle = await open(path, 'wx')
  let size = 0
  try {
    const reader = request.body?.getReader()
    if (reader === undefined) return 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        throw new StudioApiError(413, 'PAYLOAD_TOO_LARGE', `The file exceeds the ${limit / 1024 / 1024 / 1024} GB upload limit.`)
      }
      await handle.write(value)
    }
  } finally {
    await handle.close()
  }
  return size
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

  // A raw upload: the request body is the file, streamed to disk. With
  // `?unique=1` an existing name is not replaced: the file takes the first
  // free `-N` name instead, and the answer says which.
  router.add('PUT', '/api/projects/:projectId/raw/*path', async (request) => {
    const wanted = request.params.path!.replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.').join('/')
    const target = projectPath(request.cwd, wanted)
    await mkdir(dirname(target), { recursive: true })
    if (!await insideProject(request.cwd, dirname(target))) throw new StudioApiError(400, 'BAD_REQUEST', 'A path inside the project is required.')
    const temporary = join(dirname(target), `.upload-${randomUUID()}.tmp`)
    try {
      const size = await writeBody(request.raw, temporary, RAW_UPLOAD_LIMIT)
      let kept = wanted
      if (request.query.get('unique') === '1') {
        // link() refuses an existing name, so two uploads cannot take the same one.
        for (;;) {
          kept = await freeProjectPath(request.cwd, wanted)
          try {
            await link(temporary, projectPath(request.cwd, kept))
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          }
        }
      } else {
        const existing = await lstat(target).catch(() => undefined)
        if (existing?.isSymbolicLink() === true || existing?.isDirectory() === true) throw new StudioApiError(409, 'CONFLICT', 'The path is not a regular file.')
        await rename(temporary, target)
      }
      events.emit(request.cwd, { type: 'file-changed', projectId: projectOf(request), path: kept })
      return { file: { name: kept, size, mime: appFileType(kept) } }
    } finally {
      await rm(temporary, { force: true })
    }
  })

  // The asset library: the project's media, wearing the overlay the canvas
  // saves, and beside it the workspace's own media and models the board may
  // import. Model facts are measured here, not in the store: the story tools
  // read the store too and need none. One measuring budget per listing.
  router.add('GET', '/api/canvas/assets/:boardId', async (request) => {
    const [library, workspaceFiles] = await Promise.all([
      new CanvasAssetStore(request.cwd).read(request.params.boardId!, projectOf(request)),
      workspaceAssetFiles(request.cwd),
    ])
    const budget = listingBudget()
    const assets = await withModelFacts(request.cwd, library.assets, budget)
    const workspaceModels = await workspaceModelFiles(request.cwd, budget)
    return { ...library, assets, workspaceFiles, workspaceModels }
  })
  router.add('PUT', '/api/canvas/assets/:boardId', async (request) => {
    const body = await request.json()
    if (!Array.isArray(body.assets)) throw new StudioApiError(400, 'BAD_REQUEST', 'assets must be an array.')
    return new CanvasAssetStore(request.cwd).write(request.params.boardId!, projectOf(request), body.assets as CanvasAsset[])
  })
}
