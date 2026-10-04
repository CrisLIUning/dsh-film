/**
 * The agent's film tools go to the conversations that have a film to work
 * on: those whose workspace holds `film/film.json`. Other conversations do
 * not carry them (thirty tool schemas on every request of every chat would
 * cost the person tokens for nothing), so each agent gets its own scoped copy
 * when it starts in a film workspace, or the moment its workspace gets a film.
 * A scoped registration unwinds with its agent.
 *
 * The same holds inside a film: the director desk's and the modeling tools are
 * groups a conversation takes on when it needs them (a board with a director
 * node starts with the director group; `film_tools` enables any group).
 * @module dsh-film/agent/install
 */

import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PROJECT_FILE } from '../project.js'

/** Tools a film conversation takes on only when it needs them. */
export interface FilmToolGroup {
  /** One line on what the group is for. */
  description: string
  /** Build one agent's copy of the group's tools. */
  tools(): ToolDefinition[]
  /** Whether a conversation in this workspace starts with the group. */
  startsEnabled?(cwd: string): Promise<boolean>
}

export interface FilmAgentToolset {
  /** Build one agent's copy of the tools every film conversation carries. */
  tools(): ToolDefinition[]
  /** Groups enabled on demand, by name. */
  groups?: Readonly<Record<string, FilmToolGroup>>
  /** What the agent is told about the film tools. */
  guidance: string
}

/** What the plugin can ask of the installer once it runs. */
export interface FilmToolInstaller {
  /** A workspace now has a film: its live agents get the tools before this returns. */
  projectCreated(cwd: string): void
  /**
   * Enable tool groups for one film conversation (from its next step).
   * @param agent - the conversation's agent.
   * @param names - the groups.
   * @returns the groups now enabled, or `undefined` when the agent carries no film tools.
   */
  enable(agent: Agent, names: readonly string[]): string[] | undefined
}

interface Installation {
  dispose(): void
  groups: Map<string, Array<() => unknown>>
}

const unwind = (disposers: Array<() => unknown>): void => {
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch {
      // Already unwound with the agent's scope.
    }
  }
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
 * @param toolset - the tools, their groups and their guidance.
 * @returns the installer's hooks.
 */
export function installFilmAgentTools(ctx: Context, toolset: FilmAgentToolset): FilmToolInstaller {
  const installed = new Map<Agent, Installation>()
  const installing = new Set<Agent>()
  const groups = toolset.groups ?? {}

  const install = (agent: Agent): Installation => {
    const scoped = agent.ctx
    const disposers: Array<() => unknown> = []
    const enabled = new Map<string, Array<() => unknown>>()
    try {
      for (const tool of toolset.tools()) disposers.push(scoped.tools.register(tool))
      const prompt = scoped.get('systemPrompt')
      if (prompt !== undefined) {
        disposers.push(prompt.section({
          name: GUIDANCE_SECTION, order: prompt.getSectionOrder('TOOL_COMPUTER_USE') + 60, text: toolset.guidance, interpolate: false,
        }))
      }
    } catch (error) {
      unwind(disposers)
      throw error
    }
    return {
      groups: enabled,
      dispose: () => {
        for (const group of enabled.values()) unwind(group)
        enabled.clear()
        unwind(disposers)
      },
    }
  }

  const enableGroup = (agent: Agent, installation: Installation, name: string): void => {
    const group = groups[name]
    if (group === undefined || installation.groups.has(name)) return
    const disposers: Array<() => unknown> = []
    try {
      for (const tool of group.tools()) disposers.push(agent.ctx.tools.register(tool))
    } catch (error) {
      unwind(disposers)
      throw error
    }
    installation.groups.set(name, disposers)
  }

  /** Install now, once; a live agent only — a disposed agent's scope takes no registrations. */
  const installNow = (agent: Agent, startGroups: readonly string[] = []): void => {
    if (installed.has(agent) || !ctx.agents.list().includes(agent)) return
    try {
      const installation = install(agent)
      installed.set(agent, installation)
      for (const name of startGroups) enableGroup(agent, installation, name)
    } catch (error) {
      // A failed install leaves the conversation without film tools; it must not fail the conversation.
      ctx.logger.warn(`dsh-film: could not give the film tools to agent ${agent.id}: ${String(error)}`)
    }
  }

  const startingGroups = async (cwd: string): Promise<string[]> => {
    const names: string[] = []
    for (const [name, group] of Object.entries(groups)) {
      if (await group.startsEnabled?.(cwd).catch(() => false) === true) names.push(name)
    }
    return names
  }

  const maybeInstall = async (agent: Agent): Promise<void> => {
    const cwd = agent.session.header.cwd
    if (cwd === undefined || cwd === '' || installed.has(agent) || installing.has(agent)) return
    installing.add(agent)
    try {
      if (await hasFilm(cwd)) installNow(agent, await startingGroups(cwd))
    } finally {
      installing.delete(agent)
    }
  }

  for (const agent of ctx.agents.list()) void maybeInstall(agent)
  // Awaited before the agent's first step, so a film conversation starts with its tools.
  ctx.on('agent/created', async ({ agent }) => { await maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.dispose()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const installation of installed.values()) installation.dispose()
    installed.clear()
  }, 'dsh-film: agent film tools')

  return {
    // The caller has just made the film: install at once, so the agent that made
    // it has the tools on its very next step.
    projectCreated: (cwd: string) => {
      for (const agent of ctx.agents.list()) {
        const workspace = agent.session.header.cwd
        if (workspace !== undefined && workspace !== '' && sameDirectory(workspace, cwd)) installNow(agent)
      }
    },
    enable: (agent, names) => {
      const installation = installed.get(agent)
      if (installation === undefined) return undefined
      for (const name of names) enableGroup(agent, installation, name)
      return [...installation.groups.keys()]
    },
  }
}
