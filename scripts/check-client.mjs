#!/usr/bin/env node
/**
 * Post-build check of the browser bundle files the Host will load.
 *
 * - The file set is exactly the expected entry and chunks (a new chunk is a
 *   decision: add it here, and to nothing else).
 * - Each file starts with its one-line loader call (the Host reads the module
 *   id from the first line; Rolldown may spread the banner over several lines,
 *   so it is folded back) and ends with the factory's return.
 * - Each `require` names a Host module-table entry. A static require of a
 *   sibling file is refused: the loader resolves sibling chunks only through
 *   `require.async`, so a shared module split out by the bundler would throw
 *   at load time.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const name = JSON.parse(readFileSync('package.json', 'utf8')).name
const EXPECTED = ['client.js', 'client.workbench.js']
const MODULE_TABLE = new Set(['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'])

const files = readdirSync('client').filter(file => file.endsWith('.js')).sort()
if (JSON.stringify(files) !== JSON.stringify([...EXPECTED].sort())) {
  throw new Error(`client/: expected ${EXPECTED.join(', ')}, found ${files.join(', ')}`)
}

for (const file of files) {
  const path = `client/${file}`
  const required = `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, ${file === 'client.js' ? '' : `chunk: ${JSON.stringify(file)}, `}factory: (require) => {`
  let code = readFileSync(path, 'utf8')
  if (!code.startsWith(required)) {
    const marker = 'factory: (require) => {'
    const end = code.indexOf(marker)
    if (end === -1) throw new Error(`${path}: the loader banner is missing`)
    const head = code.slice(0, end + marker.length).replace(/\s+/g, ' ').trim()
    const folded = head.replace(/^window\.__ModuleLoader__\.load\(\s*\{\s*/, 'window.__ModuleLoader__.load({ ')
    code = `${folded}${code.slice(end + marker.length)}`
    if (!code.startsWith(required)) throw new Error(`${path}: expected it to start with ${required}`)
    writeFileSync(path, code)
  }
  if (!/return module\.exports;\s*\}\s*\}\);\s*$/.test(code)) throw new Error(`${path}: the loader footer is missing`)
  for (const match of code.matchAll(/\brequire(\.async)?\(\s*(['"`])([^'"`]*)\2\s*\)/g)) {
    const [, async, , specifier] = match
    if (async !== undefined) {
      if (!EXPECTED.includes(specifier.replace(/^\.\//, '')) || !specifier.startsWith('./')) {
        throw new Error(`${path}: require.async(${JSON.stringify(specifier)}) does not name an expected chunk`)
      }
    } else if (!MODULE_TABLE.has(specifier)) {
      throw new Error(`${path}: require(${JSON.stringify(specifier)}) is not a Host module-table entry`)
    }
  }
  if (/\bprocess\.env\b/.test(code)) throw new Error(`${path}: process.env survives in browser code`)
  if (/\bimport\.meta\b/.test(code)) throw new Error(`${path}: import.meta survives in a CommonJS factory`)
  console.log(`${path}: ok (${code.length} bytes)`)
}

// The entry registers exactly the three parts' tab types; 0.1's film-timeline tab must not come back.
{
  const entry = readFileSync('client/client.js', 'utf8')
  const missing = ['dsh-film/story', 'dsh-film/board', 'dsh-film/director'].filter(id => !entry.includes(JSON.stringify(id)) && !entry.includes(`'${id}'`))
  if (missing.length > 0) throw new Error(`client/client.js: the tab type(s) ${missing.join(', ')} are not registered`)
  if (/dsh-film\/timeline|film-timeline/.test(entry)) throw new Error('client/client.js: it still registers the film-timeline tab 0.2 removed')
}
