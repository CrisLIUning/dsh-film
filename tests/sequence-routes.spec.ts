import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createProject } from '../src/project.js'
import { StudioRouter } from '../src/studio/router.js'
import { addSequenceRoutes } from '../src/studio/sequence-routes.js'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
const setup = async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'film-sequence-routes-')); folders.push(cwd)
  const { project } = await createProject(cwd, { title: '测试影片', aspectRatio: '16:9' })
  const router = new StudioRouter(); addSequenceRoutes(router)
  const call = (method: string, suffix = '', body?: unknown, board = project.id) => {
    const url = new URL('http://local/api/dsh-film/studio')
    url.searchParams.set('cwd', cwd)
    url.searchParams.set('path', `/api/canvas/video/${board}/sequences${suffix}`)
    url.searchParams.set('method', method)
    return router.dispatch(new Request(url, { method: method === 'GET' ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }))
  }
  return { call }
}
const draft = { id: 'plan-a', title: '初剪', clips: [{ id: 'entry-a', nodeId: '_node-a', title: '源素材', path: 'canvas/media/a.mp4', inMs: 1000, outMs: 3000, durationMs: 5000 }] }

describe('edit plans on the actual Studio proxy router', () => {
  it('saves through tunneled PUT, replays the same request, reads and verifies its source states', async () => {
    const { call } = await setup()
    expect(await (await call('GET')).json()).toEqual({ drafts: [] })
    const body = { draft, expectedRevision: null, operationId: 'save-a' }
    const first = await call('PUT', '', body); expect(first.status).toBe(200)
    const saved = (await first.json() as { draft: { id: string; revision: string } }).draft
    expect(await (await call('PUT', '', body)).json()).toEqual({ draft: saved })
    const reopened = await call('GET', '/plan-a'); expect(reopened.status).toBe(200)
    expect(await reopened.json()).toMatchObject({ draft: saved, sources: [{ clipId: 'entry-a', status: 'missing' }] })
    expect(await (await call('POST', '/verify', { draft })).json()).toMatchObject({ sources: [{ status: 'missing' }] })
    const conflict = await call('PUT', '', { ...body, operationId: 'save-b' }); expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'SEQUENCE_CONFLICT' })
    expect((await call('DELETE', '/plan-a', { expectedRevision: saved.revision })).status).toBe(200)
    expect((await call('GET', '/plan-a')).status).toBe(404)
  })
  it('refuses another film id and does not accept malformed edit data', async () => {
    const { call } = await setup()
    expect((await call('PUT', '', { draft, expectedRevision: null, operationId: 'save-a' }, 'other-film')).status).toBe(404)
    expect((await call('PUT', '', { draft: { ...draft, clips: [{ ...draft.clips[0], path: '../outside.mp4' }] }, expectedRevision: null, operationId: 'save-a' })).status).toBe(400)
    expect(await (await call('GET')).json()).toEqual({ drafts: [] })
  })
})
