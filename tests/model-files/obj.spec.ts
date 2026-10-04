/** OBJ vertex boxes and the unit guess from their span. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readObjFacts, suggestObjMetresPerUnit } from '../../src/model-files/obj.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-film-obj-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function file(name: string, content: string | Buffer): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

describe('readObjFacts', () => {
  it('takes the box of the v lines, with w or colours after x y z, and ignores vt/vn/vp', async () => {
    const path = await file('chair.obj', [
      '# exported',
      'mtllib chair.mtl',
      'v -25 0 -20',
      'v 25 90 20 1.0',
      'v 0 45 0 0.5 0.5 0.5',
      'vt 900 900',
      'vn 0 1000 0',
      'vp 0.5 0.5 999',
      'f 1 2 3',
    ].join('\r\n'))
    expect(await readObjFacts(path)).toEqual({ bounds: { min: [-25, 0, -20], max: [25, 90, 20] }, vertices: 3 })
  })

  it('reports a file without vertices', async () => {
    expect(await readObjFacts(await file('empty.obj', ''))).toMatchObject({ vertices: 0, problem: expect.stringContaining('没有顶点') })
    expect((await readObjFacts(await file('normals.obj', 'vn 0 1 0\nvt 0 0\n'))).bounds).toBeUndefined()
  })

  it('suggests millimetres past 10000 units, centimetres past 100, else metres', () => {
    const across = (span: number) => suggestObjMetresPerUnit({ min: [0, 0, 0], max: [span, 1, 1] })
    expect(across(12000)).toBe(0.001)
    expect(across(10000)).toBe(0.01)
    expect(across(180)).toBe(0.01)
    expect(across(100)).toBe(1)
    expect(across(1.8)).toBe(1)
  })
})
