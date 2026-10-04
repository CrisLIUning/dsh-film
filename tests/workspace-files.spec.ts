/** The canvas's asset library offers the workspace's own media beside the film's. */

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invalidateWorkspaceMedia } from '../src/media.js'
import { clearModelFactsCache } from '../src/model-files/facts.js'
import { createStudioRouter } from '../src/routes.js'
import { Gltf } from './model-files/fixtures.js'

let cwd: string
let router: ReturnType<typeof createStudioRouter>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-workspace-files-'))
  router = createStudioRouter()
  invalidateWorkspaceMedia()
  clearModelFactsCache()
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

async function writeBytes(relative: string, content: Buffer, modified?: Date): Promise<void> {
  const path = join(cwd, ...relative.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  if (modified !== undefined) await utimes(path, modified, modified)
}

/** A 0.50 × 0.90 × 0.45 m chair, exported in centimetres under a 0.01 root scale. */
function chairGlb(): Buffer {
  const gltf = new Gltf()
  const seat = gltf.node({ mesh: gltf.mesh({ attributes: { POSITION: gltf.box([-25, 0, -22.5], [25, 90, 22.5]) } }) })
  return gltf.scene(gltf.node({ scale: [0.01, 0.01, 0.01], children: [seat] })).glb()
}

async function write(studioPath: string, method: 'POST' | 'PUT', json: unknown): Promise<{ status: number; body: any }> {
  const url = new URL('http://host/api/dsh-film/studio-write')
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', studioPath)
  url.searchParams.set('method', method)
  const response = await router.dispatch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }))
  return { status: response.status, body: await response.json() }
}
const post = (studioPath: string, json: unknown) => write(studioPath, 'POST', json)
const put = (studioPath: string, json: unknown) => write(studioPath, 'PUT', json)

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

  it('never lists compiled motion clips, and keeps what the overlay knows about them', async () => {
    await file('film/film.json', JSON.stringify({ format: 'vibedev.film', version: 1, id: 'film-1', title: 'A', aspectRatio: '16:9', createdAt: 't', updatedAt: 't' }))
    await file('film/motions/t1/motion.glb', 'glTF')
    await file('film/spaces/hall.glb', 'glTF')
    await file('film/canvas/assets.json', JSON.stringify({ assets: [{ id: 'canvas-file:motions/t1/motion.glb', kind: 'model', storage: 'file', filePath: 'motions/t1/motion.glb', title: '点头' }] }))
    const library = await get('/api/canvas/assets/film-1?project=film-1')
    expect(library.assets.map((asset: { filePath: string }) => asset.filePath)).toEqual(['spaces/hall.glb'])
    const url = new URL('http://host/api/dsh-film/studio-write')
    url.searchParams.set('cwd', cwd)
    url.searchParams.set('path', '/api/canvas/assets/film-1?project=film-1')
    url.searchParams.set('method', 'PUT')
    const saved = await router.dispatch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assets: library.assets }) }))
    expect(saved.status).toBe(200)
    const stored = JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'assets.json'), 'utf8')) as { assets: Array<{ filePath: string; title?: string }> }
    expect(stored.assets.find(asset => asset.filePath === 'motions/t1/motion.glb')).toMatchObject({ title: '点头' })
  })

  it('offers the workspace\'s GLB, FBX and OBJ models with their facts, and imports them into film/canvas/models', async () => {
    await file('film/film.json', JSON.stringify({ format: 'vibedev.film', version: 1, id: 'film-1', title: 'A', aspectRatio: '16:9', createdAt: 't', updatedAt: 't' }))
    await writeBytes('props/chair.glb', chairGlb(), new Date('2026-10-03T00:00:00Z'))
    await file('props/lamp.gltf', '{"asset":{"version":"2.0"}}')
    await writeBytes('node_modules/pkg/chair.glb', chairGlb())
    await writeBytes('.hidden/chair.glb', chairGlb())
    await file('film/spaces/hall.glb', 'not really a GLB')
    const library = await get('/api/canvas/assets/film-1?project=film-1')
    expect(library.workspaceModels).toHaveLength(1)
    const [chair] = library.workspaceModels
    expect(chair).toMatchObject({ id: 'workspace-model:props/chair.glb', path: 'props/chair.glb', format: 'glb', title: 'chair.glb', sizeBytes: chairGlb().length, modifiedAt: '2026-10-03T00:00:00.000Z' })
    expect(chair.model).toMatchObject({ format: 'glb', role: 'model', placeable: true, suggestedKind: 'prop', metresPerUnit: 1 })
    expect(chair.model.sizeMetres.map((value: number) => Number(value.toFixed(3)))).toEqual([0.5, 0.9, 0.45])
    // A film model carries its facts too; the space folder makes it a space, and an unreadable file is not placeable.
    expect(library.assets.find((asset: { filePath: string }) => asset.filePath === 'spaces/hall.glb').model).toMatchObject({ role: 'space', suggestedKind: 'scene', placeable: false })

    const imported = await post('/api/canvas/assets/film-1/import?project=film-1', { path: 'props/chair.glb' })
    expect(imported.status).toBe(200)
    expect(imported.body).toMatchObject({ file: { name: 'canvas/models/chair.glb', size: chairGlb().length, mime: 'model/gltf-binary' }, kind: 'model', model: { format: 'glb', role: 'model', placeable: true } })
    expect(imported.body.reused).toBeUndefined()
    expect((await readFile(join(cwd, 'film', 'canvas', 'models', 'chair.glb'))).equals(chairGlb())).toBe(true)
    expect((await post('/api/canvas/assets/film-1/import?project=film-1', { path: 'props/chair.glb' })).body).toMatchObject({ file: { name: 'canvas/models/chair.glb' }, reused: true })

    const after = await get('/api/canvas/assets/film-1?project=film-1')
    expect(after.workspaceModels).toEqual([])
    const copy = after.assets.find((asset: { filePath: string }) => asset.filePath === 'canvas/models/chair.glb')
    expect(copy).toMatchObject({ kind: 'model', model: { format: 'glb', placeable: true, suggestedKind: 'prop' } })

    // The facts are read-only: a save does not store them.
    const saved = await put('/api/canvas/assets/film-1?project=film-1', { assets: after.assets })
    expect(saved.status).toBe(200)
    const stored = JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'assets.json'), 'utf8')) as { assets: Array<Record<string, unknown>> }
    expect(stored.assets.length).toBeGreaterThan(0)
    expect(stored.assets.some(asset => 'model' in asset)).toBe(false)
  })

  it('keeps the 0.1 import path as an alias for media and models, and refuses a .gltf', async () => {
    await file('film/film.json', JSON.stringify({ format: 'vibedev.film', version: 1, id: 'film-1', title: 'A', aspectRatio: '16:9', createdAt: 't', updatedAt: 't' }))
    await file('footage/take.mov', 'mov!')
    await writeBytes('props/chair.glb', chairGlb())
    await file('props/lamp.gltf', '{"asset":{"version":"2.0"}}')
    expect((await post('/api/canvas/timelines/film-1/import?project=film-1', { path: 'footage/take.mov' })).body)
      .toEqual({ file: { name: 'canvas/media/take.mov', size: 4, mime: 'video/quicktime' }, kind: 'video' })
    expect((await post('/api/canvas/timelines/film-1/import?project=film-1', { path: 'props/chair.glb' })).body)
      .toMatchObject({ file: { name: 'canvas/models/chair.glb' }, kind: 'model', model: { format: 'glb' } })
    for (const path of ['/api/canvas/assets/film-1/import?project=film-1', '/api/canvas/timelines/film-1/import?project=film-1']) {
      expect(await post(path, { path: 'props/lamp.gltf' })).toMatchObject({ status: 400, body: { code: 'CANVAS_IMPORT_INVALID', error: expect.stringContaining('GLB') } })
      expect(await post(path, { path: 'props/none.glb' })).toMatchObject({ status: 404, body: { code: 'CANVAS_IMPORT_NOT_FOUND' } })
    }
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
