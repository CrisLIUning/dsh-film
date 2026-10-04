/**
 * Which dsh-film this Host process runs, and which one is installed now.
 *
 * DeepSeek Harness installs a new version over the old one in place and asks
 * for a restart: the Host keeps running the code it loaded at start, the
 * entry bundle the browser gets is the one snapshotted at start, but the
 * lazily loaded workbench chunk is read from disk on its first request. A
 * workbench page therefore asks `GET /api/dsh-film/runtime` and shows a
 * restart banner when the answers disagree with each other or with the
 * version it was built as (see src/client/workbench/runtime-notice.ts).
 * @module dsh-film/runtime
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

/** The package.json beside the loaded lib/. */
export const PACKAGE_JSON = new URL('../package.json', import.meta.url)

const versionIn = (text: string): string => {
  const value = (JSON.parse(text) as { version?: unknown } | null)?.version
  if (typeof value !== 'string' || value === '') throw new SyntaxError('package.json has no version.')
  return value
}

/** The version this Host process loaded, read once when the module loads. */
export const LOADED_VERSION: string = versionIn(readFileSync(PACKAGE_JSON, 'utf8'))

/** The package version (the one this process runs). */
export const version: string = LOADED_VERSION

/**
 * The version installed now: the package.json beside the loaded lib/, read at call time.
 * @param url - the package.json to read.
 * @returns its version, or `null` when the file is gone or does not parse.
 */
export async function installedVersion(url: URL = PACKAGE_JSON): Promise<string | null> {
  let text: string
  try {
    text = await readFile(url, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    return versionIn(text)
  } catch {
    return null
  }
}

/** What `GET /api/dsh-film/runtime` answers. */
export interface RuntimeAnswer {
  /** The version this Host process loaded. */
  version: string
  /** The version in the package.json beside the loaded lib, read now; `null` when it is gone or unreadable. */
  installed: string | null
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
})

/**
 * The route that tells a workbench page which version runs and which is installed.
 * It takes no workspace: the answer is the same for every window.
 * @param options - the loaded version and the package.json to read (tests inject both).
 * @returns the route.
 */
export function runtimeRoute(options: { loaded?: string; packageJson?: URL } = {}): ConnectionFetchRoute {
  const loaded = options.loaded ?? LOADED_VERSION
  const packageJson = options.packageJson ?? PACKAGE_JSON
  return {
    path: '/api/dsh-film/runtime',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        const answer: RuntimeAnswer = { version: loaded, installed: await installedVersion(packageJson) }
        return json(200, answer)
      } catch (error) {
        return json(500, { error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } })
      }
    },
  }
}
