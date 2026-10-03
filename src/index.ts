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
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import Schema from '@deepseek-ai/schemastery'
import { filmRoutes } from './routes.js'

export { FilmError } from './errors.js'
export type { FilmErrorCode } from './errors.js'
export type { AspectRatio, FilmProject } from './project.js'
export type { MediaAsset, MediaKind } from './media.js'

/** The package version. */
export const version: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

export const name = 'dsh-film'

/** No settings yet. */
export interface Config {}

export const Config: Schema<Config> = Schema.object({})

/**
 * Register the workbench routes while a client connection service is running.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  // Nested, so a profile without clients (a terminal-only run) still loads the plugin.
  ctx.inject(['connection'], (scoped) => {
    for (const route of filmRoutes()) {
      scoped.effect(() => scoped.connection.fetch.register(route), `dsh-film: ${route.path}`)
    }
  })
}
