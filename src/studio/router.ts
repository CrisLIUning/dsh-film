/**
 * A Studio-compatible API for the original apps this plugin hosts (canvas,
 * editing desk, director desk) and for the workbench's own screens. The apps
 * keep calling Studio's daemon paths; in their DSH build a small fetch wrapper
 * sends every such call to one Host route instead:
 *
 *   GET|HEAD /api/dsh-film/studio?cwd=<workspace>&path=<studio path and query>
 *   POST     /api/dsh-film/studio-write?cwd=<workspace>&path=<...>&method=POST|PUT|DELETE|PATCH
 *
 * The Host's API channel matches paths exactly and carries only GET, HEAD and
 * POST, so the Studio path and method travel in the query. This router
 * matches the Studio path against the routes this plugin implements. A
 * Studio project is the workspace here: `:projectId` segments are accepted
 * and ignored, and `cwd` names the workspace.
 * @module dsh-film/studio/router
 */

import { workspaceDirectory } from '../project.js'
import { FilmError } from '../errors.js'

export type StudioMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

export interface StudioRequest {
  method: StudioMethod
  /** The Studio path without its query. */
  path: string
  /** The Studio query parameters. */
  query: URLSearchParams
  /** Values of the matched route's `:name` segments, decoded. */
  params: Readonly<Record<string, string>>
  /** The workspace directory. */
  cwd: string
  /** The JSON request body (`{}` when there is none). */
  json(): Promise<Record<string, unknown>>
  /** The underlying Host request, for streamed bodies. */
  raw: Request
}

/** A handler answers with a Response, or with a value sent as JSON. */
export type StudioHandler = (request: StudioRequest) => Promise<unknown>

/**
 * Thrown by a handler to answer with exactly this status and JSON body — for
 * Studio routes whose error answers are not in the shared error shape (the
 * canvas routes answer `{ error: <text>, code }`).
 */
export class StudioReply extends Error {
  override name = 'StudioReply'

  constructor(readonly status: number, readonly body: Readonly<Record<string, unknown>>) {
    super(typeof body.error === 'string' ? body.error : `HTTP ${status}`)
  }
}

/** An error a handler throws to answer in Studio's error shape. */
export class StudioApiError extends Error {
  override name = 'StudioApiError'

  constructor(
    readonly status: number,
    /** Studio's generic error code (`BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`...). */
    readonly generic: string,
    message: string,
    /** Extra top-level members of the JSON answer (`code`, `current`, `diagnostics`...). */
    readonly extra: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
  }
}

interface Route {
  method: StudioMethod
  segments: readonly string[]
  handler: StudioHandler
}

const METHODS: readonly StudioMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
})

/**
 * The Studio-shaped JSON answer for an error.
 * @param status - HTTP status.
 * @param generic - Studio's generic code.
 * @param message - the message for people.
 * @param extra - extra top-level members.
 * @returns the response.
 */
export function studioError(status: number, generic: string, message: string, extra: Readonly<Record<string, unknown>> = {}): Response {
  return json(status, { error: { code: generic, message }, ...extra })
}

/** Turn what a handler threw into a Studio-shaped error answer. */
export type ErrorTranslator = (error: unknown) => Response | undefined

export class StudioRouter {
  private readonly routes: Route[] = []
  private readonly translators: ErrorTranslator[] = []

  /**
   * Add a route.
   * @param method - the Studio method.
   * @param pattern - the Studio path, `:name` for a captured segment and a
   *   final `*name` for the rest of the path (decoded, `/`-joined).
   * @param handler - the handler.
   * @returns this router.
   */
  add(method: StudioMethod, pattern: string, handler: StudioHandler): this {
    this.routes.push({ method, segments: pattern.split('/').filter(segment => segment !== ''), handler })
    return this
  }

  /**
   * Teach the router how to answer an error type handlers throw.
   * @param translate - returns a response for errors it knows.
   * @returns this router.
   */
  translate(translate: ErrorTranslator): this {
    this.translators.push(translate)
    return this
  }

  private match(method: StudioMethod, path: string): { route: Route; params: Record<string, string> } | 'wrong-method' | undefined {
    const parts = path.split('/').filter(segment => segment !== '')
    let pathMatched = false
    for (const route of this.routes) {
      const rest = route.segments.at(-1)?.startsWith('*') === true
      if (rest ? parts.length < route.segments.length : route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let index = 0; index < route.segments.length; index++) {
        const expected = route.segments[index]!
        const actual = parts[index]!
        if (expected.startsWith('*')) {
          try {
            params[expected.slice(1)] = parts.slice(index).map(part => decodeURIComponent(part)).join('/')
          } catch {
            matched = false
          }
          break
        }
        if (expected.startsWith(':')) {
          try {
            params[expected.slice(1)] = decodeURIComponent(actual)
          } catch {
            matched = false
            break
          }
        } else if (expected !== actual) {
          matched = false
          break
        }
      }
      if (!matched) continue
      if (route.method === method) return { route, params }
      pathMatched = true
    }
    return pathMatched ? 'wrong-method' : undefined
  }

  /**
   * Answer one Host request carrying a Studio call.
   * @param request - the request to `/api/dsh-film/studio`.
   * @returns the response.
   */
  async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const target = url.searchParams.get('path')
    if (target === null || !target.startsWith('/api/')) return studioError(400, 'BAD_REQUEST', 'A Studio path below /api/ is required.')
    const declared = (url.searchParams.get('method') ?? request.method).toUpperCase()
    const method = (declared === 'HEAD' ? 'GET' : declared) as StudioMethod
    if (!METHODS.includes(method)) return studioError(405, 'BAD_REQUEST', `Method ${declared} is not supported.`)
    if (method !== 'GET' && request.method !== 'POST') return studioError(405, 'BAD_REQUEST', `${method} calls must be sent as POST.`)
    const studioUrl = new URL(target, 'http://studio.invalid')
    const found = this.match(method, studioUrl.pathname)
    if (found === undefined) return studioError(404, 'NOT_FOUND', `${method} ${studioUrl.pathname} is not available in this workbench.`)
    if (found === 'wrong-method') return studioError(405, 'BAD_REQUEST', `${method} is not allowed on ${studioUrl.pathname}.`)
    try {
      const cwd = await workspaceDirectory(url.searchParams.get('cwd'))
      let body: Promise<Record<string, unknown>> | undefined
      const studioRequest: StudioRequest = {
        method,
        path: studioUrl.pathname,
        query: studioUrl.searchParams,
        params: found.params,
        cwd,
        raw: request,
        json: () => {
          body ??= readJson(request)
          return body
        },
      }
      const result = await found.route.handler(studioRequest)
      if (result instanceof Response) return request.method === 'HEAD' ? new Response(null, result) : result
      return json(200, result ?? {})
    } catch (error) {
      for (const translate of this.translators) {
        const answer = translate(error)
        if (answer !== undefined) return answer
      }
      if (error instanceof StudioReply) return json(error.status, error.body)
      if (error instanceof StudioApiError) return studioError(error.status, error.generic, error.message, error.extra)
      if (error instanceof FilmError) return studioError(error.status, error.status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', error.message, { code: error.code })
      const fileCode = (error as NodeJS.ErrnoException | undefined)?.code
      const status = fileCode === 'ENOENT' ? 404 : fileCode === 'EACCES' || fileCode === 'EPERM' ? 403 : 500
      return studioError(status, status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : 'INTERNAL', error instanceof Error ? error.message : String(error))
    }
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.trim() === '') return {}
  const type = request.headers.get('content-type') ?? ''
  if (!/^application\/json\s*(;|$)/i.test(type)) throw new StudioApiError(415, 'BAD_REQUEST', 'The request body must be sent as application/json.')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new StudioApiError(400, 'BAD_REQUEST', 'The request body is not valid JSON.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new StudioApiError(400, 'BAD_REQUEST', 'The request body must be a JSON object.')
  return value as Record<string, unknown>
}
