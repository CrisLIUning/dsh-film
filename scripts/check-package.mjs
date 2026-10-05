#!/usr/bin/env node
/**
 * Pre-pack guard (run by `npm run prepack` after the build): refuse to pack a
 * package that would install but silently lack parts, or carry parts it no
 * longer ships.
 *
 * - The built app: without apps/canvas the package still loads, but the
 *   storyboard canvas and director desk tabs have nothing to show (src/apps.ts
 *   findApps returns []).
 * - apps/ holds the canvas and nothing else: the Host serves every
 *   apps/<dir> with an index.html (src/apps.ts findApps), and build-apps only
 *   replaces the app it builds, so a folder left from an earlier build (0.1's
 *   apps/editor) would ship and be routed.
 * - No top-level vendor/ or models/ (0.1's editor bridge and model lists).
 * - The licences and notices that must ship with bundled code, including the
 *   Apache License beside the director desk's glTF decoders when it has them;
 *   the canvas NOTICE lists files under every source it credits (no
 *   "(none yet)" placeholder).
 * - The canvas catalogues the agent's generation-option tools read
 *   (apps/canvas/catalog/*.json, spec C3: camera moves, camera settings,
 *   prompt skills, generation presets), each passing the very check the tools
 *   apply (checkCanvasCatalog, from the lib/ the build just wrote): without
 *   them the tools answer CANVAS_CATALOG_MISSING, and a file failing the
 *   check is refused whole (CANVAS_CATALOG_INVALID).
 * - No FFmpeg AAC encoder: this release does not ship @mediabunny/aac-encoder
 *   (LGPL-2.1; its FFmpeg build has no pinned source, so the licence's source
 *   offer cannot be met), so a canvas build that still bundles it, or carries
 *   its licence text, is refused.
 * - None of the app files scripts/app-excludes.mjs removes is present.
 * - lib/ holds only output of a current src/ file (tsc never deletes stale
 *   output; a removed module once nearly shipped), and the entry files
 *   package.json points at exist.
 * - No file in lib/ or client/ contains this checkout's absolute path or a
 *   home-directory path (a build that bakes in where it ran).
 * - Every app file name can be routed by the Host (others are skipped).
 *
 *   node scripts/check-package.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { excludedFiles } from './app-excludes.mjs'

const root = resolve(import.meta.dirname, '..')
const problems = []
const SEGMENT = /^[A-Za-z0-9_$.-]+$/

/** The one app the package ships. */
const APP = 'canvas'
const REBUILD_APPS = 'rebuild with `node scripts/build-apps.mjs canvas` (maintainers: needs the canvas and director desk checkouts)'
const REWRITE_NOTICES = 'write them with `node scripts/build-apps.mjs notices canvas`'

/** Files the package must carry, with what goes wrong without each and how to fix it. */
const REQUIRED = [
  ['apps/canvas/index.html', 'the storyboard canvas and director desk tabs would be empty', REBUILD_APPS],
  ['LICENSE', 'the package would ship without its own licence', 'restore it from git'],
  ['lib/director/vendor/director-math/LICENSE', 'the vendored director math would ship without its licence', 'run `npm run build`'],
  ['apps/canvas/LICENSE', 'the canvas would ship without its licence', REWRITE_NOTICES],
  ['apps/canvas/NOTICE', 'the canvas would ship without its attributions (the projects it is based on or adapts code from)', REWRITE_NOTICES],
  ['apps/canvas/THIRD-PARTY-NOTICES.txt', 'the canvas bundle would ship without its third-party notices', REWRITE_NOTICES],
  ['apps/canvas/director-desk/LICENSE', 'the director desk would ship without its licence', REWRITE_NOTICES],
  ['apps/canvas/director-desk/THIRD-PARTY-NOTICES.txt', 'the director desk would ship without its third-party notices', REBUILD_APPS],
]

/** The canvas catalogues the agent's tools read (canvas_generation_options, canvas_set_generation_options), with what each lists. */
const CATALOGUES = [
  ['camera-moves', 'camera moves (运镜)'],
  ['camera-control', 'camera settings (相机)'],
  ['vibedev-skills', 'prompt skills (提示词技能)'],
  ['generation-presets', 'generation presets (生成预设)'],
]
for (const [name, what] of CATALOGUES) {
  REQUIRED.push([`apps/canvas/catalog/${name}.json`, `the agent could not list or set ${what}`, REBUILD_APPS])
}

const fileAt = path => statSync(join(root, ...path.split('/')), { throwIfNoEntry: false })

// The director desk's optional glTF decoders (Draco is Apache-2.0) need the licence text beside them.
if (fileAt('apps/canvas/director-desk/decoders')?.isDirectory() === true) {
  REQUIRED.push(['apps/canvas/director-desk/licenses/Apache-2.0.txt', 'the director desk\'s Draco decoder would ship without the Apache License', REBUILD_APPS])
}

for (const [path, consequence, fix] of REQUIRED) {
  const info = fileAt(path)
  if (info?.isFile() !== true) problems.push(`${path} is missing: ${consequence}; ${fix}.`)
  else if (info.size === 0) problems.push(`${path} is empty: ${consequence}; ${fix}.`)
}

// A catalogue the tools cannot read is as good as missing. They check each file with checkCanvasCatalog and refuse the
// whole file on any problem, so each shipped file must pass that same check: it is loaded from the lib/ the build wrote.
let checkCanvasCatalog
try {
  ({ checkCanvasCatalog } = await import(pathToFileURL(join(root, 'lib', 'canvas', 'catalog.js')).href))
  if (typeof checkCanvasCatalog !== 'function') throw new Error('it exports no checkCanvasCatalog')
} catch (error) {
  checkCanvasCatalog = undefined
  problems.push(`lib/canvas/catalog.js cannot be loaded (${error?.code ?? error?.message ?? String(error)}), so the canvas catalogues cannot be checked as the agent's `
    + 'tools read them; run `npm run build`.')
}
for (const [name, what] of CATALOGUES) {
  const path = `apps/canvas/catalog/${name}.json`
  if (fileAt(path)?.isFile() !== true || fileAt(path).size === 0) continue
  let catalogue
  try {
    // As the tools read it: a byte-order mark is no problem.
    catalogue = JSON.parse(readFileSync(join(root, ...path.split('/')), 'utf8').replace(/^﻿/u, ''))
  } catch {
    problems.push(`${path} is not valid JSON: the agent could not list or set ${what}; ${REBUILD_APPS}.`)
    continue
  }
  if (catalogue?.schema !== 1 || typeof catalogue.catalogVersion !== 'string') {
    problems.push(`${path} is not a schema-1 catalogue (schema ${JSON.stringify(catalogue?.schema)}): the agent could not list or set ${what}; ${REBUILD_APPS}.`)
    continue
  }
  const found = checkCanvasCatalog?.(name, catalogue) ?? []
  if (found.length > 0) {
    problems.push(`${path} fails the check the agent's tools apply (${found.slice(0, 3).join('; ')}${found.length > 3 ? `; and ${found.length - 3} more` : ''}), so they would `
      + `refuse the whole file and the agent could not list or set ${what}; ${REBUILD_APPS}.`)
  }
}

// The canvas NOTICE credits a source as adapted only once files derived from it are listed: a "(none yet)"
// placeholder would ship a credit for code the package does not contain (e.g. a package cut before the
// borrowed files landed).
if (fileAt('apps/canvas/NOTICE')?.isFile() === true) {
  const notice = readFileSync(join(root, 'apps', 'canvas', 'NOTICE'), 'utf8')
  const placeholders = notice.split(/\r?\n/u).filter(line => line.trim() === '(none yet)').length
  if (placeholders > 0) {
    problems.push(`apps/canvas/NOTICE still has ${placeholders} "(none yet)" file list(s): it would credit a source as adapted with no file from it in the package; `
      + 'in the canvas repository list the derived files under that source, or delete the source\'s section if nothing from it ships, '
      + `then ${REWRITE_NOTICES}.`)
  }
}

// apps/ holds the canvas only: anything else there would ship, and a folder with an index.html would be served.
if (existsSync(join(root, 'apps'))) {
  const others = readdirSync(join(root, 'apps')).filter(name => name !== APP)
  if (others.length > 0) {
    problems.push(`apps/ holds ${others.map(name => `apps/${name}`).join(', ')} besides apps/${APP}: the package ships only the canvas, `
      + 'and the Host would serve a leftover app folder; delete it by hand (build-apps replaces only the app it builds).')
  }
}

// 0.1's editor bridge and model lists must not come back.
for (const folder of ['vendor', 'models']) {
  if (existsSync(join(root, folder))) problems.push(`${folder}/ exists at the top of the package: it belonged to an app 0.1 shipped and this version does not; delete it.`)
}

// Files the trim removes.
{
  const directory = join(root, 'apps', APP)
  const leftover = existsSync(directory) ? excludedFiles(APP, directory) : []
  if (leftover.length > 0) {
    problems.push(`apps/${APP} still holds ${leftover.length} file(s) dsh-film does not ship (scripts/app-excludes.mjs), e.g. ${leftover[0].path}; `
      + `remove them with \`node scripts/build-apps.mjs trim ${APP}\`.`)
  }
}

// The entry points package.json names.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const entries = new Set([manifest.main, manifest.types, manifest.icon, manifest.dsh?.bundle?.patch, 'client/client.workbench.js'])
for (const target of Object.values(manifest.exports ?? {})) {
  for (const path of typeof target === 'string' ? [target] : Object.values(target)) entries.add(path)
}
for (const entry of entries) {
  if (typeof entry !== 'string' || entry.includes('*')) continue
  const path = entry.replace(/^\.\//, '')
  if (fileAt(path)?.isFile() !== true) problems.push(`${path} (named by package.json) is missing; run \`npm run build\`.`)
}

function walk(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else files.push(path)
  }
  return files
}

const toPosix = path => path.split(sep).join('/')

// lib/ must be the output of the current src/: X.js and X.d.ts from X.ts or X.tsx, copied files as they are.
if (existsSync(join(root, 'lib'))) {
  const stale = []
  for (const file of walk(join(root, 'lib'))) {
    const path = toPosix(relative(join(root, 'lib'), file))
    const stem = path.replace(/(\.d)?\.(js|ts)(\.map)?$/u, '')
    const sources = stem === path ? [path] : [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`]
    if (!sources.some(source => fileAt(`src/${source}`)?.isFile() === true)) stale.push(`lib/${path}`)
  }
  if (stale.length > 0) {
    problems.push(`${stale.length} file(s) in lib/ have no source in src/ (stale build output), e.g. ${stale.slice(0, 5).join(', ')}; run \`npm run build\` (it cleans lib/ first).`)
  }
}

// Build output must not carry where it was built: this checkout's absolute path, or any home directory.
{
  const forms = [root, root.split(sep).join('/'), JSON.stringify(root).slice(1, -1)]
  const home = /[A-Za-z]:(\\\\?|\/)(Users|Documents and Settings)(\\\\?|\/)[^\\/\s"'`]+|\/(Users|home)\/[^/\s"'`]+\//u
  const leaks = []
  for (const directory of ['lib', 'client']) {
    if (!existsSync(join(root, directory))) continue
    for (const file of walk(join(root, directory))) {
      const text = readFileSync(file, 'utf8')
      const found = forms.find(form => text.includes(form)) ?? home.exec(text)?.[0]
      if (found !== undefined) leaks.push(`${toPosix(relative(root, file))} (${found})`)
    }
  }
  if (leaks.length > 0) problems.push(`${leaks.length} build file(s) contain an absolute path from the build machine, e.g. ${leaks[0]}; fix the build and run \`npm run build\`.`)
}

// The Host routes app files by exact path; a name it cannot carry is skipped.
{
  const directory = join(root, 'apps', APP)
  const unroutable = existsSync(directory)
    ? walk(directory).map(file => toPosix(relative(directory, file))).filter(path => !path.split('/').every(part => SEGMENT.test(part)))
    : []
  if (unroutable.length > 0) problems.push(`apps/${APP}: ${unroutable.length} file name(s) the Host cannot route, e.g. ${unroutable[0]}.`)
}

// No FFmpeg AAC encoder ships in this release (@mediabunny/aac-encoder, LGPL-2.1: its FFmpeg build has no pinned source, so the
// LGPL's source offer cannot be met; the canvas re-encodes sound with the browser's own AAC encoder). A canvas build that still
// bundles its chunk, or carries the licence text that came with it, would ship it anyway.
{
  const directory = join(root, 'apps', APP)
  const shipped = existsSync(directory)
    ? walk(directory).map(file => toPosix(relative(directory, file))).filter(path => /aac-encoder/iu.test(basename(path)) || path.toLowerCase() === 'licenses/ffmpeg-lgpl-2.1.txt')
    : []
  if (shipped.length > 0) {
    problems.push(`apps/${APP} ships the FFmpeg AAC encoder (${shipped.slice(0, 3).join(', ')}${shipped.length > 3 ? ', …' : ''}), which this release does not ship (its `
      + 'FFmpeg build has no pinned source, so the LGPL cannot be met): build the canvas from a checkout without @mediabunny/aac-encoder and rebuild apps/ with '
      + '`node scripts/build-apps.mjs canvas`.')
  }
}

if (problems.length > 0) {
  console.error(`\ncheck-package: refusing to pack dsh-film ${manifest.version} — ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

const count = directory => walk(join(root, directory)).length
console.log(`[check-package] dsh-film ${manifest.version}: ok — apps/${APP} ${count(`apps/${APP}`)} files, `
  + `lib ${count('lib')} files, client ${count('client')} files; licences and notices present`)
