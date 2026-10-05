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
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '..')
const scripts = join(repo, 'scripts')
const CATALOGUES = ['camera-moves', 'camera-control', 'vibedev-skills', 'generation-presets']
let scratch: string

/** A module of src/ as the build writes it into lib/: an ES module with its types stripped. */
function builtModule(source: string): string {
  return ts.transpileModule(readFileSync(join(repo, 'src', source), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
}

/** One of the canvas's catalogues, as the canvas ships it (the test fixture is a byte copy). */
const catalogue = (name: string): string => readFileSync(join(repo, 'tests', 'fixtures', 'catalog', `${name}.json`), 'utf8')

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
    // The catalogues are checked with the agent tools' own checkCanvasCatalog, from lib/ (its source beside it in src/).
    for (const module of ['canvas/catalog', 'screenwriter/contracts/production']) {
      if (!leaveOut.includes(`package/lib/${module}.js`)) put(`package/lib/${module}.js`, builtModule(`${module}.ts`))
      put(`package/src/${module}.ts`)
    }
    for (const name of CATALOGUES) {
      const file = `package/apps/canvas/catalog/${name}.json`
      if (!leaveOut.includes(file)) put(file, catalogue(name))
    }
    put('package/package.json', JSON.stringify({ name: 'dsh-film', version: '0.0.0-test', type: 'module' }))
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
    put('package/apps/canvas/NOTICE', 'tigerowo/infinite-canvas\n\nPortions adapted from tigerowo/infinite-canvas. Files:\n\n  (none yet)\n\n'
      + 'Another source\n\nPortions adapted from another source. Files:\n\n  (none yet)\n')
    const result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas/NOTICE still has 2 "(none yet)" file list(s)')
  })

  it('passes a NOTICE whose credited sources all list files, and a design reference acknowledged without a list', () => {
    packageWith()
    put('package/apps/canvas/NOTICE', 'tigerowo/infinite-canvas\n\nPortions adapted from tigerowo/infinite-canvas. Files:\n\n  web/src/a.ts (abc1234)\n\n'
      + 'Open AI Canvas\n\nNo code from Open AI Canvas is included; only its interaction design served as a reference.\n')
    expect(runScript('check-package.mjs').status).toBe(0)
  })

  it('refuses a package without the canvas catalogues the agent\'s generation-option tools read', () => {
    packageWith(CATALOGUES.map(name => `package/apps/canvas/catalog/${name}.json`))
    const result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas/catalog/camera-moves.json is missing: the agent could not list or set camera moves (运镜)')
    expect(result.output).toContain('apps/canvas/catalog/camera-control.json is missing: the agent could not list or set camera settings (相机)')
    expect(result.output).toContain('apps/canvas/catalog/vibedev-skills.json is missing: the agent could not list or set prompt skills (提示词技能)')
    expect(result.output).toContain('apps/canvas/catalog/generation-presets.json is missing: the agent could not list or set generation presets (生成预设)')
    expect(result.output).toContain('node scripts/build-apps.mjs canvas')
  })

  it('refuses a catalogue that is not JSON of schema 1', () => {
    packageWith()
    put('package/apps/canvas/catalog/camera-moves.json', '{"schema":1,')
    put('package/apps/canvas/catalog/camera-control.json', JSON.stringify({ schema: 2, catalogVersion: '2027-01-01.1' }))
    put('package/apps/canvas/catalog/vibedev-skills.json', JSON.stringify({ skills: [] }))
    const result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas/catalog/camera-moves.json is not valid JSON')
    expect(result.output).toContain('apps/canvas/catalog/camera-control.json is not a schema-1 catalogue (schema 2)')
    expect(result.output).toContain('apps/canvas/catalog/vibedev-skills.json is not a schema-1 catalogue (schema undefined)')
  })

  it('refuses a schema-1 catalogue the agent\'s tools would still refuse whole, by their own check', () => {
    packageWith()
    const presets = JSON.parse(catalogue('generation-presets'))
    presets.presets[0].mode = 'audio'
    put('package/apps/canvas/catalog/generation-presets.json', JSON.stringify(presets))
    put('package/apps/canvas/catalog/camera-moves.json', JSON.stringify({ ...JSON.parse(catalogue('camera-moves')), catalogVersion: 'v2' }))
    const result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas/catalog/generation-presets.json fails the check the agent\'s tools apply (preset p.vertical-drama mode must be image or video), '
      + 'so they would refuse the whole file and the agent could not list or set generation presets (生成预设)')
    expect(result.output).toContain('apps/canvas/catalog/camera-moves.json fails the check the agent\'s tools apply (catalogVersion must look like YYYY-MM-DD.n)')
    expect(result.output).not.toContain('camera-control.json')
  })

  it('reads a catalogue with a byte-order mark as the tools do, and refuses to check without the built lib/', () => {
    packageWith()
    put('package/apps/canvas/catalog/camera-control.json', `﻿${catalogue('camera-control')}`)
    expect(runScript('check-package.mjs').status).toBe(0)
    rmSync(join(scratch, 'package', 'lib', 'canvas'), { recursive: true, force: true })
    const result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('lib/canvas/catalog.js cannot be loaded')
    expect(result.output).toContain('run `npm run build`')
  })

  it('refuses a canvas build that still bundles the FFmpeg AAC encoder, or carries its LGPL text', () => {
    packageWith()
    put('package/apps/canvas/assets/mediabunny-aac-encoder-BmtnuXQb.js', 'export {}\n')
    let result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas ships the FFmpeg AAC encoder (assets/mediabunny-aac-encoder-BmtnuXQb.js), which this release does not ship')
    expect(result.output).toContain('without @mediabunny/aac-encoder')
    rmSync(join(scratch, 'package', 'apps', 'canvas', 'assets'), { recursive: true, force: true })
    put('package/apps/canvas/licenses/FFmpeg-LGPL-2.1.txt', 'GNU LESSER GENERAL PUBLIC LICENSE\n')
    result = runScript('check-package.mjs')
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/canvas ships the FFmpeg AAC encoder (licenses/FFmpeg-LGPL-2.1.txt)')
    // Other licences beside the app are fine.
    rmSync(join(scratch, 'package', 'apps', 'canvas', 'licenses', 'FFmpeg-LGPL-2.1.txt'))
    put('package/apps/canvas/licenses/MPL-2.0.txt', 'Mozilla Public License\n')
    expect(runScript('check-package.mjs').status).toBe(0)
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
    if (withNotice) put('canvas/NOTICE', 'Infinite Canvas\n\nNo code from Open AI Canvas is included; only its interaction design served as a reference.\nPortions adapted from tigerowo/infinite-canvas\n\n')
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
    expect(readFileSync(join(app, 'NOTICE'), 'utf8')).toBe('Infinite Canvas\n\nNo code from Open AI Canvas is included; only its interaction design served as a reference.\nPortions adapted from tigerowo/infinite-canvas\n')
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
