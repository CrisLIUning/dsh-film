#!/usr/bin/env node
/**
 * Remove the build outputs `npm run build` writes: lib/ (tsc, the Host half)
 * and client/ (tsdown, the browser half). tsc never deletes the output of a
 * source file that is gone, so without this a removed module (once
 * lib/captions/gateway.js) would still ship in the package.
 *
 * apps/ is left alone: it is built from the sibling checkouts by
 * scripts/build-apps.mjs, which only maintainers can run.
 *
 *   node scripts/clean.mjs
 */
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

for (const directory of ['lib', 'client']) {
  rmSync(join(root, directory), { recursive: true, force: true })
  console.log(`[clean] removed ${directory}/`)
}
