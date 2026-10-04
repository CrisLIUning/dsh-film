/**
 * Rendering the film's cut into the project, as a film task: Studio's
 * apps/daemon/src/routes/canvas-timeline-render.ts over the Host.
 *
 * - `POST /api/canvas/timelines/:boardId/render` — `{ baseRevision?, check?,
 *   frameRate?, resolution?, fileName? }`. With `check: true` (Studio's
 *   `dryRun`) it answers 200 with what the file would be and makes neither a
 *   task nor a file; otherwise 202 `{ taskId }` and the render runs in the
 *   background. Both refuse the same way, before any task exists.
 * - `GET /api/canvas/timelines/:boardId/renders` — the MP4s in
 *   `film/canvas/renders/`, newest first, no partials.
 *
 * The task is waited on and cancelled with the film task routes
 * (`/api/media/tasks/:taskId/wait|cancel`). Unlike Studio, a cancel stops the
 * ffmpeg tree and the task stays cancelled (`RENDER_CANCELED`), one render
 * runs per film at a time (409 `RENDER_BUSY`), the cut is planned once, a
 * finished file lands on the board in the board's document whether or not
 * the 分镜 page is open, and a missing ffmpeg says whether the renderer can
 * be downloaded (it needs the person's consent, given in the editing desk).
 * Errors answer `{ error, code, detail? }`.
 * @module dsh-film/studio/render-routes
 */

import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { landFileOnBoard } from '../canvas/board-media.js'
import { CanvasDocumentStore } from '../canvas/documents.js'
import type { FilmMediaTasks, FilmTaskFile } from '../media/tasks.js'
import { probeHasAudio as probeFileHasAudio } from '../media/probe.js'
import type { EditorModels } from '../models/service.js'
import { readProject } from '../project.js'
import { ffmpegFilterNames, resolveFfmpeg, studioFfmpegCandidates } from '../render/ffmpeg.js'
import type { ResolvedFfmpeg } from '../render/ffmpeg.js'
import { RENDER_DIR, TimelineRenderError, buildTimelinePlan, normalizeRenderRequest, removeStalePartials, renderOutputPath, renderTimeline } from '../render/timeline-render.js'
import type { FfmpegRunner, ProbeHasAudio, TimelineRenderInput, TimelineRenderOutput } from '../render/timeline-render.js'
import { TimelineStore } from '../timeline/store.js'
import { projectOf } from './canvas-routes.js'
import type { ProjectEvents } from './events.js'
import { PROJECT_DIR, freeProjectPath } from './project-routes.js'
import { StudioApiError, StudioReply } from './router.js'
import type { StudioRequest, StudioRouter } from './router.js'

/** The task model a render runs as (Studio's `CANVAS_TIMELINE_RENDER_MODEL`). */
export const TIMELINE_RENDER_MODEL = 'timeline-render'
/** The capability of the downloadable renderer in the model list. */
export const RENDERER_CAPABILITY = 'renderer'

export interface RenderRouteOptions {
  tasks: FilmMediaTasks
  /** The model store: caption fonts, and the renderer download. */
  models?: EditorModels | undefined
  /** The plugin setting naming an ffmpeg binary. */
  ffmpegPath?: string | undefined
  /** Find ffmpeg (tests answer without looking at the machine). */
  resolveFfmpeg?: () => Promise<ResolvedFfmpeg | undefined>
  /** The filters a binary has (tests answer without running it). */
  filterNames?: (binary: string) => Promise<Set<string>>
  probeHasAudio?: ProbeHasAudio
  /** The renderer itself (tests swap in one that writes a stub file). */
  render?: (input: TimelineRenderInput) => Promise<TimelineRenderOutput>
  /** How ffmpeg is run (tests stand a script in). */
  runner?: FfmpegRunner
  now?: () => Date
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
})

/**
 * Add the render routes to a router.
 * @param router - the Studio-compatible router.
 * @param events - the project event bus: a finished render is announced on it.
 * @param options - the task store, the models, the ffmpeg setting and test seams.
 */
export function addRenderRoutes(router: StudioRouter, events: ProjectEvents, options: RenderRouteOptions): void {
  const { tasks, models } = options
  const render = options.render ?? renderTimeline
  const now = options.now ?? (() => new Date())
  const filterNames = options.filterNames ?? ((binary: string) => ffmpegFilterNames(binary))
  const probeHasAudio = options.probeHasAudio ?? probeFileHasAudio
  const renderer = (): { id: string; totalBytes: number } | undefined => models?.list().find(model => model.capability === RENDERER_CAPABILITY)
  const downloadedFfmpeg = async (): Promise<string | undefined> => {
    const model = renderer()
    return model === undefined ? undefined : await models?.programFile(model.id)
  }
  const findFfmpeg = options.resolveFfmpeg ?? (async () => {
    const downloaded = await downloadedFfmpeg()
    return resolveFfmpeg({ configured: options.ffmpegPath, downloaded: () => downloaded })
  })
  const resolveCaptionFont = async (fontId: string): Promise<string | null> => {
    if (models === undefined) return null
    return (await models.artifactFile(`caption-font-${fontId}`, 'font').catch(() => undefined))?.path ?? null
  }
  /** The film whose render is running, by workspace: one at a time, since ffmpeg takes every core. */
  const running = new Map<string, { taskId: string }>()

  router.translate(error => error instanceof TimelineRenderError
    ? json(error.status, { error: error.message, code: error.code, ...(error.detail !== undefined ? { detail: error.detail } : {}) })
    : undefined)

  /** Anything not already a Studio answer is Studio's catch-all. */
  const answering = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof TimelineRenderError || error instanceof StudioReply || error instanceof StudioApiError) throw error
      throw new StudioReply(500, { error: error instanceof Error ? error.message : String(error), code: 'CANVAS_TIMELINE_RENDER_FAILED' })
    }
  }

  /**
   * The binary to burn captions with: `subtitles` needs libass, which some
   * builds lack. The downloaded renderer and an installed VibeDev Studio's
   * copy are full builds, so they take over from one that lacks it; a binary
   * that cannot be asked is taken on trust.
   */
  const captionCapable = async (binary: string): Promise<string> => {
    const downloaded = await downloadedFfmpeg()
    const shipped = studioFfmpegCandidates(process.env, process.platform).filter(path => existsSync(path))
    for (const candidate of [...new Set([binary, ...(downloaded !== undefined ? [downloaded] : []), ...shipped])]) {
      const names = await filterNames(candidate)
      if (names.size === 0 || names.has('subtitles')) return candidate
    }
    throw new TimelineRenderError(422, 'FFMPEG_MISSING_FILTER',
      `这个 ffmpeg（${binary}）没有 "subtitles" 滤镜（编译时没带 libass），烧不进字幕：在剪辑台下载渲染器，或在插件设置 ffmpegPath 里指定完整版 ffmpeg，或渲染前隐藏字幕轨。`,
      { filter: 'subtitles' })
  }

  router.add('POST', '/api/canvas/timelines/:boardId/render', async request => answering(async () => {
    const boardId = request.params.boardId!
    const projectId = projectOf(request)
    const settings = normalizeRenderRequest(await request.json())
    const film = await readProject(request.cwd)
    if (film === null) throw new TimelineRenderError(404, 'PROJECT_NOT_FOUND', '这个工作区还没有影视项目，没有可渲染的剪辑。')
    const store = new TimelineStore(request.cwd)
    const state = await store.read()
    if (settings.baseRevision !== undefined && settings.baseRevision !== state.revision) {
      throw new StudioReply(409, { error: `the cut moved on: you reviewed revision ${settings.baseRevision}, current is ${state.revision}`, code: 'CANVAS_TIMELINE_CONFLICT', current: state })
    }
    const busy = running.get(request.cwd)
    if (settings.check !== true && busy !== undefined) {
      throw new TimelineRenderError(409, 'RENDER_BUSY', '这部片子正在渲染，等它完成或取消后再渲染。', { taskId: busy.taskId })
    }
    const ffmpeg = await findFfmpeg()
    if (ffmpeg === undefined) {
      const model = renderer()
      throw new TimelineRenderError(503, 'FFMPEG_UNAVAILABLE',
        model !== undefined
          ? '这台电脑上没有可用的 ffmpeg：可以在剪辑台下载渲染器（FFmpeg，独立程序，GPL 许可，需要你同意），或在插件设置 ffmpegPath 里指定一个。'
          : '这台电脑上没有可用的 ffmpeg：请安装 ffmpeg，或在插件设置 ffmpegPath 里指定一个。',
        model !== undefined ? { downloadable: true, modelId: model.id, totalBytes: model.totalBytes } : { downloadable: false })
    }
    const projectDir = join(request.cwd, PROJECT_DIR)
    const planInput = { document: state.document, projectDir, frameRate: settings.frameRate, resolution: settings.resolution, resolveCaptionFont, probeHasAudio }
    const planned = await buildTimelinePlan(planInput)
    const binary = planned.plan.sidecars?.some(sidecar => sidecar.filename === 'captions.ass') === true ? await captionCapable(ffmpeg.binary) : ffmpeg.binary
    const outputPath = await freeProjectPath(request.cwd, renderOutputPath({ boardId, revision: state.revision, fileName: settings.fileName, title: film.title, now: now() }))
    const revision = state.revision
    if (settings.check === true) {
      return {
        ok: true,
        width: planned.width,
        height: planned.height,
        frameRate: planned.plan.frameRate,
        durationSeconds: planned.plan.duration,
        hasAudio: planned.plan.hasAudio,
        targetLoudnessLufs: planned.targetLoudnessLufs,
        outputPath,
        // Studio's dry-run shape as well, for callers ported from it.
        revision,
        output: { path: outputPath },
        plan: {
          width: planned.width,
          height: planned.height,
          frameRate: planned.plan.frameRate,
          durationSeconds: planned.plan.duration,
          hasAudio: planned.plan.hasAudio,
          captionFonts: planned.captionFonts,
          targetLoudnessLufs: planned.targetLoudnessLufs,
          sourceAudioClips: planned.sourceAudioClips.length,
        },
      }
    }

    const slot = { taskId: '' }
    running.set(request.cwd, slot)
    const release = (): void => { if (running.get(request.cwd) === slot) running.delete(request.cwd) }
    const renders = join(projectDir, ...RENDER_DIR.split('/'))
    try {
      const { taskId } = await tasks.startLocal(request.cwd, projectId, {
        surface: 'video',
        model: TIMELINE_RENDER_MODEL,
        capability: TIMELINE_RENDER_MODEL,
        parameters: {
          boardId, project: projectId, revision, frameRate: settings.frameRate, resolution: settings.resolution,
          output: outputPath, width: planned.width, height: planned.height, durationSeconds: planned.plan.duration,
        },
        // Studio's progress list is empty until ffmpeg's first tick; a desk shows this meanwhile.
        started: '准备渲染',
        interruption: { code: 'RENDER_INTERRUPTED', message: '渲染过程中宿主重启，请重新渲染。', status: 503 },
        cancellation: { code: 'RENDER_CANCELED', message: '渲染已取消。', status: 499 },
      }, async (context) => {
        try {
          // Only this render of the film runs, so any partial left in the folder is a stopped one's.
          await removeStalePartials(renders)
          let lastPercent = -1
          let lastAt = 0
          const output = await render({
            ...planInput,
            planned,
            outputPath,
            ffmpegBinary: binary,
            signal: context.signal,
            ...(options.runner !== undefined ? { runner: options.runner } : {}),
            onProgress: ({ percent, seconds, duration }) => {
              // A line per few percent, not per ffmpeg tick: the task file is saved on every line.
              const at = Date.now()
              if (percent === lastPercent || (percent - lastPercent < 5 && at - lastAt < 2000)) return
              lastPercent = percent
              lastAt = at
              context.progress(`render ${percent}% · ${seconds.toFixed(1)}s / ${duration.toFixed(1)}s`)
            },
          })
          events.emit(request.cwd, { type: 'file-changed', projectId, path: output.path })
          const nodeId = await landFileOnBoard(new CanvasDocumentStore(request.cwd, projectId), boardId, projectId, {
            path: output.path,
            kind: 'video',
            mimeType: 'video/mp4',
            title: basename(output.path),
            width: output.width,
            height: output.height,
            durationSeconds: output.durationSeconds,
            size: output.size,
            metadata: { timelineRevision: revision },
          }).catch(() => null)
          if (nodeId !== null) events.emit(request.cwd, { type: 'story-canvas-changed', projectId, boardId })
          const loudness = output.loudnessLufs !== undefined ? ` · ${output.loudnessLufs.toFixed(1)} LUFS (target ${output.targetLoudnessLufs})` : ''
          const file: FilmTaskFile = {
            name: output.path,
            path: output.path,
            size: output.size,
            mtime: output.mtime,
            kind: 'video',
            mime: 'video/mp4',
            width: output.width,
            height: output.height,
            frameRate: output.frameRate,
            durationSeconds: output.durationSeconds,
            hasAudio: output.hasAudio,
            ...(output.loudnessLufs !== undefined ? { loudnessLufs: output.loudnessLufs } : {}),
            targetLoudnessLufs: output.targetLoudnessLufs,
            sha256: output.sha256,
            revision,
            boardId,
            model: TIMELINE_RENDER_MODEL,
            surface: 'video',
            providerNote: `timeline-render · r${revision} · ${output.width}×${output.height} · ${output.frameRate}fps · ${output.durationSeconds.toFixed(1)}s${output.hasAudio ? loudness : ' · silent'}`,
            ...(nodeId !== null ? { landedNodeId: nodeId, nodeId } : {}),
          }
          return file
        } finally {
          release()
        }
      })
      slot.taskId = taskId
      return json(202, { taskId, revision, status: 'running', output: { path: outputPath } })
    } catch (error) {
      release()
      throw error
    }
  }))

  router.add('GET', '/api/canvas/timelines/:boardId/renders', async (request: StudioRequest) => answering(async () => {
    const folder = join(request.cwd, PROJECT_DIR, ...RENDER_DIR.split('/'))
    const names = (await readdir(folder).catch(() => [] as string[])).filter(name => /\.mp4$/i.test(name) && !name.startsWith('.') && !/\.partial\.mp4$/i.test(name))
    const renders: Array<{ path: string; name: string; size: number; mtime: number }> = []
    for (const name of names) {
      const info = await stat(join(folder, name)).catch(() => null)
      if (info?.isFile() !== true) continue
      renders.push({ path: `${RENDER_DIR}/${name}`, name, size: info.size, mtime: info.mtimeMs })
    }
    renders.sort((left, right) => right.mtime - left.mtime)
    return { renders }
  }))
}
