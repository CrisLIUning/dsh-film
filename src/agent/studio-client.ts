/**
 * The agent's film tools call the same Studio-compatible API the hosted pages
 * call, in-process: the request goes through the router the Host routes use,
 * so an agent's edit takes the pages' path — the same validation, revisions,
 * versions, receipts and change events. Studio's own film tools are the same
 * kind of thin client over its daemon's routes.
 * @module dsh-film/agent/studio-client
 */

import type { StudioRouter } from '../studio/router.js'

/** A failed film tool call: a stable code, which also leads the message the model reads. */
export class FilmToolError extends Error {
  override name = 'FilmToolError'

  constructor(readonly code: string, message: string) {
    super(message.startsWith(`${code}:`) ? message : `${code}: ${message}`)
  }
}

export interface StudioCall {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** The Studio path with its query, below `/api/`. */
  path: string
  body?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * What a refusal says, without the whole documents some refusals carry
 * (a conflict answers with the current screenplay or cut).
 * @param status - the HTTP status.
 * @param payload - the parsed answer.
 * @returns the error.
 */
export function refusal(status: number, payload: unknown): FilmToolError {
  const body = isRecord(payload) ? payload : {}
  const nested = isRecord(body.error) ? body.error : undefined
  const code = typeof body.code === 'string' ? body.code : typeof nested?.code === 'string' ? nested.code : `HTTP_${status}`
  const message = typeof body.error === 'string' ? body.error : typeof nested?.message === 'string' ? nested.message : `The film workbench refused the call (HTTP ${status}).`
  const notes: string[] = []
  const current = isRecord(body.current) ? body.current : undefined
  if (current !== undefined && (typeof current.revision === 'string' || typeof current.revision === 'number')) notes.push(`current revision: ${String(current.revision)}`)
  if (Array.isArray(body.diagnostics) && body.diagnostics.length > 0) notes.push(`diagnostics: ${JSON.stringify(body.diagnostics.slice(0, 10))}`)
  if (Array.isArray(body.paths) && body.paths.length > 0) notes.push(`paths: ${JSON.stringify(body.paths.slice(0, 20))}`)
  if (typeof body.operationId === 'string') notes.push(`operation: ${body.operationId}`)
  // Director refusals name what the next call needs: the nodes to choose from, the step that failed, the scene's current fingerprint.
  if (Array.isArray(body.directorNodes)) notes.push(`directorNodes: ${JSON.stringify(body.directorNodes.slice(0, 20))}`)
  if (typeof body.op === 'number') notes.push(`op index: ${body.op}`)
  if (typeof body.fingerprint === 'string') notes.push(`current fingerprint: ${body.fingerprint}`)
  return new FilmToolError(code, `${code}: ${message}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`)
}

/**
 * Call the workbench's API for one workspace.
 * @param router - the Studio-compatible router.
 * @param cwd - the workspace directory.
 * @param call - method, path and body.
 * @param signal - the tool call's cancellation.
 * @returns the JSON answer.
 */
export async function callStudio(router: StudioRouter, cwd: string, call: StudioCall, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const read = call.method === 'GET'
  const url = new URL(`http://dsh-film.invalid/api/dsh-film/${read ? 'studio' : 'studio-write'}`)
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', call.path)
  if (!read && call.method !== 'POST') url.searchParams.set('method', call.method)
  const response = await router.dispatch(new Request(url, {
    method: read ? 'GET' : 'POST',
    ...(read ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(call.body ?? {}) }),
    ...(signal !== undefined ? { signal } : {}),
  }))
  const text = await response.text()
  let payload: unknown
  try {
    payload = text === '' ? {} : JSON.parse(text)
  } catch {
    payload = { error: text }
  }
  if (!response.ok) throw refusal(response.status, payload)
  return isRecord(payload) ? payload : { value: payload }
}
