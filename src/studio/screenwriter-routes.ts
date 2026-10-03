/**
 * Studio's screenwriter endpoints over the workspace's screenplays, with the
 * request and answer shapes of Studio's `routes/screenwriter.ts`.
 * @module dsh-film/studio/screenwriter-routes
 */

import { StoryOperationError } from '../screenwriter/contracts/index.js'
import type { StoryApplyRequest, StoryObjectTarget, StoryQueryRequest, StoryWriteRequest } from '../screenwriter/contracts/index.js'
import { queryStoryDocument } from '../screenwriter/query.js'
import { StoryError, StoryService } from '../screenwriter/service.js'
import { StudioApiError, studioError } from './router.js'
import type { StudioRouter } from './router.js'

const DOCUMENTS = '/api/projects/:projectId/story/documents'
const DOCUMENT = `${DOCUMENTS}/:documentId`

const OBJECT_KINDS = new Set(['entity', 'scene', 'shot'])

/**
 * Answer the screenwriter's own error types in Studio's shapes.
 * @param error - what a handler threw.
 * @returns the response, or `undefined` for other errors.
 */
export function translateStoryError(error: unknown): Response | undefined {
  if (error instanceof StoryOperationError) {
    return studioError(422, 'VALIDATION_FAILED', error.message, { code: 'STORY_INVALID_OPERATIONS', diagnostics: error.diagnostics })
  }
  if (error instanceof StoryError) {
    const generic = error.status === 409 ? 'CONFLICT' : error.status === 404 ? 'NOT_FOUND' : error.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST'
    return studioError(error.status, generic, error.message, { code: error.code, ...(error.current ? { current: error.current } : {}) })
  }
  return undefined
}

/**
 * Add the screenwriter routes to a router.
 * @param router - the Studio-compatible router.
 * @param service - the screenplay store.
 * @param onChange - told about every committed change (for live views).
 */
export function addScreenwriterRoutes(
  router: StudioRouter,
  service: StoryService,
  onChange: (cwd: string, documentId: string, revision: string) => void = () => {},
): void {
  const changed = <T extends { changed?: boolean; document?: { documentId: string; revision: string } }>(cwd: string, result: T): T => {
    if (result.changed === true && result.document !== undefined) onChange(cwd, result.document.documentId, result.document.revision)
    return result
  }
  router.translate(translateStoryError)
  router.add('GET', DOCUMENTS, ({ cwd }) => service.list(cwd))
  router.add('POST', DOCUMENTS, async ({ cwd, json }) => changed(cwd, await service.create(cwd, await json())))
  router.add('GET', DOCUMENT, ({ cwd, params }) => service.get(cwd, params.documentId!))
  router.add('PUT', DOCUMENT, async ({ cwd, params, json }) => {
    const body = await json()
    const result = await service.save(cwd, params.documentId!, body as unknown as StoryWriteRequest)
    return body.dryRun === true ? result : changed(cwd, result)
  })
  router.add('POST', `${DOCUMENT}/operations`, async ({ cwd, params, json }) => {
    const body = await json()
    const result = await service.apply(cwd, params.documentId!, body as unknown as StoryApplyRequest)
    return body.dryRun === true ? result : changed(cwd, result)
  })
  router.add('POST', `${DOCUMENT}/query`, async ({ cwd, params, json }) => {
    const document = await service.get(cwd, params.documentId!)
    try {
      return queryStoryDocument(document, await json() as unknown as StoryQueryRequest)
    } catch (error) {
      throw new StudioApiError(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  })
  router.add('GET', `${DOCUMENT}/objects/:kind/:objectId/deletion-preview`, ({ cwd, params }) => {
    if (!OBJECT_KINDS.has(params.kind!)) throw new StudioApiError(400, 'BAD_REQUEST', `Unknown object kind ${params.kind!}.`)
    return service.deletionPreview(cwd, params.documentId!, { kind: params.kind as StoryObjectTarget['kind'], id: params.objectId! })
  })
  router.add('GET', `${DOCUMENT}/history`, ({ cwd, params }) => service.history(cwd, params.documentId!))
  router.add('POST', `${DOCUMENT}/history`, async ({ cwd, params, json }) =>
    service.checkpoint(cwd, params.documentId!, await json() as { expectedRevision: string; label: string }))
  router.add('GET', `${DOCUMENT}/history/:versionId`, ({ cwd, params }) => service.version(cwd, params.documentId!, params.versionId!))
  router.add('POST', `${DOCUMENT}/restore`, async ({ cwd, params, json }) =>
    changed(cwd, await service.restore(cwd, params.documentId!, await json() as { expectedRevision: string; versionId: string; operationId?: string })))
  router.add('POST', `${DOCUMENT}/revert`, async ({ cwd, params, json }) =>
    changed(cwd, await service.revert(cwd, params.documentId!, await json() as { expectedRevision: string; operationId: string })))
}
