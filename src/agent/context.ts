/**
 * What every film tool shares: the services it works through, the film of the
 * conversation's workspace, and a JSON answer.
 * @module dsh-film/agent/context
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { InferValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CanvasBoardAgent } from '../canvas/board-agent.js'
import { readProject } from '../project.js'
import type { FilmProject } from '../project.js'
import type { ProjectEvents } from '../studio/events.js'
import type { StudioRouter } from '../studio/router.js'
import { FilmToolError } from './studio-client.js'

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
