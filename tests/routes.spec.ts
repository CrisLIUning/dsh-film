/** The routes as the connection service calls them, and the plugin loaded into a context. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import * as Film from '../src/index.js'
import { filmRoutes } from '../src/routes.js'

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
    expect(created.body.project).toMatchObject({ title: '雨夜来客', aspectRatio: '9:16' })
    const again = await call('/api/dsh-film/project', {}, post({ cwd, title: 'Other' }))
    expect(again.status).toBe(409)
    expect(again.body).toEqual({ error: { code: 'PROJECT_EXISTS', message: 'This workspace already has a film project.' }, project: created.body.project })
    expect(await call('/api/dsh-film/project', { cwd })).toMatchObject({ status: 200, body: { project: created.body.project } })
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

describe('/api/dsh-film/assets and /media', () => {
  it('lists a media file and plays it by range', async () => {
    await mkdir(join(cwd, 'media', 'videos'), { recursive: true })
    await writeFile(join(cwd, 'media', 'videos', 'shot.mp4'), 'abcdefghij')
    const listing = await call('/api/dsh-film/assets', { cwd })
    expect(listing.body.assets).toMatchObject([{ path: 'media/videos/shot.mp4', kind: 'video', bytes: 10 }])
    const media = await call('/api/dsh-film/media', { path: join(cwd, 'media', 'videos', 'shot.mp4') }, { headers: { range: 'bytes=2-4' } })
    expect(media.status).toBe(206)
    expect(await media.response.text()).toBe('cde')
  })

  it('answers failures with the code and no body for HEAD', async () => {
    await writeFile(join(cwd, 'notes.txt'), 'x')
    const get = await call('/api/dsh-film/media', { path: join(cwd, 'notes.txt') })
    expect(get).toMatchObject({ status: 415, body: { error: { code: 'NOT_MEDIA' } } })
    const head = await call('/api/dsh-film/media', { path: join(cwd, 'notes.txt') }, { method: 'HEAD' })
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
    const fiber = await ctx.plugin(Film)
    expect(registered).toEqual([
      'GET,POST /api/dsh-film/project',
      'GET /api/dsh-film/assets',
      'GET,HEAD /api/dsh-film/media',
      'GET,HEAD,POST /api/dsh-film/studio',
    ])
    await fiber.dispose()
    expect(removed.sort()).toEqual(['/api/dsh-film/assets', '/api/dsh-film/media', '/api/dsh-film/project', '/api/dsh-film/studio'])
  })

  it('loads without a connection service', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(Film)
    await fiber.dispose()
  })
})
