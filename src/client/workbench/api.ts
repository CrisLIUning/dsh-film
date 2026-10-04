/**
 * The workbench's calls to the plugin's Host routes. URLs resolve against the
 * document base, so they work under the desktop app's `dsh-app://app/` origin
 * and under a web client mounted below a path alike.
 */

/** Frames a film can be given, mirroring the Host's project model. */
export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5', '21:9', '2.39:1'] as const
export type AspectRatio = typeof ASPECT_RATIOS[number]
/** A frame a project file may hold: one of {@link ASPECT_RATIOS}, or `4:3` kept from an earlier version. */
export type StoredAspectRatio = AspectRatio | '4:3'

/** The longest title, in characters, as the Host keeps it. */
export const TITLE_MAX = 80

/** `film/film.json`, as the Host returns it. */
export interface FilmProject {
  format: 'vibedev.film'
  version: 1
  id: string
  title: string
  aspectRatio: StoredAspectRatio
  createdAt: string
  updatedAt: string
}

/** A change to the film: a new title, a new frame, or both. */
export interface ProjectChange {
  title?: string
  aspectRatio?: AspectRatio
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

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * Make sure the workspace has its film: the Host creates it (named after the
 * folder, 16:9, with its empty board) unless one is already there (another
 * tab or the agent got there first), which is returned as it is.
 * @param cwd - the workspace directory.
 * @returns the film, and whether this call created it.
 */
export async function ensureProject(cwd: string): Promise<{ project: FilmProject; created: boolean }> {
  return await call<{ project: FilmProject; created: boolean }>(endpoint('project'), postJson({ cwd, ensure: true }))
}

/**
 * Rename the film or change its frame.
 * @param cwd - the workspace directory.
 * @param change - the new title and/or frame.
 * @returns the film as saved.
 */
export async function updateProject(cwd: string, change: ProjectChange): Promise<FilmProject> {
  return (await call<{ project: FilmProject }>(endpoint('project/update'), postJson({ cwd, ...change }))).project
}
