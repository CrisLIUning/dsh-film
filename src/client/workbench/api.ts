/**
 * The workbench's calls to the plugin's Host routes. URLs resolve against the
 * document base, so they work under the desktop app's `dsh-app://app/` origin
 * and under a web client mounted below a path alike.
 */

/** Frame shapes, mirroring the Host's project model. */
export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '2.39:1'] as const
export type AspectRatio = typeof ASPECT_RATIOS[number]

/** `film/film.json`, as the Host returns it. */
export interface FilmProject {
  format: 'vibedev.film'
  version: 1
  id: string
  title: string
  aspectRatio: AspectRatio
  createdAt: string
  updatedAt: string
}

export type MediaKind = 'image' | 'video' | 'audio'

export interface MediaAsset {
  /** Relative to the workspace, with `/` separators. */
  path: string
  kind: MediaKind
  bytes: number
  modifiedAt: string
}

/** A failed call: the Host's error code and message, or the transport's. */
export class FilmApiError extends Error {
  override name = 'FilmApiError'

  constructor(readonly code: string, message: string, readonly status: number, readonly body: unknown) {
    super(message)
  }
}

const endpoint = (path: string, query: Record<string, string> = {}): URL => {
  const url = new URL(`api/dsh-film/${path}`, document.baseURI)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url
}

async function call<T>(url: URL, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init })
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error
    throw new FilmApiError(
      typeof error?.code === 'string' ? error.code : `HTTP_${response.status}`,
      typeof error?.message === 'string' ? error.message : `${response.status} ${response.statusText}`.trim(),
      response.status,
      body,
    )
  }
  return body as T
}

/**
 * Read the workspace's project.
 * @param cwd - the workspace directory.
 * @param signal - cancels the request.
 * @returns the project, or `null` when the workspace has none.
 */
export async function fetchProject(cwd: string, signal?: AbortSignal): Promise<FilmProject | null> {
  const body = await call<{ project: FilmProject | null }>(endpoint('project', { cwd }), signal === undefined ? {} : { signal })
  return body.project
}

/**
 * Start the workspace's project. When one already exists (another tab or the
 * agent got there first), that project is returned instead.
 * @param cwd - the workspace directory.
 * @param title - the film's title.
 * @param aspectRatio - the frame.
 * @returns the project now in the workspace.
 */
export async function createProject(cwd: string, title: string, aspectRatio: AspectRatio): Promise<FilmProject> {
  try {
    const body = await call<{ project: FilmProject }>(endpoint('project'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, title, aspectRatio }),
    })
    return body.project
  } catch (error) {
    const existing = error instanceof FilmApiError && error.code === 'PROJECT_EXISTS'
      ? (error.body as { project?: FilmProject } | undefined)?.project
      : undefined
    if (existing !== undefined) return existing
    throw error
  }
}

/**
 * List the workspace's media files, newest first.
 * @param cwd - the workspace directory.
 * @param signal - cancels the request.
 * @returns the files and whether the list was cut short.
 */
export async function fetchAssets(cwd: string, signal?: AbortSignal): Promise<{ assets: MediaAsset[]; truncated: boolean }> {
  return await call(endpoint('assets', { cwd }), signal === undefined ? {} : { signal })
}

/**
 * Join a workspace-relative path onto the workspace with the workspace's own
 * separator, so Windows paths stay Windows paths.
 * @param cwd - the absolute workspace directory.
 * @param path - a path relative to it, with `/` separators.
 * @returns the absolute path.
 */
export function absolutePath(cwd: string, path: string): string {
  const separator = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'
  const base = cwd.replace(/[\\/]+$/, '')
  return `${base}${separator}${path.split('/').join(separator)}`
}

/**
 * The URL a media element plays a workspace file from (byte ranges supported).
 * @param cwd - the workspace directory.
 * @param path - the file, relative to the workspace.
 * @returns the URL.
 */
export function mediaUrl(cwd: string, path: string): string {
  return endpoint('media', { path: absolutePath(cwd, path) }).href
}
