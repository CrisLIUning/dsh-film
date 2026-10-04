/**
 * The space plan compiler, its access checks and its GLB writer: Studio's
 * apps/daemon/tests/space-plan.test.ts and space-plan-access.test.ts, ported,
 * plus a structural read of the GLB the way a glTF loader walks it.
 */

import { describe, expect, it } from 'vitest'
import { compileSpacePlan, validateSpacePlan } from '../src/space-plan/compile.js'
import type { SpacePlan } from '../src/space-plan/compile.js'
import { spacePlanToGlb } from '../src/space-plan/glb.js'
import { planRectsOverlap, subtractPlanRects } from '../src/space-plan/access.js'
import { SpacePlanInputError } from '../src/space-plan/input.js'

function plan(overrides: Partial<SpacePlan> = {}): SpacePlan {
  return {
    name: '测试楼',
    footprint: { width: 12000, depth: 8000 },
    levels: [
      { id: 'f1', name: '一层', elevation: 0, height: 3000 },
      { id: 'f2', name: '二层', elevation: 3000, height: 3000 },
    ],
    stairs: [{ id: 's1', from: 'f1', to: 'f2', at: [-2380, 0], width: 1200, direction: 'east' }],
    ...overrides,
  }
}

/** The JSON chunk of a GLB. */
function glbJson(glb: Buffer): any {
  return JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'))
}

describe('平面要先和自己对上账', () => {
  it('抓出层与层之间的空隙', () => {
    const warnings = validateSpacePlan(plan({
      levels: [
        { id: 'f1', name: '一层', elevation: 0, height: 3000 },
        { id: 'f2', name: '二层', elevation: 5600, height: 3000 },
      ],
    }))
    expect(warnings.some(w => w.includes('层高不连续'))).toBe(true)
  })

  it('抓出开间分段和外轮廓对不上', () => {
    expect(validateSpacePlan(plan({ interior: { spineX: [-6000, 0, 7400] } })).some(w => w.includes('开间分段跨度'))).toBe(true)
  })

  it('抓出没有楼梯可达的层', () => {
    expect(validateSpacePlan(plan({ stairs: [] })).some(w => w.includes('没有楼梯可达'))).toBe(true)
  })

  it('抓出指向不存在楼层的翼', () => {
    expect(validateSpacePlan(plan({ wings: [{ id: 'w', rect: [0, 0, 1000, 1000], levels: ['f9'] }] })).some(w => w.includes('不存在的层'))).toBe(true)
  })

  it('抓出顶层穿出塔身', () => {
    expect(validateSpacePlan(plan({ towers: [{ id: 't', at: [0, 0], diameter: 3000, top: 4000 }] })).some(w => w.includes('高于塔身'))).toBe(true)
  })

  it('一份自洽的平面没有话说', () => {
    expect(validateSpacePlan(plan())).toEqual([])
  })
})

describe('凭空写的平面还得站得住', () => {
  it('抓出人站不直的层高', () => {
    const warnings = validateSpacePlan(plan({ levels: [{ id: 'f1', name: '一层', elevation: 0, height: 900 }], stairs: [] }))
    expect(warnings.some(w => w.includes('层高') && w.includes('超出常见范围'))).toBe(true)
  })

  it('不去为难一个真有二十米的中厅', () => {
    expect(validateSpacePlan(plan({ levels: [{ id: 'f1', name: '中厅', elevation: 0, height: 20000 }], stairs: [] }))).toEqual([])
  })

  it('抓出门比楼层还高', () => {
    const warnings = validateSpacePlan(plan({ defaults: { doorHeight: 3200 }, levels: [{ id: 'f1', name: '一层', elevation: 0, height: 3000 }], stairs: [] }))
    expect(warnings.some(w => w.includes('门高') && w.includes('不低于'))).toBe(true)
  })

  it('抓出窗顶顶穿楼板', () => {
    const warnings = validateSpacePlan(plan({ defaults: { windowSill: 900, windowHeight: 2600 }, levels: [{ id: 'f1', name: '一层', elevation: 0, height: 3000 }], stairs: [] }))
    expect(warnings.some(w => w.includes('窗顶'))).toBe(true)
  })

  it('抓出比墙还窄的开间', () => {
    const warnings = validateSpacePlan(plan({ footprint: { width: 12000, depth: 8000 }, interior: { spineX: [-6000, -5900, 6000] } }))
    expect(warnings.some(w => w.includes('开间') && w.includes('不大于内墙厚'))).toBe(true)
  })

  it('抓出爬不上去的踏步', () => {
    const warnings = validateSpacePlan(plan({ stairs: [{ id: 's1', from: 'f1', to: 'f2', at: [0, 0], width: 1200, direction: 'north', run: 80 }] }))
    expect(warnings.some(w => w.includes('踏面'))).toBe(true)
  })

  it('抓出小数点错位的外轮廓', () => {
    expect(validateSpacePlan(plan({ footprint: { width: 1200000, depth: 8000 } })).some(w => w.includes('外轮廓宽度'))).toBe(true)
  })
})

describe('编译出来的是导演台能用的东西', () => {
  it('每层一个命名组,好让一个镜头能点名某一层', () => {
    const groups = new Set(compileSpacePlan(plan()).parts.map(part => part.group))
    expect(groups.has('f1-一层')).toBe(true)
    expect(groups.has('f2-二层')).toBe(true)
  })

  it('窗是真的洞,不是贴图', () => {
    const compiled = compileSpacePlan(plan({ openings: { exteriorWindowPitch: 3000 } }))
    expect(compiled.counts.openings).toBeGreaterThan(0)
    expect(compiled.parts.some(part => part.name.includes('-sill'))).toBe(true)
    expect(compiled.parts.some(part => part.name.includes('-lintel'))).toBe(true)
  })

  it('不给间距就不开窗', () => {
    const compiled = compileSpacePlan(plan({ openings: { exteriorWindowPitch: 0 } }))
    expect(compiled.parts.some(p => p.name.includes('-sill') || p.name.includes('-lintel'))).toBe(false)
    expect(compiled.counts.openings).toBe(1) // the stairwell remains a real opening
  })

  it('楼梯正好落在上一层地面,不差半级', () => {
    const steps = compileSpacePlan(plan()).parts.filter(part => part.role === 'step')
    expect(steps.length).toBeGreaterThan(0)
    expect(Math.max(...steps.map(step => step.position[1] + step.size[1] / 2))).toBeCloseTo(3, 3)
  })

  it('地下层是负标高,和地面层同一个坐标系', () => {
    const compiled = compileSpacePlan(plan({
      levels: [
        { id: 'b1', name: '地下一层', elevation: -3000, height: 3000 },
        { id: 'f1', name: '一层', elevation: 0, height: 3000 },
      ],
      stairs: [{ id: 's', from: 'b1', to: 'f1', at: [0, 0], width: 1200, direction: 'east' }],
    }))
    expect(compiled.bounds.min[1]).toBeLessThan(-2.9)
  })

  it('中庭那几层不放隔墙', () => {
    const withHall = compileSpacePlan(plan({
      interior: { spineX: [-6000, 0, 6000], spineZ: [-4000, 4000], hall: { rect: [-6000, -4000, 6000, 4000], levels: ['f1'] } },
    }))
    const withoutHall = compileSpacePlan(plan({ interior: { spineX: [-6000, 0, 6000], spineZ: [-4000, 4000] } }))
    expect(withHall.counts.walls).toBeLessThan(withoutHall.counts.walls)
  })

  it('refuses a malformed nested dimension before building anything', () => {
    expect(() => compileSpacePlan(plan({ stairs: [{ id: 's1', from: 'f1', to: 'f2', at: [0, 'bad' as unknown as number], width: 1200, direction: 'east' }] })))
      .toThrow(SpacePlanInputError)
    expect(() => compileSpacePlan(plan({ entrance: { at: [0, 0], width: 2000, steps: 1.5, stepRise: 150, stepRun: 300 } }))).toThrow(/entrance\.steps/)
  })
})

describe('导出的 GLB', () => {
  it('carries structure provenance for each primitive without changing its dimensions', () => {
    const compiled = compileSpacePlan(plan())
    const json = glbJson(spacePlanToGlb(compiled, '测试楼')) as { nodes: Array<{ mesh?: number; name: string; extras?: unknown }> }
    const nodes = json.nodes.filter(n => n.mesh !== undefined)
    expect(nodes).toHaveLength(compiled.parts.length)
    for (const [index, part] of compiled.parts.entries()) {
      expect(nodes[index]).toMatchObject({ name: part.name, extras: { vibedevStructure: { version: 1, role: part.role, shape: part.kind, group: part.group } } })
    }
  })

  it('结构合法:头、分块长度、缓冲区都对得上', () => {
    const glb = spacePlanToGlb(compileSpacePlan(plan()), '测试楼')
    expect(glb.readUInt32LE(0)).toBe(0x46546c67)
    expect(glb.readUInt32LE(4)).toBe(2)
    expect(glb.readUInt32LE(8)).toBe(glb.length)
    let offset = 12
    const chunks: Array<{ type: number; length: number }> = []
    while (offset < glb.length) {
      const length = glb.readUInt32LE(offset)
      chunks.push({ length, type: glb.readUInt32LE(offset + 4) })
      offset += 8 + length
    }
    expect(chunks.map(chunk => chunk.type)).toEqual([0x4e4f534a, 0x004e4942])
    // Every chunk 4-byte aligned, or a reader walking them lands mid-field.
    for (const chunk of chunks) expect(chunk.length % 4).toBe(0)
    expect(offset).toBe(glb.length)
  })

  it('整栋楼共用三个原型网格,而不是每面墙一份几何', () => {
    const compiled = compileSpacePlan(plan({ openings: { exteriorWindowPitch: 1500 } }))
    const json = glbJson(spacePlanToGlb(compiled, '测试楼'))
    expect(json.accessors.length).toBe(9)
    expect(json.nodes.filter((node: { mesh?: number }) => node.mesh !== undefined).length).toBe(compiled.parts.length)
    expect(json.buffers[0].byteLength).toBeLessThan(16 * 1024)
  })

  it('缓冲区视图不越过二进制块的末尾', () => {
    const json = glbJson(spacePlanToGlb(compileSpacePlan(plan()), '测试楼'))
    for (const view of json.bufferViews) expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(json.buffers[0].byteLength)
  })

  it('墙和屋顶不共用材质', () => {
    const json = glbJson(spacePlanToGlb(compileSpacePlan(plan({ towers: [{ id: 't', at: [0, 0], diameter: 3000, top: 8000, roofHeight: 2000 }] })), '测试楼'))
    expect(json.materials.map((material: { name: string }) => material.name)).toEqual(['stone', 'floor', 'slate', 'step'])
    const roof = json.nodes.find((node: { name: string }) => node.name.endsWith('-roof'))
    expect(roof?.mesh).toBeDefined()
    expect(json.materials[json.meshes[roof.mesh].primitives[0].material].name).toBe('slate')
  })

  it('reads back as a loader would: valid JSON, a scene of group nodes, accessors matching their views and indices inside their vertex count', () => {
    const compiled = compileSpacePlan(plan({ towers: [{ id: 't', at: [0, 0], diameter: 3000, top: 8000, roofHeight: 2000 }], entrance: { at: [0, 4500], width: 2000, steps: 3, stepRise: 150, stepRun: 300 } }))
    const glb = spacePlanToGlb(compiled, '测试楼')
    const jsonLength = glb.readUInt32LE(12)
    // The JSON chunk is padded with spaces, never with zero bytes, so it still parses as JSON.
    expect(glb.subarray(20, 20 + jsonLength).toString('utf8')).toMatch(/^\{.*\}\s*$/s)
    const json = glbJson(glb)
    expect(json.asset).toEqual({ version: '2.0', generator: 'vibedev space-plan' })
    expect(json.scene).toBe(0)
    expect(json.scenes[0].name).toBe('测试楼')
    expect(json.scenes[0].extras.vibedevSpacePlan).toEqual({ version: 1, sourceChecks: compiled.access.issues })
    const binStart = 20 + jsonLength + 8
    const binLength = glb.readUInt32LE(20 + jsonLength)
    expect(binStart + binLength).toBe(glb.length)
    expect(json.buffers).toEqual([{ byteLength: binLength }])
    // The scene's roots are the level groups, and every part node is a child of exactly one.
    const groups = json.scenes[0].nodes as number[]
    expect(groups.map(index => json.nodes[index].name)).toEqual([...new Set(compiled.parts.map(part => part.group))])
    const children = groups.flatMap(index => json.nodes[index].children as number[])
    expect(new Set(children).size).toBe(compiled.parts.length)
    const size = { 5126: 4, 5123: 2 } as Record<number, number>
    const width = { VEC3: 3, SCALAR: 1 } as Record<string, number>
    for (const view of json.bufferViews) expect(view.byteOffset % 4).toBe(0)
    for (const accessor of json.accessors) {
      const view = json.bufferViews[accessor.bufferView]
      expect(accessor.count * size[accessor.componentType]! * width[accessor.type]!).toBe(view.byteLength)
    }
    for (const mesh of json.meshes) {
      const primitive = mesh.primitives[0]
      const vertices = json.accessors[primitive.attributes.POSITION].count
      expect(json.accessors[primitive.attributes.NORMAL].count).toBe(vertices)
      const indexAccessor = json.accessors[primitive.indices]
      const view = json.bufferViews[indexAccessor.bufferView]
      const indices = new Uint16Array(glb.buffer.slice(glb.byteOffset + binStart + view.byteOffset, glb.byteOffset + binStart + view.byteOffset + view.byteLength))
      expect(Math.max(...indices)).toBeLessThan(vertices)
      expect(indices.length % 3).toBe(0)
    }
    // A part node scales a unit mesh to its size and puts it at its centre.
    const first = json.nodes[children[0]!]
    expect(first.translation).toEqual(compiled.parts[0]!.position)
    expect(first.scale).toEqual(compiled.parts[0]!.size)
  })
})

describe('楼梯与平台可达性', () => {
  const accessPlan = (patch: Partial<SpacePlan> = {}): SpacePlan => ({
    name: '排演楼',
    footprint: { width: 12000, depth: 10000 },
    levels: [{ id: 'f1', name: '一层', elevation: 0, height: 3000 }, { id: 'f2', name: '二层', elevation: 3000, height: 3000 }],
    stairs: [{ id: 'main', from: 'f1', to: 'f2', at: [0, 2380], width: 1500, direction: 'north' }],
    ...patch,
  })
  const contains = (part: { position: number[]; size: number[] }, x: number, z: number) =>
    Math.abs(x - part.position[0]!) < part.size[0]! / 2 - 1e-8 && Math.abs(z - part.position[2]!) < part.size[2]! / 2 - 1e-8

  it('uses floor elevations as walking tops, and opens the actual upper mesh over the stair flight', () => {
    const floors = compileSpacePlan(accessPlan()).parts.filter(p => p.role === 'slab')
    expect(floors.filter(p => p.group === 'f1-一层').every(p => Math.abs(p.position[1] + p.size[1] / 2) < 1e-9)).toBe(true)
    const upper = floors.filter(p => p.group === 'f2-二层')
    expect(upper.every(p => Math.abs(p.position[1] + p.size[1] / 2 - 3) < 1e-9)).toBe(true)
    for (const z of [2, 0, -2]) expect(upper.some(p => contains(p, 0, z))).toBe(false)
    expect(upper.some(p => contains(p, 0, -3))).toBe(true)
    expect(upper.some(p => contains(p, 2, 0))).toBe(true)
  })

  it('warns when the authored stairs protrude outside the building instead of silently relocating them', () => {
    const p = accessPlan({ footprint: { width: 8000, depth: 6000 }, stairs: [{ id: 'outside', from: 'f1', to: 'f2', at: [0, 0], width: 1500, direction: 'north' }] })
    const before = structuredClone(p)
    expect(compileSpacePlan(p).warnings.join()).toMatch(/outside.*越出/)
    expect(p).toEqual(before)
  })

  it('detects a missing upper landing and a wall blocking the real landing envelope', () => {
    expect(compileSpacePlan(accessPlan({ stairs: [{ id: 'edge', from: 'f1', to: 'f2', at: [0, 0], width: 1500, direction: 'north' }] })).warnings.join()).toMatch(/edge.*平台/)
    expect(compileSpacePlan(accessPlan({ interior: { spineX: [-6000, 0, 6000], spineZ: [-5000, 5000] } })).warnings.join()).toMatch(/main.*墙/)
  })

  it('reports disjoint floor pairs as unreachable from the entry level', () => {
    const p = accessPlan({
      levels: [0, 1, 2, 3].map(i => ({ id: `f${i + 1}`, name: `${i + 1}层`, elevation: i * 3000, height: 3000 })),
      stairs: [{ id: 'a', from: 'f1', to: 'f2', at: [0, 2380], width: 1500, direction: 'north' }, { id: 'b', from: 'f3', to: 'f4', at: [0, 2380], width: 1500, direction: 'north' }],
    })
    expect(compileSpacePlan(p).access.issues.filter(i => i.code === 'floor-unreachable').map(i => i.levelId)).toEqual(['f3', 'f4'])
  })

  it.each(['north', 'south', 'east', 'west'] as const)('opens each crossed storey for %s stairs and preserves both landing regions', (direction) => {
    const x = direction === 'east' || direction === 'west'
    const sign = direction === 'north' || direction === 'west' ? -1 : 1
    const compiled = compileSpacePlan(accessPlan({
      footprint: { width: 20000, depth: 20000 },
      levels: [0, 1, 2].map(i => ({ id: `f${i + 1}`, name: `${i + 1}层`, elevation: i * 3000, height: 3000 })),
      stairs: [{ id: 'long', from: 'f1', to: 'f3', at: x ? [-sign * 4760, 0] : [0, -sign * 4760], width: 1500, direction }],
    }))
    for (const group of ['f2-2层', 'f3-3层']) {
      const floors = compiled.parts.filter(p => p.role === 'slab' && p.group === group)
      expect(floors.some(p => contains(p, 0, 0))).toBe(false)
      expect(floors.some(p => contains(p, x ? sign * 5.5 : 0, x ? 0 : sign * 5.5))).toBe(true)
    }
  })

  it('retains a valid staircase inspection in GLB metadata without claiming the model is universally traversable', () => {
    const compiled = compileSpacePlan(accessPlan())
    expect(compiled.access.issues).toEqual([])
    expect(compiled.access.stairs[0]).toMatchObject({ id: 'main', steps: 17, rise: 3000 / 17, start: [0, 0, 2380], end: [0, 3000, -2380], landingDepth: 1500, headroom: 2400 })
  })

  it('subtracts overlapping stair openings without overlapping or losing the remaining floor', () => {
    const base: [number, number, number, number] = [0, 0, 10, 10]
    const cuts: Array<[number, number, number, number]> = [[2, 2, 6, 6], [4, 4, 8, 8], [-2, 8, 2, 12]]
    const parts = subtractPlanRects(base, cuts)
    expect(parts.reduce((sum, p) => sum + (p[2] - p[0]) * (p[3] - p[1]), 0)).toBe(68)
    for (let i = 0; i < parts.length; i++) for (const other of parts.slice(i + 1)) expect(planRectsOverlap(parts[i]!, other)).toBe(false)
    for (const cut of cuts) expect(parts.some(p => planRectsOverlap(p, cut))).toBe(false)
  })

  it('detects another staircase in the flight clearance instead of ignoring every step mesh', () => {
    const compiled = compileSpacePlan(accessPlan({
      stairs: [{ id: 'a', from: 'f1', to: 'f2', at: [0, 2380], width: 1500, direction: 'north' }, { id: 'b', from: 'f1', to: 'f2', at: [-2380, 0], width: 1500, direction: 'east' }],
    }))
    expect(compiled.access.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'stair-clearance-blocked', stairId: 'a', partNames: expect.arrayContaining([expect.stringMatching(/^b-step-/)]) }),
    ]))
  })
})
