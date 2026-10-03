/** The editing desk's cut: the store, and the timeline endpoints as the desk's host page calls them. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStudioRouter } from '../src/routes.js'
import { createEmptyTimelineArchive } from '../src/timeline/archive.js'
import { MAX_HISTORY, TimelineConflictError, TimelineInvalidError, TimelineStore } from '../src/timeline/store.js'

let cwd: string
let router: ReturnType<typeof createStudioRouter>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-timeline-'))
  router = createStudioRouter()
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function request(studioPath: string, options: { method?: string; body?: NonNullable<RequestInit['body']>; json?: unknown } = {}): Request {
  const method = options.method ?? 'GET'
  const url = new URL(`http://host/api/dsh-film/${method === 'GET' ? 'studio' : 'studio-write'}`)
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', studioPath)
  if (method !== 'GET') url.searchParams.set('method', method)
  const init: RequestInit = { method: method === 'GET' ? 'GET' : 'POST' }
  if (options.json !== undefined) {
    init.body = JSON.stringify(options.json)
    init.headers = { 'content-type': 'application/json' }
  } else if (options.body !== undefined) {
    init.body = options.body
  }
  return new Request(url, init)
}

async function call(studioPath: string, options: Parameters<typeof request>[1] = {}) {
  const response = await router.dispatch(request(studioPath, options))
  return { status: response.status, body: await response.json() as any }
}

/** A cut with one caption, so two cuts differ. */
const cut = (caption: string) => {
  const archive = createEmptyTimelineArchive('16:9')
  ;(archive.project.captionSegments as unknown[]).push({ id: 'c1', text: caption, start: 0, duration: 2 })
  return archive
}

const TIMELINE = '/api/canvas/timelines/film-1?project=film-1'

describe('timeline store', () => {
  it('starts empty, saves on the current revision and refuses a stale one', async () => {
    const store = new TimelineStore(cwd)
    expect(await store.read()).toEqual({ document: null, revision: 0, canUndo: false, canRedo: false, historyLength: 0 })
    const first = await store.save({ document: cut('一'), baseRevision: 0 })
    expect(first).toMatchObject({ revision: 1, canUndo: false, historyLength: 1 })
    await expect(store.save({ document: cut('二'), baseRevision: 0 })).rejects.toBeInstanceOf(TimelineConflictError)
    await expect(store.save({ document: { format: 'other' }, baseRevision: 1 })).rejects.toBeInstanceOf(TimelineInvalidError)
    const onDisk = JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'timeline.json'), 'utf8'))
    expect(onDisk).toMatchObject({ revision: 1, cursor: 0 })
  })

  it('does not spend a revision on the same cut with its keys in another order', async () => {
    const store = new TimelineStore(cwd)
    const document = cut('一')
    await store.save({ document, baseRevision: 0 })
    const reordered = Object.fromEntries(Object.entries(document).reverse())
    expect(await store.save({ document: reordered, baseRevision: 1 })).toMatchObject({ revision: 1, historyLength: 1 })
  })

  it('walks the history and drops the redo branch on a new edit', async () => {
    const store = new TimelineStore(cwd)
    await store.save({ document: cut('一'), baseRevision: 0 })
    await store.save({ document: cut('二'), baseRevision: 1 })
    const undone = await store.undo(2)
    expect(undone).toMatchObject({ revision: 3, canUndo: false, canRedo: true })
    expect((undone.document as any).project.captionSegments[0].text).toBe('一')
    await expect(store.redo(2)).rejects.toBeInstanceOf(TimelineConflictError)
    expect(await store.undo()).toMatchObject({ revision: 3 })
    const edited = await store.save({ document: cut('三'), baseRevision: 3 })
    expect(edited).toMatchObject({ revision: 4, canRedo: false, historyLength: 2 })
  })

  it('keeps at most the last cuts undo can reach', async () => {
    const store = new TimelineStore(cwd)
    for (let index = 0; index < MAX_HISTORY + 3; index++) await store.save({ document: cut(String(index)), baseRevision: index })
    expect(await store.read()).toMatchObject({ revision: MAX_HISTORY + 3, historyLength: MAX_HISTORY })
  })

  it('serialises concurrent saves so only one lands on a revision', async () => {
    const outcomes = await Promise.allSettled([
      new TimelineStore(cwd).save({ document: cut('甲'), baseRevision: 0 }),
      new TimelineStore(cwd).save({ document: cut('乙'), baseRevision: 0 }),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
  })
})

describe('timeline endpoints', () => {
  it('reads, saves and answers a stale save with the current state', async () => {
    expect(await call(TIMELINE)).toMatchObject({ status: 200, body: { document: null, revision: 0 } })
    expect(await call(TIMELINE, { method: 'PUT', json: { document: cut('一'), baseRevision: 0 } })).toMatchObject({ status: 200, body: { revision: 1 } })
    const stale = await call(TIMELINE, { method: 'PUT', json: { document: cut('二'), baseRevision: 0 } })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ code: 'CANVAS_TIMELINE_CONFLICT', current: { revision: 1 } })
    expect(stale.body.current.document.project.captionSegments[0].text).toBe('一')
    expect(await call(TIMELINE, { method: 'PUT', json: { document: cut('二') } })).toMatchObject({ status: 400, body: { code: 'CANVAS_TIMELINE_INVALID' } })
    expect(await call(TIMELINE, { method: 'PUT', json: { document: { format: 'x' }, baseRevision: 1 } })).toMatchObject({ status: 400, body: { code: 'CANVAS_TIMELINE_INVALID' } })
  })

  it('undoes and redoes, checking the revision when one is given', async () => {
    await call(TIMELINE, { method: 'PUT', json: { document: cut('一'), baseRevision: 0 } })
    await call(TIMELINE, { method: 'PUT', json: { document: cut('二'), baseRevision: 1 } })
    const undone = await call('/api/canvas/timelines/film-1/undo?project=film-1', { method: 'POST', json: { baseRevision: 2 } })
    expect(undone).toMatchObject({ status: 200, body: { revision: 3, canRedo: true } })
    expect((await call('/api/canvas/timelines/film-1/redo', { method: 'POST', json: { baseRevision: 2 } })).status).toBe(409)
    expect(await call('/api/canvas/timelines/film-1/redo', { method: 'POST', json: {} })).toMatchObject({ status: 200, body: { revision: 4, canRedo: false } })
    expect((await call('/api/canvas/timelines/film-1/undo', { method: 'POST', json: { baseRevision: -1 } })).status).toBe(400)
  })

  it('places a film file through a command plan and keeps the first cut for undo', async () => {
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'shot-1.png'), 'png')
    const placed = await call('/api/canvas/timelines/film-1/commands?project=film-1', {
      method: 'POST',
      json: {
        schemaVersion: 1, operationId: 'place:t1', dryRun: false,
        plan: { schemaVersion: 1, baseRevision: 0, operations: [{ id: 'place:t1', type: 'asset.place_version', clipId: 'clip-1', assetId: 'a1', versionId: 'canvas-file:canvas/media/shot-1.png', track: 'visuals' }] },
      },
    })
    expect(placed.status).toBe(200)
    expect(placed.body.result).toMatchObject({ committed: true, revision: 1, duplicate: false, appliedOperationIds: ['place:t1'] })
    const state = (await call(TIMELINE)).body
    expect(state).toMatchObject({ revision: 1, historyLength: 2, canUndo: true })
    const clip = state.document.project.visualSegments[0]
    expect(clip).toMatchObject({ id: 'clip-1', assetVersionId: 'canvas-file:canvas/media/shot-1.png', sourceUrl: '/api/projects/film-1/raw/canvas/media/shot-1.png', duration: 5 })
    expect(clip.src).toBeUndefined()
    const again = await call('/api/canvas/timelines/film-1/commands', {
      method: 'POST',
      json: { operationId: 'place:t1', plan: { schemaVersion: 1, baseRevision: 1, operations: [{ id: 'place:t1', type: 'asset.place_version', clipId: 'clip-1', assetId: 'a1', versionId: 'canvas-file:canvas/media/shot-1.png', track: 'visuals' }] } },
    })
    expect(again.body.result).toMatchObject({ committed: false, duplicate: true, revision: 1 })
  })

  it('refuses placements of files outside the film or of the wrong kind', async () => {
    await writeFile(join(cwd, 'secret.png'), 'png')
    const plan = (versionId: string, track = 'visuals') => ({ operationId: 'op', plan: { schemaVersion: 1, baseRevision: 0, operations: [{ id: 'op', type: 'asset.place_version', clipId: 'c', assetId: 'a', versionId, track }] } })
    expect(await call('/api/canvas/timelines/film-1/commands', { method: 'POST', json: plan('canvas-file:../secret.png') })).toMatchObject({ status: 422, body: { code: 'ASSET_VERSION_FILE_INVALID', operationId: 'op' } })
    expect(await call('/api/canvas/timelines/film-1/commands', { method: 'POST', json: plan('asset-1') })).toMatchObject({ status: 422, body: { code: 'ASSET_VERSION_NOT_FOUND' } })
    expect(await call('/api/canvas/timelines/film-1/commands', { method: 'POST', json: plan('canvas-file:canvas/media/a.png', 'music') })).toMatchObject({ status: 422, body: { code: 'ASSET_VERSION_TRACK_MISMATCH' } })
    expect(await call('/api/canvas/timelines/film-1/commands', { method: 'POST', json: { operationId: 'op', plan: { schemaVersion: 1, baseRevision: 0, operations: [] } } })).toMatchObject({ status: 400, body: { code: 'CANVAS_TIMELINE_COMMAND_INVALID' } })
    expect((await call('/api/canvas/timelines/film-1/commands', { method: 'POST', json: { ...plan('canvas-file:x.png'), plan: { ...plan('canvas-file:x.png').plan, baseRevision: 5 } } })).status).toBe(409)
  })

  it('lists the film\'s media as assets and the workspace media folder as importable files', async () => {
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await mkdir(join(cwd, 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'shot 1.mp4'), 'mp4')
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'notes.txt'), 'x')
    await writeFile(join(cwd, 'media', 'music.mp3'), 'mp3')
    const { body } = await call('/api/canvas/timelines/film-1/material?project=film-1')
    expect(body.assets).toEqual([{
      assetId: 'canvas-file:canvas/media/shot 1.mp4', versionId: 'canvas-file:canvas/media/shot 1.mp4', kind: 'video', name: 'shot 1.mp4',
      url: '/api/projects/film-1/raw/canvas/media/shot%201.mp4', mimeType: 'video/mp4', sizeBytes: 3,
    }])
    expect(body.projectFiles).toHaveLength(1)
    expect(body.projectFiles[0]).toMatchObject({ id: 'workspace:media/music.mp3', path: 'media/music.mp3', kind: 'audio', mimeType: 'audio/mpeg' })
    expect(new URL(body.projectFiles[0].url, 'http://host').searchParams.get('path')).toBe(join(cwd, 'media', 'music.mp3'))
  })

  it('answers the community library the editor asks first with nothing', async () => {
    expect(await call('/api/community/media?kind=image&limit=24')).toEqual({ status: 200, body: { items: [] } })
  })

  it('imports a workspace media file into the film under a free name', async () => {
    await mkdir(join(cwd, 'media'), { recursive: true })
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'media', 'take.mp4'), 'new')
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'take.mp4'), 'old')
    const imported = await call('/api/canvas/timelines/film-1/import', { method: 'POST', json: { path: 'media/take.mp4' } })
    expect(imported).toMatchObject({ status: 200, body: { file: { name: 'canvas/media/take-2.mp4', size: 3, mime: 'video/mp4' } } })
    expect(await readFile(join(cwd, 'film', 'canvas', 'media', 'take-2.mp4'), 'utf8')).toBe('new')
    expect(await readFile(join(cwd, 'film', 'canvas', 'media', 'take.mp4'), 'utf8')).toBe('old')
    expect((await call('/api/canvas/timelines/film-1/import', { method: 'POST', json: { path: 'film/film.json' } })).status).toBe(400)
    expect((await call('/api/canvas/timelines/film-1/import', { method: 'POST', json: { path: 'media/../secret.mp4' } })).status).toBe(400)
    expect((await call('/api/canvas/timelines/film-1/import', { method: 'POST', json: { path: 'media/none.mp4' } })).status).toBe(404)
  })

  it('takes a raw upload, keeping an existing file when asked for a unique name', async () => {
    const first = await call('/api/projects/film-1/raw/canvas/renders/cut.mp4?unique=1', { method: 'PUT', body: new Blob(['one']) })
    expect(first).toMatchObject({ status: 200, body: { file: { name: 'canvas/renders/cut.mp4', size: 3, mime: 'video/mp4' } } })
    const second = await call('/api/projects/film-1/raw/canvas/renders/cut.mp4?unique=1', { method: 'PUT', body: new Blob(['two!']) })
    expect(second.body.file).toMatchObject({ name: 'canvas/renders/cut-2.mp4', size: 4 })
    const replaced = await call('/api/projects/film-1/raw/canvas/renders/cut.mp4', { method: 'PUT', body: new Blob(['three']) })
    expect(replaced.body.file).toMatchObject({ name: 'canvas/renders/cut.mp4', size: 5 })
    expect(await readFile(join(cwd, 'film', 'canvas', 'renders', 'cut.mp4'), 'utf8')).toBe('three')
    expect(await readFile(join(cwd, 'film', 'canvas', 'renders', 'cut-2.mp4'), 'utf8')).toBe('two!')
    expect((await call('/api/canvas/timelines/film-1/renders')).body.renders.map((render: { path: string }) => render.path).sort())
      .toEqual(['canvas/renders/cut-2.mp4', 'canvas/renders/cut.mp4'])
    // A literal `..` is resolved away by URL parsing; an encoded one reaches the path check.
    expect((await call('/api/projects/film-1/raw/../escape.mp4', { method: 'PUT', body: new Blob(['x']) })).status).toBe(404)
    expect((await call('/api/projects/film-1/raw/%2E%2E%2Fescape.mp4', { method: 'PUT', body: new Blob(['x']) })).status).toBe(400)
  })
})
