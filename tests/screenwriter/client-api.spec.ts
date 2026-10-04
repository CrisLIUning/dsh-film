/**
 * The 剧本 tab's client against the real plugin: its API calls go through the
 * Studio router to the screenplay service and the files on disk, and its
 * section and card logic edits what the service wrote.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../../src/project.js'
import { createStudioRouter } from '../../src/routes.js'
import { parseStoryMarkdown } from '../../src/screenwriter/contracts/index.js'
import { replaceStoryEditorSection, sectionRole, storyEditorSections } from '../../src/client/workbench/story/body-sections.js'
import { mergeStoryCardFields, readStoryCard, storyCardOperations } from '../../src/client/workbench/story/cards.js'
import {
  bindPlan,
  bindingFileName,
  coverBinding,
  currentReferenceRead,
  effectiveBindings,
  overrideToggle,
  referenceReadKey,
  referenceRowStatus,
  setMainOperations,
} from '../../src/client/workbench/story/references.js'
import type { ReferenceRead } from '../../src/client/workbench/story/references.js'
import { StoryApiError, StoryConflictError, storyApi } from '../../src/client/workbench/story/story-api.js'
import type { StoryApi } from '../../src/client/workbench/story/story-api.js'

let cwd: string
let api: StoryApi
let requests: { method: string; path: string; verb: string | null }[]

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-story-client-'))
  const router = createStudioRouter()
  requests = []
  vi.stubGlobal('document', { baseURI: 'http://host/app/' })
  vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
    const request = new Request(String(input), init)
    const url = new URL(request.url)
    requests.push({ method: request.method, path: `${url.pathname}?path=${url.searchParams.get('path')}`, verb: url.searchParams.get('method') })
    return router.dispatch(request)
  })
  api = storyApi(cwd, 'film-1')
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(cwd, { recursive: true, force: true })
})

/** A screenplay with a scene, a person and a shot, made through the plugin. */
async function screenplay() {
  const created = await api.create({ title: '雨夜来客', kind: 'short' })
  const result = await api.apply(created.document.documentId, {
    expectedRevision: created.document.revision,
    operationId: 'op-structure',
    operations: [
      { kind: 'upsertScene', scene: { id: 'scene_1', headingBlockId: 'block_h1', blockIds: ['block_h1', 'block_a1'] }, blocks: [
        { id: 'block_h1', kind: 'scene-heading', markdown: '## 客栈门口 · 夜\n' },
        { id: 'block_a1', kind: 'action', markdown: '雨很大，一个戴斗笠的人推门进来。\n' },
      ] },
      { kind: 'upsertEntity', entity: { id: 'person_1', kind: 'person', profileBlockId: 'block_p1' }, profileMarkdown: '### 陌生人\n\n戴斗笠，不说话。\n' },
      { kind: 'upsertShot', shot: { id: 'shot_1', descriptionBlockId: 'block_s1', sourceBlockIds: ['block_a1'], entityIds: ['person_1'] }, descriptionMarkdown: '### 推门\n\n门缝里透进雨光。\n' },
    ],
  })
  return result.document
}

describe('the client API against the plugin', () => {
  it('creates, lists, reads and saves a screenplay through the studio routes', async () => {
    const document = await screenplay()
    expect(document.filePath).toMatch(/^film\/story\/doc_[0-9a-f-]+\.md$/)
    expect(await readFile(join(cwd, ...document.filePath.split('/')), 'utf8')).toBe(document.content)
    expect((await api.list()).map(item => item.title)).toEqual(['雨夜来客'])
    const read = await api.read(document.documentId)
    expect(read.parsed.semanticEditable).toBe(true)
    expect(read.parsed.metadata?.scenes.map(scene => scene.id)).toEqual(['scene_1'])

    const saved = await api.write(document.documentId, { expectedRevision: read.revision, content: `${read.content}\n尾声。\n`, operationId: 'op-save' })
    expect(saved.document.content.endsWith('尾声。\n')).toBe(true)
    // Writes are POSTs to studio-write carrying the Studio verb; reads are GETs.
    expect(requests.at(-1)).toEqual({ method: 'POST', path: `/app/api/dsh-film/studio-write?path=/api/projects/film-1/story/documents/${document.documentId}`, verb: 'PUT' })
    expect(requests.find(request => request.method === 'GET')?.path).toBe('/app/api/dsh-film/studio?path=/api/projects/film-1/story/documents')
  })

  it('answers a stale save with the version on disk, and a refused edit with its diagnostics', async () => {
    const document = await screenplay()
    await api.write(document.documentId, { expectedRevision: document.revision, content: `${document.content}\nAgent 加的一行。\n`, operationId: 'op-agent' })
    const stale = api.write(document.documentId, { expectedRevision: document.revision, content: `${document.content}\n我的一行。\n`, operationId: 'op-mine' })
    await expect(stale).rejects.toBeInstanceOf(StoryConflictError)
    const conflict = await stale.then(() => undefined, (error: unknown) => error as StoryConflictError)
    expect(conflict?.current.content).toContain('Agent 加的一行。')

    const latest = await api.read(document.documentId)
    const refused = await api.apply(document.documentId, { expectedRevision: latest.revision, operationId: 'op-bad', operations: [{ kind: 'renameEntity', entityId: 'nobody', name: 'x' }] }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(StoryApiError)
    expect(refused).toMatchObject({ status: 422, code: 'STORY_INVALID_OPERATIONS' })
    // A shot naming someone who is not in the screenplay breaks a relation: the answer says which.
    const broken = await api.apply(document.documentId, { expectedRevision: latest.revision, operationId: 'op-broken', operations: [
      { kind: 'upsertShot', shot: { id: 'shot_2', descriptionBlockId: 'block_s2', sourceBlockIds: [], entityIds: ['nobody'] }, descriptionMarkdown: '### 空镜\n' },
    ] }).catch((error: unknown) => error)
    expect(broken).toMatchObject({ status: 422, code: 'STORY_INVALID_OPERATIONS' })
    expect((broken as StoryApiError).diagnostics.map(item => item.code)).toContain('missing-reference')
  })

  it('previews a deletion, keeps versions and restores one', async () => {
    const document = await screenplay()
    const preview = await api.deletionPreview(document.documentId, { kind: 'entity', id: 'person_1' })
    expect(preview).toMatchObject({ documentId: document.documentId, target: { kind: 'entity', id: 'person_1' }, canDelete: false })
    expect(preview.dependencies.some(dependency => dependency.collection === 'shots' && dependency.blocksDeletion)).toBe(true)

    const { version } = await api.checkpoint(document.documentId, { expectedRevision: document.revision, label: '第一稿' })
    expect(version.label).toBe('第一稿')
    const edited = await api.write(document.documentId, { expectedRevision: document.revision, content: document.content.replace('雨很大', '雪很大'), operationId: 'op-snow' })
    expect((await api.history(document.documentId)).some(item => item.label === '第一稿')).toBe(true)
    expect((await api.version(document.documentId, version.id)).content).toContain('雨很大')
    const restored = await api.restore(document.documentId, { expectedRevision: edited.document.revision, versionId: version.id, operationId: 'op-restore' })
    expect(restored.document.content).toContain('雨很大')
  })
})

describe('section editing on a real screenplay', () => {
  it('offers the prose between markers and refuses edits that touch them', async () => {
    const document = await screenplay()
    const sections = storyEditorSections(document.content, document.parsed.semanticEditable)!
    const action = sections.find(section => section.key === 'block:block_a1')!
    expect(action.text).toBe('雨很大，一个戴斗笠的人推门进来。')
    expect(sectionRole(action)).toBe('action')
    const heading = sections.find(section => section.key === 'block:block_h1')!
    expect(heading).toMatchObject({ heading: true, text: '客栈门口 · 夜' })
    expect(sectionRole(heading)).toBe('heading')

    const next = replaceStoryEditorSection(document.content, action, '雨很大。\n门开了。')!
    const parsed = parseStoryMarkdown(next)
    expect(parsed.semanticEditable).toBe(true)
    expect(parsed.blocks.find(block => block.id === 'block_a1')?.markdown).toBe('\n雨很大。\n门开了。\n')
    expect(await api.write(document.documentId, { expectedRevision: document.revision, content: next, operationId: 'op-body' })).toMatchObject({ changed: true })

    expect(replaceStoryEditorSection(document.content, action, '<!-- sw:block {"id":"block_x","kind":"action"} -->')).toBeNull()
    // An open fence would hide the markers after it.
    expect(replaceStoryEditorSection(document.content, action, '```')).toBeNull()
    // A section from an older text does not apply to a newer one.
    expect(replaceStoryEditorSection(next, action, '别的')).toBeNull()
  })

  it('edits a plain Markdown file as one section, and none of a broken one', () => {
    expect(storyEditorSections('# 草稿\n\n还没有结构。\n', false)).toEqual([{ key: 'tail', kind: 'paragraph', heading: true, range: { start: 2, end: 12 }, text: '草稿\n\n还没有结构。' }])
    expect(storyEditorSections('<!-- sw:block {"id":"a","kind":"action"} -->\n文字\n', false)).toBeNull()
    expect(storyEditorSections('<!-- sw:block {"id":"a","kind":"action"} -->\n文字\n', true)).toBeNull()
  })
})

describe('card editing on a real screenplay', () => {
  it('turns form fields into operations the plugin applies', async () => {
    const document = await screenplay()
    const person = readStoryCard(document, { kind: 'entity', id: 'person_1' })!
    expect(person.fields).toMatchObject({ name: '陌生人', description: '戴斗笠，不说话。', visualIdentity: '' })
    const operations = storyCardOperations(person, { ...person.fields, name: '蓑衣客', description: '戴斗笠，只说一句话。', visualIdentity: '四十岁，瘦高' })
    expect(operations.map(operation => operation.kind)).toEqual(['replaceBlock', 'upsertEntity', 'renameEntity'])
    const applied = await api.apply(document.documentId, { expectedRevision: document.revision, operations, operationId: 'op-card' })
    expect(readStoryCard(applied.document, { kind: 'entity', id: 'person_1' })?.fields).toMatchObject({ name: '蓑衣客', description: '戴斗笠，只说一句话。', visualIdentity: '四十岁，瘦高' })

    const shot = readStoryCard(applied.document, { kind: 'shot', id: 'shot_1' })!
    expect(shot.fields).toMatchObject({ name: '推门', sceneId: null, sourceBlockIds: ['block_a1'], entityIds: ['person_1'] })
    const shotOperations = storyCardOperations(shot, { ...shot.fields, sceneId: 'scene_1', estimatedSeconds: 4.5 })
    expect(shotOperations.map(operation => operation.kind)).toEqual(['upsertShot'])
    const placed = await api.apply(document.documentId, { expectedRevision: applied.document.revision, operations: shotOperations, operationId: 'op-shot' })
    expect(placed.document.parsed.metadata?.shots[0]).toMatchObject({ sceneId: 'scene_1', estimatedSeconds: 4.5 })
  })

  it('keeps an edit made elsewhere to another field, and flags one to the same field', async () => {
    const document = await screenplay()
    const baseline = readStoryCard(document, { kind: 'entity', id: 'person_1' })!.fields
    const remote = { ...baseline, visualState: '湿透的蓑衣' }
    expect(mergeStoryCardFields(baseline, { ...baseline, name: '蓑衣客' }, remote)).toEqual({ merged: { ...remote, name: '蓑衣客' }, conflicts: [] })
    expect(mergeStoryCardFields(baseline, { ...baseline, name: '蓑衣客' }, { ...baseline, name: '刀客' }).conflicts).toEqual(['name'])
  })
})

describe('reference images through the client API', () => {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

  /** A film with two images (one with a Chinese name and a space) and the screenplay. */
  async function film() {
    const project = (await createProject(cwd, { title: '雨夜来客', aspectRatio: '16:9' })).project
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'canvas', 'media', '陌生人 正面.png'), 'face bytes')
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'side.png'), 'side bytes')
    return { project, document: await screenplay() }
  }

  it('lists the library, binds the picked images and reads them back', async () => {
    const { document } = await film()
    const library = await api.assets()
    expect(library.map(item => item.filePath).sort()).toEqual(['canvas/media/side.png', 'canvas/media/陌生人 正面.png'])
    const face = library.find(item => item.filePath.endsWith('正面.png'))!
    expect(face.sha256).toBe(sha('face bytes'))

    // The picker's plan: the first picked image becomes the main reference.
    const target = { kind: 'entity' as const, id: 'person_1' }
    const picked = [face, library.find(item => item.filePath.endsWith('side.png'))!]
    let current = document
    for (const item of bindPlan(picked, { target, scope: 'document', purpose: 'appearance', direct: [] })) {
      current = (await api.bind(current.documentId, { ...item, expectedRevision: current.revision, operationId: `bind-${item.filePath.length}` })).document
    }
    const metadata = current.parsed.metadata!
    expect(metadata.bindings.map(item => item.primary)).toEqual([true, false])
    const cover = coverBinding(metadata, target)!
    expect(bindingFileName(metadata, cover)).toBe('陌生人 正面.png')
    expect(effectiveBindings(metadata, target, 'scene_1', 'appearance')).toMatchObject({ inherited: true, suppressed: false })

    const references = await api.references(current.documentId)
    expect(references.map(item => item.status)).toEqual(['available', 'available'])
    const read: ReferenceRead = { key: referenceReadKey(current.documentId, current.revision), status: 'loaded', references }
    expect(referenceRowStatus(currentReferenceRead(read, referenceReadKey(current.documentId, current.revision)), cover).status).toBe('available')

    // The cover and the picker thumbnails load through the studio route.
    const bytes = await fetch(api.referenceUrl(current.documentId, cover.assetId, cover.assetVersionId))
    expect([bytes.status, bytes.headers.get('content-type'), await bytes.text()]).toEqual([200, 'image/png', 'face bytes'])
    const thumbnail = await fetch(api.fileUrl(face.filePath))
    expect([thumbnail.status, await thumbnail.text()]).toEqual([200, 'face bytes'])
    expect(requests.at(-1)?.path).toBe('/app/api/dsh-film/studio?path=/api/projects/film-1/raw/canvas/media/%E9%99%8C%E7%94%9F%E4%BA%BA%20%E6%AD%A3%E9%9D%A2.png')

    // A changed file is reported, not substituted.
    await writeFile(join(cwd, 'film', 'canvas', 'media', '陌生人 正面.png'), 'retouched')
    const after = await api.references(current.documentId)
    expect(after.find(item => item.asset.id === cover.assetId)?.status).toBe('version-mismatch')
    expect((await fetch(api.referenceUrl(current.documentId, cover.assetId, cover.assetVersionId))).status).toBe(409)
  })

  it('sets a main reference, turns a purpose off for a scene and unbinds through the store paths', async () => {
    const { document } = await film()
    const target = { kind: 'entity' as const, id: 'person_1' }
    const [face, side] = (await api.assets()).sort((left, right) => left.filePath.localeCompare(right.filePath))
    let current = document
    for (const item of bindPlan([side!, face!], { target, scope: 'document', purpose: 'appearance', direct: [] })) {
      current = (await api.bind(current.documentId, { ...item, expectedRevision: current.revision, operationId: crypto.randomUUID() })).document
    }
    const extra = current.parsed.metadata!.bindings.find(item => !item.primary)!
    current = (await api.apply(current.documentId, { expectedRevision: current.revision, operations: setMainOperations(extra), operationId: 'op-main' })).document
    expect(current.parsed.metadata!.bindings.filter(item => item.primary).map(item => item.id)).toEqual([extra.id])

    const off = overrideToggle(current.parsed.metadata!, target, 'scene_1', 'appearance', true, () => 'x1')
    current = (await api.apply(current.documentId, { expectedRevision: current.revision, operations: off, operationId: 'op-off' })).document
    expect(effectiveBindings(current.parsed.metadata!, target, 'scene_1', 'appearance')).toMatchObject({ bindings: [], suppressed: true })
    const on = overrideToggle(current.parsed.metadata!, target, 'scene_1', 'appearance', false, () => 'x2')
    current = (await api.apply(current.documentId, { expectedRevision: current.revision, operations: on, operationId: 'op-on' })).document
    expect(current.parsed.metadata!.referenceOverrides).toEqual([])

    const unbound = await api.unbind(current.documentId, extra.id, current.revision)
    expect(requests.at(-1)).toEqual({ method: 'POST', path: `/app/api/dsh-film/studio-write?path=/api/projects/film-1/story/documents/${current.documentId}/bindings/${extra.id}`, verb: 'DELETE' })
    expect(unbound.changed).toBe(true)
    // The remaining binding takes over as main; the file stays.
    expect(unbound.document.parsed.metadata!.bindings.map(item => item.primary)).toEqual([true])
    expect(await readFile(join(cwd, 'film', 'canvas', 'media', 'side.png'), 'utf8')).toBe('side bytes')

    const stale = await api.unbind(current.documentId, 'binding_gone', current.revision).catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(StoryConflictError)
  })

  it('refuses a binding whose image changed since it was listed', async () => {
    const { document } = await film()
    const [face] = await api.assets()
    await writeFile(join(cwd, 'film', 'canvas', 'media', face!.filePath.split('/').pop()!), 'changed meanwhile')
    const [item] = bindPlan([face!], { target: { kind: 'entity', id: 'person_1' }, scope: 'document', purpose: 'appearance', direct: [] })
    const refused = await api.bind(document.documentId, { ...item!, expectedRevision: document.revision, operationId: 'op-changed' }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(StoryApiError)
    expect(refused).toMatchObject({ status: 409, code: 'STORY_ASSET_CHANGED' })
  })
})
