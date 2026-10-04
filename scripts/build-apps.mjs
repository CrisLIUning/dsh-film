#!/usr/bin/env node
/**
 * Build the original film app for this plugin and place it under apps/.
 *
 * - canvas: the storyboard canvas with its 3D director desk overlay, from the
 *   vibedev-canvas checkout (DSH_FILM_CANVAS_SRC, default ../canvas, branch
 *   feat/dsh-host), built by its own web/scripts/build-dsh.mjs into
 *   web/dist-dsh. That script builds the director desk from ../director-desk
 *   (vibedev-director-desk, branch feat/dsh-procedural-mannequin).
 *
 * The canvas is the only app. This script replaces only apps/canvas: delete
 * any other folder under apps/ by hand (the Host serves every apps/<dir> with
 * an index.html, and scripts/check-package.mjs refuses to pack one).
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
 * repository and the text of its licence files from node_modules. The
 * canvas's director-desk/THIRD-PARTY-NOTICES.txt and licenses/ come from the
 * desk's own build and are left as they are; the desk's licence is copied to
 * director-desk/LICENSE and its npm packages join the canvas's notices.
 *
 *   node scripts/build-apps.mjs [canvas]           build, copy, trim, write notices
 *   node scripts/build-apps.mjs notices [canvas]   only the licences and notices,
 *                                                  for the app already in apps/
 *   node scripts/build-apps.mjs trim [canvas]      only remove the excluded files
 *                                                  from the app already in apps/
 *
 * The notices step reads the checkouts' lockfiles and installed node_modules
 * (no network); run it from the checkouts the apps were built from. It warns
 * when a checkout is not at the commit an app's component-build.json records.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { APP_EXCLUDES, excludedFiles } from './app-excludes.mjs'

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
      'vibedev-director-desk (MIT, Copyright (c) 2026 YZ; its source repository is',
      'not public; licence: director-desk/LICENSE).',
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
    /** The build receipts in the app and the checkouts they should match. */
    receipts: source => [
      { file: 'component-build.json', checkout: source },
      { file: 'director-desk/component-build.json', checkout: deskSource(source) },
    ],
  },
}

/** The director desk checkout the canvas build uses (web/scripts/build-dsh.mjs: OD_DIRECTOR_SRC, else a sibling of the canvas checkout). */
function deskSource(canvasSource) {
  return resolve(process.env.OD_DIRECTOR_SRC ?? join(canvasSource, '..', 'director-desk'))
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}`)
}

function walk(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(path))
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

/** One package of the list. */
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

function noticesText(name, app, { packages, counts }) {
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
    ...installed.map(item => packageEntry(item)),
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
  return parts.join('\n')
}

const toPosix = path => path.split(sep).join('/')

/** A path for the log: relative to the checkout or to this repository, whichever it is in. */
function shortPath(file, source) {
  const inSource = relative(source, file)
  return toPosix(inSource.startsWith('..') ? relative(root, file) : inSource)
}

function copyLicences(name, app, appDirectory) {
  for (const { from, to } of app.licenses(app.source)) {
    if (!existsSync(from)) throw new Error(`${name}: licence file ${from} not found`)
    writeText(join(appDirectory, ...to.split('/')), readText(from))
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

function writeNotices(name, app) {
  const appDirectory = join(root, 'apps', name)
  if (!existsSync(join(appDirectory, 'index.html'))) throw new Error(`${name}: apps/${name} is not built (no index.html)`)
  if (!existsSync(app.source)) throw new Error(`${name}: no checkout at ${app.source}`)
  checkReceipts(name, app, appDirectory)
  copyLicences(name, app, appDirectory)
  const collected = collectPackages(app.lockfiles(app.source))
  writeText(join(appDirectory, 'THIRD-PARTY-NOTICES.txt'), noticesText(name, app, collected))
  const withoutFile = collected.packages.filter(item => item.installed && item.files.length === 0).length
  const absent = collected.packages.filter(item => !item.installed).length
  console.log(`[notices] ${name}: apps/${name}/THIRD-PARTY-NOTICES.txt — ${collected.packages.length - absent} packages `
    + `(${withoutFile} without a licence file), ${absent} not installed`)
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
