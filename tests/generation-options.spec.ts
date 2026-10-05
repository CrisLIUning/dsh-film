/**
 * Generation settings on storyboard nodes (spec C1/C11): the canvas's readers
 * ported with the catalogue passed in, the agent's values checked strictly,
 * the per-node plan of canvas_set_generation_options, presets, and the
 * estimate of the 4000-character rule (C2) the run tools refuse by.
 *
 * The catalogues are the canvas's own files (tests/fixtures/catalog, copied
 * from canvas feat/dsh-host 267893c web/src/lib/canvas/catalog/); the
 * expected lines follow the canvas's renderers (camera-moves.ts,
 * camera-direction.ts) on that text.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BoardNode, BoardSnapshot } from '../src/canvas/board-ops.js'
import type { CameraControlCatalog, CameraMoveCatalog, GenerationPresetCatalog } from '../src/canvas/catalog.js'
import {
  PROMPT_LIMIT_LENGTH, cameraControlRefusal, cameraMoveRefusal, checkCameraControlInput, checkCameraMoveInput, findPreset, mergeCameraControl, nearestStop,
  planGenerationOptions, presetSettings, promptLimitCheck, renderCameraDirection, renderCameraMove, sanitizeCameraControl, sanitizeCameraMove,
} from '../src/canvas/generation-options.js'
import type { CheckedGenerationOptions } from '../src/canvas/generation-options.js'

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'catalog', `${name}.json`), 'utf8')) as T
const moves = fixture<CameraMoveCatalog>('camera-moves')
const camera = fixture<CameraControlCatalog>('camera-control')
const presets = fixture<GenerationPresetCatalog>('generation-presets')
const catalogs = { moves, camera }

const node = (id: string, type: string, metadata: Record<string, unknown> = {}): BoardNode => ({ id, type, position: { x: 0, y: 0 }, width: 340, height: 240, metadata })
const board = (nodes: BoardNode[], connections: Array<[string, string]> = []): BoardSnapshot => ({
  nodes, connections: connections.map(([fromNodeId, toNodeId], index) => ({ id: `c${index}`, fromNodeId, toNodeId })),
})

const DEFAULT_CAMERA_ZH = '拍摄方式（只描述成像，不要在画面里出现相机或摄影器材）：大画幅数字电影机质感，宽容度高、肤色自然、高光过渡柔和；球面定焦镜头，成像锐利、畸变小；'
  + '50mm，标准焦距，透视自然；光圈 f/2.8，浅景深，主体突出。'
const PUSH_IN_ZH = '运镜：镜头平稳地向前推进，逐渐靠近主体。'

describe('the canvas readers, ported', () => {
  it('reads a camera move as the page does: unknown and repeated ids dropped, a locked-off move alone, three at most', () => {
    expect(sanitizeCameraMove({ v: 1, moves: [{ id: 'push-in', speed: 'slow' }, { id: 'nope' }, { id: 'push-in' }, { id: 'snap-push', speed: 'fast' }] }, moves))
      .toEqual({ v: 1, moves: [{ id: 'push-in', speed: 'slow' }, { id: 'snap-push' }], combine: 'sequence' })
    expect(sanitizeCameraMove({ moves: [{ id: 'push-in' }, { id: 'static' }], combine: 'together' }, moves)).toEqual({ v: 1, moves: [{ id: 'static' }], combine: 'together' })
    expect(sanitizeCameraMove({ moves: ['pan-left', 'pan-right', 'tilt-up', 'tilt-down'].map(id => ({ id })) }, moves)?.moves).toHaveLength(3)
    for (const cleared of [null, undefined, 'push-in', { v: 2, moves: [{ id: 'push-in' }] }, { moves: [{ id: 'nope' }] }]) expect(sanitizeCameraMove(cleared, moves)).toBeNull()
  })

  it('renders the motion line in the prompt\'s language, joined in sequence or together, with default speeds', () => {
    expect(renderCameraMove({ v: 1, moves: [{ id: 'push-in' }] }, moves, 'zh')).toBe(PUSH_IN_ZH)
    expect(renderCameraMove({ v: 1, moves: [{ id: 'push-in', speed: 'slow' }, { id: 'orbit-left' }] }, moves, 'zh'))
      .toBe('运镜：镜头缓慢地向前推进，逐渐靠近主体；随后镜头围绕主体平稳地向左环绕半圈，主体始终在画面中心。')
    expect(renderCameraMove({ v: 1, moves: [{ id: 'push-in', speed: 'slow' }, { id: 'orbit-left' }], combine: 'together' }, moves, 'en'))
      .toBe('Camera movement: the camera slowly pushes in toward the subject, while the camera smoothly orbits half a turn to the left around the subject, keeping it centred.')
    // A move's own default speed, and a move without one.
    expect(renderCameraMove({ moves: [{ id: 'push-in-face' }] }, moves, 'zh')).toBe('运镜：镜头缓慢地推近，从中景收到人物面部特写，焦点始终在眼睛上。')
    expect(renderCameraMove({ moves: [{ id: 'static' }] }, moves, 'zh')).toBe('运镜：镜头固定不动，机位、焦距和构图都不变，只有画面里的人和物在动。')
    expect(renderCameraMove(null, moves, 'zh')).toBe('')
  })

  it('reads camera settings as the page does: defaults for unknown looks, numbers snapped to stops, on unless switched off', () => {
    expect(sanitizeCameraControl({ look: 'imax-70', lens: 'anamorphic', focalLength: 40, aperture: 'f/2.8', shotSize: 'huge', angle: 'low' }, camera))
      .toEqual({ v: 1, enabled: true, look: 'digital-cinema', lens: 'anamorphic', focalLength: 35, aperture: 2.8, angle: 'low' })
    expect(sanitizeCameraControl({ enabled: false, focalLength: '85mm' }, camera)).toMatchObject({ enabled: false, focalLength: 85, aperture: 2.8 })
    for (const cleared of [null, undefined, 'on', { v: 2 }]) expect(sanitizeCameraControl(cleared, camera)).toBeNull()
    // A tie goes to the smaller stop; a value that is not a number falls back.
    expect(nearestStop(1.7, [1.4, 2], 2.8)).toBe(1.4)
    expect(nearestStop('wide', [14, 18], 50)).toBe(50)
  })

  it('renders the camera line after the canvas, and nothing when the camera is off', () => {
    expect(renderCameraDirection({ v: 1 }, camera, 'zh')).toBe(DEFAULT_CAMERA_ZH)
    expect(renderCameraDirection({ shotSize: 'close', angle: 'low' }, camera, 'zh')).toBe(`${DEFAULT_CAMERA_ZH.slice(0, -1)}；景别：近景；机位：仰拍。`)
    expect(renderCameraDirection({}, camera, 'en')).toBe('Camera direction (rendering only; show no camera or equipment): large-format digital cinema look with wide latitude, '
      + 'natural skin tones and soft highlight roll-off; spherical prime lens, sharp with low distortion; 50mm, normal lens with natural perspective; f/2.8, shallow depth of field, subject isolated.')
    expect(renderCameraDirection({ enabled: false }, camera, 'zh')).toBe('')
    expect(renderCameraDirection(null, camera, 'zh')).toBe('')
  })

  it('knows which nodes take which setting (C1)', () => {
    expect(cameraMoveRefusal(node('v', 'video'))).toBeUndefined()
    expect(cameraMoveRefusal(node('g', 'config', { generationMode: 'video' }))).toBeUndefined()
    expect(cameraMoveRefusal(node('g', 'config'))).toMatch(/generation node is in image mode/u)
    expect(cameraMoveRefusal(node('i', 'image'))).toMatch(/camera moves are for video; this is an image node/u)
    expect(cameraMoveRefusal(node('v', 'video', { videoMode: 'video-edit' }))).toMatch(/video-edit/u)
    expect(cameraControlRefusal(node('i', 'image'))).toBeUndefined()
    expect(cameraControlRefusal(node('g', 'config', { generationMode: 'video' }))).toBeUndefined()
    expect(cameraControlRefusal(node('g', 'config', { generationMode: 'text' }))).toMatch(/text mode/u)
    expect(cameraControlRefusal(node('p', 'image', { panoramaProjection: 'equirectangular' }))).toMatch(/panorama/u)
    expect(cameraControlRefusal(node('a', 'audio'))).toMatch(/image and video/u)
  })
})

describe('the agent\'s values', () => {
  it('takes 1–3 known moves, each once, a locked-off move alone, and drops a speed a move does not have', () => {
    expect(checkCameraMoveInput({ moves: [{ id: 'crane-up', speed: 'fast' }, { id: 'whip-pan', speed: 'slow' }], combine: 'together' }, moves)).toEqual({
      setting: { v: 1, moves: [{ id: 'crane-up', speed: 'fast' }, { id: 'whip-pan' }], combine: 'together' },
      adjusted: ['whip-pan has no speed; the speed was left out'],
    })
    const code = (run: () => unknown): string => {
      try {
        run()
      } catch (error) {
        return `${(error as { code: string }).code}: ${(error as Error).message}`
      }
      return 'accepted'
    }
    expect(code(() => checkCameraMoveInput({ moves: [{ id: 'dolly-in' }] }, moves))).toMatch(/^CANVAS_OPTION_UNKNOWN: Unknown camera move id: dolly-in\. The valid ids: static, static-breathing, push-in,/u)
    expect(code(() => checkCameraMoveInput({ moves: [] }, moves))).toMatch(/^CANVAS_OPTION_INVALID: .*clear: \["cameraMove"\]/u)
    expect(code(() => checkCameraMoveInput({ moves: ['pan-left', 'pan-right', 'tilt-up', 'tilt-down'].map(id => ({ id })) }, moves))).toMatch(/^CANVAS_OPTION_INVALID: .*at most 3/u)
    expect(code(() => checkCameraMoveInput({ moves: [{ id: 'pan-left' }, { id: 'pan-left' }] }, moves))).toMatch(/^CANVAS_OPTION_INVALID: pan-left is listed twice/u)
    expect(code(() => checkCameraMoveInput({ moves: [{ id: 'static' }, { id: 'push-in' }] }, moves))).toMatch(/^CANVAS_OPTION_INVALID: static \(固定镜头\) stands alone/u)
  })

  it('checks camera ids, snaps numbers and reports the snap, and merges over the node\'s current setting', () => {
    const { input, adjusted } = checkCameraControlInput({ focalLength: 40, aperture: 3, look: 'film-16mm' }, camera)
    expect(input).toEqual({ focalLength: 35, aperture: 2.8, look: 'film-16mm' })
    expect(adjusted).toEqual([expect.stringMatching(/^focalLength 40 became 35mm, the nearest stop \(14, 18, 24/u), expect.stringMatching(/^aperture 3 became f\/2\.8, the nearest stop/u)])
    expect(() => checkCameraControlInput({ look: 'imax' }, camera)).toThrow(/Unknown cameraControl\.look "imax"\. The valid look values: digital-cinema \(数字电影机\)/u)
    expect(() => checkCameraControlInput({ lens: 'tilt-shift' }, camera)).toThrow(/Unknown cameraControl\.lens "tilt-shift"\. The valid lens values: spherical-prime \(球面定焦\)/u)
    expect(() => checkCameraControlInput({ shotSize: 'cowboy' }, camera)).toThrow(/extreme-wide \(大远景\)/u)
    expect(() => checkCameraControlInput({ angle: 'dutch' }, camera)).toThrow(/eye \(平视\)/u)

    // Over the defaults when the node has none; enabled defaults to true.
    expect(mergeCameraControl({ aperture: 4 }, undefined, camera)).toEqual({ v: 1, enabled: true, look: 'digital-cinema', lens: 'spherical-prime', focalLength: 50, aperture: 4 })
    const current = { v: 1, enabled: false, look: 'film-35mm', lens: 'macro', focalLength: 85, aperture: 2, shotSize: 'close', angle: 'high' }
    expect(mergeCameraControl({ aperture: 4 }, current, camera)).toEqual({ ...current, enabled: true, aperture: 4 })
    expect(mergeCameraControl({ enabled: false, shotSize: null }, current, camera)).toEqual({ v: 1, enabled: false, look: 'film-35mm', lens: 'macro', focalLength: 85, aperture: 2, angle: 'high' })
  })

  it('turns a preset into the node fields the panels write, and says what it cannot attach', () => {
    expect(() => findPreset('p.nope', presets)).toThrow(/^Unknown preset "p\.nope"\. The valid presets: p\.vertical-drama \(竖屏短剧, video\)/u)
    expect(presetSettings(findPreset('p.vertical-drama', presets), catalogs)).toMatchObject({
      metadata: { size: '9:16', vquality: '720', seconds: '5', generateAudio: 'true' }, skipped: [],
    })
    expect(presetSettings(findPreset('p.cheap-preview', presets), catalogs).metadata).toEqual({ model: 'seedance-2-0-official-mini', vquality: '480', seconds: '4' })
    const card = presetSettings(findPreset('p.character-card', presets), catalogs)
    expect(card.metadata).toEqual({ size: '1536x1024', count: 1 })
    expect(card.skipped).toEqual([{ field: 'skills', reason: expect.stringContaining('vd.character-sheet') }])
    // A preset carrying camera settings is read with the catalogues.
    const custom = { id: 'p.custom', version: 1, name: { zh: '自定', en: 'Custom' }, mode: 'video' as const, cameraMove: { moves: [{ id: 'push-in' }] }, cameraControl: { focalLength: 30 } }
    expect(presetSettings(custom, catalogs).metadata).toEqual({
      cameraMove: { v: 1, moves: [{ id: 'push-in' }], combine: 'sequence' },
      cameraControl: { v: 1, enabled: true, look: 'digital-cinema', lens: 'spherical-prime', focalLength: 35, aperture: 2.8 },
    })
    expect(presetSettings({ ...custom, cameraMove: { moves: [{ id: 'gone' }] } }, catalogs).skipped).toEqual([{ field: 'cameraMove', reason: expect.stringContaining('not in this build') }])
  })
})

describe('planGenerationOptions', () => {
  const options = (extra: Partial<CheckedGenerationOptions>): CheckedGenerationOptions => ({ nodeIds: [], clear: [], catalogs, ...extra })
  const setting = { v: 1 as const, moves: [{ id: 'pan-left' }], combine: 'sequence' as const }

  it('writes one update_node per changed node, skips what a node does not take, and leaves unchanged nodes alone', () => {
    const snapshot = board([
      node('shot', 'video', { cameraMove: setting }),
      node('still', 'image'),
      node('gen', 'config', { generationMode: 'video', cameraControl: { v: 1, enabled: true, look: 'film-35mm', lens: 'macro', focalLength: 85, aperture: 2 } }),
    ])
    const plan = planGenerationOptions(options({ nodeIds: ['shot', 'still', 'gen'], cameraMove: setting, cameraControl: { aperture: 4 } }), snapshot)
    expect(plan.ops).toEqual([
      { type: 'update_node', id: 'shot', metadata: { cameraControl: { v: 1, enabled: true, look: 'digital-cinema', lens: 'spherical-prime', focalLength: 50, aperture: 4 } } },
      { type: 'update_node', id: 'still', metadata: { cameraControl: { v: 1, enabled: true, look: 'digital-cinema', lens: 'spherical-prime', focalLength: 50, aperture: 4 } } },
      { type: 'update_node', id: 'gen', metadata: { cameraMove: setting, cameraControl: { v: 1, enabled: true, look: 'film-35mm', lens: 'macro', focalLength: 85, aperture: 4 } } },
    ])
    expect(plan.applied).toEqual([
      { nodeId: 'shot', set: ['cameraMove', 'cameraControl'], cleared: [], skipped: [], changed: true },
      { nodeId: 'still', set: ['cameraControl'], cleared: [], skipped: [{ field: 'cameraMove', reason: 'camera moves are for video; this is an image node' }], changed: true },
      { nodeId: 'gen', set: ['cameraMove', 'cameraControl'], cleared: [], skipped: [], changed: true },
    ])
    // Clearing writes null where there is something to clear.
    const cleared = planGenerationOptions(options({ nodeIds: ['shot', 'still'], clear: ['cameraMove'] }), snapshot)
    expect(cleared.ops).toEqual([{ type: 'update_node', id: 'shot', metadata: { cameraMove: null } }])
    expect(cleared.applied.map(entry => [entry.nodeId, entry.cleared, entry.changed])).toEqual([['shot', ['cameraMove'], true], ['still', ['cameraMove'], false]])
  })

  it('refuses a node that takes no settings, a missing node, and a setting none of the nodes takes', () => {
    const snapshot = board([node('note', 'text'), node('still', 'image'), node('gen', 'config')])
    expect(() => planGenerationOptions(options({ nodeIds: ['note'], cameraControl: {} }), snapshot)).toThrow(/note is a text node; generation settings go on image, video and generation/u)
    expect(() => planGenerationOptions(options({ nodeIds: ['gone'], cameraControl: {} }), snapshot)).toThrow(/The board has no node gone/u)
    expect(() => planGenerationOptions(options({ nodeIds: ['still', 'gen'], cameraMove: setting }), snapshot))
      .toThrow(/None of these nodes takes cameraMove: still \(camera moves are for video; this is an image node\); gen \(camera moves are for video; this generation node is in image mode\)/u)
  })

  it('applies a preset to the nodes of its mode, explicit settings over it', () => {
    const snapshot = board([node('shot', 'video'), node('still', 'image')])
    const preset = presetSettings(findPreset('p.vertical-drama', presets), catalogs)
    const plan = planGenerationOptions(options({ nodeIds: ['shot', 'still'], preset, cameraControl: { focalLength: 85 } }), snapshot)
    expect(plan.ops[0]).toEqual({ type: 'update_node', id: 'shot', metadata: { size: '9:16', vquality: '720', seconds: '5', generateAudio: 'true', cameraControl: expect.objectContaining({ focalLength: 85 }) } })
    expect(plan.applied[1]).toMatchObject({ nodeId: 'still', set: ['cameraControl'], skipped: [{ field: 'preset', reason: 'p.vertical-drama is a video preset; this is an image node' }] })
    expect(() => planGenerationOptions(options({ nodeIds: ['still'], preset }), snapshot)).toThrow(/None of these nodes takes preset/u)
  })
})

describe('promptLimitCheck (C2)', () => {
  /** A generation node in video mode whose prompt mentions a wired text node holding `length` characters. */
  const composerBoard = (length: number, metadata: Record<string, unknown> = { cameraMove: { v: 1, moves: [{ id: 'push-in' }] } }): BoardSnapshot => board([
    node('note', 'text', { content: '雨'.repeat(length) }),
    node('gen', 'config', { generationMode: 'video', composerContent: '@[node:note]', prompt: '@[node:note]', ...metadata }),
  ], [['note', 'gen']])
  // The page renders '【文本1】' (zh) or '【Text 1】' (en) twice around the text: the base is length + 13 or + 19, and the line adds 2 + its length.
  const lineLength = PUSH_IN_ZH.length + 2

  it('refuses for certain when the added line pushes the prompt over the limit however the page is set up', () => {
    const length = PROMPT_LIMIT_LENGTH - 19 - 1
    const check = promptLimitCheck(composerBoard(length), { nodeId: 'gen' }, catalogs)
    expect(check).toEqual({ nodeId: 'gen', refused: 'certain', length: length + 19 + lineLength, limit: PROMPT_LIMIT_LENGTH, lines: [PUSH_IN_ZH] })
  })

  it('says possible when only one of the page\'s setups refuses, and nothing when the prompt fits or is long by itself', () => {
    // Over the limit with the English labels already, within it with the Chinese ones.
    expect(promptLimitCheck(composerBoard(PROMPT_LIMIT_LENGTH - 15), { nodeId: 'gen' }, catalogs)).toMatchObject({ refused: 'possible' })
    // Within it with the Chinese labels and the line, over it with the English ones.
    expect(promptLimitCheck(composerBoard(PROMPT_LIMIT_LENGTH - 13 - lineLength), { nodeId: 'gen' }, catalogs)).toMatchObject({ refused: 'possible' })
    expect(promptLimitCheck(composerBoard(PROMPT_LIMIT_LENGTH - 19 - lineLength), { nodeId: 'gen' }, catalogs)).toBeUndefined()
    expect(promptLimitCheck(composerBoard(PROMPT_LIMIT_LENGTH + 50), { nodeId: 'gen' }, catalogs)).toBeUndefined()
  })

  it('reads the run\'s prompt and mode as the page does, adds a line only once, and cannot estimate without the catalogue', () => {
    const near = PROMPT_LIMIT_LENGTH - 19 - 1
    // An image run takes no camera move; a text run takes nothing.
    expect(promptLimitCheck(composerBoard(near), { nodeId: 'gen', mode: 'image' }, catalogs)).toBeUndefined()
    expect(promptLimitCheck(composerBoard(near), { nodeId: 'gen', mode: 'text' }, catalogs)).toBeUndefined()
    expect(promptLimitCheck(composerBoard(near), { nodeId: 'gen' }, { camera })).toBeUndefined()
    expect(promptLimitCheck(composerBoard(near, {}), { nodeId: 'gen' }, catalogs)).toBeUndefined()
    // A prompt that already holds the line gets no second one.
    const holding = board([node('shot', 'video', { prompt: `${'雨'.repeat(PROMPT_LIMIT_LENGTH - 30)}\n${PUSH_IN_ZH}`, cameraMove: { moves: [{ id: 'push-in' }] } })])
    expect(promptLimitCheck(holding, { nodeId: 'shot', mode: 'video' }, catalogs)).toBeUndefined()
    // The run's own prompt replaces the node's.
    expect(promptLimitCheck(holding, { nodeId: 'shot', mode: 'video', prompt: '雨'.repeat(PROMPT_LIMIT_LENGTH - 10) }, catalogs)).toMatchObject({ refused: 'certain' })
    // A video prompt mentioning a node it cannot find is refused by the page for that reason instead.
    expect(promptLimitCheck(board([node('gen', 'config', { generationMode: 'video', composerContent: '@[node:gone]', cameraMove: { moves: [{ id: 'push-in' }] } })]), { nodeId: 'gen' }, catalogs)).toBeUndefined()
  })

  it('counts wired texts as blocks on the ordinary path, and allows for a saved screenplay compilation that leaves them out', () => {
    const wired = (metadata: Record<string, unknown>): BoardSnapshot => board([
      node('note', 'text', { content: '雨'.repeat(2000) }),
      node('shot', 'video', { prompt: '雨'.repeat(1985), cameraControl: { v: 1 }, ...metadata }),
    ], [['note', 'shot']])
    // 1985 + 2 + '【文本1】\n' + 2000 = 3993 within (3996 with '【Text 1】'); the camera line, in the texts' language, pushes it over either way.
    expect(promptLimitCheck(wired({}), { nodeId: 'shot', mode: 'video' }, catalogs)).toMatchObject({ refused: 'certain' })
    expect(promptLimitCheck(wired({}), { nodeId: 'shot', mode: 'image' }, catalogs)).toMatchObject({ refused: 'certain', lines: [DEFAULT_CAMERA_ZH] })
    // A matching compilation already holds the wired text, so the page leaves the block out and the prompt fits: refused only if it does not match.
    expect(promptLimitCheck(wired({ videoPromptCompilation: { prompt: 'x' } }), { nodeId: 'shot', mode: 'video' }, catalogs)).toMatchObject({ refused: 'possible' })
  })
})
