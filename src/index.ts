/**
 * dsh-film: a film workbench for DeepSeek Harness and VibeDev. Three tabs in
 * the chat's right sidebar — 剧本 (screenplays), 分镜 (the storyboard canvas)
 * and 导演 (the director desk) — work on one film per workspace, kept as files
 * under `film/`.
 *
 * This Host half serves the workbench: the project file, byte-range media
 * playback, the Studio-compatible API the hosted canvas and desk call, and
 * the hosted apps' files. The routes exist only while a client connection
 * service runs (the desktop app or the web client). It also gives the agent
 * its film tools — `film_project` everywhere, and the screenplay, storyboard
 * and film task tools in conversations whose workspace is a film — through
 * the same API the workbench's pages call — and its skills (the screenwriting
 * skill) wherever DSH's skill registry runs.
 *
 * ```yaml
 * - insert:
 *     - id: dsh-film
 *       name: dsh-film
 * ```
 * @module dsh-film
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import Schema from '@deepseek-ai/schemastery'
import { appRoutes, findApps, scanApp } from './apps.js'
import { FilmMediaTasks } from './media/tasks.js'
import type { MediaServiceLike } from './media/tasks.js'
import type { AttachmentsLike, DefaultModelLike, LlmLike } from './canvas/text-models.js'
import { CanvasBoardAgent } from './canvas/board-agent.js'
import { createStudioRouter, filmRoutes } from './routes.js'
import { ProjectEvents } from './studio/events.js'
import { applyFilmAgentTools } from './agent/index.js'
import { registerFilmSkills } from './skills.js'

export { FilmError } from './errors.js'
export type { FilmErrorCode } from './errors.js'
export type { AspectRatio, FilmProject, StoredAspectRatio } from './project.js'
export type { MediaAsset, MediaKind } from './media.js'
export { FilmToolError, filmAgentTools } from './agent/index.js'

/** The package version (the one this Host process loaded). */
export { version } from './runtime.js'

export const name = 'dsh-film'

export interface Config {
  /** Where the built apps are; empty for the package's own `apps/`. For developing an app against a live Host. */
  appsDir: string
  /** Computer-wide shared assets. Empty/undefined uses ~/.vibedev/film/assets. */
  sharedAssetsDir?: string
}

/**
 * The settings. 0.1 had two more, for the cut tools it shipped then; a
 * profile that still holds them loads, since the object schema leaves
 * unknown keys alone instead of refusing them.
 */
export const Config: Schema<Config> = Schema.object({
  appsDir: Schema.string().default(''),
  sharedAssetsDir: Schema.string(),
})

/** The package's built apps. */
const PACKAGED_APPS = fileURLToPath(new URL('../apps/', import.meta.url))

/**
 * Register the workbench routes and the hosted apps' files while a client
 * connection service is running, and the agent's film tools while agents run.
 * @param ctx - the plugin context.
 * @param config - the plugin settings.
 */
export function apply(ctx: Context, config: Config): void {
  // Generation goes through dsh-media's service, read at each request: it can come and go.
  const media = (): MediaServiceLike | undefined => ctx.get('vibedevMedia') as MediaServiceLike | undefined
  const tasks = new FilmMediaTasks(media)
  ctx.effect(() => () => { tasks.dispose() }, 'dsh-film: media tasks')
  // Text-node answers and the prompt writer use the model the person uses in DSH.
  const text = () => ({
    llm: ctx.get('llm') as LlmLike | undefined,
    defaults: ctx.get('agentDefaultModel') as DefaultModelLike | undefined,
    attachments: ctx.get('attachments') as AttachmentsLike | undefined,
  })
  // One API for the pages and the agent: the agent's edits reach open pages as the pages' own do.
  const events = new ProjectEvents()
  const boardAgent = new CanvasBoardAgent()
  const appsRoot = config.appsDir.trim() === '' ? PACKAGED_APPS : config.appsDir.trim()
  const studio = createStudioRouter({ media, tasks, text, events, boardAgent, sharedAssetsDir: config.sharedAssetsDir })
  let projectCreated: (cwd: string) => void = () => {}

  // Nested, so a profile without clients (a terminal-only run) still loads the plugin.
  ctx.inject(['connection'], (scoped) => {
    const routes = filmRoutes(studio, (cwd) => { projectCreated(cwd) }, events)
    for (const { app, directory } of findApps(appsRoot)) {
      const { files, skipped } = scanApp(app, directory)
      if (skipped.length > 0) {
        scoped.logger.warn(`dsh-film: ${skipped.length} file(s) of the ${app} app have names the Host cannot route and are not served, e.g. ${skipped[0]}`)
      }
      routes.push(...appRoutes(files))
    }
    for (const route of routes) {
      scoped.effect(() => scoped.connection.fetch.register(route), `dsh-film: ${route.path}`)
    }
  })

  // Nested too: a profile without agents (a bare Host) has nobody to give tools to.
  ctx.inject(['agents', 'tools'], (scoped) => {
    // The catalogues come with the canvas build the workbench serves (C3).
    const install = applyFilmAgentTools(scoped, { studio, boardAgent, events, catalogRoot: join(appsRoot, 'canvas', 'catalog') })
    projectCreated = install
    scoped.effect(() => () => {
      if (projectCreated === install) projectCreated = () => {}
    }, 'dsh-film: project hook')
  })

  // Nested as well: a profile without the skill registry still loads the plugin.
  ctx.inject(['skills'], (scoped) => { registerFilmSkills(scoped) })
}
