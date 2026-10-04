/**
 * Original-audio captions for the agent (Studio's `timeline_transcribe`,
 * `timeline_apply_captions`, `media_get_task` and `media_cancel_task`,
 * apps/daemon/src/mcp.ts), over the same caption and task routes the editing
 * desk calls. Recognition is a background film task: the tool answers with
 * its id, the draft is read with media_get_task (paged by line, since a
 * draft can be large), and nothing reaches the cut until a reviewed apply.
 * @module dsh-film/agent/caption-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { captionCaller } from '../captions/service.js'
import { callStudio } from './studio-client.js'
import { filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices } from './context.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Draft lines per page by default, and at most. */
const PAGE = 200
const PAGE_MAX = 1000

/**
 * A task as the agent reads it: status, the last progress line, the error,
 * and the file — a caption draft as a page of its lines, any other file
 * without bulky members.
 * @param snapshot - the wait route's answer.
 * @param offset - the first draft line to show.
 * @param limit - how many draft lines.
 * @returns the compact view.
 */
export function compactTask(snapshot: Record<string, unknown>, offset = 0, limit = PAGE): Record<string, unknown> {
  const progress = Array.isArray(snapshot.progress) ? snapshot.progress : []
  const file = isRecord(snapshot.file) ? snapshot.file : undefined
  const base: Record<string, unknown> = {
    taskId: snapshot.taskId,
    status: snapshot.status,
    ...(progress.length > 0 ? { progress: progress.at(-1) } : {}),
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    ...(isRecord(snapshot.error) ? { error: snapshot.error } : {}),
  }
  if (file === undefined) return base
  const draft = isRecord(file.documentResult) ? file.documentResult : undefined
  if (draft?.kind !== 'timeline-caption-draft') {
    const { documentResult: _document, ...rest } = file
    return { ...base, file: Object.fromEntries(Object.entries(rest).filter(([, value]) => value === null || typeof value !== 'object')) }
  }
  const segments = Array.isArray(draft.segments) ? draft.segments.filter(isRecord) : []
  const start = Math.max(0, Math.trunc(offset))
  const page = segments.slice(start, start + Math.max(0, Math.min(PAGE_MAX, Math.trunc(limit))))
  const next = start + page.length
  return {
    ...base,
    draft: {
      kind: draft.kind,
      engine: draft.engine,
      model: draft.model,
      baseRevision: draft.baseRevision,
      reviewStatus: draft.reviewStatus,
      ranges: draft.ranges,
      sources: (Array.isArray(draft.sources) ? draft.sources.filter(isRecord) : []).map(source => ({
        clipId: source.clipId, track: source.track, file: source.file, start: source.start, end: source.end, sourceIn: source.sourceIn, sourceOut: source.sourceOut,
      })),
      ...(isRecord(draft.evidence) ? { evidence: draft.evidence } : {}),
      segmentCount: segments.length,
      offset: start,
      segments: page.map(line => ({
        id: line.id, start: line.start, end: line.end, text: line.text,
        ...(Array.isArray(line.warnings) && line.warnings.length > 0 ? { warnings: line.warnings } : {}),
      })),
      ...(next < segments.length ? { nextOffset: next } : {}),
    },
  }
}

/**
 * Build the caption tools.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function captionTools(services: FilmToolServices): ToolDefinition[] {
  const timelinePath = (boardId: string, projectId: string, rest: string): string =>
    `/api/canvas/timelines/${segment(boardId)}/${rest}?project=${segment(projectId)}`
  return [
    defineTool({
      name: 'timeline_transcribe',
      description: 'Recognise the original dialogue of the film\'s cut as captions (自动字幕、原声识别、语音转字幕). Read timeline_query first and quote its revision. '
        + 'By default it hears the audible video clips\' own sound; clipIds may name separated original-audio clips; range is in timeline seconds; trims, '
        + 'offsets and speed are honoured and the cut is never edited. Returns a film taskId: read it with media_get_task, cancel with media_cancel_task. A '
        + 'done task holds an unreviewed draft (file.documentResult) with original-source timestamps; apply it only through timeline_apply_captions. '
        + 'engine: whisper (default setting; free, local, runs in a hidden page of an open VibeDev/DSH window, needs the person\'s consent to download its '
        + 'models) or gateway (VibeDev\'s ASR: Mandarin only, paid at about ¥0.05 per minute of speech, the audio is uploaded to a third-party service, '
        + 'cancelling only stops waiting, and timings come from speech regions; if dsh-media is set to confirm spending, the person is asked once for the '
        + 'whole estimate before the task starts, and SPENDING_DECLINED means they said no). There is no fallback: if the chosen engine cannot run, the call fails — '
        + 'report it, do not switch engines without the person. Never infer dialogue from a script or image; missing consent or no open window is an '
        + 'explicit failure to report, not something to work around.',
      parameters: {
        baseRevision: { type: 'integer', required: true, description: 'The cut\'s revision from timeline_query.' },
        requestId: { type: 'string', required: true, description: 'Names this request; repeating it with the same inputs returns the same task, never a second recognition.' },
        clipIds: { type: 'array', items: { type: 'string' }, description: 'Clip ids to hear (video clips, or separated original-audio clips).' },
        range: {
          type: 'object',
          properties: { start: { type: 'number', required: true }, end: { type: 'number', required: true } },
          additionalProperties: false,
          description: 'Timeline seconds.',
        },
        language: { type: 'string', description: 'Speech language hint, e.g. zh (Whisper detects the language itself; the gateway takes zh only).' },
        engine: { type: 'string', enum: ['whisper', 'gateway'], description: 'The recognition engine; the plugin setting when omitted.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        const { baseRevision, requestId, clipIds, range, language, engine } = args
        const body = {
          baseRevision, requestId,
          ...(clipIds !== undefined ? { clipIds } : {}),
          ...(range !== undefined ? { range } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(engine !== undefined ? { engine } : {}),
        }
        // The gateway's spending confirmation asks through this tool call, once, before the task starts (dsh-media's setting decides).
        const started = await captionCaller.run({ agent: exec.agent, callId: exec.callId }, () =>
          callStudio(services.studio, film.cwd, { method: 'POST', path: timelinePath(film.boardId, film.projectId, 'transcribe'), body }, exec.signal))
        return plain({ ...started, note: 'Recognition runs in the background. Poll media_get_task with this taskId; a done task is a draft to review, not applied captions.' })
      },
    }),
    defineTool({
      name: 'timeline_apply_captions',
      description: 'Apply a reviewed recognition draft from timeline_transcribe to the cut. Review the draft (media_get_task) against the original sound first — '
        + 'silence and music are not verified dialogue — then call with reviewed:true, dryRun:true, inspect the caption-only diff, then dryRun:false and read '
        + 'timeline_query. excludeSegmentIds leaves suspicious lines out. Only captions inside the recognised ranges change; manual, edited and earlier '
        + 'reviewed captions are protected (a second recognition over the same range only fills gaps). A retry cannot duplicate. If the cut moved on since '
        + 'the recognition, the apply is refused: tell the person and recognise again.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'The taskId timeline_transcribe returned.' },
        reviewed: { type: 'boolean', required: true, description: 'The draft was checked against the original sound.' },
        dryRun: { type: 'boolean', required: true },
        excludeSegmentIds: { type: 'array', items: { type: 'string' }, description: 'Draft line ids to leave out.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        const body = { taskId: args.taskId, reviewed: args.reviewed, dryRun: args.dryRun, ...(args.excludeSegmentIds !== undefined ? { excludeSegmentIds: args.excludeSegmentIds } : {}) }
        return plain(await callStudio(services.studio, film.cwd, { method: 'POST', path: timelinePath(film.boardId, film.projectId, 'captions/apply'), body }, exec.signal))
      },
    }),
    defineTool({
      name: 'media_get_task',
      description: 'Read one film task by its taskId — a caption recognition from timeline_transcribe, a render, or a storyboard generation of this workbench: '
        + 'status, the last progress line, the error, and its file. A caption draft comes back as its sources, ranges and a page of lines (id, start, end, '
        + 'text, warnings; offset/limit, nextOffset when more remain). Film tasks only — dsh-media\'s media_tasks lists a different kind of task.',
      parameters: {
        taskId: { type: 'string', required: true },
        offset: { type: 'integer', description: 'First draft line to return.' },
        limit: { type: 'integer', description: `Draft lines to return (default ${PAGE}).` },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        const snapshot = await callStudio(services.studio, film.cwd, { method: 'POST', path: `/api/media/tasks/${segment(args.taskId)}/wait`, body: { since: 0, timeoutMs: 0 } }, exec.signal)
        return plain(compactTask(snapshot, args.offset ?? 0, args.limit ?? PAGE))
      },
    }),
    defineTool({
      name: 'media_cancel_task',
      description: 'Cancel one film task by its taskId (a caption recognition, a render, a storyboard generation of this workbench); a finished task is left '
        + 'as it is. A gateway recognition already submitted is still charged — cancelling only stops waiting. Film tasks only, not dsh-media\'s media_tasks.',
      parameters: {
        taskId: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        await callStudio(services.studio, film.cwd, { method: 'POST', path: `/api/media/tasks/${segment(args.taskId)}/cancel`, body: {} }, exec.signal)
        const snapshot = await callStudio(services.studio, film.cwd, { method: 'POST', path: `/api/media/tasks/${segment(args.taskId)}/wait`, body: { since: 0, timeoutMs: 0 } }, exec.signal)
        return plain(compactTask(snapshot, 0, 0))
      },
    }),
  ]
}
