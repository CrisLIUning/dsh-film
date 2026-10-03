/**
 * The plugin's routes on the Host's API channel. The connection service has
 * already authenticated every request that reaches them.
 *
 * - `GET  /api/dsh-film/project?cwd=` — the workspace's project, or `null`.
 * - `POST /api/dsh-film/project` — `{ cwd, title, aspectRatio? }` starts one;
 *   an existing project is answered with 409 and left as it is.
 * - `GET  /api/dsh-film/assets?cwd=` — media files under `media/` and `film/`.
 * - `GET|HEAD /api/dsh-film/media?path=` — one media file, with byte ranges.
 * @module dsh-film/routes
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { FilmError } from './errors.js'
import { listAssets, serveMedia } from './media.js'
import { createProject, parseNewProject, readProject, workspaceDirectory } from './project.js'
import { StoryService } from './screenwriter/service.js'
import { FilmMediaTasks } from './media/tasks.js'
import type { MediaServiceLike } from './media/tasks.js'
import { addCanvasRoutes } from './studio/canvas-routes.js'
import { addMediaRoutes } from './studio/media-routes.js'
import { ProjectEvents } from './studio/events.js'
import { addProjectRoutes } from './studio/project-routes.js'
import { StudioRouter } from './studio/router.js'
import { addScreenwriterRoutes } from './studio/screenwriter-routes.js'

export const ROUTE_PREFIX = '/api/dsh-film'

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
})

/**
 * Answer a failure: a {@link FilmError} with its own status and code,
 * anything else as an internal error.
 * @param error - what was thrown.
 * @param method - the request method; HEAD answers carry no body.
 * @returns the response.
 */
export function failure(error: unknown, method = 'GET'): Response {
  const filmError = error instanceof FilmError ? error : undefined
  const status = filmError?.status ?? 500
  if (method === 'HEAD') return new Response(null, { status })
  return json(status, {
    error: {
      code: filmError?.code ?? 'INTERNAL',
      message: filmError?.message ?? (error instanceof Error ? error.message : String(error)),
    },
  })
}

const answering = (handle: (request: Request) => Promise<Response>) =>
  async (request: Request): Promise<Response> => {
    try {
      return await handle(request)
    } catch (error) {
      return failure(error, request.method)
    }
  }

/**
 * Read a JSON request body. Requiring the JSON content type keeps other
 * sites from posting here with a plain form, which browsers send without asking.
 * @param request - the request.
 * @returns the parsed body.
 */
async function jsonBody(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? ''
  if (!/^application\/json\s*(;|$)/i.test(type)) throw new FilmError('BAD_REQUEST', 'The request body must be sent as application/json.')
  try {
    return await request.json()
  } catch {
    throw new FilmError('BAD_REQUEST', 'The request body is not valid JSON.')
  }
}

async function project(request: Request): Promise<Response> {
  if (request.method === 'POST') {
    const body = await jsonBody(request)
    const cwd = await workspaceDirectory(typeof body === 'object' && body !== null ? (body as { cwd?: string }).cwd : undefined)
    const result = await createProject(cwd, parseNewProject(body))
    return result.created
      ? json(201, { project: result.project })
      : json(409, { error: { code: 'PROJECT_EXISTS', message: 'This workspace already has a film project.' }, project: result.project })
  }
  const cwd = await workspaceDirectory(new URL(request.url).searchParams.get('cwd'))
  return json(200, { project: await readProject(cwd) })
}

async function assets(request: Request): Promise<Response> {
  const cwd = await workspaceDirectory(new URL(request.url).searchParams.get('cwd'))
  return json(200, await listAssets(cwd))
}

/**
 * The routes this plugin registers.
 * @returns the route list.
 */
export function filmRoutes(studio: StudioRouter = createStudioRouter()): ConnectionFetchRoute[] {
  return [
    { path: `${ROUTE_PREFIX}/project`, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: answering(project) },
    { path: `${ROUTE_PREFIX}/assets`, methods: ['GET'], requestBody: 'buffered', fetch: answering(assets) },
    { path: `${ROUTE_PREFIX}/media`, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: answering(serveMedia) },
    // The Studio-compatible API on two routes: reads, and writes with streamed
    // bodies (uploads can be large). One route cannot do both: the Host builds
    // a streamed body for every method a streaming route declares, and a GET
    // with a body is refused before it reaches the handler.
    { path: `${ROUTE_PREFIX}/studio`, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: request => studio.dispatch(request) },
    { path: `${ROUTE_PREFIX}/studio-write`, methods: ['POST'], requestBody: 'streaming', fetch: request => studio.dispatch(request) },
  ]
}

/**
 * The Studio-compatible API with everything this plugin implements.
 * @returns the router.
 */
export function createStudioRouter(options: StudioRouterOptions = {}): StudioRouter {
  const router = new StudioRouter()
  const events = new ProjectEvents()
  const media = options.media ?? (() => undefined)
  addScreenwriterRoutes(router, new StoryService(), (cwd, documentId, revision) => {
    events.emit(cwd, { type: 'story-changed', documentId, revision })
  })
  addCanvasRoutes(router, events)
  addMediaRoutes(router, options.tasks ?? new FilmMediaTasks(media), media)
  addProjectRoutes(router, events)
  return router
}

export interface StudioRouterOptions {
  /** dsh-media's `vibedevMedia` service, when it is running. */
  media?: () => MediaServiceLike | undefined
  /** The canvas's media tasks (one per plugin instance, disposed with it). */
  tasks?: FilmMediaTasks
}
