#!/usr/bin/env node
/**
 * Copy the licence files of vendored code from src/ to the same place under
 * lib/, which tsc does not do: today the director desk's scene math
 * (src/director/vendor/director-math/LICENSE → lib/director/vendor/director-math/LICENSE),
 * and any LICENSE/LICENCE/COPYING/NOTICE file added under src/ later.
 * src/client is skipped: it is bundled into client/, not compiled into lib/.
 *
 *   node scripts/copy-licenses.mjs     (run by `npm run build` after tsc)
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = join(root, 'src')
const target = join(root, 'lib')
const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i
/** The vendored code that must keep its licence beside it in the package. */
const REQUIRED = ['director/vendor/director-math/LICENSE']

function walk(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (path !== join(source, 'client')) found.push(...walk(path))
    } else if (entry.isFile() && LICENCE_FILE.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

const copied = []
for (const file of walk(source)) {
  const path = relative(source, file)
  mkdirSync(dirname(join(target, path)), { recursive: true })
  copyFileSync(file, join(target, path))
  copied.push(path.split(sep).join('/'))
}
const missing = REQUIRED.filter(path => !copied.includes(path))
if (missing.length > 0) throw new Error(`copy-licenses: src/${missing.join(', src/')} not found`)
for (const path of copied) console.log(`[licenses] src/${path} → lib/${path}`)
