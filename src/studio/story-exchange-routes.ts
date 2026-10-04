/**
 * Studio's screenplay import and export endpoints (routes/screenwriter.ts:
 * `story/import/preview`, `story/import`, `story/documents/:id/export`) over
 * the workspace's screenplays.
 *
 * An import answers like any other screenplay mutation and announces the new
 * copy (`story-changed`); a package export saves its ZIP under
 * `film/story-exports/`, served by the raw file route, and announces that file.
 * @module dsh-film/studio/story-exchange-routes
 */

import type { StoryExportRequest, StoryImportRequest } from '../screenwriter/contracts/index.js'
import { StoryExchange } from '../screenwriter/exchange.js'
import type { ProjectEvents } from './events.js'
import type { StudioRouter } from './router.js'
import { filmBoardOf } from './screenwriter-routes.js'
import type { ScreenwriterServices } from './screenwriter-routes.js'

export interface StoryExchangeRouteDeps {
  /** The screenplay services the screenwriter routes use. */
  story: ScreenwriterServices
  /** The project event bus. */
  events: ProjectEvents
  /** The exchange; built from `story` when absent. */
  exchange?: StoryExchange
}

/**
 * Add the import and export routes to a router. Story errors are answered by
 * the translator the screenwriter routes register.
 * @param router - the Studio-compatible router.
 * @param deps - the screenplay services and the event bus.
 */
export function addStoryExchangeRoutes(router: StudioRouter, deps: StoryExchangeRouteDeps): void {
  const { story, events } = deps
  const exchange = deps.exchange ?? new StoryExchange(story.stories, story.assets)
  router.add('POST', '/api/projects/:projectId/story/import/preview', async ({ json }) => exchange.preview(await json() as unknown as StoryImportRequest))
  router.add('POST', '/api/projects/:projectId/story/import', async ({ cwd, json }) => {
    const result = await exchange.import(cwd, await json() as unknown as StoryImportRequest)
    story.onChange(cwd, result.document.documentId, result.document.revision)
    return result
  })
  router.add('POST', '/api/projects/:projectId/story/documents/:documentId/export', async (request) => {
    const projectId = await filmBoardOf(request)
    const result = await exchange.export(request.cwd, projectId, request.params.documentId!, await request.json() as unknown as StoryExportRequest)
    if (result.filePath !== undefined) events.emit(request.cwd, { type: 'file-changed', projectId, path: result.filePath })
    return result
  })
}
