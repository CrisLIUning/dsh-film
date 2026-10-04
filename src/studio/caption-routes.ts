/**
 * Studio's original-audio caption endpoints (`routes/timeline-captions.ts`)
 * over the film's cut, plus the engine listing the desk's engine choice reads:
 *
 * - `POST /api/canvas/timelines/:boardId/transcribe` — 202 with the task;
 *   `{ baseRevision, requestId, clipIds?, range?, language?, engine?, spendingConfirmed? }`.
 * - `POST /api/canvas/timelines/:boardId/captions/apply` — `{ taskId, reviewed, dryRun, excludeSegmentIds? }`
 *   → `{ result }`, the command's result without the two whole cuts.
 * - `GET  /api/canvas/timelines/:boardId/captions/tasks` — the latest 20 recognitions.
 * - `GET  /api/canvas/timelines/:boardId/captions/engines` — whisper and gateway, and the default.
 *
 * The board is the project here: `?project=` naming another is refused with
 * 409 `CAPTION_CONTEXT_MISMATCH`. Errors answer `{ error, code, ...extra }`.
 * Drafts are read and recognitions cancelled through the media task routes.
 * @module dsh-film/studio/caption-routes
 */

import { TimelineCaptionError, parseTranscribeRequest } from '../captions/plan.js'
import type { CaptionService } from '../captions/service.js'
import { EditorModelError } from '../models/service.js'
import { TimelineCommandError } from '../timeline/commands.js'
import { TimelineConflictError, TimelineInvalidError } from '../timeline/store.js'
import { StudioReply } from './router.js'
import type { StudioRequest, StudioRouter } from './router.js'

/**
 * Add the caption routes to a router.
 * @param router - the Studio-compatible router.
 * @param captions - the caption service.
 */
export function addCaptionRoutes(router: StudioRouter, captions: CaptionService): void {
  /** The project a request works on: its board, which `?project=` may only repeat. */
  const projectFor = (request: StudioRequest): string => {
    const board = request.params.boardId!
    const project = request.query.get('project')
    if (project !== null && project.trim() !== '' && project.trim() !== board) {
      throw new StudioReply(409, { error: 'board and project must identify the same current timeline', code: 'CAPTION_CONTEXT_MISMATCH' })
    }
    return board
  }
  const answering = async <T>(request: StudioRequest, projectId: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof TimelineCaptionError) throw new StudioReply(error.status, { ...error.extra, error: error.message, code: error.code })
      if (error instanceof TimelineConflictError) throw new StudioReply(409, { error: error.message, code: error.code, current: await captions.timeline(request.cwd, projectId).read() })
      if (error instanceof TimelineInvalidError) throw new StudioReply(400, { error: error.message, code: error.code })
      if (error instanceof TimelineCommandError) throw new StudioReply(422, { error: error.message, code: error.code, ...(error.operationId !== undefined ? { operationId: error.operationId } : {}) })
      if (error instanceof EditorModelError) throw new StudioReply(error.status, { error: error.message, code: error.code })
      throw error
    }
  }

  router.add('POST', '/api/canvas/timelines/:boardId/transcribe', async (request) => {
    const projectId = projectFor(request)
    const body = await request.json()
    const started = await answering(request, projectId, async () => captions.start(request.cwd, projectId, parseTranscribeRequest(body)))
    return new Response(JSON.stringify(started), { status: 202, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
  })

  router.add('POST', '/api/canvas/timelines/:boardId/captions/apply', async (request) => {
    const projectId = projectFor(request)
    const body = await request.json()
    if (
      typeof body.taskId !== 'string' || body.taskId.length > 200 || typeof body.reviewed !== 'boolean' || typeof body.dryRun !== 'boolean'
      || (body.excludeSegmentIds !== undefined && (!Array.isArray(body.excludeSegmentIds) || body.excludeSegmentIds.length > 10_000 || body.excludeSegmentIds.some(id => typeof id !== 'string')))
    ) {
      throw new StudioReply(400, { error: 'taskId, reviewed and dryRun are required', code: 'CAPTION_REQUEST_INVALID' })
    }
    const result = await answering(request, projectId, () => captions.apply(request.cwd, projectId, {
      taskId: body.taskId as string,
      reviewed: body.reviewed as boolean,
      dryRun: body.dryRun as boolean,
      ...(body.excludeSegmentIds !== undefined ? { excludeSegmentIds: body.excludeSegmentIds as string[] } : {}),
    }))
    // The diff is `changes`; the two whole cuts would only weigh down every answer.
    const { before: _before, after: _after, ...kept } = result
    return { result: kept }
  })

  router.add('GET', '/api/canvas/timelines/:boardId/captions/tasks', async (request) => {
    const projectId = projectFor(request)
    return answering(request, projectId, () => captions.list(request.cwd, projectId))
  })

  router.add('GET', '/api/canvas/timelines/:boardId/captions/engines', async (request) => {
    projectFor(request)
    return captions.engines(request.raw.signal)
  })
}
