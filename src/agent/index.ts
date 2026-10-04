/**
 * The agent's film tools: `film_project` in every conversation; in the
 * conversations whose workspace is a film, the screenplay, storyboard and cut
 * tools plus `film_tools`, and the director desk's and the modeling tools as
 * groups taken on when needed.
 * @module dsh-film/agent
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CANVAS_DOCUMENT_FILE } from '../canvas/documents.js'
import { canvasTools } from './canvas-tools.js'
import { captionTools } from './caption-tools.js'
import { jsonOutput, plain } from './context.js'
import type { FilmToolServices } from './context.js'
import { directorTools } from './director-tools.js'
import { FILM_GUIDANCE } from './guidance.js'
import { installFilmAgentTools } from './install.js'
import type { FilmToolGroup, FilmToolInstaller } from './install.js'
import { modelingTools } from './modeling-tools.js'
import { filmProjectTool } from './project-tool.js'
import { storyTools } from './story-tools.js'
import { storyExchangeTools } from './story-exchange-tools.js'
import { storyProductionTools } from './story-production-tools.js'
import { FilmToolError } from './studio-client.js'
import { timelineTools } from './timeline-tools.js'
import { renderTools } from './render-tools.js'

export type { FilmToolServices, FilmWorkspace } from './context.js'
export { FilmToolError } from './studio-client.js'

/**
 * The tools every film conversation carries.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function filmCoreTools(services: FilmToolServices): ToolDefinition[] {
  return [
    ...storyTools(services),
    ...storyExchangeTools(services),
    ...storyProductionTools(services),
    ...canvasTools(services), ...timelineTools(services),
    ...captionTools(services),
    ...renderTools(services),
  ]
}

/** Whether the film's saved board holds a director node. */
async function boardHasDirector(cwd: string): Promise<boolean> {
  const text = await readFile(join(cwd, ...CANVAS_DOCUMENT_FILE.split('/')), 'utf8').catch(() => '')
  if (!text.includes('"director"')) return false
  const nodes = (JSON.parse(text) as { nodes?: unknown }).nodes
  return Array.isArray(nodes) && nodes.some(node => (node as { type?: unknown } | null)?.type === 'director')
}

/**
 * The tool groups a film conversation takes on when it needs them.
 * @param services - the film services.
 * @returns the groups, by name.
 */
export function filmToolGroups(services: FilmToolServices): Record<string, FilmToolGroup> {
  return {
    director: {
      description: 'The 导演 desk\'s 3D blocking scenes: query, stage, render, review, motion and modeling briefs for a desk target (director_*).',
      tools: () => directorTools(services),
      startsEnabled: boardHasDirector,
    },
    modeling: {
      description: 'Places and procedural models: compile a space plan into a GLB for the desk, prepare model briefs, read and annotate model records (space_plan_compile, model_*).',
      tools: () => modelingTools(services),
    },
  }
}

/**
 * Every film tool, groups included (for tests and documentation).
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function filmAgentTools(services: FilmToolServices): ToolDefinition[] {
  return [...filmCoreTools(services), ...Object.values(filmToolGroups(services)).flatMap(group => group.tools())]
}

/**
 * `film_tools`: list the film's tool groups and enable some for this conversation.
 * @param groups - the groups.
 * @param installer - the installer, read when the tool runs.
 * @returns the tool definition.
 */
export function filmToolsTool(groups: Readonly<Record<string, FilmToolGroup>>, installer: () => FilmToolInstaller | undefined): ToolDefinition {
  const names = Object.keys(groups)
  return defineTool({
    name: 'film_tools',
    description: `List this film's tool groups and enable the ones the task needs; enabled tools are available from your next step. Groups: ${
      Object.entries(groups).map(([name, group]) => `${name} — ${group.description}`).join(' ')}`,
    parameters: {
      enable: { type: 'array', items: { type: 'string', enum: names }, description: 'Groups to enable now.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new FilmToolError('FILM_TOOLS_NO_AGENT', 'film_tools works only inside a conversation.')
      const enabled = installer()?.enable(agent, args.enable ?? [])
      if (enabled === undefined) throw new FilmToolError('FILM_NO_PROJECT', 'This conversation carries no film tools; create the film with film_project first.')
      return plain({
        groups: Object.entries(groups).map(([name, group]) => ({
          name, description: group.description, enabled: enabled.includes(name), tools: group.tools().map(tool => tool.name),
        })),
        ...(args.enable !== undefined && args.enable.length > 0 ? { note: 'Enabled tools are available from your next step.' } : {}),
      })
    },
  })
}

/**
 * Register `film_project` and install the film tools into film conversations.
 * @param ctx - a context with the `agents` and `tools` services.
 * @param services - the film services, without the installer's own hook.
 * @returns tells the installer a workspace now has a film.
 */
export function applyFilmAgentTools(ctx: Context, services: Omit<FilmToolServices, 'projectCreated'>): (cwd: string) => void {
  let installer: FilmToolInstaller | undefined
  const full: FilmToolServices = { ...services, projectCreated: (cwd) => { installer?.projectCreated(cwd) } }
  const groups = filmToolGroups(full)
  ctx.tools.register(filmProjectTool(full))
  installer = installFilmAgentTools(ctx, {
    tools: () => [...filmCoreTools(full), filmToolsTool(groups, () => installer)],
    groups,
    guidance: FILM_GUIDANCE,
  })
  return full.projectCreated
}
