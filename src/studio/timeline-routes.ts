/**
 * Studio's editing-desk endpoints (`routes/canvas.ts` timelines) over the
 * workspace's cut in `film/canvas/timeline.json`, plus what the desk's DSH
 * host page needs that Studio answers elsewhere:
 *
 * - `GET|PUT /api/canvas/timelines/:boardId` — the cut; a save names the
 *   revision it was built on and a stale one is answered 409 with the current state.
 * - `POST /api/canvas/timelines/:boardId/undo|redo` — step through the history.
 * - `POST /api/canvas/timelines/:boardId/commands` — a command plan (placements).
 * - `GET /api/canvas/timelines/:boardId/material` — the film's media as the
 *   editor's authorized assets, and the workspace's `media/` as files it may import.
 * - `GET /api/canvas/timelines/:boardId/renders` — exported cuts, newest first.
 * - `POST /api/canvas/timelines/:boardId/import` — copy a workspace media file into the film.
 *
 * Errors answer `{ error: <text>, code }` like Studio's canvas routes.
 * @module dsh-film/studio/timeline-routes
 */

import { copyFile, lstat, mkdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { listAssets, mediaTypeOf } from '../media.js'
import type { MediaKind } from '../media.js'
import { CANVAS_FILE_VERSION_PREFIX, TimelineCommandError, executeTimelineCommands, projectRawUrl } from '../timeline/commands.js'
import { TimelineConflictError, TimelineInvalidError, TimelineStore } from '../timeline/store.js'
import { projectOf } from './canvas-routes.js'
import type { ProjectEvents } from './events.js'
import { PROJECT_DIR, freeProjectPath, projectPath } from './project-routes.js'
import { StudioReply } from './router.js'
import type { StudioRequest, StudioRouter } from './router.js'

/** Media the editor can place: Studio's list for a board. */
const EDITOR_MEDIA = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'm4a', 'mp4', 'webm', 'mov'])
/** Where exported cuts are kept, relative to `film/`. */
export const RENDER_DIR = 'canvas/renders'
/** Where imported and generated material is kept, relative to `film/`. */
export const MATERIAL_DIR = 'canvas/media'
/** How many files the material listing reads. */
const MATERIAL_LIMIT = 2000

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

const editorMedia = (path: string): boolean => EDITOR_MEDIA.has(extname(path).slice(1).toLowerCase())

/**
 * The film's media as the editor's authorization list, and the workspace's
 * `media/` folder as files it may import. A file under `film/` that is not in
 * the list is a clip the editor drops on its next save, so all of them are in.
 * @param cwd - the workspace directory.
 * @param projectId - the film project's id.
 * @returns the assets and the importable files, newest first.
 */
export async function timelineMaterial(cwd: string, projectId: string): Promise<{ assets: AuthorizedAsset[]; projectFiles: WorkspaceMediaFile[] }> {
  const { assets: files } = await listAssets(cwd, MATERIAL_LIMIT)
  const assets: AuthorizedAsset[] = []
  const projectFiles: WorkspaceMediaFile[] = []
  for (const file of files) {
    if (!editorMedia(file.path)) continue
    const type = mediaTypeOf(file.path)
    if (type === undefined) continue
    if (file.path.startsWith(`${PROJECT_DIR}/`)) {
      const path = file.path.slice(PROJECT_DIR.length + 1)
      const identity = `${CANVAS_FILE_VERSION_PREFIX}${path}`
      assets.push({ assetId: identity, versionId: identity, kind: file.kind, name: basename(path), url: projectRawUrl(projectId, path), mimeType: type.type, sizeBytes: file.bytes })
    } else {
      const url = new URL('http://host/api/dsh-film/media')
      url.searchParams.set('path', join(cwd, ...file.path.split('/')))
      projectFiles.push({
        id: `workspace:${file.path}`,
        path: file.path,
        name: basename(file.path),
        kind: file.kind,
        url: url.pathname + url.search,
        mimeType: type.type,
        sizeBytes: file.bytes,
        mtime: Date.parse(file.modifiedAt),
      })
    }
  }
  return { assets, projectFiles }
}

const baseRevisionOf = (body: Record<string, unknown>): number | undefined => {
  const value = body.baseRevision
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new StudioReply(400, { error: 'baseRevision must be a non-negative integer', code: 'CANVAS_TIMELINE_INVALID' })
  }
  return value
}

/**
 * Add the timeline routes to a router.
 * @param router - the Studio-compatible router.
 * @param events - the project event bus; every saved cut is announced on it.
 */
export function addTimelineRoutes(router: StudioRouter, events: ProjectEvents): void {
  const storeOf = (request: StudioRequest): TimelineStore => new TimelineStore(request.cwd, (path) => {
    events.emit(request.cwd, { type: 'file-changed', projectId: projectOf(request), path })
  })
  /** Answer the store's own errors the way Studio does; anything else goes on. */
  const answering = async <T>(request: StudioRequest, store: TimelineStore, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof TimelineConflictError) throw new StudioReply(409, { error: error.message, code: error.code, current: await store.read() })
      if (error instanceof TimelineInvalidError) throw new StudioReply(400, { error: error.message, code: error.code })
      if (error instanceof TimelineCommandError) throw new StudioReply(422, { error: error.message, code: error.code, ...(error.operationId !== undefined ? { operationId: error.operationId } : {}) })
      throw error
    }
  }

  router.add('GET', '/api/canvas/timelines/:boardId', async request => storeOf(request).read())

  router.add('PUT', '/api/canvas/timelines/:boardId', async (request) => {
    const body = await request.json()
    if (body.document === undefined || typeof body.baseRevision !== 'number') {
      throw new StudioReply(400, { error: 'a timeline save needs a document and the baseRevision it was built on', code: 'CANVAS_TIMELINE_INVALID' })
    }
    const store = storeOf(request)
    return answering(request, store, () => store.save({ document: body.document, baseRevision: body.baseRevision as number }))
  })

  for (const direction of ['undo', 'redo'] as const) {
    router.add('POST', `/api/canvas/timelines/:boardId/${direction}`, async (request) => {
      const baseRevision = baseRevisionOf(await request.json())
      const store = storeOf(request)
      return answering(request, store, () => store[direction](baseRevision))
    })
  }

  router.add('POST', '/api/canvas/timelines/:boardId/commands', async (request) => {
    const body = await request.json()
    const plan = body.plan as { schemaVersion?: unknown; baseRevision?: unknown; operations?: unknown } | undefined
    if (
      typeof body.operationId !== 'string' || body.operationId.trim() === '' || body.operationId.length > 200
      || plan === undefined || plan === null || plan.schemaVersion !== 1 || typeof plan.baseRevision !== 'number'
      || !Array.isArray(plan.operations) || plan.operations.length === 0 || plan.operations.length > 64
    ) {
      throw new StudioReply(400, { error: 'a command request needs an operationId and a plan of 1–64 operations', code: 'CANVAS_TIMELINE_COMMAND_INVALID' })
    }
    const store = storeOf(request)
    const result = await answering(request, store, () => executeTimelineCommands({
      store,
      projectRoot: join(request.cwd, PROJECT_DIR),
      projectId: projectOf(request),
      boardId: request.params.boardId!,
      dryRun: body.dryRun === true,
      plan: plan as never,
    }))
    return { result }
  })

  router.add('GET', '/api/canvas/timelines/:boardId/material', async request => timelineMaterial(request.cwd, projectOf(request)))

  // The editor's library asks Studio's community catalogue first; there is
  // none under DSH, and an empty list leaves the panel to its other sources.
  router.add('GET', '/api/community/media', async () => ({ items: [] }))

  router.add('GET', '/api/canvas/timelines/:boardId/renders', async (request) => {
    const { assets } = await timelineMaterial(request.cwd, projectOf(request))
    const renders = assets
      .filter(asset => asset.versionId.startsWith(`${CANVAS_FILE_VERSION_PREFIX}${RENDER_DIR}/`))
      .map(asset => ({ path: asset.versionId.slice(CANVAS_FILE_VERSION_PREFIX.length), name: asset.name, kind: asset.kind, size: asset.sizeBytes ?? 0 }))
    return { renders }
  })

  router.add('POST', '/api/canvas/timelines/:boardId/import', async (request) => {
    const body = await request.json()
    const from = typeof body.path === 'string' ? body.path.replaceAll('\\', '/').replace(/^\.\//, '') : ''
    if (!from.startsWith('media/') || from.split('/').some(part => part === '..' || part === '') || !editorMedia(from)) {
      throw new StudioReply(400, { error: 'only media files under the workspace media/ folder can be imported', code: 'CANVAS_TIMELINE_IMPORT_INVALID' })
    }
    const source = join(request.cwd, ...from.split('/'))
    const info = await lstat(source).catch(() => undefined)
    if (info?.isFile() !== true) throw new StudioReply(404, { error: `no media file ${from}`, code: 'CANVAS_TIMELINE_IMPORT_NOT_FOUND' })
    const target = await freeProjectPath(request.cwd, `${MATERIAL_DIR}/${basename(from)}`)
    const absolute = projectPath(request.cwd, target)
    await mkdir(dirname(absolute), { recursive: true })
    await copyFile(source, absolute)
    events.emit(request.cwd, { type: 'file-changed', projectId: projectOf(request), path: target })
    return { file: { name: target, size: info.size, mime: mediaTypeOf(target)?.type ?? 'application/octet-stream' } }
  })
}
