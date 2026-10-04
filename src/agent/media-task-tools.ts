/**
 * Film tasks for the agent (Studio's `media_get_task` and `media_cancel_task`,
 * apps/daemon/src/mcp.ts), over the task routes the canvas calls: the
 * storyboard generations of this workbench, whose ids
 * canvas_get_generation_status reports as outputs[].task, and the cuts, joins
 * and sound copies the Host runs for the video_* tools (media edits, C10).
 * @module dsh-film/agent/media-task-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { callStudio } from './studio-client.js'
import { filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices } from './context.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * A task as the agent reads it: status, the last progress line, the error,
 * and the file without bulky members.
 * @param snapshot - the wait route's answer.
 * @returns the compact view.
 */
export function compactTask(snapshot: Record<string, unknown>): Record<string, unknown> {
  const progress = Array.isArray(snapshot.progress) ? snapshot.progress : []
  const file = isRecord(snapshot.file) ? snapshot.file : undefined
  return {
    taskId: snapshot.taskId,
    status: snapshot.status,
    ...(progress.length > 0 ? { progress: progress.at(-1) } : {}),
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    ...(isRecord(snapshot.error) ? { error: snapshot.error } : {}),
    ...(file !== undefined
      ? { file: Object.fromEntries(Object.entries(file).filter(([, value]) => value === null || typeof value !== 'object')) }
      : {}),
  }
}

/**
 * Build the film task tools.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function mediaTaskTools(services: FilmToolServices): ToolDefinition[] {
  const wait = (cwd: string, taskId: string, signal: AbortSignal | undefined) =>
    callStudio(services.studio, cwd, { method: 'POST', path: `/api/media/tasks/${segment(taskId)}/wait`, body: { since: 0, timeoutMs: 0 } }, signal)
  return [
    defineTool({
      name: 'media_get_task',
      description: 'Read one film task by its taskId — a storyboard generation of this workbench (the id canvas_get_generation_status reports as '
        + 'outputs[].task), or a cut, join or sound copy a video_* tool started: status, the last progress line, the error (with reasons when the Host could '
        + 'not copy a file), and its file. A finished edit\'s file.landedNodeId is the node it put on the board (file.landError says why it could not). Film '
        + 'tasks only — dsh-media\'s media_tasks lists a different kind of task.',
      parameters: {
        taskId: { type: 'string', required: true },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        return plain(compactTask(await wait(film.cwd, args.taskId, exec.signal)))
      },
    }),
    defineTool({
      name: 'media_cancel_task',
      description: 'Cancel one film task by its taskId (a storyboard generation of this workbench, as canvas_get_generation_status reports it in '
        + 'outputs[].task, or an edit a video_* tool started); a finished task is left as it is. A cancelled edit leaves no partial file; one whose result '
        + 'file is already written finishes as done. Film tasks only, not dsh-media\'s media_tasks.',
      parameters: {
        taskId: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        await callStudio(services.studio, film.cwd, { method: 'POST', path: `/api/media/tasks/${segment(args.taskId)}/cancel`, body: {} }, exec.signal)
        return plain(compactTask(await wait(film.cwd, args.taskId, exec.signal)))
      },
    }),
  ]
}
