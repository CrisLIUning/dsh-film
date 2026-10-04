#!/usr/bin/env node
/**
 * Build the original film apps for this plugin and place them under apps/.
 *
 * - canvas: the storyboard canvas with its 3D director desk overlay, from the
 *   vibedev-canvas checkout (DSH_FILM_CANVAS_SRC, default ../canvas), built by
 *   its own web/scripts/build-dsh.mjs into web/dist-dsh.
 * - editor: the editing desk, from the vibedev-video-editor checkout
 *   (DSH_FILM_EDITOR_SRC, default ../video-editor), built by its
 *   `npm run build:dsh` into dist-dsh (the editor bundle and its host page).
 *   The same build's bridge contract — the timeline command engine the Host
 *   half runs — is copied to vendor/video-editor-bridge.mjs.
 *
 * Every file must be routable by the Host's API channel (path segments of
 * [A-Za-z0-9_$.-]); the build stops on one that is not.
 *
 *   node scripts/build-apps.mjs [canvas] [editor]
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const SEGMENT = /^[A-Za-z0-9_$.-]+$/

const APPS = {
  canvas: {
    source: resolve(process.env.DSH_FILM_CANVAS_SRC ?? join(root, '..', 'canvas')),
    build(source) {
      run('node', ['scripts/build-dsh.mjs'], join(source, 'web'))
      return join(source, 'web', 'dist-dsh')
    },
  },
  editor: {
    source: resolve(process.env.DSH_FILM_EDITOR_SRC ?? join(root, '..', 'video-editor')),
    build(source) {
      run('npm', ['run', 'build:dsh'], source)
      const bridge = join(source, 'packages', 'video-editor-bridge')
      run('node', ['./esbuild.config.mjs'], bridge)
      cpSync(join(bridge, 'dist', 'index.mjs'), join(root, 'vendor', 'video-editor-bridge.mjs'))
      assertBridgeExports(join(root, 'vendor', 'video-editor-bridge.mjs'))
      console.log('[apps] editor: bridge contract → vendor/video-editor-bridge.mjs')
      return join(source, 'dist-dsh')
    },
  },
}

/** What the Host half imports from the bridge (vendor/video-editor-bridge.d.mts): a build without one would fail at load. */
const BRIDGE_EXPORTS = ['executeVideoEditorCommandPlan', 'buildNativeTimelineFfmpegPlan', 'getNativeTimelineFfmpegMediaRequirements', 'isTimelineArchive']

function assertBridgeExports(file) {
  const text = readFileSync(file, 'utf8')
  const exported = /export\s*\{([^}]*)\}\s*;?\s*$/u.exec(text)?.[1] ?? ''
  const names = new Set(exported.split(',').map(entry => entry.trim().split(/\s+as\s+/u).pop()))
  const missing = BRIDGE_EXPORTS.filter(name => !names.has(name))
  if (missing.length > 0) throw new Error(`editor: the bridge build no longer exports ${missing.join(', ')}`)
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}`)
}

function walk(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

const wanted = process.argv.slice(2)
for (const [name, app] of Object.entries(APPS)) {
  if (wanted.length > 0 && !wanted.includes(name)) continue
  if (!existsSync(app.source)) throw new Error(`${name}: no checkout at ${app.source}`)
  const output = app.build(app.source)
  const files = walk(output)
  const unroutable = files.map(file => relative(output, file).split(sep)).filter(parts => !parts.every(part => SEGMENT.test(part)))
  if (unroutable.length > 0) throw new Error(`${name}: ${unroutable.length} file(s) the Host cannot route, e.g. ${unroutable[0].join('/')}`)
  if (!existsSync(join(output, 'index.html'))) throw new Error(`${name}: the build has no index.html`)
  const target = join(root, 'apps', name)
  rmSync(target, { recursive: true, force: true })
  cpSync(output, target, { recursive: true })
  const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0)
  console.log(`[apps] ${name}: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB → apps/${name}`)
}
