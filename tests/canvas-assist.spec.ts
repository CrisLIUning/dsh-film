/** The canvas prompt writer's request checking and the words it sends a model. */

import { describe, expect, it } from 'vitest'
import { AssistRequestError, assistSystemPrompt, assistUserParts, parseAssistRequest } from '../src/canvas/assist-prompt.js'

const PNG = `data:image/png;base64,${'A'.repeat(64)}`
/** Lines as the canvas renders them (camera-moves.ts, camera-direction.ts). */
const MOVE = '运镜：镜头平稳地向前推进，逐渐靠近主体。'
const CAMERA = '拍摄方式（只描述成像，不要在画面里出现相机或摄影器材）：35mm 电影胶片质感，颗粒细腻、色彩温润、对比柔和；球面定焦镜头，成像锐利、畸变小；85mm，人像焦距，背景压缩；光圈 f/2，浅景深，背景柔和虚化。'
/** A skill template as the canvas sends it to the writer (renderSkillForWriter): the values filled in, {{prompt}} and the empty variables left to fill. */
const FRAME = '分镜画面：{{prompt}}\n景别：中景；主体位于画面三分线处；前景、中景、背景层次清楚，视线方向明确。\n场景：{{setting}}；时间与天气：{{time}}。'

describe('prompt writer requests', () => {
  it('accepts only the spherical panorama projection on image requests', () => {
    expect(parseAssistRequest({ surface: 'image', imageProjection: 'equirectangular', draft: '雨夜街道' })).toEqual({ surface: 'image', imageProjection: 'equirectangular', draft: '雨夜街道' })
    for (const imageProjection of ['normal', 1, null, {}]) {
      expect(() => parseAssistRequest({ surface: 'image', imageProjection })).toThrow('imageProjection must be equirectangular')
    }
    expect(() => parseAssistRequest({ surface: 'video', imageProjection: 'equirectangular' })).toThrow('on an image prompt')
  })
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

  it('takes up to three prompt skills within 4000 characters (C13), and refuses malformed ones', () => {
    const frame = { name: '分镜画面描述', template: FRAME, negative: ' 分格拼贴、水印 ' }
    expect(parseAssistRequest({ surface: 'image', skills: [frame, { name: ' 风格统一 ', template: '统一风格：水墨。' }] })).toEqual({
      surface: 'image', skills: [{ name: '分镜画面描述', template: FRAME, negative: '分格拼贴、水印' }, { name: '风格统一', template: '统一风格：水墨。' }],
    })
    // No skills is no skills.
    expect(parseAssistRequest({ surface: 'video', skills: [] })).toEqual({ surface: 'video' })
    const code = (skills: unknown): string | undefined => {
      try {
        parseAssistRequest({ surface: 'image', skills })
      } catch (error) {
        return (error as AssistRequestError).code
      }
      return undefined
    }
    expect(code([frame, frame, frame, frame])).toBe('CANVAS_ASSIST_SKILLS_INVALID')
    expect(code('frame')).toBe('CANVAS_ASSIST_SKILLS_INVALID')
    expect(code([{ name: 'x'.repeat(61), template: 'x' }])).toBe('CANVAS_ASSIST_SKILLS_INVALID')
    expect(code([{ name: 'x', template: '  ' }])).toBe('CANVAS_ASSIST_SKILLS_INVALID')
    expect(code([{ name: 'x', template: 'x', negative: ['水印'] }])).toBe('CANVAS_ASSIST_SKILLS_INVALID')
    // Counted as the canvas counts what it sends: each template with its avoid terms.
    expect(code([{ name: 'a', template: 'x'.repeat(3000) }, { name: 'b', template: 'x'.repeat(990), negative: 'y'.repeat(10) }])).toBeUndefined()
    expect(code([{ name: 'a', template: 'x'.repeat(3000) }, { name: 'b', template: 'x'.repeat(990), negative: 'y'.repeat(11) }])).toBe('CANVAS_ASSIST_SKILLS_INVALID')
  })
})

describe('what the model is asked', () => {
  it('writes a seamless full spherical scene rather than a framed ordinary image', () => {
    const request = parseAssistRequest({ surface: 'image', imageProjection: 'equirectangular', draft: '雨夜街道' })
    const system = assistSystemPrompt(request)
    expect(system).toContain('3D panorama viewer, not an ordinary framed image')
    expect(system).toContain('2:1 aspect ratio, continuous left and right edges')
    expect(system).toContain('surroundings in every direction')
    expect(system).toContain('without duplicating that fixed prefix')
    expect(system).not.toContain('LOCAL CLOCK')
    expect(system).not.toContain('light and camera in concrete terms')
    expect(assistSystemPrompt({ surface: 'image' })).not.toContain('equirectangular')
    expect(assistUserParts(request).parts[0]).toEqual({ type: 'text', text: 'Draft so far:\n雨夜街道' })
  })
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

  it.each([6, 15])('keeps narrative pacing within the requested %s seconds without changing settings', (durationSeconds) => {
    const request = parseAssistRequest({ surface: 'video', purpose: 'shot', video: { durationSeconds, aspect: '16:9', generateAudio: false }, draft: 'A visitor returns a letter and waits for a response.' })
    const system = assistSystemPrompt(request)
    expect(system).toContain(`cover the main action continuously from 0 to ${durationSeconds} seconds, without gaps or overruns`)
    expect(system).toContain(`All action and audio time labels must stay within 0-${durationSeconds} seconds: no negative times, delayed start or end past ${durationSeconds} seconds`)
    expect(system).toContain('a shot or action beat roughly every 2-3 seconds')
    expect(system).toContain('a pacing suggestion, not a requirement to cut')
    expect(system).toContain('longer beats for complex narrative, necessary dialogue or an explicit long take')
    expect(system).toContain('within the requested duration')
    expect(request.video).toEqual({ durationSeconds, aspect: '16:9', generateAudio: false })
    expect(system).toContain('Audio generation is OFF.')
  })

  it('resets the local clock for each of two independently generated consecutive clips', () => {
    const drafts = ['第一段，全局1-30秒：人物走进咖啡馆。', '第二段，全局31-60秒：人物坐下并交还信件。']
    for (const draft of drafts) {
      const request = parseAssistRequest({ surface: 'video', video: { durationSeconds: 30 }, draft })
      const system = assistSystemPrompt(request)
      expect(system).toContain('Every independently generated video clip MUST use a LOCAL CLOCK starting at 0 seconds, including every later clip in a continuous screenplay')
      expect(system).toContain('cover the main action continuously from 0 to 30 seconds, without gaps or overruns')
      expect(system).toContain('The requested clip duration is the local endpoint; global segment labels do not change it')
      expect(assistUserParts(request).parts[0]).toEqual({ type: 'text', text: `Draft so far:\n${draft}` })
      expect(request.video?.durationSeconds).toBe(30)
    }
  })

  it('instructs the writer to convert global segment and beat times before the model action timeline', () => {
    const draft = '第二段全局31-60秒。全局31-35秒：把信递给对方；其后等待回应。'
    const reference = { kind: 'text', title: '全剧本剪辑时间', text: '第一段1-30秒；第二段31-60秒。' }
    const request = parseAssistRequest({ surface: 'video', video: { durationSeconds: 30 }, draft, references: [reference] })
    const system = assistSystemPrompt(request)
    expect(system).toContain('Global screenplay start/end times are editing or segment metadata only')
    expect(system).toContain('Never put them in the action or audio timeline sent to the video model')
    expect(system).toContain("Convert source beats to elapsed time from this clip's start before writing the final prompt")
    expect(system).toContain('Conversion example only: a global 31-60-second segment requested as a 30-second clip uses local 0-30 seconds; its global 31-35-second beat becomes local 0-4 seconds')
    expect(system).toContain('All action and audio time labels must stay within 0-30 seconds: no negative times, delayed start or end past 30 seconds')
    expect(system).toContain('do not copy global timestamps or label both clocks')
    expect(assistUserParts(request).parts).toContainEqual({ type: 'text', text: `Draft so far:\n${draft}` })
    expect(request.references).toEqual([reference])
  })

  it('keeps an explicit long take while applying the mandatory local clock to a later clip', () => {
    const draft = '全剧本第二段31-60秒：一个长镜头完整演完，保留停顿，不切镜头。'
    const request = parseAssistRequest({ surface: 'video', video: { durationSeconds: 30 }, draft })
    const system = assistSystemPrompt(request)
    expect(system).toContain('This clock rule is mandatory even for an explicit single shot or long take')
    expect(system).toContain('cover the main action continuously from 0 to 30 seconds, without gaps or overruns')
    expect(system).toContain('preserve a requested single shot, long take or framing')
    expect(system).toContain('action beats can stay within one continuous shot')
    expect(assistUserParts(request).parts[0]).toEqual({ type: 'text', text: `Draft so far:\n${draft}` })
  })

  it('gives a multi-shot narrative clear relationships, motivated views, performance and real reference tokens', () => {
    const draft = '@图片1 林把信交还给同桌的人；@图片2 是咖啡馆。用多个镜头交代交还和对方的反应。'
    const request = parseAssistRequest({ surface: 'video', video: { durationSeconds: 15 }, draft, references: [{ kind: 'image', title: '@图片1 林', dataUrl: PNG }, { kind: 'text', title: '@图片2 咖啡馆', text: '两人隔桌而坐。' }] })
    const system = assistSystemPrompt(request)
    expect(system).toContain('preserve any reference tokens actually supplied; never invent tokens or identities')
    expect(system).toContain('who is present, where they are, their established relationships and spatial positions')
    expect(system).toContain('Each cut needs a narrative purpose')
    expect(system).toContain('over-the-shoulder views, close-ups, following an action, reaction shots or shot/reverse-shot')
    expect(system).toContain('one main action per shot')
    expect(system).toContain('natural micro-actions and facial expressions')
    expect(system).toContain('brief dialogue that fits the performance')
    expect(system).toContain('adjacent time ranges for a multi-shot narrative')
    expect(assistUserParts(request).parts).toContainEqual({ type: 'text', text: `Draft so far:\n${draft}` })
    expect(assistUserParts(request).parts).toContainEqual({ type: 'text', text: '2. @图片2 咖啡馆 (note): 两人隔桌而坐。' })
  })

  it.each([
    'Single continuous shot, no cuts: the visitor hands over the letter and waits.',
    '一个固定机位长镜头，不切镜头，保留整句对白和停顿。',
  ])('puts explicit single-shot intent ahead of default pacing: %s', (draft) => {
    const request = parseAssistRequest({ surface: 'video', video: { durationSeconds: 15 }, draft })
    const system = assistSystemPrompt(request)
    const priority = 'Explicit user filming or editing instructions take priority over these pacing suggestions'
    expect(system).toContain(priority)
    expect(system.indexOf(priority)).toBeLessThan(system.indexOf('roughly every 2-3 seconds'))
    expect(system).toContain('preserve a requested single shot, long take or framing')
    expect(system).toContain('action beats can stay within one continuous shot')
    expect(assistUserParts(request).parts[0]).toEqual({ type: 'text', text: `Draft so far:\n${draft}` })
    expect(request.video?.durationSeconds).toBe(15)
  })

  it('preserves explicit video-edit instructions and does not add cuts to non-narrative footage', () => {
    const draft = 'Only adjust the lighting of this product loop. Preserve the existing edit and shot order; do not introduce cuts.'
    const request = parseAssistRequest({ surface: 'video', video: { durationSeconds: 6 }, draft, references: [{ kind: 'video', title: 'Original product loop' }] })
    const system = assistSystemPrompt(request)
    expect(system).toContain('For video edits, preserve the existing cut structure and shot order unless the user asks to change them')
    expect(system).toContain('For non-narrative footage, do not impose multiple shots or extra story beats')
    expect(assistUserParts(request).parts[0]).toEqual({ type: 'text', text: `Draft so far:\n${draft}` })
    expect(request.references).toEqual([{ kind: 'video', title: 'Original product loop' }])
  })

  it('does not invent a timeline endpoint without a duration or add video pacing to ordinary images', () => {
    const video = assistSystemPrompt({ surface: 'video' })
    expect(video).toContain('Duration is not specified here: do not invent a fixed duration.')
    expect(video).toContain('LOCAL CLOCK starting at 0 seconds')
    expect(video).not.toContain('cover the main action continuously from 0 to')
    for (const request of [{ surface: 'image' as const }, { surface: 'image' as const, purpose: 'shot' as const }]) {
      const image = assistSystemPrompt(request)
      expect(image).toContain('Name what is in the references rather than referring to them by number.')
      for (const phrase of ['LOCAL CLOCK', 'Global screenplay start/end times', 'roughly every 2-3 seconds', 'main action continuously from 0', 'Each cut needs a narrative purpose', 'For video edits', 'For non-narrative footage']) expect(image).not.toContain(phrase)
    }
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
    expect(system).not.toContain('following an action')
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

  it('asks for the structure of the node\'s skills, with their templates and one merged avoid line (C13)', () => {
    const system = assistSystemPrompt({ surface: 'image', draft: '林推门而入', skills: [{ name: '分镜画面描述', template: FRAME, negative: '分格拼贴、水印' }, { name: '风格统一', template: '统一风格：水墨。' }] })
    expect(system).toContain('Write the prompt in the structure of the template(s) below. Fill each line from the draft and the references, drop a line you cannot fill, '
      + 'never output {{placeholders}}, and end with one line starting 避免： (Avoid: when you answer in English) that merges their avoid terms.')
    expect(system).toContain(`Template 1 (分镜画面描述):\n${FRAME}\nAvoid terms: 分格拼贴、水印\nTemplate 2 (风格统一):\n统一风格：水墨。\n`)
    expect(system).toContain('{{prompt}} marks where the draft\'s own description goes')
    // The skills come before the model and language lines, and the answer stays bare.
    expect(system.indexOf('Template 1')).toBeLessThan(system.indexOf('Answer in'))
    expect(system).toContain('no preamble')
    // Without avoid terms there is no avoid line to write; without skills, none of this.
    const plain = assistSystemPrompt({ surface: 'image', skills: [{ name: '风格统一', template: '统一风格：水墨。' }] })
    expect(plain).toContain('never output {{placeholders}}.')
    expect(plain).not.toContain('避免')
    expect(assistSystemPrompt({ surface: 'image' })).not.toContain('Template 1')
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
