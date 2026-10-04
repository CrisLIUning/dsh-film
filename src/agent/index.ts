/**
 * The agent's film tools: `film_project` in every conversation, and the
 * screenplay, storyboard and cut tools in the conversations whose workspace
 * is a film.
 * @module dsh-film/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { canvasTools } from './canvas-tools.js'
import type { FilmToolServices } from './context.js'
import { FILM_GUIDANCE } from './guidance.js'
import { installFilmAgentTools } from './install.js'
import { filmProjectTool } from './project-tool.js'
import { storyTools } from './story-tools.js'
import { storyExchangeTools } from './story-exchange-tools.js'
import { timelineTools } from './timeline-tools.js'

export type { FilmToolServices, FilmWorkspace } from './context.js'
export { FilmToolError } from './studio-client.js'

/**
 * The tools a film conversation carries.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function filmAgentTools(services: FilmToolServices): ToolDefinition[] {
  return [
    ...storyTools(services),
    ...storyExchangeTools(services),
    ...canvasTools(services), ...timelineTools(services),
  ]
}

/**
 * Register `film_project` and install the film tools into film conversations.
 * @param ctx - a context with the `agents` and `tools` services.
 * @param services - the film services, without the installer's own hook.
 * @returns tells the installer a workspace now has a film.
 */
export function applyFilmAgentTools(ctx: Context, services: Omit<FilmToolServices, 'projectCreated'>): (cwd: string) => void {
  let install: (cwd: string) => void = () => {}
  const full: FilmToolServices = { ...services, projectCreated: (cwd) => { install(cwd) } }
  ctx.tools.register(filmProjectTool(full))
  install = installFilmAgentTools(ctx, { tools: () => filmAgentTools(full), guidance: FILM_GUIDANCE })
  return full.projectCreated
}
