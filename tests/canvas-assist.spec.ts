/** The canvas prompt writer's request checking and the words it sends a model. */

import { describe, expect, it } from 'vitest'
import { AssistRequestError, assistSystemPrompt, assistUserParts, parseAssistRequest } from '../src/canvas/assist-prompt.js'

const PNG = `data:image/png;base64,${'A'.repeat(64)}`
/** Lines as the canvas renders them (camera-moves.ts, camera-direction.ts). */
const MOVE = '运镜：镜头平稳地向前推进，逐渐靠近主体。'
const CAMERA = '拍摄方式（只描述成像，不要在画面里出现相机或摄影器材）：35mm 电影胶片质感，颗粒细腻、色彩温润、对比柔和；球面定焦镜头，成像锐利、畸变小；85mm，人像焦距，背景压缩；光圈 f/2，浅景深，背景柔和虚化。'

describe('prompt writer requests', () => {
  it('accepts an image or video request and drops what it cannot read', () => {
    expect(parseAssistRequest({ surface: 'image', draft: '雨夜', references: [{ kind: 'image', title: '客栈', dataUrl: PNG }, { kind: 'bogus' }, 'x'] })).toEqual({
      surface: 'image', draft: '雨夜', references: [{ kind: 'image', title: '客栈', dataUrl: PNG }],
    })
    expect(parseAssistRequest({ surface: 'video', purpose: 'shot', video: { durationSeconds: 5, aspect: '16:9', generateAudio: true }, model: ' seedance-2.0 ' })).toEqual({
      surface: 'video', purpose: 'shot', video: { durationSeconds: 5, aspect: '16:9', generateAudio: true }, model: 'seedance-2.0',
    })
  })

  it('refuses what Studio refuses', () => {
    expect(() => parseAssistRequest({ surface: 'text' })).toThrow(AssistRequestError)
    expect(() => parseAssistRequest({ surface: 'video', purpose: 'character-sheet' })).toThrow('image/shot for video')
    expect(() => parseAssistRequest({ surface: 'image', video: { durationSeconds: 5 } })).toThrow('Video settings')
    expect(() => parseAssistRequest({ surface: 'video', video: { durationSeconds: -1 } })).toThrow('Video settings')
  })

  it('takes the direction lines the canvas composes in when it sends (C13), and refuses malformed ones', () => {
    expect(parseAssistRequest({ surface: 'video', direction: { cameraMove: ` ${MOVE} `, camera: CAMERA } })).toEqual({ surface: 'video', direction: { cameraMove: MOVE, camera: CAMERA } })
    expect(parseAssistRequest({ surface: 'image', direction: { camera: CAMERA } })).toEqual({ surface: 'image', direction: { camera: CAMERA } })
    // Empty lines are no direction.
    expect(parseAssistRequest({ surface: 'video', direction: { cameraMove: '  ', camera: '' } })).toEqual({ surface: 'video' })
    const code = (body: Record<string, unknown>): string | undefined => {
      try {
        parseAssistRequest(body)
      } catch (error) {
        return (error as AssistRequestError).code
      }
      return undefined
    }
    expect(code({ surface: 'video', direction: 'push in' })).toBe('CANVAS_ASSIST_DIRECTION_INVALID')
    expect(code({ surface: 'video', direction: { cameraMove: 3 } })).toBe('CANVAS_ASSIST_DIRECTION_INVALID')
    expect(code({ surface: 'video', direction: { camera: 'x'.repeat(601) } })).toBe('CANVAS_ASSIST_DIRECTION_INVALID')
    expect(code({ surface: 'video', direction: { camera: 'x'.repeat(600) } })).toBeUndefined()
    // A camera move is a video setting, like the video settings themselves.
    expect(code({ surface: 'image', direction: { cameraMove: MOVE } })).toBe('CANVAS_ASSIST_DIRECTION_INVALID')
  })
})

describe('what the model is asked', () => {
  it('directs a video prompt’s motion and sound, and keeps the answer bare', () => {
    const system = assistSystemPrompt({ surface: 'video', video: { durationSeconds: 5, generateAudio: false }, draft: '推门而入', language: '中文' })
    expect(system).toContain('a video generation model')
    expect(system).toContain('Include the motion')
    expect(system).toContain('Requested duration: 5 seconds.')
    expect(system).toContain('Audio generation is OFF.')
    expect(system).toContain('Keep their intent and their subject')
    expect(system).toContain('Answer in 中文.')
    expect(system).toContain('no preamble')
  })

  it('without direction, asks for the camera and its motion as before', () => {
    const system = assistSystemPrompt({ surface: 'video', purpose: 'shot' })
    expect(system).toContain('Describe subject, setting, light and camera in concrete terms.')
    expect(system).toContain('Include the motion: what moves, and how the camera moves.')
    expect(system).toContain('机位运动与声音')
    expect(system).not.toContain('chosen separately')
  })

  it('tells the writer the camera move is appended when sent, and no line still asks it to describe the camera\'s motion (C13, C.9)', () => {
    const system = assistSystemPrompt({ surface: 'video', purpose: 'shot', direction: { cameraMove: MOVE } })
    expect(system).toContain(`The camera movement is chosen separately and is appended when the prompt is sent:\n${MOVE}\nDo not describe camera movement or camera position changes.`)
    expect(system).toContain('Include the motion: what moves. A video prompt without motion is an image prompt.')
    expect(system).toContain('Describe subject, setting, light and framing in concrete terms.')
    expect(system).not.toContain('how the camera moves')
    expect(system).not.toContain('机位运动')
    expect(system).not.toContain('light and camera')
    expect(system).toContain('按当前镜头组织动作、人物位置与声音')
  })

  it('tells the writer the camera is appended when sent, and no line still asks it to describe the camera (C13, C.9)', () => {
    const image = assistSystemPrompt({ surface: 'image', direction: { camera: CAMERA } })
    expect(image).toContain(`Camera body, lens, focal length and aperture are chosen separately and appended when sent:\n${CAMERA}\n`
      + 'Do not describe cameras, lenses, depth of field or photographic equipment.')
    expect(image).toContain('Describe subject, setting and light in concrete terms.')
    expect(image).not.toContain('light and camera')
    // Both on a video: each line once, and the motion asked for without the camera's.
    const video = assistSystemPrompt({ surface: 'video', direction: { cameraMove: MOVE, camera: CAMERA } })
    expect(video.split(MOVE)).toHaveLength(2)
    expect(video.split(CAMERA)).toHaveLength(2)
    expect(video).toContain('Describe subject, setting and light in concrete terms.')
    expect(video).toContain('Include the motion: what moves. A video prompt')
    // A camera move on an image request (which parsing refuses) is not passed on.
    expect(assistSystemPrompt({ surface: 'image', direction: { cameraMove: MOVE } })).not.toContain(MOVE)
  })

  it('shows images, names the rest, and says so when an image cannot be shown', () => {
    const { parts, usedImages } = assistUserParts({
      surface: 'image',
      draft: '雨夜客栈',
      references: [
        { kind: 'image', title: '门口', dataUrl: PNG },
        { kind: 'image', title: '太大', dataUrl: `data:image/png;base64,${'A'.repeat(600_000)}` },
        { kind: 'text', title: '人物', text: '戴斗笠的陌生人' },
        { kind: 'video', title: '空镜' },
      ],
    })
    expect(usedImages).toBe(1)
    expect(parts).toEqual([
      { type: 'text', text: 'Draft so far:\n雨夜客栈' },
      { type: 'text', text: 'Wired references (4):' },
      { type: 'text', text: '1. 门口 (image)' },
      { type: 'image', dataUrl: PNG },
      { type: 'text', text: '2. 太大 (image, not shown)' },
      { type: 'text', text: '3. 人物 (note): 戴斗笠的陌生人' },
      { type: 'text', text: '4. 空镜 (video)' },
    ])
    expect(assistUserParts({ surface: 'image' }).parts[0]?.type).toBe('text')
  })
})
