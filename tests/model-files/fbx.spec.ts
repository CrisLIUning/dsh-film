/** The unit an FBX declares, binary or ASCII. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFbxUnit } from '../../src/model-files/fbx.js'
import { binaryFbx } from './fixtures.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-film-fbx-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function file(name: string, content: string | Buffer): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

describe('readFbxUnit', () => {
  it('reads UnitScaleFactor from a binary FBX with 32-bit (7400) and 64-bit (7500) records', async () => {
    expect(await readFbxUnit(await file('cm.fbx', binaryFbx(7400, 1)))).toBe(1)
    expect(await readFbxUnit(await file('m.fbx', binaryFbx(7400, 100)))).toBe(100)
    expect(await readFbxUnit(await file('cm-7500.fbx', binaryFbx(7500, 1)))).toBe(1)
    expect(await readFbxUnit(await file('m-7700.fbx', binaryFbx(7700, 100)))).toBe(100)
  })

  it('reads an ASCII FBX\'s P line', async () => {
    const ascii = [
      '; FBX 7.4.0 project file',
      'GlobalSettings:  {',
      '\tVersion: 1000',
      '\tProperties70:  {',
      '\t\tP: "UpAxis", "int", "Integer", "",1',
      '\t\tP: "UnitScaleFactor", "double", "Number", "",2.54',
      '\t}',
      '}',
    ].join('\n')
    expect(await readFbxUnit(await file('inch.fbx', ascii))).toBe(2.54)
  })

  it('answers undefined when the unit is absent or the file is not an FBX', async () => {
    expect(await readFbxUnit(await file('none.fbx', binaryFbx(7400)))).toBeUndefined()
    expect(await readFbxUnit(await file('garbage.fbx', Buffer.from('Kaydara FBX Binary  \0\x1a\0\xff\xff\xff\xff garbage', 'latin1')))).toBeUndefined()
    expect(await readFbxUnit(await file('text.fbx', 'hello'))).toBeUndefined()
    expect(await readFbxUnit(await file('zero.fbx', binaryFbx(7400, 0)))).toBeUndefined()
  })
})
