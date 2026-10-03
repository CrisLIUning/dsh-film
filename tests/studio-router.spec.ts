/** The Studio-compatible API as the hosted apps call it through `/api/dsh-film/studio`. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStudioRouter } from '../src/routes.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-studio-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const router = createStudioRouter()

async function call(studioPath: string, options: { method?: string; body?: unknown; transport?: 'GET' | 'POST'; cwd?: string } = {}) {
  const url = new URL('http://host/api/dsh-film/studio')
  url.searchParams.set('cwd', options.cwd ?? cwd)
  url.searchParams.set('path', studioPath)
  if (options.method !== undefined) url.searchParams.set('method', options.method)
  const transport = options.transport ?? (options.method === undefined || options.method === 'GET' ? 'GET' : 'POST')
  const init: RequestInit = { method: transport }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
    init.headers = { 'content-type': 'application/json' }
  }
  const response = await router.dispatch(new Request(url, init))
  return { status: response.status, body: await response.json() as any }
}

const DOCUMENTS = '/api/projects/film-1/story/documents'

describe('Studio-compatible screenwriter API', () => {
  it('creates, lists, reads and saves a screenplay with Studio paths', async () => {
    expect(await call(DOCUMENTS)).toEqual({ status: 200, body: { documents: [] } })
    const created = await call(DOCUMENTS, { transport: 'POST', body: { title: '雨夜来客' } })
    expect(created.status).toBe(200)
    const document = created.body.document
    expect(document).toMatchObject({ title: '雨夜来客', kind: 'short', filePath: `film/story/${document.documentId}.md` })
    expect((await call(DOCUMENTS)).body.documents).toHaveLength(1)
    const read = await call(`${DOCUMENTS}/${document.documentId}`)
    expect(read.body.revision).toBe(document.revision)
    const saved = await call(`${DOCUMENTS}/${document.documentId}`, {
      method: 'PUT', body: { expectedRevision: document.revision, content: `${document.content}\n门开了。\n` },
    })
    expect(saved.status).toBe(200)
    expect(saved.body.changed).toBe(true)
  })

  it('answers a stale write with 409 and the current document', async () => {
    const { body } = await call(DOCUMENTS, { transport: 'POST', body: { title: '冲突' } })
    const id = body.document.documentId
    await call(`${DOCUMENTS}/${id}`, { method: 'PUT', body: { expectedRevision: body.document.revision, content: `${body.document.content}\n甲。\n` } })
    const stale = await call(`${DOCUMENTS}/${id}`, { method: 'PUT', body: { expectedRevision: body.document.revision, content: `${body.document.content}\n乙。\n` } })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ error: { code: 'CONFLICT' }, code: 'STORY_CONFLICT' })
    expect(stale.body.current.content).toContain('甲。')
  })

  it('answers invalid operations with 422 and diagnostics', async () => {
    const { body } = await call(DOCUMENTS, { transport: 'POST', body: { title: '校验' } })
    const result = await call(`${DOCUMENTS}/${body.document.documentId}/operations`, {
      transport: 'POST',
      body: { expectedRevision: body.document.revision, operations: [{ kind: 'upsertScene', scene: { id: 'scene_1', headingBlockId: 'missing', blockIds: ['missing'] } }] },
    })
    expect(result.status).toBe(422)
    expect(result.body.code).toBe('STORY_INVALID_OPERATIONS')
  })

  it('refuses unknown paths, wrong methods and a missing workspace in Studio shapes', async () => {
    expect(await call('/api/projects/film-1/unknown')).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } })
    expect((await call(DOCUMENTS, { method: 'DELETE' })).status).toBe(405)
    expect((await call(`${DOCUMENTS}/x`, { method: 'PUT', transport: 'GET' })).status).toBe(405)
    expect((await call(DOCUMENTS, { cwd: join(cwd, 'nope') })).body.code).toBe('WORKSPACE_NOT_FOUND')
    expect((await call('/not-api')).status).toBe(400)
  })
})
