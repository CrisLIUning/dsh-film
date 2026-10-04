#!/usr/bin/env node
/**
 * Build the original film apps for this plugin and place them under apps/.
 *
 * - canvas: the storyboard canvas with its 3D director desk overlay, from the
 *   vibedev-canvas checkout (DSH_FILM_CANVAS_SRC, default ../canvas, branch
 *   feat/dsh-host), built by its own web/scripts/build-dsh.mjs into
 *   web/dist-dsh. That script builds the director desk from ../director-desk
 *   (vibedev-director-desk, branch feat/dsh-procedural-mannequin).
 * - editor: the editing desk, from the vibedev-video-editor checkout
 *   (DSH_FILM_EDITOR_SRC, default ../video-editor), built by its
 *   `npm run build:dsh` into dist-dsh (the editor bundle and its host page).
 *   The same build's bridge contract — the timeline command engine the Host
 *   half runs — is copied to vendor/video-editor-bridge.mjs.
 *
 * Every file must be routable by the Host's API channel (path segments of
 * [A-Za-z0-9_$.-]); the build stops on one that is not.
 *
 * After copying an app, its licences and notices are written into its folder:
 * the source repository's licence files, and THIRD-PARTY-NOTICES.txt listing
 * every npm package the bundle can contain — the production closure (lockfile
 * entries not marked "dev") of the app's lockfiles, each with its version,
 * licence, repository and the text of its licence files from node_modules.
 * For the editor, vendor/video-editor-bridge.LICENSE.txt is written too. The
 * canvas's director-desk/THIRD-PARTY-NOTICES.txt and licenses/ come from the
 * desk's own build and are left as they are; the desk's licence is copied to
 * director-desk/LICENSE and its npm packages join the canvas's notices.
 *
 *   node scripts/build-apps.mjs [canvas] [editor]           build, copy, write notices
 *   node scripts/build-apps.mjs notices [canvas] [editor]   only the licences and notices,
 *                                                           for the apps already in apps/
 *
 * The notices step reads the checkouts' lockfiles and installed node_modules
 * (no network); run it from the checkouts the apps were built from.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const SEGMENT = /^[A-Za-z0-9_$.-]+$/

const APPS = {
  canvas: {
    repository: 'vibedev-canvas',
    source: resolve(process.env.DSH_FILM_CANVAS_SRC ?? join(root, '..', 'canvas')),
    build(source) {
      run('node', ['scripts/build-dsh.mjs'], join(source, 'web'))
      return join(source, 'web', 'dist-dsh')
    },
    about: [
      'apps/canvas is the storyboard canvas built from vibedev-canvas (licence:',
      'LICENSE in this folder), with the director desk in director-desk/ built from',
      'vibedev-director-desk (https://github.com/CrisLIUning/vibedev-director-desk;',
      'licence: director-desk/LICENSE).',
      '',
      'The desk\'s own build also writes director-desk/THIRD-PARTY-NOTICES.txt and',
      'director-desk/licenses/ (Mediabunny, MPL-2.0); the list below covers the',
      'desk\'s npm packages as well.',
    ],
    /** The source repositories' licence files, copied into the app folder. */
    licenses: source => [
      { from: join(source, 'LICENSE'), to: 'LICENSE' },
      { from: join(deskSource(source), 'LICENSE'), to: 'director-desk/LICENSE' },
    ],
    /**
     * The lockfiles whose production closure the bundle can draw from. web/
     * also holds a bun.lock; the build installs with npm (web/node_modules has
     * npm's .package-lock.json), so package-lock.json is the one that matches.
     */
    lockfiles: source => [
      { file: join(source, 'web', 'package-lock.json'), label: 'vibedev-canvas/web/package-lock.json', role: 'the canvas app' },
      {
        file: join(source, 'plugins', 'canvas', 'registry', 'package-lock.json'),
        label: 'vibedev-canvas/plugins/canvas/registry/package-lock.json',
        role: 'the canvas node plugins in plugins/',
      },
      { file: join(deskSource(source), 'package-lock.json'), label: 'vibedev-director-desk/package-lock.json', role: 'the director desk in director-desk/' },
    ],
    /** Folders of the app holding third-party files that are not npm packages. */
    vendored: [],
  },
  editor: {
    repository: 'vibedev-video-editor (https://github.com/CrisLIUning/vibedev-video-editor)',
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
    about: [
      'apps/editor is the editing desk built from vibedev-video-editor',
      '(https://github.com/CrisLIUning/vibedev-video-editor; licence: LICENSE in this',
      'folder), which embeds the editor it forks, ai-video-editor',
      '(https://github.com/MartinDelophy/ai-video-editor; licence:',
      'ai-video-editor/LICENSE).',
      '',
      'Those MIT licences cover the source code only. The models, fonts and sample',
      'media the editor uses or downloads keep their own terms: see',
      'ai-video-editor/MODEL_LICENSES.md. dsh-film downloads models only from the',
      'list in models/video-editor-models.json, after the person agrees.',
    ],
    licenses: source => [
      { from: join(source, 'LICENSE'), to: 'LICENSE' },
      { from: join(source, 'vendor', 'ai-video-editor', 'LICENSE'), to: 'ai-video-editor/LICENSE' },
      { from: join(source, 'vendor', 'ai-video-editor', 'MODEL_LICENSES.md'), to: 'ai-video-editor/MODEL_LICENSES.md' },
    ],
    lockfiles: source => [
      { file: join(source, 'package-lock.json'), label: 'vibedev-video-editor/package-lock.json', role: 'the host page and bridge' },
      {
        file: join(source, 'vendor', 'ai-video-editor', 'package-lock.json'),
        label: 'vibedev-video-editor/vendor/ai-video-editor/package-lock.json',
        role: 'the editor',
      },
    ],
    /** ai-video-editor's public/vendor, which Vite copies into the bundle unchanged. */
    vendored: ['vendor'],
    notices(source) {
      writeBridgeLicense(source)
    },
  },
}

/** The director desk checkout the canvas build uses (web/scripts/build-dsh.mjs: OD_DIRECTOR_SRC, else a sibling of the canvas checkout). */
function deskSource(canvasSource) {
  return resolve(process.env.OD_DIRECTOR_SRC ?? join(canvasSource, '..', 'director-desk'))
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

function walk(directory, skip = () => false) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!skip(entry.name)) files.push(...walk(path, skip))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}

// ---------------------------------------------------------------------------
// Licences and notices
// ---------------------------------------------------------------------------

const LICENCE_FILE = /^(licen[cs]e|copying|notice|third[-_]?party[-_]?notices?)([-._].*)?$/i
const RULE = '-'.repeat(80)
const BANNER = '='.repeat(80)

/** A text file as LF lines without a byte-order mark or trailing blank lines. */
function readText(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trimEnd()
}

function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${text.replace(/\r\n?/gu, '\n').trimEnd()}\n`)
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

/** The licence a package.json or lockfile entry declares, as one string. */
function declaredLicence(...sources) {
  for (const source of sources) {
    if (source === undefined) continue
    const { license, licenses } = source
    if (typeof license === 'string' && license.trim() !== '') return license.trim()
    if (license !== null && typeof license === 'object' && typeof license.type === 'string') return license.type
    if (Array.isArray(licenses) && licenses.length > 0) {
      const types = licenses.map(entry => (typeof entry === 'string' ? entry : entry?.type)).filter(type => typeof type === 'string')
      if (types.length > 0) return types.length === 1 ? types[0] : `(${types.join(' OR ')})`
    }
  }
  return undefined
}

/** A package.json `repository` (or `homepage`) as a browsable URL. */
function repositoryUrl(manifest) {
  const repository = manifest.repository
  let url = typeof repository === 'string' ? repository : typeof repository?.url === 'string' ? repository.url : undefined
  const directory = typeof repository === 'object' && typeof repository?.directory === 'string' ? repository.directory : undefined
  if (url === undefined || url.trim() === '') return typeof manifest.homepage === 'string' && manifest.homepage !== '' ? manifest.homepage : undefined
  url = url.trim()
  const shorthand = /^(github|gitlab|bitbucket):(.+)$/u.exec(url)
  if (shorthand !== null) url = `https://${shorthand[1] === 'bitbucket' ? 'bitbucket.org' : `${shorthand[1]}.com`}/${shorthand[2]}`
  else if (/^[\w.-]+\/[\w.-]+$/u.test(url)) url = `https://github.com/${url}`
  url = url
    .replace(/^git\+/u, '')
    .replace(/^git:\/\//u, 'https://')
    .replace(/^ssh:\/\/git@/u, 'https://')
    .replace(/^git@([^:]+):/u, 'https://$1/')
    .replace(/\.git(#.*)?$/u, '')
  return directory === undefined ? url : `${url} (directory ${directory})`
}

/**
 * The production closure of a lockfile: every installed-package entry not
 * marked "dev" (optional and devOptional entries included). Workspace folders
 * and links are the checkout's own code, covered by its licence.
 */
function productionEntries(lockfile) {
  const lock = JSON.parse(readFileSync(lockfile.file, 'utf8'))
  if (typeof lock.packages !== 'object' || lock.packages === null) {
    throw new Error(`${lockfile.label}: not an npm lockfile v2/v3 (no "packages")`)
  }
  const base = dirname(lockfile.file)
  if (!existsSync(join(base, 'node_modules'))) {
    throw new Error(`${lockfile.label}: no node_modules beside it — install the checkout (npm ci) before writing notices`)
  }
  const entries = []
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry.dev === true || entry.link === true) continue
    const at = key.lastIndexOf('node_modules/')
    if (at === -1) continue
    entries.push({
      name: typeof entry.name === 'string' ? entry.name : key.slice(at + 'node_modules/'.length),
      version: entry.version,
      license: entry.license,
      optional: entry.optional === true || entry.devOptional === true,
      directory: join(base, ...key.split('/')),
    })
  }
  return entries
}

/** Merge the closures of an app's lockfiles into one entry per name@version. */
function collectPackages(lockfiles) {
  const packages = new Map()
  const counts = []
  for (const lockfile of lockfiles) {
    if (!existsSync(lockfile.file)) throw new Error(`${lockfile.label}: not found`)
    const entries = productionEntries(lockfile)
    const own = new Set()
    for (const entry of entries) {
      const id = `${entry.name}@${entry.version}`
      own.add(id)
      const known = packages.get(id)
      if (known === undefined) packages.set(id, { ...entry, directories: [entry.directory] })
      else {
        known.directories.push(entry.directory)
        known.optional &&= entry.optional
      }
    }
    counts.push({ ...lockfile, count: own.size })
  }
  const list = []
  for (const item of packages.values()) {
    const directory = item.directories.find(path => existsSync(join(path, 'package.json')))
    if (directory === undefined) {
      // A missing optional package (a binary for another platform) cannot be in the bundle; a missing required one means the checkout is incomplete.
      if (!item.optional) throw new Error(`${item.name}@${item.version} is not installed in ${dirname(item.directories[0])} — install the checkout (npm ci) before writing notices`)
      list.push({ ...item, installed: false, licence: declaredLicence({ license: item.license }) })
      continue
    }
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const files = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && LICENCE_FILE.test(entry.name))
      .map(entry => entry.name)
      .sort()
    list.push({
      ...item,
      installed: true,
      directory,
      installedVersion: manifest.version,
      licence: declaredLicence({ license: item.license }, manifest),
      repository: repositoryUrl(manifest),
      files: files.map(name => ({ name, text: readText(join(directory, name)) })),
    })
  }
  list.sort((left, right) => (left.name === right.name ? compare(left.version, right.version) : compare(left.name, right.name)))
  return { packages: list, counts }
}

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

/** The first comment near the top of a script that states a licence or copyright. */
function licenceHeader(file) {
  if (!/\.(c|m)?js$/u.test(file)) return undefined
  const head = readFileSync(file, 'utf8').slice(0, 8192)
  for (const match of head.matchAll(/\/\*[\s\S]*?\*\//gu)) {
    if (/@license|copyright|licensed under/iu.test(match[0])) return match[0].replace(/\r\n?/gu, '\n')
  }
  return undefined
}

const TEXT_FILE = /\.(c|m)?js$|\.(css|json|txt|html)$/u

/** A file's content hash; text files are compared with LF line endings, as a Windows checkout may have converted them. */
function contentHash(file) {
  if (!TEXT_FILE.test(file)) return sha256(file)
  return createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n')).digest('hex')
}

/** Explain each vendored file: the npm package it is a copy of, its own licence header, or that it has neither. */
function describeVendored(appDirectory, folders, packages) {
  const files = folders.flatMap(folder => (existsSync(join(appDirectory, folder)) ? walk(join(appDirectory, folder)) : []))
  if (files.length === 0) return []
  const wanted = new Map()
  for (const file of files) wanted.set(basename(file), [...(wanted.get(basename(file)) ?? []), file])
  const copies = new Map()
  const namesakes = new Map()
  for (const item of packages.filter(entry => entry.installed)) {
    for (const candidate of walk(item.directory, name => name === 'node_modules')) {
      const pending = (wanted.get(basename(candidate)) ?? []).filter(file => !copies.has(file))
      if (pending.length === 0) continue
      const hash = contentHash(candidate)
      const where = `${item.name} ${item.version}, ${relative(item.directory, candidate).split(sep).join('/')}`
      for (const file of pending) {
        if (contentHash(file) !== hash) {
          if (!namesakes.has(file)) namesakes.set(file, { where, difference: firstDifference(file, candidate) })
          continue
        }
        copies.set(file, `${where}${sha256(file) === sha256(candidate) ? '' : ', apart from line endings'}`)
      }
    }
  }
  return files
    .map(file => ({ path: relative(appDirectory, file).split(sep).join('/'), file }))
    .sort((left, right) => compare(left.path, right.path))
    .map(({ path, file }) => {
      const copy = copies.get(file)
      if (copy !== undefined) return { path, text: `Same content as ${copy} (listed above).` }
      const lines = []
      const header = licenceHeader(file)
      if (header !== undefined) lines.push('Licence header in the file:', '', header)
      else lines.push('No licence header in the file and no licence file beside it in the source.')
      const namesake = namesakes.get(file)
      if (namesake !== undefined) {
        lines.push('', `Not an exact copy of an npm package file: ${namesake.where}`, `(listed above) has the same name, and ${namesake.difference}.`)
      } else if (header === undefined) {
        lines.push('Not a copy of a file in the npm packages above.')
      }
      return { path, text: lines.join('\n') }
    })
}

/** How two files with the same name differ, for the notice. */
function firstDifference(file, other) {
  if (!TEXT_FILE.test(file)) return 'the bytes differ'
  const left = readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n').split('\n')
  const right = readFileSync(other, 'utf8').replace(/\r\n?/gu, '\n').split('\n')
  const line = left.findIndex((text, index) => text !== right[index])
  const at = line === -1 ? Math.min(left.length, right.length) + 1 : line + 1
  return `the text first differs at line ${at} (${left.length} lines here, ${right.length} there)`
}

function packageEntry(item) {
  const lines = [RULE, `${item.name} ${item.version}`, `Licence: ${item.licence ?? 'not declared'}`, `Repository: ${item.repository ?? 'not declared'}`]
  if (item.installedVersion !== item.version) {
    lines.push(`Note: the lockfile pins ${item.version}; the installed copy, whose licence files follow, is ${item.installedVersion}.`)
  }
  lines.push('')
  if (item.files.length === 0) {
    lines.push(
      'No LICENSE, LICENCE, COPYING or NOTICE file in this package.',
      item.licence === undefined ? 'Its package.json declares no licence either.' : `Its package.json declares the licence ${item.licence}.`,
    )
  } else {
    for (const [index, file] of item.files.entries()) {
      if (index > 0) lines.push('')
      lines.push(`${file.name}:`, '', file.text)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function noticesText(name, app, appDirectory, { packages, counts }) {
  const installed = packages.filter(item => item.installed)
  const absent = packages.filter(item => !item.installed)
  const width = Math.max(...counts.map(lockfile => lockfile.label.length))
  const title = `Third-party notices for apps/${name} of dsh-film`
  const parts = [
    [
      title,
      '='.repeat(title.length),
      '',
      ...app.about,
      '',
      'The bundle in this folder can contain code from the npm packages listed below:',
      'the production dependency closure (every lockfile entry not marked "dev") of',
      ...counts.map(lockfile => `  ${lockfile.label.padEnd(width)}  ${String(lockfile.count).padStart(4)} package(s), ${lockfile.role}`),
      '',
      'The list is a superset of what the bundle holds: it also names packages that',
      'only build tools use or that nothing imports. Each entry gives the version,',
      'the licence the package declares, its repository and the text of its LICENSE,',
      'LICENCE, COPYING and NOTICE files as installed in the checkout the bundle was',
      'built from.',
      '',
      `${installed.length} package(s) below${absent.length > 0 ? `; ${absent.length} more listed at the end were not installed` : ''}.`,
      `Generated by \`node scripts/build-apps.mjs notices ${name}\`; do not edit by hand.`,
      '',
    ].join('\n'),
    ...installed.map(packageEntry),
  ]
  if (absent.length > 0) {
    parts.push([
      BANNER,
      'Not installed in the build checkout',
      BANNER,
      '',
      'These entries of the closure were not installed where the bundle was built',
      '(optional packages for other platforms), so the bundle holds none of their code:',
      '',
      ...absent.map(item => `  ${item.name} ${item.version} (${item.licence ?? 'licence not declared'})`),
      '',
    ].join('\n'))
  }
  const vendored = describeVendored(appDirectory, app.vendored, packages)
  if (vendored.length > 0) {
    parts.push([
      BANNER,
      'Third-party files that are not npm packages',
      BANNER,
      '',
      `Copied unchanged from the source's public folder into ${app.vendored.map(folder => `${folder}/`).join(', ')}:`,
      '',
      ...vendored.flatMap(entry => [RULE, entry.path, '', entry.text, '']),
    ].join('\n'))
  }
  return parts.join('\n')
}

function copyLicences(name, app, appDirectory) {
  for (const { from, to } of app.licenses(app.source)) {
    if (!existsSync(from)) throw new Error(`${name}: licence file ${from} not found`)
    writeText(join(appDirectory, ...to.split('/')), readText(from))
    console.log(`[notices] ${name}: ${relative(app.source, from).split(sep).join('/')} → apps/${name}/${to}`)
  }
}

/**
 * vendor/video-editor-bridge.mjs holds code from vibedev-video-editor and from
 * the ai-video-editor sources it embeds; both licences ship beside it.
 */
function writeBridgeLicense(source) {
  const bridge = join(root, 'vendor', 'video-editor-bridge.mjs')
  if (/^\s*import\s/mu.test(readFileSync(bridge, 'utf8'))) {
    throw new Error('editor: vendor/video-editor-bridge.mjs imports other modules; list their licences before shipping it')
  }
  const own = join(source, 'LICENSE')
  const upstream = join(source, 'vendor', 'ai-video-editor', 'LICENSE')
  for (const file of [own, upstream]) if (!existsSync(file)) throw new Error(`editor: licence file ${file} not found`)
  writeText(join(root, 'vendor', 'video-editor-bridge.LICENSE.txt'), [
    'vendor/video-editor-bridge.mjs is the bridge contract of vibedev-video-editor',
    '(https://github.com/CrisLIUning/vibedev-video-editor, packages/video-editor-bridge),',
    'bundled with no npm packages inside. It contains code from the editor that',
    'project embeds, ai-video-editor (https://github.com/MartinDelophy/ai-video-editor).',
    'Both are released under the MIT License.',
    '',
    `Generated by \`node scripts/build-apps.mjs notices editor\`; do not edit by hand.`,
    '',
    RULE,
    'vibedev-video-editor — LICENSE',
    RULE,
    '',
    readText(own),
    '',
    RULE,
    'ai-video-editor — LICENSE',
    RULE,
    '',
    readText(upstream),
  ].join('\n'))
  console.log('[notices] editor: licences of the bridge contract → vendor/video-editor-bridge.LICENSE.txt')
}

function writeNotices(name, app) {
  const appDirectory = join(root, 'apps', name)
  if (!existsSync(join(appDirectory, 'index.html'))) throw new Error(`${name}: apps/${name} is not built (no index.html)`)
  if (!existsSync(app.source)) throw new Error(`${name}: no checkout at ${app.source}`)
  copyLicences(name, app, appDirectory)
  const collected = collectPackages(app.lockfiles(app.source))
  writeText(join(appDirectory, 'THIRD-PARTY-NOTICES.txt'), noticesText(name, app, appDirectory, collected))
  const withoutFile = collected.packages.filter(item => item.installed && item.files.length === 0).length
  const absent = collected.packages.filter(item => !item.installed).length
  console.log(`[notices] ${name}: apps/${name}/THIRD-PARTY-NOTICES.txt — ${collected.packages.length - absent} packages `
    + `(${withoutFile} without a licence file), ${absent} not installed`)
  app.notices?.(app.source)
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const noticesOnly = args[0] === 'notices'
const wanted = noticesOnly ? args.slice(1) : args
const unknown = wanted.filter(name => !Object.hasOwn(APPS, name))
if (unknown.length > 0) throw new Error(`unknown app(s): ${unknown.join(', ')} (known: ${Object.keys(APPS).join(', ')})`)

for (const [name, app] of Object.entries(APPS)) {
  if (wanted.length > 0 && !wanted.includes(name)) continue
  if (noticesOnly) {
    writeNotices(name, app)
    continue
  }
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
  writeNotices(name, app)
}
