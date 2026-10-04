/**
 * The render route (ported from Studio's canvas-timeline-render-route.test.ts):
 * a request becomes a film task, and when the task ends the file is in the
 * project and on the board. The renderer is swapped for one that writes a
 * stub file, except in the cases that run the real renderer with a Node script
 * standing in for ffmpeg. Beyond Studio: cancelling stops the render and stays
 * cancelled, one render runs at a time, a restart leaves the task interrupted,
 * and a missing ffmpeg says whether the renderer can be downloaded.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasDocumentStore } from '../../src/canvas/documents.js'
import { FilmMediaTasks } from '../../src/media/tasks.js'
import { EditorModels } from '../../src/models/service.js'
import type { EditorModelManifest } from '../../src/models/service.js'
import { createProject } from '../../src/project.js'
import { runFfmpeg } from '../../src/render/ffmpeg.js'
import type { TimelineRenderInput, TimelineRenderOutput } from '../../src/render/timeline-render.js'
import { createStudioRouter } from '../../src/routes.js'
import type { StudioRouterOptions } from '../../src/routes.js'
import { ProjectEvents } from '../../src/studio/events.js'
import type { ProjectEvent } from '../../src/studio/events.js'
import { createEmptyTimelineArchive } from '../../src/timeline/archive.js'
import { TimelineStore } from '../../src/timeline/store.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function still(): Record<string, unknown> {
  return {
    id: 'clip-1', type: 'image', name: 'still.png', duration: 1,
    assetId: 'canvas-file:canvas/media/still.png', assetVersionId: 'canvas-file:canvas/media/still.png',
    sourceStart: 0, sourceDuration: 0, playbackRate: 1, muted: false,
    integrity: { sha256: 'x', size: PNG.length, mimeType: 'image/png', archivePath: 'canvas/media/still.png' },
  }
}

function cutWith(visuals: unknown[], extra: Record<string, unknown> = {}) {
  const archive = createEmptyTimelineArchive('16:9')
  archive.project.visualSegments = visuals
  Object.assign(archive.project, extra)
  return archive
}

const stubRender = vi.fn(async (input: TimelineRenderInput): Promise<TimelineRenderOutput> => {
  input.onProgress?.({ percent: 50, seconds: 0.5, duration: 1 })
  const target = join(input.projectDir, ...input.outputPath.split('/'))
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, 'stub mp4')
  return {
    path: input.outputPath, absolutePath: target, size: 8, mtime: 1, sha256: 'deadbeef',
    width: 1280, height: 720, frameRate: input.frameRate, durationSeconds: 1, hasAudio: false, targetLoudnessLufs: -14,
  }
})

let cwd: string
let tasks: FilmMediaTasks
let events: ProjectEvents
let seen: ProjectEvent[]

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-render-route-'))
  await createProject(cwd, { title: '雨夜来客', aspectRatio: '16:9' })
  await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
  await writeFile(join(cwd, 'film', 'canvas', 'media', 'still.png'), PNG)
  await new TimelineStore(cwd).save({ document: cutWith([still()]), baseRevision: 0 })
  tasks = new FilmMediaTasks(() => undefined)
  events = new ProjectEvents()
  seen = []
  events.subscribe(cwd, (event) => { seen.push(event) })
  stubRender.mockClear()
})

afterEach(async () => {
  tasks.dispose()
  await tasks.settled()
  await rm(cwd, { recursive: true, force: true })
})

const NOW = new Date(2026, 8, 6, 14, 5, 9)

function makeRouter(options: { ffmpeg?: string | undefined; filterNames?: (binary: string) => Promise<Set<string>>; models?: EditorModels; renderer?: StudioRouterOptions['renderer'] } = {}) {
  return createStudioRouter({
    events,
    tasks,
    ...(options.models !== undefined ? { models: options.models } : {}),
    renderer: {
      resolveFfmpeg: async () => {
        const binary = 'ffmpeg' in options ? options.ffmpeg : 'C:\\tools\\ffmpeg.exe'
        return binary === undefined ? undefined : { binary, source: 'setting' as const }
      },
      render: stubRender,
      filterNames: options.filterNames ?? (async () => new Set(['subtitles'])),
      probeHasAudio: async () => false,
      now: () => NOW,
      ...options.renderer,
    },
  })
}

async function call(router: ReturnType<typeof createStudioRouter>, studioPath: string, json?: unknown) {
  return callAt(router, cwd, studioPath, json)
}

/** A call naming the workspace as `at` spells it. */
async function callAt(router: ReturnType<typeof createStudioRouter>, at: string, studioPath: string, json?: unknown) {
  const method = json === undefined ? 'GET' : 'POST'
  const url = new URL(`http://host/api/dsh-film/${method === 'GET' ? 'studio' : 'studio-write'}`)
  url.searchParams.set('cwd', at)
  url.searchParams.set('path', studioPath)
  const response = await router.dispatch(new Request(url, method === 'GET' ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }))
  return { status: response.status, body: await response.json() as any }
}

const RENDER = '/api/canvas/timelines/film-1/render?project=film-1'

async function settled(taskId: string) {
  const snapshot = await tasks.wait(cwd, taskId, 0, 0)
  if (snapshot.status !== 'running') return tasks.record(cwd, taskId)
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const task = await tasks.record(cwd, taskId)
    if (task !== undefined && task.status !== 'running' && task.status !== 'queued') return task
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`task ${taskId} never settled`)
}

/** Wait until a file is gone (a cancelled render's body clears up after the task already reads cancelled). */
async function gone(file: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await stat(file).then(() => false, () => true)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`${file} is still there`)
}

/** Writes an MP4-looking file where ffmpeg's output goes, after a few progress lines. */
async function scriptRunner(body: string) {
  const script = join(cwd, `ffmpeg-${Math.random().toString(36).slice(2)}.mjs`)
  await writeFile(script, body)
  return (run: Parameters<typeof runFfmpeg>[0]) => runFfmpeg({ ...run, binary: process.execPath, argv: [script, ...run.argv] })
}

describe('what the route refuses before any task exists', () => {
  it('refuses a frame rate it does not offer, on the request', async () => {
    const { status, body } = await call(makeRouter(), RENDER, { frameRate: 25 })
    expect(status).toBe(400)
    expect(body.code).toBe('CANVAS_TIMELINE_RENDER_INVALID')
    expect(stubRender).not.toHaveBeenCalled()
  })

  it('refuses a stale revision with the current state, like a write would', async () => {
    const { status, body } = await call(makeRouter(), RENDER, { baseRevision: 0 })
    expect(status).toBe(409)
    expect(body.code).toBe('CANVAS_TIMELINE_CONFLICT')
    expect(body.current.revision).toBe(1)
  })

  it('refuses a cut with no picture, without a task', async () => {
    await new TimelineStore(cwd).save({ document: cutWith([]), baseRevision: 1 })
    const { status, body } = await call(makeRouter(), RENDER, {})
    expect(status).toBe(422)
    expect(body.code).toBe('EMPTY_TIMELINE')
    expect(await tasks.list(cwd)).toEqual([])
  })

  it('refuses a workspace that has no film', async () => {
    await rm(join(cwd, 'film', 'film.json'))
    const { status, body } = await call(makeRouter(), RENDER, {})
    expect(status).toBe(404)
    expect(body.code).toBe('PROJECT_NOT_FOUND')
  })

  it('names a clip whose file is gone, with the detail the desk lists', async () => {
    await rm(join(cwd, 'film', 'canvas', 'media', 'still.png'))
    const { status, body } = await call(makeRouter(), RENDER, { check: true })
    expect(status).toBe(422)
    expect(body).toMatchObject({ code: 'MISSING_MEDIA', detail: { missing: [{ track: 'visuals', clipId: 'clip-1', path: 'canvas/media/still.png' }] } })
  })

  it('says when there is no ffmpeg, and whether the renderer can be downloaded', async () => {
    const none = await call(makeRouter({ ffmpeg: undefined }), RENDER, {})
    expect(none.status).toBe(503)
    expect(none.body).toMatchObject({ code: 'FFMPEG_UNAVAILABLE', detail: { downloadable: false } })
    const root = await mkdtemp(join(tmpdir(), 'dsh-film-render-models-'))
    try {
      const models = new EditorModels({ root, manifests: [rendererManifest()], platform: 'win32-x64' })
      const offered = await call(makeRouter({ ffmpeg: undefined, models }), RENDER, { check: true })
      expect(offered.status).toBe(503)
      expect(offered.body).toMatchObject({ code: 'FFMPEG_UNAVAILABLE', detail: { downloadable: true, modelId: 'ffmpeg-test', totalBytes: 10 } })
      expect(offered.body.error).toContain('剪辑台下载渲染器')
      // On a platform the renderer is not built for there is nothing to download.
      const elsewhere = new EditorModels({ root, manifests: [rendererManifest()], platform: 'darwin-arm64' })
      expect((await call(makeRouter({ ffmpeg: undefined, models: elsewhere }), RENDER, {})).body.detail).toEqual({ downloadable: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function rendererManifest(): EditorModelManifest {
  return {
    id: 'ffmpeg-test', label: 'FFmpeg', capability: 'renderer', revision: 'r1', platforms: ['win32-x64'], license: { name: 'GPL-2.0-or-later' },
    artifacts: [{ id: 'archive', fileName: 'ffmpeg.zip', bytes: 10, sha256: 'a'.repeat(64), sources: ['https://vibedev.jzsaas.com/x.zip'] }],
    archive: { root: 'ffmpeg', program: 'ffmpeg.exe', files: [{ path: 'bin/ffmpeg.exe', fileName: 'ffmpeg.exe', bytes: 1, sha256: 'b'.repeat(64) }], sourceNote: ['FFmpeg'] },
  }
}

describe('a render that runs', () => {
  it('accepts with a task, then finishes with the file the task reports', async () => {
    const { status, body } = await call(makeRouter(), RENDER, { frameRate: 24, resolution: '1080', fileName: 'final' })
    expect(status).toBe(202)
    expect(body).toMatchObject({ revision: 1, status: 'running', output: { path: 'canvas/renders/final.mp4' } })
    expect(typeof body.taskId).toBe('string')

    const task = (await settled(body.taskId))!
    expect(task.status).toBe('done')
    expect(task.surface).toBe('video')
    expect(task.model).toBe('timeline-render')
    expect(task.request).toMatchObject({ capability: 'timeline-render', parameters: { boardId: 'film-1', project: 'film-1', revision: 1, frameRate: 24, resolution: '1080', width: 1920, height: 1080 } })
    expect(task.progress).toEqual(['准备渲染', 'render 50% · 0.5s / 1.0s', '完成'])
    expect(task.file).toMatchObject({
      name: 'canvas/renders/final.mp4',
      path: 'canvas/renders/final.mp4',
      size: 8,
      kind: 'video',
      mime: 'video/mp4',
      width: 1280,
      height: 720,
      frameRate: 24,
      durationSeconds: 1,
      hasAudio: false,
      sha256: 'deadbeef',
      revision: 1,
      boardId: 'film-1',
      targetLoudnessLufs: -14,
      providerNote: expect.stringContaining('timeline-render · r1 · 1280×720 · 24fps'),
    })
    // No board document yet: the file is in the project, not on a board.
    expect(task.file?.landedNodeId).toBeUndefined()
    expect(stubRender).toHaveBeenCalledTimes(1)
    expect(stubRender.mock.calls[0]![0]).toMatchObject({ frameRate: 24, resolution: '1080', outputPath: 'canvas/renders/final.mp4', ffmpegBinary: 'C:\\tools\\ffmpeg.exe', projectDir: join(cwd, 'film') })
    // Planned once, on the request: the renderer is handed that plan.
    expect(stubRender.mock.calls[0]![0].planned?.width).toBe(1920)
    expect(seen).toContainEqual({ type: 'file-changed', projectId: 'film-1', path: 'canvas/renders/final.mp4' })
    // The snapshot a waiter gets is the same file.
    expect((await tasks.wait(cwd, body.taskId, 0, 0)).file).toEqual(task.file)
  })

  it('never overwrites an earlier render that has the same name', async () => {
    const dir = join(cwd, 'film', 'canvas', 'renders')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ai-voiceover.mp4'), 'first')
    await writeFile(join(dir, 'ai-voiceover-2.mp4'), 'second')
    const { body } = await call(makeRouter(), RENDER, { fileName: 'ai-voiceover' })
    expect(body.output.path).toBe('canvas/renders/ai-voiceover-3.mp4')
    expect((await settled(body.taskId))!.file?.name).toBe('canvas/renders/ai-voiceover-3.mp4')
  })

  it('answers a check with the plan, and neither a task nor a file', async () => {
    const { status, body } = await call(makeRouter(), RENDER, { check: true, frameRate: 24, resolution: '1080' })
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      width: 1920,
      height: 1080,
      frameRate: 24,
      durationSeconds: 1,
      hasAudio: false,
      targetLoudnessLufs: -14,
      outputPath: 'canvas/renders/雨夜来客-r1-20260906-140509.mp4',
      revision: 1,
      output: { path: 'canvas/renders/雨夜来客-r1-20260906-140509.mp4' },
      plan: { width: 1920, height: 1080, frameRate: 24, durationSeconds: 1, hasAudio: false, captionFonts: [], targetLoudnessLufs: -14, sourceAudioClips: 0 },
    })
    expect(await tasks.list(cwd)).toEqual([])
    expect(stubRender).not.toHaveBeenCalled()
    expect(await readdir(join(cwd, 'film', 'canvas'))).not.toContain('renders')
    // Studio's dryRun is the same question.
    expect((await call(makeRouter(), RENDER, { dryRun: true })).body.ok).toBe(true)
    expect((await call(makeRouter(), RENDER, { check: 'yes' })).status).toBe(400)
  })

  it('refuses to burn captions with an ffmpeg that has no subtitles filter, on the request and in the check', async () => {
    await new TimelineStore(cwd).save({ document: cutWith([still()], { captionSegments: [{ id: 'cap-1', text: '你来了。', start: 0, end: 1 }] }), baseRevision: 1 })
    const router = makeRouter({ filterNames: async () => new Set(['scale', 'concat', 'loudnorm']) })
    const check = await call(router, RENDER, { check: true })
    expect(check.status).toBe(422)
    expect(check.body).toMatchObject({ code: 'FFMPEG_MISSING_FILTER', detail: { filter: 'subtitles' } })
    expect(check.body.error).toContain('libass')
    expect((await call(router, RENDER, {})).status).toBe(422)
    expect(stubRender).not.toHaveBeenCalled()
    // A capable build, or one that could not be asked, goes ahead.
    for (const names of [new Set(['subtitles']), new Set<string>()]) {
      expect((await call(makeRouter({ filterNames: async () => names }), RENDER, { check: true })).status).toBe(200)
    }
  })

  it('takes the downloaded renderer for captions when the configured ffmpeg lacks libass', async () => {
    await new TimelineStore(cwd).save({ document: cutWith([still()], { captionSegments: [{ id: 'cap-1', text: '你来了。', start: 0, end: 1 }] }), baseRevision: 1 })
    const models = { list: () => [], programFile: async () => undefined, artifactFile: async () => { throw new Error('no font') } } as unknown as EditorModels
    const downloaded = 'D:\\cache\\ffmpeg.exe'
    Object.assign(models, { list: () => [{ id: 'ffmpeg-test', capability: 'renderer', totalBytes: 10 }], programFile: async () => downloaded })
    const router = makeRouter({ models, filterNames: async binary => new Set(binary === downloaded ? ['subtitles'] : ['scale']) })
    const taken = await call(router, RENDER, { fileName: 'captioned' })
    expect(taken.status).toBe(202)
    await settled(taken.body.taskId)
    expect(stubRender.mock.calls.at(-1)![0].ffmpegBinary).toBe(downloaded)
  })

  it('names the default output after the film, revision and moment', async () => {
    const { body } = await call(makeRouter(), RENDER, {})
    expect(body.output.path).toBe('canvas/renders/雨夜来客-r1-20260906-140509.mp4')
    await settled(body.taskId)
  })

  it('puts the file on the board as a video node, right of everything there', async () => {
    await writeFile(join(cwd, 'film', 'canvas', 'document.json'), JSON.stringify({ id: 'film-1', title: '雨夜', nodes: [{ id: 'a', type: 'image', position: { x: 100, y: 40 }, width: 400, height: 300, metadata: {} }], connections: [] }))
    const { body } = await call(makeRouter(), RENDER, {})
    const task = (await settled(body.taskId))!
    expect(task.status).toBe('done')
    const nodeId = task.file?.landedNodeId as string
    expect(nodeId).toMatch(/^video-/)
    expect(task.file?.nodeId).toBe(nodeId)
    const board = JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'document.json'), 'utf8'))
    expect(board.nodes.at(-1)).toMatchObject({
      id: nodeId,
      type: 'video',
      title: '雨夜来客-r1-20260906-140509.mp4',
      width: 480,
      height: 270,
      position: { x: 100 + 400 + 96, y: 40 },
      metadata: {
        content: `/api/projects/film-1/raw/canvas/renders/${encodeURIComponent('雨夜来客-r1-20260906-140509.mp4')}`,
        status: 'success',
        mimeType: 'video/mp4',
        naturalWidth: 1280,
        naturalHeight: 720,
        durationMs: 1000,
        timelineRevision: 1,
      },
    })
    expect(seen).toContainEqual({ type: 'story-canvas-changed', projectId: 'film-1', boardId: 'film-1' })
  })

  it('fails the task with the renderer\'s own code when ffmpeg fails', async () => {
    stubRender.mockImplementationOnce(async () => {
      throw Object.assign(new Error('ffmpeg exited with 1: boom'), { code: 'FFMPEG_FAILED', details: { retryable: true } })
    })
    const { body } = await call(makeRouter(), RENDER, {})
    const task = (await settled(body.taskId))!
    expect(task.status).toBe('failed')
    expect(task.error).toMatchObject({ code: 'FFMPEG_FAILED', message: 'ffmpeg exited with 1: boom', retryable: true })
    expect(task.file).toBeUndefined()
  })

  it('lists what the project holds, newest first, without partials or other files', async () => {
    const dir = join(cwd, 'film', 'canvas', 'renders')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'old.mp4'), 'a')
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(join(dir, 'new.mp4'), 'bb')
    await writeFile(join(dir, '.half.partial.mp4'), 'c')
    await writeFile(join(dir, 'half.mp4.partial.mp4'), 'c')
    await writeFile(join(dir, 'cut.webm'), 'd')
    const { status, body } = await call(makeRouter(), '/api/canvas/timelines/film-1/renders?project=film-1')
    expect(status).toBe(200)
    expect(body.renders.map((entry: { path: string }) => entry.path)).toEqual(['canvas/renders/new.mp4', 'canvas/renders/old.mp4'])
    expect(body.renders[0]).toMatchObject({ name: 'new.mp4', size: 2 })
    expect(typeof body.renders[0].mtime).toBe('number')
  })
})

describe('what Studio left out', () => {
  it('runs the real renderer to a file, through a hidden partial that never shows', async () => {
    const runner = await scriptRunner(`
import { writeFileSync } from 'node:fs'
writeFileSync(process.argv.at(-1), Buffer.from('0000ftypisom'))
process.stdout.write('out_time_us=500000\\nout_time_us=1000000\\n')
`)
    const router = makeRouter({ renderer: { render: undefined, runner } })
    const { status, body } = await call(router, RENDER, { fileName: '成片' })
    expect(status).toBe(202)
    const task = (await settled(body.taskId))!
    expect(task).toMatchObject({ status: 'done', file: { name: 'canvas/renders/成片.mp4', size: 12, durationSeconds: 1, hasAudio: false } })
    expect(task.progress).toContain('render 50% · 0.5s / 1.0s')
    expect(await readdir(join(cwd, 'film', 'canvas', 'renders'))).toEqual(['成片.mp4'])
  })

  it('cancels a running render: ffmpeg stops, no file is kept, and the task stays cancelled', async () => {
    const pidFile = join(cwd, 'ffmpeg.pid')
    const runner = await scriptRunner(`
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
let us = 0
setInterval(() => { us += 10000; process.stdout.write('out_time_us=' + us + '\\n') }, 50)
`)
    const router = makeRouter({ renderer: { render: undefined, runner } })
    const { body } = await call(router, RENDER, {})
    // Wait for ffmpeg to be running.
    for (let attempt = 0; attempt < 200 && (await readFile(pidFile, 'utf8').catch(() => '')) === ''; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect((await call(router, `/api/media/tasks/${body.taskId}/cancel`, {})).status).toBe(200)
    const snapshot = await tasks.wait(cwd, body.taskId, 0, 0)
    expect(snapshot).toMatchObject({ status: 'interrupted', error: { code: 'RENDER_CANCELED', status: 499 } })
    // The process is gone, and nothing was left in the renders folder.
    let alive = true
    for (let attempt = 0; attempt < 200 && alive; attempt += 1) {
      try {
        process.kill(pid, 0)
        await new Promise(resolve => setTimeout(resolve, 20))
      } catch {
        alive = false
      }
    }
    expect(alive).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await readdir(join(cwd, 'film', 'canvas', 'renders')).catch(() => [])).toEqual([])
    expect((await tasks.record(cwd, body.taskId))?.status).toBe('interrupted')
    // The film is free to render again.
    expect((await call(makeRouter(), RENDER, { check: true })).status).toBe(200)
  })

  it('keeps a cancelled render cancelled when the renderer finishes anyway', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const render = vi.fn(async (input: TimelineRenderInput) => {
      await gate
      return stubRender(input)
    })
    const router = makeRouter({ renderer: { render } })
    const { body } = await call(router, RENDER, {})
    await call(router, `/api/media/tasks/${body.taskId}/cancel`, {})
    finish()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await tasks.record(cwd, body.taskId)).toMatchObject({ status: 'interrupted', error: { code: 'RENDER_CANCELED' } })
  })

  it('runs one render of a film at a time', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const router = makeRouter({ renderer: { render: async (input) => { await gate; return stubRender(input) } } })
    const first = await call(router, RENDER, {})
    expect(first.status).toBe(202)
    const second = await call(router, RENDER, {})
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ code: 'RENDER_BUSY', taskId: first.body.taskId, detail: { taskId: first.body.taskId } })
    // A check is still answered while it runs.
    expect((await call(router, RENDER, { check: true })).status).toBe(200)
    finish()
    await settled(first.body.taskId)
    await new Promise(resolve => setTimeout(resolve, 20))
    const third = await call(router, RENDER, {})
    expect(third.status).toBe(202)
    await settled(third.body.taskId)
  })

  it('lets only one of two renders asked for at once start, even while the first is still being planned', async () => {
    let release!: () => void
    const planning = new Promise<void>((resolve) => { release = resolve })
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    let asked = 0
    const router = makeRouter({
      renderer: {
        // The first to plan is slow to find ffmpeg: the other request arrives meanwhile.
        resolveFfmpeg: async () => {
          asked += 1
          if (asked === 1) await planning
          return { binary: 'C:\\tools\\ffmpeg.exe', source: 'setting' as const }
        },
        render: async (input) => { await gate; return stubRender(input) },
      },
    })
    const both = Promise.all([call(router, RENDER, {}), call(router, RENDER, {})])
    await new Promise(resolve => setTimeout(resolve, 50))
    release()
    const answers = await both
    expect(answers.map(answer => answer.status).sort()).toEqual([202, 409])
    const started = answers.find(answer => answer.status === 202)!
    expect(answers.find(answer => answer.status === 409)!.body).toMatchObject({ code: 'RENDER_BUSY', taskId: started.body.taskId, detail: { taskId: started.body.taskId } })
    expect(await tasks.list(cwd)).toHaveLength(1)
    finish()
    await settled(started.body.taskId)
  })

  it('counts the desk\'s and the agent\'s spellings of a workspace as one film', async () => {
    const alias = `${cwd}-alias`
    await symlink(cwd, alias, 'junction')
    try {
      let finish!: () => void
      const gate = new Promise<void>((resolve) => { finish = resolve })
      const router = makeRouter({ renderer: { render: async (input) => { await gate; return stubRender(input) } } })
      const first = await call(router, RENDER, {})
      expect(first.status).toBe(202)
      const second = await callAt(router, alias, RENDER, {})
      expect(second).toMatchObject({ status: 409, body: { code: 'RENDER_BUSY', taskId: first.body.taskId } })
      finish()
      await settled(first.body.taskId)
    } finally {
      await rm(alias, { recursive: true, force: true })
    }
  })

  it('gives the film back to the next render when a render is refused before it starts', async () => {
    let asked = 0
    const router = makeRouter({ renderer: { resolveFfmpeg: async () => (asked++ === 0 ? undefined : { binary: 'ffmpeg', source: 'path' as const }) } })
    expect((await call(router, RENDER, {})).body.code).toBe('FFMPEG_UNAVAILABLE')
    const next = await call(router, RENDER, {})
    expect(next.status).toBe(202)
    await settled(next.body.taskId)
  })

  it('keeps neither the file nor a board node when the render is cancelled as its file comes in', async () => {
    await writeFile(join(cwd, 'film', 'canvas', 'document.json'), JSON.stringify({ id: 'film-1', title: '雨夜', nodes: [], connections: [] }))
    // The cancel arrives just as the renderer hands its file back.
    let cancelled!: () => void
    const handedBack = new Promise<void>((resolve) => { cancelled = resolve })
    const render = vi.fn(async (input: TimelineRenderInput) => {
      const output = await stubRender(input)
      const [running] = await tasks.list(cwd)
      await tasks.cancel(cwd, running!.taskId)
      cancelled()
      return output
    })
    const router = makeRouter({ renderer: { render } })
    const { body } = await call(router, RENDER, { fileName: 'late' })
    await handedBack
    await gone(join(cwd, 'film', 'canvas', 'renders', 'late.mp4'))
    expect(await tasks.record(cwd, body.taskId)).toMatchObject({ status: 'interrupted', error: { code: 'RENDER_CANCELED' } })
    expect(JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'document.json'), 'utf8')).nodes).toEqual([])
    expect(seen.some(event => event.type === 'file-changed')).toBe(false)
  })

  it('takes the node back off the board when the cancel comes while the file is being placed', async () => {
    await writeFile(join(cwd, 'film', 'canvas', 'document.json'), JSON.stringify({ id: 'film-1', title: '雨夜', nodes: [], connections: [] }))
    // Someone else is saving the board: the render's landing waits for its lock.
    let unlock!: () => void
    const locked = new Promise<void>((resolve) => { unlock = resolve })
    const saving = new CanvasDocumentStore(cwd, 'film-1').update(async (current) => { await locked; return current! })
    let rendered!: () => void
    const handedBack = new Promise<void>((resolve) => { rendered = resolve })
    const router = makeRouter({ renderer: { render: async (input) => { const output = await stubRender(input); rendered(); return output } } })
    const { body } = await call(router, RENDER, { fileName: 'placing' })
    await handedBack
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await call(router, `/api/media/tasks/${body.taskId}/cancel`, {})).status).toBe(200)
    unlock()
    await saving
    // The node is taken off before the file goes.
    await gone(join(cwd, 'film', 'canvas', 'renders', 'placing.mp4'))
    expect(JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'document.json'), 'utf8')).nodes).toEqual([])
    expect(await tasks.record(cwd, body.taskId)).toMatchObject({ status: 'interrupted', error: { code: 'RENDER_CANCELED' } })
  })

  it('leaves a render running when the Host stopped interrupted, saying to render again', async () => {
    const router = makeRouter({ renderer: { render: () => new Promise(() => {}) } })
    const { body } = await call(router, RENDER, {})
    await tasks.settled()
    const after = new FilmMediaTasks(() => undefined)
    expect(await after.record(cwd, body.taskId)).toMatchObject({ status: 'interrupted', error: { code: 'RENDER_INTERRUPTED', message: '渲染过程中宿主重启，请重新渲染。' } })
    await after.settled()
  })

  it('clears a partial a stopped render left before rendering again', async () => {
    const dir = join(cwd, 'film', 'canvas', 'renders')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.stale.partial.mp4'), 'half')
    const { body } = await call(makeRouter(), RENDER, { fileName: 'fresh' })
    await settled(body.taskId)
    expect(await readdir(dir)).toEqual(['fresh.mp4'])
  })
})
