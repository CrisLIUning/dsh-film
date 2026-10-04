/**
 * Original sound → saved draft → caption-only commit, against a real
 * workspace, the film task store and the cut's store (Studio's
 * `tests/captions/service.test.ts`, with a fake engine).
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CaptionRecognition } from '../../src/captions/contracts.js'
import { mapCaptionRecognition } from '../../src/captions/map.js'
import { planTimelineTranscription } from '../../src/captions/plan.js'
import { TimelineStore } from '../../src/timeline/store.js'
import { PROJECT, fakeEngine, original, workspace } from './fixture.js'
import type { Workspace } from './fixture.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

async function setup(...args: Parameters<typeof workspace>): Promise<Workspace> {
  const made = await workspace(...args)
  cleanups.push(made.cleanup)
  return made
}

const draftOf = async (h: Workspace, taskId: string): Promise<any> => (await h.tasks.record(h.cwd, taskId))?.file?.documentResult

describe('original sound → persisted draft → native caption-only commit', () => {
  it('supports concurrent retries, dry-run, boundary preservation, disk readback and idempotent apply', async () => {
    const h = await setup()
    const request = { baseRevision: 1, requestId: 'same', range: { start: 1, end: 6 } }
    const [a, b] = await Promise.all([h.service.start(h.cwd, PROJECT, request), h.service.start(h.cwd, PROJECT, request)])
    expect(a.taskId).toBe(b.taskId)
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true])
    expect(a).toMatchObject({ engine: 'whisper', model: 'whisper-small-q8' })
    await h.service.whenIdle()
    expect((await h.tasks.record(h.cwd, a.taskId))?.status).toBe('done')
    const draft = await draftOf(h, a.taskId)
    expect(draft).toMatchObject({ kind: 'timeline-caption-draft', reviewStatus: 'unreviewed', engine: 'whisper', model: 'whisper-small-q8', baseRevision: 1 })
    expect(draft.segments.map((c: any) => [c.start, c.end])).toEqual([[1, 1.5], [4, 5]])
    expect(draft.sources.every((source: any) => /^[0-9a-f]{64}$/.test(source.sha256))).toBe(true)
    expect((await h.store.read()).revision).toBe(1)
    await expect(h.service.apply(h.cwd, PROJECT, { taskId: a.taskId, reviewed: false, dryRun: true })).rejects.toThrow(/REVIEW_REQUIRED/)
    const checked = await h.service.apply(h.cwd, PROJECT, { taskId: a.taskId, reviewed: true, dryRun: true })
    expect(checked.committed).toBe(false)
    expect((await h.store.read()).revision).toBe(1)
    expect((await h.service.apply(h.cwd, PROJECT, { taskId: a.taskId, reviewed: true, dryRun: false })).committed).toBe(true)
    const actual = ((await new TimelineStore(h.cwd).read()).document as any).project
    expect(actual.visualSegments).toEqual(original.project.visualSegments)
    expect(actual.audioSegments).toEqual([])
    expect(actual.musicSegments).toEqual([])
    expect(actual.ratioId).toBe('16:9')
    expect(actual.captionSegments.find((c: any) => c.id === 'edge')).toEqual({ ...original.project.captionSegments[0], end: 1 })
    expect(actual.captionSegments.find((c: any) => c.id === 'last')).toEqual(original.project.captionSegments[2])
    expect(actual.captionSegments.some((c: any) => c.id === 'wrong')).toBe(false)
    expect((await h.service.apply(h.cwd, PROJECT, { taskId: a.taskId, reviewed: true, dryRun: false })).duplicate).toBe(true)
    expect((await h.store.read()).revision).toBe(2)
    expect(JSON.parse(await readFile(join(h.cwd, 'film', 'canvas', 'timeline.json'), 'utf8')).revision).toBe(2)
    // The snapshots are gone once the recognition ends.
    await expect(readFile(join(h.cwd, 'film', '.tasks', 'caption-runs', a.taskId, '0.mp4'))).rejects.toThrow()
  })

  it('refuses a stale revision, changed original bytes, request reuse and a foreign task ID', async () => {
    const h = await setup({ whisper: fakeEngine(), gateway: fakeEngine(undefined, 'gateway') })
    const a = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'r' })
    await h.service.whenIdle()
    await expect(h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'r', clipIds: ['b'] })).rejects.toThrow(/REQUEST_CONFLICT/)
    // The engine is part of the inputs.
    await expect(h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'r', engine: 'gateway' })).rejects.toThrow(/REQUEST_CONFLICT/)
    await expect(h.service.apply(h.cwd, 'foreign', { taskId: a.taskId, reviewed: true, dryRun: false })).rejects.toThrow(/TASK_NOT_FOUND/)
    await expect(h.service.apply(h.cwd, PROJECT, { taskId: 'agent-run-not-media', reviewed: true, dryRun: false })).rejects.toThrow(/TASK_NOT_FOUND/)
    await expect(h.service.start(h.cwd, PROJECT, { baseRevision: 0, requestId: 'stale' })).rejects.toThrow(/timeline has moved on/)
    await h.store.save({ baseRevision: 1, document: { ...original, project: { ...original.project, ratioId: '9:16' } } })
    await expect(h.service.apply(h.cwd, PROJECT, { taskId: a.taskId, reviewed: true, dryRun: false })).rejects.toThrow(/timeline has moved on/)
    await writeFile(join(h.cwd, 'film', 'a.mp4'), 'changed')
    await expect(h.service.apply(h.cwd, PROJECT, { taskId: a.taskId, reviewed: true, dryRun: false })).rejects.toThrow(/SOURCE_CHANGED/)
  })

  it('cancellation rejects late recognition and cannot erase or add captions', async () => {
    let finish!: (result: CaptionRecognition[]) => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const h = await setup({ whisper: fakeEngine(async () => { entered(); return new Promise((resolve) => { finish = resolve }) }) })
    const a = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'r' })
    await ready
    await h.tasks.cancel(h.cwd, a.taskId)
    finish([{ sourceClipId: 'a', segments: [{ text: 'too late', start: 0, end: 1 }] }])
    await h.service.whenIdle()
    const task = await h.tasks.record(h.cwd, a.taskId)
    expect(task).toMatchObject({ status: 'interrupted', error: { code: 'MEDIA_TASK_CANCELED' } })
    expect(task?.file).toBeUndefined()
    expect((await h.store.read()).document).toEqual(original)
    await expect(h.service.apply(h.cwd, PROJECT, { taskId: a.taskId, reviewed: true, dryRun: false })).rejects.toThrow(/NOT_READY/)
  })

  it('empty output and outside-project links fail closed without timeline writes', async () => {
    const h = await setup({ whisper: fakeEngine(async () => []) })
    const a = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'empty' })
    await h.service.whenIdle()
    expect((await h.tasks.record(h.cwd, a.taskId))?.error).toMatchObject({ code: 'CAPTION_NO_SPEECH', status: 422 })
    const outside = await mkdtemp(join(tmpdir(), 'dsh-film-captions-outside-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    await writeFile(join(outside, 'a.mp4'), 'private')
    await symlink(outside, join(h.cwd, 'film', 'link'), 'junction')
    const escaped = structuredClone(original)
    escaped.project.visualSegments[0]!.assetVersionId = 'canvas-file:link/a.mp4'
    await h.store.save({ baseRevision: 1, document: escaped })
    const b = await h.service.start(h.cwd, PROJECT, { baseRevision: 2, requestId: 'escape' })
    await h.service.whenIdle()
    expect((await h.tasks.record(h.cwd, b.taskId))?.error).toMatchObject({ code: 'CAPTION_SOURCE_OUTSIDE_PROJECT', status: 403 })
    expect((await h.store.read()).revision).toBe(2)
  })

  it('records an engine failure with its code, and an unexpected one as CAPTION_RECOGNITION_FAILED', async () => {
    const h = await setup({ whisper: fakeEngine(async () => { throw new Error('worker crashed') }) })
    const a = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'crash' })
    await h.service.whenIdle()
    expect((await h.tasks.record(h.cwd, a.taskId))?.error).toMatchObject({ code: 'CAPTION_RECOGNITION_FAILED', status: 422, message: expect.stringContaining('worker crashed') })
  })
})

it('preserves reviewed/manual captions and all non-caption tracks on an explicit re-recognition', async () => {
  const h = await setup()
  const protectedCaption = { id: 'human', text: '人工校对', start: 2, end: 3, reviewStatus: 'edited' }
  await h.store.save({ baseRevision: 1, document: { ...original, project: { ...original.project, captionSegments: [...original.project.captionSegments, protectedCaption] } } })
  const a = await h.service.start(h.cwd, PROJECT, { baseRevision: 2, requestId: 'fresh', clipIds: ['a'] })
  await h.service.whenIdle()
  await h.service.apply(h.cwd, PROJECT, { taskId: a.taskId, reviewed: true, dryRun: false })
  expect((await h.store.read()).document).toMatchObject({
    project: { captionSegments: expect.arrayContaining([protectedCaption]), visualSegments: original.project.visualSegments },
  })
})

it('keeps large raw evidence on disk without overflowing the bounded task receipt', async () => {
  const h = await setup({
    whisper: fakeEngine(async input => input.sources.map(source => ({ sourceClipId: source.clipId, segments: [{ text: 'spoken', start: 0, end: 0.5 }], diagnostics: { raw: 'x'.repeat(500_000) } }))),
  })
  const started = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'large-evidence' })
  await h.service.whenIdle()
  const task = await h.tasks.record(h.cwd, started.taskId)
  expect(task?.status).toBe('done')
  const draft = task?.file?.documentResult as any
  expect(JSON.stringify(draft).length).toBeLessThan(512 * 1024)
  expect(draft.evidence.file).toBe(`.tasks/caption-evidence/${started.taskId}.json`)
  const saved = JSON.parse(await readFile(join(h.cwd, 'film', draft.evidence.file), 'utf8'))
  expect(saved.raw[0].diagnostics.raw.length).toBe(500_000)
  expect(saved.mapped.segments).toHaveLength(2)
  expect(draft.diagnostics).toEqual([{ sourceClipId: 'a', evidence: { fullEvidenceFile: draft.evidence.file } }, { sourceClipId: 'b', evidence: { fullEvidenceFile: draft.evidence.file } }])
  expect((await h.store.read()).revision).toBe(1)
})

it('rediscovers durable drafts after a restart and exposes applied state without leaking another project', async () => {
  const h = await setup()
  const started = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'background' })
  await h.service.whenIdle()
  const { CaptionService } = await import('../../src/captions/service.js')
  const { FilmMediaTasks } = await import('../../src/media/tasks.js')
  // A fresh store and service read the tasks from disk, as after a restart of the Host.
  const tasks = new FilmMediaTasks(() => undefined)
  const fresh = new CaptionService({ tasks, engines: { whisper: fakeEngine() }, timelines: dir => new TimelineStore(dir) })
  expect((await fresh.list(h.cwd, PROJECT)).tasks).toMatchObject([{ taskId: started.taskId, status: 'done', applied: false, engine: 'whisper', model: 'whisper-small-q8', segments: 2, ranges: [{ start: 0, end: 7 }] }])
  expect((await fresh.list(h.cwd, 'foreign')).tasks).toEqual([])
  await fresh.apply(h.cwd, PROJECT, { taskId: started.taskId, reviewed: true, dryRun: false })
  expect((await fresh.list(h.cwd, PROJECT)).tasks).toMatchObject([{ taskId: started.taskId, applied: true }])
})

it('a running recognition does not survive a restart of the Host', async () => {
  let entered!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const h = await setup({
    whisper: fakeEngine(async (input) => {
      entered()
      return new Promise((_resolve, reject) => { input.signal.addEventListener('abort', () => { reject(input.signal.reason) }) })
    }),
  })
  const started = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'restart' })
  await ready
  await h.tasks.settled()
  const { FilmMediaTasks } = await import('../../src/media/tasks.js')
  const after = new FilmMediaTasks(() => undefined)
  expect(await after.record(h.cwd, started.taskId)).toMatchObject({ status: 'interrupted', error: { code: 'MEDIA_TASK_INTERRUPTED', message: expect.stringContaining('重新识别') } })
  await after.settled()
  await h.tasks.cancel(h.cwd, started.taskId)
})

it('reports progress lines as Studio does: models 0–20 %, recognition 20–99 %', async () => {
  const engine = fakeEngine(async (input) => {
    input.onProgress({ progress: 0.5, phase: '识别第 1 段' })
    return input.sources.map(source => ({ sourceClipId: source.clipId, segments: [] }))
  })
  engine.prepare = async (context) => {
    context.onProgress({ progress: 0.5, phase: '正在下载 Whisper' })
    return {}
  }
  const h = await setup({ whisper: engine })
  const started = await h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'progress' })
  await h.service.whenIdle()
  expect((await h.tasks.record(h.cwd, started.taskId))?.progress).toEqual(['0% · 已提交', '10% · 正在下载 Whisper', '20% · 识别中', '60% · 识别第 1 段', '完成'])
})

describe('mapCaptionRecognition', () => {
  const plan = planTimelineTranscription(original, { baseRevision: 1, requestId: 'r', range: { start: 1, end: 6 } })
  it('maps slice seconds through the speed curve and sorts by timeline start', () => {
    const lines = mapCaptionRecognition([
      { sourceClipId: 'b', segments: [{ text: ' two ', start: 0.5, end: 1 }] },
      { sourceClipId: 'a', segments: [{ text: 'one', start: 1, end: 2, warnings: ['weak-speech-evidence'] }] },
    ], plan.sources, 't')
    expect(lines).toEqual([
      { id: 'asr:t:1', text: 'one', warnings: ['weak-speech-evidence'], start: 1.5, end: 2, sourceClipId: 'a', sourceIn: 5, sourceOut: 6 },
      { id: 'asr:t:0', text: 'two', start: 4.5, end: 5, sourceClipId: 'b', sourceIn: 0.5, sourceOut: 1 },
    ])
  })
  it('refuses unknown, repeated, missing and malformed results', () => {
    expect(() => mapCaptionRecognition([{ sourceClipId: 'x', segments: [] }], plan.sources, 't')).toThrow(/CAPTION_RESULT_INVALID/)
    expect(() => mapCaptionRecognition([{ sourceClipId: 'a', segments: [] }, { sourceClipId: 'a', segments: [] }], plan.sources, 't')).toThrow(/CAPTION_RESULT_INVALID/)
    expect(() => mapCaptionRecognition([{ sourceClipId: 'a', segments: [] }], plan.sources, 't')).toThrow(/CAPTION_NO_SPEECH/)
    expect(() => mapCaptionRecognition([{ sourceClipId: 'a', segments: [{ text: 'x', start: 0, end: 9 }] }, { sourceClipId: 'b', segments: [] }], plan.sources, 't')).toThrow(/CAPTION_RESULT_INVALID/)
    expect(() => mapCaptionRecognition([{ sourceClipId: 'a', segments: [{ text: ' ', start: 0, end: 1 }] }, { sourceClipId: 'b', segments: [] }], plan.sources, 't')).toThrow(/CAPTION_RESULT_INVALID/)
  })
})

it('creates no task when the engine refuses before starting', async () => {
  const engine = fakeEngine()
  engine.preflight = async () => { throw Object.assign(new (await import('../../src/captions/plan.js')).TimelineCaptionError('VIDEO_EDITOR_MODEL_CONSENT_REQUIRED', 'consent', 409, { modelIds: ['silero-vad'] })) }
  const h = await setup({ whisper: engine })
  await expect(h.service.start(h.cwd, PROJECT, { baseRevision: 1, requestId: 'consent' })).rejects.toMatchObject({ code: 'VIDEO_EDITOR_MODEL_CONSENT_REQUIRED', status: 409, extra: { modelIds: ['silero-vad'] } })
  expect(await h.tasks.list(h.cwd)).toEqual([])
  await mkdir(join(h.cwd, 'film', '.tasks'), { recursive: true })
})
