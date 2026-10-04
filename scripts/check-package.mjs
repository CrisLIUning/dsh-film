#!/usr/bin/env node
/**
 * Pre-pack guard (run by `npm run prepack` after the build): refuse to pack a
 * package that would install but silently lack parts.
 *
 * - The built apps: without apps/ the package still loads, but the storyboard
 *   canvas, director desk and editing desk tabs have nothing to show
 *   (src/apps.ts findApps returns []) and captions have no runner page.
 * - The licences and notices that must ship with vendored and bundled code,
 *   including the editor's licenses/ (LGPL, MPL, Apache, ONNX Runtime,
 *   MediaPipe and OpenCV texts and the libav.js build record) and the
 *   sections of its THIRD-PARTY-NOTICES.txt that point at them.
 * - None of the app files scripts/app-excludes.mjs removes is present.
 * - lib/ holds only output of a current src/ file (tsc never deletes stale
 *   output; a removed lib/captions/gateway.js once nearly shipped), and the
 *   entry files package.json points at exist.
 * - No file in lib/ or client/ contains this checkout's absolute path or a
 *   home-directory path (a build that bakes in where it ran).
 * - Every app file name can be routed by the Host (others are skipped).
 *
 *   node scripts/check-package.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { excludedFiles } from './app-excludes.mjs'

const root = resolve(import.meta.dirname, '..')
const problems = []
const SEGMENT = /^[A-Za-z0-9_$.-]+$/

const REBUILD_APPS = 'rebuild with `node scripts/build-apps.mjs canvas editor` (maintainers: needs the canvas, director desk and editor checkouts)'
const REWRITE_NOTICES = 'write them with `node scripts/build-apps.mjs notices canvas editor`'

/** Files the package must carry, with what goes wrong without each and how to fix it. */
const REQUIRED = [
  ['apps/canvas/index.html', 'the storyboard canvas and director desk tabs would be empty', REBUILD_APPS],
  ['apps/editor/index.html', 'the editing desk tab would be empty', REBUILD_APPS],
  ['apps/editor/caption-runner.html', 'caption recognition would have no runner page', REBUILD_APPS],
  ['LICENSE', 'the package would ship without its own licence', 'restore it from git'],
  ['lib/director/vendor/director-math/LICENSE', 'the vendored director math would ship without its licence', 'run `npm run build`'],
  ['apps/canvas/LICENSE', 'the canvas would ship without its licence', REWRITE_NOTICES],
  ['apps/canvas/THIRD-PARTY-NOTICES.txt', 'the canvas bundle would ship without its third-party notices', REWRITE_NOTICES],
  ['apps/canvas/director-desk/LICENSE', 'the director desk would ship without its licence', REWRITE_NOTICES],
  ['apps/canvas/director-desk/THIRD-PARTY-NOTICES.txt', 'the director desk would ship without its third-party notices', REBUILD_APPS],
  ['apps/editor/LICENSE', 'the editing desk would ship without its licence', REWRITE_NOTICES],
  ['apps/editor/ai-video-editor/LICENSE', 'the embedded ai-video-editor would ship without its licence', REWRITE_NOTICES],
  ['apps/editor/ai-video-editor/MODEL_LICENSES.md', 'the editor\'s model and media licence notice would be missing', REWRITE_NOTICES],
  ['apps/editor/THIRD-PARTY-NOTICES.txt', 'the editor bundle would ship without its third-party notices', REWRITE_NOTICES],
  ['apps/editor/licenses/LGPL-2.1.txt', 'the editor\'s FFmpeg code (libav.js build, AAC encoder) would ship without the LGPL', REWRITE_NOTICES],
  ['apps/editor/licenses/libav-timeline-compat-BUILD.md', 'the custom libav.js build would ship without its build record', REWRITE_NOTICES],
  ['apps/editor/licenses/mediabunny-MPL-2.0.txt', 'Mediabunny would ship without the MPL-2.0', REWRITE_NOTICES],
  ['apps/editor/licenses/Apache-2.0.txt', 'MediaPipe, TensorFlow.js and OpenCV would ship without the Apache License', REWRITE_NOTICES],
  ['apps/editor/licenses/onnxruntime-LICENSE.txt', 'ONNX Runtime would ship without its licence', REWRITE_NOTICES],
  ['apps/editor/licenses/onnxruntime-ThirdPartyNotices-older-versions.txt', 'ONNX Runtime\'s older third-party notices would be missing', REWRITE_NOTICES],
  ['apps/editor/licenses/mediapipe-LICENSE.txt', 'MediaPipe would ship without its LICENSE', REWRITE_NOTICES],
  ['apps/editor/licenses/opencv-BSD-3-Clause.txt', 'opencv.js would ship without the BSD licence of OpenCV before 4.5', REWRITE_NOTICES],
  ['apps/editor/licenses/opencv-COPYRIGHT.txt', 'opencv.js would ship without OpenCV\'s copyright holders', REWRITE_NOTICES],
  ['vendor/video-editor-bridge.mjs', 'the Host half could not load (timeline commands, captions, render)', REBUILD_APPS],
  ['vendor/video-editor-bridge.LICENSE.txt', 'the bridge contract would ship without its licences', REWRITE_NOTICES],
]

const fileAt = path => statSync(join(root, ...path.split('/')), { throwIfNoEntry: false })

for (const [path, consequence, fix] of REQUIRED) {
  const info = fileAt(path)
  if (info?.isFile() !== true) problems.push(`${path} is missing: ${consequence}; ${fix}.`)
  else if (info.size === 0) problems.push(`${path} is empty: ${consequence}; ${fix}.`)
}

// The ONNX Runtime notices are versioned: one file for the newest onnxruntime-web the editor holds.
const editorLicences = join(root, 'apps', 'editor', 'licenses')
if (existsSync(editorLicences) && !readdirSync(editorLicences).some(name => /^onnxruntime-ThirdPartyNotices-v\d[^/]*\.txt$/u.test(name))) {
  problems.push(`apps/editor/licenses/onnxruntime-ThirdPartyNotices-v<version>.txt is missing: ONNX Runtime's third-party notices would not ship; ${REWRITE_NOTICES}.`)
}

// The editor's notices must carry the sections that point at those texts (an old notices file would not).
const EDITOR_SECTIONS = [
  'FFmpeg code under the GNU Lesser General Public License',
  'Mediabunny (MPL-2.0): where its source is',
  'ONNX Runtime (MIT, Microsoft)',
  'MediaPipe (Apache-2.0, Google)',
  'OpenCV (vendor/opencv.js)',
]
if (fileAt('apps/editor/THIRD-PARTY-NOTICES.txt')?.isFile() === true) {
  const notices = readFileSync(join(root, 'apps', 'editor', 'THIRD-PARTY-NOTICES.txt'), 'utf8')
  const missing = EDITOR_SECTIONS.filter(title => !notices.includes(`\n${title}\n`))
  if (missing.length > 0) problems.push(`apps/editor/THIRD-PARTY-NOTICES.txt lacks the section(s) ${missing.map(title => `"${title}"`).join(', ')}; ${REWRITE_NOTICES}.`)
}

// MODEL_LICENSES.md's relative links must resolve in the package.
if (fileAt('apps/editor/ai-video-editor/MODEL_LICENSES.md')?.isFile() === true) {
  const base = join(root, 'apps', 'editor', 'ai-video-editor')
  const text = readFileSync(join(base, 'MODEL_LICENSES.md'), 'utf8')
  const broken = [...text.matchAll(/\]\(([^)\s#]+)(#[^)\s]*)?\)/gu)]
    .map(match => match[1])
    .filter(target => !/^[a-z][a-z0-9+.-]*:/iu.test(target) && statSync(resolve(base, target), { throwIfNoEntry: false })?.isFile() !== true)
  if (broken.length > 0) problems.push(`apps/editor/ai-video-editor/MODEL_LICENSES.md has ${broken.length} link(s) that do not resolve in the package, e.g. ${broken[0]}; ${REWRITE_NOTICES}.`)
}

// Files the trim removes.
for (const app of ['canvas', 'editor']) {
  const directory = join(root, 'apps', app)
  if (!existsSync(directory)) continue
  const leftover = excludedFiles(app, directory)
  if (leftover.length > 0) {
    problems.push(`apps/${app} still holds ${leftover.length} file(s) dsh-film does not ship (scripts/app-excludes.mjs), e.g. ${leftover[0].path}; `
      + `remove them with \`node scripts/build-apps.mjs trim ${app}\`.`)
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

// eSpeak NG is GPL-3.0-or-later. The editor's VibeDev build leaves out the two speech
// front ends that carry it (Kokoro through phonemizer, the vits-web Piper voices through
// piper-phonemize) and its own build fails on these markers; this repeats the check on
// what is about to ship, so an editor copied in from an older build cannot slip through.
{
  const MARKERS = ['espeak_EVENT_TYPE', 'espeak-ng-data', 'piper_phonemize', 'kokoro-js', 'KokoroTTS', '@diffusionstudio/vits-web']
  const NAMES = /(^|[/\\])(kokoro|phonemizer|vits-web|espeak)[^/\\]*$/iu
  // Licence texts and notices may name these packages; only code and data can carry them.
  const DOCUMENT = /(\.(md|txt)|(^|[/\\])(LICEN[CS]E|NOTICE|COPYING)[^/\\]*)$/iu
  const found = []
  for (const app of ['canvas', 'editor']) {
    const directory = join(root, 'apps', app)
    if (!existsSync(directory)) continue
    for (const file of walk(directory)) {
      const path = toPosix(relative(root, file))
      if (DOCUMENT.test(path)) continue
      if (NAMES.test(path)) { found.push(`${path} (file name)`); continue }
      const text = readFileSync(file).toString('latin1')
      const marker = MARKERS.find(item => text.includes(item))
      if (marker !== undefined) found.push(`${path} (${marker})`)
    }
  }
  if (found.length > 0) {
    problems.push(`${found.length} app file(s) carry GPL-3.0 eSpeak NG code, e.g. ${found[0]}: the editor copy predates the build that leaves it out; `
      + 'rebuild with `node scripts/build-apps.mjs editor` from a video-editor checkout at or after a0282ca.')
  }
}

// The Host routes app files by exact path; a name it cannot carry is skipped.
for (const app of ['canvas', 'editor']) {
  const directory = join(root, 'apps', app)
  if (!existsSync(directory)) continue
  const unroutable = walk(directory).map(file => toPosix(relative(directory, file))).filter(path => !path.split('/').every(part => SEGMENT.test(part)))
  if (unroutable.length > 0) problems.push(`apps/${app}: ${unroutable.length} file name(s) the Host cannot route, e.g. ${unroutable[0]}.`)
}

if (problems.length > 0) {
  console.error(`\ncheck-package: refusing to pack dsh-film ${manifest.version} — ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

const count = directory => walk(join(root, directory)).length
console.log(`[check-package] dsh-film ${manifest.version}: ok — apps/canvas ${count('apps/canvas')} files, apps/editor ${count('apps/editor')} files, `
  + `lib ${count('lib')} files, client ${count('client')} files; licences and notices present`)
