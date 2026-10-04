/**
 * `timeline_render`, called the way the agent loop calls it (ported from the
 * timeline_render cases of Studio's mcp-timeline.test.ts): a check, a render
 * followed to its file, a render that outlasts the wait and is picked up
 * again, a cancel, and the refusals the model reads.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FilmToolServices } from '../../src/agent/index.js'
import { filmProjectTool } from '../../src/agent/project-tool.js'
import { renderTools } from '../../src/agent/render-tools.js'
import { refusal } from '../../src/agent/studio-client.js'
import { CanvasBoardAgent } from '../../src/canvas/board-agent.js'
import { FilmMediaTasks } from '../../src/media/tasks.js'
import type { TimelineRenderInput, TimelineRenderOutput } from '../../src/render/timeline-render.js'
import { createStudioRouter } from '../../src/routes.js'
import type { StudioRouterOptions } from '../../src/routes.js'
import { ProjectEvents } from '../../src/studio/events.js'
import { createEmptyTimelineArchive } from '../../src/timeline/archive.js'
import { TimelineStore } from '../../src/timeline/store.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

let cwd: string
let tasks: FilmMediaTasks

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-render-tool-'))
  tasks = new FilmMediaTasks(() => undefined)
})

afterEach(async () => {
  tasks.dispose()
  await tasks.settled()
  await rm(cwd, { recursive: true, force: true })
})

function exec(signal = new AbortController().signal): ToolRunContext {
  return {
    agent: { session: { header: { cwd } } },
    signal,
    callId: 'call-1', rootCallId: 'call-1', name: 'test', arguments: {}, token: Symbol('call'),
    deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext
}

/** A renderer that writes a stub file after `ms`, reporting halfway. */
function slowRender(ms: number, fail?: Error) {
  return async (input: TimelineRenderInput): Promise<TimelineRenderOutput> => {
    input.onProgress?.({ percent: 50, seconds: 0.5, duration: 1 })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      input.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('渲染已取消。'), { code: 'RENDER_CANCELED' })) })
    })
    if (fail !== undefined) throw fail
    const target = join(input.projectDir, ...input.outputPath.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, 'stub mp4')
    return { path: input.outputPath, absolutePath: target, size: 8, mtime: 1, sha256: 'deadbeef', width: 1280, height: 720, frameRate: input.frameRate, durationSeconds: 1, hasAudio: false, targetLoudnessLufs: -14 }
  }
}

async function setUp(renderer: StudioRouterOptions['renderer'], waitMs?: number): Promise<{ tool: ToolDefinition; revision: number }> {
  const events = new ProjectEvents()
  const boardAgent = new CanvasBoardAgent()
  const services: FilmToolServices = {
    studio: createStudioRouter({ events, boardAgent, tasks, renderer: { resolveFfmpeg: async () => ({ binary: 'ffmpeg', source: 'path' }), filterNames: async () => new Set(['subtitles']), probeHasAudio: async () => false, ...renderer } }),
    boardAgent, events, projectCreated: () => {},
  }
  await filmProjectTool(services).execute({ action: 'create', title: '雨夜来客' }, exec())
  await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
  await writeFile(join(cwd, 'film', 'canvas', 'media', 'still.png'), PNG)
  const archive = createEmptyTimelineArchive('16:9')
  archive.project.visualSegments = [{ id: 'clip-1', type: 'image', duration: 1, assetVersionId: 'canvas-file:canvas/media/still.png', integrity: { archivePath: 'canvas/media/still.png' } }]
  const { revision } = await new TimelineStore(cwd).save({ document: archive, baseRevision: 0 })
  const tool = renderTools(services, waitMs !== undefined ? { waitMs } : {})[0]!
  return { tool, revision }
}

describe('timeline_render', () => {
  it('checks without a task or a file', async () => {
    const { tool, revision } = await setUp({ render: slowRender(0) })
    const check = await tool.execute({ check: true, baseRevision: revision, resolution: '1080' }, exec()) as Record<string, unknown>
    expect(check).toMatchObject({ ok: true, width: 1920, height: 1080, frameRate: 30, durationSeconds: 1, hasAudio: false, targetLoudnessLufs: -14, revision })
    expect(check.outputPath).toMatch(/^canvas\/renders\/雨夜来客-r1-\d{8}-\d{6}\.mp4$/)
    expect(check.plan).toBeUndefined()
    expect(await tasks.list(cwd)).toEqual([])
  })

  it('renders and follows the task to its file over several waits', async () => {
    const { tool, revision } = await setUp({ render: slowRender(150) })
    const done = await tool.execute({ baseRevision: revision, fileName: '成片' }, exec()) as Record<string, any>
    // The film came with its board, so the render lands on it too.
    expect(done).toMatchObject({
      status: 'done', progress: '完成', file: { name: 'canvas/renders/成片.mp4', kind: 'video', durationSeconds: 1 },
      note: expect.stringMatching(/^saved as film\/canvas\/renders\/成片\.mp4 and placed on the storyboard as node \S+$/u),
    })
    expect(typeof done.taskId).toBe('string')
  })

  it('hands back the task when the render outlasts the wait, and picks it up again by taskId', async () => {
    const { tool } = await setUp({ render: slowRender(400) }, 50)
    const first = await tool.execute({}, exec()) as Record<string, any>
    expect(first).toMatchObject({ status: 'running', progress: 'render 50% · 0.5s / 1.0s', note: expect.stringContaining('call timeline_render again with this taskId') })
    // A later call (the wait is per call) follows the same task.
    let later = await tool.execute({ taskId: first.taskId }, exec()) as Record<string, any>
    for (let attempt = 0; attempt < 40 && later.status === 'running'; attempt += 1) later = await tool.execute({ taskId: first.taskId }, exec()) as Record<string, any>
    expect(later).toMatchObject({ taskId: first.taskId, status: 'done', file: { kind: 'video' } })
  })

  it('stops waiting, not rendering, when the tool call is stopped', async () => {
    const { tool } = await setUp({ render: slowRender(300) })
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 50)
    const stopped = await tool.execute({}, exec(controller.signal)) as Record<string, any>
    expect(stopped).toMatchObject({ status: 'running', note: expect.stringContaining('the render goes on') })
    expect((await tasks.wait(cwd, stopped.taskId, 0, 2000)).status).toBe('running')
    for (let attempt = 0; attempt < 100 && (await tasks.record(cwd, stopped.taskId))?.status === 'running'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 20))
    expect((await tasks.record(cwd, stopped.taskId))?.status).toBe('done')
  })

  it('cancels a render it started', async () => {
    const { tool } = await setUp({ render: slowRender(5_000) }, 30)
    const started = await tool.execute({}, exec()) as Record<string, any>
    const cancelled = await tool.execute({ taskId: started.taskId, cancel: true }, exec()) as Record<string, any>
    expect(cancelled).toMatchObject({ taskId: started.taskId, status: 'interrupted', error: { code: 'RENDER_CANCELED' }, note: expect.stringContaining('stopped') })
    await expect(tool.execute({ cancel: true }, exec())).rejects.toMatchObject({ code: 'TIMELINE_RENDER_INVALID' })
  })

  it('follows the render already running instead of failing on RENDER_BUSY', async () => {
    const { tool } = await setUp({ render: slowRender(300) }, 50)
    const first = await tool.execute({ fileName: '先渲染的' }, exec()) as Record<string, any>
    expect(first.status).toBe('running')
    // A second render while the first runs: the route refuses it, the tool follows the first.
    let second = await tool.execute({ fileName: '后来的' }, exec()) as Record<string, any>
    expect(second).toMatchObject({ taskId: first.taskId, alreadyRunning: true, note: expect.stringContaining('already rendering') })
    for (let attempt = 0; attempt < 40 && second.status === 'running'; attempt += 1) second = await tool.execute({ taskId: first.taskId }, exec()) as Record<string, any>
    expect(second).toMatchObject({ taskId: first.taskId, status: 'done', file: { name: 'canvas/renders/先渲染的.mp4' } })
    expect(await tasks.list(cwd)).toHaveLength(1)
  })

  it('keeps a busy render\'s task id in the refusal the model reads and on the error', () => {
    const error = refusal(409, { error: '这部片子正在渲染', code: 'RENDER_BUSY', taskId: 't-1', detail: { taskId: 't-1' }, current: { revision: 3, document: { big: true } } })
    expect(error).toMatchObject({ code: 'RENDER_BUSY', body: { taskId: 't-1', detail: { taskId: 't-1' } } })
    expect(error.message).toContain('taskId: t-1')
    expect(error.body?.current).toBeUndefined()
  })

  it('surfaces a failed render by its code', async () => {
    const { tool } = await setUp({ render: slowRender(0, Object.assign(new Error('ffmpeg exited with 1: boom'), { code: 'FFMPEG_FAILED' })) })
    await expect(tool.execute({}, exec())).rejects.toMatchObject({ code: 'FFMPEG_FAILED', message: expect.stringContaining('渲染失败：ffmpeg exited with 1: boom') })
  })

  it('passes refusals on, and says who can fix a missing ffmpeg', async () => {
    const { tool } = await setUp({ render: slowRender(0), resolveFfmpeg: async () => undefined })
    await expect(tool.execute({}, exec())).rejects.toMatchObject({ code: 'FFMPEG_UNAVAILABLE', message: expect.stringContaining('their consent') })
    await expect(tool.execute({ baseRevision: 0 }, exec())).rejects.toMatchObject({ code: 'CANVAS_TIMELINE_CONFLICT', message: expect.stringContaining('current revision: 1') })
  })
})
