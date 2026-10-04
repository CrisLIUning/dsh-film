/**
 * The agent's film tools go to the conversations that have a film to work
 * on: those whose workspace holds `film/film.json`. Other conversations do
 * not carry them (thirty tool schemas on every request of every chat would
 * cost the person tokens for nothing), so each agent gets its own scoped copy
 * when it starts in a film workspace, or the moment its workspace gets a film.
 * A scoped registration unwinds with its agent.
 * @module dsh-film/agent/install
 */

import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PROJECT_FILE } from '../project.js'

export interface FilmAgentToolset {
  /** Build one agent's copy of the tool definitions. */
  tools(): ToolDefinition[]
  /** What the agent is told about the film tools. */
  guidance: string
}

/** The system prompt section's name. */
export const GUIDANCE_SECTION = 'tool:dsh-film'

/**
 * Two workspace paths name the same folder (Windows paths ignore case).
 * @param left - a path.
 * @param right - another.
 * @returns whether they match.
 */
export function sameDirectory(left: string, right: string): boolean {
  const normalize = (path: string): string => {
    const resolved = resolve(path)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

async function hasFilm(cwd: string): Promise<boolean> {
  return stat(join(cwd, ...PROJECT_FILE.split('/'))).then(info => info.isFile(), () => false)
}

/**
 * Install the film tools into every live and future agent whose workspace has
 * a film project.
 * @param ctx - a context with the `agents` and `tools` services.
 * @param toolset - the tools and their guidance.
 * @returns tells the installer a workspace now has a film; its live agents get the tools before this returns.
 */
export function installFilmAgentTools(ctx: Context, toolset: FilmAgentToolset): (cwd: string) => void {
  const installed = new Map<Agent, () => void>()
  const installing = new Set<Agent>()

  const install = (agent: Agent): () => void => {
    const scoped = agent.ctx
    const disposers: Array<() => unknown> = []
    try {
      for (const tool of toolset.tools()) disposers.push(scoped.tools.register(tool))
      const prompt = scoped.get('systemPrompt')
      if (prompt !== undefined) {
        disposers.push(prompt.section({
          name: GUIDANCE_SECTION, order: prompt.getSectionOrder('TOOL_COMPUTER_USE') + 60, text: toolset.guidance, interpolate: false,
        }))
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // Already unwound with the agent's scope.
        }
      }
    }
  }

  /** Install now, once; a live agent only — a disposed agent's scope takes no registrations. */
  const installNow = (agent: Agent): void => {
    if (installed.has(agent) || !ctx.agents.list().includes(agent)) return
    try {
      installed.set(agent, install(agent))
    } catch (error) {
      // A failed install leaves the conversation without film tools; it must not fail the conversation.
      ctx.logger.warn(`dsh-film: could not give the film tools to agent ${agent.id}: ${String(error)}`)
    }
  }

  const maybeInstall = async (agent: Agent): Promise<void> => {
    const cwd = agent.session.header.cwd
    if (cwd === undefined || cwd === '' || installed.has(agent) || installing.has(agent)) return
    installing.add(agent)
    try {
      if (await hasFilm(cwd)) installNow(agent)
    } finally {
      installing.delete(agent)
    }
  }

  for (const agent of ctx.agents.list()) void maybeInstall(agent)
  // Awaited before the agent's first step, so a film conversation starts with its tools.
  ctx.on('agent/created', async ({ agent }) => { await maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'dsh-film: agent film tools')

  // The caller has just made the film: install at once, so the agent that made
  // it has the tools on its very next step.
  return (cwd: string) => {
    for (const agent of ctx.agents.list()) {
      const workspace = agent.session.header.cwd
      if (workspace !== undefined && workspace !== '' && sameDirectory(workspace, cwd)) installNow(agent)
    }
  }
}
