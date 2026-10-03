/**
 * Browser half of dsh-film, built the way DeepSeek Harness loads an external
 * package's client: closure-factory files that call
 * `window.__ModuleLoader__.load({ id, factory })` and get React and the client
 * primitives through the injected `require` (the Host's module table).
 *
 * - client/client.js — the entry the Host loads at every start (tab types).
 * - client/client.<name>.js — lazily loaded parts. A dynamic `import()` of a
 *   part is rewritten to `require.async('./client.<name>.js')`, the loader's
 *   chunk operation; chunk files carry `chunk: "<file>"` in their loader call.
 * - `x.module.css` compiles with lightningcss into the bundle that imports it
 *   and injects a `<style data-plugin="dsh-film">` when that bundle runs.
 *
 * scripts/check-client.mjs then verifies the files the Host will load.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'
import type { TsdownPlugin } from 'tsdown'

const id = 'dsh-film'

/** Modules the Host's module table provides; a `require` it cannot answer throws at load. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

/** Lazily loaded file names the loader accepts. */
const CHUNK_FILE = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/

/** Virtual ids keep module CSS away from tsdown's own CSS pipeline; the suffix must not end in `.css`. */
const CSS_PREFIX = '\0dsh-film-css:'
const CSS_SUFFIX = '.mjs'

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Rewrite package-local dynamic imports into the loader's asynchronous chunk operation. */
function asyncChunkRequire(): TsdownPlugin {
  return {
    name: 'dsh-film-async-chunk-require',
    renderChunk(code, chunk) {
      let result = code
      for (const dynamicImport of chunk.dynamicImports) {
        const fileName = dynamicImport.startsWith('./') ? dynamicImport.slice(2) : dynamicImport
        if (!CHUNK_FILE.test(fileName)) throw new Error(`dynamic chunk ${fileName} does not match ${CHUNK_FILE}`)
        const specifier = `./${fileName}`
        const call = new RegExp(`Promise\\.resolve\\(\\)\\.then\\(\\(\\)\\s*=>\\s*require\\((['"])${escapeRegExp(specifier)}\\1\\)\\)`, 'gu')
        if (!call.test(result)) throw new Error(`dynamic chunk ${specifier} has no generated import expression`)
        result = result.replace(call, `require.async(${JSON.stringify(specifier)})`)
      }
      return result === code ? null : result
    },
  }
}

/** A style injector for one stylesheet plus its CSS Modules class map. */
function styleModule(fileId: string, css: string, classMap: Readonly<Record<string, string>>): string {
  const tagId = `${id}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/** Compile `*.module.css` imports with lightningcss into injected styles and hashed class maps. */
function cssModules(): TsdownPlugin {
  return {
    name: 'dsh-film-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null
      const path = importer === undefined ? resolve(source) : resolve(dirname(importer), source)
      return `${CSS_PREFIX}${path}${CSS_SUFFIX}`
    },
    async load(virtualId) {
      if (!virtualId.startsWith(CSS_PREFIX)) return null
      const fileId = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(fileId)
      const { code, exports } = transform({
        filename: fileId,
        code: await readFile(fileId),
        cssModules: { pattern: 'dshfilm_[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, value] of Object.entries(exports ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
        classMap[local] = value.name
      }
      return styleModule(fileId, code.toString(), classMap)
    },
  }
}

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  tsconfig: 'tsconfig.client.json',
  dts: false,
  sourcemap: false,
  clean: true,
  deps: {
    neverBundle: (source: string) => CLIENT_EXTERNALS.includes(source),
    // Everything the module table does not answer must be inlined.
    alwaysBundle: (source: string) => !CLIENT_EXTERNALS.includes(source),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  plugins: [asyncChunkRequire(), cssModules()],
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
    banner: chunk => `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
