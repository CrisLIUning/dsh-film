/** The director endpoints as the canvas and the agent call them, against a real workspace and fake canvas pages. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasBoardAgent } from '../../src/canvas/board-agent.js'
import { CanvasDocumentStore } from '../../src/canvas/documents.js'
import { directorDiagnostics } from '../../src/director/query.js'
import { getDirectorProjectFingerprint } from '../../src/director/vendor/director-math/schema/projectFingerprint.js'
import type { ModelStructureInspection } from '../../src/director/vendor/director-math/schema/modelStructure.js'
import { createProject } from '../../src/project.js'
import { createStudioRouter } from '../../src/routes.js'
import { ProjectEvents } from '../../src/studio/events.js'
import type { ProjectEvent } from '../../src/studio/events.js'
import { character, lockedCamera, project, prop, walk } from './fixtures.js'
import type { Vec3 } from './fixtures.js'
import { openDeskPage } from './pages.js'

let cwd: string
let film: string
let agent: CanvasBoardAgent
let events: ProjectEvents
let seen: ProjectEvent[]
let router: ReturnType<typeof createStudioRouter>

const scene = () => project([character('a', [0, 0, 0]), character('b', [2, 0, 0])], [lockedCamera('cam', [1, 1.5, 6], [1, 1, 0])])

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-director-'))
  film = (await createProject(cwd, { title: '雨夜来客', aspectRatio: '16:9' })).project.id
  agent = new CanvasBoardAgent()
  events = new ProjectEvents()
  seen = []
  events.subscribe(cwd, (event) => { seen.push(event) })
  router = createStudioRouter({ events, boardAgent: agent })
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function call(path: string, json?: unknown, method = 'POST'): Promise<{ status: number; body: any }> {
  const url = new URL(`http://host/api/dsh-film/${method === 'GET' ? 'studio' : 'studio-write'}`)
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', path)
  if (method !== 'GET' && method !== 'POST') url.searchParams.set('method', method)
  const response = await router.dispatch(new Request(url, method === 'GET'
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json ?? {}) }))
  return { status: response.status, body: await response.json() }
}

const store = () => new CanvasDocumentStore(cwd, film)

async function board(nodes: unknown[]): Promise<void> {
  await store().write(film, { id: film, nodes, connections: [] })
}

const desk = (stored?: unknown, id = 'desk') => ({ id, type: 'director', title: '导演台', metadata: stored === undefined ? {} : { directorProject: stored } })
const savedScene = async (id = 'desk'): Promise<any> => ((await store().read(film))!.nodes as any[]).find(node => node.id === id).metadata.directorProject
const source = () => ({ boardId: film })

describe('finding the scene', () => {
  it('answers a query about the one director node, and names the nodes when it cannot choose', async () => {
    const stored = scene()
    await board([desk(stored)])
    const structure = await call('/api/director/query', { source: source(), query: { kind: 'structure' } })
    expect(structure.status).toBe(200)
    expect(structure.body).toMatchObject({ kind: 'structure', source: { boardId: film, nodeId: 'desk' } })
    expect(structure.body.objects.map((object: any) => object.id)).toEqual(['a', 'b'])
    // The events answer carries the stored bytes' fingerprint: the token a write quotes.
    expect((await call('/api/director/query', { source: source(), query: { kind: 'events' } })).body.fingerprint).toBe(getDirectorProjectFingerprint(stored))

    await board([desk(stored), desk(stored, 'desk-2')])
    expect(await call('/api/director/query', { source: source(), query: { kind: 'structure' } })).toMatchObject({
      status: 409, body: { code: 'DIRECTOR_NODE_AMBIGUOUS', directorNodes: [{ id: 'desk', name: '导演台' }, { id: 'desk-2', name: '导演台' }] },
    })
    expect((await call('/api/director/query', { source: { ...source(), nodeId: 'nope' }, query: { kind: 'structure' } })).body.code).toBe('DIRECTOR_NODE_NOT_FOUND')
    expect((await call('/api/director/query', { source: { boardId: 'other' }, query: { kind: 'structure' } })).body.code).toBe('CANVAS_DOCUMENT_NOT_FOUND')
  })

  it('refuses an empty node, bad queries and bad sources in Studio\'s shape', async () => {
    await board([desk()])
    expect(await call('/api/director/query', { source: source(), query: { kind: 'structure' } })).toMatchObject({ status: 422, body: { code: 'DIRECTOR_PROJECT_EMPTY', nodeId: 'desk' } })
    expect(await call('/api/director/query', { source: source(), query: { kind: 'nope' } })).toMatchObject({ status: 400, body: { code: 'DIRECTOR_QUERY_INVALID' } })
    expect((await call('/api/director/query', { source: 'x', query: { kind: 'structure' } })).body.code).toBe('DIRECTOR_SOURCE_INVALID')
    const inline = await call('/api/director/query', { source: { directorProject: scene() }, query: { kind: 'sample', at: [0] } })
    expect(inline.status).toBe(200)
    expect(inline.body.source).toEqual({})
  })
})

describe('staging', () => {
  it('starts a never-opened node from an empty scene and writes it into the saved board', async () => {
    await board([desk()])
    const plan = { ops: [{ type: 'place_character', id: 'hero', at: [0, 0] }, { type: 'shot', cameraId: 'cam_hero', shot: { subject: 'hero', size: 'medium' } }] }
    const dry = await call('/api/director/stage', { source: source(), plan, dryRun: true })
    expect(dry.body).toMatchObject({ written: false, desk: 'none', applied: [{ type: 'place_character' }, { type: 'shot' }] })
    expect(dry.body.project.objects.some((object: any) => object.id === 'hero')).toBe(true)
    expect(await savedScene()).toBeUndefined()

    const applied = await call('/api/director/stage', { source: source(), plan })
    expect(applied.status).toBe(200)
    expect(applied.body).toMatchObject({ written: true, desk: 'none', diagnostics: { kind: 'diagnostics' } })
    expect(applied.body.project).toBeUndefined()
    const stored = await savedScene()
    expect(stored).toMatchObject({ protocolVersion: 1, projectFingerprint: applied.body.fingerprint })
    expect(stored.project.objects.map((object: any) => object.id)).toContain('hero')
    expect(seen).toContainEqual({ type: 'story-canvas-changed', projectId: film, boardId: film })

    // A write quoting an older fingerprint is refused, with the current one to read again from.
    const stale = await call('/api/director/stage', { source: source(), plan: { ops: [{ type: 'remove', objectId: 'hero' }] }, expectedFingerprint: 'fnv1a32-00000000' })
    expect(stale).toMatchObject({ status: 409, body: { code: 'DIRECTOR_SCENE_CONFLICT', fingerprint: applied.body.fingerprint, desk: 'none' } })
    expect(await call('/api/director/stage', { source: source(), plan: { ops: [{ type: 'teleport' }] } })).toMatchObject({ status: 400, body: { code: 'DIRECTOR_STAGE_INVALID', op: 0 } })
  })

  it('writes into the desk open in the 导演 tab, not the newer 分镜 page', async () => {
    const stored = scene()
    await board([desk(stored)])
    const live = structuredClone(stored)
    live.objects[0]!.name = '桌上改过'
    const director = openDeskPage(agent, film, { deskOpen: true, scene: { project: live } })
    const storyboard = openDeskPage(agent, film, { deskOpen: false, scene: stored })
    const read = await call('/api/director/query', { source: source(), query: { kind: 'events' } })
    expect(read.body.fingerprint).toBe(getDirectorProjectFingerprint(live))
    const staged = await call('/api/director/stage', { source: source(), plan: { ops: [{ type: 'place_prop', id: 'box', at: [3, 3], size: [1, 1, 1] }] }, expectedFingerprint: read.body.fingerprint })
    expect(staged.status, JSON.stringify(staged.body)).toBe(200)
    expect(staged.body).toMatchObject({ written: true, desk: 'open' })
    expect(director.calls.map(item => item.name)).toEqual(['director_read_scene', 'director_read_scene', 'director_write_scene'])
    expect(storyboard.calls.map(item => item.name)).toEqual(['director_read_scene', 'director_read_scene'])
    expect(director.calls[2]!.input).toMatchObject({ boardId: film, nodeId: 'desk', project: film, expectedFingerprint: read.body.fingerprint })
    expect((director.scene as any).project.objects.map((object: any) => [object.id, object.name])).toContainEqual(['a', '桌上改过'])
    // The page saves its board; nothing was written behind it.
    expect(await savedScene()).toEqual(stored)
  })

  it('writes through the newest page when no desk is open, and never around a page that refuses', async () => {
    await board([desk(scene())])
    const page = openDeskPage(agent, film, { deskOpen: false, scene: scene() })
    const staged = await call('/api/director/stage', { source: source(), plan: { ops: [{ type: 'set_scene', collision: false }] } })
    expect(staged.body).toMatchObject({ written: true, desk: 'closed' })
    expect(page.calls.map(item => item.name)).toEqual(['director_read_scene', 'director_write_scene'])
    page.release()

    openDeskPage(agent, film, { refuse: '页面忙' })
    const before = await savedScene()
    expect(await call('/api/director/stage', { source: source(), plan: { ops: [{ type: 'set_scene', collision: true }] } })).toMatchObject({ status: 502, body: { code: 'CANVAS_BOARD_REFUSED' } })
    expect(await savedScene()).toEqual(before)
  })

  it('refuses to choose between two open desks on one node', async () => {
    await board([desk(scene())])
    openDeskPage(agent, film, { deskOpen: true, scene: scene() })
    openDeskPage(agent, film, { deskOpen: true, scene: scene() })
    expect(await call('/api/director/query', { source: source(), query: { kind: 'structure' } })).toMatchObject({ status: 409, body: { code: 'DIRECTOR_DESK_AMBIGUOUS', nodeId: 'desk' } })
  })

  it('verifies imported bytes in the film before a scene refers to them', async () => {
    await board([desk(scene())])
    await mkdir(join(cwd, 'film', 'models'), { recursive: true })
    const bytes = Buffer.from('glTF model bytes')
    await writeFile(join(cwd, 'film', 'models', 'box.glb'), bytes)
    const sha = createHash('sha256').update(bytes).digest('hex')
    const op = (url: string, contentSha256 = sha) => ({
      type: 'import_asset', name: '箱子', kind: 'prop',
      source: { url, fileName: 'box.glb', modelFormat: 'glb', contentSha256, byteLength: bytes.length },
    })
    const ok = await call('/api/director/stage', { source: source(), plan: { ops: [op(`/api/projects/${film}/raw/models/box.glb`)] }, dryRun: true })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((await call('/api/director/stage', { source: source(), plan: { ops: [op(`/api/projects/${film}/raw/models/box.glb`, 'f'.repeat(64))] }, dryRun: true })).body)
      .toMatchObject({ code: 'DIRECTOR_STAGE_INVALID', op: 0, error: expect.stringContaining('SHA256') })
    expect((await call('/api/director/stage', { source: source(), plan: { ops: [op('/api/projects/other/raw/models/box.glb')] }, dryRun: true })).body.error).toMatch(/当前导演台所在项目/u)
    expect((await call('/api/director/stage', { source: source(), plan: { ops: [op(`/api/projects/${film}/raw/models/box.glb`)] } })).body.error).toMatch(/expectedFingerprint/u)
  })

  it('reads and writes whole scenes, guarded by the fingerprint', async () => {
    const stored = scene()
    await board([desk(stored)])
    const read = await call(`/api/director/scenes/${film}/desk`, undefined, 'GET')
    expect(read.body).toMatchObject({ source: { boardId: film, nodeId: 'desk' }, fingerprint: getDirectorProjectFingerprint(stored), desk: 'none', version: 15 })
    const next = structuredClone(stored)
    next.objects[1]!.name = '乙'
    expect((await call(`/api/director/scenes/${film}/desk`, { project: next, expectedFingerprint: 'fnv1a32-deadbeef' }, 'PUT')).body.code).toBe('DIRECTOR_SCENE_CONFLICT')
    const written = await call(`/api/director/scenes/${film}/desk`, { project: next, expectedFingerprint: read.body.fingerprint }, 'PUT')
    expect(written.body).toMatchObject({ desk: 'none', fingerprint: getDirectorProjectFingerprint(next) })
    expect((await savedScene()).project.objects[1].name).toBe('乙')
  })
})

describe('diagnostics on the Host event loop', () => {
  it('lets other work run while a long scene is checked', async () => {
    const a = character('a', [0, 0, 0], { motionClips: [walk('a_walk', 0, 60, [0, 0, 0], [20, 0, 0])] })
    const long = project([a, character('b', [0, 0, 4])], [lockedCamera('cam', [0, 1.5, 12], [0, 1, 0]), lockedCamera('cam2', [5, 1.5, 12], [0, 1, 0])])
    long.timeline.duration = 60
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 1)
    const started = performance.now()
    const report = await directorDiagnostics(long, { kind: 'diagnostics', step: 0.05 })
    const elapsed = performance.now() - started
    clearInterval(timer)
    expect(report.kind).toBe('diagnostics')
    // A run long enough to matter gave the loop back; a synchronous one would leave ticks at 0.
    if (elapsed > 50) expect(ticks).toBeGreaterThan(0)
  })
})

describe('rendering through the open desk', () => {
  const files = [{ kind: 'frame', url: '/api/projects/F/raw/canvas/uploads/cam-0.0s.png', fileName: 'cam-0.0s.png', width: 1920, height: 1080, nodeId: 'n-1', cameraId: 'cam' }]

  it('goes past the page without the desk to the one that has it', async () => {
    await board([desk(scene())])
    expect(await call('/api/director/render', { source: source(), frames: [{ cameraId: 'cam' }] })).toMatchObject({ status: 409, body: { code: 'CANVAS_BOARD_NOT_OPEN' } })
    const director = openDeskPage(agent, film, {
      deskOpen: true, scene: scene(),
      answer: name => name === 'director_render' ? { deskOpen: true, files: files.map(file => ({ ...file, url: file.url.replace('/F/', `/${film}/`) })) } : undefined,
    })
    const storyboard = openDeskPage(agent, film, { deskOpen: false, scene: scene() })
    const rendered = await call('/api/director/render', { source: source(), frames: [{ cameraId: 'cam', at: 1 }], quality: '720p', junk: true })
    expect(rendered.status, JSON.stringify(rendered.body)).toBe(200)
    expect(rendered.body).toMatchObject({ desk: 'open', project: film, files: [{ kind: 'frame', path: 'canvas/uploads/cam-0.0s.png', nodeId: 'n-1' }] })
    expect(storyboard.calls.map(item => item.name)).toEqual(['director_render'])
    expect(director.calls).toEqual([{ name: 'director_render', input: { boardId: film, nodeId: 'desk', project: film, request: { frames: [{ cameraId: 'cam', at: 1 }], quality: '720p' } } }])
  })

  it('refuses requests the page could not take, and a board with no desk open', async () => {
    await board([desk(scene())])
    expect((await call('/api/director/render', { source: source() })).body.code).toBe('DIRECTOR_RENDER_EMPTY')
    expect((await call('/api/director/render', { source: source(), frames: [{ at: -1 }] })).body.code).toBe('DIRECTOR_RENDER_INVALID')
    expect((await call('/api/director/render', { source: { directorProject: scene() }, sheet: true })).body.code).toBe('DIRECTOR_RENDER_NEEDS_BOARD')
    openDeskPage(agent, film, { deskOpen: false, scene: scene() })
    expect(await call('/api/director/render', { source: source(), sheet: true })).toMatchObject({ status: 409, body: { code: 'DIRECTOR_DESK_NOT_OPEN', nodeId: 'desk' } })
    expect((await call('/api/director/render/status', { source: source() })).body.code).toBe('DIRECTOR_DESK_NOT_OPEN')
  })

  it('reads and cancels the desk\'s output job', async () => {
    await board([desk(scene())])
    const job = { jobId: 'job-1', label: '预演输出', phase: 'rendering', completedFrames: 2, totalFrames: 10, savedOutputs: 0 }
    const page = openDeskPage(agent, film, { deskOpen: true, scene: scene(), answer: name => name.startsWith('director_render_') ? { deskOpen: true, task: job } : undefined })
    expect((await call('/api/director/render/status', { source: source() })).body).toEqual({ source: { boardId: film, nodeId: 'desk' }, desk: 'open', task: job })
    expect((await call('/api/director/render/cancel', { source: source() })).body.code).toBe('DIRECTOR_RENDER_JOB_REQUIRED')
    expect((await call('/api/director/render/cancel', { source: source(), jobId: 'job-1' })).status).toBe(200)
    expect(page.calls.at(-1)).toMatchObject({ name: 'director_render_cancel', input: { jobId: 'job-1' } })
  })
})

describe('model inspection', () => {
  const room = () => {
    const value = project([prop('room', [9, 0, 2], [2, 2, 2], { kind: 'scene', assetRefId: 'castle' })], [])
    value.assets = [{ id: 'castle', name: '古堡', kind: 'scene', sourceType: 'model', url: '/castle.glb', fileName: 'castle.glb', modelCalibration: { metresPerUnit: 0.01, rotation: [0, 0, 0], anchor: 'source' } }] as never
    return value
  }
  const inspection: ModelStructureInspection = {
    bounds: { min: [0, 0, 0], max: [400, 300, 20] },
    parts: [{ id: 'part1', name: '东墙', group: '一层', role: 'wall', shape: 'box', corners: Array.from({ length: 8 }, (_, mask) => [mask & 1 ? 400 : 0, mask & 2 ? 300 : 0, mask & 4 ? 20 : 0] as Vec3) }],
  }

  it('reads candidates from the desk that loaded the model and proposes a plan staging can apply', async () => {
    const stored = room()
    await board([desk(stored)])
    expect((await call('/api/director/inspect-model', { source: source(), objectId: 'room' })).body.code).toBe('DIRECTOR_DESK_NOT_OPEN')
    const fingerprint = getDirectorProjectFingerprint(stored)
    openDeskPage(agent, film, { deskOpen: false, scene: stored })
    const page = openDeskPage(agent, film, {
      deskOpen: true, scene: stored,
      answer: name => name === 'director_inspect_model' ? { deskOpen: true, structure: { assetId: 'castle', fingerprint, inspection } } : undefined,
    })
    const result = await call('/api/director/inspect-model', { source: source(), objectId: 'room' })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body).toMatchObject({ fingerprint, objectId: 'room', assetId: 'castle', partCount: 1, ignoredSurfaceCount: 0, candidates: [{ evidence: 'metadata', recommended: true, volume: { bounds: { min: [0, 0, 0], max: [4, 3, 0.2] } } }] })
    expect(result.body.plan.ops).toHaveLength(1)
    expect(page.calls.at(-1)).toMatchObject({ name: 'director_inspect_model', input: { assetId: 'castle', nodeId: 'desk' } })
    expect((await call('/api/director/inspect-model', { source: source(), objectId: 'missing' })).body.code).toBe('DIRECTOR_MODEL_INVALID')
    expect((await call('/api/director/inspect-model', { source: source() })).body.code).toBe('DIRECTOR_MODEL_OBJECT_REQUIRED')
  })
})

describe('reviews', () => {
  it('creates a version through the open desk, comments, confirms and stages a generation handoff on the page', async () => {
    const stored = scene()
    stored.timeline.duration = 6
    stored.shots = [{ id: 's1', name: '开场', cameraId: 'cam', sourceIn: 0, sourceOut: 3 }] as never
    await board([desk(stored)])
    const fingerprint = getDirectorProjectFingerprint(stored)
    await mkdir(join(cwd, 'film', 'canvas', 'uploads'), { recursive: true })
    const page = openDeskPage(agent, film, {
      deskOpen: true, scene: stored,
      answer: (name, input) => {
        if (name === 'director_render') {
          const request = input.request as { expectedFingerprint: string }
          const url = (file: string) => `/api/projects/${film}/raw/canvas/uploads/${file}`
          return writeFile(join(cwd, 'film', 'canvas', 'uploads', 'shot.png'), 'frame').then(() => writeFile(join(cwd, 'film', 'canvas', 'uploads', 'sheet.png'), 'sheet')).then(() => ({
            deskOpen: true,
            files: [
              { kind: 'frame', url: url('shot.png'), fileName: 'shot.png', width: 1280, height: 720, shotId: 's1', directorFingerprint: request.expectedFingerprint },
              { kind: 'sheet', url: url('sheet.png'), fileName: 'sheet.png', width: 1280, height: 720, directorFingerprint: request.expectedFingerprint },
            ],
          }))
        }
        if (name === 'director_stage_review') return { saved: true, nodeIds: (input.request as { nodeIds: unknown }).nodeIds }
        return undefined
      },
    })
    const made = await call('/api/director/review', { source: { boardId: film, nodeId: 'desk', project: film }, action: 'create', expectedFingerprint: fingerprint })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    const version = made.body.versions[0]
    expect(version).toMatchObject({ number: 1, revision: 1, decision: 'unreviewed', fingerprint, shots: [{ shotId: 's1' }] })
    expect(made.body.source).toEqual({ boardId: film, nodeId: 'desk', project: film })
    expect(JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'director-reviews', `${createHash('sha256').update(JSON.stringify([film, 'desk'])).digest('hex')}.json`), 'utf8')).versions).toHaveLength(1)

    const confirmed = await call('/api/director/review', { source: source(), action: 'confirm', versionId: version.id, expectedRevision: 1, expectedFingerprint: fingerprint })
    expect(confirmed.body.versions[0].decision).toBe('approved')
    const handoff = { source: source(), action: 'handoff', versionId: version.id, expectedRevision: 2, expectedFingerprint: fingerprint, target: 'generation', filePath: 'canvas/uploads/shot.png', mode: 'image', prompt: '雨夜', operationId: 'op-1' }
    const dry = await call('/api/director/review', { ...handoff, dryRun: true })
    expect(dry.body.handoff).toMatchObject({ target: 'generation', committed: false, nodeIds: { reference: expect.stringMatching(/^review-ref-/u) } })
    const applied = await call('/api/director/review', { ...handoff, dryRun: false })
    expect(applied.body.handoff).toMatchObject({ committed: true, nodeIds: dry.body.handoff.nodeIds })
    const staged = page.calls.find(item => item.name === 'director_stage_review')!.input as any
    expect(staged.expectedFingerprint).toBe(fingerprint)
    expect(staged.request.ops.filter((op: any) => op.type === 'add_node').map((op: any) => op.id)).toEqual(Object.values(dry.body.handoff.nodeIds))
    expect(JSON.stringify(staged.request.ops)).toContain(`@[node:${dry.body.handoff.nodeIds.prompt}]`)
    expect((await call('/api/director/review', { ...handoff, target: 'timeline', mode: 'append', dryRun: true })).body.code).toBe('DIRECTOR_REVIEW_TIMELINE_UNAVAILABLE')
  })

  it('needs a board and refuses an unknown version', async () => {
    await board([desk(scene())])
    expect((await call('/api/director/review', { source: { directorProject: scene() }, action: 'list' })).body.code).toBe('DIRECTOR_REVIEW_NEEDS_BOARD')
    expect((await call('/api/director/review', { source: source(), action: 'list' })).body.versions).toEqual([])
    expect(await call('/api/director/review', { source: source(), action: 'get', versionId: 'nope' })).toMatchObject({ status: 404, body: { code: 'DIRECTOR_REVIEW_NOT_FOUND' } })
  })
})

describe('modeling briefs and compiled motion', () => {
  it('prepares a brief for the film, with or without a director target', async () => {
    const plain = await call(`/api/projects/${film}/modeling-brief`, { kind: 'prop', description: '一把旧木椅' })
    expect(plain.body).toMatchObject({ projectId: film, skillIds: [] })
    expect(plain.body.prompt).toContain('无需创建或打开导演台')
    const targeted = await call(`/api/projects/${film}/modeling-brief`, { kind: 'scene', description: '客栈大堂', context: { projectId: film, boardId: film, view: 'director', director: { nodeId: 'desk', objectIds: [] } } })
    expect(targeted.body.skillIds).toEqual([])
    expect(await call(`/api/projects/${film}/modeling-brief`, { kind: 'house', description: 'x' })).toMatchObject({ status: 400, body: { code: 'MODELING_BRIEF_INVALID' } })
    expect((await call(`/api/projects/${film}/modeling-brief`, { kind: 'scene', description: 'x', context: { projectId: 'other', boardId: film, view: 'director', director: { nodeId: 'd' } } })).body.error).toBe('建模需要当前项目的导演台目标')
  })

  it('compiles a motion into the film once per request id', async () => {
    const spec = { schemaVersion: 1, name: '挥手', duration: 2, fps: 30, joints: { RightArm: [{ at: 0, degrees: [0, 0, 45] }, { at: 1, degrees: [0, 0, 100] }, { at: 2, degrees: [0, 0, 45] }] } }
    const first = await call(`/api/projects/${film}/director/motions`, { requestId: 'wave-v1', spec })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body).toMatchObject({ status: 'done', reused: false, file: { kind: 'authored-motion', report: { reviewRequired: true, qualityAccepted: false }, importPlan: { ops: [{ type: 'import_animation' }] } } })
    const glb = await readFile(join(cwd, 'film', first.body.file.filePath))
    expect(glb.subarray(0, 4).toString()).toBe('glTF')
    expect(first.body.file.importPlan.ops[0].source.url).toBe(`/api/projects/${film}/raw/${first.body.file.filePath}`)
    expect((await call(`/api/projects/${film}/director/motions`, { requestId: 'wave-v1', spec })).body).toMatchObject({ reused: true, taskId: first.body.taskId })
    expect(await call(`/api/projects/${film}/director/motions`, { requestId: 'wave-v1', spec: { ...spec, name: '再挥手' } })).toMatchObject({ status: 409, body: { code: 'MOTION_REQUEST_CONFLICT' } })
    expect((await call(`/api/projects/${film}/director/motions`, { requestId: 'bad id', spec })).body.code).toBe('MOTION_REQUEST_INVALID')
    expect((await call(`/api/projects/${film}/director/motions`, { requestId: 'wave-v2', spec: { ...spec, duration: 99 } })).body.code).toBe('MOTION_SPEC_INVALID')

    // The import plan stages against the saved scene, bytes verified.
    const actor = scene()
    actor.assets = [{ id: 'model', kind: 'character', name: 'actor', sourceType: 'model', fileName: 'actor.glb', url: '/actor.glb', modelFormat: 'glb', characterRigProfile: 'mixamo', characterImportReadiness: 'ready' }] as never
    await board([desk(actor)])
    const staged = await call('/api/director/stage', { source: source(), plan: first.body.file.importPlan, expectedFingerprint: getDirectorProjectFingerprint(actor) })
    expect(staged.status, JSON.stringify(staged.body)).toBe(200)
    expect(staged.body.applied[0]).toMatchObject({ type: 'import_animation' })
  })
})
