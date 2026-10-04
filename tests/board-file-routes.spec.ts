/** The board's file routes: a workspace media or model file copied into the film (C8), the agent's attach, and the 0.1 paths that are gone. */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasDocumentStore } from '../src/canvas/documents.js'
import { invalidateWorkspaceMedia } from '../src/media.js'
import { createProject } from '../src/project.js'
import { createStudioRouter } from '../src/routes.js'
import { ProjectEvents } from '../src/studio/events.js'

let cwd: string
let router: ReturnType<typeof createStudioRouter>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-import-'))
  router = createStudioRouter()
  invalidateWorkspaceMedia()
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function call(studioPath: string, options: { method?: string; json?: unknown } = {}) {
  const method = options.method ?? 'GET'
  const url = new URL(`http://host/api/dsh-film/${method === 'GET' ? 'studio' : 'studio-write'}`)
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', studioPath)
  if (method !== 'GET') url.searchParams.set('method', method)
  const init: RequestInit = { method: method === 'GET' ? 'GET' : 'POST' }
  if (options.json !== undefined) {
    init.body = JSON.stringify(options.json)
    init.headers = { 'content-type': 'application/json' }
  }
  const response = await router.dispatch(new Request(url, init))
  return { status: response.status, body: await response.json() as any }
}

/** Make the workspace a film workspace: imports read outside film/ only for one. */
async function startFilm(): Promise<void> {
  await mkdir(join(cwd, 'film'), { recursive: true })
  await writeFile(join(cwd, 'film', 'film.json'), JSON.stringify({ format: 'vibedev.film', version: 1, id: 'film-1', title: 'A', aspectRatio: '16:9', createdAt: 't', updatedAt: 't' }))
}

describe('POST /api/canvas/assets/:boardId/import', () => {
  it('imports any workspace media file into the film under a free name, as a copy that does not follow the original', async () => {
    await startFilm()
    await mkdir(join(cwd, 'footage', 'day 1'), { recursive: true })
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'footage', 'day 1', 'take.mp4'), 'new')
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'take.mp4'), 'old')
    const seen: unknown[] = []
    const events = new ProjectEvents()
    events.subscribe(cwd, (event) => { seen.push(event) })
    router = createStudioRouter({ events })
    const imported = await call('/api/canvas/assets/film-1/import', { method: 'POST', json: { path: 'footage\\day 1\\take.mp4' } })
    expect(imported).toEqual({ status: 200, body: { file: { name: 'canvas/media/take-2.mp4', size: 3, mime: 'video/mp4' }, kind: 'video' } })
    expect(await readFile(join(cwd, 'film', 'canvas', 'media', 'take-2.mp4'), 'utf8')).toBe('new')
    expect(await readFile(join(cwd, 'film', 'canvas', 'media', 'take.mp4'), 'utf8')).toBe('old')
    const [source, copy] = await Promise.all([stat(join(cwd, 'footage', 'day 1', 'take.mp4'), { bigint: true }), stat(join(cwd, 'film', 'canvas', 'media', 'take-2.mp4'), { bigint: true })])
    expect(copy.ino).not.toBe(source.ino)
    expect([source.nlink, copy.nlink]).toEqual([1n, 1n])
    expect(seen).toEqual([{ type: 'file-changed', projectId: 'film', path: 'canvas/media/take-2.mp4' }])
    // The same bytes again: the earlier import, no new file and no event.
    expect((await call('/api/canvas/assets/film-1/import', { method: 'POST', json: { path: 'footage/day 1/take.mp4' } })).body).toEqual({ file: { name: 'canvas/media/take-2.mp4', size: 3, mime: 'video/mp4' }, kind: 'video', reused: true })
    expect(seen).toHaveLength(1)
    expect((await readdir(join(cwd, 'film', 'canvas', 'media'))).sort()).toEqual(['take-2.mp4', 'take.mp4'])
    // A tool rewriting the original in place leaves the film's copy as it was.
    await writeFile(join(cwd, 'footage', 'day 1', 'take.mp4'), 'NEW')
    expect(await readFile(join(cwd, 'film', 'canvas', 'media', 'take-2.mp4'), 'utf8')).toBe('new')
  })

  it('copies one file once when two imports of it arrive together', async () => {
    await startFilm()
    await mkdir(join(cwd, 'footage'), { recursive: true })
    await writeFile(join(cwd, 'footage', 'x.png'), 'pixels')
    const answers = await Promise.all(Array.from({ length: 3 }, () => call('/api/canvas/assets/film-1/import', { method: 'POST', json: { path: 'footage/x.png' } })))
    expect(answers.map(answer => answer.body.file.name)).toEqual(['canvas/media/x.png', 'canvas/media/x.png', 'canvas/media/x.png'])
    expect(answers.filter(answer => answer.body.reused === true)).toHaveLength(2)
    expect(await readdir(join(cwd, 'film', 'canvas', 'media'))).toEqual(['x.png'])
  })

  it('imports only into a film workspace outside hidden and credential folders', async () => {
    await mkdir(join(cwd, 'footage'), { recursive: true })
    await writeFile(join(cwd, 'footage', 'take.mp4'), 'take')
    expect(await call('/api/canvas/assets/film-1/import', { method: 'POST', json: { path: 'footage/take.mp4' } })).toMatchObject({ status: 404, body: { code: 'PROJECT_NOT_FOUND' } })
    await expect(stat(join(cwd, 'film'))).rejects.toThrow()
    const outer = cwd
    try {
      cwd = join(outer, '.aws', 'work')
      await mkdir(join(cwd, 'footage'), { recursive: true })
      await writeFile(join(cwd, 'footage', 'take.mp4'), 'take')
      await startFilm()
      expect(await call('/api/canvas/assets/film-1/import', { method: 'POST', json: { path: 'footage/take.mp4' } })).toMatchObject({ status: 403, body: { code: 'WORKSPACE_REFUSED' } })
      await expect(stat(join(cwd, 'film', 'canvas'))).rejects.toThrow()
    } finally {
      cwd = outer
    }
  })

  it('answers a file already in the film with its film path and copies nothing', async () => {
    await startFilm()
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'still.png'), 'png')
    expect(await call('/api/canvas/assets/film-1/import', { method: 'POST', json: { path: 'film/canvas/media/still.png' } }))
      .toEqual({ status: 200, body: { file: { name: 'canvas/media/still.png', size: 3, mime: 'image/png' }, kind: 'image' } })
    expect(await readdir(join(cwd, 'film', 'canvas', 'media'))).toEqual(['still.png'])
  })

  it('refuses what the workspace scan would not list, and paths that leave the workspace', async () => {
    await startFilm()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-film-outside-'))
    try {
      await writeFile(join(outside, 'secret.mp4'), 'secret')
      await symlink(outside, join(cwd, 'linked'), 'junction')
      for (const [path, content] of [['node_modules/pkg/a.mp4', 'x'], ['.private/a.mp4', 'x'], ['build/a.mp4', 'x'], ['.ssh/a.png', 'x'], ['notes.txt', 'x']] as const) {
        await mkdir(join(cwd, ...path.split('/').slice(0, -1)), { recursive: true })
        await writeFile(join(cwd, ...path.split('/')), content)
      }
      const status = async (path: unknown): Promise<[number, string]> => {
        const { status: code, body } = await call('/api/canvas/assets/film-1/import', { method: 'POST', json: { path } })
        return [code, body.code]
      }
      const invalid = [400, 'CANVAS_IMPORT_INVALID']
      expect(await status('film/film.json')).toEqual(invalid)
      expect(await status('media/../secret.mp4')).toEqual(invalid)
      expect(await status('./media/./a.mp4')).toEqual(invalid)
      expect(await status(join(outside, 'secret.mp4'))).toEqual(invalid)
      expect(await status('linked/secret.mp4')).toEqual(invalid)
      expect(await status('node_modules/pkg/a.mp4')).toEqual(invalid)
      expect(await status('.private/a.mp4')).toEqual(invalid)
      expect(await status('build/a.mp4')).toEqual(invalid)
      expect(await status('.ssh/a.png')).toEqual(invalid)
      expect(await status('notes.txt')).toEqual(invalid)
      expect(await status('media/a\0.mp4')).toEqual(invalid)
      expect(await status(undefined)).toEqual(invalid)
      expect(await status('media/none.mp4')).toEqual([404, 'CANVAS_IMPORT_NOT_FOUND'])
      await expect(stat(join(cwd, 'film', 'canvas'))).rejects.toThrow()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('POST /api/canvas/assets/:boardId/attach', () => {
  async function filmWithNode(): Promise<string> {
    const { project } = await createProject(cwd, { title: 'A', aspectRatio: '16:9' })
    await new CanvasDocumentStore(cwd, project.id).update(current => ({ ...current!, nodes: [{ id: 'img-1', type: 'image', position: { x: 10, y: 20 }, metadata: {} }] }))
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'still.png'), 'png')
    return project.id
  }

  it('puts a film file into a node, or lands it as a new node, and tells open pages', async () => {
    const id = await filmWithNode()
    const seen: Array<{ type: string }> = []
    const events = new ProjectEvents()
    events.subscribe(cwd, (event) => { seen.push(event) })
    router = createStudioRouter({ events })
    const attached = await call(`/api/canvas/assets/${id}/attach?project=${id}`, { method: 'POST', json: { path: 'canvas/media/still.png', targetNodeId: 'img-1', expectedContent: '' } })
    expect(attached).toMatchObject({ status: 200, body: { landed: { nodeId: 'img-1', landedNodeId: 'img-1', kind: 'image', path: 'canvas/media/still.png', size: 3 } } })
    const board = await new CanvasDocumentStore(cwd, id).read(id)
    expect((board!.nodes as Array<{ id: string; metadata: Record<string, unknown> }>).find(node => node.id === 'img-1')!.metadata.content)
      .toBe(`/api/projects/${id}/raw/canvas/media/still.png`)
    const landed = await call(`/api/canvas/assets/${id}/attach?project=${id}`, { method: 'POST', json: { path: 'canvas/media/still.png' } })
    expect(landed.body.landed.landedNodeId).toMatch(/^image-/u)
    expect(seen.filter(event => event.type === 'story-canvas-changed')).toHaveLength(2)
  })

  it('refuses a path outside the film, a file that is not there and a type the board cannot show', async () => {
    const id = await filmWithNode()
    const attach = async (body: Record<string, unknown>) => {
      const { status, body: answer } = await call(`/api/canvas/assets/${id}/attach?project=${id}`, { method: 'POST', json: body })
      return [status, answer.code]
    }
    expect(await attach({ path: '../secret.png' })).toEqual([400, 'CANVAS_MEDIA_ATTACH_INVALID'])
    expect(await attach({ path: 'canvas/media/notes.txt' })).toEqual([400, 'CANVAS_MEDIA_ATTACH_INVALID'])
    expect(await attach({ path: 'canvas/media/none.png' })).toEqual([422, 'CANVAS_MEDIA_FILE_NOT_FOUND'])
    expect(await attach({ path: 'canvas/media/still.png', targetNodeId: 'img-1' })).toEqual([400, 'CANVAS_MEDIA_TARGET_INVALID'])
  })
})

describe('the 0.1 editing desk paths', () => {
  it('are not available in this workbench', async () => {
    await createProject(cwd, { title: 'A', aspectRatio: '16:9' })
    const gone = [
      ['GET', '/api/canvas/timelines/film-1'],
      ['GET', '/api/canvas/timelines/film-1/material'],
      ['GET', '/api/canvas/timelines/film-1/media'],
      ['POST', '/api/canvas/timelines/film-1/media'],
      ['POST', '/api/canvas/timelines/film-1/render'],
      // The 0.1 import path, kept through 0.2.x as an alias of /api/canvas/assets/:boardId/import.
      ['POST', '/api/canvas/timelines/film-1/import'],
      ['GET', '/api/community/media'],
      ['GET', '/api/media/video-editor-models'],
    ]
    for (const [method, path] of gone) {
      const answer = await call(path!, { method: method!, ...(method === 'POST' ? { json: {} } : {}) })
      expect(answer.status, path).toBe(404)
      expect(answer.body.error.message, path).toMatch(/not available in this workbench/u)
    }
  })
})
