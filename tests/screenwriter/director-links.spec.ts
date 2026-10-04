/** Screenplay sources on director shots: Studio's director-links cases, the desk's fingerprint, and the open page's say on an unsaved desk. */

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasBoardAgent } from '../../src/canvas/board-agent.js'
import type { BoardTarget } from '../../src/canvas/board-agent.js'
import { CanvasDocumentStore } from '../../src/canvas/documents.js'
import { fingerprintOfStoredScene, getDirectorProjectFingerprint, isAnyVersionDirectorProjectShape } from '../../src/director/fingerprint.js'
import { createProject } from '../../src/project.js'
import { StoryAssets } from '../../src/screenwriter/assets.js'
import type { StoryDocument } from '../../src/screenwriter/contracts/index.js'
import { StoryDirectorLinksService } from '../../src/screenwriter/director-links.js'
import { StoryHandoff } from '../../src/screenwriter/handoff.js'
import { StoryService } from '../../src/screenwriter/service.js'
import type { EventStream } from '../../src/studio/sse.js'
import { liveDirectorReader } from '../../src/studio/story-production-routes.js'
import { openDeskPage } from '../director/pages.js'

/** A minimal version-15 desk project with one camera (Studio's director-fixtures `project([], [lockedCamera('camera', …)])` shape). */
const scene = {
  version: 15, shots: [], timeline: { duration: 6 }, scene: { backgroundColor: '#20201e', groundHeight: 0 }, assets: [], animationAssets: [], objects: [],
  cameras: [{ id: 'camera', name: '近景 · 林', fov: 50, motionClips: [] }], activeCameraId: 'camera', panoramaAssetId: null,
}

let cwd: string
let board: string
let story: StoryService
let service: StoryDirectorLinksService
let boards: CanvasDocumentStore
let liveScene: unknown

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'story-director-'))
  board = (await createProject(cwd, { title: '导演', aspectRatio: '16:9' })).project.id
  story = new StoryService()
  const handoff = new StoryHandoff(story, new StoryAssets(story))
  liveScene = undefined
  service = new StoryDirectorLinksService(story, handoff, async () => ({ deskOpen: Boolean(liveScene), scene: liveScene }))
  boards = new CanvasDocumentStore(cwd, board)
  await boards.write(board, { id: board, nodes: [{ id: 'director', type: 'director', title: '导演台', metadata: { directorProject: { project: scene }, content: 'keep' } }], connections: [] })
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function screenplay(): Promise<StoryDocument> {
  const draft = await story.create(cwd, { title: '无对白短片' })
  return (await story.apply(cwd, draft.document.documentId, { expectedRevision: draft.document.revision, operations: [{ kind: 'upsertEntity', entity: { id: 'anonymous', kind: 'person', profileBlockId: 'profile' }, profileMarkdown: '匿名的人放下钥匙。' }] })).document
}

describe('the director scene fingerprint', () => {
  it('matches the desk\'s FNV-1a value, on the project as stored, through an envelope', () => {
    // Values computed with the director desk's own src/editor/schema/projectFingerprint.ts.
    expect(getDirectorProjectFingerprint(scene as never)).toBe('fnv1a32-8465d5af')
    expect(fingerprintOfStoredScene({ project: scene })).toBe('fnv1a32-8465d5af')
    expect(fingerprintOfStoredScene({ project: { ...scene, activeCameraId: 'different' } })).toBe('fnv1a32-b840cd79')
    expect(fingerprintOfStoredScene({ ...scene, version: 16 })).toBeNull()
    expect(fingerprintOfStoredScene(undefined)).toBeNull()
    expect(isAnyVersionDirectorProjectShape({ ...scene, version: 1 })).toBe(true)
    expect(isAnyVersionDirectorProjectShape({ ...scene, scene: {} })).toBe(false)
  })
})

describe('explicit screenplay sources on existing director shots (Studio cases)', () => {
  it('lists real shots, links saved snapshots and keeps the director scene untouched', async () => {
    const document = await screenplay()
    const selected = (await service.list(cwd, board)).directors[0]!
    expect(selected.shots).toEqual([{ directorShotId: 'camera', name: '近景 · 林' }])
    expect(selected).toMatchObject({ nodeId: 'director', title: '导演台', savedScene: true, directorFingerprint: 'fnv1a32-8465d5af', links: {} })
    const request = { action: 'link' as const, expectedRevision: document.revision, objectId: 'anonymous', boardId: board, directorNodeId: selected.nodeId, directorShotId: 'camera', expectedDirectorFingerprint: selected.directorFingerprint!, expectedLinksFingerprint: selected.linksFingerprint }
    const linked = await service.mutate(cwd, document.documentId, request)
    expect(linked.changed).toBe(true)
    expect(linked.node.metadata?.directorProject).toEqual({ project: scene })
    const current = (await service.list(cwd, board)).directors[0]!
    expect(current.links.camera?.[0]?.preview.revision).toBe(document.revision)
    await expect(service.mutate(cwd, document.documentId, request)).rejects.toMatchObject({ code: 'STORY_DIRECTOR_LINK_CONFLICT' })
    expect((await service.mutate(cwd, document.documentId, { ...request, expectedLinksFingerprint: current.linksFingerprint })).changed).toBe(false)
    const unlinked = await service.mutate(cwd, document.documentId, { ...request, action: 'unlink', expectedLinksFingerprint: current.linksFingerprint })
    expect(unlinked.node.metadata?.storyDirectorLinks).toEqual({})
    expect(unlinked.node.metadata?.content).toBe('keep')
  })

  it('rejects unsaved live cameras and concurrent saved scene changes', async () => {
    const document = await screenplay()
    const original = (await service.list(cwd, board)).directors[0]!
    const request = { action: 'link' as const, expectedRevision: document.revision, objectId: 'anonymous', boardId: board, directorNodeId: 'director', directorShotId: 'camera', expectedDirectorFingerprint: original.directorFingerprint!, expectedLinksFingerprint: original.linksFingerprint }
    liveScene = { project: { ...scene, activeCameraId: 'different' } }
    expect((await service.list(cwd, board)).directors[0]!.savedScene).toBe(false)
    await expect(service.mutate(cwd, document.documentId, request)).rejects.toMatchObject({ code: 'STORY_DIRECTOR_UNSAVED' })
    liveScene = undefined
    await boards.update(current => ({ ...current!, nodes: [{ id: 'director', type: 'director', metadata: { directorProject: { project: { ...scene, activeCameraId: 'different' } } } }] }))
    await expect(service.mutate(cwd, document.documentId, request)).rejects.toMatchObject({ code: 'STORY_DIRECTOR_CONFLICT' })
  })

  it('can explicitly remove a historical link after its director shot was deleted', async () => {
    const document = await screenplay()
    const selected = (await service.list(cwd, board)).directors[0]!
    const request = { action: 'link' as const, expectedRevision: document.revision, objectId: 'anonymous', boardId: board, directorNodeId: 'director', directorShotId: 'camera', expectedDirectorFingerprint: selected.directorFingerprint!, expectedLinksFingerprint: selected.linksFingerprint }
    await service.mutate(cwd, document.documentId, request)
    await boards.update(current => ({ ...current!, nodes: (current!.nodes as Array<{ metadata: Record<string, unknown> }>).map(node => ({ ...node, metadata: { ...node.metadata, directorProject: { project: { ...scene, cameras: [], activeCameraId: null } } } })) }))
    const current = (await service.list(cwd, board)).directors[0]!
    expect(current.shots).toEqual([])
    const result = await service.mutate(cwd, document.documentId, { ...request, action: 'unlink', expectedDirectorFingerprint: current.directorFingerprint!, expectedLinksFingerprint: current.linksFingerprint })
    expect(result.changed).toBe(true)
    expect(result.node.metadata?.storyDirectorLinks).toEqual({})
    expect(result.revision).toBe(document.revision)
  })
})

describe('director links in the film', () => {
  it('refuses another board, malformed links and an absent director node', async () => {
    const document = await screenplay()
    await expect(service.list(cwd, 'other-board')).rejects.toMatchObject({ code: 'STORY_BOARD_NOT_FOUND' })
    await expect(service.list(cwd, '../x')).rejects.toMatchObject({ code: 'STORY_DIRECTOR_ID' })
    const selected = (await service.list(cwd, board)).directors[0]!
    const request = { action: 'link' as const, expectedRevision: document.revision, objectId: 'anonymous', boardId: board, directorNodeId: 'missing', directorShotId: 'camera', expectedDirectorFingerprint: selected.directorFingerprint!, expectedLinksFingerprint: selected.linksFingerprint }
    await expect(service.mutate(cwd, document.documentId, request)).rejects.toMatchObject({ code: 'STORY_DIRECTOR_NOT_FOUND' })
    await expect(service.mutate(cwd, document.documentId, { ...request, directorNodeId: '' })).rejects.toMatchObject({ code: 'STORY_DIRECTOR_SELECTION' })
    await boards.update(current => ({ ...current!, nodes: [{ id: 'director', type: 'director', metadata: { directorProject: { project: scene }, storyDirectorLinks: { camera: 'broken' } } }] }))
    await expect(service.list(cwd, board)).rejects.toMatchObject({ code: 'STORY_DIRECTOR_LINKS_INVALID' })
  })

  it('asks the page showing the film\'s board about the desk, and treats no page as a closed desk', async () => {
    const agent = new CanvasBoardAgent()
    const read = liveDirectorReader(agent)
    expect(await read(board, 'director', board)).toEqual({ deskOpen: false })

    const sent: Array<{ event: string; data: any }> = []
    const stream: EventStream = { closed: false, send: (event: string, data: unknown) => { sent.push({ event, data }); return true }, close() {} }
    const target: BoardTarget = { projectId: board, clientId: 'page', incarnation: 'one' }
    agent.connect(target, stream)
    const hello = sent.find(item => item.event === 'hello')!.data
    const lease = { target, generation: hello.generation, writeToken: hello.writeToken }
    // A page that has not reported its board yet may hold a newer scene.
    await expect(read(board, 'director', board)).rejects.toMatchObject({ code: 'STORY_DIRECTOR_STATE_UNKNOWN' })
    agent.setSnapshot(lease, { projectId: board, nodes: [], connections: [] }, 1)
    const answered = read(board, 'director', board)
    await new Promise(resolve => setTimeout(resolve, 0))
    const call = sent.find(item => item.event === 'tool_call')!.data
    expect(call).toMatchObject({ name: 'director_read_scene', input: { project: board, boardId: board, nodeId: 'director' } })
    agent.resolve(lease, { requestId: call.requestId, result: { deskOpen: true, scene: { project: scene } } })
    expect(await answered).toEqual({ deskOpen: true, scene: { project: scene } })

    const unconfirmed = read(board, 'director', board)
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = sent.filter(item => item.event === 'tool_call').at(-1)!.data
    agent.resolve(lease, { requestId: second.requestId, result: { scene: {} } })
    await expect(unconfirmed).rejects.toMatchObject({ code: 'STORY_DIRECTOR_STATE_UNKNOWN' })
  })

  it('asks every page showing the board, so a desk open in the older 导演 tab is found, and refuses two open desks', async () => {
    const agent = new CanvasBoardAgent()
    const read = liveDirectorReader(agent)
    const edited = { ...scene, cameras: [{ ...scene.cameras[0]!, name: '未保存的近景' }] }
    const director = openDeskPage(agent, board, { deskOpen: true, scene: { project: edited } })
    const storyboard = openDeskPage(agent, board, { deskOpen: false, scene: { project: scene } })
    expect(await read(board, 'director', board)).toEqual({ deskOpen: true, scene: { project: edited } })
    expect(director.calls.map(call => call.name)).toEqual(['director_read_scene'])
    expect(storyboard.calls.map(call => call.name)).toEqual(['director_read_scene'])
    storyboard.deskOpen = true
    await expect(read(board, 'director', board)).rejects.toMatchObject({ code: 'STORY_DIRECTOR_STATE_UNKNOWN' })
    director.release()
    storyboard.release()
  })
})
