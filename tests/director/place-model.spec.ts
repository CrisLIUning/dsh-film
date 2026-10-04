/** The agent's place_model op (C10), staged through the router in-process against a real workspace. */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasBoardAgent } from '../../src/canvas/board-agent.js'
import { CanvasDocumentStore } from '../../src/canvas/documents.js'
import { invalidateWorkspaceMedia } from '../../src/media.js'
import { clearModelFactsCache } from '../../src/model-files/facts.js'
import { createProject } from '../../src/project.js'
import { createStudioRouter } from '../../src/routes.js'
import { ProjectEvents } from '../../src/studio/events.js'
import { Gltf, binaryFbx } from '../model-files/fixtures.js'
import { character, lockedCamera, project } from './fixtures.js'

let cwd: string
let film: string
let router: ReturnType<typeof createStudioRouter>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-place-'))
  film = (await createProject(cwd, { title: '雨夜来客', aspectRatio: '16:9' })).project.id
  router = createStudioRouter({ events: new ProjectEvents(), boardAgent: new CanvasBoardAgent() })
  invalidateWorkspaceMedia()
  clearModelFactsCache()
  const scene = project([character('a', [0, 0, 0])], [lockedCamera('cam', [0, 1.5, 6], [0, 1, 0])])
  await new CanvasDocumentStore(cwd, film).write(film, { id: film, nodes: [{ id: 'desk', type: 'director', title: '导演台', metadata: { directorProject: scene } }], connections: [] })
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function call(path: string, json: unknown): Promise<{ status: number; body: any }> {
  const url = new URL('http://host/api/dsh-film/studio-write')
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', path)
  const response = await router.dispatch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }))
  return { status: response.status, body: await response.json() }
}

async function file(relative: string, content: string | Buffer): Promise<void> {
  const path = join(cwd, ...relative.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

/** A box GLB of this size in metres, under a scaled parent (a Blender export). */
function boxGlb(size: [number, number, number]): Buffer {
  const gltf = new Gltf()
  const half = [size[0] / 2, size[1], size[2] / 2]
  const mesh = gltf.mesh({ attributes: { POSITION: gltf.box([-half[0]! * 100, 0, -half[2]! * 100], [half[0]! * 100, half[1]! * 100, half[2]! * 100]) } })
  return gltf.scene(gltf.node({ scale: [0.01, 0.01, 0.01], children: [gltf.node({ mesh })] })).glb()
}

const source = () => ({ boardId: film })
const fingerprint = async (): Promise<string> => (await call('/api/director/query', { source: source(), query: { kind: 'events' } })).body.fingerprint
const structure = async (): Promise<any> => (await call('/api/director/query', { source: source(), query: { kind: 'structure' } })).body
const stage = async (ops: unknown[], extra: Record<string, unknown> = {}) => call('/api/director/stage', { source: source(), plan: { ops }, ...extra })
const apply = async (ops: unknown[]) => stage(ops, { expectedFingerprint: await fingerprint() })
const savedProject = async (): Promise<any> => ((await new CanvasDocumentStore(cwd, film).read(film))!.nodes as any[])[0].metadata.directorProject.project ?? ((await new CanvasDocumentStore(cwd, film).read(film))!.nodes as any[])[0].metadata.directorProject
const modelsCopied = async (): Promise<string[]> => readdir(join(cwd, 'film', 'canvas', 'models')).catch(() => [])

describe('place_model', () => {
  it('dry-runs a workspace GLB without copying it, then applies it once at its real size', async () => {
    await file('props/chair.glb', boxGlb([0.5, 0.9, 0.45]))
    const op = { type: 'place_model', path: 'props/chair.glb', at: [1, 2], facing: 90 }
    const before = await fingerprint()
    const dry = await stage([op], { dryRun: true, expectedFingerprint: before })
    expect(dry.status, JSON.stringify(dry.body)).toBe(200)
    expect(dry.body.written).toBe(false)
    expect(dry.body.placed).toEqual([expect.objectContaining({ op: 0, path: 'canvas/models/chair.glb', kind: 'prop', metresPerUnit: 1, sizeFrom: 'gltf-metres', imported: false, wouldImport: 'canvas/models/chair.glb' })])
    expect(await modelsCopied()).toEqual([])

    const applied = await stage([op], { expectedFingerprint: before })
    expect(applied.status, JSON.stringify(applied.body)).toBe(200)
    expect(applied.body.written).toBe(true)
    expect(applied.body.placed).toEqual([expect.objectContaining({ op: 0, path: 'canvas/models/chair.glb', imported: true })])
    expect(applied.body.placed[0].wouldImport).toBeUndefined()
    expect(applied.body.placed[0].sizeMetres.map((value: number) => Number(value.toFixed(3)))).toEqual([0.5, 0.9, 0.45])
    expect(applied.body.applied.map((entry: { op: number; type: string }) => [entry.op, entry.type])).toEqual([[0, 'import_asset'], [0, 'calibrate_asset'], [0, 'place_asset'], [0, 'transform_objects']])
    expect(await modelsCopied()).toEqual(['chair.glb'])
    expect((await readFile(join(cwd, 'film', 'canvas', 'models', 'chair.glb'))).equals(boxGlb([0.5, 0.9, 0.45]))).toBe(true)

    const read = await structure()
    const asset = read.assets.find((entry: { id: string }) => entry.id === applied.body.placed[0].assetId)
    expect(asset).toMatchObject({ kind: 'prop', scaleMode: 'physical', modelCalibration: { metresPerUnit: 1, anchor: 'ground-center' } })
    expect(asset.modelSize.map((value: number) => Number(value.toFixed(3)))).toEqual([0.5, 0.9, 0.45])
    const saved = await savedProject()
    const object = saved.objects.find((entry: { id: string }) => entry.id === applied.body.placed[0].objectId)
    expect(object.transform.position).toEqual([1, 0, 2])
    expect(object.transform.rotation[1]).toBeCloseTo(Math.PI / 2)
    expect(saved.assets.find((entry: { id: string }) => entry.id === asset.id).url).toBe(`/api/projects/${film}/raw/canvas/models/chair.glb`)
  })

  it('anchors a prop at its ground centre and a scene at its source origin', async () => {
    await file('film/spaces/hall.glb', boxGlb([12, 3, 8]))
    await file('film/props/crate.glb', boxGlb([1, 1, 1]))
    const placed = await apply([{ type: 'place_model', path: 'film/spaces/hall.glb' }, { type: 'place_model', path: 'props/crate.glb', kind: 'prop', at: [2, 0] }])
    expect(placed.status, JSON.stringify(placed.body)).toBe(200)
    expect(placed.body.placed.map((entry: { kind: string; imported: boolean }) => [entry.kind, entry.imported])).toEqual([['scene', false], ['prop', false]])
    const assets = (await structure()).assets
    expect(assets.find((entry: { id: string }) => entry.id === placed.body.placed[0].assetId).modelCalibration.anchor).toBe('source')
    expect(assets.find((entry: { id: string }) => entry.id === placed.body.placed[1].assetId).modelCalibration.anchor).toBe('ground-center')
  })

  it('takes a size in metres for a model without its own scale', async () => {
    // A web generator's normalised model: one unit tall, whatever it depicts.
    const unit = new Gltf()
    await file('props/unit.glb', unit.scene(unit.node({ mesh: unit.mesh({ attributes: { POSITION: unit.box([-0.5, 0, -0.5], [0.5, 1, 0.5]) } }) })).glb())
    const placed = await apply([{ type: 'place_model', path: 'props/unit.glb', size: { height: 1.8 } }])
    expect(placed.status, JSON.stringify(placed.body)).toBe(200)
    expect(placed.body.placed[0]).toMatchObject({ metresPerUnit: 1.8, sizeFrom: 'size' })
    expect(placed.body.placed[0].sizeMetres.map((value: number) => Number(value.toFixed(3)))).toEqual([1.8, 1.8, 1.8])
  })

  it('refuses an OBJ without units, naming its raw size, and places it with a unit', async () => {
    await file('props/cup.obj', 'v -5 0 -4\nv 5 12 4\n')
    const refused = await stage([{ type: 'place_model', path: 'props/cup.obj' }], { dryRun: true })
    expect(refused).toMatchObject({ status: 400, body: { code: 'DIRECTOR_MODEL_UNITS_UNKNOWN', op: 0, rawSize: [10, 12, 8] } })
    expect(refused.body.error).toContain('10 × 12 × 8')
    const placed = await apply([{ type: 'place_model', path: 'props/cup.obj', metresPerUnit: 0.01 }])
    expect(placed.status, JSON.stringify(placed.body)).toBe(200)
    expect(placed.body.placed[0]).toMatchObject({ metresPerUnit: 0.01, sizeFrom: 'explicit', path: 'canvas/models/cup.obj' })
    expect(placed.body.placed[0].sizeMetres.map((value: number) => Number(value.toFixed(3)))).toEqual([0.1, 0.12, 0.08])
  })

  it('uses an FBX\'s own unit, and refuses a size it cannot measure', async () => {
    await file('props/table.fbx', binaryFbx(7400, 1))
    const placed = await apply([{ type: 'place_model', path: 'props/table.fbx', kind: 'prop' }])
    expect(placed.status, JSON.stringify(placed.body)).toBe(200)
    expect(placed.body.placed[0]).toMatchObject({ metresPerUnit: 0.01, sizeFrom: 'fbx-unit', kind: 'prop' })
    expect(placed.body.placed[0].sizeMetres).toBeUndefined()
    expect(placed.body.applied.map((entry: { type: string }) => entry.type)).toEqual(['import_asset', 'place_asset'])
    expect(await stage([{ type: 'place_model', path: 'props/table.fbx', size: { height: 0.8 } }], { dryRun: true })).toMatchObject({ status: 400, body: { code: 'DIRECTOR_STAGE_INVALID', op: 0 } })
  })

  it('reuses one asset for the same bytes and calibration', async () => {
    await file('props/chair.glb', boxGlb([0.5, 0.9, 0.45]))
    const first = await apply([{ type: 'place_model', path: 'props/chair.glb' }, { type: 'place_model', path: 'props/chair.glb', at: [3, 0] }])
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.placed[0].assetId).toBe(first.body.placed[1].assetId)
    expect(first.body.placed[0].objectId).not.toBe(first.body.placed[1].objectId)
    const again = await apply([{ type: 'place_model', path: 'film/canvas/models/chair.glb', at: [5, 0] }])
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.placed[0].assetId).toBe(first.body.placed[0].assetId)
    expect((await savedProject()).assets.filter((asset: { sourceType: string; kind: string }) => asset.sourceType === 'model' && asset.kind === 'prop')).toHaveLength(1)
    expect(await modelsCopied()).toEqual(['chair.glb'])
  })

  it('keeps its ids clear of the agent\'s own id-less imports and placements between placements', async () => {
    await file('props/a.glb', boxGlb([0.5, 0.9, 0.45]))
    await file('props/b.glb', boxGlb([1, 1, 1]))
    const crate = boxGlb([0.3, 0.3, 0.3])
    await file('film/props/x.glb', crate)
    const sha = createHash('sha256').update(crate).digest('hex')
    const imported = (extra: Record<string, unknown> = {}) => ({
      type: 'import_asset', name: 'x', kind: 'prop', calibration: { metresPerUnit: 0.5, rotation: [0, 0, 0], anchor: 'ground-center' },
      source: { url: `/api/projects/${film}/raw/props/x.glb`, fileName: 'x.glb', modelFormat: 'glb', byteLength: crate.length, contentSha256: sha }, ...extra,
    })
    // The import takes the desk's own next asset and object ids, between two placements.
    const first = await apply([{ type: 'place_model', path: 'props/a.glb' }, imported(), { type: 'place_model', path: 'props/b.glb' }])
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    // With its asset id named, the import's scene object still takes the desk's next object id.
    const second = await apply([{ type: 'place_model', path: 'props/a.glb', at: [2, 0] }, imported({ assetId: 'xx' }), { type: 'place_model', path: 'props/b.glb', at: [4, 0] }])
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    // And an id-less place_asset between placements.
    const crateAsset = first.body.applied.find((entry: { op: number; type: string }) => entry.op === 1 && entry.type === 'import_asset').assetId
    expect(second.body.applied.find((entry: { op: number }) => entry.op === 1)).toMatchObject({ assetId: crateAsset, reused: true })
    const third = await apply([{ type: 'place_model', path: 'props/a.glb', at: [6, 0] }, { type: 'place_asset', assetId: crateAsset, at: [0, 4] }, { type: 'place_model', path: 'props/b.glb', at: [8, 0] }])
    expect(third.status, JSON.stringify(third.body)).toBe(200)
    const saved = await savedProject()
    const objectIds = saved.objects.map((object: { id: string }) => object.id)
    expect(new Set(objectIds).size).toBe(objectIds.length)
    expect(saved.objects).toHaveLength(1 + 3 + 3 + 3)
  })

  it('reuses an asset the desk measured itself, even with a locked instance, without calibrating it again', async () => {
    await file('props/chair.glb', boxGlb([0.5, 0.9, 0.45]))
    const first = await apply([{ type: 'place_model', path: 'props/chair.glb' }])
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    // The desk's own measurement (three's Float32 data) differs in the last digits, and the person locks the instance.
    const document = (await new CanvasDocumentStore(cwd, film).read(film))!
    const scene = await savedProject()
    const asset = scene.assets.find((entry: { id: string }) => entry.id === first.body.placed[0].assetId)
    asset.modelBounds = { min: [-0.24999999, 0, -0.22499999], max: [0.24999999, 0.89999998, 0.22499999] }
    scene.objects.find((entry: { id: string }) => entry.id === first.body.placed[0].objectId).locked = true
    await new CanvasDocumentStore(cwd, film).write(film, { ...document, nodes: [{ id: 'desk', type: 'director', title: '导演台', metadata: { directorProject: scene } }] })

    const again = await apply([{ type: 'place_model', path: 'film/canvas/models/chair.glb', at: [3, 0] }])
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.placed[0].assetId).toBe(asset.id)
    expect(again.body.applied.map((entry: { type: string }) => entry.type)).toEqual(['import_asset', 'place_asset'])
    expect((await savedProject()).assets.find((entry: { id: string }) => entry.id === asset.id).modelBounds).toEqual(asset.modelBounds)
  })

  it('numbers applied ops and refusals by the agent\'s own ops', async () => {
    await file('props/chair.glb', boxGlb([0.5, 0.9, 0.45]))
    const placed = await apply([
      { type: 'place_prop', id: 'box', at: [0, 3], size: [1, 1, 1] },
      { type: 'place_model', path: 'props/chair.glb' },
      { type: 'set_active_camera', cameraId: 'cam' },
    ])
    expect(placed.status, JSON.stringify(placed.body)).toBe(200)
    expect(placed.body.applied.map((entry: { op: number; type: string }) => [entry.op, entry.type])).toEqual([
      [0, 'place_prop'], [1, 'import_asset'], [1, 'calibrate_asset'], [1, 'place_asset'], [2, 'set_active_camera'],
    ])
    // A refusal in a staged op, after a placement that expands into several: the agent's number.
    const refused = await stage([{ type: 'place_model', path: 'props/chair.glb' }, { type: 'set_active_camera', cameraId: 'nope' }], { dryRun: true })
    expect(refused).toMatchObject({ status: 400, body: { code: 'DIRECTOR_STAGE_INVALID', op: 1 } })
    expect(refused.body.error).toMatch(/^第 2 步:/u)
    // And in a placement after an op of the agent's own.
    expect(await stage([{ type: 'set_active_camera', cameraId: 'cam' }, { type: 'place_model', path: 'props/none.glb' }], { dryRun: true })).toMatchObject({ status: 400, body: { op: 1 } })
  })

  it('needs the fingerprint to apply, and refuses characters and .gltf files', async () => {
    await file('props/chair.glb', boxGlb([0.5, 0.9, 0.45]))
    await file('props/lamp.gltf', JSON.stringify({ asset: { version: '2.0' } }))
    expect((await stage([{ type: 'place_model', path: 'props/chair.glb' }])).body.error).toMatch(/expectedFingerprint/u)
    expect(await modelsCopied()).toEqual([])
    expect(await stage([{ type: 'place_model', path: 'props/chair.glb', kind: 'character' }], { dryRun: true })).toMatchObject({ status: 400, body: { code: 'DIRECTOR_STAGE_INVALID', op: 0, error: expect.stringContaining('空间库') } })
    expect(await stage([{ type: 'place_model', path: 'props/lamp.gltf' }], { dryRun: true })).toMatchObject({ status: 400, body: { op: 0, error: expect.stringContaining('GLB') } })
    expect(await stage([{ type: 'place_model', path: 'props/chair.glb', metresPerUnit: 1, size: { height: 1 } }], { dryRun: true })).toMatchObject({ status: 400, body: { op: 0 } })
    expect(await stage(Array.from({ length: 41 }, () => ({ type: 'place_model', path: 'props/chair.glb' })), { dryRun: true })).toMatchObject({ status: 400, body: { error: expect.stringContaining('40') } })
  })
})
