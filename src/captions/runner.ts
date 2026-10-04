/**
 * The caption runner: where the editing desk's speech recognition runs under
 * DeepSeek Harness. Studio launched its own Electron as a headless Chromium
 * for this; the DSH Host is plain Node (or Electron run as Node) and has no
 * browser, so the work goes to a page instead. Every open DSH window keeps
 * one event stream here (`src/client/caption-runner.ts`); a job is offered to
 * all of them, the first page to claim it does it in a hidden frame
 * (`apps/editor/caption-runner.html`), and the Host keeps everything else —
 * the task, the snapshots, the models and the mapping.
 *
 * Host routes (not workspace-scoped: one window serves every workspace):
 *
 * - `GET  /api/dsh-film/caption-runner/events` — the window's stream:
 *   `hello {runnerId}`, `job {jobId, kind}`, `claimed {jobId, runnerId}`,
 *   `cancel {jobId}`, `done {jobId}`.
 * - `POST /api/dsh-film/caption-runner/claim` `{runnerId, jobId}` — the job's
 *   inputs, or 409 when another window has it or it is gone.
 * - `POST /api/dsh-film/caption-runner/progress` `{runnerId, jobId, progress, phase}` — `{cancelled}`.
 * - `POST /api/dsh-film/caption-runner/result` `{runnerId, jobId, result?|error?}`.
 * - `GET  /api/dsh-film/caption-runner/source?job=&i=&t=` — a source
 *   snapshot, with byte ranges, for the job's token only.
 *
 * Errors answer `{ error, code }`.
 * @module dsh-film/captions/runner
 */

import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { serveFile } from '../files.js'
import { mediaTypeOf } from '../media.js'
import { eventStream } from '../studio/sse.js'
import { TimelineCaptionError } from './plan.js'

/** Where the runner routes live. */
export const RUNNER_PREFIX = '/api/dsh-film/caption-runner'

/** What a page is asked to do: recognise speech with Whisper, or cut speech regions for the gateway. */
export type RunnerJobKind = 'whisper' | 'extract'

/** One job's inputs. */
export interface RunnerJobSpec {
  kind: RunnerJobKind
  language: string
  /** Snapshots (absolute paths) and the source seconds to read. */
  sources: ReadonlyArray<{ clipId: string; file: string; sourceIn: number; sourceOut: number }>
  /** Model file URLs by artifact id. */
  artifacts: Readonly<Record<string, string>>
}

/** What a claim answers. */
export interface RunnerClaim {
  jobId: string
  kind: RunnerJobKind
  language: string
  sources: Array<{ clipId: string; url: string; sourceIn: number; sourceOut: number }>
  artifacts: Record<string, string>
}

/** A connected window's event stream. */
export interface RunnerChannel {
  send(event: string, data: unknown): boolean
}

/** A runner route's refusal. */
export class CaptionRunnerError extends Error {
  override name = 'CaptionRunnerError'

  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export interface CaptionRunnerHubOptions {
  /** How long a job waits for a page to claim it (20 s). */
  claimTimeoutMs?: number
  /** How long a claimed job may run (45 minutes, Studio's deadline). */
  deadlineMs?: number
  /** Whether this build carries the runner page; without it no job can be claimed. */
  pageAvailable?: () => boolean
  randomUUID?: () => string
}

interface Job {
  id: string
  token: string
  spec: RunnerJobSpec
  claimedBy?: string
  onProgress: (update: { progress: number; phase: string }) => void
  resolve: (result: unknown) => void
  reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

const CLAIM_TIMEOUT_MS = 20_000
const DEADLINE_MS = 45 * 60_000
/** How many ended jobs are remembered, so a late progress post learns it should stop. */
const ENDED_KEPT = 200

export class CaptionRunnerHub {
  private readonly runners = new Map<string, RunnerChannel>()
  private readonly jobs = new Map<string, Job>()
  private readonly ended = new Set<string>()
  private readonly claimTimeoutMs: number
  private readonly deadlineMs: number
  private readonly pageAvailable: () => boolean
  private readonly randomUUID: () => string

  constructor(options: CaptionRunnerHubOptions = {}) {
    this.claimTimeoutMs = options.claimTimeoutMs ?? CLAIM_TIMEOUT_MS
    this.deadlineMs = options.deadlineMs ?? DEADLINE_MS
    this.pageAvailable = options.pageAvailable ?? (() => true)
    this.randomUUID = options.randomUUID ?? cryptoRandomUUID
  }

  /** Whether a job could run now, and why not. */
  availability(): { available: true } | { available: false; reason: string } {
    if (!this.pageAvailable()) return { available: false, reason: '这个版本的影视工作台没有带识别页面（apps/editor/caption-runner.html），请更新插件。' }
    if (this.runners.size === 0) return { available: false, reason: '没有打开的 VibeDev/DSH 窗口：识别在窗口里的隐藏页面中运行，请打开窗口后重试。' }
    return { available: true }
  }

  /** How many windows are connected. */
  get connected(): number {
    return this.runners.size
  }

  private broadcast(event: string, data: unknown): void {
    for (const runner of this.runners.values()) runner.send(event, data)
  }

  /**
   * A window connected: give it an id and offer it the jobs nobody has claimed.
   * @param channel - its event stream.
   * @returns its runner id.
   */
  connect(channel: RunnerChannel): string {
    const runnerId = this.randomUUID()
    this.runners.set(runnerId, channel)
    channel.send('hello', { runnerId })
    for (const job of this.jobs.values()) {
      if (job.claimedBy === undefined) channel.send('job', { jobId: job.id, kind: job.spec.kind })
    }
    return runnerId
  }

  /**
   * A window went away: the jobs it was doing are lost (a page cannot resume
   * another's half-done recognition); unclaimed jobs wait for another window.
   * @param runnerId - the window.
   */
  disconnect(runnerId: string): void {
    if (!this.runners.delete(runnerId)) return
    for (const job of [...this.jobs.values()]) {
      if (job.claimedBy === runnerId) {
        this.settle(job, () => job.reject(new TimelineCaptionError('CAPTION_RUNTIME_LOST', '识别页面所在的窗口关闭或断开了，识别没有完成；请重新识别。', 503)))
      }
    }
  }

  private settle(job: Job, finish: () => void): void {
    if (!this.jobs.delete(job.id)) return
    if (job.timer !== undefined) clearTimeout(job.timer)
    this.ended.add(job.id)
    if (this.ended.size > ENDED_KEPT) this.ended.delete(this.ended.values().next().value!)
    this.broadcast('done', { jobId: job.id })
    finish()
  }

  /**
   * Run one job in a page.
   * @param spec - the job.
   * @param options - cancellation and progress (0..1).
   * @returns what the page posted as its result.
   */
  run(spec: RunnerJobSpec, options: { signal: AbortSignal; onProgress?: (update: { progress: number; phase: string }) => void }): Promise<unknown> {
    const availability = this.availability()
    if (!availability.available) return Promise.reject(new TimelineCaptionError('CAPTION_RUNTIME_UNAVAILABLE', availability.reason, 503))
    if (options.signal.aborted) return Promise.reject(options.signal.reason)
    return new Promise((resolve, reject) => {
      const job: Job = { id: this.randomUUID(), token: this.randomUUID(), spec, onProgress: options.onProgress ?? (() => {}), resolve, reject }
      const abort = (): void => {
        if (!this.jobs.has(job.id)) return
        this.broadcast('cancel', { jobId: job.id })
        this.settle(job, () => reject(options.signal.reason))
      }
      options.signal.addEventListener('abort', abort, { once: true })
      const cleanup = (): void => { options.signal.removeEventListener('abort', abort) }
      job.resolve = (value) => { cleanup(); resolve(value) }
      job.reject = (error) => { cleanup(); reject(error) }
      job.timer = setTimeout(() => {
        this.settle(job, () => job.reject(new TimelineCaptionError('CAPTION_RUNTIME_UNAVAILABLE', '没有窗口接手识别：请确认 VibeDev/DSH 窗口开着，然后重试。', 503)))
      }, this.claimTimeoutMs)
      this.jobs.set(job.id, job)
      this.broadcast('job', { jobId: job.id, kind: spec.kind })
    })
  }

  private runnerJob(runnerId: unknown, jobId: unknown): Job {
    if (typeof runnerId !== 'string' || typeof jobId !== 'string') throw new CaptionRunnerError(400, 'CAPTION_RUNNER_REQUEST_INVALID', 'runnerId and jobId are required')
    const job = this.jobs.get(jobId)
    if (job === undefined) throw new CaptionRunnerError(409, 'CAPTION_RUNNER_JOB_GONE', 'this recognition job has ended or was never offered')
    if (job.claimedBy !== runnerId) throw new CaptionRunnerError(409, 'CAPTION_RUNNER_NOT_CLAIMED', 'another window is doing this job')
    return job
  }

  /**
   * A page claims a job: the first claim wins.
   * @param runnerId - the page's window.
   * @param jobId - the job.
   * @returns the job's inputs.
   */
  claim(runnerId: unknown, jobId: unknown): RunnerClaim {
    if (typeof runnerId !== 'string' || typeof jobId !== 'string') throw new CaptionRunnerError(400, 'CAPTION_RUNNER_REQUEST_INVALID', 'runnerId and jobId are required')
    if (!this.runners.has(runnerId)) throw new CaptionRunnerError(409, 'CAPTION_RUNNER_UNKNOWN', 'this window is not connected; reload it')
    const job = this.jobs.get(jobId)
    if (job === undefined) throw new CaptionRunnerError(409, 'CAPTION_RUNNER_JOB_GONE', 'this recognition job has ended or was never offered')
    if (job.claimedBy !== undefined && job.claimedBy !== runnerId) throw new CaptionRunnerError(409, 'CAPTION_RUNNER_CLAIMED', 'another window took this job')
    if (job.claimedBy === undefined) {
      job.claimedBy = runnerId
      if (job.timer !== undefined) clearTimeout(job.timer)
      job.timer = setTimeout(() => {
        this.broadcast('cancel', { jobId: job.id })
        this.settle(job, () => job.reject(new TimelineCaptionError('CAPTION_RECOGNITION_TIMEOUT', '识别超过 45 分钟没有完成，已停止；请缩小范围后重试。', 504)))
      }, this.deadlineMs)
      this.broadcast('claimed', { jobId: job.id, runnerId })
    }
    const query = (index: number): string => new URLSearchParams({ job: job.id, i: String(index), t: job.token }).toString()
    return {
      jobId: job.id,
      kind: job.spec.kind,
      language: job.spec.language,
      sources: job.spec.sources.map((source, index) => ({ clipId: source.clipId, url: `${RUNNER_PREFIX}/source?${query(index)}`, sourceIn: source.sourceIn, sourceOut: source.sourceOut })),
      artifacts: { ...job.spec.artifacts },
    }
  }

  /**
   * A page reports progress.
   * @returns whether it should stop (the job was cancelled or has ended).
   */
  progress(runnerId: unknown, jobId: unknown, progress: unknown, phase: unknown): { cancelled: boolean } {
    if (typeof jobId === 'string' && !this.jobs.has(jobId) && this.ended.has(jobId)) return { cancelled: true }
    const job = this.runnerJob(runnerId, jobId)
    const value = typeof progress === 'number' && Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
    job.onProgress({ progress: value, phase: typeof phase === 'string' && phase.trim() !== '' ? phase.trim().slice(0, 160) : '识别中' })
    return { cancelled: false }
  }

  /**
   * A page posts its result or its failure.
   * @param body - `{runnerId, jobId, result?}` or `{runnerId, jobId, error}`.
   */
  result(body: Record<string, unknown>): void {
    const job = this.runnerJob(body.runnerId, body.jobId)
    if (typeof body.error === 'string') {
      const message = body.error.trim().slice(0, 500) || '识别页面报告失败。'
      this.settle(job, () => job.reject(new TimelineCaptionError('CAPTION_RECOGNITION_FAILED', message, 422)))
      return
    }
    if (!('result' in body)) throw new CaptionRunnerError(400, 'CAPTION_RUNNER_REQUEST_INVALID', 'a result or an error is required')
    this.settle(job, () => job.resolve(body.result))
  }

  /**
   * The snapshot a claimed job's source URL names.
   * @returns its path.
   */
  sourceFile(jobId: string | null, index: string | null, token: string | null): string {
    const job = jobId === null ? undefined : this.jobs.get(jobId)
    if (job === undefined || job.claimedBy === undefined) throw new CaptionRunnerError(404, 'CAPTION_RUNNER_JOB_GONE', 'no running recognition job has this source')
    if (token !== job.token) throw new CaptionRunnerError(403, 'CAPTION_RUNNER_FORBIDDEN', 'this source belongs to another job')
    const source = /^\d{1,3}$/.test(index ?? '') ? job.spec.sources[Number(index)] : undefined
    if (source === undefined) throw new CaptionRunnerError(404, 'CAPTION_RUNNER_SOURCE_NOT_FOUND', 'no such source in this job')
    return source.file
  }

  /** Stop every job (the plugin is unloading). */
  dispose(): void {
    for (const job of [...this.jobs.values()]) {
      this.broadcast('cancel', { jobId: job.id })
      this.settle(job, () => job.reject(new TimelineCaptionError('CAPTION_RUNTIME_UNAVAILABLE', '影视工作台正在关闭。', 503)))
    }
  }
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
})

/** The largest result a page may post: an hour of 16 kHz speech as base64 WAV fits. */
const RESULT_LIMIT = 256 * 1024 * 1024

/** A JSON body, refused past `limit` before it is buffered whole; the JSON type keeps plain form posts out. */
async function jsonBody(request: Request, limit: number): Promise<Record<string, unknown>> {
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) throw new CaptionRunnerError(415, 'CAPTION_RUNNER_REQUEST_INVALID', 'send the body as application/json')
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    if (reader === undefined) break
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw new CaptionRunnerError(413, 'CAPTION_RUNNER_RESULT_TOO_LARGE', 'the body is too large')
    }
    chunks.push(value)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new CaptionRunnerError(400, 'CAPTION_RUNNER_REQUEST_INVALID', 'the body is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CaptionRunnerError(400, 'CAPTION_RUNNER_REQUEST_INVALID', 'the body must be a JSON object')
  return value as Record<string, unknown>
}

const answering = (handle: (request: Request) => Promise<Response>) => async (request: Request): Promise<Response> => {
  try {
    return await handle(request)
  } catch (error) {
    const known = error instanceof CaptionRunnerError ? error : undefined
    const status = known?.status ?? 500
    if (request.method === 'HEAD') return new Response(null, { status })
    return json(status, { error: error instanceof Error ? error.message : String(error), code: known?.code ?? 'INTERNAL' })
  }
}

/**
 * The runner's Host routes.
 * @param hub - the runner hub.
 * @returns the routes.
 */
export function captionRunnerRoutes(hub: CaptionRunnerHub): ConnectionFetchRoute[] {
  return [
    {
      path: `${RUNNER_PREFIX}/events`, methods: ['GET'], requestBody: 'buffered',
      fetch: answering(async request => eventStream(request, (stream) => {
        const runnerId = hub.connect(stream)
        return () => { hub.disconnect(runnerId) }
      })),
    },
    {
      path: `${RUNNER_PREFIX}/claim`, methods: ['POST'], requestBody: 'buffered',
      fetch: answering(async (request) => {
        const body = await jsonBody(request, 64 * 1024)
        return json(200, hub.claim(body.runnerId, body.jobId))
      }),
    },
    {
      path: `${RUNNER_PREFIX}/progress`, methods: ['POST'], requestBody: 'buffered',
      fetch: answering(async (request) => {
        const body = await jsonBody(request, 64 * 1024)
        return json(200, hub.progress(body.runnerId, body.jobId, body.progress, body.phase))
      }),
    },
    {
      // Streamed: a region extraction's WAV bytes exceed the Host's buffered JSON cap.
      path: `${RUNNER_PREFIX}/result`, methods: ['POST'], requestBody: 'streaming',
      fetch: answering(async (request) => {
        hub.result(await jsonBody(request, RESULT_LIMIT))
        return json(200, { ok: true })
      }),
    },
    {
      path: `${RUNNER_PREFIX}/source`, methods: ['GET', 'HEAD'], requestBody: 'buffered',
      fetch: answering(async (request) => {
        const query = new URL(request.url).searchParams
        const file = hub.sourceFile(query.get('job'), query.get('i'), query.get('t'))
        const info = await stat(file)
        return serveFile(request, { path: file, size: info.size, modified: info.mtime, type: mediaTypeOf(file)?.type ?? 'application/octet-stream', headers: { 'Cache-Control': 'no-store' } })
      }),
    },
  ]
}
