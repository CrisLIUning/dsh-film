/** The computer-wide library under Studio's existing authenticated transport. */
import { SharedAssetLibrary, SharedLibraryError } from '../canvas/shared-library.js'
import { WorkspaceMediaError } from '../media.js'
import { studioError } from './router.js'
import type { StudioHandler, StudioRequest, StudioRouter } from './router.js'

export const SHARED_LIBRARY_PREFIX = '/api/canvas/library'

/** Register local-only operations. Library reads/edits don't depend on the project's film files. */
export function addSharedLibraryRoutes(router: StudioRouter, library: SharedAssetLibrary): void {
  router.translate(error => error instanceof SharedLibraryError
    ? studioError(error.status, error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'CONFLICT' : error.status === 503 ? 'BUSY' : 'BAD_REQUEST', error.message, { code: error.code })
    : undefined)
  const add = (method: StudioRequest['method'], path: string, handler: StudioHandler): void => {
    router.add(method, `${SHARED_LIBRARY_PREFIX}${path}`, async request => {
      try { return await handler(request) } catch (error) {
        if (error instanceof WorkspaceMediaError) throw new SharedLibraryError(error.problem === 'not-found' ? 404 : 400,
          error.problem === 'not-found' ? 'SHARED_LIBRARY_SOURCE_NOT_FOUND' : 'SHARED_LIBRARY_INVALID', error.message)
        throw error
      }
    })
  }
  const mutationBody = async (request: StudioRequest): Promise<Record<string, unknown>> => {
    const body = await request.json()
    const expected = request.query.get('expectedRevision')
    return expected === null ? body : { ...body, expectedRevision: body.expectedRevision ?? expected }
  }
  add('GET', '', () => library.read())
  add('POST', '/folders', async request => library.createFolder(await mutationBody(request)))
  add('PATCH', '/folders/:id', async request => library.patchFolder(request.params.id!, await mutationBody(request)))
  add('DELETE', '/folders/:id', async request => library.deleteFolder(request.params.id!, await mutationBody(request)))
  add('POST', '/assets', async request => library.createAsset(request.cwd, await mutationBody(request)))
  add('POST', '/assets/upload', request => {
    // Prompt text and notes use JSON PATCH; only file transport metadata travels in the URL.
    const fields: Record<string, unknown> = {}
    for (const key of ['name', 'folderId', 'title', 'kind', 'expectedRevision']) {
      const value = request.query.get(key)
      if (value !== null) fields[key] = value
    }
    return library.upload(request.raw, fields)
  })
  add('PATCH', '/assets/:id', async request => library.patchAsset(request.params.id!, await mutationBody(request)))
  add('DELETE', '/assets/:id', async request => library.deleteAsset(request.params.id!, await mutationBody(request)))
  add('POST', '/assets/:id/restore', async request => library.restoreAsset(request.params.id!, await mutationBody(request)))
  add('GET', '/assets/:id/raw', request => library.raw(request.params.id!, request.raw))
  add('POST', '/import', async request => library.importAssets(request.cwd, await mutationBody(request)))
}
