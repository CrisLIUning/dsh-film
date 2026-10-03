/** The canvas prompt writer's request checking and the words it sends a model. */

import { describe, expect, it } from 'vitest'
import { AssistRequestError, assistSystemPrompt, assistUserParts, parseAssistRequest } from '../src/canvas/assist-prompt.js'

const PNG = `data:image/png;base64,${'A'.repeat(64)}`

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
