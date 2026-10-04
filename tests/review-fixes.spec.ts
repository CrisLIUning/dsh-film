/** Fixes from the round-7 review: film writes, model records, plan bounds, refusals the agent can act on, and the routes' error shapes. */

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { refusal } from '../src/agent/studio-client.js'
import { CanvasAssetStore } from '../src/canvas/assets.js'
import { filmWriteTarget } from '../src/film-files.js'
import { createModelRecord, readModelRecord, updateModelRecord, writeFilmFile } from '../src/modeling/store.js'
import { createProject, parseNewProject } from '../src/project.js'
import { createStudioRouter } from '../src/routes.js'
import { compileSpacePlan } from '../src/space-plan/compile.js'
import type { SpacePlan } from '../src/space-plan/compile.js'
import { SpacePlanInputError } from '../src/space-plan/input.js'

let cwd: string
let outside: string
let projectId: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-review-'))
  outside = await mkdtemp(join(tmpdir(), 'dsh-film-outside-'))
  projectId = (await createProject(cwd, parseNewProject({ title: '复查' }, cwd))).project.id
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

async function call(router: ReturnType<typeof createStudioRouter>, studioPath: string, method: 'GET' | 'POST' | 'PUT' = 'GET', json?: unknown): Promise<{ status: number; body: any }> {
  const url = new URL('http://host/api/dsh-film/studio')
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', studioPath)
  if (method === 'PUT') url.searchParams.set('method', 'PUT')
  const response = await router.dispatch(new Request(url, {
    method: method === 'GET' ? 'GET' : 'POST',
    ...(json !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) } : {}),
  }))
  return { status: response.status, body: await response.json() }
}

describe('film writes', () => {
  it('refuse a link out of the film before making any folder, and make folders inside it', async () => {
    await symlink(outside, join(cwd, 'film', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(filmWriteTarget(cwd, 'link/new/x.png')).rejects.toMatchObject({ code: 'EPATHESCAPE' })
    expect(await exists(join(outside, 'new'))).toBe(false)
    await expect(writeFilmFile(cwd, 'link/deep/model.json', '{}')).rejects.toMatchObject({ code: 'EACCES' })
    expect(await exists(join(outside, 'deep'))).toBe(false)
    for (const bad of ['', '../x', 'a/../../x', 'a\\b', '/abs']) await expect(filmWriteTarget(cwd, bad), bad).rejects.toMatchObject({ code: 'EPATHESCAPE' })
    const target = await filmWriteTarget(cwd, 'canvas/story-references/a.png')
    expect(await exists(join(cwd, 'film', 'canvas', 'story-references'))).toBe(true)
    expect(target.endsWith('a.png')).toBe(true)
  })
})

describe('model records', () => {
  it('read a record only from its own folder and never write one into another model\'s folder', async () => {
    const now = new Date().toISOString()
    await writeFilmFile(cwd, 'models/knight/model.json', JSON.stringify(createModelRecord({ id: 'knight', kind: 'character', title: '骑士', now })))
    // A record copied into another folder names its own id there.
    await writeFilmFile(cwd, 'models/copy/model.json', JSON.stringify(createModelRecord({ id: 'knight', kind: 'character', title: '冒名', now })))
    expect((await readModelRecord(cwd, 'knight'))?.title).toBe('骑士')
    expect(await readModelRecord(cwd, 'copy')).toBeNull()
    const other = createModelRecord({ id: 'knight', kind: 'character', title: '覆盖', now })
    await expect(updateModelRecord(cwd, 'copy', () => ({ record: other, value: undefined }))).rejects.toThrow(/不属于/u)
    expect(JSON.parse(await readFile(join(cwd, 'film', 'models', 'knight', 'model.json'), 'utf8')).title).toBe('骑士')
  })
})

describe('space plan bounds', () => {
  const plan: SpacePlan = {
    name: '边界', footprint: { width: 12000, depth: 8000 },
    levels: [{ id: 'f1', name: '一层', elevation: 0, height: 3000 }, { id: 'f2', name: '二层', elevation: 3000, height: 3000 }],
    stairs: [{ id: 's1', from: 'f1', to: 'f2', at: [0, 0], width: 1200, direction: 'north' }],
  }

  it('refuse plans that would allocate without limit, and still compile ordinary ones', () => {
    expect(compileSpacePlan(plan).parts.length).toBeGreaterThan(0)
    const refused = (changed: Partial<SpacePlan>): void => { expect(() => compileSpacePlan({ ...plan, ...changed } as SpacePlan)).toThrow(SpacePlanInputError) }
    refused({ entrance: { at: [0, -4000], width: 2000, stepRise: 150, stepRun: 300, steps: 100_000 } })
    refused({ openings: { exteriorWindowPitch: 1 } })
    refused({ levels: [plan.levels[0]!, { id: 'f2', name: '高塔', elevation: 10_000_000, height: 3000 }] })
    // A long run of windows is bounded by the part ceiling, not left to allocate.
    refused({ footprint: { width: 100_000_000, depth: 8000 }, openings: { exteriorWindowPitch: 300 } })
    expect(compileSpacePlan({ ...plan, openings: { exteriorWindowPitch: 0 } }).parts.length).toBeGreaterThan(0)
  })
})

describe('refusals the agent can act on', () => {
  it('carry a strict plan\'s warnings and the stairs that do not connect', () => {
    const error = refusal(422, {
      error: '平面有未解决的问题', code: 'SPACE_PLAN_NOT_CLEAN', warnings: ['楼梯 s1 落点在墙里'],
      access: { issues: [{ code: 'floor-unreachable', levelId: 'f2', message: '二层没有楼梯可达', partNames: ['a', 'b', 'c', 'd', 'e', 'f'] }] },
    })
    expect(error.message).toContain('SPACE_PLAN_NOT_CLEAN')
    expect(error.message).toContain('楼梯 s1 落点在墙里')
    expect(error.message).toContain('floor-unreachable')
    expect(error.message).not.toContain('"f"')
  })
})

describe('route error shapes', () => {
  it('answer modeling file failures flat, as the 程序化模型 panel reads them', async () => {
    const router = createStudioRouter({})
    await mkdir(join(cwd, 'film', 'models', 'knight', 'src', 'main.ts'), { recursive: true })
    const answer = await call(router, `/api/projects/${projectId}/models/knight/source`, 'PUT', { path: 'models/knight/src/main.ts', text: 'export {}' })
    expect(answer.status).toBe(500)
    expect(answer.body).toMatchObject({ code: 'MODEL_WRITE_FAILED' })
    expect(typeof answer.body.error).toBe('string')
  })

  it('answer a damaged film.json on director routes as the film\'s problem, not a director failure', async () => {
    const router = createStudioRouter({})
    await writeFile(join(cwd, 'film', 'film.json'), '{ not json')
    const answer = await call(router, '/api/director/query', 'POST', { source: { boardId: projectId }, query: { kind: 'structure' } })
    expect(answer.status).not.toBe(500)
    expect(answer.body.code).not.toBe('DIRECTOR_FAILED')
  })

  it('keep the stored titles of model version outputs the library scan hides', async () => {
    await writeFilmFile(cwd, 'models/knight/versions/v1/preview.png', 'png')
    await writeFilmFile(cwd, 'canvas/media/a.png', 'a')
    const store = new CanvasAssetStore(cwd)
    const versionAsset = { id: 'canvas-file:models/knight/versions/v1/preview.png', kind: 'image', title: '骑士 v1', storage: 'file', filePath: 'models/knight/versions/v1/preview.png', note: '侧面' }
    await writeFile(join(cwd, 'film', 'canvas', 'assets.json'), JSON.stringify({ assets: [versionAsset], publishedReferences: {} }))
    const library = await store.read(projectId, projectId)
    expect(library.assets.map(asset => asset.filePath)).toEqual(['canvas/media/a.png'])
    await store.write(projectId, projectId, library.assets.map(asset => ({ ...asset, title: '改名' })))
    const saved = JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'assets.json'), 'utf8')) as { assets: Array<{ filePath: string; title: string; note?: string }> }
    expect(saved.assets).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: 'models/knight/versions/v1/preview.png', title: '骑士 v1', note: '侧面' })]))
  })
})
