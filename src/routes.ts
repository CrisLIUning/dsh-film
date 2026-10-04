/**
 * The plugin's routes on the Host's API channel. The connection service has
 * already authenticated every request that reaches them.
 *
 * - `GET  /api/dsh-film/project?cwd=` — the workspace's project, or `null`.
 * - `POST /api/dsh-film/project` — `{ cwd, title, aspectRatio? }` starts one;
 *   an existing project is answered with 409 and left as it is.
 * - `GET  /api/dsh-film/assets?cwd=` — media files under `media/` and `film/`.
 * - `GET|HEAD /api/dsh-film/media?path=` — one media file, with byte ranges.
 * - `/api/dsh-film/caption-runner/*` — the caption runner's windows (see captions/runner).
 * @module dsh-film/routes
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { FilmError } from './errors.js'
import { listAssets, serveMedia } from './media.js'
import { createProject, parseNewProject, readProject, workspaceDirectory } from './project.js'
import { FilmMediaTasks } from './media/tasks.js'
import type { MediaServiceLike } from './media/tasks.js'
import { addCanvasRoutes } from './studio/canvas-routes.js'
import { CanvasBoardAgent } from './canvas/board-agent.js'
import { addMediaRoutes } from './studio/media-routes.js'
import { ProjectEvents } from './studio/events.js'
import { addProjectRoutes } from './studio/project-routes.js'
import { StudioRouter } from './studio/router.js'
import { addScreenwriterRoutes, screenwriterServices } from './studio/screenwriter-routes.js'
import { addStoryExchangeRoutes } from './studio/story-exchange-routes.js'
import { addStoryProductionRoutes } from './studio/story-production-routes.js'
import { addTextRoutes } from './studio/text-routes.js'
import { CanvasTextModels } from './canvas/text-models.js'
import type { TextServices } from './canvas/text-models.js'
import { addTimelineRoutes } from './studio/timeline-routes.js'
import { addRenderRoutes } from './studio/render-routes.js'
import type { RenderRouteOptions } from './studio/render-routes.js'
import { addModelRoutes } from './studio/model-routes.js'
import { addDirectorRoutes } from './studio/director-routes.js'
import type { EditorModels } from './models/service.js'
import { addModelingRoutes } from './studio/modeling-routes.js'
import type { ModelEnvironment } from './modeling/contracts/model-project.js'
import { captionRunnerRoutes } from './captions/runner.js'
import type { CaptionRunnerHub } from './captions/runner.js'
import type { CaptionService } from './captions/service.js'
import { addCaptionRoutes } from './studio/caption-routes.js'

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

const projectRoute = (created: (cwd: string) => void) => async (request: Request): Promise<Response> => {
  if (request.method === 'POST') {
    const body = await jsonBody(request)
    const cwd = await workspaceDirectory(typeof body === 'object' && body !== null ? (body as { cwd?: string }).cwd : undefined)
    const result = await createProject(cwd, parseNewProject(body))
    if (result.created) created(cwd)
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
 * @param studio - the Studio-compatible API.
 * @param projectCreated - told when a workspace gets its film project (the agent's film tools come with it).
 * @param captionRunner - the caption runner, whose windows' routes are served too.
 * @returns the route list.
 */
export function filmRoutes(studio: StudioRouter = createStudioRouter(), projectCreated: (cwd: string) => void = () => {}, captionRunner?: CaptionRunnerHub): ConnectionFetchRoute[] {
  return [
    { path: `${ROUTE_PREFIX}/project`, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: answering(projectRoute(projectCreated)) },
    { path: `${ROUTE_PREFIX}/assets`, methods: ['GET'], requestBody: 'buffered', fetch: answering(assets) },
    { path: `${ROUTE_PREFIX}/media`, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: answering(serveMedia) },
    // The Studio-compatible API on two routes: reads, and writes with streamed
    // bodies (uploads can be large). One route cannot do both: the Host builds
    // a streamed body for every method a streaming route declares, and a GET
    // with a body is refused before it reaches the handler.
    { path: `${ROUTE_PREFIX}/studio`, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: request => studio.dispatch(request) },
    { path: `${ROUTE_PREFIX}/studio-write`, methods: ['POST'], requestBody: 'streaming', fetch: request => studio.dispatch(request) },
    // The caption runner serves every workspace from each open window, so its routes take no cwd.
    ...(captionRunner !== undefined ? captionRunnerRoutes(captionRunner) : []),
  ]
}

/**
 * The Studio-compatible API with everything this plugin implements.
 * @returns the router.
 */
export function createStudioRouter(options: StudioRouterOptions = {}): StudioRouter {
  const router = new StudioRouter()
  const events = options.events ?? new ProjectEvents()
  const media = options.media ?? (() => undefined)
  const story = screenwriterServices({
    onChange: (cwd, documentId, revision) => { events.emit(cwd, { type: 'story-changed', documentId, revision }) },
  })
  const boardAgent = options.boardAgent ?? new CanvasBoardAgent()
  addScreenwriterRoutes(router, story)
  addStoryExchangeRoutes(router, { story, events })
  addStoryProductionRoutes(router, { story, events, boardAgent })
  addCanvasRoutes(router, events, boardAgent)
  addDirectorRoutes(router, { events, boardAgent })
  const tasks = options.tasks ?? new FilmMediaTasks(media)
  addMediaRoutes(router, tasks, media)
  addProjectRoutes(router, events)
  addTimelineRoutes(router, events)
  addRenderRoutes(router, events, { ...options.renderer, tasks, models: options.models, ffmpegPath: options.ffmpegPath })
  addTextRoutes(router, new CanvasTextModels(options.text ?? (() => ({}))), async (model) => {
    const video = (await media()?.models())?.find(entry => entry.id === model)?.video
    return video?.nativeAudio
  })
  if (options.models !== undefined) addModelRoutes(router, options.models)
  if (options.captions !== undefined) addCaptionRoutes(router, options.captions)
  addModelingRoutes(router, { events, ...(options.modelEnvironment !== undefined ? { environment: options.modelEnvironment } : {}) })
  return router
}

export interface StudioRouterOptions {
  /** The project event bus, shared with the agent's film tools so their edits reach open pages. */
  events?: ProjectEvents
  /** The open canvas pages, shared with the agent's canvas tools. */
  boardAgent?: CanvasBoardAgent
  /** dsh-media's `vibedevMedia` service, when it is running. */
  media?: () => MediaServiceLike | undefined
  /** The canvas's media tasks (one per plugin instance, disposed with it). */
  tasks?: FilmMediaTasks
  /** DSH's model services, read at each request (text-node answers, the prompt writer). */
  text?: () => TextServices
  /** The editing desk's AI models; without it the model endpoints are not offered. */
  models?: EditorModels
  /** The procedural-model panel's environment probe (tests replace it). */
  modelEnvironment?: () => Promise<ModelEnvironment>
  /** Original-audio captions; without it the caption endpoints are not offered. */
  captions?: CaptionService
  /** The plugin setting naming the ffmpeg the background render runs. */
  ffmpegPath?: string
  /** The background render's seams (tests replace finding and running ffmpeg). */
  renderer?: Omit<RenderRouteOptions, 'tasks' | 'models' | 'ffmpegPath'>
}
