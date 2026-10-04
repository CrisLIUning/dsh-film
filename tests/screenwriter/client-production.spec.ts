/**
 * The 剧本 tab's import, export, source, handoff and impact calls against the
 * real plugin routes (the client branch was built against a recording fake).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../../src/project.js'
import { createStudioRouter } from '../../src/routes.js'
import { storyApi } from '../../src/client/workbench/story/story-api.js'
import type { StoryApi } from '../../src/client/workbench/story/story-api.js'

/** What the import dialog sends for a picked file (exchange.ts importRequestFromFile, which needs the DOM). */
const importRequestFromFile = (name: string, bytes: Uint8Array) => /\.zip$/iu.test(name)
  ? { format: 'package' as const, encoding: 'base64' as const, content: Buffer.from(bytes).toString('base64') }
  : { format: 'markdown' as const, encoding: 'utf8' as const, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }

let cwd: string
let filmId: string
let api: StoryApi

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-story-production-'))
  filmId = (await createProject(cwd, { title: '雨夜来客', aspectRatio: '16:9' })).project.id
  const router = createStudioRouter()
  vi.stubGlobal('document', { baseURI: 'http://host/app/' })
  vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => router.dispatch(new Request(String(input), init)))
  api = storyApi(cwd, filmId)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(cwd, { recursive: true, force: true })
})

async function screenplay() {
  const created = await api.create({ title: '第一集', kind: 'short' })
  const result = await api.apply(created.document.documentId, {
    expectedRevision: created.document.revision,
    operationId: 'op-structure',
    operations: [
      { kind: 'upsertEntity', entity: { id: 'person_1', kind: 'person', profileBlockId: 'block_p1', visualIdentity: '戴斗笠' }, profileMarkdown: '### 陌生人\n\n不说话。\n' },
      { kind: 'upsertScene', scene: { id: 'scene_1', headingBlockId: 'block_h1', blockIds: ['block_h1', 'block_a1'] }, blocks: [
        { id: 'block_h1', kind: 'scene-heading', markdown: '## 客栈门口 · 夜\n' },
        { id: 'block_a1', kind: 'action', markdown: '雨很大，陌生人推门进来。\n' },
      ] },
    ],
  })
  return result.document
}

describe('import and export through the client', () => {
  it('previews and imports a copy, exports markdown, body and a package that imports again', async () => {
    const document = await screenplay()
    const markdown = await api.exportDocument(document.documentId, { expectedRevision: document.revision, mode: 'markdown' })
    expect(markdown.content).toBe(document.content)
    const body = await api.exportDocument(document.documentId, { expectedRevision: document.revision, mode: 'body' })
    expect(body.content).toContain('雨很大')
    expect(body.content).not.toContain('vibedev:screenwriter')

    const request = importRequestFromFile('第一集.md', new TextEncoder().encode(markdown.content!))
    const preview = await api.previewImport(request)
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/u)
    const copy = await api.importCopy({ ...request, expectedPreviewDigest: preview.digest })
    expect(copy.document.documentId).not.toBe(document.documentId)
    expect(copy.document.content).toContain('雨很大')

    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'face.png'), 'face')
    const [face] = await api.assets()
    const bound = await api.bind(document.documentId, {
      expectedRevision: document.revision, filePath: face!.filePath, expectedSha256: face!.sha256,
      target: { kind: 'entity', id: 'person_1' }, scope: { kind: 'document' }, purpose: 'appearance', primary: true, operationId: 'bind-face',
    })
    const pack = await api.exportDocument(document.documentId, { expectedRevision: bound.document.revision, mode: 'package' }) as { workspacePath?: string; filePath?: string; content?: string }
    const saved = pack.workspacePath ?? `film/${pack.filePath}`
    const zip = await readFile(join(cwd, ...saved.split('/')))
    const again = importRequestFromFile('package.zip', new Uint8Array(zip))
    const packagePreview = await api.previewImport(again)
    const imported = await api.importCopy({ ...again, expectedPreviewDigest: packagePreview.digest })
    expect(imported.document.parsed.metadata?.bindings).toHaveLength(1)
  })
})

describe('source, handoff and impact through the client', () => {
  it('reads a source, sends it to the board once, and reports the impact of an edit', async () => {
    const document = await screenplay()
    const source = await api.source(document.documentId, 'person_1')
    expect(source).toMatchObject({ objectId: 'person_1', revision: document.revision })
    const handed = await api.handoff(document.documentId, { expectedRevision: document.revision, objectId: 'person_1', boardId: filmId, production: { purpose: 'character-sheet', requestId: 'sheet-1' } })
    expect(handed).toMatchObject({ created: true })
    const again = await api.handoff(document.documentId, { expectedRevision: document.revision, objectId: 'person_1', boardId: filmId })
    expect(again.created).toBe(false)
    const board = JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'document.json'), 'utf8')) as { nodes: Array<{ type: string }> }
    expect(board.nodes.map(node => node.type).sort()).toEqual(['image', 'story-source'])

    const edited = await api.apply(document.documentId, {
      expectedRevision: document.revision, operationId: 'op-edit',
      operations: [{ kind: 'replaceBlock', blockId: 'block_p1', markdown: '### 陌生人\n\n开口了。\n' }],
    })
    // Impact follows adopted production conditions; a handoff alone adopts nothing.
    const impact = await api.impact(document.documentId)
    expect(impact).toMatchObject({ documentId: document.documentId, currentRevision: edited.document.revision, items: [] })
    await expect(api.handoff(document.documentId, { expectedRevision: edited.document.revision, objectId: 'person_1', boardId: 'another-board' })).rejects.toMatchObject({ code: 'STORY_BOARD_MISMATCH' })
  })
})
