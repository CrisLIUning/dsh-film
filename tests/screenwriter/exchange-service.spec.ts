/**
 * Screenplay import and export: Studio's StoryExchange cases
 * (apps/daemon/tests/screenwriter/exchange.test.ts), with two workspaces in
 * place of the source and target Studio projects, plus the Markdown and body
 * exports and the request checks.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseStoryMarkdown, projectStoryBody } from '../../src/screenwriter/contracts/index.js'
import type { StoryDocument, StoryReferencePackageManifest } from '../../src/screenwriter/contracts/index.js'
import { createProject } from '../../src/project.js'
import { StoryAssets } from '../../src/screenwriter/assets.js'
import { StoryExchange } from '../../src/screenwriter/exchange.js'
import { StoryService } from '../../src/screenwriter/service.js'

const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

describe('screenwriter reference package integrity and project isolation (Studio cases)', () => {
  let source: string
  let target: string
  let sourceBoard: string
  let targetBoard: string
  let story: StoryService
  let assets: StoryAssets
  let exchange: StoryExchange
  let document: StoryDocument

  beforeEach(async () => {
    source = await mkdtemp(path.join(os.tmpdir(), 'story-exchange-source-'))
    target = await mkdtemp(path.join(os.tmpdir(), 'story-exchange-target-'))
    sourceBoard = (await createProject(source, { title: '引用包', aspectRatio: '16:9' })).project.id
    targetBoard = (await createProject(target, { title: '副本', aspectRatio: '16:9' })).project.id
    story = new StoryService()
    assets = new StoryAssets(story)
    exchange = new StoryExchange(story, assets)
    const created = await story.create(source, { title: '引用包', content: '# 原文\n\n<!-- author:keep  空格 -->\n还没写完——' })
    document = (await story.apply(source, created.document.documentId, {
      expectedRevision: created.document.revision,
      operations: [{ kind: 'upsertEntity', entity: { id: 'person', kind: 'person', profileBlockId: 'profile' }, profileMarkdown: '### 林岚\n\n匿名身份也有效。' }],
    })).document
    await mkdir(path.join(source, 'film', 'images'))
    await writeFile(path.join(source, 'film', 'images/a.png'), 'A bytes')
    document = (await assets.bind(source, document.documentId, {
      expectedRevision: document.revision, filePath: 'images/a.png', expectedSha256: digest('A bytes'),
      target: { kind: 'entity', id: 'person' }, scope: { kind: 'document' }, purpose: 'appearance', primary: true,
    }, sourceBoard)).document
  })

  afterEach(async () => {
    await rm(source, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  })

  const film = (root: string, ...parts: string[]): string => path.join(root, 'film', ...parts)
  const packed = async () => {
    const result = await exchange.export(source, sourceBoard, document.documentId, { expectedRevision: document.revision, mode: 'package' })
    return { result, zip: await JSZip.loadAsync(Buffer.from(result.content, 'base64')), manifest: result.manifest! }
  }
  const repackage = async (zip: JSZip, manifest: StoryReferencePackageManifest) => {
    zip.file('manifest.json', JSON.stringify(manifest))
    return { format: 'package' as const, encoding: 'base64' as const, content: await zip.generateAsync({ type: 'base64' }) }
  }

  it('locks source revision separately from packaged Markdown bytes and preserves the source project', async () => {
    const { result, zip, manifest } = await packed()
    const markdown = await zip.file('screenplay.md')!.async('string')
    expect(manifest.revision).toBe(digest(document.content))
    expect(manifest.markdownSha256).toBe(digest(markdown))
    expect(manifest.markdownSha256).not.toBe(manifest.revision)
    expect(markdown).toContain('references/')
    expect(await readFile(path.join(source, document.filePath), 'utf8')).toBe(document.content)
    expect(await readFile(film(source, 'images/a.png'), 'utf8')).toBe('A bytes')
    // The package is saved in the film and named for download through the raw route.
    expect(result.filePath).toMatch(new RegExp(`^story-exports/${document.documentId}-[0-9a-f-]{36}\\.zip$`, 'u'))
    expect(result.workspacePath).toBe(`film/${result.filePath!}`)
    expect(result.downloadPath).toBe(`/api/projects/${sourceBoard}/raw/${result.filePath!}`)
    expect(await readFile(film(source, ...result.filePath!.split('/')))).toEqual(Buffer.from(result.content, 'base64'))
    expect(result).toMatchObject({ fileName: '引用包.zip', mimeType: 'application/zip', encoding: 'base64' })
  })

  it('imports a reviewed copy with new document/entity/asset identities and selected bytes', async () => {
    const { result } = await packed()
    const input = { format: 'package' as const, encoding: 'base64' as const, content: result.content }
    const preview = await exchange.preview(input)
    expect(preview).toMatchObject({ format: 'native', semanticEditable: true, entityCount: 1, copy: true, files: [{ sha256: digest('A bytes'), sizeBytes: 7 }] })
    const imported = await exchange.import(target, { ...input, expectedPreviewDigest: preview.digest })
    const metadata = imported.document.parsed.metadata!
    const asset = metadata.assets[0]!
    expect(imported.document.documentId).not.toBe(document.documentId)
    expect(metadata.entities[0]?.id).not.toBe('person')
    expect(asset.id).not.toBe(document.parsed.metadata!.assets[0]!.id)
    expect(asset.versionId).toBe(document.parsed.metadata!.assets[0]!.versionId)
    expect(metadata.bindings[0]?.assetId).toBe(asset.id)
    expect((await assets.readReference(target, imported.document, asset.id, asset.versionId, targetBoard)).buffer.toString()).toBe('A bytes')
    expect(imported.document.content).toContain('<!-- author:keep  空格 -->')
    expect(await readFile(film(source, 'images/a.png'), 'utf8')).toBe('A bytes')
  })

  it('refuses unreviewed or changed import payloads before material is written', async () => {
    const { result } = await packed()
    const input = { format: 'package' as const, encoding: 'base64' as const, content: result.content }
    const before = await readdir(film(target))
    await expect(exchange.import(target, input)).rejects.toMatchObject({ code: 'STORY_IMPORT_PREVIEW_REQUIRED' })
    await expect(exchange.import(target, { ...input, expectedPreviewDigest: 'f'.repeat(64) })).rejects.toMatchObject({ status: 409, code: 'STORY_IMPORT_PREVIEW_REQUIRED' })
    expect(await readdir(film(target))).toEqual(before)
  })

  it('rejects altered Markdown even if every reference file still matches', async () => {
    const { zip, manifest } = await packed()
    zip.file('screenplay.md', (await zip.file('screenplay.md')!.async('string')) + '\n被悄悄修改')
    await expect(exchange.preview(await repackage(zip, manifest))).rejects.toMatchObject({ code: 'STORY_PACKAGE_MARKDOWN_CHECKSUM' })
  })

  it('rejects manifest rows that do not match Markdown identity, path or selected hash', async () => {
    for (const mutation of ['identity', 'path', 'hash', 'duplicate'] as const) {
      const { zip, manifest } = await packed()
      if (mutation === 'identity') manifest.files[0]!.assetId = 'unrelated_asset'
      if (mutation === 'path') manifest.files[0]!.path = `references/${'b'.repeat(64)}.png`
      if (mutation === 'hash') manifest.files[0]!.sha256 = 'b'.repeat(64)
      if (mutation === 'duplicate') manifest.files.push({ ...manifest.files[0]!, assetId: 'unrelated_asset' })
      await expect(exchange.preview(await repackage(zip, manifest))).rejects.toMatchObject({ code: 'STORY_PACKAGE_REFERENCE_MISMATCH' })
    }
  })

  it('explicitly degrades a physically missing reference instead of marking its package complete', async () => {
    const { zip, manifest } = await packed()
    zip.remove(manifest.files[0]!.path)
    const input = await repackage(zip, manifest)
    const preview = await exchange.preview(input)
    expect(preview.manifest?.complete).toBe(false)
    expect(preview.manifest?.missing).toHaveLength(1)
    const imported = await exchange.import(target, { ...input, expectedPreviewDigest: preview.digest })
    expect(imported.document.parsed.metadata?.bindings).toHaveLength(1)
    expect((await assets.resolve(target, imported.document, targetBoard)).references[0]?.status).toBe('missing')
  })

  it('detects omitted references and contradictory completeness declarations', async () => {
    const { zip, manifest } = await packed()
    manifest.files = []
    await expect(exchange.preview(await repackage(zip, manifest))).rejects.toMatchObject({ code: 'STORY_PACKAGE_REFERENCE_MISMATCH' })
    const second = await packed()
    second.manifest.missing.push({ assetId: second.manifest.files[0]!.assetId, assetVersionId: second.manifest.files[0]!.assetVersionId, status: 'missing' })
    await expect(exchange.preview(await repackage(second.zip, second.manifest))).rejects.toMatchObject({ code: 'STORY_PACKAGE_REFERENCE_MISMATCH' })
  })

  it('deduplicates identical bytes while keeping the two material and binding identities', async () => {
    await writeFile(film(source, 'images/also.jpg'), 'A bytes')
    document = (await assets.bind(source, document.documentId, {
      expectedRevision: document.revision, filePath: 'images/also.jpg', expectedSha256: digest('A bytes'),
      target: { kind: 'entity', id: 'person' }, scope: { kind: 'document' }, purpose: 'appearance', primary: false,
    }, sourceBoard)).document
    const { zip, manifest } = await packed()
    expect(manifest.files).toHaveLength(2)
    expect(new Set(manifest.files.map(file => file.assetId)).size).toBe(2)
    expect(new Set(manifest.files.map(file => file.path)).size).toBe(1)
    expect(Object.values(zip.files).filter(entry => !entry.dir && entry.name.startsWith('references/'))).toHaveLength(1)
  })

  it('preserves opaque author provenance and resolves valid uppercase source digests after copy', async () => {
    const original = document.parsed.metadata!.assets[0]!
    document = (await story.apply(source, document.documentId, {
      expectedRevision: document.revision,
      operations: [{ kind: 'upsertAsset', asset: { ...original, sha256: original.sha256.toUpperCase(), provenance: '作者原样记录，不转成对象' } }],
    })).document
    const { result, manifest } = await packed()
    const input = { format: 'package' as const, encoding: 'base64' as const, content: result.content }
    expect(manifest.files[0]?.sha256).toBe(original.sha256)
    const preview = await exchange.preview(input)
    const imported = await exchange.import(target, { ...input, expectedPreviewDigest: preview.digest })
    const asset = imported.document.parsed.metadata!.assets[0]!
    expect(asset.provenance).toBe('作者原样记录，不转成对象')
    expect(asset.originAssetId).toBe(original.id)
    expect(asset.projectRelativePath).toMatch(/^story-references\/import_/u)
    expect((await assets.readReference(target, imported.document, asset.id, asset.versionId, targetBoard)).buffer.toString()).toBe('A bytes')
  })

  it('does not resolve unsafe ZIP paths, corrupted bytes or invalid UTF-8 as a successful import', async () => {
    const unsafe = await packed()
    unsafe.zip.file('../private.png', 'private')
    await expect(exchange.preview(await repackage(unsafe.zip, unsafe.manifest))).rejects.toMatchObject({ code: 'STORY_PACKAGE_UNSAFE_PATH' })
    const corrupt = await packed()
    corrupt.zip.file(corrupt.manifest.files[0]!.path, 'B bytes')
    await expect(exchange.preview(await repackage(corrupt.zip, corrupt.manifest))).rejects.toMatchObject({ code: 'STORY_PACKAGE_CHECKSUM' })
    const invalid = await packed()
    const bytes = Buffer.from([0xff])
    invalid.zip.file('screenplay.md', bytes)
    invalid.manifest.markdownSha256 = digest(bytes)
    await expect(exchange.preview(await repackage(invalid.zip, invalid.manifest))).rejects.toMatchObject({ code: 'STORY_PACKAGE_TEXT_ENCODING' })
  })

  it('requires explicit incomplete export and retains unavailable binding identities in the imported copy', async () => {
    await rm(film(source, 'images/a.png'))
    await expect(exchange.export(source, sourceBoard, document.documentId, { expectedRevision: document.revision, mode: 'package' }))
      .rejects.toMatchObject({ status: 409, code: 'STORY_PACKAGE_INCOMPLETE', current: { revision: document.revision } })
    const exported = await exchange.export(source, sourceBoard, document.documentId, { expectedRevision: document.revision, mode: 'package', allowMissing: true })
    const input = { format: 'package' as const, encoding: 'base64' as const, content: exported.content }
    const preview = await exchange.preview(input)
    expect(preview.files).toEqual([])
    expect(preview.manifest?.complete).toBe(false)
    const imported = await exchange.import(target, { ...input, expectedPreviewDigest: preview.digest })
    const original = document.parsed.metadata!.assets[0]!
    expect(imported.document.parsed.metadata?.assets[0]).toMatchObject({ versionId: original.versionId, sha256: original.sha256, provenance: { originAssetId: original.id } })
    expect(imported.document.parsed.metadata?.bindings[0]?.assetId).not.toBe(original.id)
    expect((await assets.resolve(target, imported.document, targetBoard)).references[0]?.status).toBe('missing')
  })

  it('stops oversized decompression before buffering, including falsely small declared references', async () => {
    const small = await packed()
    small.manifest.files[0]!.sizeBytes = 1
    await expect(exchange.preview(await repackage(small.zip, small.manifest))).rejects.toMatchObject({ code: 'STORY_PACKAGE_TOO_LARGE' })
    const big = await packed()
    const markdown = '#'.repeat(8 * 1024 * 1024 + 1)
    big.zip.file('screenplay.md', markdown)
    big.manifest.markdownSha256 = digest(markdown)
    await expect(exchange.preview(await repackage(big.zip, big.manifest))).rejects.toMatchObject({ code: 'STORY_PACKAGE_TOO_LARGE' })
  })

  it('removes only the fresh import directory after a document save failure', async () => {
    await mkdir(film(target, 'story-references/existing'), { recursive: true })
    await writeFile(film(target, 'story-references/existing/keep.png'), 'target-owned bytes')
    const { result } = await packed()
    const input = { format: 'package' as const, encoding: 'base64' as const, content: result.content }
    const preview = await exchange.preview(input)
    vi.spyOn(story, 'create').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(exchange.import(target, { ...input, expectedPreviewDigest: preview.digest })).rejects.toThrow('disk unavailable')
    expect(await readdir(film(target, 'story-references'))).toEqual(['existing'])
    expect(await readFile(film(target, 'story-references/existing/keep.png'), 'utf8')).toBe('target-owned bytes')
    expect(await readFile(film(source, 'images/a.png'), 'utf8')).toBe('A bytes')
  })

  it('returns client diagnostics for malformed ZIP, JSON and encodings', async () => {
    await expect(exchange.preview({ format: 'package', encoding: 'base64', content: Buffer.from('not zip').toString('base64') })).rejects.toMatchObject({ status: 400, code: 'STORY_PACKAGE_INVALID' })
    const invalid = await packed()
    invalid.zip.file('manifest.json', '{"incomplete":')
    await expect(exchange.preview({ format: 'package', encoding: 'base64', content: await invalid.zip.generateAsync({ type: 'base64' }) })).rejects.toMatchObject({ status: 400, code: 'STORY_PACKAGE_FORMAT' })
    await expect(exchange.preview({ format: 'markdown', encoding: 'base64', content: 'abc=' })).rejects.toMatchObject({ code: 'STORY_IMPORT_FORMAT' })
  })

  it('never downgrades unknown native Markdown or invents relationships during plain Markdown import', async () => {
    const unknown = document.content.replace('"1.0"', '"99.0"')
    const preview = await exchange.preview({ format: 'markdown', content: unknown })
    const imported = await exchange.import(target, { format: 'markdown', content: unknown, expectedPreviewDigest: preview.digest })
    expect(imported.document.content).toBe(unknown)
    expect(imported.document.parsed.semanticEditable).toBe(false)
    const raw = '﻿# 普通稿\r\n\r\n林岚：\r\n<!-- 保留  -->'
    const plainPreview = await exchange.preview({ format: 'markdown', content: raw })
    const plain = await exchange.import(target, { format: 'markdown', content: raw, expectedPreviewDigest: plainPreview.digest })
    expect(plain.document.content.endsWith(raw.slice(1))).toBe(true)
    expect(parseStoryMarkdown(plain.document.content).metadata?.entities).toEqual([])
  })

  // Beyond Studio's file: the text exports, the remaining request checks and package refusals.

  it('exports the exact saved Markdown and its body, pinned to the saved revision', async () => {
    const markdown = await exchange.export(source, sourceBoard, document.documentId, { expectedRevision: document.revision, mode: 'markdown' })
    expect(markdown).toEqual({
      documentId: document.documentId, revision: document.revision, fileName: '引用包.md', mimeType: 'text/markdown', encoding: 'utf8', content: document.content, completeRelations: true,
    })
    const body = await exchange.export(source, sourceBoard, document.documentId, { expectedRevision: document.revision, mode: 'body' })
    expect(body).toMatchObject({ fileName: '引用包-body.md', content: projectStoryBody(document.content), completeRelations: false })
    expect(parseStoryMarkdown(body.content).format).toBe('plain')
    expect(body.content).toContain('<!-- author:keep  空格 -->')
    await expect(exchange.export(source, sourceBoard, document.documentId, { expectedRevision: 'stale', mode: 'markdown' }))
      .rejects.toMatchObject({ status: 409, code: 'STORY_CONFLICT', current: { revision: document.revision } })
    await expect(exchange.export(source, sourceBoard, document.documentId, { expectedRevision: document.revision, mode: 'pdf' as never }))
      .rejects.toMatchObject({ status: 400, code: 'STORY_EXPORT_MODE' })
    // Text exports write nothing.
    await expect(readdir(film(source, 'story-exports'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('names exports after the title with unsafe characters replaced', async () => {
    const titled = await story.apply(source, document.documentId, { expectedRevision: document.revision, operations: [{ kind: 'updateDocument', changes: { title: 'a/b:c*?' } }] })
    const result = await exchange.export(source, sourceBoard, document.documentId, { expectedRevision: titled.document.revision, mode: 'body' })
    expect(result.fileName).toBe('a-b-c---body.md')
  })

  it('refuses packages of screenplays whose metadata needs repair', async () => {
    const broken = await story.create(source, { content: document.content.replace('"1.0"', '"99.0"') })
    await expect(exchange.export(source, sourceBoard, broken.document.documentId, { expectedRevision: broken.document.revision, mode: 'package' }))
      .rejects.toMatchObject({ status: 422, code: 'STORY_UNRESOLVED_REFERENCES' })
  })

  it('checks import requests: content, format, size, encoding and base64', async () => {
    await expect(exchange.preview(undefined as never)).rejects.toMatchObject({ status: 400, code: 'STORY_IMPORT_CONTENT_REQUIRED' })
    await expect(exchange.preview({ format: 'markdown' } as never)).rejects.toMatchObject({ status: 400, code: 'STORY_IMPORT_CONTENT_REQUIRED' })
    await expect(exchange.preview({ format: 'docx', content: 'x' } as never)).rejects.toMatchObject({ status: 400, code: 'STORY_IMPORT_FORMAT' })
    await expect(exchange.preview({ format: 'package', content: 'abcd' })).rejects.toMatchObject({ status: 400, code: 'STORY_IMPORT_FORMAT' })
    await expect(exchange.preview({ format: 'package', encoding: 'base64', content: 'ab$d' })).rejects.toMatchObject({ status: 400, code: 'STORY_IMPORT_FORMAT' })
    await expect(exchange.preview({ format: 'package', encoding: 'base64', content: 'abc' })).rejects.toMatchObject({ status: 400, code: 'STORY_IMPORT_FORMAT' })
    await expect(exchange.preview({ format: 'markdown', content: 'x'.repeat(8 * 1024 * 1024 + 1) })).rejects.toMatchObject({ status: 413, code: 'STORY_TOO_LARGE' })
    await expect(exchange.preview({ format: 'markdown', content: '剧本\uD800' })).rejects.toMatchObject({ status: 400, code: 'STORY_PACKAGE_TEXT_ENCODING' })
    await expect(exchange.preview({ format: 'package', encoding: 'base64', content: 'A'.repeat(Math.ceil(64 * 1024 * 1024 / 3) * 4 + 8) })).rejects.toMatchObject({ status: 413, code: 'STORY_PACKAGE_TOO_LARGE' })
  })

  it('refuses packages without a manifest or screenplay, with a foreign manifest, a mismatched identity or a bad file row', async () => {
    const noManifest = await packed()
    noManifest.zip.remove('manifest.json')
    await expect(exchange.preview({ format: 'package', encoding: 'base64', content: await noManifest.zip.generateAsync({ type: 'base64' }) })).rejects.toMatchObject({ code: 'STORY_PACKAGE_MANIFEST_MISSING' })
    const noMarkdown = await packed()
    noMarkdown.zip.remove('screenplay.md')
    await expect(exchange.preview(await repackage(noMarkdown.zip, noMarkdown.manifest))).rejects.toMatchObject({ code: 'STORY_PACKAGE_MARKDOWN_MISSING' })
    const foreign = await packed()
    await expect(exchange.preview(await repackage(foreign.zip, { ...foreign.manifest, formatVersion: '2.0' as '1.0' }))).rejects.toMatchObject({ code: 'STORY_PACKAGE_FORMAT' })
    const identity = await packed()
    await expect(exchange.preview(await repackage(identity.zip, { ...identity.manifest, documentId: 'doc_other' }))).rejects.toMatchObject({ code: 'STORY_PACKAGE_REFERENCE_MISMATCH' })
    const row = await packed()
    row.manifest.files[0]!.path = '../a.png'
    await expect(exchange.preview(await repackage(row.zip, row.manifest))).rejects.toMatchObject({ code: 'STORY_PACKAGE_FILE_INVALID' })
    const tooMany = await packed()
    for (let index = 0; index < 2048; index++) tooMany.zip.file(`extra/${index}.txt`, '')
    await expect(exchange.preview(await repackage(tooMany.zip, tooMany.manifest))).rejects.toMatchObject({ status: 413, code: 'STORY_PACKAGE_TOO_MANY_FILES' })
  })

  it('imports plain Markdown as an untitled copy, a package without bound references as Markdown, and never into an existing document', async () => {
    const preview = await exchange.preview({ format: 'markdown', content: '# 点子\n\n一个人在雨夜等车。' })
    expect(preview).toMatchObject({ format: 'plain', entityCount: 0, sceneCount: 0, files: [], copy: true })
    expect(preview.manifest).toBeUndefined()
    const first = await exchange.import(target, { format: 'markdown', content: '# 点子\n\n一个人在雨夜等车。', expectedPreviewDigest: preview.digest })
    const second = await exchange.import(target, { format: 'markdown', content: '# 点子\n\n一个人在雨夜等车。', expectedPreviewDigest: preview.digest })
    expect(first.document.title).toBe('')
    expect(second.document.documentId).not.toBe(first.document.documentId)
    expect((await story.list(target)).documents).toHaveLength(2)
    const created = await story.create(source, { title: '无参考' })
    const bare = await exchange.export(source, sourceBoard, created.document.documentId, { expectedRevision: created.document.revision, mode: 'package' })
    expect(bare.manifest).toMatchObject({ complete: true, files: [], missing: [] })
    const input = { format: 'package' as const, encoding: 'base64' as const, content: bare.content }
    const copy = await exchange.import(target, { ...input, expectedPreviewDigest: (await exchange.preview(input)).digest })
    expect(copy.document.title).toBe('无参考')
    await expect(readdir(film(target, 'story-references'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
