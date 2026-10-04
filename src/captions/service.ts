/**
 * Original-audio captions for the film's cut, ported from Studio's
 * `services/timeline-captions/service.ts`: a request becomes a background
 * film task whose result is an unreviewed draft; a reviewed draft is applied
 * as one revisioned caption command; and the recognitions of a cut can be
 * listed again later with whether each was applied.
 *
 * What is Studio's and kept exactly: the same requestId with the same inputs
 * is the same task (the engine is part of the inputs here); sources are
 * snapshotted and hashed before recognition, and an apply refuses a source
 * whose bytes changed since; progress is 0–20 % for models and 20–99 % for
 * recognition; a failure is recorded only while the task still runs, so a
 * cancel stays a cancel; and a draft that does not fit the task (512 KiB)
 * keeps its full evidence in a file (`film/.tasks/caption-evidence/<taskId>.json`).
 *
 * What differs: missing model consent and a missing runner are refused before
 * a task exists (Studio failed the task afterwards), and there are two
 * engines (`engines.ts`, `gateway.ts`) with no fallback between them.
 * @module dsh-film/captions/service
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FilmMediaTasks, FilmTask } from '../media/tasks.js'
import { EditorModelError } from '../models/service.js'
import { executeTimelineCommands } from '../timeline/commands.js'
import type { TimelineCommandResult } from '../timeline/commands.js'
import { TimelineConflictError } from '../timeline/store.js'
import type { TimelineStore } from '../timeline/store.js'
import type {
  CaptionCaller,
  CaptionEngine,
  CaptionEstimate,
  TimelineCaptionApplyRequest,
  TimelineCaptionDraft,
  TimelineCaptionTaskSummary,
  TimelineTranscribeRequest,
} from './contracts.js'
import type { CaptionEngineDriver } from './engines.js'
import { mapCaptionRecognition } from './map.js'
import { TimelineCaptionError, captionApplyPlan, planTimelineTranscription } from './plan.js'

/**
 * Who is asking, for the gateway's spending confirmation: an agent tool call
 * reaches the routes in-process through the same router the pages use, and
 * this carries its agent and call id along that path without a parameter on
 * every route.
 */
export const captionCaller = new AsyncLocalStorage<CaptionCaller>()

/** The project folder inside a workspace. */
const PROJECT_DIR = 'film'
/** Where a recognition's snapshots live while it runs, relative to `film/`. */
const RUNS_DIR = '.tasks/caption-runs'
/** Where a large draft's full evidence is kept, relative to `film/` (hidden from the asset listing). */
const EVIDENCE_DIR = '.tasks/caption-evidence'
const EVIDENCE_AT = 450 * 1024
const DRAFT_LIMIT = 500 * 1024
/** Studio's limit on one source file. */
const SOURCE_LIMIT = 1024 ** 3

function sha256File(file: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => { done(hash.digest('hex')) }).on('error', fail)
  })
}

/** A source file proven, on real paths, to be a file inside the project and at most 1 GiB. */
async function owned(root: string, file: string): Promise<string> {
  const base = await realpath(root)
  let absolute: string
  try {
    absolute = await realpath(resolve(base, ...file.split('/')))
  } catch {
    throw new TimelineCaptionError('CAPTION_SOURCE_INVALID', 'source missing or larger than 1 GiB')
  }
  const offset = relative(base, absolute)
  if (offset === '' || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new TimelineCaptionError('CAPTION_SOURCE_OUTSIDE_PROJECT', 'source leaves the current project', 403)
  }
  const info = await stat(absolute)
  if (!info.isFile() || info.size > SOURCE_LIMIT) throw new TimelineCaptionError('CAPTION_SOURCE_INVALID', 'source missing or larger than 1 GiB')
  return absolute
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Whether a stored task is a recognition of this project's cut. */
function isRecognition(task: FilmTask, projectId: string): boolean {
  return task.projectId === projectId && task.request?.capability === 'transcribe' && task.request.parameters?.nativeTimeline === true
}

const appliedIds = (document: unknown): string[] => {
  const ids = isRecord(document) && isRecord(document.project) && isRecord(document.project.commandState) ? document.project.commandState.appliedOperationIds : undefined
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

/** What a start answers (202). */
export interface CaptionStartResult {
  taskId: string
  status: FilmTask['status']
  duplicate: boolean
  engine: CaptionEngine
  model: string
  estimate?: CaptionEstimate
}

export interface CaptionServiceOptions {
  tasks: FilmMediaTasks
  /** The engines this Host offers. */
  engines: Partial<Record<CaptionEngine, CaptionEngineDriver>>
  /** The cut's store for a workspace (announcing its writes to open pages). */
  timelines: (cwd: string, projectId: string) => TimelineStore
  /** The plugin setting `captionEngine`, read at each request. */
  defaultEngine?: () => CaptionEngine
}

export class CaptionService {
  private readonly active = new Set<Promise<void>>()
  private readonly starting = new Map<string, Promise<unknown>>()

  constructor(private readonly options: CaptionServiceOptions) {}

  /**
   * The cut's store for a workspace, as this service writes it.
   * @param cwd - the workspace.
   * @param projectId - the film's project id.
   * @returns the store.
   */
  timeline(cwd: string, projectId: string): TimelineStore {
    return this.options.timelines(cwd, projectId)
  }

  /** The engine a request runs on: its own, else the setting. */
  private engineOf(request: TimelineTranscribeRequest): CaptionEngineDriver {
    const id = request.engine ?? this.options.defaultEngine?.() ?? 'whisper'
    const driver = this.options.engines[id]
    if (driver === undefined) throw new TimelineCaptionError(id === 'gateway' ? 'CAPTION_ENGINE_UNAVAILABLE' : 'CAPTION_RUNTIME_UNAVAILABLE', `这个环境没有 ${id} 识别引擎。`, 503)
    return driver
  }

  /** One start at a time per workspace: the duplicate check and the task's creation must not interleave. */
  private serial<T>(cwd: string, run: () => Promise<T>): Promise<T> {
    const key = resolve(cwd)
    const turn = (this.starting.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
    this.starting.set(key, turn)
    void turn.finally(() => { if (this.starting.get(key) === turn) this.starting.delete(key) }).catch(() => {})
    return turn
  }

  /**
   * Start a recognition, or answer the task an identical earlier request started.
   * @param cwd - the workspace.
   * @param projectId - the film's project id (also its board's).
   * @param request - the checked request.
   * @param caller - the agent tool call asking, for the gateway's spending confirmation.
   * @returns the task.
   */
  start(cwd: string, projectId: string, request: TimelineTranscribeRequest, caller: CaptionCaller = captionCaller.getStore() ?? {}): Promise<CaptionStartResult> {
    return this.serial(cwd, async () => {
      const driver = this.engineOf(request)
      const identity = JSON.stringify({
        baseRevision: request.baseRevision,
        requestId: request.requestId,
        clipIds: request.clipIds,
        range: request.range,
        language: request.language,
        engine: driver.id,
      })
      const previous = (await this.options.tasks.list(cwd)).find(task => isRecognition(task, projectId) && task.request?.requestId === request.requestId)
      if (previous !== undefined) {
        if (previous.request?.parameters?.identity !== identity) throw new TimelineCaptionError('CAPTION_REQUEST_CONFLICT', 'requestId already names different inputs', 409)
        return { taskId: previous.taskId, status: previous.status, duplicate: true, engine: driver.id, model: previous.model }
      }
      const store = this.options.timelines(cwd, projectId)
      const state = await store.read()
      if (state.revision !== request.baseRevision) throw new TimelineConflictError(state.revision, request.baseRevision)
      const plan = planTimelineTranscription(state.document, request, projectId)
      const { model, estimate } = await driver.preflight({ cwd, request, plan })
      const spending = { confirmed: request.spendingConfirmed === true, ...caller }
      const language = request.language ?? 'zh'
      let finished!: () => void
      const work = new Promise<void>((done) => { finished = done })
      this.active.add(work)
      void work.finally(() => { this.active.delete(work) })
      const started = await this.options.tasks.startLocal(cwd, projectId, {
        surface: 'video-editor',
        model,
        capability: 'transcribe',
        requestId: request.requestId,
        parameters: { nativeTimeline: true, identity, baseRevision: request.baseRevision, engine: driver.id },
        started: '0% · 已提交',
        interruption: { message: '识别过程中宿主重启了，请重新识别（换一个 requestId）。', code: 'MEDIA_TASK_INTERRUPTED', status: 503 },
      }, async ({ taskId, signal, progress }) => {
        const report = (percent: number, phase: string): void => {
          if (!signal.aborted) progress(`${Math.max(0, Math.min(100, Math.round(percent)))}% · ${phase.slice(0, 160)}`)
        }
        const projectRoot = join(cwd, PROJECT_DIR)
        const runDir = join(projectRoot, ...RUNS_DIR.split('/'), taskId)
        try {
          const artifacts = await driver.prepare({ signal, onProgress: (update) => { report(update.progress * 20, update.phase) } })
          signal.throwIfAborted()
          await mkdir(runDir, { recursive: true })
          const sources = []
          for (const [index, source] of plan.sources.entries()) {
            signal.throwIfAborted()
            const original = await owned(projectRoot, source.file)
            const snapshot = join(runDir, `${index}${extname(original)}`)
            await copyFile(original, snapshot)
            source.sha256 = await sha256File(snapshot)
            sources.push({ clipId: source.clipId, file: snapshot, sourceIn: source.sourceIn, sourceOut: source.sourceOut })
          }
          signal.throwIfAborted()
          report(20, '识别中')
          const output = await driver.recognize({
            taskId, cwd, sources, artifacts, language, signal, spending, model,
            onProgress: (update) => { report(20 + update.progress * 79, update.phase) },
          })
          signal.throwIfAborted()
          // An engine may report the model that actually ran (the gateway's may be pinned in dsh-media).
          const ran = output.map(result => result.diagnostics?.model).find((value): value is string => typeof value === 'string')
          const draft: TimelineCaptionDraft = {
            schemaVersion: 1,
            kind: 'timeline-caption-draft',
            baseRevision: request.baseRevision,
            model: ran !== undefined && driver.id === 'gateway' ? `gateway:${ran}` : model,
            engine: driver.id,
            reviewStatus: 'unreviewed',
            ...plan,
            diagnostics: output.map(result => ({ sourceClipId: result.sourceClipId, evidence: result.diagnostics ?? {} })),
            segments: mapCaptionRecognition(output, plan.sources, taskId),
          }
          if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > EVIDENCE_AT) {
            const { spendingConfirmed: _spending, ...asked } = request
            const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, taskId, request: asked, raw: output, mapped: draft }), 'utf8')
            const name = `${EVIDENCE_DIR}/${taskId}.json`
            const file = join(projectRoot, ...name.split('/'))
            await mkdir(join(projectRoot, ...EVIDENCE_DIR.split('/')), { recursive: true })
            signal.throwIfAborted()
            await writeFile(file, bytes, { flag: 'wx' })
            draft.evidence = { file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
            draft.diagnostics = output.map(result => ({ sourceClipId: result.sourceClipId, evidence: { fullEvidenceFile: name } }))
          }
          const size = Buffer.byteLength(JSON.stringify(draft), 'utf8')
          if (size > DRAFT_LIMIT) throw new TimelineCaptionError('CAPTION_RANGE_TOO_LARGE', 'too many transcript lines; transcribe a smaller range')
          signal.throwIfAborted()
          return { name: `.tasks/${taskId}.json`, size, kind: 'caption-draft', mime: 'application/json', model: draft.model, surface: 'video-editor', documentResult: draft }
        } catch (error) {
          if (signal.aborted || error instanceof TimelineCaptionError || error instanceof EditorModelError) throw error
          throw new TimelineCaptionError('CAPTION_RECOGNITION_FAILED', error instanceof Error ? error.message : String(error), 422)
        } finally {
          await rm(runDir, { recursive: true, force: true }).catch(() => {})
          finished()
        }
      }).catch((error: unknown) => {
        finished()
        throw error
      })
      return { taskId: started.taskId, status: started.status, duplicate: false, engine: driver.id, model, ...(estimate !== undefined ? { estimate } : {}) }
    })
  }

  /** The recognition task of this project, or Studio's 404. */
  private async recognition(cwd: string, projectId: string, taskId: string): Promise<FilmTask> {
    const task = /^[A-Za-z0-9_-]{1,80}$/.test(taskId) ? await this.options.tasks.record(cwd, taskId) : undefined
    if (task === undefined || !isRecognition(task, projectId)) throw new TimelineCaptionError('CAPTION_TASK_NOT_FOUND', 'use the media taskId returned by timeline_transcribe in this project', 404)
    return task
  }

  /**
   * Apply a reviewed draft: one caption command, refused when the cut moved
   * on or a source changed; a retry of an applied draft writes nothing.
   * @param cwd - the workspace.
   * @param projectId - the film's project id.
   * @param request - the checked request.
   * @returns the command's result.
   */
  async apply(cwd: string, projectId: string, request: TimelineCaptionApplyRequest): Promise<TimelineCommandResult> {
    const task = await this.recognition(cwd, projectId, request.taskId)
    if (task.status !== 'done') throw new TimelineCaptionError('CAPTION_TASK_NOT_READY', 'only a completed recognition draft can be applied', 409)
    const draft = task.file?.documentResult as TimelineCaptionDraft | undefined
    if (draft?.kind !== 'timeline-caption-draft') throw new TimelineCaptionError('CAPTION_DRAFT_MISSING', 'recognition task has no draft', 409)
    const plan = captionApplyPlan(draft, task.taskId, request.reviewed, request.excludeSegmentIds)
    const store = this.options.timelines(cwd, projectId)
    const current = await store.read()
    const projectRoot = join(cwd, PROJECT_DIR)
    if (appliedIds(current.document).includes(plan.operations[0]!.id)) {
      // The engine recognises the operation and writes nothing; it never applies twice.
      plan.baseRevision = current.revision
    } else {
      for (const source of draft.sources) {
        if (await sha256File(await owned(projectRoot, source.file)) !== source.sha256) {
          throw new TimelineCaptionError('CAPTION_SOURCE_CHANGED', 'original source changed since recognition; generate a new draft', 409)
        }
      }
    }
    return executeTimelineCommands({ store, projectRoot, projectId, boardId: projectId, dryRun: request.dryRun, plan })
  }

  /**
   * The latest 20 recognitions of the cut, newest first, with whether each was applied.
   * @param cwd - the workspace.
   * @param projectId - the film's project id.
   * @returns the rows.
   */
  async list(cwd: string, projectId: string): Promise<{ tasks: TimelineCaptionTaskSummary[] }> {
    const applied = appliedIds((await this.options.timelines(cwd, projectId).read()).document)
    const tasks = (await this.options.tasks.list(cwd)).filter(task => isRecognition(task, projectId)).slice(0, 20)
    return {
      tasks: tasks.map((task) => {
        const draft = task.file?.documentResult as TimelineCaptionDraft | undefined
        const engine = task.request?.parameters?.engine
        return {
          taskId: task.taskId,
          status: task.status,
          engine: engine === 'gateway' ? 'gateway' : 'whisper',
          model: draft?.model ?? task.model,
          startedAt: task.startedAt,
          endedAt: task.endedAt,
          applied: applied.includes(`caption-asr:${task.taskId}`),
          segments: Array.isArray(draft?.segments) ? draft.segments.length : 0,
          ranges: Array.isArray(draft?.ranges) ? draft.ranges : [],
          progress: task.progress.slice(-1),
          ...(task.error !== undefined && task.error !== null ? { error: { ...(task.error.code !== undefined ? { code: task.error.code } : {}), message: task.error.message } } : {}),
        }
      }),
    }
  }

  /**
   * The engines, whether each can run now, and the default.
   * @param signal - the request's lifetime.
   * @returns the engines route's answer.
   */
  async engines(signal?: AbortSignal): Promise<{ default: CaptionEngine; engines: Record<string, unknown>[] }> {
    const engines: Record<string, unknown>[] = []
    for (const id of ['whisper', 'gateway'] as const) {
      const driver = this.options.engines[id]
      engines.push(driver === undefined ? { id, available: false, reason: `这个环境没有 ${id} 识别引擎。` } : await driver.describe(signal))
    }
    return { default: this.options.defaultEngine?.() ?? 'whisper', engines }
  }

  /** Settles when no recognition is running and every task save has landed. */
  async whenIdle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active])
    // The task's end is written one turn after its body returns.
    await new Promise(done => setTimeout(done, 0))
    await this.options.tasks.settled()
  }
}
