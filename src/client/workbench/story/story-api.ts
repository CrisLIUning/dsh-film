/**
 * The 剧本 tab's calls: Studio's screenwriter endpoints, which the plugin
 * answers behind its `studio` routes (the Studio path travels in `path=`, a
 * write's verb in `method=`). Screenplays are `film/story/<id>.md`.
 */

import type {
  StoryDeletionPreviewResponse,
  StoryDiagnostic,
  StoryDocument,
  StoryDocumentKind,
  StoryDocumentSummary,
  StoryMutationResult,
  StoryObjectTarget,
  StoryOperation,
} from '../../../screenwriter/contracts/types.js'

/** One saved version of a screenplay, as the history lists it. */
export interface StoryVersion {
  id: string
  version: number
  label: string
  /** Milliseconds since the epoch. */
  createdAt: number
  source: 'ai' | 'manual' | 'restore'
  size: number
  current: boolean
}

/** A refusal from the plugin, with Studio's code and the diagnostics of a refused edit. */
export class StoryApiError extends Error {
  override name = 'StoryApiError'

  constructor(message: string, readonly status: number, readonly code: string, readonly diagnostics: StoryDiagnostic[] = []) {
    super(message)
  }
}

/** The screenplay changed since it was read; carries the version now on disk. */
export class StoryConflictError extends StoryApiError {
  override name = 'StoryConflictError'

  constructor(message: string, readonly current: StoryDocument) {
    super(message, 409, 'STORY_CONFLICT')
  }
}

/** The page's base; read through `globalThis` so the module also loads in Host-side tests. */
const baseUri = (): string => (globalThis as { document?: { baseURI?: string } }).document?.baseURI ?? 'http://localhost/'

/** Where the plugin's routes are: against the document base, like the workbench's other calls. */
const route = (name: 'studio' | 'studio-write', cwd: string, path: string, method?: string): URL => {
  const url = new URL(`api/dsh-film/${name}`, baseUri())
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', path)
  if (method !== undefined) url.searchParams.set('method', method)
  return url
}

async function answer<T>(response: Response): Promise<T> {
  const text = await response.text()
  let body: Record<string, unknown> | undefined
  try {
    body = text === '' ? undefined : JSON.parse(text) as Record<string, unknown>
  } catch {
    body = undefined
  }
  if (response.ok) return body as T
  const error = body?.error
  const message = typeof error === 'string'
    ? error
    : typeof (error as { message?: unknown } | undefined)?.message === 'string' ? (error as { message: string }).message : `${response.status} ${response.statusText}`.trim()
  const code = typeof body?.code === 'string' ? body.code : typeof (error as { code?: unknown } | undefined)?.code === 'string' ? (error as { code: string }).code : `HTTP_${response.status}`
  const current = body?.current as StoryDocument | undefined
  if (response.status === 409 && code === 'STORY_CONFLICT' && current !== undefined && typeof current.revision === 'string') throw new StoryConflictError(message, current)
  throw new StoryApiError(message, response.status, code, Array.isArray(body?.diagnostics) ? body.diagnostics as StoryDiagnostic[] : [])
}

/** The screenplay calls for one workspace's film. */
export interface StoryApi {
  list(signal?: AbortSignal): Promise<StoryDocumentSummary[]>
  read(documentId: string, signal?: AbortSignal): Promise<StoryDocument>
  create(input: { title: string; kind: StoryDocumentKind }): Promise<StoryMutationResult>
  write(documentId: string, input: { expectedRevision: string; content: string; operationId: string }): Promise<StoryMutationResult>
  apply(documentId: string, input: { expectedRevision: string; operations: StoryOperation[]; operationId: string }): Promise<StoryMutationResult>
  deletionPreview(documentId: string, target: StoryObjectTarget): Promise<StoryDeletionPreviewResponse>
  history(documentId: string): Promise<StoryVersion[]>
  version(documentId: string, versionId: string): Promise<{ version: StoryVersion; content: string }>
  checkpoint(documentId: string, input: { expectedRevision: string; label: string }): Promise<{ version: StoryVersion }>
  restore(documentId: string, input: { expectedRevision: string; versionId: string; operationId: string }): Promise<StoryMutationResult>
}

/**
 * The screenplay calls for a workspace.
 * @param cwd - the workspace directory.
 * @param projectId - the film project's id (Studio paths carry one; the plugin ignores it).
 */
export function storyApi(cwd: string, projectId: string): StoryApi {
  const base = `/api/projects/${encodeURIComponent(projectId)}/story/documents`
  const doc = (documentId: string): string => `${base}/${encodeURIComponent(documentId)}`
  const get = async <T>(path: string, signal?: AbortSignal): Promise<T> =>
    answer<T>(await fetch(route('studio', cwd, path), { credentials: 'same-origin', ...(signal ? { signal } : {}) }))
  const send = async <T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> =>
    answer<T>(await fetch(route('studio-write', cwd, path, method), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }))
  return {
    list: async signal => (await get<{ documents: StoryDocumentSummary[] }>(base, signal)).documents,
    read: (documentId, signal) => get<StoryDocument>(doc(documentId), signal),
    create: input => send('POST', base, input),
    write: (documentId, input) => send('PUT', doc(documentId), input),
    apply: (documentId, input) => send('POST', `${doc(documentId)}/operations`, { ...input, source: 'manual' }),
    deletionPreview: (documentId, target) => get(`${doc(documentId)}/objects/${target.kind}/${encodeURIComponent(target.id)}/deletion-preview`),
    history: async documentId => (await get<{ versions: StoryVersion[] }>(`${doc(documentId)}/history`)).versions,
    version: (documentId, versionId) => get(`${doc(documentId)}/history/${encodeURIComponent(versionId)}`),
    checkpoint: (documentId, input) => send('POST', `${doc(documentId)}/history`, input),
    restore: (documentId, input) => send('POST', `${doc(documentId)}/restore`, input),
  }
}
