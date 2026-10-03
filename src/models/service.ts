/**
 * The editing desk's AI models: which ones it may download, whether the
 * person agreed to each download, and the verified copies kept on this
 * machine. Ported from Studio's `production-video-editor-models.ts`.
 *
 * The list is `models/video-editor-models.json` (see
 * `scripts/editor-models.mjs`): pinned files on the VibeDev model mirror,
 * each with its size and SHA-256, and only models whose licence is clear.
 * Nothing is downloaded before the person agrees; agreements are kept per
 * model in `consents.json` beside the files. A file counts as present only
 * when its size and digest match, and is served only then.
 * @module dsh-film/models/service
 */

import { createHash, randomUUID as cryptoRandomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { STALL_TIMEOUT_MS, VerifiedDownloadFailure, downloadVerifiedFile } from './download.js'

export interface EditorModelArtifact {
  id: string
  fileName: string
  bytes: number
  sha256: string
  sources: readonly string[]
}

export interface EditorModelManifest {
  id: string
  label: string
  /** The editor capability that uses it (`tts`, `segmentation`, `caption-font`...). */
  capability: string
  revision: string
  license: { name: string; notice?: string; url?: string }
  /** Models agreed to together (all caption fonts share one licence and one question). */
  group?: string
  artifacts: readonly EditorModelArtifact[]
}

/** What the editor is told about a model: no source URLs, the hosts they are on. */
export interface EditorModelListing {
  schemaVersion: 1
  id: string
  label: string
  capability: string
  revision: string
  license: EditorModelManifest['license']
  consent: 'download'
  group?: string
  /** How many models share the group, this one included. */
  groupSize?: number
  totalBytes: number
  sourceHosts: string[]
  artifacts: { id: string; fileName: string; bytes: number; sha256: string }[]
}

export interface EditorModelTask {
  taskId: string
  modelId: string
  status: 'running' | 'done' | 'failed' | 'interrupted'
  progress: number
  /** What is happening, in words for people. */
  phase: string
  cached: boolean
  error?: { code: string; message: string }
}

/** A failure with the HTTP status and code the routes answer. */
export class EditorModelError extends Error {
  override name = 'EditorModelError'

  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const SHA256 = /^[0-9a-f]{64}$/

/** Hosts a download may end up on after redirects. */
const TRUSTED_HOSTS: ReadonlySet<string> = new Set([
  'vibedev.jzsaas.com',
  'raw.githubusercontent.com',
  'storage.googleapis.com',
])

/** How long a finished task stays readable. */
const FINISHED_TASK_TTL_MS = 10 * 60_000

/**
 * The packaged model list.
 * @returns the manifests in `models/video-editor-models.json`.
 */
export function packagedModelManifests(): EditorModelManifest[] {
  const file = JSON.parse(readFileSync(new URL('../../models/video-editor-models.json', import.meta.url), 'utf8')) as { models: EditorModelManifest[] }
  return file.models
}

/**
 * Where the models are kept by default: `$DSH_HOME/cache/dsh-film/video-editor-models`,
 * `~/.dsh` standing in for an unset or blank `DSH_HOME`.
 * @param env - the environment.
 * @returns the absolute directory.
 */
export function defaultModelsRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env.DSH_HOME
  const home = configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
  return resolve(home, 'cache', 'dsh-film', 'video-editor-models')
}

function validate(manifest: EditorModelManifest): void {
  if (!SAFE_ID.test(manifest.id) || !SAFE_ID.test(manifest.revision) || manifest.artifacts.length === 0) {
    throw new Error(`invalid editor model manifest: ${manifest.id}`)
  }
  const ids = new Set<string>()
  for (const artifact of manifest.artifacts) {
    const bad = !SAFE_ID.test(artifact.id)
      || ids.has(artifact.id)
      || artifact.fileName.includes('/') || artifact.fileName.includes('\\') || artifact.fileName.startsWith('.')
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0
      || !SHA256.test(artifact.sha256)
      || artifact.sources.length === 0
      || artifact.sources.some((source) => {
        try {
          return new URL(source).protocol !== 'https:'
        } catch {
          return true
        }
      })
    if (bad) throw new Error(`invalid editor model artifact: ${manifest.id}/${artifact.id}`)
    ids.add(artifact.id)
  }
}

async function digestOf(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += (chunk as Buffer).byteLength
    hash.update(chunk as Buffer)
  }
  return { bytes, sha256: hash.digest('hex') }
}

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

interface Task extends EditorModelTask {
  updatedAt: number
}

interface Preparation {
  controller: AbortController
  taskIds: Set<string>
  promise: Promise<void>
}

export interface EditorModelsOptions {
  /** The directory the models and `consents.json` live in. */
  root: string
  manifests?: readonly EditorModelManifest[]
  fetch?: typeof fetch
  randomUUID?: () => string
  /** Hosts a download may end up on; the mirror and the two upstream hosts by default. */
  isTrustedHost?: (hostname: string) => boolean
  stallTimeoutMs?: number
  now?: () => number
}

export class EditorModels {
  private readonly root: string
  private readonly manifests = new Map<string, EditorModelManifest>()
  private readonly groups = new Map<string, string[]>()
  private readonly fetch: typeof fetch
  private readonly randomUUID: () => string
  private readonly isTrustedHost: (hostname: string) => boolean
  private readonly stallTimeoutMs: number
  private readonly now: () => number
  private readonly tasks = new Map<string, Task>()
  private readonly preparations = new Map<string, Preparation>()
  /** Files whose digest matched, by path: the size and time they had then. */
  private readonly verified = new Map<string, string>()
  private consents: Promise<Record<string, boolean>> | undefined
  private consentWrite: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(options: EditorModelsOptions) {
    this.root = options.root
    this.fetch = options.fetch ?? fetch
    this.randomUUID = options.randomUUID ?? cryptoRandomUUID
    this.isTrustedHost = options.isTrustedHost ?? (hostname => TRUSTED_HOSTS.has(hostname.toLowerCase()))
    this.stallTimeoutMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS
    this.now = options.now ?? Date.now
    for (const manifest of options.manifests ?? packagedModelManifests()) {
      validate(manifest)
      if (this.manifests.has(manifest.id)) throw new Error(`duplicate editor model manifest: ${manifest.id}`)
      this.manifests.set(manifest.id, manifest)
      if (manifest.group !== undefined) this.groups.set(manifest.group, [...this.groups.get(manifest.group) ?? [], manifest.id])
    }
  }

  /** Every model the editor may ask for. */
  list(): EditorModelListing[] {
    return [...this.manifests.values()].map(manifest => ({
      schemaVersion: 1,
      id: manifest.id,
      label: manifest.label,
      capability: manifest.capability,
      revision: manifest.revision,
      license: manifest.license,
      consent: 'download',
      ...(manifest.group !== undefined ? { group: manifest.group, groupSize: this.groups.get(manifest.group)!.length } : {}),
      totalBytes: manifest.artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
      sourceHosts: [...new Set(manifest.artifacts.flatMap(artifact => artifact.sources.map(source => new URL(source).hostname)))],
      artifacts: manifest.artifacts.map(({ sources: _sources, ...artifact }) => artifact),
    }))
  }

  /**
   * One model's manifest.
   * @param modelId - the model.
   * @throws {@link EditorModelError} 404 for a model that is not on the list.
   */
  manifest(modelId: string): EditorModelManifest {
    const manifest = this.manifests.get(modelId)
    if (manifest === undefined) throw new EditorModelError(404, 'VIDEO_EDITOR_MODEL_NOT_FOUND', `剪辑台不提供这个模型：${modelId}`)
    return manifest
  }

  private readConsents(): Promise<Record<string, boolean>> {
    this.consents ??= readFile(join(this.root, 'consents.json'), 'utf8')
      .then((text) => {
        const value: unknown = JSON.parse(text)
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, boolean> : {}
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}
        this.consents = undefined
        throw error
      })
    return this.consents
  }

  /**
   * Whether the person agreed to download a model.
   * @param modelId - the model.
   */
  async consent(modelId: string): Promise<{ modelId: string; granted: boolean }> {
    this.manifest(modelId)
    return { modelId, granted: (await this.readConsents())[modelId] === true }
  }

  /**
   * Record the person's answer for a model, or for every model of its group.
   * @param modelId - the model asked about.
   * @param granted - the answer.
   * @param group - apply it to the model's whole group.
   * @returns the models the answer now covers.
   */
  async setConsent(modelId: string, granted: boolean, group = false): Promise<{ modelId: string; granted: boolean; modelIds: string[] }> {
    const manifest = this.manifest(modelId)
    const modelIds = group && manifest.group !== undefined ? this.groups.get(manifest.group)! : [modelId]
    const write = this.consentWrite.then(async () => {
      const consents = { ...await this.readConsents() }
      for (const id of modelIds) consents[id] = granted
      await mkdir(this.root, { recursive: true })
      const file = join(this.root, 'consents.json')
      const temporary = `${file}.tmp-${this.randomUUID()}`
      await writeFile(temporary, `${JSON.stringify(consents, null, 2)}\n`, 'utf8')
      await rename(temporary, file)
      this.consents = Promise.resolve(consents)
    })
    // A failed write must not wedge the ones after it.
    this.consentWrite = write.catch(() => {})
    await write
    return { modelId, granted, modelIds }
  }

  private artifactPath(manifest: EditorModelManifest, artifact: EditorModelArtifact): string {
    return join(this.root, manifest.id, manifest.revision, artifact.fileName)
  }

  /** Whether a file is present with the artifact's size and digest; digests are remembered per size and time. */
  private async present(path: string, artifact: EditorModelArtifact): Promise<boolean> {
    let info
    try {
      info = await stat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!info.isFile() || info.size !== artifact.bytes) return false
    const stamp = `${info.size}:${info.mtimeMs}`
    if (this.verified.get(path) === stamp) return true
    const digest = await digestOf(path)
    const ok = digest.bytes === artifact.bytes && digest.sha256 === artifact.sha256
    if (ok) this.verified.set(path, stamp)
    else this.verified.delete(path)
    return ok
  }

  private update(preparation: Preparation, change: Partial<Task>): void {
    for (const taskId of preparation.taskIds) {
      const task = this.tasks.get(taskId)
      if (task?.status === 'running') Object.assign(task, change, { updatedAt: this.now() })
    }
  }

  private async prepare(manifest: EditorModelManifest, preparation: Preparation): Promise<void> {
    const total = manifest.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)
    let done = 0
    let allCached = true
    this.update(preparation, { phase: `正在检查本机的 ${manifest.label}` })
    for (const artifact of manifest.artifacts) {
      const target = this.artifactPath(manifest, artifact)
      if (await this.present(target, artifact)) {
        done += artifact.bytes
        this.update(preparation, { progress: Math.round((done / total) * 100) })
        continue
      }
      allCached = false
      await rm(target, { force: true }).catch(() => {})
      await mkdir(join(this.root, manifest.id, manifest.revision), { recursive: true })
      const label = `正在下载 ${manifest.label}（共 ${megabytes(total)}）`
      this.update(preparation, { phase: label })
      try {
        await downloadVerifiedFile({
          sources: artifact.sources,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          target,
          signal: preparation.controller.signal,
          fetch: this.fetch,
          isTrustedUrl: url => url.protocol === 'https:' && this.isTrustedHost(url.hostname),
          randomUUID: this.randomUUID,
          stallTimeoutMs: this.stallTimeoutMs,
          onBytes: (loaded) => {
            this.update(preparation, { progress: Math.min(99, Math.round(((done + loaded) / total) * 100)), phase: label })
          },
        })
      } catch (error) {
        if (!(error instanceof VerifiedDownloadFailure)) throw error
        if (error.integrityFailure) {
          throw new EditorModelError(502, 'VIDEO_EDITOR_MODEL_INTEGRITY_FAILED', `${manifest.label} 的文件 ${artifact.fileName} 校验不通过，已丢弃，请稍后重试。`)
        }
        const reason = error.lastError instanceof Error ? error.lastError.message : String(error.lastError)
        throw new EditorModelError(502, 'VIDEO_EDITOR_MODEL_DOWNLOAD_FAILED', `${manifest.label} 下载失败（${reason}），请检查网络后重试。`)
      }
      const info = await stat(target)
      this.verified.set(target, `${info.size}:${info.mtimeMs}`)
      done += artifact.bytes
    }
    for (const taskId of preparation.taskIds) {
      const task = this.tasks.get(taskId)
      if (task?.status === 'running') {
        Object.assign(task, { status: 'done', cached: true, progress: 100, phase: allCached ? `${manifest.label} 已在本机` : `${manifest.label} 已下载`, updatedAt: this.now() })
      }
    }
  }

  private prune(): void {
    const before = this.now() - FINISHED_TASK_TTL_MS
    for (const [taskId, task] of this.tasks) {
      if (task.status !== 'running' && task.updatedAt < before) this.tasks.delete(taskId)
    }
  }

  /**
   * Start getting a model ready: files already present are checked, missing
   * ones downloaded. Callers asking for the same model share one download.
   * @param modelId - the model.
   * @returns the task to follow.
   * @throws {@link EditorModelError} 409 when the person has not agreed.
   */
  async startPrepare(modelId: string): Promise<{ taskId: string; status: 'running' }> {
    const manifest = this.manifest(modelId)
    if (this.disposed) throw new EditorModelError(503, 'VIDEO_EDITOR_MODEL_UNAVAILABLE', '影视工作台正在关闭。')
    if ((await this.readConsents())[modelId] !== true) {
      throw new EditorModelError(409, 'VIDEO_EDITOR_MODEL_CONSENT_REQUIRED', `下载 ${manifest.label} 之前需要你的同意。`)
    }
    this.prune()
    const taskId = this.randomUUID()
    this.tasks.set(taskId, { taskId, modelId, status: 'running', progress: 0, phase: '排队中', cached: false, updatedAt: this.now() })
    let preparation = this.preparations.get(modelId)
    if (preparation === undefined) {
      const created: Preparation = { controller: new AbortController(), taskIds: new Set(), promise: Promise.resolve() }
      this.preparations.set(modelId, created)
      created.promise = this.prepare(manifest, created)
        .catch((error: unknown) => {
          const canceled = created.controller.signal.aborted
          const failure = error instanceof EditorModelError
            ? error
            : canceled
              ? new EditorModelError(499, 'VIDEO_EDITOR_MODEL_CANCELED', `已取消下载 ${manifest.label}。`)
              : new EditorModelError(502, 'VIDEO_EDITOR_MODEL_DOWNLOAD_FAILED', `${manifest.label} 没能准备好：${error instanceof Error ? error.message : String(error)}`)
          for (const subscriber of created.taskIds) {
            const task = this.tasks.get(subscriber)
            if (task?.status !== 'running') continue
            task.status = failure.code === 'VIDEO_EDITOR_MODEL_CANCELED' ? 'interrupted' : 'failed'
            task.phase = task.status === 'interrupted' ? '已取消' : '下载失败'
            task.error = { code: failure.code, message: failure.message }
            task.updatedAt = this.now()
          }
        })
        .finally(() => {
          if (this.preparations.get(modelId) === created) this.preparations.delete(modelId)
        })
      preparation = created
    }
    preparation.taskIds.add(taskId)
    return { taskId, status: 'running' }
  }

  /**
   * A task's state.
   * @param taskId - the task.
   */
  task(taskId: string): EditorModelTask {
    const task = this.tasks.get(taskId)
    if (task === undefined) throw new EditorModelError(404, 'VIDEO_EDITOR_MODEL_TASK_NOT_FOUND', '找不到这个模型下载任务。')
    const { updatedAt: _updatedAt, ...snapshot } = task
    return { ...snapshot, ...(task.error !== undefined ? { error: { ...task.error } } : {}) }
  }

  /**
   * Stop following a task; the download stops when no one else follows it.
   * @param taskId - the task.
   * @returns whether the task was still running.
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (task === undefined) throw new EditorModelError(404, 'VIDEO_EDITOR_MODEL_TASK_NOT_FOUND', '找不到这个模型下载任务。')
    if (task.status !== 'running') return false
    Object.assign(task, {
      status: 'interrupted',
      phase: '已取消',
      error: { code: 'VIDEO_EDITOR_MODEL_CANCELED', message: '已取消下载。' },
      updatedAt: this.now(),
    })
    const preparation = this.preparations.get(task.modelId)
    preparation?.taskIds.delete(taskId)
    if (preparation !== undefined && preparation.taskIds.size === 0) preparation.controller.abort(new DOMException('The download was canceled.', 'AbortError'))
    return true
  }

  /**
   * A model file that is present and verified.
   * @param modelId - the model.
   * @param artifactId - the file's id in the manifest.
   * @returns where it is.
   * @throws {@link EditorModelError} 404 for an unknown file, 409 when it is not ready.
   */
  async artifactFile(modelId: string, artifactId: string): Promise<{ path: string; size: number; modified: Date; fileName: string }> {
    const manifest = this.manifest(modelId)
    const artifact = manifest.artifacts.find(candidate => candidate.id === artifactId)
    if (artifact === undefined) throw new EditorModelError(404, 'VIDEO_EDITOR_MODEL_ARTIFACT_NOT_FOUND', `${manifest.label} 没有这个文件：${artifactId}`)
    const path = this.artifactPath(manifest, artifact)
    if (!await this.present(path, artifact)) throw new EditorModelError(409, 'VIDEO_EDITOR_MODEL_NOT_READY', `${manifest.label} 还没有下载好。`)
    const info = await stat(path)
    return { path, size: info.size, modified: info.mtime, fileName: artifact.fileName }
  }

  /** Settles when no download is running. */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.preparations.values()].map(preparation => preparation.promise))
  }

  /** Stop every download (the plugin is unloading). */
  dispose(): void {
    this.disposed = true
    for (const preparation of this.preparations.values()) preparation.controller.abort(new DOMException('The download was canceled.', 'AbortError'))
  }
}
