/** The caption endpoints over the Studio-compatible router, as the editing desk calls them. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TimelineCaptionError } from '../../src/captions/plan.js'
import { createStudioRouter } from '../../src/routes.js'
import type { StudioRouter } from '../../src/studio/router.js'
import { PROJECT, fakeEngine, workspace } from './fixture.js'
import type { Workspace } from './fixture.js'

let h: Workspace
let router: StudioRouter

beforeEach(async () => {
  const gateway = fakeEngine(undefined, 'gateway')
  gateway.preflight = async ({ request }) => {
    if (request.language === 'en') throw new TimelineCaptionError('CAPTION_ENGINE_LANGUAGE_UNSUPPORTED', 'zh only', 400)
    if (request.requestId === 'no-media') throw new TimelineCaptionError('CAPTION_ENGINE_UNAVAILABLE', 'install dsh-media', 503, { cause: 'MEDIA_SERVICE_UNAVAILABLE' })
    return { model: 'gateway:asr', estimate: { seconds: 11, amountCny: 0.01, basis: 'retail' } }
  }
  const whisper = fakeEngine()
  whisper.preflight = async ({ request }) => {
    if (request.requestId === 'consent') throw new TimelineCaptionError('VIDEO_EDITOR_MODEL_CONSENT_REQUIRED', 'consent first', 409, { modelIds: ['whisper-small-q8', 'silero-vad'] })
    return { model: 'whisper-small-q8' }
  }
  h = await workspace({ whisper, gateway })
  router = createStudioRouter({ tasks: h.tasks, captions: h.service })
})

afterEach(async () => {
  await h.cleanup()
})

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = new URL(`http://host/api/dsh-film/${method === 'GET' ? 'studio' : 'studio-write'}`)
  url.searchParams.set('cwd', h.cwd)
  url.searchParams.set('path', path)
  const response = await router.dispatch(new Request(url, method === 'GET' ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }))
  return { status: response.status, body: await response.json() }
}

const base = `/api/canvas/timelines/${PROJECT}`

describe('caption routes', () => {
  it('starts with 202, answers a repeat with the same task, and refuses a mismatched project', async () => {
    const first = await call('POST', `${base}/transcribe?project=${PROJECT}`, { baseRevision: 1, requestId: 'r1', range: { start: 1, end: 6 } })
    expect(first).toMatchObject({ status: 202, body: { status: 'running', duplicate: false, engine: 'whisper', model: 'whisper-small-q8' } })
    expect((await call('POST', `${base}/transcribe`, { baseRevision: 1, requestId: 'r1', range: { start: 1, end: 6 } })).body).toMatchObject({ taskId: first.body.taskId, duplicate: true })
    expect(await call('POST', `${base}/transcribe?project=foreign`, { baseRevision: 1, requestId: 'r2' })).toMatchObject({ status: 409, body: { code: 'CAPTION_CONTEXT_MISMATCH' } })
    expect(await call('POST', `${base}/transcribe`, { requestId: 'r3' })).toMatchObject({ status: 400, body: { code: 'CAPTION_REQUEST_INVALID', error: expect.stringMatching(/^CAPTION_REQUEST_INVALID: /) } })
    const stale = await call('POST', `${base}/transcribe`, { baseRevision: 0, requestId: 'r4' })
    expect(stale).toMatchObject({ status: 409, body: { code: 'CANVAS_TIMELINE_CONFLICT', current: { revision: 1 } } })
    expect(await call('POST', `${base}/transcribe`, { baseRevision: 1, requestId: 'r1', clipIds: ['a'] })).toMatchObject({ status: 409, body: { code: 'CAPTION_REQUEST_CONFLICT' } })
  })

  it('answers engine refusals with their code, status and extra members', async () => {
    expect(await call('POST', `${base}/transcribe`, { baseRevision: 1, requestId: 'consent' })).toEqual({
      status: 409, body: { code: 'VIDEO_EDITOR_MODEL_CONSENT_REQUIRED', error: 'VIDEO_EDITOR_MODEL_CONSENT_REQUIRED: consent first', modelIds: ['whisper-small-q8', 'silero-vad'] },
    })
    expect(await call('POST', `${base}/transcribe`, { baseRevision: 1, requestId: 'en', engine: 'gateway', language: 'en' })).toMatchObject({ status: 400, body: { code: 'CAPTION_ENGINE_LANGUAGE_UNSUPPORTED' } })
    expect(await call('POST', `${base}/transcribe`, { baseRevision: 1, requestId: 'no-media', engine: 'gateway' })).toMatchObject({ status: 503, body: { code: 'CAPTION_ENGINE_UNAVAILABLE', cause: 'MEDIA_SERVICE_UNAVAILABLE' } })
    const paid = await call('POST', `${base}/transcribe`, { baseRevision: 1, requestId: 'paid', engine: 'gateway', spendingConfirmed: true })
    expect(paid).toMatchObject({ status: 202, body: { engine: 'gateway', model: 'gateway:asr', estimate: { seconds: 11, amountCny: 0.01 } } })
  })

  it('reads the draft through the task routes, applies it reviewed, and lists it as applied', async () => {
    const started = await call('POST', `${base}/transcribe`, { baseRevision: 1, requestId: 'apply', range: { start: 1, end: 6 } })
    await h.service.whenIdle()
    const waited = await call('POST', `/api/media/tasks/${started.body.taskId}/wait`, { since: 0, timeoutMs: 1000 })
    expect(waited.body).toMatchObject({ status: 'done', file: { kind: 'caption-draft', documentResult: { kind: 'timeline-caption-draft', engine: 'whisper' } } })
    expect(await call('POST', `${base}/captions/apply`, { taskId: started.body.taskId, reviewed: true })).toMatchObject({ status: 400, body: { code: 'CAPTION_REQUEST_INVALID' } })
    expect(await call('POST', `${base}/captions/apply`, { taskId: started.body.taskId, reviewed: false, dryRun: true })).toMatchObject({ status: 400, body: { code: 'CAPTION_REVIEW_REQUIRED' } })
    expect(await call('POST', `${base}/captions/apply`, { taskId: 'nope', reviewed: true, dryRun: true })).toMatchObject({ status: 404, body: { code: 'CAPTION_TASK_NOT_FOUND' } })
    const dry = await call('POST', `${base}/captions/apply`, { taskId: started.body.taskId, reviewed: true, dryRun: true })
    expect(dry).toMatchObject({ status: 200, body: { result: { committed: false, revision: 1 } } })
    expect(dry.body.result.before).toBeUndefined()
    expect(dry.body.result.after).toBeUndefined()
    expect(dry.body.result.changes).toBeDefined()
    expect((await call('GET', `${base}/captions/tasks`)).body.tasks).toMatchObject([{ taskId: started.body.taskId, status: 'done', applied: false, segments: 2, engine: 'whisper' }])
    expect((await call('POST', `${base}/captions/apply`, { taskId: started.body.taskId, reviewed: true, dryRun: false, excludeSegmentIds: [`asr:${started.body.taskId}:1`] })).body.result).toMatchObject({ committed: true, revision: 2 })
    expect((await call('POST', `${base}/captions/apply`, { taskId: started.body.taskId, reviewed: true, dryRun: false })).body.result).toMatchObject({ committed: false, duplicate: true, revision: 2 })
    expect((await call('GET', `${base}/captions/tasks?project=${PROJECT}`)).body.tasks).toMatchObject([{ taskId: started.body.taskId, applied: true }])
    expect((await call('GET', `${base}/captions/tasks?project=other`)).status).toBe(409)
  })

  it('refuses an apply of a task still running, and cancels through the task route', async () => {
    let release!: () => void
    const engine = fakeEngine(async (input) => {
      await new Promise<void>((resolve) => { release = resolve; input.signal.addEventListener('abort', () => { resolve() }) })
      input.signal.throwIfAborted()
      return []
    })
    const slow = await workspace({ whisper: engine })
    try {
      const slowRouter = createStudioRouter({ tasks: slow.tasks, captions: slow.service })
      const url = (path: string): URL => {
        const target = new URL('http://host/api/dsh-film/studio-write')
        target.searchParams.set('cwd', slow.cwd)
        target.searchParams.set('path', path)
        return target
      }
      const send = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
        const response = await slowRouter.dispatch(new Request(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
        return { status: response.status, body: await response.json() }
      }
      const started = await send(`${base}/transcribe`, { baseRevision: 1, requestId: 'slow' })
      expect(await send(`${base}/captions/apply`, { taskId: started.body.taskId, reviewed: true, dryRun: true })).toMatchObject({ status: 409, body: { code: 'CAPTION_TASK_NOT_READY' } })
      expect((await send(`/api/media/tasks/${started.body.taskId}/cancel`, {})).status).toBe(200)
      await slow.service.whenIdle()
      expect((await send(`/api/media/tasks/${started.body.taskId}/wait`, { since: 0, timeoutMs: 0 })).body).toMatchObject({ status: 'interrupted', error: { code: 'MEDIA_TASK_CANCELED' } })
      release?.()
    } finally {
      await slow.cleanup()
    }
  })

  it('answers an estimate with 200 and starts, copies and charges nothing', async () => {
    const free = await call('POST', `${base}/transcribe`, { baseRevision: 1, estimateOnly: true, range: { start: 1, end: 6 } })
    expect(free).toEqual({ status: 200, body: { estimate: { seconds: 8, amountCny: 0, basis: expect.any(String) }, engine: 'whisper' } })
    const paid = await call('POST', `${base}/transcribe?project=${PROJECT}`, { baseRevision: 1, requestId: 'ignored', engine: 'gateway', estimateOnly: true })
    expect(paid).toEqual({ status: 200, body: { estimate: { seconds: 11, amountCny: 0.01, basis: 'retail' }, engine: 'gateway' } })
    // The same refusals as a start.
    expect(await call('POST', `${base}/transcribe`, { baseRevision: 0, estimateOnly: true })).toMatchObject({ status: 409, body: { code: 'CANVAS_TIMELINE_CONFLICT', current: { revision: 1 } } })
    expect(await call('POST', `${base}/transcribe`, { baseRevision: 1, estimateOnly: true, engine: 'gateway', language: 'en' })).toMatchObject({ status: 400, body: { code: 'CAPTION_ENGINE_LANGUAGE_UNSUPPORTED' } })
    expect(await call('POST', `${base}/transcribe`, { baseRevision: 1, estimateOnly: 'yes' })).toMatchObject({ status: 400, body: { code: 'CAPTION_REQUEST_INVALID' } })
    // Without estimateOnly a requestId is still required.
    expect(await call('POST', `${base}/transcribe`, { baseRevision: 1 })).toMatchObject({ status: 400, body: { code: 'CAPTION_REQUEST_INVALID' } })
    expect(await h.tasks.list(h.cwd)).toEqual([])
  })

  it('lists the engines with the default', async () => {
    expect((await call('GET', `${base}/captions/engines`)).body).toEqual({ default: 'whisper', engines: [{ id: 'whisper', available: true }, { id: 'gateway', available: true }] })
  })
})
