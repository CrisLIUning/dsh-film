/** Reference images of the screenplays: Studio's StoryAssets cases, plus the board, the routes and the film's paths. */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoryBindRequest, StoryDocument } from '../../src/screenwriter/contracts/index.js'
import { createProject } from '../../src/project.js'
import { createStudioRouter } from '../../src/routes.js'
import { StoryAssets, referencesFilmFile } from '../../src/screenwriter/assets.js'
import { StoryService } from '../../src/screenwriter/service.js'
import { ProjectEvents } from '../../src/studio/events.js'
import type { ProjectEvent } from '../../src/studio/events.js'

const digest = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')

let cwd: string
let board: string
let story: StoryService
let assets: StoryAssets
let document: StoryDocument

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'story-assets-'))
  board = (await createProject(cwd, { title: '独立参考', aspectRatio: '16:9' })).project.id
  story = new StoryService()
  assets = new StoryAssets(story)
  const created = await story.create(cwd, { title: '独立参考' })
  document = (await story.apply(cwd, created.document.documentId, {
    expectedRevision: created.document.revision,
    operations: [{ kind: 'upsertEntity', entity: { id: 'person', kind: 'person', profileBlockId: 'profile' }, profileMarkdown: '### 匿名的人' }],
  })).document
  await mkdir(path.join(cwd, 'film', 'images'))
  await writeFile(path.join(cwd, 'film', 'images', 'a.png'), 'selected A bytes')
  await writeFile(path.join(cwd, 'film', 'images', 'b.png'), 'selected B bytes')
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const request = (doc: StoryDocument, more: Partial<StoryBindRequest> = {}): StoryBindRequest => ({
  expectedRevision: doc.revision, filePath: 'images/a.png', expectedSha256: digest('selected A bytes'),
  target: { kind: 'entity', id: 'person' }, scope: { kind: 'document' }, purpose: 'appearance', primary: true, ...more,
})
const film = (...parts: string[]): string => path.join(cwd, 'film', ...parts)

describe('screenwriter project reference identity and selected versions (Studio cases)', () => {
  it('binds once across retries, keeps original files untouched and records the chosen byte version', async () => {
    const input = request(document, { operationId: 'bind-once' })
    const bound = await assets.bind(cwd, document.documentId, input, board)
    const retry = await assets.bind(cwd, document.documentId, input, board)
    expect(retry.changed).toBe(false)
    expect(retry.document.parsed.metadata?.bindings).toHaveLength(1)
    const asset = bound.document.parsed.metadata!.assets[0]!
    expect(asset.sha256).toBe(input.expectedSha256)
    expect(asset.versionId).toBe(`sha256_${input.expectedSha256}`)
    expect(await readFile(film('images/a.png'), 'utf8')).toBe('selected A bytes')
    await writeFile(film('images/a.png'), 'changed later')
    await expect(assets.bind(cwd, document.documentId, request(bound.document), board)).rejects.toMatchObject({ code: 'STORY_ASSET_CHANGED' })
    await expect(assets.readReference(cwd, bound.document, asset.id, asset.versionId, board)).rejects.toMatchObject({ code: 'STORY_ASSET_UNAVAILABLE' })
  })

  it('retains binding extension data and compares target identity independent of JSON member order', async () => {
    const bound = await assets.bind(cwd, document.documentId, request(document), board)
    const binding = bound.document.parsed.metadata!.bindings[0]!
    const annotated = await story.apply(cwd, document.documentId, {
      expectedRevision: bound.document.revision,
      operations: [{ kind: 'upsertBinding', binding: { ...binding, target: { id: 'person', kind: 'entity' }, 'author-note': '保留绑定备注' } }],
    })
    const replaced = await assets.bind(cwd, document.documentId, request(annotated.document, { replaceBindingId: binding.id, filePath: 'images/b.png', expectedSha256: digest('selected B bytes') }), board)
    expect(replaced.document.parsed.metadata?.bindings[0]).toMatchObject({ id: binding.id, 'author-note': '保留绑定备注' })
    expect(replaced.document.parsed.metadata?.bindings).toHaveLength(1)
    expect(await readFile(film('images/a.png'), 'utf8')).toBe('selected A bytes')
  })

  it('resolves an unambiguous relocation and keeps the established asset identity when selected again', async () => {
    const bound = await assets.bind(cwd, document.documentId, request(document), board)
    const oldAsset = bound.document.parsed.metadata!.assets[0]!
    await rename(film('images/a.png'), film('images/renamed.png'))
    expect((await assets.resolve(cwd, bound.document, board)).references[0]).toMatchObject({ status: 'relocated', resolvedPath: 'images/renamed.png' })
    const rebound = await assets.bind(cwd, document.documentId, request(bound.document, { filePath: 'images/renamed.png', replaceBindingId: bound.document.parsed.metadata!.bindings[0]!.id }), board)
    expect(rebound.document.parsed.metadata?.bindings[0]?.assetId).toBe(oldAsset.id)
    expect(rebound.document.parsed.metadata?.assets).toHaveLength(1)
    expect(rebound.document.parsed.metadata?.assets[0]?.projectRelativePath).toBe('images/renamed.png')
  })

  it('does not collapse imported asset identities sharing identical paths or overwrite opaque provenance', async () => {
    const bound = await assets.bind(cwd, document.documentId, request(document), board)
    const original = bound.document.parsed.metadata!.assets[0]!
    const firstBinding = bound.document.parsed.metadata!.bindings[0]!
    const second = await story.apply(cwd, document.documentId, {
      expectedRevision: bound.document.revision,
      operations: [
        { kind: 'upsertAsset', asset: { ...original, id: 'independent_asset', provenance: '作者单独记录的来源', extension: { keep: true } } },
        { kind: 'upsertBinding', binding: { ...firstBinding, id: 'independent_binding', assetId: 'independent_asset', primary: false } },
      ],
    })
    const selected = await assets.bind(cwd, document.documentId, request(second.document, { replaceBindingId: 'independent_binding', primary: false }), board)
    expect(selected.document.parsed.metadata?.bindings.find(binding => binding.id === 'independent_binding')?.assetId).toBe('independent_asset')
    expect(selected.document.parsed.metadata?.assets.find(asset => asset.id === 'independent_asset')).toMatchObject({ provenance: '作者单独记录的来源', extension: { keep: true } })
    expect(selected.document.parsed.metadata?.assets).toHaveLength(2)
  })

  it('reads the selected historical bytes at a new path without treating current path bytes as that version', async () => {
    const bound = await assets.bind(cwd, document.documentId, request(document), board)
    await rename(film('images/a.png'), film('images/old-version.png'))
    await writeFile(film('images/a.png'), 'new version bytes')
    const reference = (await assets.resolve(cwd, bound.document, board)).references[0]!
    expect(reference).toMatchObject({ status: 'relocated', resolvedPath: 'images/old-version.png' })
    expect((await assets.readReference(cwd, bound.document, reference.asset.id, reference.asset.versionId, board)).buffer.toString()).toBe('selected A bytes')
  })

  it('reports equal-content relocation candidates as ambiguous instead of merging their identities', async () => {
    const bound = await assets.bind(cwd, document.documentId, request(document), board)
    await rm(film('images/a.png'))
    await writeFile(film('images/copy-one.png'), 'selected A bytes')
    await writeFile(film('images/copy-two.png'), 'selected A bytes')
    const reference = (await assets.resolve(cwd, bound.document, board)).references[0]!
    expect(reference.status).toBe('ambiguous')
    expect(reference.candidatePaths?.sort()).toEqual(['images/copy-one.png', 'images/copy-two.png'])
    await expect(assets.readReference(cwd, bound.document, reference.asset.id, reference.asset.versionId, board)).rejects.toMatchObject({ code: 'STORY_ASSET_UNAVAILABLE' })
  })

  it('unbind retries are harmless and preserve every project file', async () => {
    const bound = await assets.bind(cwd, document.documentId, request(document), board)
    const bindingId = bound.document.parsed.metadata!.bindings[0]!.id
    const removed = await assets.unbind(cwd, document.documentId, bindingId, bound.document.revision)
    const replay = await assets.unbind(cwd, document.documentId, bindingId, bound.document.revision)
    expect(removed.document.parsed.metadata?.bindings).toEqual([])
    expect(replay.changed).toBe(false)
    expect(await readFile(film('images/a.png'), 'utf8')).toBe('selected A bytes')
  })
})

describe('reference images in the film', () => {
  it('lists the film\'s images with the board nodes that show them, and leaves other media out', async () => {
    await writeFile(film('images', 'clip.mp4'), 'video')
    await mkdir(film('canvas'), { recursive: true })
    await writeFile(film('canvas', 'document.json'), JSON.stringify({
      id: board, nodes: [
        { id: 'img-a', type: 'image', metadata: { content: `/api/projects/${board}/raw/images/a.png` } },
        { id: 'img-a-bak', type: 'image', metadata: { content: `/api/projects/${board}/raw/images/a.png.bak` } },
        { id: 'img-b', type: 'image', metadata: { content: `/api/projects/${board}/raw/images/b.png?v=2` } },
      ], connections: [],
    }))
    const { assets: listed } = await assets.candidates(cwd, board)
    expect(listed.map(item => item.filePath).sort()).toEqual(['images/a.png', 'images/b.png'])
    expect(listed.find(item => item.filePath === 'images/a.png')).toMatchObject({ sha256: digest('selected A bytes'), mimeType: 'image/png', sizeBytes: 16, canvasNodeIds: ['img-a'] })
    expect(listed.find(item => item.filePath === 'images/b.png')?.canvasNodeIds).toEqual(['img-b'])
  })

  it('tells a changed file at the recorded path from a missing one, and refuses unsafe paths', async () => {
    const bound = await assets.bind(cwd, document.documentId, request(document), board)
    await writeFile(film('images/a.png'), 'other bytes')
    expect((await assets.resolve(cwd, bound.document, board)).references[0]?.status).toBe('version-mismatch')
    await rm(film('images/a.png'))
    expect((await assets.resolve(cwd, bound.document, board)).references[0]?.status).toBe('missing')
    const asset = bound.document.parsed.metadata!.assets[0]!
    const unsafe = await story.apply(cwd, document.documentId, {
      expectedRevision: bound.document.revision,
      operations: [{ kind: 'upsertAsset', asset: { ...asset, id: 'outside', projectRelativePath: '../secret.png' } }],
    })
    expect((await assets.resolve(cwd, unsafe.document, board)).references.find(item => item.asset.id === 'outside')?.status).toBe('missing')
  })

  it('keeps one main reference per card, scope and purpose, and promotes another when the main one goes', async () => {
    const first = await assets.bind(cwd, document.documentId, request(document, { operationId: 'first' }), board)
    const second = await assets.bind(cwd, document.documentId, request(first.document, { operationId: 'second', filePath: 'images/b.png', expectedSha256: digest('selected B bytes') }), board)
    const bindings = second.document.parsed.metadata!.bindings
    expect(bindings.map(binding => binding.primary)).toEqual([false, true])
    const removed = await assets.unbind(cwd, document.documentId, bindings[1]!.id, second.document.revision)
    expect(removed.document.parsed.metadata!.bindings).toEqual([expect.objectContaining({ id: bindings[0]!.id, primary: true })])
  })

  it('refuses a replacement of another card, a file outside the library and a missing version', async () => {
    const bound = await assets.bind(cwd, document.documentId, request(document), board)
    const binding = bound.document.parsed.metadata!.bindings[0]!
    await expect(assets.bind(cwd, document.documentId, request(bound.document, { replaceBindingId: binding.id, scope: { kind: 'scene', sceneId: 'nope' } }), board))
      .rejects.toMatchObject({ code: 'STORY_BINDING_TARGET_MISMATCH' })
    await writeFile(film('images', 'clip.mp4'), 'video')
    await expect(assets.bind(cwd, document.documentId, request(bound.document, { filePath: 'images/clip.mp4', expectedSha256: digest('video') }), board))
      .rejects.toMatchObject({ code: 'STORY_ASSET_NOT_FOUND' })
    await expect(assets.bind(cwd, document.documentId, request(bound.document, { expectedSha256: 'abc' }), board))
      .rejects.toMatchObject({ code: 'STORY_ASSET_VERSION_REQUIRED' })
  })

  it('names a film file only by a URL that ends at its path', () => {
    expect(referencesFilmFile({ content: '/api/projects/p/raw/images/a.png' }, 'images/a.png')).toBe(true)
    expect(referencesFilmFile({ content: '/api/projects/p/raw/images/a.png#frame' }, 'images/a.png')).toBe(true)
    expect(referencesFilmFile({ list: [{ url: '/api/projects/p/raw/images/a.png.bak' }] }, 'images/a.png')).toBe(false)
    expect(referencesFilmFile({ content: '/api/projects/p/raw/%E9%95%9C%201.png' }, '镜 1.png')).toBe(true)
    expect(referencesFilmFile({ path: 'images/a.png' }, 'images/a.png')).toBe(true)
  })
})

describe('reference routes', () => {
  function call(router: ReturnType<typeof createStudioRouter>, studioPath: string, method = 'GET', json?: unknown) {
    const url = new URL(`http://host/api/dsh-film/${method === 'GET' ? 'studio' : 'studio-write'}`)
    url.searchParams.set('cwd', cwd)
    url.searchParams.set('path', studioPath)
    if (method !== 'GET' && method !== 'POST') url.searchParams.set('method', method)
    return router.dispatch(new Request(url, {
      method: method === 'GET' ? 'GET' : 'POST',
      ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } } : {}),
    }))
  }

  it('list, bind, resolve, read the bound bytes and unbind — announcing each saved change', async () => {
    const events = new ProjectEvents()
    const seen: ProjectEvent[] = []
    events.subscribe(cwd, (event) => { seen.push(event) })
    const router = createStudioRouter({ events })
    const documents = `/api/projects/${board}/story/documents/${document.documentId}`
    const listed = await (await call(router, `/api/projects/any-id/story/assets`)).json() as { assets: Array<{ filePath: string; sha256: string }> }
    const a = listed.assets.find(item => item.filePath === 'images/a.png')!
    const bound = await call(router, `${documents}/bindings`, 'POST', {
      expectedRevision: document.revision, filePath: a.filePath, expectedSha256: a.sha256,
      target: { kind: 'entity', id: 'person' }, scope: { kind: 'document' }, purpose: 'appearance', primary: true, operationId: 'route-bind',
    })
    expect(bound.status).toBe(200)
    const result = await bound.json() as { changed: boolean; document: StoryDocument }
    expect(result.changed).toBe(true)
    expect(seen.filter(event => event.type === 'story-changed')).toHaveLength(1)
    const asset = result.document.parsed.metadata!.assets[0]!
    const references = await (await call(router, `${documents}/references`)).json() as { references: Array<{ status: string }> }
    expect(references.references).toEqual([expect.objectContaining({ status: 'available', resolvedPath: 'images/a.png' })])
    const bytes = await call(router, `${documents}/references/${asset.id}/${asset.versionId}`)
    expect(bytes.headers.get('content-type')).toBe('image/png')
    expect(bytes.headers.get('content-security-policy')).toContain('sandbox')
    expect(bytes.headers.get('content-disposition')).toBeNull()
    expect(await bytes.text()).toBe('selected A bytes')
    await writeFile(film('images/a.png'), 'changed')
    const refused = await call(router, `${documents}/references/${asset.id}/${asset.versionId}`)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: 'CONFLICT' }, code: 'STORY_ASSET_UNAVAILABLE' })
    const binding = result.document.parsed.metadata!.bindings[0]!
    const unbound = await call(router, `${documents}/bindings/${binding.id}`, 'DELETE', { expectedRevision: result.document.revision })
    expect(((await unbound.json()) as { document: StoryDocument }).document.parsed.metadata!.bindings).toEqual([])
    expect(seen.filter(event => event.type === 'story-changed')).toHaveLength(2)
  })
})
