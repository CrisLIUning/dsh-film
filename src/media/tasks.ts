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
 * The same store holds local tasks — work the Host runs itself, such as
 * rendering the cut or recognising its speech — with the same wait and cancel
 * routes. A local task ends once: a cancel or a restart leaves it interrupted,
 * and a run that finishes afterwards cannot overwrite that.
 *
 * A reference may also be a Studio URL of the film's own files: a bound
 * screenplay reference version (`/api/projects/<id>/story/documents/<doc>/
 * references/<asset>/<version>`, what a wired screenplay source card hands
 * the canvas) is resolved to the file holding exactly those bytes, and a raw
 * file URL (`/api/projects/<id>/raw/<path>`) to that file.
 * @module dsh-film/media/tasks
 */

import { randomUUID } from 'node:crypto'
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

/** The produced file, project-relative (the project is the workspace's `film/`), plus what a local task adds (a recognition's draft). */
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

export type FilmTaskSurface = 'image' | 'video' | 'audio' | 'video-editor'

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
  /** Work the Host runs itself. */
  kind?: 'local'
  /** What a local task was asked to do: its capability, idempotency key and parameters. */
  request?: { capability: string; requestId?: string; parameters?: Record<string, unknown> }
  /** What a restart of the Host leaves a running local task as. */
  interruption?: FilmTaskError
}

/** A local task to start. */
export interface LocalTaskSpec {
  surface: FilmTaskSurface
  model: string
  capability: string
  requestId?: string
  parameters?: Record<string, unknown>
  /** The first progress line. */
  started?: string
  /** What a restart of the Host leaves the task as (default: a generic interruption). */
  interruption?: FilmTaskError
}

/** What a local task's body works with. */
export interface LocalTaskContext {
  taskId: string
  signal: AbortSignal
  /** Add a progress line (a repeat of the last one is dropped). */
  progress(line: string): void
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

  private key(cwd: string, taskId: string): string {
    return `${resolve(cwd)}\0${taskId}`
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
    // A task ends once: a late answer after a cancel or a restart is not news.
    if (TERMINAL.has(task.status) && (patch.status !== undefined || patch.file !== undefined || patch.error !== undefined)) return
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
        // An image request, a render or a recognition does not survive a restart of the Host.
        this.change(cwd, task, {
          status: 'interrupted',
          error: task.interruption ?? { message: '生成过程中宿主重启，请重新生成。', code: 'MEDIA_TASK_INTERRUPTED', status: 503 },
        }, '已中断')
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
   * cannot be cancelled at the gateway and keeps running.
   * @param cwd - the workspace.
   * @param taskId - the canvas task.
   */
  async cancel(cwd: string, taskId: string): Promise<void> {
    const task = await this.load(cwd, taskId)
    this.running.get(this.key(cwd, taskId))?.abort(new Error('cancelled'))
    // A local task stops here and now; its body's late end changes nothing.
    if (task?.kind === 'local' && !TERMINAL.has(task.status)) {
      this.change(cwd, task, { status: 'interrupted', error: { message: '已取消。', code: 'MEDIA_TASK_CANCELED', status: 499 } }, '已取消')
    }
  }

  /**
   * Start work the Host runs itself, as a task the canvas, the editing desk
   * and the agent can wait on and cancel.
   * @param cwd - the workspace.
   * @param projectId - the film's project id (echoed in snapshots).
   * @param spec - what the task is.
   * @param run - the work; its result is the task's file, its failure the task's error.
   * @returns the task id.
   */
  async startLocal(cwd: string, projectId: string, spec: LocalTaskSpec, run: (context: LocalTaskContext) => Promise<FilmTaskFile>): Promise<{ taskId: string; status: FilmTaskStatus }> {
    const taskId = randomUUID()
    const task: FilmTask = {
      taskId, projectId, surface: spec.surface, model: spec.model, status: 'running', startedAt: Date.now(), endedAt: null,
      progress: [spec.started ?? '已开始'], error: null, kind: 'local',
      request: { capability: spec.capability, ...(spec.requestId !== undefined ? { requestId: spec.requestId } : {}), ...(spec.parameters !== undefined ? { parameters: spec.parameters } : {}) },
      ...(spec.interruption !== undefined ? { interruption: spec.interruption } : {}),
    }
    const key = this.key(cwd, taskId)
    this.tasks.set(key, task)
    await this.save(cwd, task)
    const controller = new AbortController()
    this.running.set(key, controller)
    const context: LocalTaskContext = { taskId, signal: controller.signal, progress: (line) => { this.change(cwd, task, {}, line) } }
    void (async () => {
      try {
        const file = await run(context)
        this.change(cwd, task, { status: 'done', file }, '完成')
      } catch (error) {
        if (controller.signal.aborted) this.change(cwd, task, { status: 'interrupted', error: { message: '已取消。', code: 'MEDIA_TASK_CANCELED', status: 499 } }, '已取消')
        else this.change(cwd, task, { status: 'failed', error: errorOf(error) }, '失败')
      } finally {
        if (this.running.get(key) === controller) this.running.delete(key)
      }
    })()
    return { taskId, status: task.status }
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

  /** Stop following dsh-media tasks (the plugin is unloading). */
  dispose(): void {
    for (const stop of this.following.values()) stop()
    this.following.clear()
    for (const controller of this.running.values()) controller.abort(new Error('disposed'))
  }
}
