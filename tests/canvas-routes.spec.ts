/** The canvas and project endpoints as the hosted canvas calls them. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasDocumentStore, emptyFilmBoard } from '../src/canvas/documents.js'
import { createStudioRouter } from '../src/routes.js'

let cwd: string
let router: ReturnType<typeof createStudioRouter>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-canvas-'))
  router = createStudioRouter()
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function request(studioPath: string, options: { method?: string; body?: NonNullable<RequestInit['body']>; json?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Request {
  const url = new URL('http://host/api/dsh-film/studio')
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', studioPath)
  const method = options.method ?? 'GET'
  if (method !== 'GET' && method !== 'POST') url.searchParams.set('method', method)
  const init: RequestInit = { method: method === 'GET' ? 'GET' : 'POST', headers: { ...options.headers } }
  if (options.signal) init.signal = options.signal
  if (options.json !== undefined) {
    init.body = JSON.stringify(options.json)
    init.headers = { ...options.headers, 'content-type': 'application/json' }
  } else if (options.body !== undefined) {
    init.body = options.body
  }
  return new Request(url, init)
}

async function call(studioPath: string, options: Parameters<typeof request>[1] = {}) {
  const response = await router.dispatch(request(studioPath, options))
  const type = response.headers.get('content-type') ?? ''
  return { status: response.status, body: type.startsWith('application/json') ? await response.json() as any : undefined, response }
}

const BOARD = { id: 'film-1', title: '雨夜来客', nodes: [{ id: 'n1', type: 'text', text: '开场' }], connections: [] }

describe('canvas documents', () => {
  it('starts empty, saves by merge and reads the board back', async () => {
    expect(await call('/api/canvas/documents?project=film-1')).toMatchObject({ status: 200, body: { documents: [], deleted: [] } })
    expect((await call('/api/canvas/documents/film-1?project=film-1')).body).toEqual({ error: 'no canvas document film-1', code: 'CANVAS_DOCUMENT_NOT_FOUND' })
    const saved = await call('/api/canvas/documents/film-1/merge?project=film-1', { method: 'POST', json: { base: null, document: BOARD } })
    expect(saved.status).toBe(200)
    expect(saved.body.document.nodes).toEqual(BOARD.nodes)
    expect(saved.body.summary).toMatchObject({ id: 'film-1', projectId: 'film-1', title: '雨夜来客' })
    const onDisk = JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'document.json'), 'utf8'))
    expect(onDisk.nodes).toEqual(BOARD.nodes)
    expect((await call('/api/canvas/documents/film-1?project=film-1')).body.nodes).toEqual(BOARD.nodes)
  })

  it('merges edits to different nodes and refuses a two-sided edit of one', async () => {
    const first = (await call('/api/canvas/documents/film-1/merge', { method: 'POST', json: { base: null, document: BOARD } })).body.document
    const mine = { ...first, nodes: [...first.nodes, { id: 'n2', type: 'image' }] }
    const theirs = { ...first, nodes: [{ ...first.nodes[0], text: '开场（改）' }] }
    await call('/api/canvas/documents/film-1/merge', { method: 'POST', json: { base: first, document: theirs } })
    const merged = await call('/api/canvas/documents/film-1/merge', { method: 'POST', json: { base: first, document: mine } })
    expect(merged.body.document.nodes.map((node: { id: string }) => node.id).sort()).toEqual(['n1', 'n2'])
    expect(merged.body.document.nodes.find((node: { id: string }) => node.id === 'n1').text).toBe('开场（改）')
    const conflicting = { ...first, nodes: [{ ...first.nodes[0], text: '另一个开场' }] }
    const refused = await call('/api/canvas/documents/film-1/merge', { method: 'POST', json: { base: first, document: conflicting } })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ code: 'CANVAS_MERGE_CONFLICT', paths: ['nodes.n1.text'] })
  })

  it('leaves a tombstone when the board is deleted and refuses merges until it is recreated', async () => {
    await call('/api/canvas/documents/film-1/merge', { method: 'POST', json: { base: null, document: BOARD } })
    expect((await call('/api/canvas/documents/film-1', { method: 'DELETE' })).body).toEqual({ ok: true })
    expect((await call('/api/canvas/documents?project=film-1')).body.deleted).toMatchObject([{ id: 'film-1', projectId: 'film-1' }])
    const refused = await call('/api/canvas/documents/film-1/merge', { method: 'POST', json: { base: null, document: BOARD } })
    expect(refused).toMatchObject({ status: 409, body: { code: 'CANVAS_DOCUMENT_DELETED' } })
  })

  it('gives a film made without a board (0.1.0) its empty board when its own board is listed', async () => {
    const film = { format: 'vibedev.film', version: 1, id: 'film-legacy', title: '旧片', aspectRatio: '4:3', createdAt: 'a', updatedAt: 'a' }
    await mkdir(join(cwd, 'film'), { recursive: true })
    await writeFile(join(cwd, 'film', 'film.json'), JSON.stringify(film))
    // Another project id, or none, is not this film's board: nothing is made.
    expect((await call('/api/canvas/documents?project=other')).body.documents).toEqual([])
    expect((await call('/api/canvas/documents')).body.documents).toEqual([])
    await expect(readFile(join(cwd, 'film', 'canvas', 'document.json'))).rejects.toThrow()

    const listed = await call('/api/canvas/documents?project=film-legacy')
    expect(listed.body).toMatchObject({ documents: [{ id: 'film-legacy', projectId: 'film-legacy', title: '旧片' }], deleted: [] })
    expect((await call('/api/canvas/documents/film-legacy?project=film-legacy')).body).toMatchObject({
      id: 'film-legacy', title: '旧片', nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: 'lines', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
    })
  })

  it('never makes a listed board over a saved, damaged or deleted one', async () => {
    const film = { format: 'vibedev.film', version: 1, id: 'film-1', title: '雨夜来客', aspectRatio: '16:9', createdAt: 'a', updatedAt: 'a' }
    await mkdir(join(cwd, 'film', 'canvas'), { recursive: true })
    await writeFile(join(cwd, 'film', 'film.json'), JSON.stringify(film))
    await writeFile(join(cwd, 'film', 'canvas', 'document.json'), '{ damaged')
    expect((await call('/api/canvas/documents?project=film-1')).body.documents).toEqual([])
    expect(await readFile(join(cwd, 'film', 'canvas', 'document.json'), 'utf8')).toBe('{ damaged')

    await rm(join(cwd, 'film', 'canvas', 'document.json'))
    await writeFile(join(cwd, 'film', 'canvas', 'document.deleted.json'), JSON.stringify({ id: 'film-1', deletedAt: 'z' }))
    expect((await call('/api/canvas/documents?project=film-1')).body).toMatchObject({ documents: [], deleted: [{ id: 'film-1' }] })
    await expect(readFile(join(cwd, 'film', 'canvas', 'document.json'))).rejects.toThrow()

    await rm(join(cwd, 'film', 'canvas', 'document.deleted.json'))
    const saved = await call('/api/canvas/documents/film-1/merge?project=film-1', { method: 'POST', json: { base: null, document: BOARD } })
    expect(saved.status).toBe(200)
    expect((await call('/api/canvas/documents?project=film-1')).body.documents).toMatchObject([{ id: 'film-1', title: '雨夜来客' }])
    expect(JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'document.json'), 'utf8')).nodes).toEqual(BOARD.nodes)
  })

  it('lists normally beside a broken project file', async () => {
    await mkdir(join(cwd, 'film'), { recursive: true })
    await writeFile(join(cwd, 'film', 'film.json'), 'not json')
    expect(await call('/api/canvas/documents?project=film-1')).toMatchObject({ status: 200, body: { documents: [], deleted: [] } })
  })

  it('rejects a draft that does not match the board', async () => {
    const result = await call('/api/canvas/documents/film-1/merge', { method: 'POST', json: { base: null, document: { ...BOARD, id: 'other' } } })
    expect(result).toMatchObject({ status: 400, body: { code: 'STORY_BOARD_INVALID' } })
  })
})

describe('CanvasDocumentStore.create', () => {
  it('saves a board only where there is none, and says what it found', async () => {
    const store = new CanvasDocumentStore(cwd, 'film-1')
    const results = await Promise.all([store.create(emptyFilmBoard('film-1', 'A')), store.create(emptyFilmBoard('film-1', 'B'))])
    expect(results.sort()).toEqual(['created', 'exists'])
    const saved = JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'document.json'), 'utf8'))
    expect(['A', 'B']).toContain(saved.title)
    await store.remove('film-1')
    expect(await store.create(emptyFilmBoard('film-1', 'C'))).toBe('deleted')
    expect(await store.read('film-1')).toBeNull()
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(join(cwd, 'film', 'canvas'))).filter(name => name.includes('.tmp'))).toEqual([])
  })
})

describe('project files', () => {
  it('uploads into the project and serves the file back by range', async () => {
    const form = new FormData()
    form.append('name', 'canvas/uploads/k1-abc-导演台截图.png')
    form.append('file', new Blob([new Uint8Array(100).fill(7)], { type: 'image/png' }), 'shot.png')
    const uploaded = await call('/api/projects/film-1/files', { method: 'POST', body: form })
    expect(uploaded.body).toEqual({ file: { name: 'canvas/uploads/k1-abc-导演台截图.png', size: 100, mime: 'image/png' } })
    const raw = await call(`/api/projects/film-1/raw/canvas/uploads/${encodeURIComponent('k1-abc-导演台截图.png')}`, { headers: { range: 'bytes=0-9' } })
    expect(raw.status).toBe(206)
    expect(raw.response.headers.get('content-type')).toBe('image/png')
    expect((await raw.response.arrayBuffer()).byteLength).toBe(10)
  })

  it('refuses paths outside the project and sandboxes documents', async () => {
    await mkdir(join(cwd, 'film', 'canvas'), { recursive: true })
    await writeFile(join(cwd, 'secret.txt'), 'outside')
    expect((await call('/api/projects/film-1/raw/../secret.txt')).status).toBe(404)
    expect((await call(`/api/projects/film-1/raw/${encodeURIComponent('../secret.txt')}`)).status).toBe(400)
    await writeFile(join(cwd, 'film', 'canvas', 'page.html'), '<script>alert(1)</script>')
    const page = await call('/api/projects/film-1/raw/canvas/page.html')
    expect(page.response.headers.get('content-security-policy')).toContain('sandbox')
  })
})

describe('event streams', () => {
  it('hands an open canvas page its lease', async () => {
    const controller = new AbortController()
    const response = await router.dispatch(request('/api/canvas/agent/events?projectId=film-1&clientId=c1&incarnation=i1', { signal: controller.signal }))
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toMatch(/^event: hello\ndata: \{"target":\{"projectId":"film-1","clientId":"c1","incarnation":"i1"\},"generation":"[^"]+","writeToken":"[^"]+"\}\n\n$/)
    controller.abort()
  })

  it('tells project subscribers about screenplay changes', async () => {
    const controller = new AbortController()
    const response = await router.dispatch(request('/api/projects/film-1/events', { signal: controller.signal }))
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: ready\ndata: {}\n\n')
    await call('/api/projects/film-1/story/documents', { method: 'POST', json: { title: '事件' } })
    expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/^event: story-changed\ndata: \{"type":"story-changed","documentId":"doc_[^"]+","revision":"[a-f0-9]{64}"\}/)
    controller.abort()
  })
})
