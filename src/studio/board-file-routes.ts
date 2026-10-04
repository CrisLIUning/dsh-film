/**
 * The board's file endpoints:
 *
 * - `POST /api/canvas/assets/:boardId/import` — `{ path }`: copy a workspace
 *   media file into `film/canvas/media/`, or a GLB, FBX or OBJ model into
 *   `film/canvas/models/` (see src/canvas/workspace-import.ts). Answers
 *   `{ file: { name, size, mime }, kind, reused?, model? }`; a model carries
 *   its facts. A film workspace only, outside hidden and credential folders.
 *   (0.1 served it as `POST /api/canvas/timelines/:boardId/import`; that path
 *   was kept through 0.2.x and is gone since 0.3.0.)
 * - `POST /api/canvas/assets/:boardId/attach` — `{ path, targetNodeId?,
 *   expectedContent?, width?, height?, durationSeconds?, title? }`: put a film
 *   file (`path` relative to `film/`) into an existing node, or land it on the
 *   board as a new one. Answers `{ landed }`; the agent's canvas_attach_media
 *   calls it. (0.1 served it as `POST /api/canvas/timelines/:boardId/media`.)
 *
 * Errors answer `{ error: <text>, code }` like Studio's canvas routes.
 * @module dsh-film/studio/board-file-routes
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BoardAttachError, attachFileToNode, landFileOnBoard, mediaKindOfPath } from '../canvas/board-media.js'
import { CanvasDocumentStore, CanvasDocumentUpdateError } from '../canvas/documents.js'
import { WorkspaceMediaError, mediaTypeOf } from '../media.js'
import { probeMedia } from '../media/probe.js'
import { importWorkspaceFile, sha256File } from '../canvas/workspace-import.js'
import { modelFacts } from '../model-files/facts.js'
import { FILM_DIR, requireFilmWorkspace } from '../project.js'
import { projectOf } from './canvas-routes.js'
import type { ProjectEvents } from './events.js'
import { projectPath } from './project-routes.js'
import { StudioReply } from './router.js'
import type { StudioRequest, StudioRouter } from './router.js'

/** The import's path. */
export const BOARD_IMPORT_PATH = '/api/canvas/assets/:boardId/import'
/** The agent's attach. */
export const BOARD_ATTACH_PATH = '/api/canvas/assets/:boardId/attach'

/**
 * Add the board file routes to a router.
 * @param router - the Studio-compatible router.
 * @param events - the project event bus; a file the import created is announced on it.
 */
export function addBoardFileRoutes(router: StudioRouter, events: ProjectEvents): void {
  const importFile = async (request: StudioRequest): Promise<unknown> => {
    // It reads outside film/: only a film workspace, outside hidden and credential folders, is read from.
    await requireFilmWorkspace(request.cwd)
    const body = await request.json()
    let imported
    try {
      imported = await importWorkspaceFile(request.cwd, typeof body.path === 'string' ? body.path : '')
    } catch (error) {
      if (!(error instanceof WorkspaceMediaError)) throw error
      if (error.problem === 'not-found') throw new StudioReply(404, { error: error.message, code: 'CANVAS_IMPORT_NOT_FOUND' })
      throw new StudioReply(400, { error: `${error.message} Only the workspace's own image, video, audio and model (GLB, FBX, OBJ) files can be imported.`, code: 'CANVAS_IMPORT_INVALID' })
    }
    if (imported.created) events.emit(request.cwd, { type: 'file-changed', projectId: projectOf(request), path: imported.file.name })
    const model = imported.kind === 'model'
      ? await modelFacts(join(request.cwd, FILM_DIR, ...imported.file.name.split('/')), `${FILM_DIR}/${imported.file.name}`).catch(() => undefined)
      : undefined
    return {
      file: imported.file,
      kind: imported.kind,
      ...(imported.reused === true ? { reused: true } : {}),
      ...(model !== undefined ? { model } : {}),
    }
  }
  router.add('POST', BOARD_IMPORT_PATH, importFile)
  router.add('POST', BOARD_ATTACH_PATH, request => attachFile(request, events))
}

/**
 * Put a film file into a board node, or land it on the board as a new node.
 * @param request - the request.
 * @param events - the project event bus; a changed board is announced on it.
 * @returns `{ landed }`.
 */
async function attachFile(request: StudioRequest, events: ProjectEvents): Promise<unknown> {
  const body = await request.json()
  if (body.targetNodeId !== undefined && (typeof body.targetNodeId !== 'string' || body.targetNodeId === '' || typeof body.expectedContent !== 'string')) {
    throw new StudioReply(400, { error: 'targetNodeId requires expectedContent from the reviewed node (empty string for an empty node)', code: 'CANVAS_MEDIA_TARGET_INVALID' })
  }
  const path = typeof body.path === 'string' ? body.path.trim().replaceAll('\\', '/').replace(/^\.\//, '') : ''
  if (path === '' || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '')) {
    throw new StudioReply(400, { error: 'path must be a project-relative file inside the project', code: 'CANVAS_MEDIA_ATTACH_INVALID' })
  }
  const kind = mediaKindOfPath(path)
  if (kind === null) throw new StudioReply(400, { error: `the board cannot show "${path}" — it holds video, images and audio`, code: 'CANVAS_MEDIA_ATTACH_INVALID' })
  const absolute = projectPath(request.cwd, path)
  const info = await stat(absolute).catch(() => undefined)
  if (info?.isFile() !== true) throw new StudioReply(422, { error: `${path} is not a file in this project`, code: 'CANVAS_MEDIA_FILE_NOT_FOUND' })
  // What the caller measured wins over the probe.
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
  const projectId = projectOf(request)
  const boardId = request.params.boardId!
  const board = new CanvasDocumentStore(request.cwd, projectId)
  const targetNodeId = typeof body.targetNodeId === 'string' ? body.targetNodeId : undefined
  let landedNodeId: string | null
  try {
    landedNodeId = targetNodeId === undefined
      ? await landFileOnBoard(board, boardId, projectId, file)
      : await attachFileToNode(board, boardId, projectId, {
        ...file, targetNodeId, expectedContent: body.expectedContent as string, sha256: await sha256File(absolute),
      })
  } catch (error) {
    if (error instanceof BoardAttachError) throw new StudioReply(error.status, { error: error.message, code: error.code })
    if (error instanceof CanvasDocumentUpdateError) throw new StudioReply(409, { error: error.message, code: error.code })
    throw error
  }
  if (landedNodeId !== null) events.emit(request.cwd, { type: 'story-canvas-changed', projectId, boardId })
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
}
