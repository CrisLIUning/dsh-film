/**
 * Studio's screenplay-to-production endpoints (apps/daemon/src/routes/
 * screenwriter.ts and screenwriter-director.ts) over the film:
 *
 * - `GET  /api/projects/:projectId/story/documents/:documentId/source/:objectId[?sceneId=]` — a source preview.
 * - `POST .../documents/:documentId/handoff` — a source card (and a production node) on the film's board.
 * - `POST .../documents/:documentId/adopt` — explicit adoption into one production node.
 * - `GET  .../documents/:documentId/impact` — what the saved screenplay's changes touch.
 * - `GET  /api/projects/:projectId/story/directors[?boardId=]` — director nodes and their saved cameras.
 * - `POST .../documents/:documentId/director-links` — link or unlink a source with a director shot.
 *
 * The board is written host-side, so these work with the 分镜 tab closed;
 * every board write is announced (`story-canvas-changed`) so an open page
 * merges it, and handoff, adoption and a changed link also announce
 * `story-changed` as Studio does.
 * @module dsh-film/studio/story-production-routes
 */

import { BoardAgentError } from '../canvas/board-agent.js'
import type { CanvasBoardAgent } from '../canvas/board-agent.js'
import { CanvasDocumentUpdateError } from '../canvas/documents.js'
import type { StoryAdoptRequest, StoryHandoffRequest } from '../screenwriter/contracts/index.js'
import { StoryDirectorLinksService } from '../screenwriter/director-links.js'
import type { ReadLiveDirector, StoryDirectorLinkRequest } from '../screenwriter/director-links.js'
import { StoryHandoff } from '../screenwriter/handoff.js'
import { StoryImpact } from '../screenwriter/impact.js'
import { StoryError } from '../screenwriter/service.js'
import type { ProjectEvents } from './events.js'
import { StudioApiError } from './router.js'
import type { StudioRouter } from './router.js'
import { filmBoardOf } from './screenwriter-routes.js'
import type { ScreenwriterServices } from './screenwriter-routes.js'

/** The open page's call that reports a director desk's live scene (Studio's DIRECTOR_READ_SCENE_TOOL). */
export const DIRECTOR_READ_SCENE_TOOL = 'director_read_scene'

export interface StoryProductionDeps {
  /** The screenplay services the screenwriter routes use. */
  story: ScreenwriterServices
  /** The project event bus. */
  events: ProjectEvents
  /** The open canvas pages, asked about live director desks. */
  boardAgent: CanvasBoardAgent
}

const DOCUMENT = '/api/projects/:projectId/story/documents/:documentId'

/**
 * Ask the page showing the film's board whether a director node's desk holds
 * a scene, as Studio's screenwriter routes do. No page: the desk is closed.
 * @param agent - the open canvas pages.
 * @returns the reader.
 */
export function liveDirectorReader(agent: CanvasBoardAgent): ReadLiveDirector {
  return async (boardId, nodeId, projectId) => {
    let page
    try {
      page = agent.choose({ projectId, boardId })
    } catch (error) {
      // A page still loading may hold a newer scene than the saved one.
      if (error instanceof BoardAgentError) throw new StoryError(409, 'STORY_DIRECTOR_STATE_UNKNOWN', 'The connected director desk did not respond. Reopen the target board before linking.')
      throw error
    }
    if (page === undefined) return { deskOpen: false }
    let answer: unknown
    try {
      answer = await agent.call(page.target, DIRECTOR_READ_SCENE_TOOL, { project: projectId, boardId, nodeId })
    } catch {
      throw new StoryError(409, 'STORY_DIRECTOR_STATE_UNKNOWN', 'The connected director desk did not respond. Reopen the target board before linking.')
    }
    if (!answer || typeof answer !== 'object' || !('deskOpen' in answer) || typeof answer.deskOpen !== 'boolean') {
      throw new StoryError(409, 'STORY_DIRECTOR_STATE_UNKNOWN', 'The open director desk did not confirm its saved state. Reopen the target board before linking.')
    }
    return { deskOpen: answer.deskOpen, ...('scene' in answer ? { scene: answer.scene } : {}) }
  }
}

/** The board store's refusals in Studio's shape (409 CONFLICT with the board code). */
async function boardWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (error instanceof CanvasDocumentUpdateError) throw new StudioApiError(409, 'CONFLICT', error.message, { code: error.code })
    throw error
  }
}

/**
 * Add the screenplay-to-production routes to a router.
 * @param router - the Studio-compatible router.
 * @param deps - the screenplay services, the event bus and the open pages.
 */
export function addStoryProductionRoutes(router: StudioRouter, deps: StoryProductionDeps): void {
  const { stories, assets, onChange } = deps.story
  const handoff = new StoryHandoff(stories, assets, (cwd, path, projectId) => {
    deps.events.emit(cwd, { type: 'file-changed', projectId, path })
  })
  const impact = new StoryImpact(stories, handoff)
  const directorLinks = new StoryDirectorLinksService(stories, handoff, liveDirectorReader(deps.boardAgent))
  const boardChanged = (cwd: string, boardId: string): void => {
    deps.events.emit(cwd, { type: 'story-canvas-changed', projectId: boardId, boardId })
  }

  router.add('GET', `${DOCUMENT}/source/:objectId`, async (request) => {
    const sceneId = request.query.get('sceneId')
    return handoff.preview(request.cwd, request.params.documentId!, request.params.objectId!, sceneId !== null ? { kind: 'scene', sceneId } : undefined)
  })
  router.add('POST', `${DOCUMENT}/handoff`, async (request) => {
    const documentId = request.params.documentId!
    const result = await boardWrite(async () => handoff.send(request.cwd, documentId, await request.json() as unknown as StoryHandoffRequest))
    boardChanged(request.cwd, result.boardId)
    onChange(request.cwd, documentId, result.preview.revision)
    return result
  })
  router.add('POST', `${DOCUMENT}/adopt`, async (request) => {
    const documentId = request.params.documentId!
    const body = await request.json() as unknown as StoryAdoptRequest
    const result = await boardWrite(() => handoff.adopt(request.cwd, documentId, body))
    boardChanged(request.cwd, body.boardId)
    onChange(request.cwd, documentId, result.preview.revision)
    return result
  })
  router.add('GET', `${DOCUMENT}/impact`, request => impact.read(request.cwd, request.params.documentId!))
  router.add('GET', '/api/projects/:projectId/story/directors', async (request) => {
    return directorLinks.list(request.cwd, request.query.get('boardId') ?? await filmBoardOf(request))
  })
  router.add('POST', `${DOCUMENT}/director-links`, async (request) => {
    const documentId = request.params.documentId!
    const body = await request.json() as unknown as StoryDirectorLinkRequest
    const result = await boardWrite(() => directorLinks.mutate(request.cwd, documentId, body))
    if (result.changed) {
      boardChanged(request.cwd, body.boardId)
      onChange(request.cwd, documentId, result.revision)
    }
    return result
  })
}
