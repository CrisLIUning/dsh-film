/** The routes as the connection service calls them, and the plugin loaded into a context. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import * as Film from '../src/index.js'
import { filmRoutes } from '../src/routes.js'
import { ProjectEvents } from '../src/studio/events.js'
import type { ProjectEvent } from '../src/studio/events.js'

let cwd: string
let routes: Map<string, ConnectionFetchRoute>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-routes-'))
  routes = new Map(filmRoutes().map(route => [route.path, route]))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function call(path: string, query: Record<string, string>, init: RequestInit = {}): Promise<{ status: number; body: any; response: Response }> {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`no route ${path}`)
  const url = new URL(`http://host${path}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await route.fetch(new Request(url, init))
  const isJson = response.headers.get('content-type')?.startsWith('application/json') === true
  const body = isJson && init.method !== 'HEAD' ? JSON.parse(await response.clone().text()) : undefined
  return { status: response.status, body, response }
}

const post = (body: unknown, type = 'application/json'): RequestInit => ({
  method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body),
})

describe('/api/dsh-film/project', () => {
  it('reports no project, creates one, then refuses a second', async () => {
    expect(await call('/api/dsh-film/project', { cwd })).toMatchObject({ status: 200, body: { project: null } })
    const created = await call('/api/dsh-film/project', {}, post({ cwd, title: ' 雨夜来客 ', aspectRatio: '9:16' }))
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ created: true, project: { title: '雨夜来客', aspectRatio: '9:16' } })
    const again = await call('/api/dsh-film/project', {}, post({ cwd, title: 'Other' }))
    expect(again.status).toBe(409)
    expect(again.body).toEqual({ error: { code: 'PROJECT_EXISTS', message: 'This workspace already has a film project.' }, project: created.body.project })
    expect(await call('/api/dsh-film/project', { cwd })).toMatchObject({ status: 200, body: { project: created.body.project } })
  })

  it('ensures a film with no form: named after the folder, 16:9, with its board, and answers an existing one as it is', async () => {
    const folder = join(cwd, '短片计划')
    await mkdir(folder)
    const seen: string[] = []
    routes = new Map(filmRoutes(undefined, (dir) => { seen.push(dir) }).map(route => [route.path, route]))
    const first = await call('/api/dsh-film/project', {}, post({ cwd: folder, ensure: true }))
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({ created: true, project: { title: '短片计划', aspectRatio: '16:9' } })
    const board = JSON.parse(await readFile(join(folder, 'film', 'canvas', 'document.json'), 'utf8'))
    expect(board).toMatchObject({ id: first.body.project.id, title: '短片计划', nodes: [], connections: [], backgroundMode: 'lines' })
    const second = await call('/api/dsh-film/project', {}, post({ cwd: folder, ensure: true, title: 'Other' }))
    expect(second).toMatchObject({ status: 200, body: { created: false, project: first.body.project } })
    // Told once: only the real creation installs the agent's film tools.
    expect(seen).toEqual([folder])
  })

  it('never ensures over a broken project file', async () => {
    await mkdir(join(cwd, 'film'))
    await writeFile(join(cwd, 'film', 'film.json'), 'not json')
    const result = await call('/api/dsh-film/project', {}, post({ cwd, ensure: true }))
    expect(result).toMatchObject({ status: 422, body: { error: { code: 'PROJECT_INVALID' } } })
    expect(await readFile(join(cwd, 'film', 'film.json'), 'utf8')).toBe('not json')
  })

  it('never ensures a film in a workspace inside a hidden or credential folder', async () => {
    for (const folder of [join(cwd, '.ssh', 'work'), join(cwd, '.local', 'share', 'work')]) {
      await mkdir(folder, { recursive: true })
      const refused = await call('/api/dsh-film/project', {}, post({ cwd: folder, ensure: true }))
      expect(refused).toMatchObject({ status: 403, body: { error: { code: 'WORKSPACE_REFUSED' } } })
      await expect(readFile(join(folder, 'film', 'film.json'))).rejects.toThrow()
    }
  })

  it('refuses an ensure flag that is not a boolean', async () => {
    expect((await call('/api/dsh-film/project', {}, post({ cwd, ensure: 'yes' }))).body.error).toEqual({ code: 'BAD_REQUEST', message: 'ensure must be a boolean.' })
  })

  it('renames the film and changes its frame, and tells open pages', async () => {
    const events = new ProjectEvents()
    const seen: ProjectEvent[] = []
    events.subscribe(cwd, (event) => { seen.push(event) })
    routes = new Map(filmRoutes(undefined, undefined, events).map(route => [route.path, route]))
    const made = (await call('/api/dsh-film/project', {}, post({ cwd, ensure: true }))).body.project
    const renamed = await call('/api/dsh-film/project/update', {}, post({ cwd, title: '  雨夜来客 ' }))
    expect(renamed).toMatchObject({ status: 200, body: { project: { id: made.id, title: '雨夜来客', aspectRatio: '16:9' } } })
    const reframed = await call('/api/dsh-film/project/update', {}, post({ cwd, aspectRatio: '2.39:1' }))
    expect(reframed.body.project).toMatchObject({ title: '雨夜来客', aspectRatio: '2.39:1' })
    expect(seen).toEqual([
      { type: 'project-changed', projectId: made.id, project: renamed.body.project },
      { type: 'project-changed', projectId: made.id, project: reframed.body.project },
    ])
    // An update that changes nothing is not announced.
    expect((await call('/api/dsh-film/project/update', {}, post({ cwd, aspectRatio: '2.39:1' }))).status).toBe(200)
    expect(seen).toHaveLength(2)
  })

  it('refuses an update with no film, nothing to change or a frame no longer offered', async () => {
    expect((await call('/api/dsh-film/project/update', {}, post({ cwd, title: 'x' }))).body.error.code).toBe('PROJECT_NOT_FOUND')
    expect((await call('/api/dsh-film/project/update', {}, post({ cwd, title: 'x' }))).status).toBe(404)
    await call('/api/dsh-film/project', {}, post({ cwd, ensure: true }))
    expect((await call('/api/dsh-film/project/update', {}, post({ cwd }))).status).toBe(400)
    expect((await call('/api/dsh-film/project/update', {}, post({ cwd, aspectRatio: '4:3' }))).body.error.message).toMatch(/aspectRatio must be one of/)
    expect((await call('/api/dsh-film/project/update', {}, post({ cwd, title: 'x' }, 'text/plain'))).status).toBe(400)
  })

  it('accepts only a JSON body', async () => {
    const result = await call('/api/dsh-film/project', {}, post({ cwd, title: 'x' }, 'text/plain'))
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('BAD_REQUEST')
    const broken = await call('/api/dsh-film/project', {}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect(broken.body.error.message).toBe('The request body is not valid JSON.')
  })

  it('refuses a relative or missing workspace', async () => {
    expect((await call('/api/dsh-film/project', { cwd: 'relative' })).status).toBe(400)
    expect((await call('/api/dsh-film/project', {})).status).toBe(400)
    expect((await call('/api/dsh-film/project', { cwd: join(cwd, 'nope') })).body.error.code).toBe('WORKSPACE_NOT_FOUND')
  })

  it('reports a broken project file instead of treating it as missing', async () => {
    await mkdir(join(cwd, 'film'))
    await writeFile(join(cwd, 'film', 'film.json'), 'not json')
    const result = await call('/api/dsh-film/project', { cwd })
    expect(result.status).toBe(422)
    expect(result.body.error.code).toBe('PROJECT_INVALID')
  })
})

describe('/api/dsh-film/media', () => {
  beforeEach(async () => {
    await mkdir(join(cwd, 'film'), { recursive: true })
    await writeFile(join(cwd, 'film', 'film.json'), JSON.stringify({ format: 'vibedev.film', version: 1, id: 'film-1', title: 'A', aspectRatio: '16:9', createdAt: 't', updatedAt: 't' }))
  })

  it('plays a file by its workspace-relative path; the 0.1 shelf listing is gone', async () => {
    await mkdir(join(cwd, 'media', 'videos'), { recursive: true })
    await writeFile(join(cwd, 'media', 'videos', 'shot.mp4'), 'abcdefghij')
    expect(routes.has('/api/dsh-film/assets')).toBe(false)
    const media = await call('/api/dsh-film/media', { cwd, path: 'media/videos/shot.mp4' }, { headers: { range: 'bytes=2-4' } })
    expect(media.status).toBe(206)
    expect(await media.response.text()).toBe('cde')
  })

  it('serves nothing by absolute path or outside the workspace', async () => {
    await mkdir(join(cwd, 'media'), { recursive: true })
    await writeFile(join(cwd, 'media', 'shot.mp4'), 'abc')
    expect(await call('/api/dsh-film/media', { path: join(cwd, 'media', 'shot.mp4') })).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } })
    expect(await call('/api/dsh-film/media', { cwd, path: join(cwd, 'media', 'shot.mp4') })).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } })
    expect(await call('/api/dsh-film/media', { cwd, path: '../media/shot.mp4' })).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } })
    // A folder of the workspace is not a film workspace: a caller cannot move the containment by picking cwd.
    expect(await call('/api/dsh-film/media', { cwd: join(cwd, 'media'), path: 'shot.mp4' })).toMatchObject({ status: 404, body: { error: { code: 'PROJECT_NOT_FOUND' } } })
  })

  it('answers failures with the code and no body for HEAD', async () => {
    await writeFile(join(cwd, 'notes.txt'), 'x')
    const get = await call('/api/dsh-film/media', { cwd, path: 'notes.txt' })
    expect(get).toMatchObject({ status: 415, body: { error: { code: 'NOT_MEDIA' } } })
    const head = await call('/api/dsh-film/media', { cwd, path: 'notes.txt' }, { method: 'HEAD' })
    expect(head.status).toBe(415)
    expect(head.response.body).toBeNull()
  })
})

describe('dsh-film plugin', () => {
  it('registers its routes while a connection service runs and removes them after', async () => {
    const registered: string[] = []
    const removed: string[] = []
    const ctx = new Context()
    ctx.provide('connection')
    ctx.set('connection', {
      fetch: {
        register(route: ConnectionFetchRoute) {
          registered.push(`${route.methods.join(',')} ${route.path}`)
          return async () => { removed.push(route.path) }
        },
      },
    })
    // An empty apps folder: the packaged apps/ may hold built apps with hundreds of routes.
    const fiber = await ctx.plugin(Film, { appsDir: cwd })
    const expected = [
      'GET,POST /api/dsh-film/project',
      'POST /api/dsh-film/project/update',
      'GET /api/dsh-film/runtime',
      'GET,HEAD /api/dsh-film/media',
      'GET,HEAD /api/dsh-film/studio',
      'POST /api/dsh-film/studio-write',
    ]
    expect(registered).toEqual(expected)
    await fiber.dispose()
    expect(removed.sort()).toEqual(expected.map(entry => entry.split(' ')[1]).sort())
  })

  it('loads a profile that still holds the 0.1 settings modelsDir and ffmpegPath', async () => {
    const registered: string[] = []
    const ctx = new Context()
    ctx.provide('connection')
    ctx.set('connection', { fetch: { register(route: ConnectionFetchRoute) { registered.push(route.path); return async () => {} } } })
    const stale = { appsDir: cwd, modelsDir: join(cwd, 'models'), ffmpegPath: join(cwd, 'ffmpeg.exe') }
    expect(Film.Config(stale as Film.Config)).toMatchObject({ appsDir: cwd })
    const fiber = await ctx.plugin(Film, stale as Film.Config)
    expect(registered).toContain('/api/dsh-film/project')
    expect(registered.some(path => path.includes('/models/') || path.includes('caption'))).toBe(false)
    await fiber.dispose()
  })

  it('announces a project change on the event stream the hosted pages read', async () => {
    const served = new Map<string, ConnectionFetchRoute>()
    const ctx = new Context()
    ctx.provide('connection')
    ctx.set('connection', { fetch: { register(route: ConnectionFetchRoute) { served.set(route.path, route); return async () => {} } } })
    const fiber = await ctx.plugin(Film, { appsDir: cwd })
    routes = served
    const made = (await call('/api/dsh-film/project', {}, post({ cwd, ensure: true }))).body.project
    const controller = new AbortController()
    const stream = await call('/api/dsh-film/studio', { cwd, path: `/api/projects/${made.id}/events` }, { signal: controller.signal })
    const reader = stream.response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: ready\ndata: {}\n\n')
    await call('/api/dsh-film/project/update', {}, post({ cwd, title: '改过的片名' }))
    const text = new TextDecoder().decode((await reader.read()).value)
    expect(text.startsWith('event: project-changed\n')).toBe(true)
    expect(JSON.parse(text.split('\n')[1]!.slice('data: '.length))).toMatchObject({ type: 'project-changed', projectId: made.id, project: { title: '改过的片名' } })
    controller.abort()
    await fiber.dispose()
  })

  it('loads without a connection service', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(Film)
    await fiber.dispose()
  })
})
