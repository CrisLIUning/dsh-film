/** The media edit routes (C9): probe, cut, join and extract audio as film tasks, landing on a closed board. */

import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasDocumentStore, emptyFilmBoard } from '../src/canvas/documents.js'
import { FilmMediaTasks } from '../src/media/tasks.js'
import { createStudioRouter } from '../src/routes.js'
import { ProjectEvents } from '../src/studio/events.js'
import { writeFixture } from './media-edit-fixtures.js'

let cwd: string
let outside: string
let tasks: FilmMediaTasks
let events: ProjectEvents
let seen: Array<Record<string, unknown>>
let router: ReturnType<typeof createStudioRouter>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-edit-routes-'))
  outside = await mkdtemp(join(tmpdir(), 'dsh-film-edit-outside-'))
  await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
  tasks = new FilmMediaTasks(() => undefined)
  events = new ProjectEvents()
  seen = []
  events.subscribe(cwd, (event) => { seen.push(event) })
  router = createStudioRouter({ tasks, events })
})

afterEach(async () => {
  tasks.dispose()
  await tasks.settled()
  await rm(cwd, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function call(studioPath: string, json: unknown) {
  const url = new URL('http://host/api/dsh-film/studio-write')
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', studioPath)
  url.searchParams.set('method', 'POST')
  const response = await router.dispatch(new Request(url, { method: 'POST', body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }))
  return { status: response.status, body: await response.json() as any }
}

/** Wait for a task through the media task route until it ends. */
async function finished(taskId: string): Promise<any> {
  let since = 0
  for (;;) {
    const { body } = await call(`/api/media/tasks/${taskId}/wait`, { since, timeoutMs: 2000 })
    since = body.nextSince
    if (['done', 'failed', 'interrupted'].includes(body.status)) return body
  }
}

const media = (name: string): string => join(cwd, 'film', 'canvas', 'media', name)

/** A saved board (no page open) with one video node. */
async function board(): Promise<CanvasDocumentStore> {
  const store = new CanvasDocumentStore(cwd, 'film')
  await store.write('film-1', {
    ...emptyFilmBoard('film-1', 'A'),
    nodes: [
      { id: 'src', type: 'video', title: 'shot', position: { x: 100, y: 50 }, width: 320, height: 180, metadata: { content: '/api/projects/film/raw/canvas/media/src.mp4' } },
      { id: 'second', type: 'video', title: 'shot 2', position: { x: 100, y: 400 }, width: 320, height: 180, metadata: { content: '/api/projects/film/raw/canvas/media/b.mp4' } },
    ],
    connections: [],
  })
  return store
}

describe('POST /api/canvas/video/:boardId/probe', () => {
  it('answers each path\'s facts, and ok: false for a missing or unreadable file', async () => {
    await writeFixture(media('src.mp4'), { frames: 50 })
    await writeFile(media('broken.mp4'), 'nope')
    const { status, body } = await call('/api/canvas/video/film-1/probe', { paths: ['canvas/media/src.mp4', '/api/projects/film/raw/canvas/media/src.mp4', 'canvas/media/none.mp4', 'canvas/media/broken.mp4'] })
    expect(status).toBe(200)
    expect(body.items[0]).toMatchObject({ path: 'canvas/media/src.mp4', ok: true, width: 64, height: 64, hasAudio: true, video: { codec: 'avc', codedWidth: 64, codedHeight: 64 }, audio: { codec: 'aac', sampleRate: 48000, channels: 2 }, keyframesMs: [0, 1000] })
    expect(body.items[0].rotation).toBeUndefined()
    expect(body.items[1]).toMatchObject({ ok: true, durationMs: body.items[0].durationMs })
    expect(body.items.slice(2)).toEqual([{ path: 'canvas/media/none.mp4', ok: false }, { path: 'canvas/media/broken.mp4', ok: false }])
  })

  it('refuses an empty list and paths outside film/', async () => {
    expect(await call('/api/canvas/video/film-1/probe', { paths: [] })).toMatchObject({ status: 400, body: { code: 'MEDIA_EDIT_INVALID' } })
    expect(await call('/api/canvas/video/film-1/probe', { paths: ['../secret.mp4'] })).toMatchObject({ status: 400, body: { code: 'MEDIA_EDIT_INVALID' } })
  })
})

describe('POST /api/canvas/video/:boardId/cut', () => {
  it('cuts as a film task, answers a repeated request id with the same task, and writes the file once', async () => {
    await writeFixture(media('src.mp4'), { frames: 75 })
    const body = { requestId: 'a6f1c8e2-0000-4000-8000-000000000001', source: { nodeId: 'src', path: 'canvas/media/src.mp4' }, inMs: 1000, outMs: 2000 }
    const first = await call('/api/canvas/video/film-1/cut', body)
    expect(first).toMatchObject({ status: 202, body: { taskId: expect.any(String) } })
    const again = await call('/api/canvas/video/film-1/cut', body)
    expect(again).toMatchObject({ status: 202, body: { taskId: first.body.taskId } })
    const done = await finished(first.body.taskId)
    expect(done).toMatchObject({ status: 'done', file: { kind: 'video', mime: 'video/mp4', width: 64, height: 64, derivedFrom: { v: 1, op: 'cut', engine: 'host-copy', requestId: body.requestId, sources: [{ nodeId: 'src', path: 'canvas/media/src.mp4', inMs: 1000, outMs: 2000 }] } } })
    expect(done.file.name).toMatch(/^canvas\/media\/clip-[0-9a-f]{10}\.mp4$/)
    expect(done.file.landedNodeId).toBeUndefined()
    expect(done.progress).toContain('完成')
    // Done, the same request id still answers with that task (even with another body) and makes nothing new.
    expect(await call('/api/canvas/video/film-1/cut', { ...body, inMs: 0 })).toMatchObject({ status: 202, body: { taskId: first.body.taskId, status: 'done' } })
    expect((await readdir(join(cwd, 'film', 'canvas', 'media'))).sort()).toEqual([done.file.name.split('/').pop(), 'src.mp4'].sort())
    expect(seen).toContainEqual({ type: 'file-changed', projectId: 'film', path: done.file.name })
    // The same id for another edit is a conflict.
    expect(await call('/api/canvas/video/film-1/extract-audio', { requestId: body.requestId, source: { path: 'canvas/media/src.mp4' } })).toMatchObject({ status: 409, body: { code: 'MEDIA_EDIT_REQUEST_CONFLICT' } })
  })

  it('lands the result right of the source with a derived edge on a closed board', async () => {
    await writeFixture(media('src.mp4'), { frames: 75 })
    const store = await board()
    const started = await call('/api/canvas/video/film-1/cut', {
      requestId: 'a6f1c8e2-0000-4000-8000-000000000002', source: { nodeId: 'src', path: '/api/projects/film/raw/canvas/media/src.mp4' }, inMs: 500, outMs: 1500,
      land: { nearNodeId: 'src', connectFrom: ['src', 'gone'], title: '片段 1' },
    })
    const done = await finished(started.body.taskId)
    expect(done.status).toBe('done')
    const landed = done.file.landedNodeId as string
    expect(landed).toMatch(/^video-/)
    const document = (await store.read('film-1'))!
    const node = document.nodes.find((entry: any) => entry.id === landed) as any
    expect(node).toMatchObject({ type: 'video', title: '片段 1', position: { x: 100 + 320 + 96, y: 50 } })
    expect(node.metadata).toMatchObject({
      content: `/api/projects/film/raw/${done.file.name}`, status: 'success', mimeType: 'video/mp4', naturalWidth: 64, naturalHeight: 64,
      derivedFrom: { v: 1, op: 'cut', engine: 'host-copy', sources: [{ nodeId: 'src', path: 'canvas/media/src.mp4', inMs: 500, outMs: 1500 }] },
    })
    for (const key of ['videoAttempt', 'videoGenerationInput', 'videoTaskId', 'gatewayReceipt']) expect(node.metadata[key]).toBeUndefined()
    expect(document.connections).toEqual([{ id: `derived:${landed}:src`, fromNodeId: 'src', toNodeId: landed }])
    expect(seen).toContainEqual({ type: 'story-canvas-changed', projectId: 'film', boardId: 'film-1' })
    // A second cut of the same source lands below the first, not on it.
    const next = await call('/api/canvas/video/film-1/cut', { requestId: 'a6f1c8e2-0000-4000-8000-000000000003', source: { nodeId: 'src', path: 'canvas/media/src.mp4' }, inMs: 0, outMs: 1000, land: { nearNodeId: 'src', connectFrom: ['src'] } })
    const second = await finished(next.body.taskId)
    const below = (await store.read('film-1'))!.nodes.find((entry: any) => entry.id === second.file.landedNodeId) as any
    expect(below.position.x).toBe(516)
    expect(below.position.y).toBeGreaterThanOrEqual(50 + node.height)
  })

  it('refuses paths outside film/, missing sources, short and out-of-range cuts, and bad request ids', async () => {
    await writeFixture(media('src.mp4'), { frames: 50 })
    await writeFixture(join(outside, 'x.mp4'), { frames: 25 })
    await symlink(outside, join(cwd, 'film', 'canvas', 'linked'), 'junction')
    const cut = (requestId: string, path: unknown, inMs = 0, outMs = 1000) => call('/api/canvas/video/film-1/cut', { requestId, source: { path }, inMs, outMs })
    expect(await cut('b0000000-0001', '../outside.mp4')).toMatchObject({ status: 400, body: { code: 'MEDIA_EDIT_INVALID' } })
    expect(await cut('b0000000-0002', join(outside, 'x.mp4'))).toMatchObject({ status: 400, body: { code: 'MEDIA_EDIT_INVALID' } })
    expect(await cut('b0000000-0003', 'canvas/linked/x.mp4')).toMatchObject({ status: 400, body: { code: 'MEDIA_EDIT_INVALID', error: expect.stringContaining('outside film/') } })
    expect(await cut('b0000000-0004', 'canvas/media/none.mp4')).toMatchObject({ status: 404, body: { code: 'MEDIA_EDIT_SOURCE_NOT_FOUND' } })
    expect(await cut('b0000000-0005', 'canvas/media/src.mp4', 1000, 1050)).toMatchObject({ status: 400, body: { code: 'MEDIA_EDIT_INVALID' } })
    expect(await cut('b0000000-0006', 'canvas/media/src.mp4', 1000, 9000)).toMatchObject({ status: 400, body: { code: 'MEDIA_EDIT_INVALID' } })
    expect(await cut('short', 'canvas/media/src.mp4')).toMatchObject({ status: 400, body: { code: 'MEDIA_EDIT_INVALID' } })
    await writeFile(media('broken.mp4'), 'nope')
    expect(await cut('b0000000-0007', 'canvas/media/broken.mp4')).toMatchObject({ status: 422, body: { code: 'MEDIA_EDIT_UNSUPPORTED' } })
    expect(await readdir(join(cwd, 'film', 'canvas', 'media'))).toEqual(['broken.mp4', 'src.mp4'])
  })

  it('answers 503 MEDIA_EDIT_BUSY past two running edits in a workspace', async () => {
    await writeFixture(media('src.mp4'), { frames: 50 })
    const hold = () => new Promise<never>(() => {})
    await tasks.startLocal(cwd, 'film', { capability: 'video.cut', requestId: 'c0000000-0001', parameters: {}, surface: 'video' }, hold)
    await tasks.startLocal(cwd, 'film', { capability: 'video.cut', requestId: 'c0000000-0002', parameters: {}, surface: 'video' }, hold)
    expect(await call('/api/canvas/video/film-1/cut', { requestId: 'c0000000-0003', source: { path: 'canvas/media/src.mp4' }, inMs: 0, outMs: 1000 }))
      .toMatchObject({ status: 503, body: { code: 'MEDIA_EDIT_BUSY' } })
  })
})

describe('POST /api/canvas/video/:boardId/join', () => {
  it('joins compatible clips and lands a final concat node with an edge from every source', async () => {
    await writeFixture(media('src.mp4'), { frames: 50 })
    await writeFixture(media('b.mp4'), { frames: 50 })
    const store = await board()
    const started = await call('/api/canvas/video/film-1/join', {
      requestId: 'd0000000-0000-4000-8000-000000000001',
      clips: [{ nodeId: 'src', path: 'canvas/media/src.mp4' }, { nodeId: 'second', path: 'canvas/media/b.mp4', inMs: 1000 }],
      land: { nearNodeId: 'second', connectFrom: ['src', 'second'] },
    })
    expect(started.status).toBe(202)
    const done = await finished(started.body.taskId)
    expect(done).toMatchObject({ status: 'done', file: { kind: 'video', derivedFrom: { op: 'join', sources: [{ nodeId: 'src', inMs: 0 }, { nodeId: 'second', inMs: 1000 }] } } })
    expect(done.file.name).toMatch(/^canvas\/media\/join-[0-9a-f]{10}\.mp4$/)
    expect(done.file.durationMs).toBeGreaterThanOrEqual(3000)
    expect(done.file.durationMs).toBeLessThan(3050)
    const document = (await store.read('film-1'))!
    const node = document.nodes.find((entry: any) => entry.id === done.file.landedNodeId) as any
    expect(node).toMatchObject({ position: { x: 516, y: 400 }, metadata: { workflowKind: 'final', videoEditOperation: 'concat', derivedFrom: { engine: 'host-copy' } } })
    expect(document.connections).toEqual([
      { id: `derived:${node.id}:src`, fromNodeId: 'src', toNodeId: node.id },
      { id: `derived:${node.id}:second`, fromNodeId: 'second', toNodeId: node.id },
    ])
  })

  it('answers 422 VIDEO_JOIN_NEEDS_TRANSCODE with the reasons, so the page re-encodes', async () => {
    await writeFixture(media('src.mp4'), { frames: 50 })
    await writeFixture(media('wide.mp4'), { width: 96 })
    await writeFixture(media('mute.mp4'), { audio: false })
    const { status, body } = await call('/api/canvas/video/film-1/join', {
      requestId: 'd0000000-0000-4000-8000-000000000002',
      clips: [{ path: 'canvas/media/src.mp4' }, { path: 'canvas/media/wide.mp4' }, { path: 'canvas/media/mute.mp4', inMs: 500 }],
    })
    expect(status).toBe(422)
    expect(body.code).toBe('VIDEO_JOIN_NEEDS_TRANSCODE')
    expect(body.reasons.map((reason: any) => [reason.index, reason.reason])).toEqual([[1, 'resolution'], [2, 'missing-audio'], [2, 'not-keyframe']])
    expect(await readdir(join(cwd, 'film', 'canvas', 'media'))).toHaveLength(3)
    expect(await call('/api/canvas/video/film-1/join', { requestId: 'd0000000-0003', clips: [{ path: 'canvas/media/src.mp4' }] })).toMatchObject({ status: 400, body: { code: 'MEDIA_EDIT_INVALID' } })
  })
})

describe('POST /api/canvas/video/:boardId/extract-audio', () => {
  it('copies the sound into an .m4a and lands an audio node beside the video', async () => {
    await writeFixture(media('src.mp4'), { frames: 50 })
    const store = await board()
    const started = await call('/api/canvas/video/film-1/extract-audio', { requestId: 'e0000000-0001', source: { nodeId: 'src', path: 'canvas/media/src.mp4' }, land: { nearNodeId: 'src', connectFrom: ['src'] } })
    const done = await finished(started.body.taskId)
    expect(done).toMatchObject({ status: 'done', file: { kind: 'audio', mime: 'audio/mp4', derivedFrom: { op: 'extract-audio', sources: [{ nodeId: 'src', inMs: 0 }] } } })
    expect(done.file.name).toMatch(/^canvas\/media\/extract-[0-9a-f]{10}\.m4a$/)
    const node = (await store.read('film-1'))!.nodes.find((entry: any) => entry.id === done.file.landedNodeId) as any
    expect(node).toMatchObject({ type: 'audio', position: { x: 516, y: 50 }, metadata: { mimeType: 'audio/mp4' } })
  })

  it('answers 422 VIDEO_NO_AUDIO_TRACK for a video without sound', async () => {
    await writeFixture(media('mute.mp4'), { audio: false })
    expect(await call('/api/canvas/video/film-1/extract-audio', { requestId: 'e0000000-0002', source: { path: 'canvas/media/mute.mp4' } }))
      .toMatchObject({ status: 422, body: { code: 'VIDEO_NO_AUDIO_TRACK', error: '这个视频没有音轨。' } })
  })
})
