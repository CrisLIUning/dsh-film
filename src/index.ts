/**
 * dsh-film: a film workbench for DeepSeek Harness and VibeDev. Four tabs in
 * the chat's right sidebar — script, storyboard, editing and director desks —
 * work on one film per workspace, kept as files under `film/`.
 *
 * This Host half serves the workbench: the project file, the workspace's
 * media listing and byte-range media playback. The routes exist only while a
 * client connection service runs (the desktop app or the web client).
 *
 * ```yaml
 * - insert:
 *     - id: dsh-film
 *       name: dsh-film
 * ```
 * @module dsh-film
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import Schema from '@deepseek-ai/schemastery'
import { appRoutes, findApps, scanApp } from './apps.js'
import { FilmMediaTasks } from './media/tasks.js'
import type { MediaServiceLike } from './media/tasks.js'
import type { AttachmentsLike, DefaultModelLike, LlmLike } from './canvas/text-models.js'
import { createStudioRouter, filmRoutes } from './routes.js'
import { EditorModels, defaultModelsRoot } from './models/service.js'
import { modelFileRoutes } from './studio/model-routes.js'

export { FilmError } from './errors.js'
export type { FilmErrorCode } from './errors.js'
export type { AspectRatio, FilmProject } from './project.js'
export type { MediaAsset, MediaKind } from './media.js'

/** The package version. */
export const version: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

export const name = 'dsh-film'

export interface Config {
  /** Where the built apps are; empty for the package's own `apps/`. For developing an app against a live Host. */
  appsDir: string
  /** Where the editing desk's AI models are kept; empty for `$DSH_HOME/cache/dsh-film/video-editor-models`. */
  modelsDir: string
}

export const Config: Schema<Config> = Schema.object({
  appsDir: Schema.string().default(''),
  modelsDir: Schema.string().default(''),
})

/** The package's built apps. */
const PACKAGED_APPS = fileURLToPath(new URL('../apps/', import.meta.url))

/**
 * Register the workbench routes and the hosted apps' files while a client
 * connection service is running.
 * @param ctx - the plugin context.
 * @param config - the plugin settings.
 */
export function apply(ctx: Context, config: Config): void {
  // Nested, so a profile without clients (a terminal-only run) still loads the plugin.
  ctx.inject(['connection'], (scoped) => {
    // Generation goes through dsh-media's service, read at each request: it can come and go.
    const media = (): MediaServiceLike | undefined => scoped.get('vibedevMedia') as MediaServiceLike | undefined
    const tasks = new FilmMediaTasks(media)
    scoped.effect(() => () => { tasks.dispose() }, 'dsh-film: media tasks')
    // Text-node answers and the prompt writer use the model the person uses in DSH.
    const text = () => ({
      llm: scoped.get('llm') as LlmLike | undefined,
      defaults: scoped.get('agentDefaultModel') as DefaultModelLike | undefined,
      attachments: scoped.get('attachments') as AttachmentsLike | undefined,
    })
    // The editing desk's AI models: downloaded only after the person agrees, kept once per machine.
    const models = new EditorModels({ root: config.modelsDir.trim() === '' ? defaultModelsRoot() : resolve(config.modelsDir.trim()) })
    scoped.effect(() => () => { models.dispose() }, 'dsh-film: editor models')
    const routes = filmRoutes(createStudioRouter({ media, tasks, text, models }))
    routes.push(...modelFileRoutes(models))
    for (const { app, directory } of findApps(config.appsDir.trim() === '' ? PACKAGED_APPS : config.appsDir.trim())) {
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
}
