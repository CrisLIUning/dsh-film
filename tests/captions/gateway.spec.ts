/**
 * The gateway engine: speech regions cut by a stand-in runner page, each sent
 * to a fake dsh-media `transcribe`, timed by the region unless the gateway
 * returns timings; and its refusals, spending and cancellation.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gatewayEngine, gatewayEstimate, readRegions } from '../../src/captions/gateway.js'
import { CaptionRunnerHub, captionRunnerRoutes } from '../../src/captions/runner.js'
import type { HostMediaModel } from '../../src/media/catalogue.js'
import type { MediaServiceLike, TranscribeServiceRequest, TranscribeServiceResult, TranscribeSpending } from '../../src/media/tasks.js'
import { PROJECT, workspace } from './fixture.js'
import type { Workspace } from './fixture.js'
import { captionModels, openWindow, post } from './pages.js'
import type { RunnerWindow } from './pages.js'

/** A 16 kHz mono 16-bit WAV of `seconds` of silence, base64. */
function wav(seconds: number): string {
  const samples = Math.round(seconds * 16_000)
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0, 'latin1')
  bytes.writeUInt32LE(36 + samples * 2, 4)
  bytes.write('WAVEfmt ', 8, 'latin1')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24)
  bytes.writeUInt32LE(32_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'latin1')
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes.toString('base64')
}

const MODEL: HostMediaModel = {
  id: 'doubao-asr-vibedev', name: '豆包转写', kind: 'transcription', inputModalities: ['audio'],
  pricing: { currency: 'CNY', tiers: [{ tier: 'default', unit: 'second', amount: 0.05 / 60 }] },
}

interface Call { request: TranscribeServiceRequest; cwd: string; signal: AbortSignal; spending: TranscribeSpending | undefined }

/** A fake dsh-media: one transcription model, and `answer` deciding each transcription. */
function fakeMedia(answer: (call: Call) => Promise<TranscribeServiceResult> | TranscribeServiceResult, options: { withTranscribe?: boolean; models?: () => Promise<readonly HostMediaModel[]> } = {}) {
  const calls: Call[] = []
  const media: MediaServiceLike = {
    models: options.models ?? (async () => [{ id: 'gpt-image', name: 'image', kind: 'image', inputModalities: [] }, MODEL]),
    generateImages: async () => { throw new Error('unused') },
    startVideo: async () => { throw new Error('unused') },
    task: async () => undefined,
    onTask: () => () => {},
    ...(options.withTranscribe === false ? {} : {
      transcribe: async (request: TranscribeServiceRequest, target: { cwd: string }, signal: AbortSignal, spending?: TranscribeSpending) => {
        const call = { request, cwd: target.cwd, signal, spending }
        calls.push(call)
        return answer(call)
      },
    }),
  }
  return { media, calls }
}

let modelsRoot: string
let models: ReturnType<typeof captionModels>
let hub: CaptionRunnerHub
let routes: ReturnType<typeof captionRunnerRoutes>
const windows: RunnerWindow[] = []
const cleanups: Array<() => Promise<void>> = []

beforeEach(async () => {
  modelsRoot = await mkdtemp(join(tmpdir(), 'dsh-film-gateway-models-'))
  models = captionModels(modelsRoot)
  await models.setConsent('silero-vad', true)
  hub = new CaptionRunnerHub({ claimTimeoutMs: 2000 })
  routes = captionRunnerRoutes(hub)
})

afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
  hub.dispose()
  for (const window of windows.splice(0)) window.close()
  models.dispose()
  await models.whenIdle()
  await rm(modelsRoot, { recursive: true, force: true })
})

async function setup(media: () => MediaServiceLike | undefined): Promise<Workspace> {
  const h = await workspace({ gateway: gatewayEngine({ media, models, runner: hub, pollMs: 5 }) })
  cleanups.push(h.cleanup)
  return h
}

const open = async (): Promise<RunnerWindow> => {
  const window = await openWindow(routes)
  windows.push(window)
  return window
}

/** Play the runner page: claim the extract job and post these regions (source-file seconds). */
async function cutRegions(window: RunnerWindow, regions: Record<string, Array<{ start: number; end: number }>>): Promise<any> {
  const job = await window.next('job', 5000)
  const claim = await post(routes, 'claim', { runnerId: window.runnerId, jobId: job.jobId })
  expect(claim.body).toMatchObject({ kind: 'extract', language: 'zh', artifacts: { 'speech-vad': '/api/dsh-film/models/silero-vad/abc1234/speech-vad' } })
  await post(routes, 'progress', { runnerId: window.runnerId, jobId: job.jobId, progress: 1, phase: '语音分段' })
  const result = claim.body.sources.map((source: any) => ({
    sourceClipId: source.clipId,
    regions: (regions[source.clipId] ?? []).map(region => ({ ...region, wav: wav(region.end - region.start) })),
  }))
  expect((await post(routes, 'result', { runnerId: window.runnerId, jobId: job.jobId, result })).status).toBe(200)
  return claim.body
}

describe('gateway engine', () => {
  it('transcribes each speech region once, timed by the region, with stable keys and names', async () => {
    const { media, calls } = fakeMedia(({ request }) => ({ model: 'doubao-asr-vibedev', text: request.name === 'region-0-0.wav' ? '你好' : request.name === 'region-1-0.wav' ? '再见' : '', language: 'zh', name: request.name!, taskId: `gw-${request.name}`, chargedCny: '0.01' }))
    const h = await setup(() => media)
    const window = await open()
    const started = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'gw', engine: 'gateway', spendingConfirmed: true })
    expect(started).toMatchObject({ engine: 'gateway', model: 'gateway:doubao-asr-vibedev', estimate: { seconds: 11, amountCny: 0.01, basis: expect.stringContaining('catalogue') } })
    const claim = await cutRegions(window, { a: [{ start: 2.75, end: 4.4 }, { start: 9, end: 9.8 }], b: [{ start: 0.5, end: 1.5 }] })
    expect(claim.sources.map((source: any) => [source.clipId, source.sourceIn, source.sourceOut])).toEqual([['a', 2, 10], ['b', 0, 3]])
    await h.service.whenIdle()
    expect(calls.map(call => [call.request.name, call.request.idempotencyKey, call.request.mimeType, call.request.language, call.request.timestamps, call.request.background])).toEqual([
      ['region-0-0.wav', `dsh-film-asr:${started.taskId}:0:0`, 'audio/wav', 'zh', true, true],
      ['region-0-1.wav', `dsh-film-asr:${started.taskId}:0:1`, 'audio/wav', 'zh', true, true],
      ['region-1-0.wav', `dsh-film-asr:${started.taskId}:1:0`, 'audio/wav', 'zh', true, true],
    ])
    expect(calls.every(call => call.cwd === h.cwd && call.spending?.confirmed === true && call.request.model === undefined)).toBe(true)
    expect(calls[0]!.request.data!.byteLength).toBe(44 + Math.round(1.65 * 16_000) * 2)
    const task = await h.tasks.record(h.cwd, started.taskId)
    expect(task?.status).toBe('done')
    const draft = task?.file?.documentResult as any
    expect(draft).toMatchObject({ engine: 'gateway', model: 'gateway:doubao-asr-vibedev' })
    // a plays source 2..10 at double speed from 0; b plays from 4. An empty region adds no line.
    expect(draft.segments.map((line: any) => [line.text, line.start, line.end, line.sourceIn, line.sourceOut, line.warnings])).toEqual([
      ['你好', 0.375, 1.2000000000000002, 2.75, 4.4, ['region-timing']],
      ['再见', 4.5, 5.5, 0.5, 1.5, ['region-timing']],
    ])
    expect(draft.diagnostics[0].evidence).toMatchObject({ engine: 'gateway', mode: 'region', model: 'doubao-asr-vibedev', regions: [{ gatewayTaskId: 'gw-region-0-0.wav', chargedCny: '0.01', timing: 'region' }, { timing: 'empty' }] })
  })

  it('uses the gateway\'s own segment timings when it returns them, offset by the region', async () => {
    const { media } = fakeMedia(() => ({ model: 'doubao-asr-vibedev', text: '一 二', language: 'zh', name: 'x', segments: [{ start: 0.1, end: 0.5, text: '一' }, { start: 0.6, end: 5, text: '二' }, { start: 0.7, end: 0.7, text: 'bad' }] }))
    const h = await setup(() => media)
    const window = await open()
    const started = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'timed', engine: 'gateway', clipIds: ['b'] })
    await cutRegions(window, { b: [{ start: 1, end: 2 }] })
    await h.service.whenIdle()
    const draft = (await h.tasks.record(h.cwd, started.taskId))?.file?.documentResult as any
    // Clamped to the region: a timing past its end stops there.
    expect(draft.segments.map((line: any) => [line.text, line.sourceIn, line.sourceOut, line.warnings])).toEqual([
      ['一', 1.1, 1.5, undefined],
      ['二', 1.6, 2, undefined],
    ])
  })

  it('refuses before a task: no window, no dsh-media, an old dsh-media, not signed in, another language, no consent', async () => {
    const { media } = fakeMedia(() => { throw new Error('unused') })
    const h = await setup(() => media)
    const start = (extra: Record<string, unknown> = {}) => h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: `r-${Math.random()}`, engine: 'gateway', ...extra })
    await expect(start()).rejects.toMatchObject({ code: 'CAPTION_RUNTIME_UNAVAILABLE', status: 503 })
    await expect(start({ language: 'en' })).rejects.toMatchObject({ code: 'CAPTION_ENGINE_LANGUAGE_UNSUPPORTED', status: 400 })
    const missing = await workspace({ gateway: gatewayEngine({ media: () => undefined, models, runner: hub }) })
    cleanups.push(missing.cleanup)
    await expect(missing.service.start(missing.cwd, PROJECT, { baseRevision: 1, requestId: 'm', engine: 'gateway' })).rejects.toMatchObject({ code: 'CAPTION_ENGINE_UNAVAILABLE', status: 503, extra: { cause: 'MEDIA_SERVICE_UNAVAILABLE' } })
    const old = fakeMedia(() => { throw new Error('unused') }, { withTranscribe: false })
    const outdated = await workspace({ gateway: gatewayEngine({ media: () => old.media, models, runner: hub }) })
    cleanups.push(outdated.cleanup)
    await expect(outdated.service.start(outdated.cwd, PROJECT, { baseRevision: 1, requestId: 'o', engine: 'gateway' })).rejects.toMatchObject({ extra: { cause: 'MEDIA_TRANSCRIBE_UNSUPPORTED' } })
    const signedOut = fakeMedia(() => { throw new Error('unused') }, { models: async () => { throw Object.assign(new Error('sign in'), { code: 'NOT_SIGNED_IN' }) } })
    const anonymous = await workspace({ gateway: gatewayEngine({ media: () => signedOut.media, models, runner: hub }) })
    cleanups.push(anonymous.cleanup)
    await expect(anonymous.service.start(anonymous.cwd, PROJECT, { baseRevision: 1, requestId: 's', engine: 'gateway' })).rejects.toMatchObject({ code: 'CAPTION_ENGINE_UNAVAILABLE', extra: { cause: 'NOT_SIGNED_IN' } })
    const noModel = fakeMedia(() => { throw new Error('unused') }, { models: async () => [] })
    const empty = await workspace({ gateway: gatewayEngine({ media: () => noModel.media, models, runner: hub }) })
    cleanups.push(empty.cleanup)
    await expect(empty.service.start(empty.cwd, PROJECT, { baseRevision: 1, requestId: 'n', engine: 'gateway' })).rejects.toMatchObject({ extra: { cause: 'NO_MODEL_AVAILABLE' } })
    await models.setConsent('silero-vad', false)
    await expect(start()).rejects.toMatchObject({ code: 'VIDEO_EDITOR_MODEL_CONSENT_REQUIRED', status: 409, extra: { modelIds: ['silero-vad'] } })
    expect(await h.tasks.list(h.cwd)).toEqual([])
  })

  it('lets dsh-media\'s setting confirm the cost of an agent\'s recognition', async () => {
    const { media, calls } = fakeMedia(() => ({ model: 'doubao-asr-vibedev', text: '好', language: 'zh', name: 'x' }))
    const h = await setup(() => media)
    const window = await open()
    const agent = { id: 'agent-1' }
    await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'agent', engine: 'gateway', clipIds: ['b'] }, { agent, callId: 'call-7' })
    await cutRegions(window, { b: [{ start: 0, end: 1 }] })
    await h.service.whenIdle()
    expect(calls[0]!.spending).toEqual({ confirmed: false, agent, callId: 'call-7' })
  })

  it('records dsh-media failures by their code, and a cancel as a cancel', async () => {
    const { media } = fakeMedia(() => { throw Object.assign(new Error('balance'), { code: 'INSUFFICIENT_BALANCE' }) })
    const h = await setup(() => media)
    const window = await open()
    const poor = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'poor', engine: 'gateway', clipIds: ['b'] })
    await cutRegions(window, { b: [{ start: 0, end: 1 }] })
    await h.service.whenIdle()
    expect((await h.tasks.record(h.cwd, poor.taskId))?.error).toMatchObject({ code: 'INSUFFICIENT_BALANCE', status: 402, message: 'VibeDev 余额不足，充值后再试。' })

    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const slow = fakeMedia(({ signal }) => new Promise((_resolve, reject) => {
      entered()
      signal.addEventListener('abort', () => { reject(Object.assign(new Error('stopped waiting'), { code: 'ABORTED' })) })
    }))
    const k = await setup(() => slow.media)
    const started = await k.service.start(k.cwd, PROJECT, { baseRevision: 1, requestId: 'slow', engine: 'gateway', clipIds: ['b'] })
    await cutRegions(window, { b: [{ start: 0, end: 1 }, { start: 2, end: 2.5 }] })
    await waiting
    await k.tasks.cancel(k.cwd, started.taskId)
    await k.service.whenIdle()
    expect(await k.tasks.record(k.cwd, started.taskId)).toMatchObject({ status: 'interrupted', error: { code: 'MEDIA_TASK_CANCELED' } })
    // The second region was never sent.
    expect(slow.calls).toHaveLength(1)
    expect(slow.calls[0]!.signal.aborted).toBe(true)
  })

  it('describes itself for the engine choice', async () => {
    const { media } = fakeMedia(() => { throw new Error('unused') })
    const engine = gatewayEngine({ media: () => media, models, runner: hub })
    expect(await engine.describe()).toMatchObject({ id: 'gateway', available: false, languages: ['zh'], limits: { maxSeconds: 600, maxBytes: 20_000_000 }, model: 'doubao-asr-vibedev', runner: 'none', consent: { 'silero-vad': true } })
    await open()
    expect(await engine.describe()).toMatchObject({ available: true, model: 'doubao-asr-vibedev', pricePerMinuteCny: 0.05, runner: 'connected' })
    expect(await gatewayEngine({ media: () => undefined, models, runner: hub }).describe()).toMatchObject({ available: false, cause: 'MEDIA_SERVICE_UNAVAILABLE' })
  })
})

describe('gateway helpers', () => {
  it('estimates from the catalogue per second, else the retail per-minute price', () => {
    expect(gatewayEstimate(MODEL, 600)).toEqual({ seconds: 600, amountCny: 0.5, basis: expect.stringContaining('catalogue') })
    expect(gatewayEstimate({ ...MODEL, pricing: undefined }, 120)).toEqual({ seconds: 120, amountCny: 0.1, basis: expect.stringContaining('retail') })
  })

  it('refuses malformed region results', () => {
    const sources = [{ clipId: 'a', file: 'x', sourceIn: 0, sourceOut: 5 }]
    expect(readRegions([{ sourceClipId: 'a', regions: [{ start: 0, end: 1, wav: wav(1) }] }], sources).get('a')).toHaveLength(1)
    for (const value of [
      {}, [{ sourceClipId: 'b', regions: [] }], [], [{ sourceClipId: 'a', regions: [{ start: 1, end: 1, wav: wav(1) }] }],
      [{ sourceClipId: 'a', regions: [{ start: 0, end: 1, wav: Buffer.from('not a wav file at all, but long enough to have a header....').toString('base64') }] }],
      [{ sourceClipId: 'a', regions: [] }, { sourceClipId: 'a', regions: [] }],
    ]) expect(() => readRegions(value, sources)).toThrow(/CAPTION_RESULT_INVALID/)
  })
})
