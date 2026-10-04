/**
 * The modeling endpoints as the canvas's 程序化模型 panel, the director desk
 * and the agent's tools call them, over a real temporary workspace. Ports the
 * route and store cases of Studio's space-plan-route, modeling-brief-route,
 * model-project-store, model-review and model-workflow tests.
 */

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MODEL_REVIEW_ASPECTS, modelReviewSummary } from '../src/modeling/contracts/model-project.js'
import type { ModelEnvironment } from '../src/modeling/contracts/model-project.js'
import {
  collectModelInputs, createModelRecord, describeStaleness, readModelRecord, stalenessReason, upsertModelVersion, writeModelRecord,
} from '../src/modeling/store.js'
import type { ModelInputSpec } from '../src/modeling/store.js'
import { modelEnvironment } from '../src/modeling/environment.js'
import { readModelWorkflow } from '../src/modeling/workflow.js'
import { createProject, parseNewProject } from '../src/project.js'
import { createStudioRouter } from '../src/routes.js'
import { ProjectEvents } from '../src/studio/events.js'
import type { ProjectEvent } from '../src/studio/events.js'
import { spacePlanOutputPath } from '../src/studio/modeling-routes.js'
import type { SpacePlan } from '../src/space-plan/compile.js'

const ENVIRONMENT: ModelEnvironment = { browser: { found: false }, python: { found: false } }

let cwd: string
let film: string
let projectId: string
let router: ReturnType<typeof createStudioRouter>
let seen: ProjectEvent[]

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-modeling-'))
  film = join(cwd, 'film')
  projectId = (await createProject(cwd, parseNewProject({ title: '古堡' }, cwd))).project.id
  const events = new ProjectEvents()
  seen = []
  events.subscribe(cwd, (event) => { seen.push(event) })
  router = createStudioRouter({ events, modelEnvironment: async () => ENVIRONMENT })
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function call(studioPath: string, method: 'GET' | 'POST' | 'PUT' = 'GET', json?: unknown): Promise<{ status: number; body: any }> {
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

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

/** Make a symbolic link, or report that this machine does not allow it. */
async function link(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path)
    return true
  } catch {
    return false
  }
}

const PLAN: SpacePlan = {
  name: '试验室',
  footprint: { width: 12000, depth: 8000 },
  levels: [
    { id: 'f1', name: '一层', elevation: 0, height: 3000, rooms: ['门厅'] },
    { id: 'f2', name: '二层', elevation: 3000, height: 3000 },
  ],
  stairs: [{ id: 's1', from: 'f1', to: 'f2', at: [0, 0], width: 1200, direction: 'north' }],
}
const SPACES = '/api/projects/whatever/space-plans'

describe('POST /api/projects/:id/space-plans', () => {
  it('把建筑写进影片,并给出能直接打开它的地址', async () => {
    const { status, body } = await call(SPACES, 'POST', { plan: PLAN })
    expect(status).toBe(200)
    expect(body.written).toBe(true)
    expect(body.file).toBe('spaces/试验室.glb')
    // The URL names the film's project, whatever id the caller sent.
    expect(body.url).toBe(`/api/projects/${projectId}/raw/spaces/${encodeURIComponent('试验室.glb')}`)
    const glb = await readFile(join(film, 'spaces', '试验室.glb'))
    expect(glb.readUInt32LE(0)).toBe(0x46546c67)
    expect(glb.length).toBe(body.bytes)
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(seen).toContainEqual({ type: 'file-changed', projectId, path: 'spaces/试验室.glb' })
    // And the raw route serves it to the desk.
    const raw = await router.dispatch(new Request(`http://host/api/dsh-film/studio?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(body.url)}`))
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toContain('model/gltf-binary')
  })

  it('报出每层的组名和尺寸', async () => {
    const { body } = await call(SPACES, 'POST', { plan: PLAN })
    expect(body.levels).toEqual(expect.arrayContaining(['f1-一层', 'f2-二层']))
    expect(body.size).toMatchObject({ width: expect.any(Number), height: expect.any(Number), depth: expect.any(Number) })
    expect(body.counts).toMatchObject({ walls: expect.any(Number), slabs: expect.any(Number), steps: expect.any(Number) })
  })

  it('dryRun 只报结果,一个文件都不留', async () => {
    const { body } = await call(SPACES, 'POST', { plan: PLAN, dryRun: true })
    expect(body.written).toBe(false)
    expect(body.counts).toBeTruthy()
    expect(await exists(join(film, 'spaces', '试验室.glb'))).toBe(false)
    expect(seen).toEqual([])
  })

  it('警告随结果一起给出,但不拦住写入', async () => {
    const { status, body } = await call(SPACES, 'POST', { plan: { ...PLAN, stairs: [] } })
    expect(status).toBe(200)
    expect(body.written).toBe(true)
    expect((body.warnings as string[]).some(w => w.includes('没有楼梯可达'))).toBe(true)
  })

  it('strict 时有警告就不写', async () => {
    const { status, body } = await call(SPACES, 'POST', { plan: { ...PLAN, stairs: [] }, strict: true })
    expect(status).toBe(422)
    expect(body).toMatchObject({ code: 'SPACE_PLAN_NOT_CLEAN', error: '平面有未解决的问题' })
    expect(body.warnings.length).toBeGreaterThan(0)
    expect(await exists(join(film, 'spaces', '试验室.glb'))).toBe(false)
  })

  it('returns the same structured access issues in check, strict refusal and GLB source metadata', async () => {
    const checked = await call(SPACES, 'POST', { plan: PLAN, dryRun: true })
    expect(checked.status).toBe(200)
    expect(checked.body.access).toMatchObject({ units: 'mm', issues: expect.arrayContaining([expect.objectContaining({ code: 'stair-outside-floor', stairId: 's1' })]) })
    const strict = await call(SPACES, 'POST', { plan: PLAN, strict: true })
    expect(strict.status).toBe(422)
    expect(strict.body.access).toEqual(checked.body.access)
    expect(await exists(join(film, 'spaces', '试验室.glb'))).toBe(false)
    expect((await call(SPACES, 'POST', { plan: PLAN })).status).toBe(200)
    const glb = await readFile(join(film, 'spaces', '试验室.glb'))
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'))
    expect(json.scenes[0].extras.vibedevSpacePlan).toEqual({ version: 1, sourceChecks: checked.body.access.issues })
  })

  it.each([
    { levels: [{ id: 'f1', name: '一层', elevation: null, height: 3000 }] },
    { stairs: [{ ...PLAN.stairs![0], at: [0, 'bad'] }] },
    { stairs: [{ ...PLAN.stairs![0], run: 0 }] },
    { stairs: [{ ...PLAN.stairs![0], headroom: -1 }] },
    { defaults: { slabThickness: 'not a number' } },
    { wings: [{ id: 'wing', rect: [0, 0, 1], levels: ['f1'] }] },
  ])('rejects malformed nested geometry before creating files: %j', async (patch) => {
    const response = await call(SPACES, 'POST', { plan: { ...PLAN, ...patch } })
    expect(response.status).toBe(400)
    expect(response.body.code).toBe('SPACE_PLAN_INVALID')
    expect(response.body.error).toMatch(/^平面字段无效：/)
    expect(await exists(join(film, 'spaces'))).toBe(false)
  })

  it('不是平面的东西一律拒绝', async () => {
    for (const plan of [undefined, {}, { name: 'x' }, { name: 'x', footprint: { width: 1 }, levels: [] }]) {
      const { status, body } = await call(SPACES, 'POST', { plan })
      expect(status).toBe(400)
      expect(body).toEqual({ code: 'SPACE_PLAN_INVALID', error: '需要一份平面:至少有 name、footprint 和一层 levels' })
    }
  })

  it('will not write through a spaces/ folder linked out of the film', async () => {
    const outside = join(cwd, 'outside')
    await mkdir(outside)
    await mkdir(film, { recursive: true })
    await symlink(outside, join(film, 'spaces'), 'junction')
    const { status, body } = await call(SPACES, 'POST', { plan: PLAN })
    expect(status).toBe(500)
    expect(body.code).toBe('SPACE_PLAN_COMPILE_FAILED')
    expect(await exists(join(outside, '试验室.glb'))).toBe(false)
  })

  it('建好的空间在素材库里是一个模型', async () => {
    await call(SPACES, 'POST', { plan: PLAN })
    const library = await call(`/api/canvas/assets/${projectId}`)
    expect(library.body.assets).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'model', filePath: 'spaces/试验室.glb' })]))
  })
})

describe('产物落点', () => {
  it('永远在项目的 spaces/ 下,不管调用方要求写到哪', () => {
    expect(spacePlanOutputPath('楼', '../../../etc/passwd')).toBe('spaces/passwd.glb')
    expect(spacePlanOutputPath('楼', '/tmp/x.glb')).toBe('spaces/x.glb')
    expect(spacePlanOutputPath('楼', 'sub/dir/a.glb')).toBe('spaces/a.glb')
    expect(spacePlanOutputPath('楼', 'C:\\tmp\\b.glb')).toBe('spaces/b.glb')
  })

  it('没给名字就用建筑的名字,并补上后缀', () => {
    expect(spacePlanOutputPath('废弃教堂')).toBe('spaces/废弃教堂.glb')
    expect(spacePlanOutputPath('楼', '中厅')).toBe('spaces/中厅.glb')
  })

  it('一个只剩非法字符的名字仍然落在项目里', () => {
    expect(spacePlanOutputPath('楼', '///')).toBe('spaces/space.glb')
  })
})

describe('the asset library and model versions', () => {
  it('leaves a model\'s per-version outputs out of the library, but keeps its other files', async () => {
    await mkdir(join(film, 'models', 'knight', 'versions', 'abc', 'captures'), { recursive: true })
    await writeFile(join(film, 'models', 'knight', 'versions', 'abc', 'model.glb'), 'glb')
    await writeFile(join(film, 'models', 'knight', 'versions', 'abc', 'captures', 'beauty.png'), 'png')
    await writeFile(join(film, 'models', 'knight', 'reference.png'), 'png')
    const paths = (await call(`/api/canvas/assets/${projectId}`)).body.assets.map((asset: { filePath: string }) => asset.filePath)
    expect(paths).toEqual(['models/knight/reference.png'])
  })
})

describe('POST /api/projects/:id/modeling-brief', () => {
  const BRIEF = '/api/projects/x/modeling-brief'

  it('prepares a project brief without a director desk, and one for a director target of this film', async () => {
    const independent = await call(BRIEF, 'POST', { kind: 'prop', description: '设计项目的杯子', references: ['models/cup/ref.png'] })
    expect(independent.status).toBe(200)
    expect(independent.body).toMatchObject({ projectId, skillIds: ['img2threejs'] })
    expect(independent.body.prompt).toContain('无需创建或打开导演台')
    expect(independent.body.prompt).toContain('film/models/')
    expect(independent.body.prompt).toContain('"models/cup/ref.png"')
    const context = { projectId, boardId: projectId, view: 'director', director: { nodeId: 'd', objectIds: [] } }
    const desk = await call(BRIEF, 'POST', { kind: 'vehicle', description: '蒸汽汽车', heightMetres: 2.4, context })
    expect(desk.status).toBe(200)
    expect(desk.body.prompt).toContain('蒸汽汽车')
    expect(desk.body.skillIds).toEqual(['director', 'img2threejs'])
    expect(desk.body.context).toMatchObject({ projectId, view: 'director' })
  })

  it.each([
    [{ kind: 'vehicle', description: '车', context: { projectId: 'other', boardId: 'b', view: 'director', director: { nodeId: 'd', objectIds: [] } } }, '建模需要当前项目的导演台目标'],
    [{ kind: 'house', description: '房子' }, '请选择模型用途'],
    [{ kind: 'prop', description: '  ' }, '建模描述需要 1–8000 字'],
    [{ kind: 'prop', description: '杯子', heightMetres: 0 }, '模型高度需要 0–10000 米之间的正数'],
    [{ kind: 'prop', description: '杯子', references: ['../escape.png'] }, '参考图需要最多三个项目相对文件路径'],
    [{ kind: 'prop', description: '杯子', references: ['a.png', 'b.png', 'c.png', 'd.png'] }, '参考图需要最多三个项目相对文件路径'],
  ])('refuses %j', async (body, error) => {
    expect(await call(BRIEF, 'POST', body)).toEqual({ status: 400, body: { code: 'MODELING_BRIEF_INVALID', error } })
  })
})

/* ── the model record on disk (Studio's model-project-store.test.ts) ──── */

describe('the model store', () => {
  const spec = (over: Partial<ModelInputSpec> = {}): ModelInputSpec => ({
    entry: 'models/knight/knight.ts',
    sources: ['models/knight/knight.ts', 'models/knight/parts/helm.ts'],
    resources: ['models/knight/textures/steel.png'],
    parameters: { height: 1.82 },
    toolchain: { three: '0.184.0', bundler: 'esbuild', bundlerVersion: '0.25.12', runtime: 'model-runtime@1' },
    ...over,
  })

  beforeEach(async () => {
    await mkdir(join(film, 'models/knight/parts'), { recursive: true })
    await mkdir(join(film, 'models/knight/textures'), { recursive: true })
    await writeFile(join(film, 'models/knight/knight.ts'), 'export function createKnightModel(){return null;}\n')
    await writeFile(join(film, 'models/knight/parts/helm.ts'), 'export const helm = 1;\n')
    await writeFile(join(film, 'models/knight/textures/steel.png'), 'PNGDATA-v1')
  })

  it('hashes the whole closure, so an imported module moves the version', async () => {
    const before = await collectModelInputs(cwd, spec())
    expect(before.missing).toEqual([])
    expect(before.inputs.sources).toHaveLength(2)
    await writeFile(join(film, 'models/knight/parts/helm.ts'), 'export const helm = 2;\n')
    expect((await collectModelInputs(cwd, spec())).versionId).not.toBe(before.versionId)
  })

  it('moves the version when only a texture or only a parameter changed', async () => {
    const before = await collectModelInputs(cwd, spec())
    expect((await collectModelInputs(cwd, spec({ parameters: { height: 1.9 } }))).versionId).not.toBe(before.versionId)
    await writeFile(join(film, 'models/knight/textures/steel.png'), 'PNGDATA-v2')
    expect((await collectModelInputs(cwd, spec())).versionId).not.toBe(before.versionId)
  })

  it('reports a declared resource that is not there instead of hashing around it', async () => {
    const collected = await collectModelInputs(cwd, spec({ resources: ['models/knight/textures/missing.png'] }))
    expect(collected.missing).toEqual(['models/knight/textures/missing.png'])
    expect(collected.inputs.resources).toEqual([])
  })

  it('refuses inputs that are not project-relative before touching the disk', async () => {
    await expect(collectModelInputs(cwd, spec({ entry: '/etc/passwd' }))).rejects.toThrow(/项目内相对路径/)
    await expect(collectModelInputs(cwd, spec({ sources: ['../outside.ts'] }))).rejects.toThrow(/项目内相对路径/)
    await expect(collectModelInputs(cwd, spec({ resources: ['https://host/x.png'] }))).rejects.toThrow(/项目内相对路径/)
  })

  it('will not follow a symlink out of the film', async () => {
    const outside = join(cwd, 'outside.ts')
    await writeFile(outside, 'export const secret = 1;\n')
    if (!await link(outside, join(film, 'models/knight/linked.ts'))) return
    const collected = await collectModelInputs(cwd, spec({ sources: ['models/knight/knight.ts', 'models/knight/linked.ts'] }))
    expect(collected.missing).toEqual(['models/knight/linked.ts'])
    expect(collected.inputs.sources.map(ref => ref.path)).toEqual(['models/knight/knight.ts'])
  })

  it('is stable when nothing changed', async () => {
    const a = await collectModelInputs(cwd, spec())
    expect((await collectModelInputs(cwd, spec({ sources: [...spec().sources].reverse() }))).versionId).toBe(a.versionId)
  })

  it('round-trips, keeps old versions, and marks old artefacts as needing an update', async () => {
    const first = await collectModelInputs(cwd, spec())
    let record = createModelRecord({ id: 'knight', kind: 'character', title: '骑士', now: '2026-09-07T00:00:00.000Z' })
    record = upsertModelVersion(record, first.versionId, first.inputs, '2026-09-07T00:00:00.000Z')
    record = {
      ...record,
      runs: [{
        runId: 'r1', kind: 'mesh-dump', versionId: first.versionId, status: 'succeeded', requestedBy: 'cli',
        startedAt: '2026-09-07T00:00:00.000Z', endedAt: '2026-09-07T00:00:10.000Z', checkIds: [],
        artifacts: [{ path: 'models/knight/versions/x/meshes.json', sha256: 'a'.repeat(64), bytes: 12, versionId: first.versionId, runId: 'r1', producedAt: '2026-09-07T00:00:10.000Z' }],
      }],
    }
    await writeModelRecord(cwd, record)
    const reloaded = await readModelRecord(cwd, 'knight')
    expect(reloaded?.versions[0]?.versionId).toBe(first.versionId)
    expect(describeStaleness(reloaded!, first).artifacts[0]?.freshness).toBe('current')
    await writeFile(join(film, 'models/knight/parts/helm.ts'), 'export const helm = 3;\n')
    const second = await collectModelInputs(cwd, spec())
    const staleness = describeStaleness(reloaded!, second)
    expect(staleness.known).toBe(false)
    expect(staleness.artifacts[0]?.freshness).toBe('needs-update')
    expect(staleness.reason?.changedSources).toEqual(['models/knight/parts/helm.ts'])
    expect(stalenessReason(staleness.reason)).toContain('models/knight/parts/helm.ts')
    const kept = upsertModelVersion(reloaded!, second.versionId, second.inputs, '2026-09-07T01:00:00.000Z')
    expect(kept.versions.map(version => version.versionId)).toEqual([second.versionId, first.versionId])
    expect(kept.versions[1]?.createdAt).toBe('2026-09-07T00:00:00.000Z')
  })

  it('returns null rather than a half-record when the file is absent or corrupt, and refuses to write an invalid one', async () => {
    expect(await readModelRecord(cwd, 'nothing')).toBeNull()
    await mkdir(join(film, 'models/broken'), { recursive: true })
    await writeFile(join(film, 'models/broken/model.json'), '{ not json')
    expect(await readModelRecord(cwd, 'broken')).toBeNull()
    const record = createModelRecord({ id: 'knight', kind: 'prop', title: 'k', now: '2026-09-07T00:00:00.000Z' })
    await expect(writeModelRecord(cwd, { ...record, schemaVersion: 2 as unknown as 1 })).rejects.toThrow(/不合法/)
  })
})

/* ── the model panel's endpoints (Studio's model-review and model-workflow tests) ── */

const V1 = 'a'.repeat(64)
const V2 = 'b'.repeat(64)
const MODEL = '/api/projects/p/models/crate'
const inputs = (seed: string) => ({
  entry: 'models/crate/crate.ts',
  sources: [{ path: 'models/crate/crate.ts', sha256: seed, bytes: 1 }],
  resources: [],
  parameters: {},
  toolchain: { three: '0.184.0', bundler: 'esbuild', bundlerVersion: '0.28.0', runtime: 'model-runtime@x' },
})

async function seedModel(kind: 'prop' | 'character' | 'scene' = 'prop', extra: Partial<ReturnType<typeof createModelRecord>> = {}): Promise<void> {
  await mkdir(join(film, 'models/crate'), { recursive: true })
  await writeFile(join(film, 'models/crate/crate.ts'), 'export function createCrateModel(){}')
  let record = createModelRecord({ id: 'crate', kind, title: '木箱', now: '2026-09-08T00:00:00.000Z' })
  record = upsertModelVersion(record, V1, inputs(V1), '2026-09-08T00:00:00.000Z')
  await writeModelRecord(cwd, { ...record, ...extra })
}

describe('the model list and report', () => {
  it('lists models with their newest version and capabilities, and reports the environment', async () => {
    await seedModel()
    const { status, body } = await call('/api/projects/p/models')
    expect(status).toBe(200)
    expect(body).toEqual({
      models: [{ id: 'crate', kind: 'prop', title: '木箱', updatedAt: '2026-09-08T00:00:00.000Z', versionId: V1, capabilities: ['source'] }],
      environment: ENVIRONMENT,
    })
  })

  it('probes the real environment: no model browser here, and Python only as discovered', async () => {
    const environment = await modelEnvironment()
    expect(environment.browser).toEqual({ found: false })
    if (environment.python.found) expect(environment.python.version).toMatch(/^3\.(1\d|[2-9]\d)$|^[4-9]\./)
  }, 30_000)

  it('answers an empty list for a film without models', async () => {
    expect((await call('/api/projects/p/models')).body).toEqual({ models: [], environment: ENVIRONMENT })
  })

  it('reports the record, its versions and its staleness against the disk', async () => {
    await seedModel()
    const report = (await call(MODEL)).body
    expect(report.record.id).toBe('crate')
    expect(report.versions).toEqual([expect.objectContaining({ versionId: V1, capabilities: ['source'], quality: expect.objectContaining({ verdict: 'incomplete' }) })])
    // The recorded hash is a placeholder, so the source on disk reads as moved.
    expect(report.staleness).toMatchObject({ known: false, reasonText: expect.stringContaining('models/crate/crate.ts') })
  })

  it('offers what to look at by what the model is for', async () => {
    await seedModel('character')
    expect((await call(MODEL)).body.reviewAspects).toEqual([...MODEL_REVIEW_ASPECTS.character])
    await seedModel('prop')
    expect((await call(MODEL)).body.reviewAspects).toEqual([...MODEL_REVIEW_ASPECTS.prop])
  })

  it('refuses an unsafe model id and an unknown model', async () => {
    expect(await call('/api/projects/p/models/..%2Fx')).toEqual({ status: 400, body: { code: 'MODEL_ID_INVALID', error: '模型 ID 不合法' } })
    expect(await call('/api/projects/p/models/ghost')).toEqual({ status: 404, body: { code: 'MODEL_NOT_FOUND', error: '没有这个模型记录' } })
  })

  it('shows pre-code progress without promoting forge checkboxes to quality passes', async () => {
    const dir = join(film, 'models/figure')
    await mkdir(join(dir, '.img2threejs'), { recursive: true })
    await mkdir(join(dir, 'evidence'))
    await writeFile(join(dir, '.img2threejs/state.json'), JSON.stringify({ profile: 'character', currentStep: 'build-current-pass', currentPass: 'blockout', status: 'active', checklist: [{ id: 'reference-suitability', status: 'done' }] }))
    await writeFile(join(dir, 'evidence/reference-admission.json'), '{"admitted":false}')
    const result = await readModelWorkflow(cwd, 'figure')
    expect(result).toMatchObject({ kind: 'character', entries: [], currentStep: 'build-current-pass', steps: [{ id: 'reference-suitability', status: 'done' }] })
    expect(result?.warnings).toHaveLength(1)
    await writeFile(join(dir, 'figure.ts'), 'export const a=1')
    const after = await readModelWorkflow(cwd, 'figure')
    expect(after?.entries).toEqual(['models/figure/figure.ts'])
    expect(after?.sourceRevision).not.toBe(result?.sourceRevision)
    await writeFile(join(dir, 'figure.ts'), 'export const a=2')
    expect((await readModelWorkflow(cwd, 'figure'))?.sourceRevision).not.toBe(after?.sourceRevision)
  })

  it('does not read a workflow symlink outside the film', async () => {
    const dir = join(film, 'models/figure/.img2threejs')
    await mkdir(dir, { recursive: true })
    const outside = join(cwd, 'outside.json')
    await writeFile(outside, '{"currentStep":"secret"}')
    if (!await link(outside, join(dir, 'state.json'))) return
    expect(await readModelWorkflow(cwd, 'figure')).toBeNull()
  })

  it('lists and shows an early task with no model.json, without writing a synthetic record', async () => {
    const dir = join(film, 'models/figure')
    await mkdir(join(dir, '.img2threejs'), { recursive: true })
    await writeFile(join(dir, '.img2threejs/state.json'), JSON.stringify({ profile: 'character', currentPass: 'blockout' }))
    expect((await call('/api/projects/p/models')).body.models[0]?.id).toBe('figure')
    const report = (await call('/api/projects/p/models/figure')).body
    expect(report.workflow.currentPass).toBe('blockout')
    expect(report.record.versions).toEqual([])
    expect(report.versions).toEqual([])
    expect(await exists(join(dir, 'model.json'))).toBe(false)
  })
})

describe('the model source', () => {
  it('reads and writes only under models/<id>/, refusing an edit made over someone else\'s', async () => {
    await seedModel()
    const read = await call(`${MODEL}/source?path=${encodeURIComponent('models/crate/crate.ts')}`)
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ path: 'models/crate/crate.ts', text: 'export function createCrateModel(){}', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect((await call(`${MODEL}/source?path=${encodeURIComponent('film.json')}`)).body.code).toBe('MODEL_SOURCE_PATH_INVALID')
    expect((await call(`${MODEL}/source?path=${encodeURIComponent('models/crate/../../film.json')}`)).body.code).toBe('MODEL_SOURCE_PATH_INVALID')
    expect((await call(`${MODEL}/source?path=${encodeURIComponent('models/crate/none.ts')}`)).status).toBe(404)
    const saved = await call(`${MODEL}/source`, 'PUT', { path: 'models/crate/crate.ts', text: 'export const v = 2', expectedSha256: read.body.sha256 })
    expect(saved).toMatchObject({ status: 200, body: { path: 'models/crate/crate.ts', bytes: 18 } })
    expect(await readFile(join(film, 'models/crate/crate.ts'), 'utf8')).toBe('export const v = 2')
    expect(seen).toContainEqual({ type: 'file-changed', projectId, path: 'models/crate/crate.ts' })
    const stale = await call(`${MODEL}/source`, 'PUT', { path: 'models/crate/crate.ts', text: 'lost', expectedSha256: read.body.sha256 })
    expect(stale).toMatchObject({ status: 409, body: { code: 'MODEL_SOURCE_CONFLICT' } })
    expect((await call(`${MODEL}/source`, 'PUT', { path: 'models/other/x.ts', text: 'x' })).body.code).toBe('MODEL_SOURCE_PATH_INVALID')
    expect((await call(`${MODEL}/source`, 'PUT', { path: 'models/crate/x.ts', text: 5 })).body.code).toBe('MODEL_SOURCE_INVALID')
  })
})

describe('review notes', () => {
  it('records a concrete concern against the version that was looked at', async () => {
    await seedModel()
    const created = await call(`${MODEL}/reviews`, 'POST', { aspect: 'size', concern: '箱体比参考图短了约三分之一', raisedBy: 'user' })
    expect(created.status).toBe(201)
    expect(created.body.note).toMatchObject({ versionId: V1, aspect: 'size', status: 'open', raisedBy: 'user' })
    expect(created.body.aspects).toEqual([...MODEL_REVIEW_ASPECTS.prop])
    const record = await readModelRecord(cwd, 'crate')
    expect(modelReviewSummary(record!.reviews, V1)).toMatchObject({ open: 1, openAspects: ['size'] })
    expect(seen).toContainEqual({ type: 'file-changed', projectId, path: 'models/crate/model.json' })
  })

  it('refuses an empty concern, an unknown version and an unknown model', async () => {
    await seedModel()
    expect((await call(`${MODEL}/reviews`, 'POST', { concern: '   ' })).body).toEqual({ code: 'MODEL_REVIEW_EMPTY', error: '审阅要写清楚具体问题' })
    expect((await call(`${MODEL}/reviews`, 'POST', { concern: '短了', versionId: V2 })).body.code).toBe('MODEL_VERSION_UNKNOWN')
    expect((await call('/api/projects/p/models/ghost/reviews', 'POST', { concern: '短了' })).status).toBe(404)
  })

  it('falls back to a known aspect rather than inventing one', async () => {
    await seedModel()
    // `rig` is a character aspect; a prop is not judged on it.
    expect((await call(`${MODEL}/reviews`, 'POST', { aspect: 'rig', concern: '形体不对' })).body.note.aspect).toBe('form')
  })

  it('keeps the note on its own version after the source moves, and follows the fix loop', async () => {
    await seedModel()
    const noteId = (await call(`${MODEL}/reviews`, 'POST', { aspect: 'size', concern: '短了三分之一' })).body.note.id as string
    let record = await readModelRecord(cwd, 'crate')
    record = upsertModelVersion(record!, V2, inputs(V2), '2026-09-08T01:00:00.000Z')
    await writeModelRecord(cwd, record)
    expect(modelReviewSummary(record.reviews, V2)).toMatchObject({ open: 1, carriedOver: 1 })
    const addressed = await call(`${MODEL}/reviews/${noteId}`, 'POST', { status: 'addressed', addressedInVersionId: V2, resolution: '按参考图重算了箱体长度' })
    expect(addressed.body.note).toMatchObject({ status: 'addressed', addressedInVersionId: V2 })
    expect(addressed.body.note.resolvedAt).toBeTruthy()
    expect((await call(`${MODEL}/reviews/${noteId}`, 'POST', { status: 'accepted' })).body.note.status).toBe('accepted')
    expect(modelReviewSummary((await readModelRecord(cwd, 'crate'))!.reviews, V2)).toMatchObject({ open: 0, accepted: 0, addressed: 0 })
    expect((await call(`${MODEL}/reviews/${noteId}`, 'POST', { status: 'maybe' })).body.code).toBe('MODEL_REVIEW_STATUS_INVALID')
    expect((await call(`${MODEL}/reviews/rev_nope`, 'POST', { status: 'accepted' })).status).toBe(404)
  })

  it('keeps both of two notes filed at the same time', async () => {
    await seedModel()
    await Promise.all([
      call(`${MODEL}/reviews`, 'POST', { concern: '一' }),
      call(`${MODEL}/reviews`, 'POST', { concern: '二' }),
    ])
    expect((await readModelRecord(cwd, 'crate'))!.reviews.map(note => note.concern).sort()).toEqual(['一', '二'])
  })
})

describe('adoption', () => {
  it('records the chosen version and warns about what is still open', async () => {
    await seedModel()
    await call(`${MODEL}/reviews`, 'POST', { aspect: 'form', concern: '倒角太硬' })
    const adopted = await call(`${MODEL}/adopt`, 'POST', { versionId: V1 })
    expect(adopted.body.adoptedVersionId).toBe(V1)
    expect(adopted.body.review).toMatchObject({ open: 1, openAspects: ['form'] })
    expect((await readModelRecord(cwd, 'crate'))?.adoptedVersionId).toBe(V1)
  })

  it('refuses a version this model does not have', async () => {
    await seedModel()
    expect(await call(`${MODEL}/adopt`, 'POST', { versionId: V2 })).toEqual({ status: 400, body: { code: 'MODEL_ADOPT_REJECTED', error: `这个模型没有版本 ${V2.slice(0, 12)}` } })
  })
})

describe('model runs', () => {
  const run = (runId: string, status: 'queued' | 'running' | 'succeeded') => ({
    runId, kind: 'mesh-dump' as const, versionId: V1, status, requestedBy: 'mcp' as const, startedAt: '2026-09-08T00:00:00.000Z', artifacts: [], checkIds: [],
  })

  it('lists the recorded runs, and one left running reads as interrupted, never failed', async () => {
    await seedModel('prop', { runs: [run('r2', 'running'), run('r1', 'succeeded')] })
    const { body } = await call(`${MODEL}/runs`)
    expect(body.runs.map((entry: { runId: string; status: string }) => [entry.runId, entry.status])).toEqual([['r2', 'interrupted'], ['r1', 'succeeded']])
    expect(body.runs[0]).toMatchObject({ projectId, modelId: 'crate', versionKnown: true, error: 'daemon 重启，任务中断' })
    expect((await call(`${MODEL}/runs/r1`)).body.run).toMatchObject({ runId: 'r1', status: 'succeeded' })
    expect(await call(`${MODEL}/runs/nope`)).toEqual({ status: 404, body: { code: 'MODEL_RUN_NOT_FOUND', error: '没有这个任务' } })
  })

  it('answers a cancel with the run as recorded, since nothing runs here', async () => {
    await seedModel('prop', { runs: [run('r2', 'queued')] })
    expect((await call(`${MODEL}/runs/r2/cancel`, 'POST')).body.run).toMatchObject({ runId: 'r2', status: 'interrupted' })
    expect((await call(`${MODEL}/runs/nope/cancel`, 'POST')).status).toBe(404)
  })

  it('refuses to start, retry or preview a run, with Studio\'s codes, and records nothing', async () => {
    await seedModel()
    expect((await call(`${MODEL}/runs`, 'POST', { kind: 'paint', entry: 'models/crate/crate.ts' })).body.code).toBe('MODEL_RUN_KIND_INVALID')
    expect((await call(`${MODEL}/runs`, 'POST', { kind: 'mesh-dump' })).body.code).toBe('MODEL_ENTRY_REQUIRED')
    const started = await call(`${MODEL}/runs`, 'POST', { kind: 'mesh-dump', entry: 'models/crate/crate.ts' })
    expect(started.status).toBe(400)
    expect(started.body).toMatchObject({ code: 'MODEL_RUN_REJECTED', error: expect.stringContaining('无头浏览器') })
    expect((await call(`${MODEL}/runs/r1/retry`, 'POST', {})).body.code).toBe('MODEL_RUN_REJECTED')
    expect((await call(`${MODEL}/preview`, 'POST', { entry: 'models/crate/crate.ts' })).body.code).toBe('MODEL_PREVIEW_REJECTED')
    expect((await readModelRecord(cwd, 'crate'))?.runs).toEqual([])
  })
})
