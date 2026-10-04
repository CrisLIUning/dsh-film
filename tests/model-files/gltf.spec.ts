/** The Host's glTF box: the same numbers three's GLTFLoader and Box3.setFromObject give the desk. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelTooLargeError, readGlbFacts, readGltfFacts } from '../../src/model-files/gltf.js'
import { ModelReadError } from '../../src/model-files/types.js'
import type { ModelBox } from '../../src/model-files/types.js'
import { compileSpacePlan } from '../../src/space-plan/compile.js'
import { spacePlanToGlb } from '../../src/space-plan/glb.js'
import { Gltf, aboutY, glb, translation } from './fixtures.js'

let dir: string
const LIMIT = { maxJsonBytes: 16 * 1024 * 1024 }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-film-gltf-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function measure(bytes: Buffer, options = LIMIT) {
  const path = join(dir, 'model.glb')
  await writeFile(path, bytes)
  return readGlbFacts(path, options)
}

function expectBox(actual: ModelBox | undefined, min: number[], max: number[]): void {
  expect(actual).toBeDefined()
  for (let axis = 0; axis < 3; axis++) {
    expect(actual!.min[axis]).toBeCloseTo(min[axis]!, 5)
    expect(actual!.max[axis]).toBeCloseTo(max[axis]!, 5)
  }
}

const unitCube = (gltf: Gltf): number => gltf.mesh({ attributes: { POSITION: gltf.box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]) } })

describe('readGlbFacts', () => {
  it('applies a node\'s translation, rotation and scale', async () => {
    const gltf = new Gltf()
    const mesh = unitCube(gltf)
    gltf.scene(gltf.node({ mesh, translation: [1, 2, 3], rotation: aboutY(90), scale: [2, 1, 1] }))
    const facts = await measure(gltf.glb())
    // Scaled to 2 wide in X, then turned so that width lies along Z.
    expectBox(facts.bounds, [0.5, 1.5, 2], [1.5, 2.5, 4])
    expect(facts).toMatchObject({ hasSkin: false, compression: [], approximate: false, problems: [] })
  })

  it('applies a node\'s matrix', async () => {
    const gltf = new Gltf()
    const mesh = unitCube(gltf)
    const matrix = translation(5, 0, 0)
    matrix[0] = 3; matrix[5] = 3; matrix[10] = 3
    gltf.scene(gltf.node({ mesh, matrix }))
    expectBox((await measure(gltf.glb())).bounds, [3.5, -1.5, -1.5], [6.5, 1.5, 1.5])
  })

  it('walks nested parents, such as a 0.01 root scale from a centimetre export', async () => {
    const gltf = new Gltf()
    const mesh = gltf.mesh({ attributes: { POSITION: gltf.box([-50, 0, -25], [50, 180, 25]) } })
    const leaf = gltf.node({ mesh })
    const middle = gltf.node({ translation: [100, 0, 0], children: [leaf] })
    gltf.scene(gltf.node({ scale: [0.01, 0.01, 0.01], children: [middle] }))
    expectBox((await measure(gltf.glb())).bounds, [0.5, 0, -0.25], [1.5, 1.8, 0.25])
  })

  it('unites several primitives and meshes', async () => {
    const gltf = new Gltf()
    const twoParts = gltf.mesh(
      { attributes: { POSITION: gltf.box([0, 0, 0], [1, 1, 1]) } },
      { attributes: { POSITION: gltf.box([-2, 0, 0], [-1, 3, 1]) } },
    )
    const other = gltf.mesh({ attributes: { POSITION: gltf.box([0, 0, 0], [1, 1, 1]) } })
    gltf.scene(gltf.node({ mesh: twoParts }), gltf.node({ mesh: other, translation: [0, 0, 5] }))
    expectBox((await measure(gltf.glb())).bounds, [-2, 0, 0], [1, 3, 6])
  })

  it('scales normalized (quantized) int16 positions, with the node scale that undoes the quantization', async () => {
    const gltf = new Gltf()
    const position = gltf.json.accessors.push({ bufferView: gltf.view(Buffer.alloc(48)), componentType: 5122, normalized: true, count: 8, type: 'VEC3', min: [-32767, 0, -32767], max: [32767, 32767, 32767] }) - 1
    const mesh = gltf.mesh({ attributes: { POSITION: position } })
    gltf.scene(gltf.node({ mesh, scale: [0.5, 2, 0.5] }))
    expectBox((await measure(gltf.glb())).bounds, [-0.5, 0, -0.5], [0.5, 2, 0.5])
  })

  it('expands by the largest morph target displacement per axis', async () => {
    const gltf = new Gltf()
    const mesh = gltf.mesh({
      attributes: { POSITION: gltf.box([-1, -1, -1], [1, 1, 1]) },
      targets: [{ POSITION: gltf.bare([-0.5, 0, 0], [0.2, 0.3, 0]) }, { POSITION: gltf.bare([0, 0, -0.1], [0, 0, 0.4]) }],
    })
    gltf.scene(gltf.node({ mesh }))
    expectBox((await measure(gltf.glb())).bounds, [-1.5, -1.3, -1.4], [1.5, 1.3, 1.4])
  })

  it('measures a Draco primitive from its min/max, without a decoder', async () => {
    const gltf = new Gltf()
    gltf.json.extensionsUsed = ['KHR_draco_mesh_compression', 'KHR_texture_basisu']
    gltf.json.extensionsRequired = ['KHR_draco_mesh_compression']
    const mesh = gltf.mesh({ attributes: { POSITION: gltf.bare([-0.25, 0, -0.2], [0.25, 0.9, 0.2]) }, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } } })
    gltf.scene(gltf.node({ mesh }))
    const facts = await measure(gltf.glb())
    expectBox(facts.bounds, [-0.25, 0, -0.2], [0.25, 0.9, 0.2])
    expect(facts.compression).toEqual(['draco', 'ktx2'])
    expect(facts.approximate).toBe(false)
  })

  it('scans float positions whose accessor lacks min/max', async () => {
    const gltf = new Gltf()
    const mesh = gltf.mesh({ attributes: { POSITION: gltf.box([-1, 0, -2], [3, 4, 2], { minMax: false }) } })
    gltf.scene(gltf.node({ mesh }))
    const facts = await measure(gltf.glb())
    expectBox(facts.bounds, [-1, 0, -2], [3, 4, 2])
    expect(facts.approximate).toBe(false)
  })

  it('scans interleaved positions without min/max across many reads, and defers a scan over its limit when asked', async () => {
    // 100 000 vertices, 24 bytes apart (position + normal): 2.4 MB, more than one scan chunk.
    const count = 100_000
    const data = Buffer.alloc(count * 24)
    for (let at = 0; at < count; at++) {
      data.writeFloatLE(at === 77_777 ? -3 : (at % 10) / 10, at * 24)
      data.writeFloatLE(at === count - 1 ? 9 : 1, at * 24 + 4)
      data.writeFloatLE(at === 12_345 ? 4 : 0, at * 24 + 8)
      data.writeFloatLE(100, at * 24 + 12) // the normal, never part of the box
    }
    const gltf = new Gltf()
    const position = gltf.json.accessors.push({ bufferView: gltf.view(data, 24), componentType: 5126, count, type: 'VEC3' }) - 1
    gltf.scene(gltf.node({ mesh: gltf.mesh({ attributes: { POSITION: position } }) }))
    const bytes = gltf.glb()
    const facts = await measure(bytes)
    expectBox(facts.bounds, [-3, 1, 0], [0.9, 9, 4])
    expect(facts.approximate).toBe(false)
    // Over the scan limit: left out of an approximate box, or (a listing) deferred.
    const small = { ...LIMIT, maxScanBytes: 1024 }
    expect(await measure(bytes, small)).toMatchObject({ approximate: true })
    await expect(measure(bytes, { ...small, deferLargeScans: true })).rejects.toBeInstanceOf(ModelTooLargeError)
  })

  it('marks the box approximate when compressed positions have no min/max', async () => {
    const gltf = new Gltf()
    gltf.json.extensionsUsed = ['EXT_meshopt_compression']
    const plain = gltf.mesh({ attributes: { POSITION: gltf.box([0, 0, 0], [1, 1, 1]) } })
    const compressed = gltf.mesh({ attributes: { POSITION: gltf.json.accessors.push({ componentType: 5126, count: 8, type: 'VEC3' }) - 1 } })
    gltf.scene(gltf.node({ mesh: plain }), gltf.node({ mesh: compressed }))
    const facts = await measure(gltf.glb())
    expectBox(facts.bounds, [0, 0, 0], [1, 1, 1])
    expect(facts.approximate).toBe(true)
    expect(facts.compression).toEqual(['meshopt'])
    expect(facts.problems.join()).toMatch(/min\/max/u)
  })

  it('puts a skinned mesh through world(joint)·inverseBind', async () => {
    const gltf = new Gltf()
    const mesh = unitCube(gltf)
    const joint = gltf.node({ translation: [0, 2, 0] })
    // Bound with the joint at y=1, now posed at y=2: the vertices follow it up by 1.
    const ibm = gltf.floats(translation(0, -1, 0), 'MAT4')
    gltf.json.skins = [{ joints: [joint], inverseBindMatrices: ibm }]
    gltf.scene(gltf.node({ mesh, skin: 0 }), joint)
    const facts = await measure(gltf.glb())
    expectBox(facts.bounds, [-0.5, 0.5, -0.5], [0.5, 1.5, 0.5])
    expect(facts).toMatchObject({ hasSkin: true, approximate: false })

    // Joints that disagree, or a mesh node that moves, make it a rough box.
    const posed = new Gltf()
    const posedMesh = unitCube(posed)
    const a = posed.node({ translation: [0, 0, 0] })
    const b = posed.node({ translation: [3, 0, 0] })
    posed.json.skins = [{ joints: [a, b] }]
    posed.scene(posed.node({ mesh: posedMesh, skin: 0 }), a, b)
    const rough = await measure(posed.glb())
    expectBox(rough.bounds, [-0.5, -0.5, -0.5], [3.5, 0.5, 0.5])
    expect(rough.approximate).toBe(true)
  })

  it('places every instance of EXT_mesh_gpu_instancing', async () => {
    const gltf = new Gltf()
    const mesh = unitCube(gltf)
    const offsets = gltf.floats([0, 0, 0, 10, 0, 0], 'VEC3')
    gltf.scene(gltf.node({ mesh, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: offsets } } } }))
    const facts = await measure(gltf.glb())
    expectBox(facts.bounds, [-0.5, -0.5, -0.5], [10.5, 0.5, 0.5])
    expect(facts.approximate).toBe(false)
  })

  it('uses the nodes nobody lists as a child when there are no scenes', async () => {
    const gltf = new Gltf()
    const mesh = unitCube(gltf)
    const child = gltf.node({ mesh, translation: [0, 1, 0] })
    gltf.node({ translation: [2, 0, 0], children: [child] })
    expectBox((await measure(gltf.glb())).bounds, [1.5, 0.5, -0.5], [2.5, 1.5, 0.5])
  })

  it('refuses a file that is not a GLB, or is cut short', async () => {
    await expect(measure(Buffer.from('not a model at all, just text'))).rejects.toBeInstanceOf(ModelReadError)
    const whole = new Gltf()
    whole.scene(whole.node({ mesh: unitCube(whole) }))
    const bytes = whole.glb()
    await expect(measure(bytes.subarray(0, 30))).rejects.toThrow(/不完整/u)
    await expect(measure(bytes.subarray(0, 10))).rejects.toThrow(/不完整/u)
  })

  it('refuses a JSON chunk over the limit as too large, not as broken', async () => {
    const gltf = new Gltf()
    gltf.scene(gltf.node({ mesh: unitCube(gltf) }))
    gltf.json.extras = { padding: 'x'.repeat(4096) }
    await expect(measure(gltf.glb(), { maxJsonBytes: 1024 })).rejects.toBeInstanceOf(ModelTooLargeError)
  })

  it('reads a .gltf from its JSON alone', async () => {
    const gltf = new Gltf()
    gltf.scene(gltf.node({ mesh: gltf.mesh({ attributes: { POSITION: gltf.bare([0, 0, 0], [2, 1, 1]) } }), translation: [1, 0, 0] }))
    gltf.json.buffers = [{ uri: 'model.bin', byteLength: 0 }]
    const path = join(dir, 'model.gltf')
    await writeFile(path, JSON.stringify(gltf.json))
    expectBox((await readGltfFacts(path, LIMIT)).bounds, [1, 0, 0], [3, 1, 1])
  })

  it('gives a compiled space\'s GLB the plan\'s own footprint and height', async () => {
    const compiled = compileSpacePlan({
      name: '测试楼',
      footprint: { width: 12000, depth: 8000 },
      levels: [{ id: 'f1', name: '一层', elevation: 0, height: 3000 }, { id: 'f2', name: '二层', elevation: 3000, height: 3000 }],
      stairs: [{ id: 's1', from: 'f1', to: 'f2', at: [-2380, 0], width: 1200, direction: 'east' }],
    })
    const facts = await measure(spacePlanToGlb(compiled, '测试楼'))
    expectBox(facts.bounds, compiled.bounds.min, compiled.bounds.max)
    // The walls stand on the 12 m × 8 m footprint (the roof's eaves reach past it) and the two 3 m storeys stand on y=0.
    expect(facts.bounds!.max[0] - facts.bounds!.min[0]).toBeGreaterThanOrEqual(12)
    expect(facts.bounds!.max[2] - facts.bounds!.min[2]).toBeGreaterThanOrEqual(8)
    expect(facts.bounds!.min[1]).toBeCloseTo(compiled.bounds.min[1], 5)
    expect(facts.bounds!.max[1]).toBeGreaterThanOrEqual(6)
  })
})

describe('glb()', () => {
  it('builds the files the tests read', () => {
    const bytes = glb({ asset: { version: '2.0' } })
    expect(bytes.readUInt32LE(0)).toBe(0x46546c67)
    expect(bytes.readUInt32LE(8)).toBe(bytes.length)
  })
})
