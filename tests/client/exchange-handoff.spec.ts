/**
 * Import, export, 送到画布 and 制作影响 in the 剧本 tab: reading picked files,
 * the requests the dialogs build, how answers are summarised, the cross-tab
 * requests, and the calls `storyApi` sends (against a recording fake; the
 * plugin's routes for these are built elsewhere).
 * @module dsh-film/tests/client/exchange-handoff.spec
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoryExportResult, StoryImpactItem, StoryImportPreview } from '../../src/screenwriter/contracts/assets.ts'
import type { StoryMetadata } from '../../src/screenwriter/contracts/types.ts'
import { MAX_IMPORT_BYTES, ImportFileError, exportBytes, exportRequest, exportSummary, importApplyRequest, importPreviewSummary, importRequestFromFile } from '../../src/client/workbench/story/exchange.ts'
import { handoffFocusNode, handoffRequest, impactAction, impactItemKey, productionActions } from '../../src/client/workbench/story/handoff.ts'
import { StoryApiError, StoryConflictError, storyApi } from '../../src/client/workbench/story/story-api.ts'
import { onCanvasFocus, onStoryOpen, requestCanvasFocus, requestStoryOpen, takeCanvasFocus, takeStoryOpen } from '../../src/client/workbench/film-links.ts'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('reading a picked import file', () => {
  it('sends a ZIP as base64 and anything else as UTF-8 Markdown, keeping a byte-order mark', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00])
    const pkg = importRequestFromFile('剧本包.ZIP', zip)
    expect(pkg).toMatchObject({ format: 'package', encoding: 'base64' })
    expect(Uint8Array.from(atob(pkg.content), char => char.charCodeAt(0))).toEqual(zip)
    expect(importRequestFromFile('稿.md', utf8('\uFEFF# 雨夜\r\n'))).toEqual({ format: 'markdown', encoding: 'utf8', content: '\uFEFF# 雨夜\r\n' })
    expect(importRequestFromFile('notes.txt', utf8('点子'))).toMatchObject({ format: 'markdown', content: '点子' })
  })

  it('encodes a large package without overflowing the call stack', () => {
    const bytes = new Uint8Array(300_000).map((_, index) => index % 251)
    const pkg = importRequestFromFile('big.zip', bytes)
    expect(Uint8Array.from(atob(pkg.content), char => char.charCodeAt(0))).toEqual(bytes)
  })

  it('refuses text that is not UTF-8, and files over 64 MiB', () => {
    expect(() => importRequestFromFile('gbk.md', new Uint8Array([0xd3, 0xea, 0xff]))).toThrow(ImportFileError)
    const tooLarge = { byteLength: MAX_IMPORT_BYTES + 1 } as Uint8Array
    expect(() => importRequestFromFile('huge.zip', tooLarge)).toThrow(expect.objectContaining({ reason: 'too-large' }))
  })
})

describe('import and export requests and answers', () => {
  const preview: StoryImportPreview = {
    digest: 'digest-1',
    format: 'native',
    content: '...',
    diagnostics: [],
    semanticEditable: true,
    entityCount: 3,
    sceneCount: 2,
    files: [{ path: 'references/a.png', sha256: 'a'.repeat(64), sizeBytes: 3 }],
    manifest: {
      format: 'vibedev.screenwriter.package', formatVersion: '1.0', documentId: 'doc', revision: 'r', markdownPath: 'screenplay.md', markdownSha256: 'm', complete: false,
      files: [], missing: [{ assetId: 'asset_b', assetVersionId: 'v1', status: 'missing' }],
    },
    copy: true,
  }

  it('pins the copy to the previewed bytes', () => {
    const input = { format: 'markdown' as const, encoding: 'utf8' as const, content: '# x' }
    expect(importApplyRequest(input, preview)).toEqual({ ...input, expectedPreviewDigest: 'digest-1' })
    expect(importPreviewSummary(preview)).toEqual({ format: 'native', entities: 3, scenes: 2, references: 1, complete: false, missing: preview.manifest!.missing })
    expect(importPreviewSummary({ ...preview, manifest: undefined })).toMatchObject({ complete: undefined, missing: [] })
  })

  it('exports the saved revision, allowing missing references only for packages', () => {
    expect(exportRequest('rev', 'markdown', true)).toEqual({ expectedRevision: 'rev', mode: 'markdown' })
    expect(exportRequest('rev', 'package', false)).toEqual({ expectedRevision: 'rev', mode: 'package' })
    expect(exportRequest('rev', 'package', true)).toEqual({ expectedRevision: 'rev', mode: 'package', allowMissing: true })
  })

  it('summarises a package with distinct files and where it was saved, and decodes its bytes', () => {
    const result: StoryExportResult = {
      documentId: 'doc', revision: 'rev', fileName: '雨夜.zip', mimeType: 'application/zip', encoding: 'base64', content: btoa('PK'),
      manifest: { ...preview.manifest!, complete: true, missing: [], files: [
        { assetId: 'a', assetVersionId: 'v1', path: 'references/x.png', sha256: 'x', sizeBytes: 1 },
        { assetId: 'b', assetVersionId: 'v1', path: 'references/x.png', sha256: 'x', sizeBytes: 1 },
      ] },
      filePath: 'story-exports/doc-1.zip',
      downloadPath: '/api/projects/p/raw/story-exports/doc-1.zip',
    }
    expect(exportSummary(result)).toEqual({ fileName: '雨夜.zip', revision: 'rev', complete: true, paths: ['references/x.png'], missing: [], savedPath: 'film/story-exports/doc-1.zip' })
    expect(exportSummary({ ...result, workspacePath: 'film/story-exports/other.zip' }).savedPath).toBe('film/story-exports/other.zip')
    expect(exportBytes(result)).toEqual(new Uint8Array([0x50, 0x4b]))
    expect(exportBytes({ encoding: 'utf8', content: '# 正文' })).toBe('# 正文')
    expect(exportSummary({ ...result, manifest: undefined, filePath: undefined })).toMatchObject({ complete: undefined, paths: [], savedPath: undefined })
  })
})

describe('sending to the canvas and the impact report', () => {
  const metadata = {
    entities: [{ id: 'p', kind: 'person' }, { id: 'l', kind: 'place' }, { id: 'o', kind: 'prop' }],
  } as unknown as StoryMetadata

  it('offers a production image and the sheet each kind calls for', () => {
    expect(productionActions(metadata, { kind: 'shot', id: 's' })).toEqual({ image: 'shot', sheet: undefined })
    expect(productionActions(metadata, { kind: 'entity', id: 'p' })).toEqual({ image: 'image', sheet: 'character-sheet' })
    expect(productionActions(metadata, { kind: 'entity', id: 'l' })).toEqual({ image: 'image', sheet: 'scene-sheet' })
    expect(productionActions(metadata, { kind: 'entity', id: 'o' })).toEqual({ image: 'image', sheet: 'prop-sheet' })
    expect(productionActions(metadata, { kind: 'entity', id: 'gone' }).sheet).toBeUndefined()
  })

  it('sends against the saved revision with a fresh request id per production click', () => {
    let ids = 0
    const requestId = (): string => `req-${++ids}`
    expect(handoffRequest({ revision: 'rev', objectId: 'scene_1', boardId: 'film-1', requestId })).toEqual({ expectedRevision: 'rev', boardId: 'film-1', objectId: 'scene_1', scope: { kind: 'document' } })
    expect(ids).toBe(0)
    expect(handoffRequest({ revision: 'rev', objectId: 'p', boardId: 'film-1', scope: { kind: 'scene', sceneId: 'scene_2' }, purpose: 'character-sheet', requestId })).toEqual({
      expectedRevision: 'rev', boardId: 'film-1', objectId: 'p', scope: { kind: 'scene', sceneId: 'scene_2' }, production: { purpose: 'character-sheet', requestId: 'req-1' },
    })
    expect(handoffRequest({ revision: 'rev', objectId: 'p', boardId: 'film-1', purpose: 'image', requestId }).production?.requestId).toBe('req-2')
  })

  it('shows the production node when one was made, else the source card', () => {
    expect(handoffFocusNode({ node: { id: 'story-source-1' }, productionNode: { id: 'story-production-1' } })).toBe('story-production-1')
    expect(handoffFocusNode({ node: { id: 'story-source-1' } })).toBe('story-source-1')
  })

  it('keys impact items and leads them to the canvas node or the timeline', () => {
    const item: StoryImpactItem = { nodeId: 'node_1', objectId: 'p', objectKind: 'entity', title: 't', field: 'prompt', adoptedRevision: 'r', status: 'changed', manualChanged: false }
    expect(impactItemKey(item)).toBe('input:node_1::::prompt')
    expect(impactItemKey({ ...item, usageId: 'output:node_1:req:abc:p:references', field: 'references' })).toBe('output:node_1:req:abc:p:references:references')
    expect(impactAction(item)).toEqual({ kind: 'canvas', nodeId: 'node_1' })
    expect(impactAction({ ...item, nodeId: ' ' })).toEqual({ kind: 'none' })
    expect(impactAction({ ...item, sourceType: 'timeline-slot', nodeId: '' })).toEqual({ kind: 'timeline' })
    expect(impactAction({ ...item, sourceType: 'timeline-media' })).toEqual({ kind: 'timeline' })
  })
})

describe('requests between the tabs', () => {
  beforeEach(() => { vi.stubGlobal('window', new EventTarget()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('delivers a canvas focus to a showing storyboard and keeps it briefly for one still opening', () => {
    const seen: string[] = []
    const stop = onCanvasFocus('film-1', (nodeId) => { seen.push(nodeId) })
    requestCanvasFocus('film-2', 'other', 1000)
    requestCanvasFocus('film-1', 'node_a', 1000)
    expect(seen).toEqual(['node_a'])
    stop()
    requestCanvasFocus('film-1', 'node_b', 1000)
    expect(seen).toEqual(['node_a'])
    expect(takeCanvasFocus('film-1', 2000)).toBe('node_b')
    expect(takeCanvasFocus('film-1', 2000)).toBeUndefined()
    requestCanvasFocus('film-1', 'node_c', 1000)
    expect(takeCanvasFocus('film-1', 1000 + 31_000)).toBeUndefined()
    expect(takeCanvasFocus('film-2', 2000)).toBe('other')
  })

  it('hands a story-open request to the mounted 剧本 tab once, or to the next mount', () => {
    const seen: unknown[] = []
    const stop = onStoryOpen('film-1', (request) => { seen.push(request) })
    requestStoryOpen('film-1', { documentId: 'doc', objectId: 'person' }, 1000)
    expect(seen).toEqual([{ documentId: 'doc', objectId: 'person' }])
    expect(takeStoryOpen('film-1', 1000)).toBeUndefined()
    stop()
    requestStoryOpen('film-1', { documentId: 'doc', objectId: 'scene' }, 1000)
    expect(takeStoryOpen('film-1', 1500)).toEqual({ documentId: 'doc', objectId: 'scene' })
  })
})

describe('the calls storyApi sends', () => {
  let calls: { method: string; endpoint: string; path: string | null; verb: string | null; cwd: string | null; body: unknown }[]
  let reply: (path: string) => { status: number; body: unknown }

  beforeEach(() => {
    calls = []
    reply = () => ({ status: 200, body: {} })
    vi.stubGlobal('document', { baseURI: 'dsh-app://host/app/' })
    vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const path = url.searchParams.get('path')
      calls.push({
        method: init.method ?? 'GET',
        endpoint: url.pathname,
        path,
        verb: url.searchParams.get('method'),
        cwd: url.searchParams.get('cwd'),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      const answer = reply(path ?? '')
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const api = () => storyApi('C:/work/雨夜', 'film 1')

  it('previews, imports and exports through studio-write', async () => {
    await api().previewImport({ format: 'package', encoding: 'base64', content: 'UEs=' })
    await api().importCopy({ format: 'markdown', encoding: 'utf8', content: '# x', expectedPreviewDigest: 'd' })
    await api().exportDocument('doc/1', { expectedRevision: 'rev', mode: 'body' })
    expect(calls).toEqual([
      { method: 'POST', endpoint: '/app/api/dsh-film/studio-write', path: '/api/projects/film%201/story/import/preview', verb: 'POST', cwd: 'C:/work/雨夜', body: { format: 'package', encoding: 'base64', content: 'UEs=' } },
      { method: 'POST', endpoint: '/app/api/dsh-film/studio-write', path: '/api/projects/film%201/story/import', verb: 'POST', cwd: 'C:/work/雨夜', body: { format: 'markdown', encoding: 'utf8', content: '# x', expectedPreviewDigest: 'd' } },
      { method: 'POST', endpoint: '/app/api/dsh-film/studio-write', path: '/api/projects/film%201/story/documents/doc%2F1/export', verb: 'POST', cwd: 'C:/work/雨夜', body: { expectedRevision: 'rev', mode: 'body' } },
    ])
  })

  it('reads a source preview for a scope, hands off, and reads the impact report', async () => {
    await api().source('doc', 'person 1')
    await api().source('doc', 'person 1', { kind: 'scene', sceneId: 'scene 2' })
    await api().handoff('doc', { expectedRevision: 'rev', boardId: 'film 1', objectId: 'scene_1', scope: { kind: 'document' } })
    await api().impact('doc')
    expect(calls.map(call => [call.method, call.endpoint.split('/').pop(), call.path, call.verb])).toEqual([
      ['GET', 'studio', '/api/projects/film%201/story/documents/doc/source/person%201', null],
      ['GET', 'studio', '/api/projects/film%201/story/documents/doc/source/person%201?sceneId=scene%202', null],
      ['POST', 'studio-write', '/api/projects/film%201/story/documents/doc/handoff', 'POST'],
      ['GET', 'studio', '/api/projects/film%201/story/documents/doc/impact', null],
    ])
    expect(calls[2]!.body).toEqual({ expectedRevision: 'rev', boardId: 'film 1', objectId: 'scene_1', scope: { kind: 'document' } })
  })

  it('turns refusals into errors the dialogs can tell apart', async () => {
    reply = path => path.endsWith('/import')
      ? { status: 409, body: { error: { code: 'CONFLICT', message: 'Preview this exact import before creating its copy.' }, code: 'STORY_IMPORT_PREVIEW_REQUIRED' } }
      : { status: 409, body: { error: { code: 'CONFLICT', message: 'changed' }, code: 'STORY_CONFLICT', current: { documentId: 'doc', revision: 'r2' } } }
    await expect(api().importCopy({ format: 'markdown', content: '# x', expectedPreviewDigest: 'old' })).rejects.toMatchObject({ code: 'STORY_IMPORT_PREVIEW_REQUIRED', status: 409 })
    await expect(api().importCopy({ format: 'markdown', content: '# x', expectedPreviewDigest: 'old' })).rejects.toBeInstanceOf(StoryApiError)
    const stale = await api().exportDocument('doc', { expectedRevision: 'r1', mode: 'markdown' }).catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(StoryConflictError)
    expect((stale as StoryConflictError).current.revision).toBe('r2')
  })

  it('builds page URLs for film files, bound versions and Studio paths', () => {
    expect(new URL(api().fileUrl('canvas/media/雨 夜#1.png')).searchParams.get('path')).toBe('/api/projects/film%201/raw/canvas/media/%E9%9B%A8%20%E5%A4%9C%231.png')
    const reference = new URL(api().referenceUrl('doc', 'asset_1', 'sha256_ab'))
    expect([reference.pathname, reference.searchParams.get('path'), reference.searchParams.get('method')]).toEqual(['/app/api/dsh-film/studio', '/api/projects/film%201/story/documents/doc/references/asset_1/sha256_ab', null])
    expect(new URL(api().studioUrl('/api/projects/p/story/documents/d/references/a/v')).searchParams.get('path')).toBe('/api/projects/p/story/documents/d/references/a/v')
  })
})
