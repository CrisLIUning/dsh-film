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
 * - `POST /api/canvas/timelines/:boardId/import` — copy a workspace media file into the film.
 * - `GET /api/canvas/timelines/:boardId/media` — the board's media nodes;
 *   `POST .../media` lands a film file on the board (an exported cut);
 *   `POST .../place` puts a board node (or a film file) on the cut.
 * - `GET /api/canvas/timelines/:boardId/scripts` — scripts the desk can put on
 *   the cut: the 剧本 tab's screenplays with dialogue, and the board's text nodes.
 * - `POST /api/canvas/timelines/:boardId/sound` — lines, effects and music on
 *   the cut's shots; a script becomes one caption per line.
 *
 * Rendering the cut and listing the renders are in `render-routes.ts`.
 * Errors answer `{ error: <text>, code }` like Studio's canvas routes.
 * @module dsh-film/studio/timeline-routes
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { BoardAttachError, attachFileToNode, landFileOnBoard, listBoardMedia, mediaKindOfPath } from '../canvas/board-media.js'
import { CanvasDocumentStore, CanvasDocumentUpdateError } from '../canvas/documents.js'
import { listAssets, mediaTypeOf } from '../media.js'
import type { MediaKind } from '../media.js'
import { probeMedia } from '../media/probe.js'
import { TimelinePlaceError, placeBoardMediaOnTimeline } from '../timeline/place.js'
import { TimelineSoundError, listScriptNodes, listStoryScripts, placeSoundOnTimeline, readStories, storyScriptLines } from '../timeline/sound.js'
import type { ScriptLine } from '../timeline/sound.js'
import { TimelineVersionError, candidatesFor, findSlot, listSlots, publicSlot, swapSlotVersion } from '../timeline/versions.js'
import type { Slot, Take } from '../timeline/versions.js'
import { CANVAS_FILE_VERSION_PREFIX, TimelineCommandError, executeTimelineCommands, projectRawUrl } from '../timeline/commands.js'
import { TimelineConflictError, TimelineInvalidError, TimelineStore } from '../timeline/store.js'
import { projectOf } from './canvas-routes.js'
import type { ProjectEvents } from './events.js'
import { PROJECT_DIR, freeProjectPath, projectPath } from './project-routes.js'
import { StudioReply } from './router.js'
import type { StudioRequest, StudioRouter } from './router.js'

/** Media the editor can place: Studio's list for a board. */
const EDITOR_MEDIA = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'm4a', 'mp4', 'webm', 'mov'])
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

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => { resolve(hash.digest('hex')) })
  })
}

/**
 * An earlier import of the same bytes: the names `freeProjectPath` hands out
 * for `path` (x.png, x-2.png, ...) up to the first free one, the first whose
 * size and digest match the source.
 * @param cwd - the workspace.
 * @param path - the import's film-relative name.
 * @param source - the file being imported.
 * @param size - its size.
 * @returns the earlier copy's film-relative name, if there is one.
 */
async function identicalCopy(cwd: string, path: string, source: string, size: number): Promise<string | undefined> {
  const match = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(path)
  const stem = match?.[1] ?? path
  const extension = match?.[2] ?? ''
  let sourceDigest: string | undefined
  for (let index = 1; index < 10_000; index++) {
    const candidate = index === 1 ? path : `${stem}-${index}${extension}`
    const info = await lstat(projectPath(cwd, candidate)).catch(() => undefined)
    if (info === undefined) return undefined
    if (!info.isFile() || info.size !== size) continue
    sourceDigest ??= await sha256File(source)
    if (await sha256File(projectPath(cwd, candidate)).catch(() => undefined) === sourceDigest) return candidate
  }
  return undefined
}

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
      if (error instanceof TimelinePlaceError || error instanceof TimelineVersionError || error instanceof TimelineSoundError || error instanceof BoardAttachError) throw new StudioReply(error.status, { error: error.message, code: error.code })
      if (error instanceof CanvasDocumentUpdateError) throw new StudioReply(409, { error: error.message, code: error.code })
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

  const boardOf = (request: StudioRequest): CanvasDocumentStore => new CanvasDocumentStore(request.cwd, projectOf(request))

  router.add('GET', '/api/canvas/timelines/:boardId/media', async (request) => {
    const board = await boardOf(request).read(request.params.boardId!)
    if (board === null) throw new StudioReply(404, { error: `no such board: ${request.params.boardId!}`, code: 'CANVAS_DOCUMENT_NOT_FOUND' })
    return { media: listBoardMedia(board) }
  })

  router.add('POST', '/api/canvas/timelines/:boardId/place', async (request) => {
    const body = await request.json()
    const baseRevision = baseRevisionOf(body)
    const dryRun = body.dryRun === true
    // Applying to whatever is current would write over a cut nobody reviewed.
    if (!dryRun && baseRevision === undefined) throw new StudioReply(400, { error: 'an apply needs the baseRevision you reviewed; a dry run does not', code: 'CANVAS_TIMELINE_PLACE_INVALID' })
    const store = storeOf(request)
    const board = await boardOf(request).read(request.params.boardId!)
    return answering(request, store, () => placeBoardMediaOnTimeline({
      store,
      projectRoot: join(request.cwd, PROJECT_DIR),
      projectId: projectOf(request),
      boardId: request.params.boardId!,
      board,
      request: body,
      ...(baseRevision !== undefined ? { baseRevision } : {}),
      dryRun,
      operationId: typeof body.operationId === 'string' && body.operationId.trim() !== '' ? body.operationId.trim().slice(0, 200) : `place-${Date.now().toString(36)}`,
      probeDuration: async path => (await probeMedia(path)).durationSeconds,
    }))
  })

  router.add('GET', '/api/canvas/timelines/:boardId/scripts', async (request) => {
    const board = await boardOf(request).read(request.params.boardId!)
    return { scripts: [...listStoryScripts(await readStories(request.cwd)), ...(board === null ? [] : listScriptNodes(board))] }
  })

  router.add('POST', '/api/canvas/timelines/:boardId/sound', async (request) => {
    const body = await request.json()
    const baseRevision = baseRevisionOf(body)
    const dryRun = body.dryRun === true
    if (!dryRun && baseRevision === undefined) throw new StudioReply(400, { error: 'an apply needs the baseRevision you reviewed; a dry run does not', code: 'CANVAS_TIMELINE_SOUND_INVALID' })
    const store = storeOf(request)
    const board = await boardOf(request).read(request.params.boardId!)
    const script = body.script !== null && typeof body.script === 'object' ? body.script as Record<string, unknown> : undefined
    let storyLines: ScriptLine[] | undefined
    if (typeof script?.storyDocumentId === 'string') {
      const story = (await readStories(request.cwd)).find(item => item.documentId === script.storyDocumentId)
      if (story !== undefined) storyLines = storyScriptLines(story)
    }
    return answering(request, store, () => placeSoundOnTimeline({
      store,
      projectRoot: join(request.cwd, PROJECT_DIR),
      projectId: projectOf(request),
      boardId: request.params.boardId!,
      boardDocument: board,
      request: body,
      ...(storyLines !== undefined ? { storyLines } : {}),
      ...(baseRevision !== undefined ? { baseRevision } : {}),
      dryRun,
      operationId: typeof body.operationId === 'string' && body.operationId.trim() !== '' ? body.operationId.trim().slice(0, 200) : `sound-${Date.now().toString(36)}`,
      probeDuration: async path => (await probeMedia(path)).durationSeconds,
    }))
  })

  router.add('POST', '/api/canvas/timelines/:boardId/media', async (request) => {
    const body = await request.json()
    if (body.targetNodeId !== undefined && (typeof body.targetNodeId !== 'string' || body.targetNodeId === '' || typeof body.expectedContent !== 'string')) {
      throw new StudioReply(400, { error: 'targetNodeId requires expectedContent from the reviewed node (empty string for an empty node)', code: 'CANVAS_MEDIA_TARGET_INVALID' })
    }
    const path = typeof body.path === 'string' ? body.path.trim().replaceAll('\\', '/').replace(/^\.\//, '') : ''
    if (path === '' || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '')) {
      throw new StudioReply(400, { error: 'path must be a project-relative file inside the project', code: 'CANVAS_TIMELINE_PLACE_INVALID' })
    }
    const kind = mediaKindOfPath(path)
    if (kind === null) throw new StudioReply(400, { error: `the board cannot show "${path}" — it holds video, images and audio`, code: 'CANVAS_TIMELINE_PLACE_INVALID' })
    const absolute = projectPath(request.cwd, path)
    const info = await stat(absolute).catch(() => undefined)
    if (info?.isFile() !== true) throw new StudioReply(422, { error: `${path} is not a file in this project`, code: 'CANVAS_TIMELINE_PLACE_FILE_NOT_FOUND' })
    // What the caller measured wins: the editor has just made the file.
    const given = (key: string): number | undefined => typeof body[key] === 'number' && Number.isFinite(body[key]) && (body[key] as number) > 0 ? body[key] as number : undefined
    const probed = kind === 'image' ? {} : await probeMedia(absolute)
    const width = given('width') ?? probed.width
    const height = given('height') ?? probed.height
    const durationSeconds = given('durationSeconds') ?? probed.durationSeconds
    const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim().slice(0, 120) : path.split('/').pop() ?? path
    const file = {
      path,
      kind,
      mimeType: mediaTypeOf(path)?.type ?? 'application/octet-stream',
      title,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      size: info.size,
    }
    const targetNodeId = typeof body.targetNodeId === 'string' ? body.targetNodeId : undefined
    const landedNodeId = await answering(request, storeOf(request), async () => targetNodeId === undefined
      ? landFileOnBoard(boardOf(request), request.params.boardId!, projectOf(request), file)
      : attachFileToNode(boardOf(request), request.params.boardId!, projectOf(request), {
        ...file, targetNodeId, expectedContent: body.expectedContent as string, sha256: await sha256File(absolute),
      }))
    if (landedNodeId !== null) events.emit(request.cwd, { type: 'story-canvas-changed', projectId: projectOf(request), boardId: request.params.boardId! })
    return {
      landed: {
        nodeId: landedNodeId ?? '',
        landedNodeId,
        title,
        path,
        kind,
        size: info.size,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      },
    }
  })

  // The cut's slots, and one slot's takes when a clip is named.
  router.add('GET', '/api/canvas/timelines/:boardId/versions', async (request) => {
    const store = storeOf(request)
    return answering(request, store, async () => {
      const cut = await store.read()
      const asked = request.query.get('clipId')?.trim() ?? ''
      const body: { slots: Slot[]; versions: Take[]; slot?: Slot } = { slots: listSlots(cut.document).map(publicSlot), versions: [] }
      if (asked !== '') {
        const slot = findSlot(cut.document, asked)
        body.slot = publicSlot(slot)
        body.versions = candidatesFor(slot, await boardOf(request).read(request.params.boardId!))
      }
      return body
    })
  })

  router.add('POST', '/api/canvas/timelines/:boardId/version', async (request) => {
    const body = await request.json()
    const baseRevision = baseRevisionOf(body)
    const dryRun = body.dryRun === true
    if (!dryRun && baseRevision === undefined) throw new StudioReply(400, { error: 'an apply needs the baseRevision you reviewed; a dry run does not', code: 'CANVAS_TIMELINE_VERSION_INVALID' })
    const store = storeOf(request)
    const board = await boardOf(request).read(request.params.boardId!)
    return answering(request, store, () => swapSlotVersion({
      store,
      projectRoot: join(request.cwd, PROJECT_DIR),
      projectId: projectOf(request),
      boardId: request.params.boardId!,
      board,
      request: body,
      ...(baseRevision !== undefined ? { baseRevision } : {}),
      dryRun,
      operationId: typeof body.operationId === 'string' && body.operationId.trim() !== '' ? body.operationId.trim().slice(0, 200) : `version-${Date.now().toString(36)}`,
      probeDuration: async path => (await probeMedia(path)).durationSeconds,
    }))
  })

  // The editor's library asks Studio's community catalogue first; there is
  // none under DSH, and an empty list leaves the panel to its other sources.
  router.add('GET', '/api/community/media', async () => ({ items: [] }))

  router.add('POST', '/api/canvas/timelines/:boardId/import', async (request) => {
    const body = await request.json()
    const from = typeof body.path === 'string' ? body.path.replaceAll('\\', '/').replace(/^\.\//, '') : ''
    if (!from.startsWith('media/') || from.split('/').some(part => part === '..' || part === '') || !editorMedia(from)) {
      throw new StudioReply(400, { error: 'only media files under the workspace media/ folder can be imported', code: 'CANVAS_TIMELINE_IMPORT_INVALID' })
    }
    const source = join(request.cwd, ...from.split('/'))
    const info = await lstat(source).catch(() => undefined)
    if (info?.isFile() !== true) throw new StudioReply(404, { error: `no media file ${from}`, code: 'CANVAS_TIMELINE_IMPORT_NOT_FOUND' })
    // Importing the same bytes again answers the earlier copy, so a retried bind or attach does not pile up x-2, x-3, ...
    const earlier = await identicalCopy(request.cwd, `${MATERIAL_DIR}/${basename(from)}`, source, info.size)
    if (earlier !== undefined) return { file: { name: earlier, size: info.size, mime: mediaTypeOf(earlier)?.type ?? 'application/octet-stream' }, reused: true }
    const target = await freeProjectPath(request.cwd, `${MATERIAL_DIR}/${basename(from)}`)
    const absolute = projectPath(request.cwd, target)
    await mkdir(dirname(absolute), { recursive: true })
    await copyFile(source, absolute)
    events.emit(request.cwd, { type: 'file-changed', projectId: projectOf(request), path: target })
    return { file: { name: target, size: info.size, mime: mediaTypeOf(target)?.type ?? 'application/octet-stream' } }
  })
}
