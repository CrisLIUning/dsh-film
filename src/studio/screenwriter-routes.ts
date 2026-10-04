/**
 * Studio's screenwriter endpoints over the workspace's screenplays, with the
 * request and answer shapes of Studio's `routes/screenwriter.ts`.
 * @module dsh-film/studio/screenwriter-routes
 */

import { StoryOperationError } from '../screenwriter/contracts/index.js'
import type { StoryApplyRequest, StoryBindRequest, StoryObjectTarget, StoryQueryRequest, StoryWriteRequest } from '../screenwriter/contracts/index.js'
import { readProject } from '../project.js'
import { StoryAssets } from '../screenwriter/assets.js'
import { queryStoryDocument } from '../screenwriter/query.js'
import { StoryError, StoryService } from '../screenwriter/service.js'
import { StudioApiError, studioError } from './router.js'
import type { StudioRequest, StudioRouter } from './router.js'

const DOCUMENTS = '/api/projects/:projectId/story/documents'
const DOCUMENT = `${DOCUMENTS}/:documentId`

const OBJECT_KINDS = new Set(['entity', 'scene', 'shot'])
/** Reference bytes shown inline; any other type is sent as a download. */
const RASTER_IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'])

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

/** The screenplay services the screenwriter routes (and the story routes added beside them) share. */
export interface ScreenwriterServices {
  /** The screenplay store. */
  stories: StoryService
  /** Reference images. */
  assets: StoryAssets
  /** Told about every committed change (for live views). */
  onChange: (cwd: string, documentId: string, revision: string) => void
}

/**
 * The screenplay services with their defaults filled in.
 * @param services - what the caller supplies.
 * @returns the services.
 */
export function screenwriterServices(services: Partial<ScreenwriterServices> = {}): ScreenwriterServices {
  const stories = services.stories ?? new StoryService()
  return { stories, assets: services.assets ?? new StoryAssets(stories), onChange: services.onChange ?? (() => {}) }
}

/**
 * The film's board id: its project's id. A screenplay route's `:projectId` is
 * ignored like every other Studio project id here, so it cannot point the
 * library at a board the 分镜 tab never opens.
 * @param request - the request.
 * @returns the board id.
 */
export async function filmBoardOf(request: StudioRequest): Promise<string> {
  return (await readProject(request.cwd))?.id ?? request.params.projectId ?? 'film'
}

/**
 * Add the screenwriter routes to a router.
 * @param router - the Studio-compatible router.
 * @param services - the screenplay services.
 */
export function addScreenwriterRoutes(router: StudioRouter, services: ScreenwriterServices): void {
  const { stories: service, assets, onChange } = services
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

  // Reference images: the film's image library, what each bound version resolves to, binding and its removal, and the bound bytes.
  router.add('GET', '/api/projects/:projectId/story/assets', async request => assets.candidates(request.cwd, await filmBoardOf(request)))
  router.add('GET', `${DOCUMENT}/references`, async request =>
    assets.resolve(request.cwd, await service.get(request.cwd, request.params.documentId!), await filmBoardOf(request)))
  router.add('POST', `${DOCUMENT}/bindings`, async request =>
    changed(request.cwd, await assets.bind(request.cwd, request.params.documentId!, await request.json() as unknown as StoryBindRequest, await filmBoardOf(request))))
  router.add('DELETE', `${DOCUMENT}/bindings/:bindingId`, async request =>
    changed(request.cwd, await assets.unbind(request.cwd, request.params.documentId!, request.params.bindingId!, String((await request.json()).expectedRevision ?? ''))))
  router.add('GET', `${DOCUMENT}/references/:assetId/:versionId`, async (request) => {
    const document = await service.get(request.cwd, request.params.documentId!)
    const file = await assets.readReference(request.cwd, document, request.params.assetId!, request.params.versionId!, await filmBoardOf(request))
    // Only raster images are shown inline; anything else a package delivered (HTML, SVG, XML) is a download, never a page on this origin.
    const inline = RASTER_IMAGES.has(file.mime)
    return new Response(new Uint8Array(file.buffer), {
      headers: {
        'Content-Type': inline ? file.mime : 'application/octet-stream',
        ...(inline ? {} : { 'Content-Disposition': 'attachment' }),
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })
}
