/**
 * The packaging scripts' handling of the canvas's NOTICE: build-apps copies it
 * beside the canvas LICENSE, and check-package refuses a package without it
 * (or without the canvas catalogues the agent's tools read).
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
    for (const name of ['camera-moves', 'camera-control']) {
      const file = `package/apps/canvas/catalog/${name}.json`
      if (!leaveOut.includes(file)) put(file, JSON.stringify({ schema: 1, catalogVersion: '2026-10-05.1' }))
    }
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
    expect(result.output).toContain('the projects it is based on or adapts code from')
    expect(result.output).toContain('node scripts/build-apps.mjs notices canvas')
  })

  it('refuses an empty apps/canvas/NOTICE', () => {
    packageWith()
    put('package/apps/canvas/NOTICE', '')
    const result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas/NOTICE is empty')
  })

  it('refuses a NOTICE that still credits a source with no files ("(none yet)")', () => {
    packageWith()
    put('package/apps/canvas/NOTICE', 'Open AI Canvas\n\nPortions adapted from Open AI Canvas. Files:\n\n  (none yet)\n\ntigerowo\n\nFiles:\n\n  (none yet)\n')
    const result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas/NOTICE still has 2 "(none yet)" file list(s)')
  })

  it('passes a NOTICE whose credited sources all list files', () => {
    packageWith()
    put('package/apps/canvas/NOTICE', 'Open AI Canvas\n\nPortions adapted from Open AI Canvas. Files:\n\n  web/src/a.ts (abc1234)\n')
    expect(runScript('check-package.mjs').status).toBe(0)
  })

  it('refuses a package without the canvas catalogues the agent\'s generation-option tools read', () => {
    packageWith(['package/apps/canvas/catalog/camera-moves.json', 'package/apps/canvas/catalog/camera-control.json'])
    const result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas/catalog/camera-moves.json is missing: the agent could not list or set camera moves (运镜)')
    expect(result.output).toContain('apps/canvas/catalog/camera-control.json is missing: the agent could not list or set camera settings (相机)')
    expect(result.output).toContain('node scripts/build-apps.mjs canvas')
  })

  it('refuses a catalogue that is not JSON of schema 1', () => {
    packageWith()
    put('package/apps/canvas/catalog/camera-moves.json', '{"schema":1,')
    put('package/apps/canvas/catalog/camera-control.json', JSON.stringify({ schema: 2, catalogVersion: '2027-01-01.1' }))
    const result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas/catalog/camera-moves.json is not valid JSON')
    expect(result.output).toContain('apps/canvas/catalog/camera-control.json is not a schema-1 catalogue (schema 2)')
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
    expect(notices).toContain('NOTICE in this\nfolder')
    expect(notices).toContain('is based on or adapts code from')
    // The about text names no adapted source as present: whether one is, is NOTICE's to say.
    expect(notices).not.toContain('Open AI Canvas')
    expect(notices).not.toContain('tigerowo')
  })

  it('stops when the canvas checkout has no NOTICE', () => {
    const result = runScript('build-apps.mjs', ['notices', 'canvas'], checkouts(false))
    expect(result.status).not.toBe(0)
    expect(result.output).toMatch(/licence file .*NOTICE not found/u)
  })
})
