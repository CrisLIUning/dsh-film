/**
 * The caption runner: jobs offered to every open window over the real event
 * route, claimed by the first page, followed and ended through the real Host
 * routes; and the whisper engine end to end with a stand-in page.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { whisperEngine } from '../../src/captions/engines.js'
import { CaptionRunnerHub, captionRunnerRoutes } from '../../src/captions/runner.js'
import type { RunnerJobSpec } from '../../src/captions/runner.js'
import { PROJECT, workspace } from './fixture.js'
import { captionModels, getSource, openWindow, post } from './pages.js'
import type { RunnerWindow } from './pages.js'

let dir: string
let hub: CaptionRunnerHub
let routes: ReturnType<typeof captionRunnerRoutes>
const windows: RunnerWindow[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-film-runner-'))
  await writeFile(join(dir, 'source.mp4'), 'the source bytes')
  hub = new CaptionRunnerHub({ claimTimeoutMs: 300, deadlineMs: 2000 })
  routes = captionRunnerRoutes(hub)
})

afterEach(async () => {
  hub.dispose()
  for (const window of windows.splice(0)) window.close()
  await rm(dir, { recursive: true, force: true })
})

const open = async (): Promise<RunnerWindow> => {
  const window = await openWindow(routes)
  windows.push(window)
  return window
}

const spec = (): RunnerJobSpec => ({
  kind: 'whisper', language: 'zh',
  sources: [{ clipId: 'a', file: join(dir, 'source.mp4'), sourceIn: 1, sourceOut: 3 }],
  artifacts: { 'speech-vad': '/api/dsh-film/models/silero-vad/r/speech-vad' },
})

describe('caption runner hub', () => {
  it('offers a job to every window; the first claim wins and the others are told', async () => {
    const [first, second] = [await open(), await open()]
    const result = hub.run(spec(), { signal: new AbortController().signal })
    const job = await first.next('job')
    expect(await second.next('job')).toEqual(job)
    expect(job.kind).toBe('whisper')
    const [won, lost] = await Promise.all([
      post(routes, 'claim', { runnerId: second.runnerId, jobId: job.jobId }),
      post(routes, 'claim', { runnerId: first.runnerId, jobId: job.jobId }).then(async (answer) => { await new Promise(resolve => setTimeout(resolve, 0)); return answer }),
    ])
    expect(won.status).toBe(200)
    expect(won.body).toMatchObject({ jobId: job.jobId, kind: 'whisper', language: 'zh', artifacts: { 'speech-vad': '/api/dsh-film/models/silero-vad/r/speech-vad' } })
    expect(won.body.sources).toMatchObject([{ clipId: 'a', sourceIn: 1, sourceOut: 3, url: expect.stringMatching(/^\/api\/dsh-film\/caption-runner\/source\?job=.+&i=0&t=.+$/) }])
    expect(lost).toMatchObject({ status: 409, body: { code: 'CAPTION_RUNNER_CLAIMED' } })
    expect(await first.next('claimed')).toEqual({ jobId: job.jobId, runnerId: second.runnerId })
    // The winner may claim again (a page reload); the job does not move.
    expect((await post(routes, 'claim', { runnerId: second.runnerId, jobId: job.jobId })).status).toBe(200)
    expect(await post(routes, 'progress', { runnerId: second.runnerId, jobId: job.jobId, progress: 0.5, phase: '识别中' })).toEqual({ status: 200, body: { cancelled: false } })
    expect((await post(routes, 'progress', { runnerId: first.runnerId, jobId: job.jobId, progress: 0.5 })).body.code).toBe('CAPTION_RUNNER_NOT_CLAIMED')
    expect((await post(routes, 'result', { runnerId: second.runnerId, jobId: job.jobId, result: [{ sourceClipId: 'a', segments: [] }] })).status).toBe(200)
    await expect(result).resolves.toEqual([{ sourceClipId: 'a', segments: [] }])
    expect(await first.next('done')).toEqual({ jobId: job.jobId })
    // A late post learns the job has ended.
    expect((await post(routes, 'progress', { runnerId: second.runnerId, jobId: job.jobId, progress: 1 })).body).toEqual({ cancelled: true })
    expect((await post(routes, 'result', { runnerId: second.runnerId, jobId: job.jobId, result: [] })).body.code).toBe('CAPTION_RUNNER_JOB_GONE')
  })

  it('refuses at once without a window or without the page, and fails a job nobody claims', async () => {
    await expect(hub.run(spec(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'CAPTION_RUNTIME_UNAVAILABLE', status: 503 })
    const pageless = new CaptionRunnerHub({ pageAvailable: () => false })
    pageless.connect({ send: () => true })
    expect(pageless.availability()).toMatchObject({ available: false, reason: expect.stringContaining('caption-runner.html') })
    const window = await open()
    const started = Date.now()
    await expect(hub.run(spec(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'CAPTION_RUNTIME_UNAVAILABLE', status: 503 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect((await window.next('done')).jobId).toBe((await window.next('job')).jobId)
  })

  it('offers a waiting job to a window that connects after it was posted', async () => {
    const early = await open()
    const result = hub.run(spec(), { signal: new AbortController().signal })
    const job = await early.next('job')
    early.close()
    const late = await open()
    expect(await late.next('job')).toEqual(job)
    expect((await post(routes, 'claim', { runnerId: late.runnerId, jobId: job.jobId })).status).toBe(200)
    await post(routes, 'result', { runnerId: late.runnerId, jobId: job.jobId, result: [] })
    await expect(result).resolves.toEqual([])
  })

  it('fails a claimed job whose window goes away', async () => {
    const window = await open()
    const result = hub.run(spec(), { signal: new AbortController().signal })
    const job = await window.next('job')
    await post(routes, 'claim', { runnerId: window.runnerId, jobId: job.jobId })
    window.close()
    await expect(result).rejects.toMatchObject({ code: 'CAPTION_RUNTIME_LOST', status: 503 })
    expect(hub.connected).toBe(0)
  })

  it('cancels: the window is told, progress answers cancelled, a late result is refused', async () => {
    const window = await open()
    const controller = new AbortController()
    const result = hub.run(spec(), { signal: controller.signal })
    const job = await window.next('job')
    await post(routes, 'claim', { runnerId: window.runnerId, jobId: job.jobId })
    controller.abort(new Error('cancelled'))
    await expect(result).rejects.toThrow('cancelled')
    expect(await window.next('cancel')).toEqual({ jobId: job.jobId })
    expect((await post(routes, 'progress', { runnerId: window.runnerId, jobId: job.jobId, progress: 0.7 })).body).toEqual({ cancelled: true })
    expect((await post(routes, 'result', { runnerId: window.runnerId, jobId: job.jobId, result: [] })).status).toBe(409)
  })

  it('serves a source only to its job\'s token, with byte ranges', async () => {
    const window = await open()
    const result = hub.run(spec(), { signal: new AbortController().signal })
    const job = await window.next('job')
    const url = new URL('http://host/api/dsh-film/caption-runner/source')
    url.searchParams.set('job', job.jobId)
    url.searchParams.set('i', '0')
    url.searchParams.set('t', 'guess')
    // Unclaimed: nothing is served yet.
    expect((await getSource(routes, url.pathname + url.search)).status).toBe(404)
    const claim = await post(routes, 'claim', { runnerId: window.runnerId, jobId: job.jobId })
    const wrong = await getSource(routes, url.pathname + url.search)
    expect(wrong.status).toBe(403)
    expect(await wrong.json()).toMatchObject({ code: 'CAPTION_RUNNER_FORBIDDEN' })
    const right = await getSource(routes, claim.body.sources[0].url, { range: 'bytes=4-9' })
    expect(right.status).toBe(206)
    expect(await right.text()).toBe('source')
    expect((await getSource(routes, claim.body.sources[0].url.replace('i=0', 'i=4'))).status).toBe(404)
    await post(routes, 'result', { runnerId: window.runnerId, jobId: job.jobId, result: [] })
    await result
    expect((await getSource(routes, claim.body.sources[0].url)).status).toBe(404)
  })

  it('turns a page error into CAPTION_RECOGNITION_FAILED and a run past the deadline into a timeout', async () => {
    const window = await open()
    const failing = hub.run(spec(), { signal: new AbortController().signal })
    const job = await window.next('job')
    await post(routes, 'claim', { runnerId: window.runnerId, jobId: job.jobId })
    await post(routes, 'result', { runnerId: window.runnerId, jobId: job.jobId, error: 'CAPTION_SOURCE_UNAVAILABLE: 404' })
    await expect(failing).rejects.toMatchObject({ code: 'CAPTION_RECOGNITION_FAILED', status: 422, message: expect.stringContaining('CAPTION_SOURCE_UNAVAILABLE') })
    const slow = new CaptionRunnerHub({ deadlineMs: 50 })
    const slowRoutes = captionRunnerRoutes(slow)
    const slowWindow = await openWindow(slowRoutes)
    windows.push(slowWindow)
    const late = slow.run(spec(), { signal: new AbortController().signal })
    const slowJob = await slowWindow.next('job')
    await post(slowRoutes, 'claim', { runnerId: slowWindow.runnerId, jobId: slowJob.jobId })
    await expect(late).rejects.toMatchObject({ code: 'CAPTION_RECOGNITION_TIMEOUT', status: 504 })
    expect(await slowWindow.next('cancel')).toEqual({ jobId: slowJob.jobId })
  })

  it('ends every window\'s stream when disposed, so the windows reconnect to the hub that replaces it', async () => {
    const window = await open()
    const job = hub.run(spec(), { signal: new AbortController().signal })
    await window.next('job')
    hub.dispose()
    await expect(job).rejects.toMatchObject({ code: 'CAPTION_RUNTIME_UNAVAILABLE' })
    expect(await window.next('done')).toMatchObject({ jobId: expect.any(String) })
    const outcome = await Promise.race([window.ended.then(() => 'ended'), new Promise(resolve => setTimeout(resolve, 2000, 'still open'))])
    expect(outcome).toBe('ended')
    expect(hub.connected).toBe(0)
    // A window that reconnects before the old route is gone is sent on at once, stream and all.
    const close = vi.fn()
    hub.connect({ send: () => true, close })
    expect(close).toHaveBeenCalledTimes(1)
    expect(hub.connected).toBe(0)
    const response = await routes.find(route => route.path.endsWith('/events'))!.fetch(new Request('http://host/api/dsh-film/caption-runner/events'))
    const reader = response.body!.getReader()
    const read = await Promise.race([reader.read(), new Promise(resolve => setTimeout(resolve, 2000, 'still open'))])
    expect(read).toMatchObject({ done: true })
  })

  it('refuses claims from unknown windows and malformed posts', async () => {
    const window = await open()
    void hub.run(spec(), { signal: new AbortController().signal }).catch(() => {})
    const job = await window.next('job')
    expect((await post(routes, 'claim', { runnerId: 'nobody', jobId: job.jobId })).body.code).toBe('CAPTION_RUNNER_UNKNOWN')
    expect((await post(routes, 'claim', { runnerId: window.runnerId, jobId: 'none' })).body.code).toBe('CAPTION_RUNNER_JOB_GONE')
    expect((await post(routes, 'claim', {})).status).toBe(400)
    const response = await routes.find(route => route.path.endsWith('/claim'))!.fetch(new Request('http://host/x', { method: 'POST', body: '{}' }))
    expect(response.status).toBe(415)
  })
})

describe('whisper engine', () => {
  let models: ReturnType<typeof captionModels>
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-film-runner-models-'))
    models = captionModels(root)
  })

  afterEach(async () => {
    models.dispose()
    await models.whenIdle()
    await rm(root, { recursive: true, force: true })
  })

  it('refuses before a task without consent or without a window, and names what is missing', async () => {
    const engine = whisperEngine({ models, runner: hub })
    const h = await workspace({ whisper: engine })
    try {
      await expect(h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'r' })).rejects.toMatchObject({
        code: 'VIDEO_EDITOR_MODEL_CONSENT_REQUIRED', status: 409, extra: { modelIds: ['whisper-small-q8', 'silero-vad'] },
      })
      await models.setConsent('whisper-small-q8', true)
      await expect(h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'r' })).rejects.toMatchObject({ extra: { modelIds: ['silero-vad'] } })
      await models.setConsent('silero-vad', true)
      await expect(h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'r' })).rejects.toMatchObject({ code: 'CAPTION_RUNTIME_UNAVAILABLE', status: 503 })
      expect(await h.tasks.list(h.cwd)).toEqual([])
      expect(await engine.describe()).toMatchObject({ id: 'whisper', available: false, consent: { 'whisper-small-q8': true, 'silero-vad': true }, runner: 'none' })
    } finally {
      await h.cleanup()
    }
  })

  it('prepares both models, runs the page with their files and the snapshots, and saves the draft', async () => {
    await models.setConsent('whisper-small-q8', true)
    await models.setConsent('silero-vad', true)
    const engine = whisperEngine({ models, runner: hub, pollMs: 5 })
    const h = await workspace({ whisper: engine })
    try {
      const window = await open()
      expect(await engine.describe()).toMatchObject({ available: true, runner: 'connected', downloadBytes: expect.any(Number) })
      const started = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'r', range: { start: 1, end: 6 }, language: 'zh' })
      expect(started).toMatchObject({ status: 'running', engine: 'whisper', model: 'whisper-small-q8' })
      const job = await window.next('job', 5000)
      const claim = await post(routes, 'claim', { runnerId: window.runnerId, jobId: job.jobId })
      expect(claim.body.artifacts).toEqual({
        config: '/api/dsh-film/models/whisper-small-q8/abc1234/config',
        'encoder-q8': '/api/dsh-film/models/whisper-small-q8/abc1234/encoder-q8',
        'speech-vad': '/api/dsh-film/models/silero-vad/abc1234/speech-vad',
      })
      expect(claim.body.sources.map((source: any) => [source.clipId, source.sourceIn, source.sourceOut])).toEqual([['a', 4, 10], ['b', 0, 2]])
      // The page reads the snapshots, not the film's files.
      expect(await (await getSource(routes, claim.body.sources[1].url)).text()).toBe('fixture source B')
      await post(routes, 'progress', { runnerId: window.runnerId, jobId: job.jobId, progress: 0.5, phase: '识别第 1 段' })
      await post(routes, 'result', {
        runnerId: window.runnerId, jobId: job.jobId,
        result: [
          { sourceClipId: 'a', segments: [{ id: 'asr-draft-0', text: '你好', start: 0, end: 1, rawText: '你好', warnings: ['weak-speech-evidence'] }], diagnostics: { vad: [] } },
          { sourceClipId: 'b', segments: [{ text: '再见', start: 0, end: 1 }] },
        ],
      })
      await h.service.whenIdle()
      const task = await h.tasks.record(h.cwd, started.taskId)
      expect(task?.progress).toContain('60% · 识别第 1 段')
      expect(task?.status).toBe('done')
      const draft = task?.file?.documentResult as any
      expect(draft.segments).toEqual([
        { id: `asr:${started.taskId}:0`, text: '你好', warnings: ['weak-speech-evidence'], start: 1, end: 1.5, sourceClipId: 'a', sourceIn: 4, sourceOut: 5 },
        { id: `asr:${started.taskId}:1`, text: '再见', start: 4, end: 5, sourceClipId: 'b', sourceIn: 0, sourceOut: 1 },
      ])
      expect(draft.diagnostics).toEqual([{ sourceClipId: 'a', evidence: { vad: [] } }, { sourceClipId: 'b', evidence: {} }])
      expect(JSON.parse(await readFile(join(root, 'consents.json'), 'utf8'))).toMatchObject({ 'silero-vad': true })
    } finally {
      await h.cleanup()
    }
  })

  it('cancelling the task tells the page and leaves the task interrupted', async () => {
    await models.setConsent('whisper-small-q8', true)
    await models.setConsent('silero-vad', true)
    const h = await workspace({ whisper: whisperEngine({ models, runner: hub, pollMs: 5 }) })
    try {
      const window = await open()
      const started = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'cancel' })
      const job = await window.next('job', 5000)
      await post(routes, 'claim', { runnerId: window.runnerId, jobId: job.jobId })
      await h.tasks.cancel(h.cwd, started.taskId)
      expect(await window.next('cancel')).toEqual({ jobId: job.jobId })
      await h.service.whenIdle()
      expect(await h.tasks.record(h.cwd, started.taskId)).toMatchObject({ status: 'interrupted', error: { code: 'MEDIA_TASK_CANCELED' } })
    } finally {
      await h.cleanup()
    }
  })

  it('fails the task when the page returns a malformed result', async () => {
    await models.setConsent('whisper-small-q8', true)
    await models.setConsent('silero-vad', true)
    const h = await workspace({ whisper: whisperEngine({ models, runner: hub, pollMs: 5 }) })
    try {
      const window = await open()
      const started = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'bad' })
      const job = await window.next('job', 5000)
      await post(routes, 'claim', { runnerId: window.runnerId, jobId: job.jobId })
      await post(routes, 'result', { runnerId: window.runnerId, jobId: job.jobId, result: { text: 'not a list' } })
      await h.service.whenIdle()
      expect((await h.tasks.record(h.cwd, started.taskId))?.error).toMatchObject({ code: 'CAPTION_RESULT_INVALID', status: 422 })
    } finally {
      await h.cleanup()
    }
  })
})
