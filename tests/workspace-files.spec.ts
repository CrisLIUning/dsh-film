/** The canvas's asset library offers the workspace's own media beside the film's. */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invalidateWorkspaceMedia } from '../src/media.js'
import { createStudioRouter } from '../src/routes.js'

let cwd: string
let router: ReturnType<typeof createStudioRouter>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-workspace-files-'))
  router = createStudioRouter()
  invalidateWorkspaceMedia()
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function file(relative: string, content = 'x', modified?: Date): Promise<void> {
  const path = join(cwd, ...relative.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  if (modified !== undefined) await utimes(path, modified, modified)
}

async function get(studioPath: string): Promise<any> {
  const url = new URL('http://host/api/dsh-film/studio')
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', studioPath)
  const response = await router.dispatch(new Request(url))
  expect(response.status).toBe(200)
  return response.json()
}

describe('GET /api/canvas/assets/:boardId', () => {
  it('lists the workspace\'s own media as workspaceFiles and leaves the library as it was', async () => {
    await file('film/film.json', JSON.stringify({ format: 'vibedev.film', version: 1, id: 'film-1', title: 'A', aspectRatio: '16:9', createdAt: 't', updatedAt: 't' }))
    await file('film/canvas/media/shot.png', 'png')
    await file('media/gen.png', 'generated', new Date('2026-10-03T00:00:00Z'))
    await file('footage/day 1/take.mov', 'mov!', new Date('2026-10-02T00:00:00Z'))
    await file('music/bed.mp3', 'mp3', new Date('2026-10-01T00:00:00Z'))
    await file('refs/odd.avif')
    await file('node_modules/pkg/logo.png')
    await file('notes.txt')
    const library = await get('/api/canvas/assets/film-1?project=film-1')
    expect(library.assets.map((asset: { filePath: string }) => asset.filePath)).toEqual(['canvas/media/shot.png'])
    expect(library.workspaceFiles).toEqual([
      { id: 'workspace-file:media/gen.png', path: 'media/gen.png', kind: 'image', title: 'gen.png', url: expect.any(String), sizeBytes: 9, mimeType: 'image/png', modifiedAt: '2026-10-03T00:00:00.000Z' },
      { id: 'workspace-file:footage/day 1/take.mov', path: 'footage/day 1/take.mov', kind: 'video', title: 'take.mov', url: expect.any(String), sizeBytes: 4, mimeType: 'video/quicktime', modifiedAt: '2026-10-02T00:00:00.000Z' },
      { id: 'workspace-file:music/bed.mp3', path: 'music/bed.mp3', kind: 'audio', title: 'bed.mp3', url: expect.any(String), sizeBytes: 3, mimeType: 'audio/mpeg', modifiedAt: '2026-10-01T00:00:00.000Z' },
    ])
    const url = new URL(library.workspaceFiles[1].url, 'http://host')
    expect(url.pathname).toBe('/api/dsh-film/media')
    expect(Object.fromEntries(url.searchParams)).toEqual({ cwd, path: 'footage/day 1/take.mov' })
  })

  it('leaves out a workspace file the film imported, until it changes or the film\'s copy goes', async () => {
    await file('film/film.json', JSON.stringify({ format: 'vibedev.film', version: 1, id: 'film-1', title: 'A', aspectRatio: '16:9', createdAt: 't', updatedAt: 't' }))
    await file('footage/take.mov', 'mov!', new Date('2026-10-02T00:00:00Z'))
    await file('music/bed.mp3', 'mp3', new Date('2026-10-01T00:00:00Z'))
    const offered = async (): Promise<string[]> => (await get('/api/canvas/assets/film-1?project=film-1')).workspaceFiles.map((entry: { path: string }) => entry.path)
    expect(await offered()).toEqual(['footage/take.mov', 'music/bed.mp3'])
    const url = new URL('http://host/api/dsh-film/studio-write')
    url.searchParams.set('cwd', cwd)
    url.searchParams.set('path', '/api/canvas/timelines/film-1/import?project=film-1')
    url.searchParams.set('method', 'POST')
    const imported = await router.dispatch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'footage/take.mov' }) }))
    expect(imported.status).toBe(200)
    const library = await get('/api/canvas/assets/film-1?project=film-1')
    expect(library.workspaceFiles.map((entry: { path: string }) => entry.path)).toEqual(['music/bed.mp3'])
    // The film's copy is in the library itself.
    expect(library.assets.map((asset: { filePath: string }) => asset.filePath)).toEqual(['canvas/media/take.mov'])
    await rm(join(cwd, 'film', 'canvas', 'media', 'take.mov'))
    expect(await offered()).toEqual(['footage/take.mov', 'music/bed.mp3'])
  })
})
