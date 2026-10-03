/**
 * Studio's canvas endpoints over the workspace's board, with the answers of
 * Studio's `routes/canvas.ts` (and the merge route of `routes/screenwriter.ts`).
 * Canvas routes answer errors as `{ error: <text>, code }`.
 * @module dsh-film/studio/canvas-routes
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CanvasBoardAgent, BoardAgentError, parseBoardTarget, parseLease } from '../canvas/board-agent.js'
import { CanvasDocumentStore, CanvasDocumentUpdateError } from '../canvas/documents.js'
import type { CanvasDocument } from '../canvas/documents.js'
import { CanvasStoryMergeConflict, mergeStoryCanvas } from '../canvas/merge.js'
import { StudioApiError, StudioReply } from './router.js'
import type { StudioRequest, StudioRouter } from './router.js'
import type { ProjectEvents } from './events.js'
import { eventStream } from './sse.js'

/** The project id a request addresses the workspace by. */
export const projectOf = (request: StudioRequest): string =>
  request.query.get('project')?.trim() || request.params.projectId || 'film'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Add the canvas routes to a router.
 * @param router - the Studio-compatible router.
 * @param events - the project event bus (board changes are announced on it).
 * @param agent - the open canvas pages.
 */
export function addCanvasRoutes(router: StudioRouter, events: ProjectEvents, agent: CanvasBoardAgent = new CanvasBoardAgent()): void {
  const store = (request: StudioRequest) => new CanvasDocumentStore(request.cwd, projectOf(request))
  const boardError = (error: unknown): never => {
    if (error instanceof BoardAgentError) throw new StudioReply(error.status, { error: error.message, code: error.code })
    throw error
  }

  router.add('GET', '/api/canvas/documents', async (request) => {
    const documents = store(request)
    const [list, deleted] = await Promise.all([documents.list(), documents.tombstones()])
    return { documents: list, deleted }
  })
  router.add('GET', '/api/canvas/documents/:id', async (request) => {
    const document = await store(request).read(request.params.id!)
    if (document === null) throw new StudioReply(404, { error: `no canvas document ${request.params.id!}`, code: 'CANVAS_DOCUMENT_NOT_FOUND' })
    return document
  })
  router.add('PUT', '/api/canvas/documents/:id', async (request) => {
    const body = await request.json()
    if (!Array.isArray(body.nodes)) throw new StudioReply(400, { error: 'a canvas document must be a JSON object', code: 'CANVAS_DOCUMENT_INVALID' })
    const summary = await store(request).write(request.params.id!, { ...body, id: request.params.id! } as CanvasDocument)
    events.emit(request.cwd, { type: 'story-canvas-changed', projectId: projectOf(request), boardId: request.params.id! })
    return summary
  })
  router.add('DELETE', '/api/canvas/documents/:id', async (request) => {
    await store(request).remove(request.params.id!)
    return { ok: true }
  })
  router.add('POST', '/api/canvas/documents/:id/merge', async (request) => {
    const id = request.params.id!
    const { base, document } = await request.json()
    if (!isObject(document) || document.id !== id || (base !== null && (!isObject(base) || base.id !== id))) {
      throw new StudioApiError(400, 'BAD_REQUEST', 'A matching draft document and explicit base (or null) are required.', { code: 'STORY_BOARD_INVALID' })
    }
    try {
      const result = await store(request).update(current => mergeStoryCanvas(base as CanvasDocument | null, document as CanvasDocument, current))
      events.emit(request.cwd, { type: 'story-canvas-changed', projectId: projectOf(request), boardId: id })
      return result
    } catch (error) {
      if (error instanceof CanvasStoryMergeConflict) {
        throw new StudioReply(409, { error: error.message, code: 'CANVAS_MERGE_CONFLICT', paths: error.paths, current: error.current })
      }
      if (error instanceof CanvasDocumentUpdateError) throw new StudioApiError(409, 'CONFLICT', error.message, { code: error.code })
      if (error instanceof Error && /must (be an array|have unique stable IDs)|identity does not match/.test(error.message)) {
        throw new StudioApiError(400, 'BAD_REQUEST', error.message, { code: 'STORY_BOARD_INVALID' })
      }
      throw error
    }
  })

  // The pages' line to the agent: a lease on connect, then snapshots of their board.
  router.add('GET', '/api/canvas/agent/events', async (request) => {
    let target
    try {
      target = parseBoardTarget(Object.fromEntries(request.query))
    } catch (error) {
      return boardError(error)
    }
    return eventStream(request.raw, stream => agent.connect(target, stream))
  })
  router.add('POST', '/api/canvas/agent/state', async (request) => {
    try {
      const body = await request.json()
      const lease = parseLease(body)
      if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) <= 0) throw new BoardAgentError(400, 'CANVAS_BOARD_INVALID', 'A positive state sequence is required')
      if (!agent.setSnapshot(lease, body.snapshot ?? null, Number(body.sequence))) throw new StudioReply(409, { ok: false, code: 'CANVAS_BOARD_STALE_LEASE' })
      return { ok: true }
    } catch (error) {
      return boardError(error)
    }
  })
  router.add('POST', '/api/canvas/agent/result', async (request) => {
    try {
      const accepted = agent.resolve(parseLease(await request.json()))
      if (!accepted) throw new StudioReply(409, { ok: false, code: 'CANVAS_BOARD_RESULT_UNCONFIRMED' })
      return { ok: true }
    } catch (error) {
      return boardError(error)
    }
  })
  router.add('GET', '/api/canvas/agent', async (request) => {
    const projectId = request.query.get('projectId') ?? ''
    if (projectId === '') throw new StudioReply(400, { code: 'CANVAS_BOARD_PROJECT_REQUIRED', error: 'projectId is required' })
    const clients = agent.list(projectId)
    return { connected: clients.length > 0, clients }
  })

  // A batch groups the renders one click started; the canvas only needs its id back.
  router.add('POST', '/api/canvas/batches/register', async (request) => {
    const body = await request.json()
    if (typeof body.boardId !== 'string' || !Array.isArray(body.items)) throw new StudioReply(400, { error: 'boardId and items are required', code: 'CANVAS_BATCH_INVALID' })
    const id = randomUUID()
    const directory = join(request.cwd, 'film', 'canvas', 'batches')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${id}.json`), `${JSON.stringify({ id, boardId: body.boardId, items: body.items, createdAt: new Date().toISOString() }, null, 2)}\n`)
    return { id }
  })

  // Text models for text nodes and prompt help: connected to the gateway in a later step.
  router.add('GET', '/api/canvas/models', async () => ({ models: [], complete: true, warnings: [] }))
}
