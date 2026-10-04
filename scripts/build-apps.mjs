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
 * After copying, the files listed in scripts/app-excludes.mjs (pages and
 * chunks nothing dsh-film serves opens, such as the director desk's smoke
 * tests) are removed; the step stops if a remaining file still names one.
 *
 * Then the app's licences and notices are written into its folder: the source
 * repository's licence files, and THIRD-PARTY-NOTICES.txt listing every npm
 * package the bundle can contain — the production closure (lockfile entries
 * not marked "dev") of the app's lockfiles, each with its version, licence,
 * repository and the text of its licence files from node_modules. For the
 * editor, licenses/ gets the licence texts its packages do not ship themselves
 * (kept in third-party/, see third-party/README.md) and the libav.js build
 * record, the notices open with the components that carry further terms
 * (FFmpeg under the LGPL, Mediabunny under the MPL, ONNX Runtime, MediaPipe,
 * OpenCV), ai-video-editor/MODEL_LICENSES.md gets links that resolve in the
 * package, and vendor/video-editor-bridge.LICENSE.txt is written. The canvas's
 * director-desk/THIRD-PARTY-NOTICES.txt and licenses/ come from the desk's own
 * build and are left as they are; the desk's licence is copied to
 * director-desk/LICENSE and its npm packages join the canvas's notices.
 *
 *   node scripts/build-apps.mjs [canvas] [editor]           build, copy, trim, write notices
 *   node scripts/build-apps.mjs notices [canvas] [editor]   only the licences and notices,
 *                                                           for the apps already in apps/
 *   node scripts/build-apps.mjs trim [canvas] [editor]      only remove the excluded files
 *                                                           from the apps already in apps/
 *
 * The notices step reads the checkouts' lockfiles and installed node_modules
 * (no network); run it from the checkouts the apps were built from. It warns
 * when a checkout is not at the commit an app's component-build.json records.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { APP_EXCLUDES, excludedFiles, leftOutRule } from './app-excludes.mjs'

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
    /** The build receipts in the app and the checkouts they should match. */
    receipts: source => [
      { file: 'component-build.json', checkout: source },
      { file: 'director-desk/component-build.json', checkout: deskSource(source) },
    ],
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
      { from: libavBuildRecord(source), to: LIBAV_BUILD_RECORD },
      ...EDITOR_LICENCE_TEXTS.map(({ file, to }) => ({ from: join(root, 'third-party', file), to })),
      { from: installedLicence(source, 'mediabunny'), to: MEDIABUNNY_LICENCE },
      // Last: its links are checked against the files copied above.
      {
        from: join(source, 'vendor', 'ai-video-editor', 'MODEL_LICENSES.md'),
        to: 'ai-video-editor/MODEL_LICENSES.md',
        transform: (text, context) => rewriteModelNoticeLinks(text, source, context),
      },
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
    /** Written only by the notices step (the editor build has no licenses/), so it is cleared first. */
    noticeFolders: ['licenses'],
    /** vibedev-video-editor's build:dsh writes no component-build.json yet; the check says so. */
    receipts: source => [{ file: 'component-build.json', checkout: source }],
    preface: context => editorPreface(context),
    supplement: item => editorSupplement(item),
    vendoredNote: path => editorVendoredNote(path),
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
      integrity: entry.integrity,
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

/**
 * Explain each vendored file: the npm package it is a copy of, its own licence
 * header, or that it has neither; then the app's own note on it, if any.
 */
function describeVendored(appDirectory, folders, packages, note = () => undefined) {
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
      const lines = []
      const copy = copies.get(file)
      if (copy !== undefined) lines.push(`Same content as ${copy} (listed above).`)
      else {
        const header = licenceHeader(file)
        if (header !== undefined) lines.push('Licence header in the file:', '', header)
        else lines.push('No licence header in the file and no licence file beside it in the source.')
        const namesake = namesakes.get(file)
        if (namesake !== undefined) {
          lines.push('', `Not an exact copy of an npm package file: ${namesake.where}`, `(listed above) has the same name, and ${namesake.difference}.`)
        } else if (header === undefined) {
          lines.push('Not a copy of a file in the npm packages above.')
        }
      }
      const extra = note(path)
      if (extra !== undefined) lines.push('', ...extra)
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

/**
 * One package of the list. `extra` is the app's supplement for it: a licence
 * line that corrects what the package declares, and notes (where the licence
 * text the package lacks is, or which section above covers it).
 */
function packageEntry(item, extra = {}) {
  const lines = [RULE, `${item.name} ${item.version}`, `Licence: ${extra.licence ?? item.licence ?? 'not declared'}`, `Repository: ${item.repository ?? 'not declared'}`]
  if (item.installedVersion !== item.version) {
    lines.push(`Note: the lockfile pins ${item.version}; the installed copy, whose licence files follow, is ${item.installedVersion}.`)
  }
  lines.push('')
  if (extra.lines !== undefined) lines.push(...extra.lines, '')
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
  // Packages the VibeDev build leaves out on purpose are named apart, never as shipped code.
  const leftOut = packages.filter(item => leftOutRule(name, item.name) !== undefined)
  const installed = packages.filter(item => item.installed && leftOutRule(name, item.name) === undefined)
  const absent = packages.filter(item => !item.installed && leftOutRule(name, item.name) === undefined)
  const width = Math.max(...counts.map(lockfile => lockfile.label.length))
  const title = `Third-party notices for apps/${name} of dsh-film`
  const preface = app.preface?.({ name, appDirectory, packages, source: app.source }) ?? []
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
      `${installed.length} package(s) below${absent.length > 0 ? `; ${absent.length} more listed at the end were not installed` : ''}`
        + `${leftOut.length > 0 ? `; ${leftOut.length} more listed at the end are left out of this build` : ''}.`,
      ...(preface.length > 0
        ? ['Before the list come the components whose terms need more than a licence text,', 'and the licence texts in licenses/ that their packages do not ship.']
        : []),
      `Generated by \`node scripts/build-apps.mjs notices ${name}\`; do not edit by hand.`,
      '',
    ].join('\n'),
    ...preface,
    ...(preface.length > 0 ? [[BANNER, 'npm packages', BANNER, ''].join('\n')] : []),
    ...installed.map(item => packageEntry(item, app.supplement?.(item))),
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
  if (leftOut.length > 0) {
    parts.push([
      BANNER,
      'Left out of this build',
      BANNER,
      '',
      'These entries of the closure belong to features the VibeDev build turns off;',
      'their imports are unreachable, the bundler drops them, and the build and',
      'dsh-film\'s package check refuse a bundle that carries their code:',
      '',
      ...leftOut.map(item => `  ${item.name} ${item.version} (${item.licence ?? 'licence not declared'}): ${leftOutRule(name, item.name).why}`),
      '',
    ].join('\n'))
  }
  const vendored = describeVendored(appDirectory, app.vendored, packages, app.vendoredNote)
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

const toPosix = path => path.split(sep).join('/')

/** A path for the log: relative to the checkout or to this repository, whichever it is in. */
function shortPath(file, source) {
  const inSource = relative(source, file)
  return toPosix(inSource.startsWith('..') ? relative(root, file) : inSource)
}

function copyLicences(name, app, appDirectory) {
  const copies = app.licenses(app.source)
  const context = { appDirectory, targets: new Set(copies.map(copy => copy.to)) }
  for (const { from, to, transform } of copies) {
    if (!existsSync(from)) throw new Error(`${name}: licence file ${from} not found`)
    const text = readText(from)
    writeText(join(appDirectory, ...to.split('/')), transform === undefined ? text : transform(text, context))
    console.log(`[notices] ${name}: ${shortPath(from, app.source)} → apps/${name}/${to}`)
  }
}

/**
 * Warn — not stop — when a checkout is not at the commit an app's
 * component-build.json records, or has uncommitted changes: the notices are
 * read from the checkout's lockfiles and licence files, which then may not be
 * the ones the bundle was built from.
 */
function checkReceipts(name, app, appDirectory) {
  for (const { file, checkout } of app.receipts?.(app.source) ?? []) {
    const receipt = join(appDirectory, ...file.split('/'))
    const where = `apps/${name}/${file}`
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: checkout, encoding: 'utf8' })
    if (status.status === 0 && status.stdout.trim() !== '') {
      const changed = status.stdout.trim().split('\n').length
      console.warn(`[notices] warning: ${name}: ${checkout} has ${changed} uncommitted change(s); the notices read the working tree, `
        + `which may not be what apps/${name} was built from`)
    }
    if (!existsSync(receipt)) {
      console.warn(`[notices] ${name}: no ${where}; cannot check that ${checkout} is at the commit the app was built from`)
      continue
    }
    const recorded = JSON.parse(readFileSync(receipt, 'utf8'))?.source?.gitCommit
    const head = gitHead(checkout)
    if (head === undefined || typeof recorded !== 'string') {
      console.warn(`[notices] warning: ${name}: cannot compare ${where} (${recorded ?? 'no source.gitCommit'}) with the HEAD of ${checkout}`)
      continue
    }
    if (head !== recorded) {
      console.warn(`[notices] warning: ${name}: ${where} records commit ${recorded}, but ${checkout} is at ${head}; `
        + 'the notices describe the checkout, which may not be what the bundle was built from')
    }
  }
}

/** A checkout's HEAD commit, or undefined. */
function gitHead(checkout) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' })
  return head.status === 0 ? head.stdout.trim() : undefined
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

// ---------------------------------------------------------------------------
// Editor: the terms its packages do not carry themselves
// ---------------------------------------------------------------------------

/** Where the libav.js build record is copied in apps/editor. */
const LIBAV_BUILD_RECORD = 'licenses/libav-timeline-compat-BUILD.md'
const MEDIABUNNY_LICENCE = 'licenses/mediabunny-MPL-2.0.txt'

/**
 * The onnxruntime release whose ThirdPartyNotices.txt third-party/ holds: it
 * must be the newest onnxruntime-web of the editor's closure.
 */
const ONNXRUNTIME_NOTICES = '1.27.0'

/** Licence texts kept in third-party/ (sources: third-party/README.md), copied to apps/editor. */
const EDITOR_LICENCE_TEXTS = [
  { file: 'LGPL-2.1.txt', to: 'licenses/LGPL-2.1.txt', what: 'GNU Lesser General Public License 2.1 (FFmpeg, libav.js)' },
  { file: 'Apache-2.0.txt', to: 'licenses/Apache-2.0.txt', what: 'Apache License 2.0 (MediaPipe, TensorFlow.js, OpenCV 4.5 and later)' },
  { file: 'onnxruntime-LICENSE.txt', to: 'licenses/onnxruntime-LICENSE.txt', what: 'ONNX Runtime\'s licence: MIT, Copyright (c) Microsoft Corporation' },
  {
    file: `onnxruntime-ThirdPartyNotices-v${ONNXRUNTIME_NOTICES}.txt`,
    to: `licenses/onnxruntime-ThirdPartyNotices-v${ONNXRUNTIME_NOTICES}.txt`,
    what: `ONNX Runtime ${ONNXRUNTIME_NOTICES}'s third-party notices`,
  },
  {
    file: 'onnxruntime-ThirdPartyNotices-older-versions.txt',
    to: 'licenses/onnxruntime-ThirdPartyNotices-older-versions.txt',
    what: `notices of older ONNX Runtime versions for components ${ONNXRUNTIME_NOTICES} no longer lists`,
  },
  { file: 'mediapipe-v1.0.0-LICENSE.txt', to: 'licenses/mediapipe-LICENSE.txt', what: 'MediaPipe\'s LICENSE at tag v1.0.0 (Apache-2.0 and its third-party notices)' },
  { file: 'opencv-4.4.0-LICENSE.txt', to: 'licenses/opencv-BSD-3-Clause.txt', what: 'OpenCV 4.4.0\'s licence: 3-clause BSD, for OpenCV before 4.5' },
  { file: 'opencv-4.5.5-COPYRIGHT.txt', to: 'licenses/opencv-COPYRIGHT.txt', what: 'the copyright holders of OpenCV 4.5.5 (Apache-2.0)' },
]

/** The record of how ai-video-editor's custom libav.js build was made. */
function libavBuildRecord(source) {
  return join(source, 'vendor', 'ai-video-editor', 'src', 'vendor', 'libav-timeline-compat', 'BUILD.md')
}

/** The licence file an npm package of the editor has installed. */
function installedLicence(source, name) {
  const directory = join(source, 'vendor', 'ai-video-editor', 'node_modules', ...name.split('/'))
  const file = existsSync(directory) ? readdirSync(directory).filter(entry => LICENCE_FILE.test(entry)).sort()[0] : undefined
  if (file === undefined) throw new Error(`editor: ${name} has no licence file in ${directory} — install the checkout (npm ci)`)
  return join(directory, file)
}

/** What BUILD.md records of the libav.js build; it stops when the record no longer has a field. */
function readLibavBuild(source) {
  const text = readText(libavBuildRecord(source))
  const field = label => {
    const match = new RegExp(`^- ${label}: \`?([^\`\\n]+?)\`?\\s*$`, 'mu').exec(text)
    if (match === null) throw new Error(`editor: ${LIBAV_BUILD_RECORD} source has no "- ${label}:" line; update scripts/build-apps.mjs`)
    return match[1].trim()
  }
  const build = { libav: field('libav\\.js'), commit: field('upstream commit'), ffmpeg: field('FFmpeg'), emscripten: field('Emscripten') }
  if (!/^[0-9a-f]{40}$/u.test(build.commit)) throw new Error(`editor: BUILD.md records libav.js commit "${build.commit}", not a full commit id`)
  const config = /```json\n([\s\S]*?)\n```/u.exec(text)?.[1]
  if (config === undefined) throw new Error('editor: BUILD.md has no ```json configuration block; update scripts/build-apps.mjs')
  // libav.js's own notice, from the loader source (the bundle drops plain comments).
  const loader = join(dirname(libavBuildRecord(source)), `libav-${build.libav}-timeline-compat.wasm.mjs`)
  const code = existsSync(loader) ? readText(loader) : ''
  const at = code.search(/\n \* Copyright[^\n]*Yahweasel\n/u)
  const start = at === -1 ? -1 : code.lastIndexOf('/*', at)
  const end = at === -1 ? -1 : code.indexOf('*/', at)
  const comment = start === -1 || end === -1 ? undefined : code.slice(start, end + 2)
  const glue = comment?.split('\n').map(line => line.replace(/^\s*\/?\*+\/?\s?/u, '').trimEnd()).filter((line, index, lines) => line !== '' || (index > 0 && index < lines.length - 1))
  return { ...build, config: JSON.parse(config), glue }
}

const npmTarball = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`

/** Compare release versions (prereleases before their release), enough for the onnxruntime versions here. */
function compareVersions(left, right) {
  const parse = version => {
    const [release, prerelease] = version.split(/-(.*)/su)
    return { parts: release.split('.').map(Number), prerelease }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if ((a.parts[index] ?? 0) !== (b.parts[index] ?? 0)) return (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/** The version OpenCV's build information compiled into opencv.js states, if it can be read. */
function opencvVersion(file) {
  const blob = /data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/u.exec(readFileSync(file, 'latin1'))?.[1]
  if (blob === undefined) return undefined
  return /General configuration for OpenCV (\d+\.\d+\.\d+)/u.exec(Buffer.from(blob, 'base64').toString('latin1'))?.[1]
}

/** The first copyright line in the first 4 KB of a package's entry script. */
function packageCopyright(item) {
  const manifest = JSON.parse(readFileSync(join(item.directory, 'package.json'), 'utf8'))
  for (const entry of [manifest.module, manifest.main]) {
    if (typeof entry !== 'string' || !existsSync(join(item.directory, entry))) continue
    const line = /Copyright \(c\)[^\n*]*/u.exec(readFileSync(join(item.directory, entry), 'utf8').slice(0, 4096))?.[0]
    if (line !== undefined) return line.trim().replace(/\.$/u, '')
  }
  return undefined
}

const MODEL_MIRROR = 'https://huggingface.co/haixin/timeline-studio-onnx-models/blob'

/**
 * MODEL_LICENSES.md is written for the ai-video-editor source tree; in the
 * package it sits at apps/editor/ai-video-editor/. Each relative link is
 * pointed at what the package ships (the libav.js build record; files Vite
 * copied from public/), or, for files the package does not hold, at a
 * version-pinned public copy: the face-swap configuration in ai-video-editor
 * at the snapshot commit vibedev-video-editor vendors, and the MI-GAN and
 * NanoVSR notices in the model repository at the revision dsh-film downloads
 * (models/video-editor-models.json). Any other file of the vendored snapshot
 * that git tracks (such as the fork's own src/config/vibedevFeatures.js) is
 * linked in vibedev-video-editor at the checkout's HEAD — with a warning when
 * that commit is on no remote branch yet (the link resolves once it is
 * pushed) or the file has uncommitted changes. A relative link to anything
 * else stops the step, so a new link is never shipped broken.
 */
function rewriteModelNoticeLinks(text, source, { appDirectory, targets }) {
  const snapshot = JSON.parse(readFileSync(join(source, 'vendor', 'ai-video-editor.manifest.json'), 'utf8')).commit
  if (!/^[0-9a-f]{40}$/u.test(snapshot ?? '')) throw new Error('editor: vendor/ai-video-editor.manifest.json records no snapshot commit')
  const models = JSON.parse(readFileSync(join(root, 'models', 'video-editor-models.json'), 'utf8')).models
  const revision = id => {
    const model = models.find(entry => entry.id === id)
    if (model === undefined) throw new Error(`editor: models/video-editor-models.json has no ${id}, whose notice MODEL_LICENSES.md links to`)
    return model.revision
  }
  const pinned = {
    'src/vendor/libav-timeline-compat/BUILD.md': `../${LIBAV_BUILD_RECORD}`,
    'src/config/faceSwap.js': `https://github.com/MartinDelophy/ai-video-editor/blob/${snapshot}/src/config/faceSwap.js`,
    'public/models/migan-webgpu/README.md': `${MODEL_MIRROR}/${revision('migan-256-webgpu')}/migan-webgpu/README.md`,
    'public/models/migan-webgpu/LICENSE': `${MODEL_MIRROR}/${revision('migan-256-webgpu')}/migan-webgpu/LICENSE`,
    'public/models/nanovsr-644k/README.md': `${MODEL_MIRROR}/${revision('nanovsr-644k')}/nanovsr-644k/README.md`,
    'public/models/nanovsr-644k/LICENSE': `${MODEL_MIRROR}/${revision('nanovsr-644k')}/nanovsr-644k/LICENSE`,
  }
  const ships = path => targets.has(path) || existsSync(join(appDirectory, ...path.split('/')))
  /** The file in vibedev-video-editor at the checkout's HEAD, if git tracks it there. */
  const forkFile = path => {
    const file = `vendor/ai-video-editor/${path}`
    const head = gitHead(source)
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd: source, encoding: 'utf8' })
    if (head === undefined || tracked.status !== 0) return undefined
    const pushed = spawnSync('git', ['branch', '-r', '--contains', head], { cwd: source, encoding: 'utf8' })
    if (pushed.status !== 0 || pushed.stdout.trim() === '') {
      console.warn(`[notices] warning: editor: MODEL_LICENSES.md links ${path} at vibedev-video-editor ${head}, which is on no remote branch yet; push it before publishing`)
    }
    const changed = spawnSync('git', ['status', '--porcelain', '--', file], { cwd: source, encoding: 'utf8' })
    if (changed.status === 0 && changed.stdout.trim() !== '') {
      console.warn(`[notices] warning: editor: ${file} has uncommitted changes; MODEL_LICENSES.md links its committed version at ${head}`)
    }
    return `https://github.com/CrisLIUning/vibedev-video-editor/blob/${head}/${file}`
  }
  let rewritten = 0
  const body = text.replace(/\]\(([^)\s]+)\)/gu, (match, target) => {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('#')) return match
    const [path, anchor] = target.split(/(?=#)/u)
    let link
    if (ships(`ai-video-editor/${path}`)) link = path
    else if (pinned[path] !== undefined) link = pinned[path]
    else if (path.startsWith('public/') && ships(path.slice('public/'.length))) link = `../${path.slice('public/'.length)}`
    else link = forkFile(path)
    if (link === undefined) {
      throw new Error(`editor: MODEL_LICENSES.md links to ${path}, which neither apps/editor nor vibedev-video-editor's git holds; add where it is to rewriteModelNoticeLinks in scripts/build-apps.mjs`)
    }
    if (link !== path) rewritten += 1
    return `](${link}${anchor ?? ''})`
  })
  console.log(`[notices] editor: MODEL_LICENSES.md — ${rewritten} link(s) pointed at the package or at pinned public copies`)
  return [
    '> In dsh-film this file is `apps/editor/ai-video-editor/MODEL_LICENSES.md`. Links that pointed into the',
    '> ai-video-editor source tree now lead to the copies in this package or to version-pinned public copies',
    '> (`scripts/build-apps.mjs` of dsh-film). dsh-film downloads only the models listed in its',
    '> `models/video-editor-models.json`, after the person agrees.',
    '',
    body,
  ].join('\n')
}

/** The sections that open the editor's notices: licence texts in licenses/, then the components with further terms. */
function editorPreface({ appDirectory, packages, source }) {
  const files = walk(appDirectory).map(file => toPosix(relative(appDirectory, file)))
  const find = pattern => files.filter(path => pattern.test(path))
  const located = (paths, what) => {
    if (paths.length === 0) console.warn(`[notices] warning: editor: ${what} not found in apps/editor; its section names no file`)
    return paths.length === 0 ? ['(not found in this build)'] : paths
  }
  const versions = name => packages.filter(item => item.name === name && item.installed)
  const only = name => {
    const found = versions(name)
    if (found.length !== 1) throw new Error(`editor: expected one ${name} in the closure, found ${found.length}; update the editor's notices in scripts/build-apps.mjs`)
    return found[0]
  }
  const wrap = (text, indent = '') => {
    const lines = []
    let line = ''
    for (const word of text.split(/\s+/u).filter(Boolean)) {
      if (line !== '' && indent.length + line.length + 1 + word.length > 80) {
        lines.push(indent + line)
        line = word
      } else line = line === '' ? word : `${line} ${word}`
    }
    if (line !== '') lines.push(indent + line)
    return lines
  }
  const section = (title, ...lines) => [BANNER, title, BANNER, '', ...lines, ''].join('\n')

  // Licence texts.
  const texts = [
    ...EDITOR_LICENCE_TEXTS.map(({ to, what }) => ({ to, what })),
    { to: MEDIABUNNY_LICENCE, what: 'Mozilla Public License 2.0, as installed with mediabunny' },
    { to: LIBAV_BUILD_RECORD, what: 'how the custom libav.js build was made (from the editor\'s source)' },
  ]
  const licences = section(
    'Licence texts in licenses/',
    ...wrap('The notices step copies these into licenses/: the packages or files they belong to do not ship them, or their terms want them beside the binaries. Where each came from: third-party/README.md in the dsh-film repository (https://github.com/CrisLIUning/dsh-film/tree/main/third-party).'),
    '',
    ...texts.flatMap(({ to, what }) => [`  ${to}`, ...wrap(what, '      ')]),
  )
  /** A file of the bundle and what it holds, the description wrapped under it. */
  const fileLine = (path, what) => [`     ${path}`, ...wrap(what, '         ')]
  /** "name v1, v2 and name2 v3" for packages of several versions. */
  const byName = items => {
    const names = new Map()
    for (const item of items) names.set(item.name, [...(names.get(item.name) ?? []), item.version])
    const list = [...names].map(([name, list]) => `${name} ${[...new Set(list)].sort(compareVersions).join(', ')}`)
    return list.length > 1 ? `${list.slice(0, -1).join('; ')} and ${list.at(-1)}` : list.join('')
  }

  // FFmpeg under the LGPL.
  const libav = readLibavBuild(source)
  const aac = only('@mediabunny/aac-encoder')
  const frontend = versions('@libav.js/variant-webcodecs')
  const libavFiles = located(find(new RegExp(`^assets/libav-${libav.libav.replace(/\./gu, '\\.')}-timeline-compat\\.wasm-[^/]+\\.wasm$`, 'u')), 'the libav.js WebAssembly')
  const workerFiles = located(find(/^assets\/libav-compat\.worker-[^/]+\.js$/u), 'the libav.js compatibility worker')
  const aacFiles = find(/^assets\/[^/]+\.js$/u).filter(path => /Lavc\d+\.\d+\.\d+/u.test(readFileSync(join(appDirectory, ...path.split('/')), 'utf8')))
  const lavc = aacFiles.length > 0 ? /Lavc(\d+\.\d+\.\d+)/u.exec(readFileSync(join(appDirectory, ...aacFiles[0].split('/')), 'utf8'))[1] : undefined
  const frontendWasm = find(/(^|\/)libav-[\d.]+-webcodecs\./u)
  const lgpl = section(
    'FFmpeg code under the GNU Lesser General Public License',
    ...wrap('Two parts of the editor contain code from FFmpeg (https://ffmpeg.org/), which is licensed under the GNU Lesser General Public License version 2.1 or (at your option) any later version: LGPL-2.1-or-later. The licence text is licenses/LGPL-2.1.txt. Neither vibedev-video-editor nor dsh-film has modified either part: the libav.js build comes with ai-video-editor\'s source as built there, and the AAC encoder is the npm package as published. The editor uses each only through its published interface.'),
    '',
    `1. Compatibility media runtime: libav.js ${libav.libav}, a custom build of FFmpeg ${libav.ffmpeg}`,
    ...wrap('Licence: LGPL-2.1-or-later (FFmpeg; the libav.js npm packages declare LGPL-2.1). The licence header of the loader the build generated, with FFmpeg\'s LGPL and the MIT notice of Emscripten and musl, is kept in the worker file. libav.js\'s own glue code in that loader carries this notice, which the bundler dropped:', '   '),
    '',
    ...(libav.glue ?? ['(not found in the loader source)']).map(line => `     ${line}`.trimEnd()),
    '',
    '   Files:',
    ...libavFiles.flatMap(path => fileLine(path, 'FFmpeg as WebAssembly')),
    ...workerFiles.flatMap(path => fileLine(path, `the worker that loads it: the generated loader and the libav.js frontend of @libav.js/variant-webcodecs ${frontend.map(item => item.version).join(', ') || '(not in the closure)'}`)),
    '   Source:',
    `     libav.js    https://github.com/Yahweasel/libav.js/tree/${libav.commit}`,
    `                 (its Makefile builds FFmpeg ${libav.ffmpeg} with the patches in`,
    '                 patches/ at that commit)',
    `     FFmpeg      https://ffmpeg.org/releases/ffmpeg-${libav.ffmpeg}.tar.xz`,
    `     Emscripten  ${libav.emscripten}`,
    '     Configuration (a libav.js variant configuration; the record lists no changes to',
    '     libav.js or FFmpeg sources):',
    ...wrap(JSON.stringify(libav.config).replace(/,/gu, ', '), '       '),
    `   Build record: ${LIBAV_BUILD_RECORD} (vibedev-video-editor,`,
    '   vendor/ai-video-editor/src/vendor/libav-timeline-compat/BUILD.md).',
    ...wrap('It is a separate module: the worker is its own file and loads the WebAssembly by URL, only when the browser cannot handle a file natively or a Matroska file is imported. You may replace both files with your own build of libav.js, with this configuration or a modified one; the editor uses only the libav.js API.', '   '),
    '',
    `2. AAC encoder: @mediabunny/aac-encoder ${aac.version}`,
    ...wrap(`Licence: MPL-2.0 for the package's own code (${MEDIABUNNY_LICENCE}) AND LGPL-2.1-or-later for the WebAssembly build of FFmpeg's AAC encoder it contains. The package declares only "MPL-2.0", which covers its own code, not FFmpeg.`, '   '),
    '   Files:',
    ...(aacFiles.length > 0
      ? aacFiles.flatMap(path => fileLine(path, 'the package\'s code, with the encoder\'s WebAssembly embedded in it, inlined as published'))
      : located([], 'the AAC encoder (a script naming its libavcodec version)').map(path => `     ${path}`)),
    '   Source:',
    `     package     ${npmTarball(aac.name, aac.version)}`,
    ...(aac.integrity === undefined ? [] : [`                 (${aac.integrity})`]),
    '                 It holds src/, including bridge.c, the C glue compiled with',
    '                 FFmpeg\'s encoder, and the prebuilt build/aac.js.',
    `     repository  https://github.com/Vanilagy/mediabunny/tree/v${aac.version}/packages/aac-encoder`,
    '     FFmpeg      https://git.ffmpeg.org/ffmpeg.git (https://ffmpeg.org/download.html)',
    ...wrap(`The package's repository does not publish which FFmpeg revision or configuration its WebAssembly was built from${lavc === undefined ? '' : `; the build reports libavcodec ${lavc}, a development version after FFmpeg 8.0`}.`, '                 '),
    ...wrap('It is not a separate file: the bundler inlined it into the editor\'s entry chunk. To replace it, rebuild the editor from its source (https://github.com/CrisLIUning/vibedev-video-editor, MIT, `npm run build:dsh`) with another build of @mediabunny/aac-encoder, for example through an npm "overrides" entry, and put the result in apps/editor.', '   '),
    '',
    ...wrap(`@libav.js/variant-webcodecs: only its JavaScript frontend is in this folder (inside the worker above)${frontendWasm.length > 0 ? `; its own builds are here too: ${frontendWasm.join(', ')}` : '; its own WebAssembly builds are not shipped'}. Source: ${frontend.map(item => npmTarball(item.name, item.version)).join(', ') || 'not in the closure'}.`),
    '',
    ...wrap('dsh-film places no restriction on modifying these components for your own use or on reverse engineering the editor to debug such modifications.'),
  )

  // Mediabunny under the MPL.
  const bunnies = packages.filter(item => item.installed && (item.name === 'mediabunny' || item.name.startsWith('@mediabunny/')))
  const bunnyWidth = Math.max(...bunnies.map(item => `${item.name} ${item.version}`.length))
  const tags = [...new Set(bunnies.map(item => item.version))]
  const copyright = bunnies.map(packageCopyright).find(line => line !== undefined) ?? 'Copyright (c) Vanilagy and contributors'
  const mpl = section(
    'Mediabunny (MPL-2.0): where its source is',
    ...wrap(`${bunnies.map(item => `${item.name} ${item.version}`).join(' and ')} are in this folder in Executable Form only, bundled into the editor's scripts (for the AAC encoder, its MPL-2.0 code; see above for the FFmpeg part). As section 3.2(a) of the Mozilla Public License 2.0 requires, their Source Code Form is available, unmodified, from these version-pinned tarballs:`),
    '',
    ...bunnies.flatMap(item => [`  ${`${item.name} ${item.version}`.padEnd(bunnyWidth)}  ${npmTarball(item.name, item.version)}`, ...(item.integrity === undefined ? [] : [`  ${' '.repeat(bunnyWidth)}  (${item.integrity})`])]),
    '',
    ...wrap(`and from the repository at ${tags.map(version => `https://github.com/Vanilagy/mediabunny/tree/v${version}`).join(', ')}. ${copyright}. The licence text is ${MEDIABUNNY_LICENCE}. This distribution does not limit or alter the recipients' rights in the Source Code Form under that licence (section 3.2(b)).`),
  )

  // ONNX Runtime.
  const runtimes = packages.filter(item => item.installed && /^onnxruntime-(web|common|node)$/u.test(item.name))
  const web = runtimes.filter(item => item.name === 'onnxruntime-web').map(item => item.version).sort(compareVersions)
  const newest = web.at(-1)
  if (newest !== ONNXRUNTIME_NOTICES) {
    throw new Error(`editor: the newest onnxruntime-web in the closure is ${newest ?? 'none'}, but third-party/ holds the notices of ${ONNXRUNTIME_NOTICES}; `
      + 'add that version\'s ThirdPartyNotices.txt (see third-party/README.md) and update ONNXRUNTIME_NOTICES')
  }
  const tagOf = version => (/-dev\.\d+-([0-9a-f]+)$/u.exec(version)?.[1] ?? `v${version}`)
  const ort = section(
    'ONNX Runtime (MIT, Microsoft)',
    ...wrap(`The editor runs models with ONNX Runtime Web. The closure holds ${byName(runtimes.filter(item => item.name === 'onnxruntime-web'))} (the ort*.mjs and ort*.wasm files in assets/ and the model workers' scripts come from them, and vendor/migan-ort/ is a file of one of them, see its entry at the end), plus ${byName(runtimes.filter(item => item.name !== 'onnxruntime-web'))}. None of these npm packages ships a licence file. ONNX Runtime is licensed under the MIT License, Copyright (c) Microsoft Corporation: licenses/onnxruntime-LICENSE.txt, the LICENSE of https://github.com/microsoft/onnxruntime, the same at every one of these versions.`),
    '',
    ...wrap(`Its WebAssembly builds include third-party components listed in its ThirdPartyNotices.txt, which differs between these versions. licenses/ holds the notices of the newest, ${newest} (licenses/onnxruntime-ThirdPartyNotices-v${newest}.txt, from the release tag v${newest}), and in licenses/onnxruntime-ThirdPartyNotices-older-versions.txt the sections of the older versions' notices for components ${newest} no longer lists. Each version's own notices: ${web.map(version => `https://github.com/microsoft/onnxruntime/blob/${tagOf(version)}/ThirdPartyNotices.txt`).join(' ')}`),
  )

  // MediaPipe.
  const mediapipe = only('@mediapipe/tasks-vision')
  const mp = section(
    'MediaPipe (Apache-2.0, Google)',
    ...wrap(`@mediapipe/tasks-vision ${mediapipe.version} (Copyright 2022 The MediaPipe Authors, as its sources state; MediaPipe is developed by Google) is licensed under the Apache License 2.0, but its npm package ships no licence file. The licence is licenses/Apache-2.0.txt; licenses/mediapipe-LICENSE.txt is MediaPipe's LICENSE at the tag v1.0.0 of https://github.com/google-ai-edge/mediapipe (Apache-2.0 followed by the notices of third-party code in MediaPipe).`),
    '',
    ...wrap(`vendor/mediapipe/vision/ holds MediaPipe's vision WebAssembly runtime, also Apache-2.0 and derived from @mediapipe/tasks-vision: its .wasm is the same file as in ${mediapipe.version}, but its .js is not an exact copy of ${mediapipe.version}'s (see the entries at the end), and which MediaPipe build it comes from is not recorded.`),
  )

  // OpenCV.
  const opencvFile = join(appDirectory, 'vendor', 'opencv.js')
  const opencv = existsSync(opencvFile) ? opencvVersion(opencvFile) : undefined
  const cv = existsSync(opencvFile)
    ? section(
      'OpenCV (vendor/opencv.js)',
      ...wrap(`vendor/opencv.js is a JavaScript build of OpenCV (https://opencv.org/). The source repository records neither its version nor where it came from${opencv === undefined ? ', and the file does not state it either: the exact version is unrecorded' : `; the build information compiled into it reads "General configuration for OpenCV ${opencv}"`}. OpenCV 4.5.0 and later are licensed under the Apache License 2.0 (licenses/Apache-2.0.txt; their copyright holders, as OpenCV 4.5.5 lists them, in licenses/opencv-COPYRIGHT.txt); earlier versions under the 3-clause BSD licence (licenses/opencv-BSD-3-Clause.txt, OpenCV 4.4.0's licence with its copyright holders). Both are included because the file's origin is not recorded. Third-party copyrights in OpenCV are property of their respective owners.`),
    )
    : undefined

  return [licences, lgpl, mpl, ort, mp, ...(cv === undefined ? [] : [cv])]
}

/** Notes added to package entries of the editor's list: where the licence a package lacks is, or what corrects its declaration. */
function editorSupplement(item) {
  if (/^onnxruntime-(web|common|node)$/u.test(item.name)) {
    return { lines: ['ONNX Runtime is MIT, Copyright (c) Microsoft Corporation: licenses/onnxruntime-LICENSE.txt;', 'its third-party notices: see "ONNX Runtime" above.'] }
  }
  if (item.name === '@mediapipe/tasks-vision') {
    return { lines: ['Licence text: licenses/Apache-2.0.txt; MediaPipe\'s LICENSE: licenses/mediapipe-LICENSE.txt', '(see "MediaPipe" above).'] }
  }
  if (item.name === '@libav.js/variant-webcodecs') {
    return { lines: ['Licence text: licenses/LGPL-2.1.txt. Only its JavaScript frontend is bundled (into the', 'libav compatibility worker); see "FFmpeg code under the GNU Lesser General Public License" above.'] }
  }
  if (item.name === '@mediabunny/aac-encoder') {
    return {
      licence: 'MPL-2.0 AND LGPL-2.1-or-later (the package declares MPL-2.0, which covers its own code; its WebAssembly is FFmpeg\'s AAC encoder)',
      lines: ['See "FFmpeg code under the GNU Lesser General Public License" (LGPL text: licenses/LGPL-2.1.txt)', 'and "Mediabunny (MPL-2.0): where its source is" above.'],
    }
  }
  if (item.name === 'mediabunny') return { lines: ['Source tarball and the MPL-2.0 section 3.2 statement: see "Mediabunny (MPL-2.0): where its source is" above.'] }
  return undefined
}

/** Notes added to the editor's vendored files. */
function editorVendoredNote(path) {
  if (path === 'vendor/opencv.js') return ['Licence: see "OpenCV (vendor/opencv.js)" above.']
  if (path.startsWith('vendor/mediapipe/')) return ['Licence: Apache-2.0, derived from @mediapipe/tasks-vision; see "MediaPipe" above.']
  if (path.startsWith('vendor/migan-ort/')) return ['Licence: ONNX Runtime, MIT, Copyright (c) Microsoft Corporation; see "ONNX Runtime" above.']
  if (path.startsWith('vendor/vocal-remover/')) return ['TensorFlow.js. The Apache License 2.0 the header names is in licenses/Apache-2.0.txt.']
  return undefined
}

function writeNotices(name, app) {
  const appDirectory = join(root, 'apps', name)
  if (!existsSync(join(appDirectory, 'index.html'))) throw new Error(`${name}: apps/${name} is not built (no index.html)`)
  if (!existsSync(app.source)) throw new Error(`${name}: no checkout at ${app.source}`)
  checkReceipts(name, app, appDirectory)
  // Folders only this step writes start empty, so a text that is no longer needed does not linger.
  for (const folder of app.noticeFolders ?? []) rmSync(join(appDirectory, folder), { recursive: true, force: true })
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
// Trimming
// ---------------------------------------------------------------------------

/** Files whose text can name another file of the app (pages, scripts, styles, manifests). */
const REFERENCING_FILE = /\.(c|m)?js$|\.(css|html|json|webmanifest)$/u

/**
 * Remove the files scripts/app-excludes.mjs lists for this app — after making
 * sure no page, script or style that stays names one of them (other than the
 * references an entry documents as unreachable); stop, removing nothing, if
 * one does.
 */
function trimApp(name, appDirectory) {
  const entries = APP_EXCLUDES[name] ?? []
  const removed = excludedFiles(name, appDirectory)
  if (removed.length === 0) {
    console.log(`[trim] ${name}: nothing to remove`)
    return
  }
  const leaving = new Set(removed.map(({ path }) => path))
  const needles = new Map()
  for (const { path, entry } of removed) {
    const needle = entry.needle ?? basename(path)
    if (!needles.has(needle)) needles.set(needle, entry)
  }
  const dangling = []
  for (const file of walk(appDirectory).filter(path => REFERENCING_FILE.test(path))) {
    const path = toPosix(relative(appDirectory, file))
    if (leaving.has(path)) continue
    const text = readFileSync(file, 'utf8')
    for (const [needle, entry] of needles) {
      if (!text.includes(needle)) continue
      if (entry.referencedFrom?.test(path)) {
        console.log(`[trim] ${name}: ${path} still names ${needle} — ${entry.reference}`)
        continue
      }
      dangling.push(`${path} names ${needle}`)
    }
  }
  if (dangling.length > 0) {
    throw new Error(`${name}: files kept in apps/${name} name files the trim would remove (${dangling.join('; ')}); `
      + 'nothing removed — keep those files or fix the exclude list in scripts/app-excludes.mjs')
  }
  let bytes = 0
  for (const path of leaving) {
    const file = join(appDirectory, ...path.split('/'))
    bytes += statSync(file).size
    rmSync(file)
  }
  // Remove the folders the trim emptied.
  const prune = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) prune(join(directory, entry.name))
    if (directory !== appDirectory && readdirSync(directory).length === 0) rmSync(directory, { recursive: true })
  }
  prune(appDirectory)
  console.log(`[trim] ${name}: removed ${removed.length} file(s), ${(bytes / 1e6).toFixed(1)} MB, by ${entries.length} rule(s) of scripts/app-excludes.mjs`)
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const mode = args[0] === 'notices' || args[0] === 'trim' ? args[0] : 'build'
const wanted = mode === 'build' ? args : args.slice(1)
const unknown = wanted.filter(name => !Object.hasOwn(APPS, name))
if (unknown.length > 0) throw new Error(`unknown app(s): ${unknown.join(', ')} (known: ${Object.keys(APPS).join(', ')})`)

for (const [name, app] of Object.entries(APPS)) {
  if (wanted.length > 0 && !wanted.includes(name)) continue
  const target = join(root, 'apps', name)
  if (mode === 'notices') {
    writeNotices(name, app)
    continue
  }
  if (mode === 'trim') {
    if (!existsSync(join(target, 'index.html'))) throw new Error(`${name}: apps/${name} is not built (no index.html)`)
    trimApp(name, target)
    continue
  }
  if (!existsSync(app.source)) throw new Error(`${name}: no checkout at ${app.source}`)
  const output = app.build(app.source)
  const files = walk(output)
  const unroutable = files.map(file => relative(output, file).split(sep)).filter(parts => !parts.every(part => SEGMENT.test(part)))
  if (unroutable.length > 0) throw new Error(`${name}: ${unroutable.length} file(s) the Host cannot route, e.g. ${unroutable[0].join('/')}`)
  if (!existsSync(join(output, 'index.html'))) throw new Error(`${name}: the build has no index.html`)
  rmSync(target, { recursive: true, force: true })
  cpSync(output, target, { recursive: true })
  const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0)
  console.log(`[apps] ${name}: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB → apps/${name}`)
  trimApp(name, target)
  writeNotices(name, app)
}
