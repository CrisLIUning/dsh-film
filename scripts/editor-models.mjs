#!/usr/bin/env node
/**
 * Write `models/video-editor-models.json`, the AI models the editing desk may
 * download, from a dump of Studio's published model list.
 *
 * Studio keeps the list in `apps/daemon/src/production-video-editor-models.ts`
 * (`PRODUCTION_VIDEO_EDITOR_MODEL_MANIFESTS`: pinned files on the VibeDev
 * model mirror, each with its size and SHA-256). Dump it to JSON, for example
 * with the editor repo's tsx:
 *
 *   tsx -e "import('<studio>/apps/daemon/src/production-video-editor-models.ts')
 *     .then(m => console.log(JSON.stringify(m.PRODUCTION_VIDEO_EDITOR_MODEL_MANIFESTS)))" > studio-models.json
 *
 * then run:
 *
 *   node scripts/editor-models.mjs studio-models.json <studio commit> [<captionFonts.js>]
 *
 * With the editor's `vendor/ai-video-editor/src/lib/captionFonts.js`, caption
 * fonts are named as the editor names them (站酷快乐体, not "Caption font:
 * zcool-kuaile"), which is what the consent question shows.
 *
 * Only models whose licence is clear are kept: Studio's `restricted` models
 * (face swap: research weights) and the ones listed in EXCLUDED are dropped.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Models left out on purpose, with the reason the file records. */
const EXCLUDED = {
  'stable-audio-3-small-music-onnx': 'Stability AI Community License: not cleared for VibeDev yet',
}

/** Models offered under one consent, by capability. */
const GROUPS = { 'caption-font': 'caption-font' }

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const SHA256 = /^[0-9a-f]{64}$/
const REVISION = /^[0-9a-f]{7,64}$/
const TRUSTED_HOSTS = new Set([
  'vibedev.jzsaas.com',
  'raw.githubusercontent.com',
  'storage.googleapis.com',
])

const [input, commit, fontTable] = process.argv.slice(2)
if (input === undefined || commit === undefined) {
  console.error('usage: node scripts/editor-models.mjs <studio-models.json> <studio commit> [<captionFonts.js>]')
  process.exit(2)
}

/** The editor's names for its caption fonts, by model id. */
const fontNames = new Map()
if (fontTable !== undefined) {
  for (const [, id, name] of readFileSync(fontTable, 'utf8').matchAll(/font\("([a-z0-9-]+)",\s*"[^"]*",\s*"([^"]+)"/g)) {
    fontNames.set(`caption-font-${id}`, name)
  }
  if (fontNames.size === 0) throw new Error(`no caption fonts found in ${fontTable}`)
}

const studio = JSON.parse(readFileSync(input, 'utf8'))
if (!Array.isArray(studio)) throw new Error('expected the JSON array of Studio model manifests')

const excluded = {}
const models = []
for (const manifest of studio) {
  if (manifest.consent !== 'download') {
    excluded[manifest.id] = `Studio marks it ${manifest.consent}: ${manifest.license?.notice ?? manifest.license?.name}`
    continue
  }
  if (Object.hasOwn(EXCLUDED, manifest.id)) {
    excluded[manifest.id] = EXCLUDED[manifest.id]
    continue
  }
  if (manifest.schemaVersion !== 1 || !SAFE_ID.test(manifest.id) || !REVISION.test(manifest.revision)) {
    throw new Error(`unexpected manifest ${manifest.id}`)
  }
  if (typeof manifest.license?.name !== 'string' || manifest.license.name.trim() === '') {
    throw new Error(`${manifest.id} has no licence name`)
  }
  const artifacts = manifest.artifacts.map((artifact) => {
    if (!SAFE_ID.test(artifact.id) || !SHA256.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
      throw new Error(`unexpected artifact ${manifest.id}/${artifact.id}`)
    }
    if (artifact.fileName.includes('/') || artifact.fileName.includes('\\')) throw new Error(`artifact file name with a directory: ${manifest.id}/${artifact.id}`)
    for (const source of artifact.sources) {
      const url = new URL(source)
      if (url.protocol !== 'https:' || !TRUSTED_HOSTS.has(url.hostname)) throw new Error(`untrusted source ${source}`)
    }
    return { id: artifact.id, fileName: artifact.fileName, bytes: artifact.bytes, sha256: artifact.sha256, sources: artifact.sources }
  })
  if (new Set(artifacts.map(artifact => artifact.id)).size !== artifacts.length) throw new Error(`duplicate artifact ids in ${manifest.id}`)
  models.push({
    id: manifest.id,
    label: fontNames.get(manifest.id) ?? manifest.label,
    capability: manifest.capability,
    revision: manifest.revision,
    license: manifest.license,
    ...(Object.hasOwn(GROUPS, manifest.capability) ? { group: GROUPS[manifest.capability] } : {}),
    artifacts,
  })
}
if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('duplicate model ids')

const output = fileURLToPath(new URL('../models/video-editor-models.json', import.meta.url))
writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  source: `Studio apps/daemon/src/production-video-editor-models.ts @ ${commit}`,
  excluded,
  models,
}, null, 2)}\n`)
console.log(`${models.length} models written, ${Object.keys(excluded).length} left out`)
