/** The screenplay-to-production routes through the Studio router: answers, error shapes, change events, and bound references as generation inputs. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilmMediaTasks } from '../../src/media/tasks.js'
import type { MediaServiceLike } from '../../src/media/tasks.js'
import { createProject } from '../../src/project.js'
import { createStudioRouter } from '../../src/routes.js'
import type { StoryDocument } from '../../src/screenwriter/contracts/index.js'
import { ProjectEvents } from '../../src/studio/events.js'
import type { ProjectEvent } from '../../src/studio/events.js'

let cwd: string
let film: string
let events: ProjectEvents
let seen: ProjectEvent[]
let router: ReturnType<typeof createStudioRouter>

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'story-production-'))
  film = (await createProject(cwd, { title: '角色制作', aspectRatio: '16:9' })).project.id
  events = new ProjectEvents()
  seen = []
  events.subscribe(cwd, (event) => { seen.push(event) })
  router = createStudioRouter({ events })
  await mkdir(path.join(cwd, 'film', 'canvas', 'media'), { recursive: true })
  await writeFile(path.join(cwd, 'film', 'canvas', 'media', 'hero.png'), 'hero image bytes')
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function call(studioPath: string, method = 'GET', json?: unknown, using = router): Promise<{ status: number; body: any }> {
  const url = new URL(`http://host/api/dsh-film/${method === 'GET' ? 'studio' : 'studio-write'}`)
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', studioPath)
  if (method !== 'GET' && method !== 'POST') url.searchParams.set('method', method)
  const response = await using.dispatch(new Request(url, {
    method: method === 'GET' ? 'GET' : 'POST',
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } } : {}),
  }))
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) }
}

const documents = (): string => `/api/projects/${film}/story/documents`

/** A screenplay with a person whose identity image is bound. */
async function screenplay(): Promise<StoryDocument> {
  const { document } = (await call(documents(), 'POST', { title: '角色制作' })).body as { document: StoryDocument }
  const edited = (await call(`${documents()}/${document.documentId}/operations`, 'POST', {
    expectedRevision: document.revision,
    operations: [
      { kind: 'upsertEntity', entity: { id: 'hero', kind: 'person', profileBlockId: 'hero-profile', visualIdentity: '短发', visualState: '雨衣' }, profileMarkdown: '### 许知微\n\n夺回作品。' },
      { kind: 'upsertScene', scene: { id: 'scene-1', headingBlockId: 'heading-1', blockIds: ['heading-1'] }, blocks: [{ id: 'heading-1', kind: 'scene-heading', markdown: '## 工作室 夜' }] },
    ],
  })).body.document as StoryDocument
  const listed = (await call(`/api/projects/${film}/story/assets`)).body.assets as Array<{ filePath: string; sha256: string }>
  const hero = listed.find(item => item.filePath === 'canvas/media/hero.png')!
  return (await call(`${documents()}/${document.documentId}/bindings`, 'POST', {
    expectedRevision: edited.revision, filePath: hero.filePath, expectedSha256: hero.sha256, target: { kind: 'entity', id: 'hero' }, scope: { kind: 'document' }, purpose: 'identity', primary: true,
  })).body.document as StoryDocument
}

describe('handoff and adoption over the Studio paths', () => {
  it('prepares a sheet and its wire without generating or rewriting the screenplay, and announces the board change', async () => {
    const document = await screenplay()
    seen.length = 0
    const args = { expectedRevision: document.revision, objectId: 'hero', boardId: film, production: { purpose: 'character-sheet', requestId: 'sheet-1' } }
    const first = await call(`${documents()}/${document.documentId}/handoff`, 'POST', args)
    expect(first.status).toBe(200)
    expect(first.body.productionNode.metadata).toMatchObject({ status: 'idle', promptPurpose: 'character-sheet', count: 1 })
    expect(first.body.preview.productionText).toContain('短发')
    expect(first.body.connection).toMatchObject({ fromNodeId: first.body.node.id, toNodeId: first.body.productionNode.id })
    expect(seen).toEqual([
      { type: 'story-canvas-changed', projectId: film, boardId: film },
      { type: 'story-changed', documentId: document.documentId, revision: document.revision },
    ])
    const again = await call(`${documents()}/${document.documentId}/handoff`, 'POST', args)
    expect(again.body.productionNode.id).toBe(first.body.productionNode.id)
    expect((await call(`${documents()}/${document.documentId}`)).body.revision).toBe(document.revision)
    const board = (await call(`/api/canvas/documents/${film}`)).body
    expect(board.nodes.map((node: { type: string }) => node.type)).toEqual(['story-source', 'image'])
    expect(board.connections).toHaveLength(1)
  })

  it('answers refusals in Studio\'s error shape and changes nothing', async () => {
    const document = await screenplay()
    seen.length = 0
    const foreign = await call(`${documents()}/${document.documentId}/handoff`, 'POST', { expectedRevision: document.revision, objectId: 'hero', boardId: 'another-board' })
    expect(foreign).toMatchObject({ status: 409, body: { error: { code: 'CONFLICT' }, code: 'STORY_BOARD_MISMATCH' } })
    const stale = await call(`${documents()}/${document.documentId}/handoff`, 'POST', { expectedRevision: 'a'.repeat(64), objectId: 'hero', boardId: film })
    expect(stale).toMatchObject({ status: 409, body: { code: 'STORY_CONFLICT', current: { revision: document.revision } } })
    const block = await call(`${documents()}/${document.documentId}/source/hero-profile`)
    expect(block).toMatchObject({ status: 422, body: { error: { code: 'BAD_REQUEST' }, code: 'STORY_SOURCE_KIND_UNSUPPORTED' } })
    expect(seen).toEqual([])
    await call(`/api/canvas/documents/${film}`, 'DELETE')
    const deleted = await call(`${documents()}/${document.documentId}/handoff`, 'POST', { expectedRevision: document.revision, objectId: 'hero', boardId: film })
    expect(deleted).toMatchObject({ status: 409, body: { error: { code: 'CONFLICT' }, code: 'CANVAS_DOCUMENT_DELETED' } })
  })

  it('reads a scene-scoped source, adopts into a node with a byte snapshot, and reports the impact', async () => {
    const document = await screenplay()
    const source = await call(`${documents()}/${document.documentId}/source/hero?sceneId=scene-1`)
    expect(source.status).toBe(200)
    expect(source.body).toMatchObject({ objectId: 'hero', objectKind: 'entity', entityKind: 'person', revision: document.revision, references: [{ status: 'available', primary: true }] })
    expect((await call(`${documents()}/${document.documentId}/source/hero?sceneId=absent`)).body.code).toBe('STORY_SCOPE_NOT_FOUND')
    const sent = await call(`${documents()}/${document.documentId}/handoff`, 'POST', { expectedRevision: document.revision, objectId: 'hero', boardId: film, production: { purpose: 'image', requestId: 'image-1' } })
    const target = sent.body.productionNode
    seen.length = 0
    const adopted = await call(`${documents()}/${document.documentId}/adopt`, 'POST', {
      expectedRevision: document.revision, objectId: 'hero', boardId: film, targetNodeId: target.id, fields: ['prompt', 'references'],
      expectedTarget: { prompt: target.metadata.prompt, composerContent: target.metadata.composerContent },
    })
    expect(adopted.status).toBe(200)
    const reference = adopted.body.node.metadata.references[0] as string
    expect(reference).toMatch(new RegExp(`^/api/projects/${film}/raw/canvas/story-references/[a-f0-9]{64}\\.png$`, 'u'))
    expect(await readFile(path.join(cwd, 'film', reference.split('/raw/')[1]!), 'utf8')).toBe('hero image bytes')
    expect(seen.map(event => event.type)).toEqual(['file-changed', 'story-canvas-changed', 'story-changed'])
    // The adopted reference is served by the raw route.
    const raw = await router.dispatch(new Request(`http://host/api/dsh-film/studio?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(reference)}`))
    expect(await raw.text()).toBe('hero image bytes')
    const impact = await call(`${documents()}/${document.documentId}/impact`)
    expect(impact.body).toMatchObject({ documentId: document.documentId, currentRevision: document.revision })
    expect(impact.body.items.map((item: { sourceType: string; field: string; status: string }) => [item.sourceType, item.field, item.status])).toEqual([['input', 'prompt', 'unchanged'], ['input', 'references', 'unchanged']])
  })
})

describe('director links over the Studio paths', () => {
  const scene = { version: 15, shots: [], timeline: { duration: 6 }, scene: { backgroundColor: '#000' }, assets: [], animationAssets: [], objects: [], cameras: [{ id: 'cam-a', name: '' }], activeCameraId: 'cam-a', panoramaAssetId: null }

  it('lists the film board\'s directors by default and announces only a changed link', async () => {
    const document = await screenplay()
    await call(`/api/canvas/documents/${film}`, 'PUT', { id: film, nodes: [{ id: 'desk', type: 'director', title: '', metadata: { directorProject: scene } }], connections: [] })
    const listed = await call(`/api/projects/${film}/story/directors`)
    expect(listed.body).toMatchObject({ boardId: film, directors: [{ nodeId: 'desk', title: 'desk', savedScene: true, shots: [{ directorShotId: 'cam-a', name: 'cam-a' }], links: {} }] })
    expect((await call(`/api/projects/${film}/story/directors?boardId=another`)).body.code).toBe('STORY_BOARD_NOT_FOUND')
    const director = listed.body.directors[0]
    const link = { expectedRevision: document.revision, objectId: 'scene-1', boardId: film, directorNodeId: 'desk', directorShotId: 'cam-a', expectedDirectorFingerprint: director.directorFingerprint, expectedLinksFingerprint: director.linksFingerprint, action: 'link' }
    seen.length = 0
    const linked = await call(`${documents()}/${document.documentId}/director-links`, 'POST', link)
    expect(linked.body).toMatchObject({ changed: true, revision: document.revision, node: { id: 'desk', metadata: { storyDirectorLinks: { 'cam-a': [{ scope: { kind: 'document' } }] } } } })
    expect(seen.map(event => event.type)).toEqual(['story-canvas-changed', 'story-changed'])
    const relisted = (await call(`/api/projects/${film}/story/directors`)).body.directors[0]
    seen.length = 0
    const replay = await call(`${documents()}/${document.documentId}/director-links`, 'POST', { ...link, expectedLinksFingerprint: relisted.linksFingerprint })
    expect(replay.body.changed).toBe(false)
    expect(seen).toEqual([])
  })
})

describe('bound references as generation inputs', () => {
  function capturing() {
    const requests: unknown[] = []
    const service = {
      models: async () => [],
      generateImages: async (request: unknown, target: { folder: string; stem: string }) => {
        requests.push(request)
        const absolutePath = path.join(target.folder, `${target.stem}.png`)
        await mkdir(target.folder, { recursive: true })
        await writeFile(absolutePath, 'png')
        return { model: 'm', images: [{ absolutePath, mediaType: 'image/png', bytes: 3 }] }
      },
      startVideo: async (request: unknown) => {
        requests.push(request)
        return { id: 'video-1', model: 'v', status: 'pending' as const }
      },
      task: async () => undefined,
      onTask: () => () => {},
    } as unknown as MediaServiceLike
    return { service, requests }
  }

  it('resolves a story reference URL to the file holding exactly its bytes, and refuses one that is unavailable', async () => {
    const document = await screenplay()
    const asset = document.parsed.metadata!.assets[0]!
    const url = `/api/projects/${film}/story/documents/${document.documentId}/references/${asset.id}/${asset.versionId}`
    const { service, requests } = capturing()
    const tasks = new FilmMediaTasks(() => service)
    const media = createStudioRouter({ media: () => service, tasks })
    try {
      const wrapped = `http://host/api/dsh-film/studio?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(url)}`
      const image = await call(`/api/projects/${film}/media/generate`, 'POST', { surface: 'image', prompt: '角色设定卡', images: [url], referenceImages: [wrapped] }, media)
      expect(image.status).toBe(202)
      const video = await call(`/api/projects/${film}/media/generate`, 'POST', { surface: 'video', prompt: '走出门', videoMode: 'image-to-video', firstFrame: url }, media)
      expect(video.status).toBe(202)
      await tasks.wait(cwd, image.body.taskId, 0, 2000)
      const file = path.join(cwd, 'film', 'canvas', 'media', 'hero.png')
      expect(requests[0]).toMatchObject({ references: [file, file] })
      expect(requests[1]).toMatchObject({ firstFrame: file })

      await writeFile(file, 'changed after binding')
      const refused = await call(`/api/projects/${film}/media/generate`, 'POST', { surface: 'image', prompt: '角色设定卡', images: [url] }, media)
      expect(refused).toMatchObject({ status: 409, body: { error: { code: 'STORY_ASSET_UNAVAILABLE' } } })
      expect(requests).toHaveLength(2)
    } finally {
      tasks.dispose()
      await tasks.settled()
    }
  })
})
