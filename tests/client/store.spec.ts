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

  it('creates the film with one ensure post, with no title or frame, once the Host said there is none', async () => {
    answer = request => request.method === 'GET' ? json(200, { project: null }) : json(201, { project: PROJECT, created: true })
    const { ensureProject, projectState, readProject } = await store()
    // Nothing is known yet: no post.
    await ensureProject(CWD)
    expect(seen).toHaveLength(0)
    await readProject(CWD)
    expect(projectState(CWD)).toEqual({ status: 'ready', project: null })
    // Every part on screen asks; one request goes out.
    await Promise.all([ensureProject(CWD), ensureProject(CWD), ensureProject(CWD)])
    expect(seen.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(seen[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { cwd: CWD, ensure: true },
    })
    expect(seen[1]?.url.href).toBe('http://host/base/api/dsh-film/project')
    expect(projectState(CWD)).toEqual({ status: 'ready', project: PROJECT })
    // A film is shown: asking again sends nothing.
    await ensureProject(CWD)
    expect(seen).toHaveLength(2)
  })

  it('never creates a film over a broken or newer project file', async () => {
    for (const code of ['PROJECT_INVALID', 'PROJECT_UNSUPPORTED']) {
      answer = () => json(422, { error: { code, message: code } })
      const { ensureProject, readProject } = await store()
      await readProject(CWD)
      seen.length = 0
      await ensureProject(CWD)
      expect(seen).toEqual([])
      vi.resetModules()
    }
  })

  it('shows a failed creation as such, and tries again only after a reload reads no film', async () => {
    answer = request => request.method === 'GET' ? json(200, { project: null }) : json(403, { error: { code: 'WORKSPACE_READ_ONLY', message: 'read-only' } })
    const { ensureProject, projectState, readProject } = await store()
    await readProject(CWD)
    await ensureProject(CWD)
    expect(projectState(CWD)).toEqual({ status: 'failed', code: 'WORKSPACE_READ_ONLY', message: 'read-only', during: 'start' })
    await ensureProject(CWD)
    expect(seen.filter(request => request.method === 'POST')).toHaveLength(1)
    await readProject(CWD)
    await ensureProject(CWD)
    expect(seen.filter(request => request.method === 'POST')).toHaveLength(2)
  })

  it('takes the film another tab or the agent made first', async () => {
    answer = request => request.method === 'GET' ? json(200, { project: null }) : json(200, { project: PROJECT, created: false })
    const { ensureProject, projectState, readProject } = await store()
    await readProject(CWD)
    await ensureProject(CWD)
    expect(projectState(CWD)).toEqual({ status: 'ready', project: PROJECT })
  })

  it('does not let a read that started before the film was made hide it again', async () => {
    let release!: () => void
    const held = new Promise<void>((done) => { release = done })
    let reads = 0
    answer = async (request) => {
      if (request.method === 'POST') return json(201, { project: PROJECT, created: true })
      reads += 1
      if (reads === 2) await held
      return json(200, { project: null })
    }
    const { ensureProject, projectState, readProject } = await store()
    await readProject(CWD)
    const stale = readProject(CWD)
    await ensureProject(CWD)
    release()
    await stale
    expect(projectState(CWD)).toEqual({ status: 'ready', project: PROJECT })
  })

  it('renames the film and changes its frame, showing the saved film in every part', async () => {
    const renamed = { ...PROJECT, title: '修表铺', aspectRatio: '9:16' }
    answer = request => request.method === 'GET' ? json(200, { project: PROJECT }) : json(200, { project: renamed })
    const { changeProject, projectState, readProject } = await store()
    await readProject(CWD)
    await expect(changeProject(CWD, { title: '修表铺', aspectRatio: '9:16' })).resolves.toEqual(renamed)
    expect(seen[1]).toMatchObject({ method: 'POST', body: { cwd: CWD, title: '修表铺', aspectRatio: '9:16' } })
    expect(seen[1]?.url.pathname).toBe('/base/api/dsh-film/project/update')
    expect(projectState(CWD)).toEqual({ status: 'ready', project: renamed })
  })

  it('reports a refused change with the Host message and keeps the film shown', async () => {
    answer = request => request.method === 'GET' ? json(200, { project: PROJECT }) : json(400, { error: { code: 'BAD_REQUEST', message: 'A title must have at least one visible character.' } })
    const { changeProject, projectState, readProject } = await store()
    await readProject(CWD)
    await expect(changeProject(CWD, { title: ' ' })).rejects.toThrow('A title must have at least one visible character.')
    expect(projectState(CWD)).toEqual({ status: 'ready', project: PROJECT })
  })
})

describe('title editing', () => {
  const title = () => import('../../src/client/workbench/project-title.ts')

  it('saves a cleaned, changed title and nothing else', async () => {
    const { titleToSave } = await title()
    expect(titleToSave('  修表\n铺 ', '雨夜来客')).toBe('修表 铺')
    expect(titleToSave('雨夜来客 ', '雨夜来客')).toBeUndefined()
    expect(titleToSave(' \t', '雨夜来客')).toBeUndefined()
    expect([...titleToSave('长'.repeat(100), '雨夜来客')!]).toHaveLength(80)
  })

  it('saves on Enter, cancels on Escape, and leaves Enter to an input method that is composing', async () => {
    const { titleKeyAction } = await title()
    expect(titleKeyAction('Enter', false)).toBe('save')
    expect(titleKeyAction('Escape', false)).toBe('cancel')
    expect(titleKeyAction('Enter', true)).toBeUndefined()
    expect(titleKeyAction('a', false)).toBeUndefined()
  })

  it('offers exactly the editing desk\'s frames (the video editor\'s HOST_PROJECT_ASPECTS, which the Host pins too)', async () => {
    const { ASPECT_RATIOS } = await api()
    expect([...ASPECT_RATIOS].sort()).toEqual(['9:16', '16:9', '1:1', '4:5', '21:9', '2.39:1'].sort())
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
