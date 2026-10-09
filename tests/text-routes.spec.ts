/** Canvas text answers and the prompt writer over a stand-in for DSH's model services. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStudioRouter } from '../src/routes.js'
import type { LlmChunk, TextServices } from '../src/canvas/text-models.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-text-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const PNG = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`

/** A stand-in for `llm` + `agentDefaultModel` + `attachments`. */
function fakeServices(answer: LlmChunk[] = [{ type: 'text-delta', text: '雨夜，' }, { type: 'text-delta', text: '客栈。' }, { type: 'finish', reason: { kind: 'stop' } }], options: { images?: boolean; reasoningOff?: boolean } = {}) {
  const calls: Record<string, unknown>[] = []
  const saved: { mediaType: string; size: number }[] = []
  const services: TextServices = {
    llm: {
      listProviders: () => [{ id: 'deepseek-account', name: 'VibeDev' }, { id: 'deepseek-official', name: 'DeepSeek' }, { id: 'broken', name: 'Broken' }],
      listModels: async (provider) => {
        if (provider === 'broken') throw new Error('no key')
        return provider === 'deepseek-account' ? [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] : [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }]
      },
      resolveModelInfo: async () => ({ ...(options.images ? { inputModalities: ['text', 'image'] } : {}), ...(options.reasoningOff ? { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } } : {}) }),
      stream: (request) => {
        calls.push(request)
        return (async function* () { for (const chunk of answer) yield chunk })()
      },
    },
    defaults: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-v4-flash' }) },
    attachments: {
      saveImage: async (image) => {
        saved.push({ mediaType: image.mediaType, size: image.data.byteLength })
        return { ref: `att-${saved.length}` }
      },
    },
  }
  return { services, calls, saved }
}

async function call(router: ReturnType<typeof createStudioRouter>, path: string, json?: unknown) {
  const url = new URL(`http://host/api/dsh-film/${json === undefined ? 'studio' : 'studio-write'}`)
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', path)
  if (json !== undefined) url.searchParams.set('method', 'POST')
  return router.dispatch(new Request(url, json === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }))
}

describe('text models for the canvas', () => {
  it('lists every provider route’s models and says which provider could not answer', async () => {
    const router = createStudioRouter({ text: () => fakeServices().services })
    const listing = await (await call(router, '/api/canvas/models')).json() as any
    expect(listing.models).toEqual([
      { id: 'deepseek-official/deepseek-chat', modelId: 'deepseek-chat', label: 'DeepSeek Chat', providerId: 'deepseek-official', providerName: 'DeepSeek', source: 'byok', capability: 'text', protocol: 'dsh', available: true },
      { id: 'deepseek-account/deepseek-v4-flash', modelId: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', providerId: 'deepseek-account', providerName: 'VibeDev', source: 'gateway', capability: 'text', protocol: 'dsh', available: true },
    ])
    expect(listing.complete).toBe(false)
    expect(listing.warnings).toEqual([{ source: 'byok', providerId: 'broken', message: 'no key' }])
  })

  it('says whether it can answer and with which model', async () => {
    expect(await (await call(createStudioRouter({ text: () => fakeServices().services }), '/api/canvas/assist')).json()).toEqual({ available: true, model: 'deepseek-v4-flash' })
    expect(await (await call(createStudioRouter(), '/api/canvas/assist')).json()).toEqual({ available: false })
    expect(await (await call(createStudioRouter(), '/api/canvas/models')).json()).toEqual({ models: [], complete: true, warnings: [] })
  })
})

describe('a text node’s answer', () => {
  it('streams OpenAI-style deltas from the person’s default model, images attached when it sees them', async () => {
    const fake = fakeServices(undefined, { images: true })
    const response = await call(createStudioRouter({ text: () => fake.services }), '/api/canvas/chat', {
      messages: [
        { role: 'system', content: '你是编剧助手。' },
        { role: 'user', content: '这是哪里？' },
        { role: 'assistant', content: '一个客栈。' },
        { role: 'user', content: [{ type: 'text', text: '再看这张图' }, { type: 'image_url', image_url: { url: PNG } }] },
      ],
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('x-canvas-chat-model')).toBe('deepseek-v4-flash')
    expect(response.headers.get('x-canvas-chat-source')).toBe('gateway')
    expect(await response.text()).toBe('data: {"choices":[{"delta":{"content":"雨夜，"}}]}\n\ndata: {"choices":[{"delta":{"content":"客栈。"}}]}\n\ndata: [DONE]\n\n')
    const request = fake.calls[0]!
    expect(request).toMatchObject({ provider: 'deepseek-account', model: 'deepseek-v4-flash', system: '你是编剧助手。' })
    expect(request.messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: '先前的对话：\n用户：这是哪里？\n助手：一个客栈。\n\n现在：' },
      { type: 'text', text: '再看这张图' },
      { type: 'image', attachment: { ref: 'att-1' } },
    ] }])
    expect(fake.saved).toEqual([{ mediaType: 'image/png', size: 9 }])
  })

  it('tells a model that does not see images that one was there, and uses the model the canvas names', async () => {
    const fake = fakeServices()
    await (await call(createStudioRouter({ text: () => fake.services }), '/api/canvas/chat', {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }], model: 'deepseek-chat', providerId: 'deepseek-official', source: 'byok',
    })).text()
    expect(fake.calls[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat', messages: [{ role: 'user', content: [{ type: 'text', text: '[一张图片；当前模型不看图片]' }] }] })
    expect(fake.saved).toEqual([])
  })

  it('answers a refusal before the first word as an error the canvas reads, and one after it as a stream error', async () => {
    const signedOut = fakeServices([{ type: 'finish', reason: { kind: 'error', failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'sign in' } } }])
    const refused = await call(createStudioRouter({ text: () => signedOut.services }), '/api/canvas/chat', { messages: [{ role: 'user', content: '你好' }] })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ error: '请先登录 VibeDev 账号，再让画布里的文字节点回答。', code: 'ACCOUNT_SIGN_IN_REQUIRED' })
    const brokenOff = fakeServices([{ type: 'text-delta', text: '一半' }, { type: 'finish', reason: { kind: 'error', failure: { code: 'ACCOUNT_QUOTA_EXCEEDED', message: '402' } } }])
    const partial = await (await call(createStudioRouter({ text: () => brokenOff.services }), '/api/canvas/chat', { messages: [{ role: 'user', content: '你好' }] })).text()
    expect(partial).toBe('data: {"choices":[{"delta":{"content":"一半"}}]}\n\ndata: {"error":{"code":"ACCOUNT_QUOTA_EXCEEDED","message":"VibeDev 账号余额不足，请充值后重试。"}}\n\n')
    expect((await call(createStudioRouter({ text: () => brokenOff.services }), '/api/canvas/chat', { messages: [] })).status).toBe(400)
    expect((await call(createStudioRouter(), '/api/canvas/chat', { messages: [{ role: 'user', content: '你好' }] })).status).toBe(503)
  })
})

describe('the prompt writer', () => {
  it('passes the panorama projection all the way to the writer and rejects it on video before any model call', async () => {
    const fake = fakeServices()
    const router = createStudioRouter({ text: () => fake.services })
    const response = await call(router, '/api/canvas/assist/prompt', { surface: 'image', imageProjection: 'equirectangular', draft: '雨夜街道' })
    expect(response.status).toBe(200)
    expect(String(fake.calls[0]!.system)).toContain('360-degree full spherical equirectangular texture')
    const refused = await call(router, '/api/canvas/assist/prompt', { surface: 'video', imageProjection: 'equirectangular' })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ code: 'CANVAS_ASSIST_PROJECTION_INVALID' })
    expect(fake.calls).toHaveLength(1)
  })
  it('writes a prompt quickly from the wired references', async () => {
    const fake = fakeServices([{ type: 'text-delta', text: '  雨夜客栈门口，' }, { type: 'text-delta', text: '陌生人推门而入。 ' }, { type: 'finish', reason: { kind: 'stop' } }], { images: true, reasoningOff: true })
    const response = await call(createStudioRouter({ text: () => fake.services }), '/api/canvas/assist/prompt', {
      surface: 'video', video: { durationSeconds: 5, generateAudio: false }, draft: '推门', references: [{ kind: 'image', title: '门口', dataUrl: PNG }],
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ prompt: '雨夜客栈门口，陌生人推门而入。', model: 'deepseek-v4-flash', source: 'gateway', providerId: 'deepseek-account', usedReferences: 1 })
    expect(fake.calls[0]).toMatchObject({ reasoningEffort: 'off', maxTokens: 2048 })
    expect(String(fake.calls[0]!.system)).toContain('Audio generation is OFF.')
    expect((fake.calls[0]!.messages as any)[0].content.some((part: { type: string }) => part.type === 'image')).toBe(true)
  })

  it('passes the canvas\'s direction lines to the writer\'s system prompt, and refuses malformed ones (C13)', async () => {
    const fake = fakeServices()
    const router = createStudioRouter({ text: () => fake.services })
    const move = '运镜：镜头缓慢地向后拉远，主体变小，周围环境逐渐显露。'
    const response = await call(router, '/api/canvas/assist/prompt', { surface: 'video', purpose: 'shot', draft: '雨夜', direction: { cameraMove: move } })
    expect(response.status).toBe(200)
    const system = String(fake.calls[0]!.system)
    expect(system).toContain(`appended when the prompt is sent:\n${move}\nDo not describe camera movement`)
    expect(system).not.toContain('how the camera moves')
    const refused = await call(router, '/api/canvas/assist/prompt', { surface: 'image', direction: { cameraMove: move } })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ code: 'CANVAS_ASSIST_DIRECTION_INVALID' })
    expect(fake.calls).toHaveLength(1)
  })

  it('writes in the structure of the node\'s skills and says how many it was given, so the canvas marks them written (C13)', async () => {
    const fake = fakeServices()
    const router = createStudioRouter({ text: () => fake.services })
    const skills = [{ name: '分镜画面描述', template: '分镜画面：{{prompt}}\n场景：{{setting}}。', negative: '水印' }, { name: '风格统一', template: '统一风格：水墨。' }]
    const response = await call(router, '/api/canvas/assist/prompt', { surface: 'image', draft: '雨夜', skills })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ prompt: '雨夜，客栈。', appliedSkills: 2 })
    expect(String(fake.calls[0]!.system)).toContain('Template 1 (分镜画面描述):\n分镜画面：{{prompt}}\n场景：{{setting}}。\nAvoid terms: 水印')
    // A request without skills is answered as before, without the count.
    expect(await (await call(router, '/api/canvas/assist/prompt', { surface: 'image', draft: '雨夜' })).json()).not.toHaveProperty('appliedSkills')
    const refused = await call(router, '/api/canvas/assist/prompt', { surface: 'image', skills: [...skills, ...skills] })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ code: 'CANVAS_ASSIST_SKILLS_INVALID' })
    expect(fake.calls).toHaveLength(2)
  })

  it('uses the writer the canvas picked and refuses empty or invalid requests', async () => {
    const fake = fakeServices([{ type: 'finish', reason: { kind: 'stop' } }])
    const router = createStudioRouter({ text: () => fake.services })
    const empty = await call(router, '/api/canvas/assist/prompt', { surface: 'image', writer: { model: 'deepseek-chat', providerId: 'deepseek-official' } })
    expect(empty.status).toBe(502)
    expect(fake.calls[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect((await call(router, '/api/canvas/assist/prompt', { surface: 'audio' })).status).toBe(400)
  })
})
