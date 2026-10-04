/**
 * What every film tool shares: the services it works through, the film of the
 * conversation's workspace, and a JSON answer.
 * @module dsh-film/agent/context
 */

import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { InferValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CanvasBoardAgent } from '../canvas/board-agent.js'
import { FILM_DIR, readProject } from '../project.js'
import type { FilmProject } from '../project.js'
import type { ProjectEvents } from '../studio/events.js'
import type { StudioRouter } from '../studio/router.js'
import { FilmToolError, callStudio } from './studio-client.js'

export interface FilmToolServices {
  /** The Studio-compatible API the pages use. */
  studio: StudioRouter
  /** The open canvas pages. */
  boardAgent: CanvasBoardAgent
  /** The project event bus, for edits made here rather than through a route. */
  events: ProjectEvents
  /** Tell the installer a workspace now has a film. */
  projectCreated(cwd: string): void
}

/** The film a tool call works on. */
export interface FilmWorkspace {
  cwd: string
  project: FilmProject
  /** The id Studio's paths and the canvas pages address the film by. */
  projectId: string
  /** The film's one board; its id is the project's. */
  boardId: string
}

/**
 * The conversation's workspace folder.
 * @param exec - the tool call.
 * @returns the folder.
 */
export function workspaceFolder(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || cwd === '') throw new FilmToolError('FILM_NO_WORKSPACE', 'This conversation has no workspace folder, so it has no film.')
  return cwd
}

/**
 * The film of the conversation's workspace.
 * @param exec - the tool call.
 * @returns the workspace and its film.
 */
export async function filmWorkspace(exec: ToolRunContext): Promise<FilmWorkspace> {
  const cwd = workspaceFolder(exec)
  const project = await readProject(cwd)
  if (project === null) throw new FilmToolError('FILM_NO_PROJECT', 'This workspace has no film project. Create one with film_project (action "create").')
  return { cwd, project, projectId: project.id, boardId: project.id }
}

/** A JSON value, as a tool declared with {@link jsonOutput} returns. */
export type JsonAnswer = InferValue<{ type: 'json' }>

/** JSON values only: drops `undefined` members so the answer is lossless JSON. */
export function plain(value: unknown): JsonAnswer {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonAnswer
}

/** A tool output declared as any JSON value and rendered as compact JSON. */
export const jsonOutput = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }],
} as const

/** Path segment encoding for Studio paths. */
export const segment = encodeURIComponent

/**
 * A film-relative path from what the agent wrote: `film/…`, `./…` and
 * backslashes are folded.
 * @param path - the path as written.
 * @returns the path relative to `film/`.
 */
export function filmRelative(path: string): string {
  const clean = path.trim().replaceAll('\\', '/').replace(/^\.\//u, '')
  return clean.startsWith(`${FILM_DIR}/`) ? clean.slice(FILM_DIR.length + 1) : clean
}

const isFile = (path: string): Promise<boolean> => stat(path).then(info => info.isFile(), () => false)

/** What {@link filmPathFor} needs to bring a workspace file into the film. */
export interface FilmPathOptions {
  /** The Studio-compatible API, whose import route copies the file. */
  studio: StudioRouter
  signal?: AbortSignal
  /** Runs before a workspace file is copied in (to refuse bytes other than the ones chosen); throwing stops the copy. */
  beforeImport?: (workspacePath: string) => Promise<void>
  /** The code of the failure when the import names no file. */
  failureCode?: string
}

/**
 * The film-relative path of a media file the agent named, bringing a
 * workspace file into the film first. Accepted: `film/…`; a path relative to
 * `film/` (a film file of that name wins); any media file of the workspace,
 * relative to it (`media/…` where the media tools save, or anywhere else
 * outside `film/`), which the editing desk's import links or copies into
 * `film/canvas/media/` — once: the same bytes again answer the earlier copy;
 * and an absolute path inside the workspace. A path that names no file is
 * returned as written, for the route to refuse in its own words.
 * @param film - the film.
 * @param path - the path as the agent wrote it.
 * @param options - the import's services.
 * @returns the path relative to `film/`.
 */
export async function filmPathFor(film: FilmWorkspace, path: string, options: FilmPathOptions): Promise<string> {
  let clean = path.trim()
  if (isAbsolute(clean)) {
    const offset = relative(film.cwd, clean)
    if (offset === '' || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
      throw new FilmToolError('FILM_PATH_INVALID', `${path} is outside this workspace.`)
    }
    clean = offset
  }
  clean = clean.replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '')
  if (clean.startsWith(`${FILM_DIR}/`)) return clean.slice(FILM_DIR.length + 1)
  const parts = clean.split('/')
  if (await isFile(join(film.cwd, FILM_DIR, ...parts)) || !await isFile(join(film.cwd, ...parts))) return clean
  await options.beforeImport?.(clean)
  const imported = await callStudio(options.studio, film.cwd, {
    method: 'POST',
    path: `/api/canvas/timelines/${segment(film.boardId)}/import?project=${segment(film.projectId)}`,
    body: { path: clean },
  }, options.signal)
  const file = imported.file !== null && typeof imported.file === 'object' ? imported.file as Record<string, unknown> : {}
  if (typeof file.name !== 'string' || file.name === '') throw new FilmToolError(options.failureCode ?? 'FILM_MEDIA_IMPORT_FAILED', `Could not bring ${clean} into the film.`)
  return file.name
}
