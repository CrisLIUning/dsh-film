/**
 * The 剧本 tab's calls: Studio's screenwriter endpoints, which the plugin
 * answers behind its `studio` routes (the Studio path travels in `path=`, a
 * write's verb in `method=`). Screenplays are `film/story/<id>.md`.
 *
 * Beside the screenplay itself: reference images (Studio's `listStoryAssets`,
 * `listStoryReferences`, `bindStoryReference`, `unbindStoryReference`),
 * import and export, and sending to the canvas with its impact report
 * (Studio `apps/web/src/providers/screenwriter.ts`). Only types come from the
 * contracts, so no validation code reaches the browser bundle.
 */

import type {
  StoryAssetCandidate,
  StoryAssetResolution,
  StoryBindRequest,
  StoryExportRequest,
  StoryExportResult,
  StoryHandoffRequest,
  StoryHandoffResponse,
  StoryImpactResponse,
  StoryImportPreview,
  StoryImportRequest,
  StorySourcePreview,
} from '../../../screenwriter/contracts/assets.js'
import type {
  StoryDeletionPreviewResponse,
  StoryDiagnostic,
  StoryDocument,
  StoryDocumentKind,
  StoryDocumentSummary,
  StoryMutationResult,
  StoryObjectTarget,
  StoryBindingScope,
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
  /** The film's image library (images under `film/`, newest first, with their current SHA-256). */
  assets(signal?: AbortSignal): Promise<StoryAssetCandidate[]>
  /** What every reference version recorded in the saved screenplay resolves to. */
  references(documentId: string, signal?: AbortSignal): Promise<StoryAssetResolution[]>
  /** Bind one library image version to a card. */
  bind(documentId: string, body: StoryBindRequest): Promise<StoryMutationResult>
  /** Remove one binding; the image itself stays. */
  unbind(documentId: string, bindingId: string, expectedRevision: string): Promise<StoryMutationResult>
  /** A film file (path relative to `film/`) as the page can load it. */
  fileUrl(path: string): string
  /** The bytes of one bound reference version as the page can load them. */
  referenceUrl(documentId: string, assetId: string, versionId: string): string
  /** A Studio path the plugin answered with (a source preview's reference `url`) as the page can load it. */
  studioUrl(path: string): string
  /** Inspect an import without storing anything; the digest pins the exact bytes. */
  previewImport(input: StoryImportRequest): Promise<StoryImportPreview>
  /** Create a new screenplay from previewed bytes. */
  importCopy(input: StoryImportRequest & { expectedPreviewDigest: string }): Promise<StoryMutationResult>
  /** Export the saved revision as Markdown, body text or a reference package. */
  exportDocument(documentId: string, input: StoryExportRequest): Promise<StoryExportResult>
  /** One saved scene, shot or card as the canvas would receive it. */
  source(documentId: string, objectId: string, scope?: StoryBindingScope): Promise<StorySourcePreview>
  /** Send a saved object to the board as a source card, optionally with an idle production node. */
  handoff(documentId: string, body: StoryHandoffRequest): Promise<StoryHandoffResponse>
  /** What the canvas and the cut adopted from this screenplay, compared with the saved text. */
  impact(documentId: string): Promise<StoryImpactResponse>
}

/**
 * The screenplay calls for a workspace.
 * @param cwd - the workspace directory.
 * @param projectId - the film project's id (Studio paths carry one; the plugin ignores it).
 */
export function storyApi(cwd: string, projectId: string): StoryApi {
  const project = `/api/projects/${encodeURIComponent(projectId)}`
  const base = `${project}/story/documents`
  const doc = (documentId: string): string => `${base}/${encodeURIComponent(documentId)}`
  const get = async <T>(path: string, signal?: AbortSignal): Promise<T> =>
    answer<T>(await fetch(route('studio', cwd, path), { credentials: 'same-origin', ...(signal ? { signal } : {}) }))
  const send = async <T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown): Promise<T> =>
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
    assets: async signal => (await get<{ assets: StoryAssetCandidate[] }>(`${project}/story/assets`, signal)).assets,
    references: async (documentId, signal) => (await get<{ references: StoryAssetResolution[] }>(`${doc(documentId)}/references`, signal)).references,
    bind: (documentId, body) => send('POST', `${doc(documentId)}/bindings`, body),
    // Studio's unbind is a DELETE with a JSON body; it travels as a POST carrying the verb.
    unbind: (documentId, bindingId, expectedRevision) => send('DELETE', `${doc(documentId)}/bindings/${encodeURIComponent(bindingId)}`, { expectedRevision }),
    fileUrl: path => route('studio', cwd, `${project}/raw/${path.split('/').map(encodeURIComponent).join('/')}`).href,
    referenceUrl: (documentId, assetId, versionId) =>
      route('studio', cwd, `${doc(documentId)}/references/${encodeURIComponent(assetId)}/${encodeURIComponent(versionId)}`).href,
    studioUrl: path => route('studio', cwd, path).href,
    previewImport: input => send('POST', `${project}/story/import/preview`, input),
    importCopy: input => send('POST', `${project}/story/import`, input),
    exportDocument: (documentId, input) => send('POST', `${doc(documentId)}/export`, input),
    source: (documentId, objectId, scope) =>
      get(`${doc(documentId)}/source/${encodeURIComponent(objectId)}${scope?.kind === 'scene' ? `?sceneId=${encodeURIComponent(scope.sceneId)}` : ''}`),
    handoff: (documentId, body) => send('POST', `${doc(documentId)}/handoff`, body),
    impact: documentId => get(`${doc(documentId)}/impact`),
  }
}
