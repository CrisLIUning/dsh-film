/**
 * What the procedural-model panel is told about its environment, in Studio's
 * `ModelEnvironment` shape (apps/daemon/src/services/models/model-environment.ts).
 *
 * This workbench does not run models yet — running, photographing and
 * exporting one needs a headless browser and a bundler it does not drive — so
 * the browser is always reported as not found, which the panel turns into
 * "cannot run or export models for now". Python is looked for as Studio does
 * (the img2threejs forge needs 3.10+), plus plain `python` on Windows, where
 * the versioned names do not exist. Discovery only: never a claim that a
 * model passed anything. Cached for a minute.
 * @module dsh-film/modeling/environment
 */

import { execFile } from 'node:child_process'
import type { ModelEnvironment } from './contracts/model-project.js'

const CANDIDATES = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', ...(process.platform === 'win32' ? ['python'] : [])]

/** The interpreter's `major.minor` when it is 3.10 or newer. */
function versionOf(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(command, ['-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], { encoding: 'utf8', timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error !== null) return resolve(null)
        const version = String(stdout ?? '').trim()
        const [major, minor] = version.split('.').map(Number)
        resolve((major ?? 0) > 3 || (major === 3 && (minor ?? 0) >= 10) ? version : null)
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * The first Python 3.10+ found: `DSH_FILM_PYTHON` when set, then the usual names on PATH.
 * @param env - the environment.
 * @returns the command and version, or `null`.
 */
export async function findPython(env: NodeJS.ProcessEnv = process.env): Promise<{ command: string; version: string } | null> {
  const configured = env.DSH_FILM_PYTHON?.trim()
  for (const command of configured ? [configured, ...CANDIDATES] : CANDIDATES) {
    const version = await versionOf(command)
    if (version !== null) return { command, version }
  }
  return null
}

let cached: { key: string; until: number; value: ModelEnvironment } | null = null

/**
 * The model environment, cached for a minute per PATH and setting.
 * @returns the environment.
 */
export async function modelEnvironment(): Promise<ModelEnvironment> {
  const key = [process.env.DSH_FILM_PYTHON, process.env.PATH].join('\n')
  if (cached !== null && cached.key === key && cached.until > Date.now()) return cached.value
  const python = await findPython()
  const value: ModelEnvironment = {
    browser: { found: false },
    python: python !== null ? { found: true, command: python.command, version: python.version } : { found: false },
  }
  cached = { key, until: Date.now() + 60_000, value }
  return value
}
