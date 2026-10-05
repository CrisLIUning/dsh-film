/**
 * Generation settings on storyboard nodes (spec C1/C11): the canvas's readers
 * ported with the catalogue passed in, the agent's values checked strictly,
 * the per-node plan of canvas_set_generation_options (camera, skills, skill
 * nodes, frame roles), presets, and the estimate of the 4000-character rule
 * (C2) the run tools refuse by.
 *
 * The catalogues are the canvas's own files (tests/fixtures/catalog, copied
 * from canvas feat/dsh-host web/src/lib/canvas/catalog/: the camera ones at
 * 267893c, the skills and presets at ad85ff3); the expected text follows the
 * canvas's renderers (camera-moves.ts, camera-direction.ts, prompt-skills.ts,
 * prompt-composition.ts) on that text.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BoardNode, BoardSnapshot } from '../src/canvas/board-ops.js'
import type { CameraControlCatalog, CameraMoveCatalog, GenerationPresetCatalog, PromptSkillCatalog } from '../src/canvas/catalog.js'
import {
  PROMPT_LIMIT_LENGTH, cameraControlRefusal, cameraMoveRefusal, checkCameraControlInput, checkCameraMoveInput, checkFrameRolesInput, checkSkillInputs, composeGenerationText,
  findPreset, flowFrameRoles, flowSkills, frameImageIds, frameOrder, mergeCameraControl, nearestStop, nodeRunMode, planGenerationOptions, presetSettings, promptLimitCheck,
  promptPartsForRun, readFrameRoles, renderCameraDirection, renderCameraMove, sanitizeCameraControl, sanitizeCameraMove,
} from '../src/canvas/generation-options.js'
import type { CheckedGenerationOptions } from '../src/canvas/generation-options.js'
import { generationFlowOps } from '../src/canvas/board-tools.js'
import { newNodePromptSkill, skillNodeMetadata } from '../src/canvas/prompt-skills.js'

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'catalog', `${name}.json`), 'utf8')) as T
const moves = fixture<CameraMoveCatalog>('camera-moves')
const camera = fixture<CameraControlCatalog>('camera-control')
const presets = fixture<GenerationPresetCatalog>('generation-presets')
const skillCatalog = fixture<PromptSkillCatalog>('vibedev-skills')
const catalogs = { moves, camera }
const skill = (id: string) => skillCatalog.skills.find(entry => entry.id === id)!

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
    expect(check).toEqual({ nodeId: 'gen', refused: 'certain', length: length + 19 + lineLength, limit: PROMPT_LIMIT_LENGTH, lines: [PUSH_IN_ZH], skills: [] })
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

describe('nodeRunMode (generation-run.ts)', () => {
  it('runs a node in its panel\'s mode: a config node by its generationMode, any other node by its type', () => {
    expect(nodeRunMode(node('v', 'video'))).toBe('video')
    expect(nodeRunMode(node('i', 'image'))).toBe('image')
    expect(nodeRunMode(node('t', 'text'))).toBe('text')
    expect(nodeRunMode(node('a', 'audio'))).toBe('audio')
    expect(nodeRunMode(node('g', 'config'))).toBe('image')
    expect(nodeRunMode(node('g', 'config', { generationMode: 'video' }))).toBe('video')
    // A stray generationMode on a video node does not make it an image; the run's own mode wins; anything else is an image.
    expect(nodeRunMode(node('v', 'video', { generationMode: 'image' }))).toBe('video')
    expect(nodeRunMode(node('v', 'video'), 'image')).toBe('image')
    expect(nodeRunMode(node('v', 'video'), 'film')).toBe('video')
    expect(nodeRunMode(node('p', 'pack:custom'))).toBe('image')
    expect(nodeRunMode(undefined)).toBe('image')
  })
})

describe('prompt skills in the composed prompt (C2)', () => {
  const zh = (userText: string, upstreamText = '') => ({ userText, upstreamText, languageText: [userText, upstreamText] })
  const frame = newNodePromptSkill(skill('vd.storyboard-frame'), { setting: '雨夜客栈' })
  const CAMERA_SENTENCE = DEFAULT_CAMERA_ZH.slice(DEFAULT_CAMERA_ZH.indexOf('：') + 1, -1)

  it('wraps the person\'s text, fills the camera slot with the bare sentence, drops empty parts and merges the avoid terms into one line', () => {
    const snapshot = board([node('still', 'image', { promptSkills: [frame], cameraControl: { v: 1 } })])
    const composed = composeGenerationText(snapshot, 'still', 'image', zh('林推门而入。'), 'zh', catalogs)
    expect(composed).toEqual({
      prompt: [
        '分镜画面：林推门而入。',
        '景别：中景；主体位于画面三分线处；前景、中景、背景层次清楚，视线方向明确。',
        // 时间与天气 is empty: that segment goes, and the line keeps its closing '。'.
        '场景：雨夜客栈。',
        '人物沿用所连参考的脸型、发型、服装和年龄感，动作定格在这一镜最有张力的瞬间。',
        `成像方式（只描述画面效果，不出现相机或摄影器材）：${CAMERA_SENTENCE}。`,
        '单幅电影剧照质感，不分格，不加文字或字幕。',
        '',
        '避免：分格拼贴、设定卡排版、文字标签、水印、多余人物',
      ].join('\n'),
      base: '林推门而入。',
      // The camera line went into the slot, so it is not appended.
      lines: ['避免：分格拼贴、设定卡排版、文字标签、水印、多余人物'],
      skills: ['vd.storyboard-frame'],
    })
  })

  it('appends skills after the wired texts, then the motion line and one avoid line; a skill the writer followed adds nothing', () => {
    const lock = newNodePromptSkill(skill('vd.style-lock'), { style: '水墨' })
    const shot = board([node('shot', 'video', { promptSkills: [lock], cameraMove: { v: 1, moves: [{ id: 'push-in' }] } })])
    expect(composeGenerationText(shot, 'shot', 'video', zh('林推门而入。', '【文本1】\n雨夜。'), 'zh', catalogs)?.prompt).toBe([
      '林推门而入。', '', '【文本1】', '雨夜。', '',
      // 色调、质感、时代感 are all empty: the whole line goes.
      '统一风格：水墨。', '与同组其他镜头保持一致的色彩倾向、光比和颗粒感，不因单镜头内容改变整体风格。', '',
      PUSH_IN_ZH, '避免：风格漂移、色调突变',
    ].join('\n'))
    const written = board([node('still', 'image', { promptSkills: [{ ...frame, appliedBy: 'writer' }] })])
    expect(composeGenerationText(written, 'still', 'image', zh('林推门而入。'), 'zh', catalogs)).toEqual({ prompt: '林推门而入。', base: '林推门而入。', lines: [], skills: [] })
    // Nothing to compose: null.
    expect(composeGenerationText(board([node('still', 'image')]), 'still', 'image', zh('林'), 'zh', catalogs)).toBeNull()
    // A camera setting whose catalogue is not loaded cannot be estimated.
    expect(composeGenerationText(board([node('still', 'image', { cameraControl: { v: 1 } })]), 'still', 'image', zh('林'), 'zh', { moves })).toBeUndefined()
  })

  it('applies a wired skill node, the node\'s own wrap skill first, and only in the modes a skill names', () => {
    const wired = (metadata: Record<string, unknown>, mode = 'image') => {
      const snapshot = board([node('still', mode === 'image' ? 'image' : 'config', { generationMode: mode, ...metadata }), node('s1', 'skill', skillNodeMetadata(skill('vd.cover-poster'), skillCatalog.catalogVersion, { title: '雨夜来客' }))], [['s1', 'still']])
      return composeGenerationText(snapshot, 'still', mode as 'image', zh('林'), 'zh', catalogs)
    }
    expect(wired({})?.skills).toEqual(['vd.cover-poster'])
    expect(wired({})?.prompt).toMatch(/^短剧封面海报/u)
    // The node's own wrap skill beats the skill node's.
    expect(wired({ promptSkills: [frame] })?.skills).toEqual(['vd.storyboard-frame'])
    // An image skill on a video run does nothing.
    expect(wired({}, 'video')).toBeNull()
    // videoModes: only while the node's saved video mode is one of them.
    const bridge = newNodePromptSkill(skill('vd.first-last-bridge'))
    const video = (videoMode?: string) => composeGenerationText(board([node('gen', 'config', { generationMode: 'video', promptSkills: [bridge], ...(videoMode !== undefined ? { videoMode } : {}) })]), 'gen', 'video', zh('林'), 'zh', catalogs)
    expect(video('first-last-frame')?.skills).toEqual(['vd.first-last-bridge'])
    expect(video('frames')?.skills).toEqual(['vd.first-last-bridge'])
    expect(video('reference')).toBeNull()
    expect(video()).toBeNull()
  })

  it('counts skills in the 4000-character rule, the node\'s own and its skill nodes\', and leaves the writer\'s alone', () => {
    const long = '雨'.repeat(3900)
    const still = (metadata: Record<string, unknown>) => board([node('still', 'image', { prompt: long, ...metadata })])
    expect(promptLimitCheck(still({ promptSkills: [frame] }), { nodeId: 'still' }, catalogs)).toMatchObject({ refused: 'certain', skills: ['vd.storyboard-frame'], lines: ['避免：分格拼贴、设定卡排版、文字标签、水印、多余人物'] })
    expect(promptLimitCheck(still({ promptSkills: [{ ...frame, appliedBy: 'writer' }] }), { nodeId: 'still' }, catalogs)).toBeUndefined()
    // An append skill adds less: its block and its avoid terms.
    const lighting = (length: number) => board([node('still', 'image', { prompt: '雨'.repeat(length) }), node('s1', 'skill', skillNodeMetadata(skill('vd.lighting-mood'), skillCatalog.catalogVersion, { mood: '压抑' }))], [['s1', 'still']])
    const added = composeGenerationText(lighting(0), 'still', 'image', { userText: '雨', upstreamText: '', languageText: ['雨'] }, 'zh', catalogs)!.prompt.length - 1
    expect(promptLimitCheck(lighting(PROMPT_LIMIT_LENGTH - added), { nodeId: 'still' }, catalogs)).toBeUndefined()
    expect(promptLimitCheck(lighting(PROMPT_LIMIT_LENGTH - added + 1), { nodeId: 'still' }, catalogs)).toMatchObject({ refused: 'certain', length: PROMPT_LIMIT_LENGTH + 1, skills: ['vd.lighting-mood'] })
    // A skill node wired into a text node does nothing (it applies to image, video and generation nodes).
    expect(promptLimitCheck(board([node('note', 'text', { prompt: long }), node('s1', 'skill', skillNodeMetadata(skill('vd.script-to-shots'), skillCatalog.catalogVersion))], [['s1', 'note']]), { nodeId: 'note' }, catalogs)).toBeUndefined()
    // Text mode takes text skills, and never an avoid line.
    const script = newNodePromptSkill(skill('vd.script-to-shots'))
    expect(promptLimitCheck(board([node('gen', 'config', { generationMode: 'text', prompt: '雨'.repeat(3950), promptSkills: [script] })]), { nodeId: 'gen' }, catalogs))
      .toMatchObject({ refused: 'certain', skills: ['vd.script-to-shots'], lines: [] })
    // The person's own text past the limit is sent as it is.
    expect(promptLimitCheck(still({ prompt: '雨'.repeat(4100), promptSkills: [frame] }), { nodeId: 'still' }, catalogs)).toBeUndefined()
    // A video node without a generationMode runs as a video, so its camera move counts.
    expect(promptLimitCheck(board([node('shot', 'video', { prompt: '雨'.repeat(3990), cameraMove: { v: 1, moves: [{ id: 'push-in' }] } })]), { nodeId: 'shot' }, catalogs)).toMatchObject({ refused: 'certain', lines: [PUSH_IN_ZH] })
  })
})

describe('frame roles (C1 frameRoles)', () => {
  const promptPartsForRunText = (snapshot: BoardSnapshot): string | undefined => promptPartsForRun(snapshot, { nodeId: 'gen' }, 'zh')?.userText

  it('reads roles as the canvas does and orders the frame images by them', () => {
    expect(readFrameRoles({ first: 'a', last: 'a' })).toEqual({ first: 'a' })
    expect(readFrameRoles({ first: '', last: 'b', extra: 1 })).toEqual({ last: 'b' })
    for (const cleared of [null, undefined, 'a', {}, { first: 3 }]) expect(readFrameRoles(cleared)).toBeNull()
    expect(frameOrder(['a', 'b', 'c'], { first: 'c', last: 'a' })).toEqual(['c', 'a', 'b'])
    expect(frameOrder(['a', 'b', 'c'], { last: 'a' })).toEqual(['b', 'a', 'c'])
    expect(frameOrder(['a', 'b'], { first: 'gone' })).toEqual(['a', 'b'])
  })

  it('names the images a node takes, groups and screenplay sources expanded, and labels the frame images first in a frame mode', () => {
    const snapshot = board([
      node('a', 'image', { content: 'a.png' }), node('b', 'image', { content: 'b.png' }), node('empty', 'image'),
      node('g', 'group'), node('c', 'image', { content: 'c.png', groupId: 'g' }),
      node('gen', 'config', { generationMode: 'video', composerContent: '@[node:a]和@[node:b]走过来', prompt: '@[node:a]和@[node:b]走过来', videoMode: 'first-last-frame', frameRoles: { first: 'b', last: 'a' } }),
    ], [['a', 'gen'], ['b', 'gen'], ['empty', 'gen'], ['g', 'gen']])
    expect(frameImageIds(snapshot.nodes![5]!, snapshot.nodes!, snapshot.connections!)).toEqual(['a', 'b', 'c'])
    expect(promptPartsForRunText(snapshot)).toBe('@Image2和@Image1走过来')
    // Outside a frame mode the images keep their mention order.
    const reference = { ...snapshot, nodes: snapshot.nodes!.map(item => (item.id === 'gen' ? { ...item, metadata: { ...item.metadata, videoMode: 'reference' } } : item)) }
    expect(promptPartsForRunText(reference)).toBe('@Image1和@Image2走过来')
  })

  it('plans roles on video and video-mode generation nodes only, from the images they take', () => {
    const snapshot = board([
      node('f1', 'image', { content: '1.png' }), node('f2', 'image', { content: '2.png' }), node('gen', 'config', { generationMode: 'video', videoMode: 'image-to-video', frameRoles: { first: 'f1' } }),
      node('img', 'image'),
    ], [['f1', 'gen'], ['f2', 'gen']])
    const plan = planGenerationOptions({ nodeIds: ['gen', 'img'], frameRoles: { last: 'f1' }, clear: [], catalogs }, snapshot)
    // The last frame takes the first frame's image: the two swap, and the first frame is left empty (filled from connection order).
    expect(plan.ops).toEqual([{ type: 'update_node', id: 'gen', metadata: { frameRoles: { last: 'f1' } } }])
    expect(plan.applied[1]).toMatchObject({ skipped: [{ field: 'frameRoles', reason: 'first and last frames are for video; this is an image node' }] })
    expect(() => checkFrameRolesInput({})).toThrow(/names first, last or both/u)
    expect(() => checkFrameRolesInput({ first: ' ' })).toThrow(/image node id/u)
    expect(() => checkFrameRolesInput({ first: 'x', last: 'x' })).toThrow(/both the first and the last frame/u)
  })
})

describe('prompt skills: the agent\'s values and the plan', () => {
  const checked = (inputs: Array<{ id: string; vars?: Record<string, unknown>; as?: string }>) => checkSkillInputs(inputs, skillCatalog)
  const refusal = (run: () => unknown): string => {
    try {
      run()
    } catch (error) {
      return `${(error as { code: string }).code}: ${(error as Error).message}`
    }
    return 'accepted'
  }
  const options = (extra: Partial<CheckedGenerationOptions>): CheckedGenerationOptions => ({ nodeIds: [], clear: [], catalogs: { ...catalogs, skills: skillCatalog }, ...extra })

  it('checks ids, the per-node limit and the variables a skill declares', () => {
    expect(checked([{ id: 'vd.camera-move-detail', vars: { speed: '缓慢', duration: ' ' } }])).toEqual([{ entry: skill('vd.camera-move-detail'), vars: { speed: '缓慢' }, unset: ['duration'], as: 'attach' }])
    expect(checked([{ id: 'vd.style-lock', vars: { style: 3 }, as: 'node' }])[0]).toMatchObject({ vars: { style: '3' }, as: 'node' })
    expect(refusal(() => checked([]))).toMatch(/^CANVAS_OPTION_INVALID: skills lists 1–3/u)
    expect(refusal(() => checked([{ id: 'vd.gone' }]))).toMatch(/^CANVAS_OPTION_UNKNOWN: Unknown prompt skill id: vd\.gone/u)
    expect(refusal(() => checked([{ id: 'vd.style-lock' }, { id: 'vd.style-lock', as: 'node' }]))).toMatch(/^CANVAS_OPTION_INVALID: vd\.style-lock is listed twice/u)
    expect(refusal(() => checked([{ id: 'vd.storyboard-frame' }, { id: 'vd.cover-poster', as: 'node' }]))).toMatch(/^CANVAS_SKILL_LIMIT: .*this call names 2 wrap \(vd\.storyboard-frame, vd\.cover-poster\)/u)
    expect(refusal(() => checked([{ id: 'vd.style-lock' }, { id: 'vd.lighting-mood' }, { id: 'vd.identity-lock' }]))).toMatch(/^CANVAS_SKILL_LIMIT: .*3 append/u)
    expect(refusal(() => checked([{ id: 'vd.sound-bed', vars: { volume: '大' } }]))).toMatch(/^CANVAS_SKILL_VARS: vd\.sound-bed \(环境声设计\) has no variable "volume"\. It declares: ambience \(环境声, required\), music \(音乐, default "不要音乐"\)\./u)
    expect(refusal(() => checked([{ id: 'vd.sound-bed', vars: { ambience: { rain: true } } }]))).toMatch(/takes text/u)
    expect(refusal(() => checked([{ id: 'vd.sound-bed', vars: { ambience: '雨'.repeat(2001) } }]))).toMatch(/2001 characters; it takes at most 2000/u)
  })

  it('keeps an attached skill\'s frozen version and its writer mark, takes the new values, and gives a cleared auto value back to the node', () => {
    // A catalogue that has moved on to version 2 of the skill.
    const bumped = { ...skillCatalog, skills: skillCatalog.skills.map(entry => (entry.id === 'vd.camera-move-detail' ? { ...entry, version: 2 } : entry)) }
    const old = { ...newNodePromptSkill(skill('vd.camera-move-detail')), appliedBy: 'writer' as const, vars: { speed: '平稳', duration: '8' } }
    const snapshot = board([node('shot', 'video', { promptSkills: [old] })])
    const plan = planGenerationOptions(options({ nodeIds: ['shot'], skills: checkSkillInputs([{ id: 'vd.camera-move-detail', vars: { speed: '缓慢', duration: '' } }], bumped) }), snapshot)
    expect(plan.ops).toEqual([{ type: 'update_node', id: 'shot', metadata: { promptSkills: [{ ...old, vars: { speed: '缓慢' } }] } }])
    expect(plan.applied[0]!.notes).toEqual([
      expect.stringMatching(/^vd\.camera-move-detail was written into the prompt by 帮我写, so the storyboard does not compose it again/u),
      'vd.camera-move-detail stays at version 1 on this node; the catalogue has version 2 (the person can update it on the node, or clear the node\'s skills and attach it again)',
    ])
    expect(plan.applied[0]!.skills).toEqual([{ id: 'vd.camera-move-detail', source: 'node', state: 'writer' }])
  })

  it('notes a video skill kept outside its video modes, and turns a preset\'s skills into attachments', () => {
    const snapshot = board([node('gen', 'config', { generationMode: 'video', videoMode: 'reference' })])
    const plan = planGenerationOptions(options({ nodeIds: ['gen'], skills: checked([{ id: 'vd.first-last-bridge' }]) }), snapshot)
    expect(plan.applied[0]).toMatchObject({
      set: ['skills'], notes: ['vd.first-last-bridge applies only in video mode first-last-frame; this node\'s video mode is reference, so the skill is kept but not composed until it is'],
      skills: [{ id: 'vd.first-last-bridge', source: 'node', state: 'video-mode' }],
    })
    const card = presetSettings(findPreset('p.character-card', presets), { ...catalogs, skills: skillCatalog })
    expect(card.skills).toEqual([{ entry: skill('vd.character-sheet'), vars: {} }])
    expect(card.skipped).toEqual([])
    expect(presetSettings({ ...findPreset('p.character-card', presets), skills: [{ id: 'vd.gone' }, { id: 'vd.sound-bed' }] }, { skills: skillCatalog }).skipped).toEqual([
      { field: 'skills', reason: 'vd.gone is not in this build\'s skill catalogue' }, { field: 'skills', reason: 'vd.sound-bed does not apply in image mode' },
    ])
  })

  it('builds a flow\'s skills: the preset\'s first, the call\'s own, and skill nodes beside the generation node', () => {
    const preset = presetSettings(findPreset('p.storyboard-still', presets), { ...catalogs, skills: skillCatalog })
    const flow = flowSkills(checked([{ id: 'vd.cover-poster', vars: { title: '雨夜' } }, { id: 'vd.style-lock', vars: { style: '水墨' }, as: 'node' }]), preset, undefined, skillCatalog.catalogVersion)
    expect(flow.skills.map(item => item.id)).toEqual(['vd.cover-poster'])
    expect(flow.notes).toEqual(['vd.cover-poster replaced the preset\'s vd.storyboard-frame (a node takes one wrap skill)'])
    expect(flow.purpose).toEqual({ promptPurpose: 'shot' })
    expect(flow.nodes).toEqual([{ title: '风格统一', metadata: { status: 'idle', ...skillNodeMetadata(skill('vd.style-lock'), skillCatalog.catalogVersion, { style: '水墨' }, (flow.nodes[0]!.metadata.skillSnapshot as { frozenAt: string }).frozenAt) } }])
    expect(refusal(() => flowSkills(checked([{ id: 'vd.dialogue-shot', vars: { speaker: '林' } }]), undefined, undefined, ''))).toMatch(/^CANVAS_SKILL_VARS: vd\.dialogue-shot \(对白镜头\) needs lines \(台词原文\)/u)
    // The skill node goes under the prompt node, wired into the generation node, never mentioned in its prompt.
    const ops = generationFlowOps({ prompt: '雨', mode: 'image', referenceNodeIds: ['f1'] }, board([node('f1', 'image', { content: '1.png' })]), {}, flow.nodes)
    const added = ops.find(op => op.nodeType === 'skill')!
    expect(added).toMatchObject({ type: 'add_node', title: '风格统一', position: { x: 420, y: 280 } })
    const config = ops.find(op => op.nodeType === 'config')!
    expect(ops).toContainEqual({ type: 'connect_nodes', fromNodeId: added.id, toNodeId: config.id })
    expect(JSON.stringify(config.metadata)).not.toContain(String(added.id))
    // Frame roles go on the generation node when they name its images.
    flowFrameRoles(ops, board([node('f1', 'image', { content: '1.png' })]), { first: 'f1' })
    expect(config.metadata).toMatchObject({ frameRoles: { first: 'f1' } })
    expect(refusal(() => flowFrameRoles(ops, board([node('f1', 'image', { content: '1.png' })]), { last: 'f9' }))).toMatch(/^CANVAS_OPTION_INVALID: frameRoles\.last f9 is not among the images this flow wires in \(f1\)/u)
  })
})
