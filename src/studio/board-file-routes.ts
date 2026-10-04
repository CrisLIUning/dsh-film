/**
 * The board's file endpoints that are not the editing desk's:
 *
 * - `POST /api/canvas/assets/:boardId/import` — `{ path }`: copy a workspace
 *   media file into `film/canvas/media/`, or a GLB, FBX or OBJ model into
 *   `film/canvas/models/` (see src/canvas/workspace-import.ts). Answers
 *   `{ file: { name, size, mime }, kind, reused?, model? }`; a model carries
 *   its facts. A film workspace only, outside hidden and credential folders.
 * - `POST /api/canvas/timelines/:boardId/import` — the same handler under its
 *   0.1 path, which the canvas and the agent called; kept through 0.2.x and
 *   removed in 0.3.0.
 *
 * Errors answer `{ error: <text>, code }` like Studio's canvas routes.
 * @module dsh-film/studio/board-file-routes
 */

import { join } from 'node:path'
import { WorkspaceMediaError } from '../media.js'
import { importWorkspaceFile } from '../canvas/workspace-import.js'
import { modelFacts } from '../model-files/facts.js'
import { FILM_DIR, requireFilmWorkspace } from '../project.js'
import { projectOf } from './canvas-routes.js'
import type { ProjectEvents } from './events.js'
import { StudioReply } from './router.js'
import type { StudioRequest, StudioRouter } from './router.js'

/** The import's path; the legacy one goes in 0.3.0. */
export const BOARD_IMPORT_PATH = '/api/canvas/assets/:boardId/import'
export const LEGACY_BOARD_IMPORT_PATH = '/api/canvas/timelines/:boardId/import'

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
  router.add('POST', LEGACY_BOARD_IMPORT_PATH, importFile)
}
