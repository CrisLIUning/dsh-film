/**
 * The canvas catalogues (C3) the agent's generation-option tools read from
 * the canvas build: read once per folder, checked against schema 1, and a
 * missing or broken file is a clear refusal. The fixtures are the canvas's
 * own files (tests/fixtures/catalog; the local apps/ is an older build
 * without catalog/, so no test reads it).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasCatalogError, PACKAGED_CATALOG_ROOT, checkCanvasCatalog, readCanvasCatalog } from '../src/canvas/catalog.js'
import type { CanvasCatalogName } from '../src/canvas/catalog.js'

const fixtures = join(import.meta.dirname, 'fixtures', 'catalog')
let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-film-catalog-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const fixture = async (name: CanvasCatalogName): Promise<any> => JSON.parse(await readFile(join(fixtures, `${name}.json`), 'utf8'))

/** The refusal a read ends with. */
const refusal = (name: CanvasCatalogName, root: string): Promise<CanvasCatalogError> =>
  readCanvasCatalog(name, root).then(() => { throw new Error(`${name} was read`) }, (error: unknown) => error as CanvasCatalogError)

describe('readCanvasCatalog', () => {
  it('reads the canvas build\'s catalogues once, checked', async () => {
    const moves = await readCanvasCatalog('camera-moves', fixtures)
    expect(moves).toMatchObject({ schema: 1, catalogVersion: '2026-10-05.1' })
    expect(moves.moves).toHaveLength(42)
    expect(moves.categories.map(category => category.id)).toEqual(['fixed', 'push', 'pull', 'pan', 'truck', 'follow', 'crane', 'orbit', 'handheld', 'zoom', 'aerial', 'special'])
    expect((await readCanvasCatalog('camera-control', fixtures)).defaults).toEqual({ look: 'digital-cinema', lens: 'spherical-prime', focalLength: 50, aperture: 2.8 })
    expect((await readCanvasCatalog('generation-presets', fixtures)).presets).toHaveLength(6)
    const skills = await readCanvasCatalog('vibedev-skills', fixtures)
    expect(skills).toMatchObject({ schema: 1, catalogVersion: '2026-10-05.1' })
    expect(skills.skills).toHaveLength(23)
    expect(skills.skills.filter(skill => skill.kind === 'append').map(skill => skill.id)).toEqual(['vd.style-lock', 'vd.lighting-mood', 'vd.identity-lock', 'vd.sound-bed'])
    // The same folder answers from what it read.
    expect(readCanvasCatalog('camera-moves', fixtures)).toBe(readCanvasCatalog('camera-moves', fixtures))
  })

  it('finds the packaged catalogues beside the canvas build (apps/canvas/catalog)', () => {
    expect(PACKAGED_CATALOG_ROOT.split(sep).join('/')).toMatch(/\/apps\/canvas\/catalog\/?$/u)
  })

  it('refuses a missing catalogue with CANVAS_CATALOG_MISSING, and reads it once it is there', async () => {
    const missing = await refusal('camera-moves', scratch)
    expect(missing).toBeInstanceOf(CanvasCatalogError)
    expect(missing.code).toBe('CANVAS_CATALOG_MISSING')
    expect(missing.message).toContain('apps/canvas/catalog/camera-moves.json')
    // A failed read is not remembered.
    await writeFile(join(scratch, 'camera-moves.json'), await readFile(join(fixtures, 'camera-moves.json')))
    expect((await readCanvasCatalog('camera-moves', scratch)).moves).toHaveLength(42)
  })

  it('refuses a catalogue that is not JSON or not schema 1 with CANVAS_CATALOG_INVALID', async () => {
    await mkdir(join(scratch, 'broken'))
    await writeFile(join(scratch, 'broken', 'camera-control.json'), '{"schema":1,')
    expect(await refusal('camera-control', join(scratch, 'broken'))).toMatchObject({ code: 'CANVAS_CATALOG_INVALID', message: expect.stringContaining('not valid JSON') })
    await mkdir(join(scratch, 'old'))
    await writeFile(join(scratch, 'old', 'camera-control.json'), JSON.stringify({ ...(await fixture('camera-control')), schema: 2 }))
    expect(await refusal('camera-control', join(scratch, 'old'))).toMatchObject({ code: 'CANVAS_CATALOG_INVALID', message: expect.stringContaining('schema must be 1') })
  })
})

describe('checkCanvasCatalog', () => {
  it('passes the canvas\'s files', async () => {
    for (const name of ['camera-moves', 'camera-control', 'generation-presets', 'vibedev-skills'] as const) expect(checkCanvasCatalog(name, await fixture(name)), name).toEqual([])
  })

  it('names what the skill tools could not use', async () => {
    const skills = await fixture('vibedev-skills')
    skills.skills[0].template = `${skills.skills[0].template}\n{{prompt}}`
    skills.skills[1].category = 'misc'
    skills.skills[2].variables.push({ key: 'prompt', label: { zh: '提示词', en: 'Prompt' } })
    skills.skills[3].template += '{{palette}}'
    skills.skills[4].composes.camera = 'keep'
    skills.skills[5].appliesTo = ['audio']
    skills.skills[8].videoModes = ['frames']
    skills.skills[10].template = `{{prompt}}${skills.skills[10].template}`
    skills.skills.push({ ...skills.skills[0], id: 'storyboard' })
    expect(checkCanvasCatalog('vibedev-skills', skills)).toEqual([
      'skills has an entry without a valid id (storyboard)',
      'skill vd.storyboard-frame is a wrap skill and needs exactly one {{prompt}}',
      'skill vd.character-sheet has an unknown category',
      'skill vd.scene-sheet has a variable without an unused ASCII key (prompt)',
      'skill vd.prop-sheet template uses {{palette}} without declaring it',
      'skill vd.turnaround composes.camera must be slot, append or drop',
      'skill vd.expression-sheet appliesTo must list image, video or text',
      'skill vd.first-last-bridge videoModes must list the canvas\'s video modes',
      'skill vd.style-lock is an append skill and must not hold {{prompt}}',
    ])
  })

  it('names what the tools could not use', async () => {
    const moves = await fixture('camera-moves')
    moves.moves[2].sentence.zh = '镜头向前推进'
    moves.moves[3].category = 'drone'
    moves.moves.push({ ...moves.moves[0] })
    expect(checkCanvasCatalog('camera-moves', moves)).toEqual([
      'moves static is repeated',
      'move push-in has {speed} in its sentence exactly when it is speedable',
      'move push-in-face has an unknown category',
    ])
    const camera = await fixture('camera-control')
    camera.shotSizes.pop()
    camera.defaults.focalLength = 40
    expect(checkCanvasCatalog('camera-control', camera)).toEqual([
      'shotSizes must be extreme-wide, wide, full, medium-full, medium, medium-close, close, extreme-close',
      'defaults.focalLength must be a listed focal length',
    ])
    const presets = await fixture('generation-presets')
    presets.presets[0].mode = 'audio'
    presets.presets[1].id = 'trailer'
    expect(checkCanvasCatalog('generation-presets', presets)).toEqual([
      'presets has an entry without a valid id (trailer)',
      'preset p.vertical-drama mode must be image or video',
    ])
    expect(checkCanvasCatalog('camera-moves', [])).toEqual(['the catalogue is not a JSON object'])
  })
})
