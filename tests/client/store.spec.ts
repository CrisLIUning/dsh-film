/** The workbench's Host calls and shared project state, against a stubbed fetch. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Seen { method: string; url: URL; headers: Record<string, string>; body: unknown }

let seen: Seen[]
let answer: (request: Seen) => Response | Promise<Response>

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const PROJECT = { format: 'vibedev.film', version: 1, id: 'p1', title: '雨夜来客', aspectRatio: '2.39:1', createdAt: 'a', updatedAt: 'a' }
const CWD = 'C:\\Users\\me\\film-ws'

beforeEach(() => {
  seen = []
  vi.resetModules()
  vi.stubGlobal('document', { baseURI: 'http://host/base/' })
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init: RequestInit = {}) => {
    const request: Seen = {
      method: init.method ?? 'GET',
      url: new URL(String(input)),
      headers: { ...init.headers as Record<string, string> },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    seen.push(request)
    return await answer(request)
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const store = () => import('../../src/client/workbench/project-store.ts')
const api = () => import('../../src/client/workbench/api.ts')

describe('project store', () => {
  it('reads the project from the route under the document base', async () => {
    answer = () => json(200, { project: PROJECT })
    const { projectState, readProject } = await store()
    expect(projectState(CWD)).toEqual({ status: 'loading' })
    await readProject(CWD)
    expect(projectState(CWD)).toEqual({ status: 'ready', project: PROJECT })
    expect(seen[0]?.url.href).toBe(`http://host/base/api/dsh-film/project?cwd=${encodeURIComponent(CWD)}`)
  })

  it('shares one read between parts asking at once', async () => {
    answer = () => json(200, { project: null })
    const { readProject } = await store()
    await Promise.all([readProject(CWD), readProject(CWD), readProject(CWD)])
    expect(seen).toHaveLength(1)
  })

  it('keeps the shown project when the Host cannot be reached', async () => {
    answer = () => json(200, { project: PROJECT })
    const { projectState, readProject } = await store()
    await readProject(CWD)
    answer = () => { throw new TypeError('Failed to fetch') }
    await readProject(CWD)
    expect(projectState(CWD)).toEqual({ status: 'ready', project: PROJECT })
  })

  it('shows a broken project file even after a good read', async () => {
    answer = () => json(200, { project: PROJECT })
    const { projectState, readProject } = await store()
    await readProject(CWD)
    answer = () => json(422, { error: { code: 'PROJECT_INVALID', message: 'film/film.json is not valid JSON' } })
    await readProject(CWD)
    expect(projectState(CWD)).toEqual({ status: 'failed', code: 'PROJECT_INVALID', message: 'film/film.json is not valid JSON' })
  })

  it('names an unreachable Host when nothing was shown yet', async () => {
    answer = () => { throw new TypeError('Failed to fetch') }
    const { projectState, readProject } = await store()
    await readProject(CWD)
    expect(projectState(CWD)).toEqual({ status: 'failed', code: 'UNREACHABLE', message: 'Failed to fetch' })
  })

  it('starts a project with a JSON post and shows it', async () => {
    answer = () => json(201, { project: PROJECT })
    const { projectState, startProject } = await store()
    await expect(startProject(CWD, '雨夜来客', '2.39:1')).resolves.toEqual(PROJECT)
    expect(seen[0]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { cwd: CWD, title: '雨夜来客', aspectRatio: '2.39:1' },
    })
    expect(projectState(CWD)).toEqual({ status: 'ready', project: PROJECT })
  })

  it('takes the existing project when another part created one first', async () => {
    answer = () => json(409, { error: { code: 'PROJECT_EXISTS', message: 'exists' }, project: PROJECT })
    const { startProject } = await store()
    await expect(startProject(CWD, 'Other', '16:9')).resolves.toEqual(PROJECT)
  })

  it('reports other refusals with the Host message', async () => {
    answer = () => json(400, { error: { code: 'BAD_REQUEST', message: 'A project needs a title.' } })
    const { startProject } = await store()
    await expect(startProject(CWD, ' ', '16:9')).rejects.toThrow('A project needs a title.')
  })
})

describe('media paths', () => {
  it('builds the media URL from the workspace and the path relative to it', async () => {
    const { mediaUrl } = await api()
    const url = new URL(mediaUrl('C:\\ws', 'footage/a b.mp4'))
    expect(url.pathname).toBe('/base/api/dsh-film/media')
    expect(Object.fromEntries(url.searchParams)).toEqual({ cwd: 'C:\\ws', path: 'footage/a b.mp4' })
  })
})
