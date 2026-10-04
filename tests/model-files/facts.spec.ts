/** The facts a listing and a placement report about one model file (C6). */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearModelFactsCache, listingBudget, mapConcurrent, modelFacts, modelFactsCacheSize } from '../../src/model-files/facts.js'
import { Gltf, binaryFbx } from './fixtures.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-facts-'))
  clearModelFactsCache()
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function file(relative: string, content: string | Buffer): Promise<string> {
  const path = join(cwd, ...relative.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  return path
}

/** A GLB of one box, optionally skinned. */
function boxGlb(min: number[], max: number[], options: { skin?: boolean } = {}): Buffer {
  const gltf = new Gltf()
  const mesh = gltf.mesh({ attributes: { POSITION: gltf.box(min, max) } })
  const node = gltf.node({ mesh, ...(options.skin === true ? { skin: 0 } : {}) })
  if (options.skin === true) gltf.json.skins = [{ joints: [node] }]
  return gltf.scene(node).glb()
}

describe('modelFacts', () => {
  it('reports a GLB under film/spaces/ as a space to place as a scene, in metres', async () => {
    const path = await file('film/spaces/hall.glb', boxGlb([-6, 0, -4], [6, 3, 4]))
    expect(await modelFacts(path, 'film/spaces/hall.glb')).toEqual({
      format: 'glb', role: 'space', placeable: true, suggestedKind: 'scene',
      bounds: { min: [-6, 0, -4], max: [6, 3, 4] }, metresPerUnit: 1, sizeMetres: [12, 3, 8],
    })
  })

  it('suggests a kind: auto for a skin, scene from 6 m across, else prop', async () => {
    const rigged = await file('people/hero.glb', boxGlb([-0.3, 0, -0.2], [0.3, 1.8, 0.2], { skin: true }))
    expect(await modelFacts(rigged, 'people/hero.glb')).toMatchObject({ role: 'model', suggestedKind: 'auto', hasSkin: true })
    const wide = await file('sets/street.glb', boxGlb([0, 0, 0], [2, 3, 6]))
    expect(await modelFacts(wide, 'sets/street.glb')).toMatchObject({ suggestedKind: 'scene', sizeMetres: [2, 3, 6] })
    const chair = await file('props/chair.glb', boxGlb([-0.25, 0, -0.225], [0.25, 0.9, 0.225]))
    const facts = await modelFacts(chair, 'props/chair.glb')
    expect(facts).toMatchObject({ suggestedKind: 'prop', placeable: true, metresPerUnit: 1 })
    expect(facts.sizeMetres![0]).toBeCloseTo(0.5)
    expect(facts.sizeMetres![1]).toBeCloseTo(0.9)
    expect(facts.sizeMetres![2]).toBeCloseTo(0.45)
  })

  it('never offers a .gltf for import, and says why', async () => {
    const gltf = new Gltf()
    gltf.scene(gltf.node({ mesh: gltf.mesh({ attributes: { POSITION: gltf.bare([0, 0, 0], [1, 1, 1]) } }) }))
    const path = await file('props/lamp.gltf', JSON.stringify(gltf.json))
    expect(await modelFacts(path, 'props/lamp.gltf')).toMatchObject({ format: 'gltf', placeable: false, bounds: { min: [0, 0, 0], max: [1, 1, 1] }, problem: expect.stringContaining('GLB') })
  })

  it('gives a size in metres only when the units are known', async () => {
    const obj = await file('props/cup.obj', 'v -0.05 0 -0.05\nv 0.05 0.12 0.05\n')
    const objFacts = await modelFacts(obj, 'props/cup.obj')
    expect(objFacts).toEqual({ format: 'obj', role: 'model', placeable: true, suggestedKind: 'prop', bounds: { min: [-0.05, 0, -0.05], max: [0.05, 0.12, 0.05] }, suggestedMetresPerUnit: 1 })
    const centimetres = await file('props/table.fbx', binaryFbx(7400, 1))
    expect(await modelFacts(centimetres, 'props/table.fbx')).toEqual({ format: 'fbx', role: 'model', placeable: true, suggestedKind: 'auto', metresPerUnit: 0.01 })
    const unknown = await file('props/stool.fbx', binaryFbx(7400))
    expect((await modelFacts(unknown, 'props/stool.fbx')).metresPerUnit).toBeUndefined()
  })

  it('reports an unreadable file as not placeable', async () => {
    const broken = await file('props/broken.glb', 'this is no GLB')
    expect(await modelFacts(broken, 'props/broken.glb')).toMatchObject({ placeable: false, problem: expect.any(String) })
    const empty = await file('props/empty.obj', '')
    expect(await modelFacts(empty, 'props/empty.obj')).toMatchObject({ placeable: false, problem: expect.stringContaining('没有顶点') })
  })

  it('remembers a measurement until the file\'s size or time changes', async () => {
    const path = await file('props/box.glb', boxGlb([0, 0, 0], [1, 1, 1]))
    const time = new Date('2026-10-01T00:00:00Z')
    await utimes(path, time, time)
    expect((await modelFacts(path, 'props/box.glb')).sizeMetres).toEqual([1, 1, 1])
    expect(modelFactsCacheSize()).toBe(1)
    // Same size and time: the remembered answer, even though the bytes differ.
    await writeFile(path, boxGlb([0, 0, 0], [2, 1, 1]))
    await utimes(path, time, time)
    expect((await modelFacts(path, 'props/box.glb')).sizeMetres).toEqual([1, 1, 1])
    const later = new Date('2026-10-02T00:00:00Z')
    await utimes(path, later, later)
    expect((await modelFacts(path, 'props/box.glb')).sizeMetres).toEqual([2, 1, 1])
  })

  it('leaves files a listing has no time or room for pending, and measures them in full later', async () => {
    const path = await file('props/box.glb', boxGlb([0, 0, 0], [1, 1, 1]))
    const spent = listingBudget(-1)
    expect(await modelFacts(path, 'props/box.glb', { listing: spent })).toEqual({ format: 'glb', role: 'model', placeable: true, suggestedKind: 'prop', metresPerUnit: 1, pending: true })
    expect(modelFactsCacheSize()).toBe(0)
    expect((await modelFacts(path, 'props/box.glb')).sizeMetres).toEqual([1, 1, 1])
    // Once measured, a listing answers it even with its budget spent.
    expect(await modelFacts(path, 'props/box.glb', { listing: spent })).toMatchObject({ sizeMetres: [1, 1, 1] })
    expect((await modelFacts(path, 'props/box.glb', { listing: spent })).pending).toBeUndefined()

    // An OBJ over the listing's 8 MiB is measured only in full.
    const big = await file('props/big.obj', `v 0 0 0\nv 1 2 3\n${'# padding line for a large OBJ file\n'.repeat(260_000)}`)
    expect(await modelFacts(big, 'props/big.obj', { listing: listingBudget() })).toMatchObject({ pending: true })
    expect(await modelFacts(big, 'props/big.obj')).toMatchObject({ bounds: { min: [0, 0, 0], max: [1, 2, 3] } })
  })
})

describe('mapConcurrent', () => {
  it('runs at most the limit at once and keeps the order', async () => {
    let running = 0
    let most = 0
    const results = await mapConcurrent([5, 1, 4, 2, 3, 6], 4, async (value) => {
      running++
      most = Math.max(most, running)
      await new Promise(resolve => setTimeout(resolve, value))
      running--
      return value * 10
    })
    expect(results).toEqual([50, 10, 40, 20, 30, 60])
    expect(most).toBe(4)
  })
})
