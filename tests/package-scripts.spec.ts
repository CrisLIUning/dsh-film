/**
 * The packaging scripts' handling of the canvas's NOTICE: build-apps copies it
 * beside the canvas LICENSE, and check-package refuses a package without it.
 * Each script runs as it does for a maintainer, from a copy placed in a
 * scratch package (they work relative to their own folder).
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const scripts = resolve(import.meta.dirname, '..', 'scripts')
let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-film-package-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function put(path: string, text = 'x\n'): void {
  const file = join(scratch, ...path.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function copyScript(name: string): void {
  mkdirSync(join(scratch, 'package', 'scripts'), { recursive: true })
  copyFileSync(join(scripts, name), join(scratch, 'package', 'scripts', name))
}

function runScript(name: string, args: string[] = [], env: Record<string, string> = {}): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [join('scripts', name), ...args], {
    cwd: join(scratch, 'package'),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('check-package', () => {
  /** A package with everything check-package asks for, except what `leaveOut` names. */
  function packageWith(leaveOut: readonly string[] = []): void {
    copyScript('check-package.mjs')
    copyScript('app-excludes.mjs')
    const files = [
      'package/LICENSE',
      'package/client/client.workbench.js',
      'package/lib/director/vendor/director-math/LICENSE',
      'package/src/director/vendor/director-math/LICENSE',
      'package/apps/canvas/index.html',
      'package/apps/canvas/LICENSE',
      'package/apps/canvas/NOTICE',
      'package/apps/canvas/THIRD-PARTY-NOTICES.txt',
      'package/apps/canvas/director-desk/LICENSE',
      'package/apps/canvas/director-desk/THIRD-PARTY-NOTICES.txt',
    ]
    for (const file of files) if (!leaveOut.includes(file)) put(file)
    put('package/package.json', JSON.stringify({ name: 'dsh-film', version: '0.0.0-test' }))
  }

  it('passes a package that carries the canvas NOTICE', () => {
    packageWith()
    const result = runScript('check-package.mjs')
    expect(result.output).toContain('ok')
    expect(result.status).toBe(0)
  })

  it('refuses a package without apps/canvas/NOTICE', () => {
    packageWith(['package/apps/canvas/NOTICE'])
    const result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas/NOTICE is missing')
    expect(result.output).toContain('Open AI Canvas, tigerowo')
    expect(result.output).toContain('node scripts/build-apps.mjs notices canvas')
  })

  it('refuses an empty apps/canvas/NOTICE', () => {
    packageWith()
    put('package/apps/canvas/NOTICE', '')
    const result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas/NOTICE is empty')
  })
})

describe('build-apps notices', () => {
  /** A built apps/canvas plus installed canvas and director desk checkouts with empty production closures. */
  function checkouts(withNotice: boolean): Record<string, string> {
    copyScript('build-apps.mjs')
    copyScript('app-excludes.mjs')
    put('package/apps/canvas/index.html', '<!doctype html>\n')
    const lockfile = JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' } } })
    put('canvas/LICENSE', 'MIT License\r\n\r\nCopyright (c) 2026 basketikun\r\n')
    if (withNotice) put('canvas/NOTICE', 'Infinite Canvas\n\nPortions adapted from Open AI Canvas (MIT)\nPortions adapted from tigerowo/infinite-canvas\n\n')
    put('canvas/web/package-lock.json', lockfile)
    mkdirSync(join(scratch, 'canvas', 'web', 'node_modules'), { recursive: true })
    put('canvas/plugins/canvas/registry/package-lock.json', lockfile)
    mkdirSync(join(scratch, 'canvas', 'plugins', 'canvas', 'registry', 'node_modules'), { recursive: true })
    put('director-desk/LICENSE', 'MIT License\n\nCopyright (c) 2026 YZ\n')
    put('director-desk/package-lock.json', lockfile)
    mkdirSync(join(scratch, 'director-desk', 'node_modules'), { recursive: true })
    return { DSH_FILM_CANVAS_SRC: join(scratch, 'canvas'), OD_DIRECTOR_SRC: join(scratch, 'director-desk') }
  }

  it('copies the canvas NOTICE beside its LICENSE and names it in the third-party notices', () => {
    const result = runScript('build-apps.mjs', ['notices', 'canvas'], checkouts(true))
    expect(result.output).toContain('NOTICE → apps/canvas/NOTICE')
    expect(result.status).toBe(0)
    const app = join(scratch, 'package', 'apps', 'canvas')
    expect(readFileSync(join(app, 'NOTICE'), 'utf8')).toBe('Infinite Canvas\n\nPortions adapted from Open AI Canvas (MIT)\nPortions adapted from tigerowo/infinite-canvas\n')
    expect(readFileSync(join(app, 'LICENSE'), 'utf8')).toBe('MIT License\n\nCopyright (c) 2026 basketikun\n')
    const notices = readFileSync(join(app, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
    expect(notices).toContain('Infinite Canvas by basketikun (MIT)')
    expect(notices).toContain('Open AI Canvas (MIT, Copyright (c) 2026 ddcat and Open\nAI Canvas contributors)')
    expect(notices).toContain('tigerowo/infinite-canvas (author TIGERQWQ,')
    expect(notices).toContain('NOTICE in this folder')
  })

  it('stops when the canvas checkout has no NOTICE', () => {
    const result = runScript('build-apps.mjs', ['notices', 'canvas'], checkouts(false))
    expect(result.status).not.toBe(0)
    expect(result.output).toMatch(/licence file .*NOTICE not found/u)
  })
})
