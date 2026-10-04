/**
 * Screenplay import and export through the Studio router: Studio's routes and
 * its UI round trip (e2e/ui/screenwriter-editing.test.ts: bind, export a
 * package, import the ZIP elsewhere), the events they announce, the raw
 * download of a package, and the router's body limits.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectStoryBody } from '../../src/screenwriter/contracts/index.js'
import type { StoryDocument, StoryExportResult, StoryImportPreview } from '../../src/screenwriter/contracts/index.js'
import { createProject } from '../../src/project.js'
import { createStudioRouter } from '../../src/routes.js'
import { ProjectEvents } from '../../src/studio/events.js'
import type { ProjectEvent } from '../../src/studio/events.js'
import { JSON_BODY_LIMIT } from '../../src/studio/router.js'

const digest = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')

let source: string
let target: string
let board: string
let events: ProjectEvents
let seen: ProjectEvent[]
let router: ReturnType<typeof createStudioRouter>

beforeEach(async () => {
  source = await mkdtemp(path.join(os.tmpdir(), 'story-exchange-routes-'))
  target = await mkdtemp(path.join(os.tmpdir(), 'story-exchange-routes-target-'))
  board = (await createProject(source, { title: '雨夜来客', aspectRatio: '16:9' })).project.id
  await createProject(target, { title: '副本', aspectRatio: '16:9' })
  events = new ProjectEvents()
  seen = []
  events.subscribe(source, (event) => { seen.push(event) })
  events.subscribe(target, (event) => { seen.push(event) })
  router = createStudioRouter({ events })
})

afterEach(async () => {
  await rm(source, { recursive: true, force: true })
  await rm(target, { recursive: true, force: true })
})

function call(cwd: string, studioPath: string, method = 'GET', json?: unknown): Promise<Response> {
  const url = new URL(`http://host/api/dsh-film/${method === 'GET' ? 'studio' : 'studio-write'}`)
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', studioPath)
  if (method !== 'GET' && method !== 'POST') url.searchParams.set('method', method)
  return router.dispatch(new Request(url, {
    method: method === 'GET' ? 'GET' : 'POST',
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } } : {}),
  }))
}

async function ok<T>(response: Promise<Response>): Promise<T> {
  const answer = await response
  const body = await answer.json() as T
  expect(answer.status, JSON.stringify(body)).toBe(200)
  return body
}

/** A screenplay with a person and a bound reference image, made through the routes. */
async function boundScreenplay(): Promise<StoryDocument> {
  const documents = `/api/projects/${board}/story/documents`
  const created = await ok<{ document: StoryDocument }>(call(source, documents, 'POST', { title: '雨夜来客' }))
  const withPerson = await ok<{ document: StoryDocument }>(call(source, `${documents}/${created.document.documentId}/operations`, 'POST', {
    expectedRevision: created.document.revision,
    operations: [{ kind: 'upsertEntity', entity: { id: 'person', kind: 'person', profileBlockId: 'profile' }, profileMarkdown: '### 林岚\n' }],
  }))
  await mkdir(path.join(source, 'film', 'images'))
  await writeFile(path.join(source, 'film', 'images', 'face.png'), 'face bytes')
  const bound = await ok<{ document: StoryDocument }>(call(source, `${documents}/${created.document.documentId}/bindings`, 'POST', {
    expectedRevision: withPerson.document.revision, filePath: 'images/face.png', expectedSha256: digest('face bytes'),
    target: { kind: 'entity', id: 'person' }, scope: { kind: 'document' }, purpose: 'appearance', primary: true,
  }))
  return bound.document
}

describe('import and export routes', () => {
  it('previews, then imports a native copy with new identities and announces it; the original is untouched', async () => {
    const document = await boundScreenplay()
    const exported = await ok<StoryExportResult>(call(source, `/api/projects/${board}/story/documents/${document.documentId}/export`, 'POST', { expectedRevision: document.revision, mode: 'markdown' }))
    expect(exported.content).toBe(document.content)
    const input = { format: 'markdown', content: exported.content }
    const preview = await ok<StoryImportPreview>(call(target, '/api/projects/any/story/import/preview', 'POST', input))
    expect(preview).toMatchObject({ format: 'native', semanticEditable: true, entityCount: 1, copy: true, files: [] })
    const stale = await call(target, '/api/projects/any/story/import', 'POST', { ...input, expectedPreviewDigest: 'f'.repeat(64) })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'CONFLICT' }, code: 'STORY_IMPORT_PREVIEW_REQUIRED' })
    const imported = await ok<{ changed: boolean; document: StoryDocument }>(call(target, '/api/projects/any/story/import', 'POST', { ...input, expectedPreviewDigest: preview.digest }))
    expect(imported.changed).toBe(true)
    expect(imported.document.documentId).not.toBe(document.documentId)
    expect(imported.document.parsed.metadata?.entities[0]?.id).not.toBe('person')
    expect(seen).toContainEqual({ type: 'story-changed', documentId: imported.document.documentId, revision: imported.document.revision })
    expect(await readFile(path.join(source, document.filePath), 'utf8')).toBe(document.content)
  })

  it('exports Markdown byte for byte and the body as its projection; a stale revision is a conflict with the current document', async () => {
    const document = await boundScreenplay()
    const exportPath = `/api/projects/${board}/story/documents/${document.documentId}/export`
    const body = await ok<StoryExportResult>(call(source, exportPath, 'POST', { expectedRevision: document.revision, mode: 'body' }))
    expect(body).toMatchObject({ content: projectStoryBody(document.content), completeRelations: false, fileName: '雨夜来客-body.md' })
    const stale = await call(source, exportPath, 'POST', { expectedRevision: 'old', mode: 'markdown' })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'STORY_CONFLICT', current: { documentId: document.documentId, revision: document.revision } })
    const missing = await call(source, exportPath, 'POST', {})
    expect(missing.status).toBe(409)
    const unknown = await call(source, `/api/projects/${board}/story/documents/doc_absent/export`, 'POST', { expectedRevision: 'x', mode: 'markdown' })
    expect(unknown.status).toBe(404)
    const empty = await call(source, '/api/projects/any/story/import/preview', 'POST')
    expect(await empty.json()).toMatchObject({ code: 'STORY_IMPORT_CONTENT_REQUIRED' })
  })

  it('round trip: a bound screenplay exported as a package downloads as a ZIP and imports elsewhere with its binding', async () => {
    const document = await boundScreenplay()
    seen.length = 0
    const exported = await ok<StoryExportResult & { workspacePath: string }>(call(source, `/api/projects/${board}/story/documents/${document.documentId}/export`, 'POST', {
      expectedRevision: document.revision, mode: 'package',
    }))
    expect(exported.manifest).toMatchObject({ complete: true, files: [{ sha256: digest('face bytes') }], missing: [] })
    expect(exported.workspacePath).toBe(`film/${exported.filePath!}`)
    expect(seen).toEqual([{ type: 'file-changed', projectId: board, path: exported.filePath }])
    const download = await router.dispatch(new Request(`http://host/api/dsh-film/studio?cwd=${encodeURIComponent(source)}&path=${encodeURIComponent(exported.downloadPath!)}`))
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/zip')
    expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from(exported.content, 'base64'))

    const input = { format: 'package', encoding: 'base64', content: exported.content }
    const preview = await ok<StoryImportPreview>(call(target, '/api/projects/any/story/import/preview', 'POST', input))
    expect(preview.files).toHaveLength(1)
    const imported = await ok<{ document: StoryDocument }>(call(target, '/api/projects/any/story/import', 'POST', { ...input, expectedPreviewDigest: preview.digest }))
    const metadata = imported.document.parsed.metadata!
    expect(imported.document.documentId).not.toBe(document.documentId)
    expect(metadata.bindings).toHaveLength(document.parsed.metadata!.bindings.length)
    expect(metadata.assets[0]!.id).not.toBe(document.parsed.metadata!.assets[0]!.id)
    const references = await ok<{ references: Array<{ status: string }> }>(call(target, `/api/projects/any/story/documents/${imported.document.documentId}/references`))
    expect(references.references).toEqual([expect.objectContaining({ status: 'available' })])
  })

  it('serves exported Markdown files with their type', async () => {
    await mkdir(path.join(source, 'film', 'story-exports'), { recursive: true })
    await writeFile(path.join(source, 'film', 'story-exports', 'a.md'), '# 稿')
    const response = await call(source, `/api/projects/${board}/raw/story-exports/a.md`)
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
  })
})

describe('request bodies', () => {
  const post = (body: RequestInit['body'], type = 'application/json'): Promise<Response> => {
    const url = new URL('http://host/api/dsh-film/studio-write')
    url.searchParams.set('cwd', source)
    url.searchParams.set('path', '/api/projects/any/story/import/preview')
    return router.dispatch(new Request(url, { method: 'POST', body, headers: { 'content-type': type }, duplex: 'half' } as RequestInit))
  }

  it('refuses a body past the limit without buffering it whole', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > JSON_BODY_LIMIT + chunk.byteLength) { controller.close(); return }
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    const response = await post(stream)
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(sent).toBeLessThanOrEqual(JSON_BODY_LIMIT + 2 * chunk.byteLength)
  })

  it('refuses bytes that are not UTF-8 instead of reading them as replacement characters', async () => {
    const bytes = Buffer.concat([Buffer.from('{"format":"markdown","content":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])
    const response = await post(new Uint8Array(bytes))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' }, code: 'INVALID_UTF8_INPUT' })
    const fine = await post(JSON.stringify({ format: 'markdown', content: '剧本 � 保留' }))
    expect(fine.status).toBe(200)
  })
})
