/** The agent's caption tools, called the way the agent loop calls them, against a real workspace and a fake engine. */

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compactTask } from '../../src/agent/caption-tools.js'
import { filmCoreTools } from '../../src/agent/index.js'
import { filmProjectTool } from '../../src/agent/project-tool.js'
import { CanvasBoardAgent } from '../../src/canvas/board-agent.js'
import { createStudioRouter } from '../../src/routes.js'
import { ProjectEvents } from '../../src/studio/events.js'
import { fakeEngine, workspace } from './fixture.js'
import type { Workspace } from './fixture.js'

let h: Workspace
let engine: ReturnType<typeof fakeEngine>
let tools: Map<string, ToolDefinition>
const agent = { session: { header: { cwd: '' } } }

beforeEach(async () => {
  engine = fakeEngine(async input => input.sources.map(source => ({
    sourceClipId: source.clipId,
    segments: Array.from({ length: 3 }, (_, index) => ({ text: `${source.clipId} 第 ${index + 1} 句`, start: index * 0.5, end: index * 0.5 + 0.4, ...(index === 2 ? { warnings: ['weak-speech-evidence'] } : {}) })),
  })))
  h = await workspace(engine)
  agent.session.header.cwd = h.cwd
  const events = new ProjectEvents()
  const boardAgent = new CanvasBoardAgent()
  const services = { studio: createStudioRouter({ events, boardAgent, tasks: h.tasks, captions: h.service }), boardAgent, events, projectCreated: () => {} }
  tools = new Map([filmProjectTool(services), ...filmCoreTools(services)].map(tool => [tool.name, tool]))
  await run('film_project', { action: 'create', title: '雨夜来客' })
})

afterEach(async () => {
  await h.cleanup()
})

function exec(): ToolRunContext {
  return {
    agent, signal: new AbortController().signal,
    callId: 'call-9', rootCallId: 'call-9', name: 'test', arguments: {}, token: Symbol('call'),
    deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext
}

async function run(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool.execute(args, exec())
}

describe('caption tools', () => {
  it('transcribe → media_get_task (paged draft) → apply dry run → apply → caption-tasks', async () => {
    // Whisper is the only engine: the agent names none.
    expect(Object.keys((tools.get('timeline_transcribe')!.parameters as { properties: Record<string, unknown> }).properties)).toEqual(['baseRevision', 'requestId', 'clipIds', 'range', 'language'])
    const started = await run('timeline_transcribe', { baseRevision: 1, requestId: 'agent-1', range: { start: 1, end: 6 } })
    expect(started).toMatchObject({ status: 'running', engine: 'whisper', duplicate: false, note: expect.stringContaining('media_get_task') })
    await h.service.whenIdle()
    expect(engine.inputs).toHaveLength(1)
    const first = await run('media_get_task', { taskId: started.taskId, limit: 4 })
    expect(first).toMatchObject({ taskId: started.taskId, status: 'done', progress: '完成', draft: { kind: 'timeline-caption-draft', engine: 'whisper', segmentCount: 6, offset: 0, nextOffset: 4 } })
    expect(first.draft.segments).toHaveLength(4)
    expect(first.draft.sources.map((source: any) => source.clipId)).toEqual(['a', 'b'])
    expect(first.draft.sources[0].mapping).toBeUndefined()
    const rest = await run('media_get_task', { taskId: started.taskId, offset: 4 })
    expect(rest.draft.segments.map((line: any) => line.text)).toEqual(['b 第 2 句', 'b 第 3 句'])
    expect(rest.draft.segments[1].warnings).toEqual(['weak-speech-evidence'])
    expect(rest.draft.nextOffset).toBeUndefined()
    expect((await run('timeline_query', { kind: 'caption-tasks' })).tasks).toMatchObject([{ taskId: started.taskId, applied: false }])
    await expect(run('timeline_apply_captions', { taskId: started.taskId, reviewed: false, dryRun: true })).rejects.toThrow(/CAPTION_REVIEW_REQUIRED/)
    const dry = await run('timeline_apply_captions', { taskId: started.taskId, reviewed: true, dryRun: true })
    expect(dry.result).toMatchObject({ committed: false, revision: 1 })
    expect(dry.result.before).toBeUndefined()
    const applied = await run('timeline_apply_captions', { taskId: started.taskId, reviewed: true, dryRun: false, excludeSegmentIds: [first.draft.segments[0].id] })
    expect(applied.result).toMatchObject({ committed: true, revision: 2 })
    expect((await run('timeline_query', { kind: 'caption-tasks' })).tasks).toMatchObject([{ taskId: started.taskId, applied: true }])
    const cut = await run('timeline_query')
    expect(cut.captions.map((caption: any) => caption.text)).toContain('a 第 2 句')
    expect(cut.captions.map((caption: any) => caption.text)).not.toContain('a 第 1 句')
  })

  it('refuses a stale revision with the current one, and cancels a running recognition', async () => {
    await expect(run('timeline_transcribe', { baseRevision: 0, requestId: 'stale' })).rejects.toThrow(/CANVAS_TIMELINE_CONFLICT.*current revision: 1/)
    let entered!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    engine.recognize = async input => new Promise((_resolve, reject) => {
      entered()
      input.signal.addEventListener('abort', () => { reject(input.signal.reason) })
    })
    const started = await run('timeline_transcribe', { baseRevision: 1, requestId: 'cancel-me' })
    await ready
    const cancelled = await run('media_cancel_task', { taskId: started.taskId })
    expect(cancelled).toMatchObject({ taskId: started.taskId, status: 'interrupted', error: { code: 'MEDIA_TASK_CANCELED' } })
    await expect(run('media_get_task', { taskId: 'missing-task' })).rejects.toThrow(/MEDIA_TASK_NOT_FOUND/)
  })
})

describe('compactTask', () => {
  it('summarises other files without bulky members', () => {
    expect(compactTask({ taskId: 't', status: 'done', progress: ['a', 'b'], startedAt: 1, endedAt: 2, error: null, file: { name: 'canvas/renders/x.mp4', size: 3, kind: 'video', mime: 'video/mp4', loudness: { lufs: -14 } } }))
      .toEqual({ taskId: 't', status: 'done', progress: 'b', startedAt: 1, endedAt: 2, file: { name: 'canvas/renders/x.mp4', size: 3, kind: 'video', mime: 'video/mp4' } })
  })
})
