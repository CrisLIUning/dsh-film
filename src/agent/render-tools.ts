/**
 * `timeline_render`: Studio's tool of that name (apps/daemon/src/mcp.ts) over
 * the film's background render. A thin client like Studio's: it posts the
 * render (or its check) to the route the editing desk uses, then long-polls
 * the film task for up to four minutes and hands back the task id when the
 * render outlasts the wait. Waiting is all a stopped tool call stops; the
 * render goes on until it finishes or is cancelled (`cancel: true`).
 * @module dsh-film/agent/render-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FilmToolError, callStudio } from './studio-client.js'
import { filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices, FilmWorkspace } from './context.js'

/** How long one call waits for a render (Studio's `TIMELINE_RENDER_WAIT_MS`). */
export const TIMELINE_RENDER_WAIT_MS = 4 * 60_000
/** The longest single long-poll the task route allows. */
const WAIT_STEP_MS = 25_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const KEEP_WAITING = 'still rendering — call timeline_render again with this taskId to keep waiting, or with cancel:true to stop it'

/**
 * Follow a render task until it ends, the wait runs out or the call stops.
 * @returns what to tell the model; a failed render throws its code.
 */
async function follow(services: FilmToolServices, film: FilmWorkspace, taskId: string, exec: ToolRunContext, waitMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + waitMs
  let since = 0
  let last: string | undefined
  for (;;) {
    let snapshot: Record<string, unknown>
    try {
      snapshot = await callStudio(services.studio, film.cwd, {
        method: 'POST',
        path: `/api/media/tasks/${segment(taskId)}/wait`,
        body: { since, timeoutMs: Math.min(WAIT_STEP_MS, Math.max(0, deadline - Date.now())) },
      }, exec.signal)
    } catch (error) {
      if (exec.signal.aborted) return { taskId, status: 'running', ...(last !== undefined ? { progress: last } : {}), note: `stopped waiting; the render goes on — ${KEEP_WAITING}` }
      throw error
    }
    const lines = Array.isArray(snapshot.progress) ? snapshot.progress.filter((line): line is string => typeof line === 'string') : []
    if (lines.length > 0) last = lines.at(-1)
    since = typeof snapshot.nextSince === 'number' ? snapshot.nextSince : since + lines.length
    const status = typeof snapshot.status === 'string' ? snapshot.status : 'running'
    if (status === 'done') {
      const file = isRecord(snapshot.file) ? snapshot.file : {}
      const landed = typeof file.landedNodeId === 'string' ? ` and placed on the storyboard as node ${file.landedNodeId}` : ''
      return { taskId, status, ...(last !== undefined ? { progress: last } : {}), file, note: `saved as film/${String(file.name ?? '')}${landed}` }
    }
    if (status === 'failed' || status === 'interrupted') {
      const error = isRecord(snapshot.error) ? snapshot.error : {}
      const code = typeof error.code === 'string' ? error.code : 'RENDER_FAILED'
      throw new FilmToolError(code, `渲染失败：${typeof error.message === 'string' ? error.message : status}`)
    }
    if (exec.signal.aborted) return { taskId, status, ...(last !== undefined ? { progress: last } : {}), note: `stopped waiting; the render goes on — ${KEEP_WAITING}` }
    if (Date.now() >= deadline) return { taskId, status, ...(last !== undefined ? { progress: last } : {}), note: KEEP_WAITING }
  }
}

/**
 * The render tool.
 * @param services - the film services.
 * @param options - how long one call waits (tests shorten it).
 * @returns the tool definitions.
 */
export function renderTools(services: FilmToolServices, options: { waitMs?: number } = {}): ToolDefinition[] {
  const waitMs = options.waitMs ?? TIMELINE_RENDER_WAIT_MS
  return [
    defineTool({
      name: 'timeline_render',
      description: 'Render the film\'s cut to an H.264 MP4 on this machine (ffmpeg, no page needed): it lands under film/canvas/renders/ and on the storyboard. '
        + 'check:true answers with the same refusals as a render and starts nothing: output size, length, frame rate, whether it has sound, the loudness '
        + 'target and the file name. Otherwise it renders and waits up to 4 minutes; a longer render returns its taskId — call again with taskId to keep '
        + 'waiting, or taskId with cancel:true to stop it. Quote baseRevision from timeline_query so a cut that moved on is refused. A colour-graded cut is '
        + 'slow, about 20× real time. Report only a finished file. One render of a film runs at a time: when one is already running (the editing desk\'s or '
        + 'an earlier call\'s) this call follows it instead (alreadyRunning: true) — its settings may differ from yours. Refusals: CANVAS_TIMELINE_CONFLICT '
        + '(read again), EMPTY_TIMELINE, MISSING_MEDIA, UNSUPPORTED_RENDER_FEATURE, MISSING_RENDER_RESOURCE (a caption font the person has not downloaded), '
        + 'FFMPEG_UNAVAILABLE, FFMPEG_MISSING_FILTER — a refusal repeats identically, so do not retry it unchanged.',
      parameters: {
        baseRevision: { type: 'integer', description: 'The cut revision you read with timeline_query.' },
        check: { type: 'boolean', description: 'Only check whether and how the cut would render.' },
        frameRate: { type: 'integer', enum: [24, 30, 60], description: 'Frames per second (default 30).' },
        resolution: { type: 'string', enum: ['720', '1080', '1440', '2160'], description: 'The short side in pixels (default 720).' },
        fileName: { type: 'string', description: 'The file name under film/canvas/renders/ (.mp4 added; an existing name gets -2, -3…).' },
        taskId: { type: 'string', description: 'A render this tool started: keep waiting for it, or cancel it.' },
        cancel: { type: 'boolean', description: 'With taskId: stop that render.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        if (args.cancel === true) {
          if (args.taskId === undefined || args.taskId === '') throw new FilmToolError('TIMELINE_RENDER_INVALID', 'cancel needs the taskId of the render to stop.')
          await callStudio(services.studio, film.cwd, { method: 'POST', path: `/api/media/tasks/${segment(args.taskId)}/cancel` }, exec.signal)
          const snapshot = await callStudio(services.studio, film.cwd, { method: 'POST', path: `/api/media/tasks/${segment(args.taskId)}/wait`, body: { since: 0, timeoutMs: 0 } }, exec.signal)
          const lines = Array.isArray(snapshot.progress) ? snapshot.progress : []
          return plain({ taskId: args.taskId, status: snapshot.status, progress: lines.at(-1), ...(snapshot.error !== null && snapshot.error !== undefined ? { error: snapshot.error } : {}), note: snapshot.status === 'done' ? 'the render had already finished' : 'the render is stopped; no file was kept' })
        }
        if (args.taskId !== undefined && args.taskId !== '') return plain(await follow(services, film, args.taskId, exec, waitMs))
        const body = {
          ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}),
          ...(args.check === true ? { check: true } : {}),
          ...(args.frameRate !== undefined ? { frameRate: args.frameRate } : {}),
          ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
          ...(args.fileName !== undefined ? { fileName: args.fileName } : {}),
        }
        let answer: Record<string, unknown>
        try {
          answer = await callStudio(services.studio, film.cwd, { method: 'POST', path: `/api/canvas/timelines/${segment(film.boardId)}/render?project=${segment(film.projectId)}`, body }, exec.signal)
        } catch (error) {
          // Downloading the renderer is a separate GPL program the person agrees to; the agent cannot agree for them.
          if (error instanceof FilmToolError && error.code === 'FFMPEG_UNAVAILABLE') {
            throw new FilmToolError(error.code, `${error.message} Ask the person to download the renderer in the 剪辑 tab (导出 → 渲染到项目), which asks for their consent, or to set the plugin's ffmpegPath; then render again.`)
          }
          // A render of this film is already running (the desk's, or an earlier call's): follow it rather than fail.
          const running = error instanceof FilmToolError && error.code === 'RENDER_BUSY' ? error.body?.taskId : undefined
          if (typeof running === 'string' && running !== '') {
            const followed = await follow(services, film, running, exec, waitMs)
            return plain({ ...followed, alreadyRunning: true, note: `${String(followed.note ?? '')} — this film was already rendering, so this call followed that render (task ${running}) instead of starting another; its settings may differ from the ones asked for, so check the file, and render again once it has ended if they must.` })
          }
          throw error
        }
        if (args.check === true) {
          // The contract's flat shape; Studio's nested copy of the same facts is left out.
          const { output: _output, plan: _plan, ...check } = answer
          return plain(check)
        }
        const taskId = typeof answer.taskId === 'string' ? answer.taskId : ''
        if (taskId === '') throw new FilmToolError('TIMELINE_RENDER_FAILED', 'The render route answered without a task.')
        return plain(await follow(services, film, taskId, exec, waitMs))
      },
    }),
  ]
}
