/** Screenplay sources for production: Studio's handoff and impact cases (tests/screenwriter/handoff.test.ts) on a film workspace. */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasDocumentStore } from '../../src/canvas/documents.js'
import type { CanvasDocument } from '../../src/canvas/documents.js'
import { createProject } from '../../src/project.js'
import { StoryAssets } from '../../src/screenwriter/assets.js'
import type { StoryDocument } from '../../src/screenwriter/contracts/index.js'
import { StoryHandoff } from '../../src/screenwriter/handoff.js'
import { StoryImpact } from '../../src/screenwriter/impact.js'
import { StoryService } from '../../src/screenwriter/service.js'

const nodesOf = (board: CanvasDocument | null) => (board?.nodes ?? []) as Array<Record<string, any>>

let cwd: string
let board: string
let story: StoryService
let assets: StoryAssets
let handoff: StoryHandoff
let boards: CanvasDocumentStore
const original = {
  id: 'production', type: 'image', title: '已制作', position: { x: 10, y: 20 }, width: 300, height: 280,
  metadata: { prompt: '人工制作描述', composerContent: '人工制作描述', references: ['original-reference'], model: 'chosen-model', content: 'generated-result', quality: 'high', texts: ['保留人工笔记'] },
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'story-handoff-'))
  board = (await createProject(cwd, { title: '制作', aspectRatio: '16:9' })).project.id
  story = new StoryService()
  assets = new StoryAssets(story)
  handoff = new StoryHandoff(story, assets)
  boards = new CanvasDocumentStore(cwd, board)
  await boards.write(board, { id: board, title: '制作', nodes: [original], connections: [], updatedAt: '2026-01-01' })
  await mkdir(path.join(cwd, 'film', 'canvas', 'media'), { recursive: true })
  await writeFile(path.join(cwd, 'film', 'canvas', 'media', 'a.png'), 'image-version-a')
  await writeFile(path.join(cwd, 'film', 'canvas', 'media', 'b.png'), 'image-version-b')
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function createBound(): Promise<StoryDocument> {
  const { document } = await story.create(cwd, { title: '短片' })
  const withEntity = await story.apply(cwd, document.documentId, { expectedRevision: document.revision, operations: [{ kind: 'upsertEntity', entity: { id: 'person', kind: 'person', profileBlockId: 'profile' }, profileMarkdown: '### 她\n\n把钥匙留在灯下。' }] })
  const a = (await assets.candidates(cwd, board)).assets.find(item => item.filePath === 'canvas/media/a.png')!
  return (await assets.bind(cwd, document.documentId, { expectedRevision: withEntity.document.revision, filePath: a.filePath, expectedSha256: a.sha256, target: { kind: 'entity', id: 'person' }, scope: { kind: 'document' }, purpose: 'identity', primary: true }, board)).document
}

describe('saved screenplay references and explicit production adoption (Studio cases)', () => {
  it('hands off an ordinary text body with complete screenplay provenance', async () => {
    const document = await createBound()
    const sent = await handoff.send(cwd, document.documentId, { expectedRevision: document.revision, objectId: 'person', boardId: board })
    expect(sent.node.type).toBe('text')
    expect(sent.node.metadata).toMatchObject({ content: sent.preview.productionText, storyNote: '', storySource: { projectId: board, documentId: document.documentId, objectId: 'person', scope: { kind: 'document' }, snapshot: sent.preview } })
    expect(nodesOf(await boards.read(board))).toEqual([original, sent.node])
  })

  it.each(['text', 'story-source'])('reuses %s sources without losing manual content, metadata, geometry or wires', async type => {
    const document = await createBound()
    const preview = await handoff.preview(cwd, document.documentId, 'person')
    const legacy = { id: 'legacy-source', type, title: '手写标题', position: { x: 610, y: 220 }, width: 390, height: 250, metadata: { content: '人工保留的说明', storyNote: '独立备注', custom: { keep: true }, storyDirectorLinks: { camera: [{ revision: 'old' }] }, storySource: { projectId: board, documentId: document.documentId, objectId: 'person', objectKind: 'entity', snapshot: preview } } }
    const connection = { id: 'old-wire', fromNodeId: legacy.id, toNodeId: original.id }
    await boards.update(current => ({ ...current!, nodes: [original, legacy], connections: [connection] }))
    const sent = await handoff.send(cwd, document.documentId, { expectedRevision: document.revision, objectId: 'person', boardId: board })
    expect(sent.created).toBe(false)
    expect(sent.node).toEqual({ ...legacy, type: 'text' })
    expect((await boards.read(board))!.connections).toEqual([connection])
    expect(nodesOf(await boards.read(board))).toEqual([original, { ...legacy, type: 'text' }])
  })

  it('converts a contentless legacy source from its saved snapshot and refreshes production text only while unedited', async () => {
    const document = await createBound()
    const preview = await handoff.preview(cwd, document.documentId, 'person')
    const legacy = { id: 'old-source', type: 'story-source', title: preview.title, position: { x: 450, y: 80 }, width: 340, height: 410, metadata: { storyNote: '独立备注', storySource: { projectId: board, documentId: document.documentId, objectId: 'person', objectKind: 'entity', snapshot: preview } } }
    await boards.update(current => ({ ...current!, nodes: [original, legacy] }))
    const changed = await story.apply(cwd, document.documentId, { expectedRevision: document.revision, operations: [{ kind: 'replaceBlock', blockId: 'profile', markdown: '### 她\n\n带走钥匙。' }] })
    const sent = await handoff.send(cwd, document.documentId, { expectedRevision: changed.document.revision, objectId: 'person', boardId: board, production: { purpose: 'image', requestId: 'refresh-source' } })
    expect(sent.node).toMatchObject({ id: legacy.id, type: 'text', position: legacy.position, metadata: { content: sent.preview.productionText, storyNote: '独立备注', storySource: { snapshot: sent.preview } } })
    await boards.update(current => ({ ...current!, nodes: nodesOf(current).map(node => node.id === legacy.id ? { ...node, metadata: { ...node.metadata, content: '本地新编辑' } } : node) }))
    const again = await handoff.send(cwd, document.documentId, { expectedRevision: changed.document.revision, objectId: 'person', boardId: board, production: { purpose: 'image', requestId: 'refresh-source' } })
    expect(again.node.metadata.content).toBe('本地新编辑')
    expect(again.node.id).toBe(legacy.id)
  })
  it('distinguishes an existing text block from a missing production entity', async () => {
    const document = await createBound()
    const block = document.parsed.blocks.find(item => item.id === 'profile')!
    await expect(handoff.preview(cwd, document.documentId, block.id)).rejects.toMatchObject({ code: 'STORY_SOURCE_KIND_UNSUPPORTED' })
    await expect(handoff.preview(cwd, document.documentId, 'absent')).rejects.toMatchObject({ code: 'STORY_SOURCE_NOT_FOUND' })
  })

  it('prepares an editable character sheet with one source wire and reuses the request id', async () => {
    const document = await createBound()
    const request = { expectedRevision: document.revision, objectId: 'person', boardId: board, production: { purpose: 'character-sheet' as const, requestId: 'prepare-person-1' } }
    const first = await handoff.send(cwd, document.documentId, request)
    expect(first.productionNode?.metadata).toMatchObject({ status: 'idle', promptPurpose: 'character-sheet', count: 1, storyProduction: { objectId: 'person', revision: document.revision } })
    expect(first.productionNode?.metadata.prompt).toContain('同一角色')
    expect(first.connection).toMatchObject({ fromNodeId: first.node.id, toNodeId: first.productionNode!.id })
    const again = await handoff.send(cwd, document.documentId, request)
    expect(again.productionNode?.id).toBe(first.productionNode!.id)
    const saved = await boards.read(board)
    expect(nodesOf(saved)).toHaveLength(3)
    expect(saved!.connections).toHaveLength(1)
    expect(nodesOf(saved)[0]).toEqual(original)
    await expect(handoff.send(cwd, document.documentId, { ...request, production: { ...request.production, purpose: 'image' } })).rejects.toMatchObject({ code: 'STORY_PRODUCTION_CONFLICT' })
    await expect(handoff.send(cwd, document.documentId, { ...request, production: { ...request.production, purpose: 'scene-sheet' } })).rejects.toMatchObject({ code: 'STORY_PRODUCTION_KIND' })
  })

  it('compiles production style and scene state without replacing the dramatic profile', async () => {
    const document = await createBound()
    const person = document.parsed.metadata!.entities[0]!
    const result = await story.apply(cwd, document.documentId, { expectedRevision: document.revision, operations: [
      { kind: 'updateDocument', changes: { visualStyle: '现实主义，暖色门店' } },
      { kind: 'upsertEntity', entity: { ...person, visualIdentity: '短发，圆脸', visualState: '素色工作服' } },
      { kind: 'upsertScene', scene: { id: 'scene-one', headingBlockId: 'heading-one', blockIds: ['heading-one'] }, blocks: [{ id: 'heading-one', kind: 'scene-heading', markdown: '## 店外 雨夜' }] },
      { kind: 'upsertRecord', collection: 'appearances', record: { id: 'costume-one', entityId: person.id, sceneId: 'scene-one', visualState: '加穿雨衣' } },
      { kind: 'upsertShot', shot: { id: 'shot-one', descriptionBlockId: 'shot-block', sceneId: 'scene-one', entityIds: [person.id], sourceBlockIds: [] }, descriptionMarkdown: '### 走出店门' },
    ] })
    const preview = await handoff.preview(cwd, document.documentId, person.id, { kind: 'scene', sceneId: 'scene-one' })
    expect(preview.markdown).toBe(document.parsed.blocks.find(block => block.id === person.profileBlockId)!.markdown)
    expect(preview.productionText).toContain('短发，圆脸')
    expect(preview.productionText).toContain('加穿雨衣')
    expect(preview.productionText).toContain('现实主义，暖色门店')
    const shot = await handoff.preview(cwd, document.documentId, 'shot-one')
    expect(shot.references).toHaveLength(1)
    expect(shot.productionText).toContain('加穿雨衣')
    expect(shot.productionText).toContain('把钥匙留在灯下')
    await expect(handoff.send(cwd, document.documentId, { expectedRevision: document.revision, objectId: person.id, boardId: board, production: { purpose: 'image', requestId: 'stale' } })).rejects.toMatchObject({ code: 'STORY_CONFLICT' })
    expect((await story.get(cwd, document.documentId)).revision).toBe(result.document.revision)
  })

  it('updates the source preview after changing a binding, without changing original nodes or files', async () => {
    const a = await createBound()
    const request = { expectedRevision: a.revision, objectId: 'person', boardId: board }
    const sent = await handoff.send(cwd, a.documentId, request)
    expect(sent.created).toBe(true)
    expect((await handoff.send(cwd, a.documentId, request)).created).toBe(false)
    const source = sent.node
    await boards.update(current => ({ ...current!, nodes: nodesOf(current).map(node => node.id === source.id ? { ...node, metadata: { ...node.metadata, storyNote: '画布手写补充' } } : node) }))
    const b = (await assets.candidates(cwd, board)).assets.find(item => item.filePath === 'canvas/media/b.png')!
    const updated = await assets.bind(cwd, a.documentId, { expectedRevision: a.revision, filePath: b.filePath, expectedSha256: b.sha256, target: { kind: 'entity', id: 'person' }, scope: { kind: 'document' }, purpose: 'identity', primary: true, replaceBindingId: a.parsed.metadata!.bindings[0]!.id }, board)
    const preview = await handoff.preview(cwd, a.documentId, 'person')
    expect(preview.revision).toBe(updated.document.revision)
    expect(preview.references[0]!.sha256).toBe(b.sha256)
    const saved = await boards.read(board)
    expect(nodesOf(saved).find(node => node.id === 'production')).toEqual(original)
    expect(nodesOf(saved).find(node => node.id === source.id)!.metadata.storyNote).toBe('画布手写补充')
    expect(await readFile(path.join(cwd, 'film/canvas/media/a.png'), 'utf8')).toBe('image-version-a')
    expect(await readFile(path.join(cwd, 'film/canvas/media/b.png'), 'utf8')).toBe('image-version-b')
    await story.restore(cwd, a.documentId, { expectedRevision: updated.document.revision, versionId: a.versionId! })
    expect((await handoff.preview(cwd, a.documentId, 'person')).references[0]!.sha256).toBe(sent.preview.references[0]!.sha256)
    expect((await boards.read(board))!.nodes).toEqual(saved!.nodes)
  })

  it('preserves each adopted field version, output and immutable reference bytes through later editing', async () => {
    const a = await createBound()
    const adoptedA = await handoff.adopt(cwd, a.documentId, { expectedRevision: a.revision, objectId: 'person', boardId: board, targetNodeId: 'production', fields: ['prompt', 'references'], expectedTarget: { prompt: original.metadata.prompt, composerContent: original.metadata.composerContent, references: original.metadata.references } })
    const aMetadata = adoptedA.node.metadata
    const referenceUrl = (aMetadata.references as string[])[0]!
    expect(referenceUrl).toBe(`/api/projects/${board}/raw/canvas/story-references/${createHash('sha256').update('image-version-a').digest('hex')}.png`)
    const adoptedPath = referenceUrl.split('/raw/')[1]!
    expect(await readFile(path.join(cwd, 'film', adoptedPath), 'utf8')).toBe('image-version-a')
    const b = await story.apply(cwd, a.documentId, { expectedRevision: a.revision, operations: [{ kind: 'replaceBlock', blockId: 'profile', markdown: '### 她\n\n转身带走钥匙。' }] })
    const adoptedB = await handoff.adopt(cwd, a.documentId, { expectedRevision: b.document.revision, objectId: 'person', boardId: board, targetNodeId: 'production', fields: ['prompt'], expectedTarget: { prompt: aMetadata.prompt as string, composerContent: aMetadata.composerContent as string } })
    expect(adoptedB.adoption!.fieldAdoptions.prompt!.revision).toBe(b.document.revision)
    expect(adoptedB.adoption!.fieldAdoptions.references!.revision).toBe(a.revision)
    expect(adoptedB.node.metadata.references).toEqual([referenceUrl])
    expect(adoptedB.node.metadata).toMatchObject({ model: 'chosen-model', content: 'generated-result', quality: 'high', texts: ['保留人工笔记'] })
    await writeFile(path.join(cwd, 'film/canvas/media/a.png'), 'original edited later')
    expect(createHash('sha256').update(await readFile(path.join(cwd, 'film', adoptedPath))).digest('hex')).toBe(adoptedA.preview.references[0]!.sha256)
    await story.restore(cwd, a.documentId, { expectedRevision: b.document.revision, versionId: a.versionId! })
    expect(nodesOf(await boards.read(board))[0]).toEqual(adoptedB.node)
  })

  it('rejects a stale target or missing reference before changing production inputs', async () => {
    const a = await createBound()
    const request = { expectedRevision: a.revision, objectId: 'person', boardId: board, targetNodeId: 'production', fields: ['references'] as Array<'references'>, expectedTarget: { references: ['outdated'] } }
    await expect(handoff.adopt(cwd, a.documentId, request)).rejects.toMatchObject({ code: 'STORY_TARGET_CONFLICT' })
    await rm(path.join(cwd, 'film/canvas/media/a.png'))
    await expect(handoff.adopt(cwd, a.documentId, { ...request, expectedTarget: { references: original.metadata.references } })).rejects.toMatchObject({ code: 'STORY_ASSET_UNAVAILABLE' })
    expect((await boards.read(board))!.nodes).toEqual([original])
  })

  it('reports only relevant adopted fields and detects later manual edits without writing the board', async () => {
    const a = await createBound()
    const impact = new StoryImpact(story, handoff)
    const adopted = await handoff.adopt(cwd, a.documentId, { expectedRevision: a.revision, objectId: 'person', boardId: board, targetNodeId: 'production', fields: ['prompt', 'references'], expectedTarget: original.metadata })
    const unrelated = await story.save(cwd, a.documentId, { expectedRevision: a.revision, content: `${a.content}\n与她无关的作者附记。\n` })
    expect((await impact.read(cwd, a.documentId)).items.map(item => item.status)).toEqual(['unchanged', 'unchanged'])
    const changed = await story.apply(cwd, a.documentId, { expectedRevision: unrelated.document.revision, operations: [{ kind: 'replaceBlock', blockId: 'profile', markdown: '### 她\n\n带走钥匙。' }] })
    await boards.update(current => ({ ...current!, nodes: nodesOf(current).map(node => ({ ...node, metadata: { ...node.metadata, prompt: '手改后保留' } })) }))
    const before = await boards.read(board)
    const comparison = await impact.read(cwd, a.documentId)
    expect(comparison.currentRevision).toBe(changed.document.revision)
    expect(comparison.items).toEqual([
      expect.objectContaining({ field: 'prompt', status: 'changed', manualChanged: true, adoptedRevision: a.revision }),
      expect.objectContaining({ field: 'references', status: 'unchanged', manualChanged: false, adoptedRevision: a.revision }),
    ])
    expect(await boards.read(board)).toEqual(before)
    expect(adopted.adoption!.fieldAdoptions.references!.revision).toBe(a.revision)
  })

  it('detects visual changes for outputs made from live source connections without rewriting old outputs', async () => {
    const a = await createBound()
    const snapshot = await handoff.preview(cwd, a.documentId, 'person')
    const source = { projectId: board, documentId: a.documentId, objectId: 'person', objectKind: 'entity', scope: { kind: 'document' }, snapshot }
    const output = { requestId: 'connected-output', sourceNodeId: 'production', adoption: { ...source, revision: a.revision, fields: [] }, sources: [{ nodeId: 'source', source }], inputs: { prompt: snapshot.productionText, referenceImages: [], referenceVideos: [], referenceAudios: [] } }
    await boards.update(current => ({ ...current!, nodes: nodesOf(current).map(node => ({ ...node, metadata: { ...node.metadata, storyOutputSource: output } })) }))
    const before = await boards.read(board)
    await story.apply(cwd, a.documentId, { expectedRevision: a.revision, operations: [{ kind: 'upsertEntity', entity: { ...a.parsed.metadata!.entities[0]!, visualIdentity: '新发型' } }] })
    const result = await new StoryImpact(story, handoff).read(cwd, a.documentId)
    expect(result.items).toEqual([
      expect.objectContaining({ sourceType: 'output', field: 'prompt', status: 'changed', adoptedRevision: a.revision }),
      expect.objectContaining({ sourceType: 'output', field: 'references', status: 'unchanged' }),
    ])
    expect(await boards.read(board)).toEqual(before)
  })

  it('reports actual output provenance separately from newly adopted inputs and director intent, and never reads an old cut', async () => {
    const a = await createBound()
    const adopted = await handoff.adopt(cwd, a.documentId, { expectedRevision: a.revision, objectId: 'person', boardId: board, targetNodeId: 'production', fields: ['prompt', 'references'], expectedTarget: original.metadata })
    const output = { requestId: 'render-a', sourceNodeId: 'production', adoption: adopted.adoption, inputs: { prompt: '人工改后的生成文字', referenceImages: adopted.node.metadata.references, referenceVideos: [], referenceAudios: [] } }
    const source = { preview: adopted.preview, scope: { kind: 'document' }, linkedAt: '2026-01-01' }
    const mediaUrl = `/api/projects/${board}/raw/canvas/media/a.png`
    await boards.update(current => ({ ...current!, nodes: nodesOf(current).map(node => ({ ...node, metadata: { ...node.metadata, content: mediaUrl, storyOutputSource: output, storyOutputHistory: [{ content: mediaUrl, storyOutputSource: output }], storyDirectorLinks: { camera: [source] } } })) }))
    // A cut 0.1's editing desk saved, whose clip records the same sources: left on disk, never read or rewritten.
    const cutFile = path.join(cwd, 'film', 'canvas', 'timeline.json')
    const cut = {
      revision: 1,
      document: { project: { visualSegments: [{ id: 'clip', name: '已裁切镜头', duration: 2, sourceIn: 1, director: { nodeId: 'production', shotId: 'camera', storySources: [source] }, storyMediaSource: { projectId: board, path: 'canvas/media/a.png', outputs: [output] } }] } },
    }
    await writeFile(cutFile, JSON.stringify(cut, null, 2))
    const cutSha = createHash('sha256').update(await readFile(cutFile)).digest('hex')
    const b = await story.apply(cwd, a.documentId, { expectedRevision: a.revision, operations: [{ kind: 'replaceBlock', blockId: 'profile', markdown: '### 她\n\n带走钥匙。' }] })
    await handoff.adopt(cwd, a.documentId, { expectedRevision: b.document.revision, objectId: 'person', boardId: board, targetNodeId: 'production', fields: ['prompt'], expectedTarget: { prompt: adopted.node.metadata.prompt as string, composerContent: adopted.node.metadata.composerContent as string } })
    const beforeBoard = await boards.read(board)
    const items = (await new StoryImpact(story, handoff).read(cwd, a.documentId)).items
    expect(items).toHaveLength(6) // two fields for each distinct use; duplicate history collapses
    expect(items.filter(item => item.field === 'prompt')).toEqual([
      expect.objectContaining({ sourceType: 'input', adoptedRevision: b.document.revision, status: 'unchanged' }),
      expect.objectContaining({ sourceType: 'output', adoptedRevision: a.revision, status: 'changed' }),
      expect.objectContaining({ sourceType: 'director', adoptedRevision: a.revision, status: 'changed' }),
    ])
    expect(new Set(items.map(item => item.usageId)).size).toBe(items.length)
    expect(items.every(item => !('clipId' in item) && ['input', 'output', 'director'].includes(item.sourceType ?? 'input'))).toBe(true)
    expect(items.filter(item => item.sourceType === 'output')).toEqual([
      expect.objectContaining({ field: 'prompt', inputsChanged: true, manualChanged: false }),
      expect.objectContaining({ field: 'references', inputsChanged: false }),
    ])
    expect(await boards.read(board)).toEqual(beforeBoard)
    expect(createHash('sha256').update(await readFile(cutFile)).digest('hex')).toBe(cutSha)
  })
})

describe('the film\'s one board', () => {
  it('refuses any board but the film\'s before reading or writing', async () => {
    const document = await createBound()
    const before = await boards.read(board)
    await expect(handoff.send(cwd, document.documentId, { expectedRevision: document.revision, objectId: 'person', boardId: 'other-board' })).rejects.toMatchObject({ code: 'STORY_BOARD_MISMATCH' })
    await expect(handoff.send(cwd, document.documentId, { expectedRevision: document.revision, objectId: 'person', boardId: '../board' })).rejects.toMatchObject({ code: 'STORY_BOARD_ID_REQUIRED' })
    await expect(handoff.adopt(cwd, document.documentId, { expectedRevision: document.revision, objectId: 'person', boardId: 'other-board', targetNodeId: 'production', fields: ['prompt'], expectedTarget: {} }))
      .rejects.toMatchObject({ code: 'STORY_BOARD_NOT_FOUND' })
    expect(await boards.read(board)).toEqual(before)
  })

  it('starts the board, named after the film, when the storyboard was never opened', async () => {
    await rm(path.join(cwd, 'film', 'canvas', 'document.json'))
    const document = await createBound()
    const sent = await handoff.send(cwd, document.documentId, { expectedRevision: document.revision, objectId: 'person', boardId: board })
    const saved = await boards.read(board)
    expect(saved).toMatchObject({ id: board, title: '制作', backgroundMode: 'lines', connections: [] })
    expect(nodesOf(saved)).toEqual([expect.objectContaining({ id: sent.node.id, type: 'text', position: { x: 64, y: 80 }, metadata: expect.objectContaining({ storyNote: '', content: sent.preview.productionText }) })])
    expect(sent.preview.references[0]).toMatchObject({ status: 'available', url: `/api/projects/${board}/story/documents/${document.documentId}/references/${document.parsed.metadata!.assets[0]!.id}/${document.parsed.metadata!.assets[0]!.versionId}` })
  })

  it('needs a film', async () => {
    const document = await createBound()
    await rm(path.join(cwd, 'film', 'film.json'))
    await expect(handoff.preview(cwd, document.documentId, 'person')).rejects.toMatchObject({ status: 404, code: 'PROJECT_NOT_FOUND' })
  })
})
