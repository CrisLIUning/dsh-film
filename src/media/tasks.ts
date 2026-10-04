/**
 * Media tasks of the storyboard canvas, in Studio's shape
 * (`POST /api/projects/:id/media/generate` → `{ taskId }`, then
 * `POST /api/media/tasks/:id/wait` long-polls), generated through dsh-media's
 * `vibedevMedia` service. Images run in the background here; videos become
 * dsh-media tasks, which dsh-media follows to the end and saves.
 *
 * Tasks are kept in `film/.tasks/<id>.json`, so a board reopened after a
 * restart can still pick up a running video.
 *
 * Local tasks are work the Host runs itself: since 0.3 the canvas's lossless
 * media edits (cut, join, extract audio — `startLocal`, media/edit.ts), as
 * 0.1 ran its own cut. They carry `kind: 'local'` and their `request`
 * (capability, idempotency key, parameters); a cancel aborts the work and
 * leaves the task interrupted with its `cancellation`, and a restart leaves
 * an unfinished one interrupted, so an old 0.1 record reads as interrupted too.
 *
 * A reference may also be a Studio URL of the film's own files: a bound
 * screenplay reference version (`/api/projects/<id>/story/documents/<doc>/
 * references/<asset>/<version>`, what a wired screenplay source card hands
 * the canvas) is resolved to the file holding exactly those bytes, and a raw
 * file URL (`/api/projects/<id>/raw/<path>`) to that file.
 * @module dsh-film/media/tasks
 */

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { HostMediaModel } from './catalogue.js'
import { readProject } from '../project.js'
import { StoryAssets } from '../screenwriter/assets.js'
import { StoryError, StoryService } from '../screenwriter/service.js'

/** What dsh-media's host service offers (its `MediaHostService`), typed here by shape. */
export interface MediaServiceLike {
  models(signal?: AbortSignal): Promise<readonly HostMediaModel[]>
  generateImages(
    request: { prompt: string; model?: string; size?: string; quality?: string; n?: number; references?: readonly string[] },
    target: MediaTarget,
    signal: AbortSignal,
  ): Promise<{ model: string; images: readonly { absolutePath: string; mediaType: string; bytes: number }[]; estimatedCny?: string }>
  startVideo(request: VideoServiceRequest, target: MediaTarget, signal: AbortSignal): Promise<MediaTaskLike>
  task(id: string): Promise<MediaTaskLike | undefined>
  onTask(id: string, listener: (task: MediaTaskLike) => void): () => void
}

export interface MediaTarget { cwd: string; folder: string; stem: string }

export interface VideoServiceRequest {
  prompt: string
  model?: string
  mode?: string
  duration?: number
  aspectRatio?: string
  resolution?: string
  generateAudio?: boolean
  firstFrame?: string
  lastFrame?: string
  referenceImages?: readonly string[]
  referenceVideos?: readonly string[]
  referenceAudios?: readonly string[]
}

export interface MediaTaskLike {
  id: string
  model: string
  status: 'submitting' | 'pending' | 'completed' | 'failed' | 'lost'
  progress?: string
  outputs?: readonly { path?: string; url?: string; durationSeconds?: number }[]
  error?: { code: string; message: string }
  estimatedCny?: string
  chargedCny?: string
}

export type FilmTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted'

/** The produced file, project-relative (the project is the workspace's `film/`), plus what an old local task added. */
export interface FilmTaskFile {
  name: string
  size: number
  kind: string
  mime: string
  model?: string
  surface?: string
  [key: string]: unknown
}

export interface FilmTaskError {
  message: string
  code?: string
  status?: number
  retryable?: boolean
  stage?: string
}

/** What a task generates. An old local task's record may name a surface no longer listed here. */
export type FilmTaskSurface = 'image' | 'video' | 'audio'

/** One task as it is stored. */
export interface FilmTask {
  taskId: string
  projectId: string
  surface: FilmTaskSurface
  model: string
  status: FilmTaskStatus
  startedAt: number
  endedAt: number | null
  progress: string[]
  file?: FilmTaskFile
  error?: FilmTaskError | null
  /** dsh-media's task, for videos. */
  mediaTaskId?: string
  /** Work the Host ran itself (0.1 records only). */
  kind?: 'local'
  /** What an old local task was asked to do: its capability, idempotency key and parameters. */
  request?: { capability: string; requestId?: string; parameters?: Record<string, unknown> }
  /** What a restart of the Host leaves an old running local task as. */
  interruption?: FilmTaskError
  /** What a cancel left an old local task as. */
  cancellation?: FilmTaskError
}

/** One answer to a wait: new progress lines since `since`, and where to continue. */
export interface FilmTaskSnapshot {
  projectId: string
  taskId: string
  status: FilmTaskStatus
  startedAt: number
  endedAt: number | null
  progress: string[]
  nextSince: number
  file?: FilmTaskFile
  error?: FilmTaskError | null
}

export class FilmMediaError extends Error {
  override name = 'FilmMediaError'

  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

const TASKS_DIR = 'film/.tasks'
const PROJECT_DIR = 'film'
const TERMINAL: ReadonlySet<FilmTaskStatus> = new Set(['done', 'failed', 'interrupted'])
const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/
const WAIT_CAP_MS = 25_000

/** The canvas's video modes, as the gateway names them. */
const GATEWAY_MODES: Readonly<Record<string, string>> = {
  'text-to-video': 'text_to_video',
  'image-to-video': 'first_frame',
  'first-last-frame': 'first_last_frame',
  reference: 'omni_reference',
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
}

type Body = Record<string, unknown>

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim()) : []
const isLink = (source: string): boolean => /^(https?:|data:)/i.test(source)

/**
 * Resolve a project-relative path inside the workspace's `film/` folder.
 * @param cwd - the workspace.
 * @param path - the path the canvas sent.
 * @returns the absolute path.
 */
function projectFile(cwd: string, path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.')
  if (path.includes('\0') || isAbsolute(path) || parts.length === 0 || parts.some(part => part === '..')) {
    throw new FilmMediaError(400, 'MEDIA_PATH_INVALID', `"${path}" is not a path inside the project.`)
  }
  return join(cwd, PROJECT_DIR, ...parts)
}

/** A path relative to the project, with `/` separators, for files the canvas will address. */
function projectName(cwd: string, absolute: string): string {
  return relative(join(cwd, PROJECT_DIR), absolute).split(sep).join('/')
}

/** Where a Studio URL of the film's own files points: a bound screenplay reference version, or a raw file. */
type FilmUrl = { kind: 'story'; documentId: string; assetId: string; versionId: string } | { kind: 'raw'; path: string }

/**
 * Read a reference that is a Studio URL of the film's files: relative, or
 * wrapped in the workbench's `/api/dsh-film/studio?path=` route the way a
 * page's fetch wrapper sends it.
 * @param source - a reference as the canvas sent it.
 * @returns what it names, or `undefined` for anything else.
 */
export function filmUrlOf(source: string): FilmUrl | undefined {
  let path: string
  try {
    if (source.startsWith('/api/projects/')) path = new URL(source, 'http://film.invalid').pathname
    else {
      const url = new URL(source, 'http://film.invalid')
      const wrapped = url.pathname.endsWith('/api/dsh-film/studio') ? url.searchParams.get('path') : null
      if (wrapped === null || !wrapped.startsWith('/api/projects/')) return undefined
      path = new URL(wrapped, 'http://film.invalid').pathname
    }
    const parts = path.split('/').filter(part => part !== '').map(part => decodeURIComponent(part))
    if (parts.length === 9 && parts[3] === 'story' && parts[4] === 'documents' && parts[6] === 'references') {
      return { kind: 'story', documentId: parts[5]!, assetId: parts[7]!, versionId: parts[8]! }
    }
    if (parts.length > 4 && parts[3] === 'raw') return { kind: 'raw', path: parts.slice(4).join('/') }
  } catch {
    // A malformed URL is not one of the film's.
  }
  return undefined
}

/** Order `[links..., files...]` by a declared permutation, when it is one. */
function ordered(links: string[], files: string[], order: unknown): string[] {
  const combined = [...links, ...files]
  if (!Array.isArray(order) || order.length !== combined.length) return combined
  const indexes = order.filter((index): index is number => Number.isInteger(index))
  if (new Set(indexes).size !== combined.length || indexes.some(index => index < 0 || index >= combined.length)) return combined
  return indexes.map(index => combined[index]!)
}

/** An image size for an aspect: square, landscape or portrait; the model default otherwise. */
function sizeFor(aspect: string | undefined): string | undefined {
  const match = aspect === undefined ? null : /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect)
  if (match === null) return undefined
  const ratio = Number(match[1]) / Number(match[2])
  if (Math.abs(ratio - 1) < 0.05) return '1024x1024'
  return ratio > 1 ? '1536x1024' : '1024x1536'
}

/**
 * What a person in the canvas should read for the failures they can act on;
 * dsh-media's own messages are written for the agent.
 */
const USER_MESSAGES: Readonly<Record<string, string>> = {
  NOT_SIGNED_IN: '生成需要登录 VibeDev 账号：在插件页打开 dsh-media 的设置登录。在 VibeDev 应用里会直接使用应用登录的账号。',
  INSUFFICIENT_BALANCE: 'VibeDev 余额不足，充值后再试。',
  SPENDING_DECLINED: '已取消，没有扣费。',
  ABORTED: '已取消。',
}

function errorOf(error: unknown): FilmTaskError {
  const coded = error as { code?: unknown; message?: unknown; details?: { retryable?: unknown } } | undefined
  const code = typeof coded?.code === 'string' ? coded.code : undefined
  const status = code === 'NOT_SIGNED_IN' ? 401 : code === 'INSUFFICIENT_BALANCE' ? 402 : code === 'ABORTED' ? 499 : 502
  return {
    message: (code === undefined ? undefined : USER_MESSAGES[code]) ?? (error instanceof Error ? error.message : String(error)),
    ...code === undefined ? {} : { code },
    status,
    ...typeof coded?.details?.retryable === 'boolean' ? { retryable: coded.details.retryable } : {},
  }
}

/** What a task the Host stopped reports (a restart): its own interruption, or the generic one. */
function interruptedError(task: FilmTask): FilmTaskError {
  if (task.interruption !== undefined) return task.interruption
  if (task.kind === 'local' && task.request?.capability.startsWith('video.') === true) {
    return { message: '剪辑过程中宿主重启，请重新操作。', code: 'MEDIA_TASK_INTERRUPTED', status: 503 }
  }
  return { message: '生成过程中宿主重启，请重新生成。', code: 'MEDIA_TASK_INTERRUPTED', status: 503 }
}

/** The media edits the Host runs itself (C10). */
export type LocalCapability = 'video.cut' | 'video.join' | 'video.extract-audio'

/** What one media edit is asked to do. */
export interface LocalTaskRequest {
  capability: LocalCapability
  /** The caller's idempotency key: the same key again answers with the same task. */
  requestId: string
  parameters: Record<string, unknown>
  surface: 'video' | 'audio'
}

/** The work of a media edit: produce the file, reporting progress lines; stop when the signal aborts. */
export type LocalTaskRun = (signal: AbortSignal, progress: (line: string) => void) => Promise<FilmTaskFile>

/** How many media edits may run at once in one workspace. */
export const LOCAL_TASK_LIMIT = 2

const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/

/** Why a local task failed, for the record. */
function localErrorOf(error: unknown): FilmTaskError {
  const coded = error as { status?: unknown; code?: unknown; message?: unknown } | undefined
  return {
    message: error instanceof Error ? error.message : String(error),
    ...typeof coded?.code === 'string' ? { code: coded.code } : {},
    status: typeof coded?.status === 'number' ? coded.status : 500,
  }
}

/** Why the running work of a task store that is being disposed stopped. */
class TasksDisposedError extends Error {
  override name = 'TasksDisposedError'
}

/** The screenplay services a task resolves bound references with, when none are given. */
function defaultReferences(): { stories: StoryService; assets: StoryAssets } {
  const stories = new StoryService()
  return { stories, assets: new StoryAssets(stories) }
}

export class FilmMediaTasks {
  private readonly tasks = new Map<string, FilmTask>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly running = new Map<string, AbortController>()
  private readonly following = new Map<string, () => void>()
  private readonly saves = new Map<string, Promise<void>>()
  /** Each spelling of a workspace that has a real path, and that path. */
  private readonly workspaces = new Map<string, string>()
  /** Media edits running, per workspace (real path). */
  private readonly localRunning = new Map<string, Set<string>>()
  /** The task each media edit's request id started, by workspace and request id. */
  private readonly requests = new Map<string, string>()

  /**
   * @param media - dsh-media's service, when the plugin is installed and running.
   * @param references - the screenplays and their reference images, for references given as bound-version URLs.
   */
  constructor(private readonly media: () => MediaServiceLike | undefined, private readonly references: { stories: StoryService; assets: StoryAssets } = defaultReferences()) {}

  /**
   * The project files that the film URLs among a request's references name,
   * as absolute paths: a bound reference version only while a file holds
   * exactly its recorded bytes.
   * @param cwd - the workspace.
   * @param body - Studio's generate body.
   * @returns each such reference and its file.
   */
  private async filmReferences(cwd: string, body: Body): Promise<Map<string, string>> {
    const sources = new Set(['images', 'image', 'referenceImages', 'firstFrame', 'lastFrame', 'referenceVideo', 'referenceVideos', 'referenceAudio', 'referenceAudios']
      .flatMap(key => texts(Array.isArray(body[key]) ? body[key] : [body[key]])))
    const resolved = new Map<string, string>()
    for (const source of sources) {
      const target = filmUrlOf(source)
      if (target === undefined) continue
      if (target.kind === 'raw') {
        resolved.set(source, projectFile(cwd, target.path))
        continue
      }
      try {
        const boardId = (await readProject(cwd))?.id ?? 'film'
        const document = await this.references.stories.get(cwd, target.documentId)
        const file = await this.references.assets.readReference(cwd, document, target.assetId, target.versionId, boardId)
        resolved.set(source, projectFile(cwd, file.resolvedPath))
      } catch (error) {
        if (error instanceof StoryError) throw new FilmMediaError(error.status, error.code, `参考图不可用：${error.message}`)
        throw error
      }
    }
    return resolved
  }

  private service(): MediaServiceLike {
    const media = this.media()
    if (media === undefined) throw new FilmMediaError(503, 'MEDIA_SERVICE_UNAVAILABLE', '生成需要 dsh-media 插件（VibeDev 媒体生成）。请在插件页安装并启用它。')
    return media
  }

  /**
   * A task's key: its workspace by real path, so the desk and the agent, who
   * may spell the workspace differently, share one live task — a second copy
   * read from disk would take the running task for one a restart left behind.
   */
  private key(cwd: string, taskId: string): string {
    let real = this.workspaces.get(cwd)
    if (real === undefined) {
      try {
        real = realpathSync.native(cwd)
        this.workspaces.set(cwd, real)
      } catch {
        real = resolve(cwd)
      }
    }
    return `${real}\0${taskId}`
  }

  /** The workspace's real path, the part of {@link key} before the task id. */
  private workspace(cwd: string): string {
    return this.key(cwd, '').slice(0, -1)
  }

  /**
   * The task an idempotency key started, in memory or on disk.
   * @param cwd - the workspace.
   * @param requestId - the key.
   * @returns the task, or `undefined`.
   */
  private async byRequest(cwd: string, requestId: string): Promise<FilmTask | undefined> {
    if (!REQUEST_ID.test(requestId)) return undefined
    const known = this.requests.get(this.key(cwd, requestId))
    if (known !== undefined) return this.tasks.get(this.key(cwd, known))
    const stored = (await this.list(cwd)).find(task => task.kind === 'local' && task.request?.requestId === requestId)
    if (stored === undefined) return undefined
    this.requests.set(this.key(cwd, requestId), stored.taskId)
    return this.tasks.get(this.key(cwd, stored.taskId))
  }

  /**
   * The media edit a request id started, when it started one: the routes
   * answer a repeated request with it before checking the request again.
   * @param cwd - the workspace.
   * @param requestId - the idempotency key.
   * @param capability - the edit asked for; a different one is a conflict.
   * @returns the task id and status, or `undefined`.
   */
  async findLocal(cwd: string, requestId: string, capability: LocalCapability): Promise<{ taskId: string; status: FilmTaskStatus } | undefined> {
    const task = await this.byRequest(cwd, requestId)
    if (task === undefined) return undefined
    if (task.request?.capability !== capability) throw new FilmMediaError(409, 'MEDIA_EDIT_REQUEST_CONFLICT', `requestId ${requestId} already started a different edit.`)
    return { taskId: task.taskId, status: task.status }
  }

  /**
   * Start a media edit the Host runs itself (a cut, a join, a sound copy) as
   * a task the canvas waits for and can cancel like a generation. The same
   * request id again answers with the task it started, running or ended.
   * At most {@link LOCAL_TASK_LIMIT} run at once per workspace.
   * @param cwd - the workspace.
   * @param projectId - the project id the canvas uses (echoed in snapshots).
   * @param request - what the edit is.
   * @param run - the work.
   * @returns the task id, its status, and whether it existed already.
   */
  async startLocal(cwd: string, projectId: string, request: LocalTaskRequest, run: LocalTaskRun): Promise<{ taskId: string; status: FilmTaskStatus; existing: boolean }> {
    if (!REQUEST_ID.test(request.requestId)) throw new FilmMediaError(400, 'MEDIA_EDIT_INVALID', 'requestId must be a UUID.')
    const found = await this.byRequest(cwd, request.requestId)
    // Checked again after the wait: the same request may have started meanwhile.
    const startedMeanwhile = this.requests.get(this.key(cwd, request.requestId))
    const existing = found ?? (startedMeanwhile === undefined ? undefined : this.tasks.get(this.key(cwd, startedMeanwhile)))
    if (existing !== undefined) {
      if (existing.request?.capability !== request.capability) {
        throw new FilmMediaError(409, 'MEDIA_EDIT_REQUEST_CONFLICT', `requestId ${request.requestId} already started a different edit.`)
      }
      return { taskId: existing.taskId, status: existing.status, existing: true }
    }
    // From here to the task's creation nothing awaits: two requests cannot both pass these checks.
    const workspace = this.workspace(cwd)
    let active = this.localRunning.get(workspace)
    if (active === undefined) this.localRunning.set(workspace, active = new Set())
    if (active.size >= LOCAL_TASK_LIMIT) throw new FilmMediaError(503, 'MEDIA_EDIT_BUSY', `已有 ${active.size} 个剪辑任务在运行，请等它们完成后再试。`)
    const taskId = randomUUID()
    const key = this.key(cwd, taskId)
    const task: FilmTask = {
      taskId, projectId, surface: request.surface, model: 'host-copy', status: 'queued', startedAt: Date.now(), endedAt: null, progress: ['已提交'], error: null,
      kind: 'local', request: { capability: request.capability, requestId: request.requestId, parameters: request.parameters },
    }
    this.tasks.set(key, task)
    this.requests.set(this.key(cwd, request.requestId), taskId)
    const controller = new AbortController()
    this.running.set(key, controller)
    active.add(taskId)
    await this.save(cwd, task)
    void (async () => {
      this.change(cwd, task, { status: 'running' }, '读取片段')
      try {
        if (controller.signal.aborted) throw controller.signal.reason
        const file = await run(controller.signal, (line) => { if (!controller.signal.aborted) this.change(cwd, task, {}, line) })
        if (controller.signal.aborted) throw controller.signal.reason
        this.change(cwd, task, { status: 'done', file }, '完成')
      } catch (error) {
        if (controller.signal.aborted) {
          if (controller.signal.reason instanceof TasksDisposedError) {
            const interruption: FilmTaskError = { message: '剪辑过程中宿主停止，请重新操作。', code: 'MEDIA_TASK_INTERRUPTED', status: 503 }
            this.change(cwd, task, { status: 'interrupted', error: interruption, interruption }, '已中断')
          } else {
            const cancellation: FilmTaskError = { message: '已取消。', code: 'ABORTED', status: 499 }
            this.change(cwd, task, { status: 'interrupted', error: cancellation, cancellation }, '已取消')
          }
        } else {
          this.change(cwd, task, { status: 'failed', error: localErrorOf(error) }, '失败')
        }
      } finally {
        this.running.delete(key)
        active.delete(taskId)
      }
    })()
    return { taskId, status: task.status, existing: false }
  }

  private file(cwd: string, taskId: string): string {
    return join(cwd, ...TASKS_DIR.split('/'), `${taskId}.json`)
  }

  private async write(cwd: string, taskId: string, body: string): Promise<void> {
    const path = this.file(cwd, taskId)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, body)
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  /** Save a task's state as it is now, after any earlier save of it: an older state never lands last. */
  private save(cwd: string, task: FilmTask): Promise<void> {
    const key = this.key(cwd, task.taskId)
    const body = `${JSON.stringify(task, null, 2)}\n`
    const next = (this.saves.get(key) ?? Promise.resolve()).then(() => this.write(cwd, task.taskId, body)).catch(() => undefined)
    this.saves.set(key, next)
    void next.finally(() => { if (this.saves.get(key) === next) this.saves.delete(key) })
    return next
  }

  /** Every task save in flight has landed. */
  async settled(): Promise<void> {
    while (this.saves.size > 0) await Promise.all([...this.saves.values()])
  }

  private change(cwd: string, task: FilmTask, patch: Partial<FilmTask>, line?: string): void {
    if (TERMINAL.has(task.status)) {
      // A task ends once: a late answer after a cancel or a restart is not news,
      if (patch.status !== undefined || patch.file !== undefined || patch.error !== undefined) return
      // nor is a late progress line: the last line stays the one that ended it.
      line = undefined
      if (Object.keys(patch).length === 0) return
    }
    Object.assign(task, patch)
    if (line !== undefined && task.progress.at(-1) !== line) task.progress.push(line)
    if (TERMINAL.has(task.status) && task.endedAt === null) task.endedAt = Date.now()
    void this.save(cwd, task)
    for (const listener of this.listeners.get(this.key(cwd, task.taskId)) ?? []) listener()
  }

  /**
   * Start one generation the canvas asked for.
   * @param cwd - the workspace.
   * @param projectId - the project id the canvas uses (echoed in snapshots).
   * @param body - Studio's generate body.
   * @returns the task id.
   */
  async generate(cwd: string, projectId: string, body: Body): Promise<{ taskId: string; status: FilmTaskStatus }> {
    const media = this.service()
    const surface = body.surface
    if (surface !== 'image' && surface !== 'video' && surface !== 'audio') throw new FilmMediaError(400, 'MEDIA_SURFACE_INVALID', 'surface must be image, video or audio.')
    if (surface === 'audio') throw new FilmMediaError(400, 'MEDIA_SURFACE_UNSUPPORTED', '影视工作台暂不支持在画布里生成配音。')
    const prompt = text(body.prompt) ?? ''
    const model = text(body.model)
    // Resolved before the task exists: an unavailable reference refuses the request rather than failing a started run.
    const films = await this.filmReferences(cwd, body)
    const taskId = randomUUID()
    const output = text(body.output) ?? `canvas/media/${surface}-${taskId.slice(0, 10)}${surface === 'image' ? '.png' : '.mp4'}`
    const outputPath = projectFile(cwd, output)
    const target: MediaTarget = { cwd, folder: dirname(outputPath), stem: basename(outputPath, extname(outputPath)) }
    const task: FilmTask = { taskId, projectId, surface, model: model ?? '', status: 'queued', startedAt: Date.now(), endedAt: null, progress: ['已提交'], error: null }
    this.tasks.set(this.key(cwd, taskId), task)
    await this.save(cwd, task)
    const controller = new AbortController()
    this.running.set(this.key(cwd, taskId), controller)
    const inputs = (value: unknown): string[] => texts(value).map(source => films.get(source) ?? (isLink(source) ? source : projectFile(cwd, source)))
    const links = (value: unknown): string[] => texts(value).map(source => films.get(source) ?? source)
    const run = surface === 'image'
      ? this.runImage(cwd, task, media, {
        prompt,
        ...model === undefined ? {} : { model },
        ...sizeFor(text(body.aspect)) === undefined ? {} : { size: sizeFor(text(body.aspect))! },
        ...['low', 'medium', 'high', 'auto'].includes(String(body.quality)) ? { quality: String(body.quality) } : {},
        references: ordered(links(body.referenceImages), inputs([...texts(body.images), ...texts(body.image === undefined ? [] : [body.image])]), (body.referenceOrder as Body | undefined)?.images),
      }, target, controller.signal)
      : this.runVideo(cwd, task, media, this.videoRequest(cwd, body, prompt, model, films), target, controller.signal)
    void run.finally(() => { this.running.delete(this.key(cwd, taskId)) })
    return { taskId, status: task.status }
  }

  private videoRequest(cwd: string, body: Body, prompt: string, model: string | undefined, films: ReadonlyMap<string, string>): VideoServiceRequest {
    const resolveOne = (value: unknown): string | undefined => {
      const source = text(value)
      return source === undefined ? undefined : films.get(source) ?? (isLink(source) ? source : projectFile(cwd, source))
    }
    const localFiles = (value: unknown): string[] => texts(value).map(source => films.get(source) ?? (isLink(source) ? source : projectFile(cwd, source)))
    const links = (value: unknown): string[] => texts(value).map(source => films.get(source) ?? source)
    const order = body.referenceOrder as Body | undefined
    const canvasMode = text(body.videoMode)
    if (canvasMode === 'video-edit') throw new FilmMediaError(400, 'VIDEO_MODE_UNSUPPORTED', '影视工作台暂不支持视频编辑模式。')
    const mode = canvasMode === undefined ? undefined : GATEWAY_MODES[canvasMode]
    const images = ordered(links(body.referenceImages), localFiles(body.images), order?.images)
    const firstFrame = resolveOne(body.firstFrame) ?? (mode === 'first_frame' || mode === 'first_last_frame' ? images.shift() : undefined)
    const lastFrame = resolveOne(body.lastFrame) ?? (mode === 'first_last_frame' ? images.shift() : undefined)
    const videos = ordered(links(body.referenceVideos), localFiles(body.referenceVideo), order?.videos)
    const audios = ordered(links(body.referenceAudios), localFiles(body.referenceAudio === undefined ? [] : [body.referenceAudio]), order?.audios)
    const duration = typeof body.length === 'number' ? body.length : typeof body.duration === 'number' ? body.duration : undefined
    const aspect = text(body.aspect)
    return {
      prompt,
      ...model === undefined ? {} : { model },
      ...mode === undefined ? {} : { mode },
      ...duration === undefined ? {} : { duration },
      ...aspect === undefined || aspect === 'adaptive' ? {} : { aspectRatio: aspect },
      ...text(body.resolution) === undefined ? {} : { resolution: text(body.resolution)! },
      ...typeof body.generateAudio === 'boolean' ? { generateAudio: body.generateAudio } : {},
      ...firstFrame === undefined ? {} : { firstFrame },
      ...lastFrame === undefined ? {} : { lastFrame },
      ...images.length === 0 ? {} : { referenceImages: images },
      ...videos.length === 0 ? {} : { referenceVideos: videos },
      ...audios.length === 0 ? {} : { referenceAudios: audios },
    }
  }

  private async runImage(cwd: string, task: FilmTask, media: MediaServiceLike, request: Parameters<MediaServiceLike['generateImages']>[0], target: MediaTarget, signal: AbortSignal): Promise<void> {
    this.change(cwd, task, { status: 'running' }, '生成中')
    try {
      const result = await media.generateImages(request, target, signal)
      const image = result.images[0]
      if (image === undefined) throw new FilmMediaError(502, 'IMAGE_EMPTY', 'The gateway returned no image.')
      this.change(cwd, task, {
        status: 'done',
        model: result.model,
        file: { name: projectName(cwd, image.absolutePath), size: image.bytes, kind: 'image', mime: image.mediaType, model: result.model, surface: 'image' },
      }, '完成')
    } catch (error) {
      this.change(cwd, task, { status: signal.aborted ? 'interrupted' : 'failed', error: errorOf(error) }, signal.aborted ? '已取消' : '失败')
    }
  }

  private async runVideo(cwd: string, task: FilmTask, media: MediaServiceLike, request: VideoServiceRequest, target: MediaTarget, signal: AbortSignal): Promise<void> {
    this.change(cwd, task, { status: 'running' }, '上传参考并提交')
    try {
      const started = await media.startVideo(request, target, signal)
      this.change(cwd, task, { mediaTaskId: started.id, model: started.model })
      this.follow(cwd, task, media, started)
    } catch (error) {
      this.change(cwd, task, { status: signal.aborted ? 'interrupted' : 'failed', error: errorOf(error) }, signal.aborted ? '已取消' : '失败')
    }
  }

  /** Mirror a dsh-media task onto the canvas task until it ends. */
  private follow(cwd: string, task: FilmTask, media: MediaServiceLike, current: MediaTaskLike): void {
    const key = this.key(cwd, task.taskId)
    this.following.get(key)?.()
    const apply = (remote: MediaTaskLike): void => {
      if (TERMINAL.has(task.status)) return
      if (remote.status === 'completed') {
        const output = remote.outputs?.find(item => item.path !== undefined)
        if (output?.path === undefined) {
          this.change(cwd, task, { status: 'failed', error: { message: 'The video finished but no file was saved.', code: 'VIDEO_OUTPUT_MISSING', status: 502 } }, '失败')
        } else {
          const name = projectName(cwd, output.path)
          this.change(cwd, task, {
            status: 'done',
            file: { name, size: 0, kind: 'video', mime: MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? 'video/mp4', model: remote.model, surface: 'video' },
          }, '完成')
        }
      } else if (remote.status === 'failed' || remote.status === 'lost') {
        this.change(cwd, task, {
          status: remote.status === 'lost' ? 'interrupted' : 'failed',
          error: { message: remote.error?.message ?? '视频生成失败。', ...remote.error?.code === undefined ? {} : { code: remote.error.code }, status: 502 },
        }, '失败')
      } else {
        this.change(cwd, task, { status: 'running' }, remote.progress === undefined ? '生成中' : `生成中：${remote.progress}`)
      }
      if (TERMINAL.has(task.status)) {
        this.following.get(key)?.()
        this.following.delete(key)
      }
    }
    const stop = media.onTask(current.id, apply)
    this.following.set(key, stop)
    apply(current)
    // The service may have moved on between the submission and the subscription.
    void media.task(current.id).then(latest => { if (latest !== undefined) apply(latest) }).catch(() => undefined)
  }

  private async load(cwd: string, taskId: string): Promise<FilmTask | undefined> {
    if (!TASK_ID.test(taskId)) throw new FilmMediaError(400, 'MEDIA_TASK_INVALID', 'Invalid task id.')
    const key = this.key(cwd, taskId)
    const known = this.tasks.get(key)
    if (known !== undefined) return known
    let task: FilmTask
    try {
      task = JSON.parse(await readFile(this.file(cwd, taskId), 'utf8')) as FilmTask
    } catch {
      return undefined
    }
    this.tasks.set(key, task)
    if (!TERMINAL.has(task.status)) {
      const media = this.media()
      if (task.mediaTaskId !== undefined && media !== undefined) {
        const remote = await media.task(task.mediaTaskId).catch(() => undefined)
        if (remote !== undefined) this.follow(cwd, task, media, remote)
      } else if (task.mediaTaskId === undefined) {
        // An image request, or an old local task, does not survive a restart of the Host.
        this.change(cwd, task, { status: 'interrupted', error: interruptedError(task) }, '已中断')
      }
    }
    return task
  }

  /**
   * Answer one long-poll: at once when there is news since `since`, else when
   * the task changes or the wait times out.
   * @param cwd - the workspace.
   * @param taskId - the canvas task.
   * @param since - progress lines the canvas has seen.
   * @param timeoutMs - the longest wait (capped at 25 s).
   * @param signal - the request's lifetime.
   * @returns the snapshot.
   */
  async wait(cwd: string, taskId: string, since: number, timeoutMs: number, signal?: AbortSignal): Promise<FilmTaskSnapshot> {
    const task = await this.load(cwd, taskId)
    if (task === undefined) throw new FilmMediaError(404, 'MEDIA_TASK_NOT_FOUND', `No media task ${taskId}.`)
    const seen = Math.max(0, Math.trunc(Number.isFinite(since) ? since : 0))
    if (task.progress.length <= seen && !TERMINAL.has(task.status)) {
      await new Promise<void>((done) => {
        const key = this.key(cwd, taskId)
        let set = this.listeners.get(key)
        if (set === undefined) this.listeners.set(key, set = new Set())
        const finish = (): void => {
          clearTimeout(timer)
          set.delete(finish)
          signal?.removeEventListener('abort', finish)
          done()
        }
        const timer = setTimeout(finish, Math.min(Math.max(timeoutMs, 0), WAIT_CAP_MS))
        set.add(finish)
        signal?.addEventListener('abort', finish, { once: true })
      })
    }
    return {
      projectId: task.projectId,
      taskId: task.taskId,
      status: task.status,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      progress: task.progress.slice(seen),
      nextSince: task.progress.length,
      ...task.file === undefined ? {} : { file: task.file },
      error: task.error ?? null,
    }
  }

  /**
   * Stop waiting for a task: an image request is cancelled; a submitted video
   * cannot be cancelled at the gateway and keeps running; a media edit stops
   * and deletes its partial file.
   * @param cwd - the workspace.
   * @param taskId - the canvas task.
   */
  async cancel(cwd: string, taskId: string): Promise<void> {
    // Loading settles an old task left unfinished by a restart (it reads as interrupted).
    await this.load(cwd, taskId)
    this.running.get(this.key(cwd, taskId))?.abort(new Error('cancelled'))
  }

  /**
   * One task as stored, request and file included.
   * @param cwd - the workspace.
   * @param taskId - the task.
   * @returns a copy, or `undefined` when there is no such task.
   */
  async record(cwd: string, taskId: string): Promise<FilmTask | undefined> {
    const task = await this.load(cwd, taskId)
    return task === undefined ? undefined : structuredClone(task)
  }

  /**
   * Every task of the workspace, newest first.
   * @param cwd - the workspace.
   * @returns copies of the tasks.
   */
  async list(cwd: string): Promise<FilmTask[]> {
    const names = await readdir(join(cwd, ...TASKS_DIR.split('/'))).catch(() => [] as string[])
    const tasks: FilmTask[] = []
    for (const name of names) {
      const match = /^([A-Za-z0-9_-]{1,80})\.json$/u.exec(name)
      if (match?.[1] === undefined) continue
      const task = await this.load(cwd, match[1]).catch(() => undefined)
      if (task !== undefined) tasks.push(structuredClone(task))
    }
    return tasks.sort((left, right) => right.startedAt - left.startedAt)
  }

  /** Stop following dsh-media tasks and stop the running work (the plugin is unloading). */
  dispose(): void {
    for (const stop of this.following.values()) stop()
    this.following.clear()
    for (const controller of this.running.values()) controller.abort(new TasksDisposedError('disposed'))
  }
}
