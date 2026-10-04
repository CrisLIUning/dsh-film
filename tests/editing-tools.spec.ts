/**
 * The cutting tools (C12, group 'editing'), called the way the agent loop
 * calls them: marks and splits on the saved board or the open page, renders,
 * joins and sound copies as Host film tasks that land their results.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filmAgentTools } from '../src/agent/index.js'
import type { FilmToolServices } from '../src/agent/index.js'
import { filmProjectTool } from '../src/agent/project-tool.js'
import { CanvasBoardAgent } from '../src/canvas/board-agent.js'
import type { BoardLease, BoardTarget } from '../src/canvas/board-agent.js'
import { applyBoardOps } from '../src/canvas/board-ops.js'
import type { BoardNode, BoardOp, BoardSnapshot } from '../src/canvas/board-ops.js'
import { FilmMediaTasks } from '../src/media/tasks.js'
import { createStudioRouter } from '../src/routes.js'
import { ProjectEvents } from '../src/studio/events.js'
import type { ProjectEvent } from '../src/studio/events.js'
import type { EventStream } from '../src/studio/sse.js'
import { writeFixture } from './media-edit-fixtures.js'

let cwd: string
let events: ProjectEvents
let boardAgent: CanvasBoardAgent
let tasks: FilmMediaTasks
let tools: Map<string, ToolDefinition>
let film: { id: string }
let seen: ProjectEvent[]
/** Runs while a tool waits for the Host's probe (between reading the board and writing it). */
let duringProbe: (() => Promise<void>) | undefined

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-editing-'))
  events = new ProjectEvents()
  boardAgent = new CanvasBoardAgent()
  tasks = new FilmMediaTasks(() => undefined)
  duringProbe = undefined
  const studio = createStudioRouter({ events, boardAgent, tasks })
  const dispatch = studio.dispatch.bind(studio)
  studio.dispatch = async (request) => {
    if ((new URL(request.url).searchParams.get('path') ?? '').includes('/probe')) await duringProbe?.()
    return dispatch(request)
  }
  const services: FilmToolServices = { studio, boardAgent, events, projectCreated: () => {} }
  tools = new Map([filmProjectTool(services), ...filmAgentTools(services)].map(tool => [tool.name, tool]))
  film = (await run('film_project', { action: 'create', title: '雨夜来客' })).project
  seen = []
  events.subscribe(cwd, (event) => { seen.push(event) })
})

afterEach(async () => {
  tasks.dispose()
  await tasks.settled()
  await rm(cwd, { recursive: true, force: true })
})

function exec(): ToolRunContext {
  return {
    agent: { session: { header: { cwd } } },
    signal: new AbortController().signal,
    callId: 'call-1', rootCallId: 'call-1', name: 'test', arguments: {}, token: Symbol('call'),
    deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext
}

async function run(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool.execute(args, exec())
}

/** The refusal a call ends with. */
const refused = (name: string, args: Record<string, unknown>): Promise<any> => run(name, args).then(() => { throw new Error(`${name} was not refused`) }, (error: unknown) => error)

const url = (name: string): string => `/api/projects/${film.id}/raw/canvas/media/${name}`
const media = (name: string): string => join(cwd, 'film', 'canvas', 'media', name)
const savedBoard = async (): Promise<any> => JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'document.json'), 'utf8'))
const savedNode = async (id: string): Promise<any> => (await savedBoard()).nodes.find((node: { id: string }) => node.id === id)

/** A video (or other) node with a film file, on the saved board. */
function mediaNodeOp(id: string, file: string, metadata: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): BoardOp {
  return {
    type: 'add_node', id, nodeType: 'video', title: '镜头', position: { x: 100, y: 50 }, width: 320, height: 180,
    metadata: { content: url(file), status: 'success', mimeType: 'video/mp4', ...metadata }, ...extra,
  }
}

async function onBoard(...ops: BoardOp[]): Promise<void> {
  await run('canvas_apply_ops', { ops })
}

/** Follow a film task through media_get_task until it ends. */
async function finished(taskId: string): Promise<any> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const task = await run('media_get_task', { taskId })
    if (['done', 'failed', 'interrupted'].includes(task.status)) return task
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`task ${taskId} did not end`)
}

/** A canvas page showing this film's board: it takes its lease, reports the board and runs the ops it is sent. */
function openPage(nodes: BoardNode[]) {
  const sent: Array<{ event: string; data: any }> = []
  let board: BoardSnapshot = { projectId: film.id, title: '雨夜来客', nodes, connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }
  let lease!: BoardLease
  let sequence = 1
  let closed = false
  const stream: EventStream = {
    send(event, data) {
      if (closed) return false
      sent.push({ event, data })
      if (event === 'tool_call') {
        const call = data as { requestId: string; input: { ops: BoardOp[] } }
        queueMicrotask(() => {
          board = applyBoardOps(board, call.input.ops)
          boardAgent.resolve(lease, { requestId: call.requestId, result: board, sequence: ++sequence })
        })
      }
      return true
    },
    close() { closed = true },
    get closed() { return closed },
  }
  const target: BoardTarget = { projectId: film.id, clientId: 'page-1', incarnation: 'load-1' }
  boardAgent.connect(target, stream)
  const hello = sent[0]!.data as { generation: string; writeToken: string }
  lease = { target, generation: hello.generation, writeToken: hello.writeToken }
  boardAgent.setSnapshot(lease, board, sequence)
  return { calls: () => sent.filter(item => item.event === 'tool_call').map(item => item.data), board: () => board, target }
}

/** The node an op adds, as a board node. */
const nodeOf = (op: BoardOp): BoardNode => applyBoardOps({ nodes: [], connections: [] }, [op]).nodes![0]!

describe('video_clip', () => {
  it('marks a part of the file on the saved board, reading the length from the Host, and never touches the file', async () => {
    await writeFixture(media('src.mp4'), { frames: 75 })
    await onBoard(mediaNodeOp('shot', 'src.mp4'))
    seen.length = 0
    const marked = await run('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), inMs: 500, outMs: 2000 })
    expect(marked).toMatchObject({ source: 'persisted', changed: true, nodeId: 'shot', clip: { inMs: 500, outMs: 2000 }, resultView: 'changes' })
    const durationMs = marked.durationMs as number
    expect(durationMs).toBeGreaterThanOrEqual(3000)
    expect(durationMs).toBeLessThan(3100)
    expect((await savedNode('shot')).metadata).toMatchObject({ clip: { inMs: 500, outMs: 2000 }, durationMs, content: url('src.mp4') })
    expect(seen).toContainEqual({ type: 'story-canvas-changed', projectId: film.id, boardId: film.id })

    // One edge at a time keeps the other.
    expect((await run('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), outMs: 2500 })).clip).toEqual({ inMs: 500, outMs: 2500 })
    expect((await run('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), inMs: 1000 })).clip).toEqual({ inMs: 1000, outMs: 2500 })
    // The same mark again changes nothing.
    const before = (await savedBoard()).updatedAt
    expect(await run('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), inMs: 1000, outMs: 2500 })).toMatchObject({ changed: false, clip: { inMs: 1000, outMs: 2500 } })
    expect((await savedBoard()).updatedAt).toBe(before)
    // The whole file is no mark; clear stores null (the agent cannot delete a key).
    expect(await run('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), inMs: 0, outMs: durationMs })).toMatchObject({ changed: true, clip: null, note: expect.stringContaining('whole file') })
    expect((await savedNode('shot')).metadata.clip).toBeNull()
    await run('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), inMs: 200, outMs: 900 })
    expect(await run('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), clear: true })).toMatchObject({ changed: true, clip: null })
    expect((await savedNode('shot')).metadata.clip).toBeNull()
    expect(await run('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), clear: true })).toMatchObject({ changed: false })
    expect(await readdir(join(cwd, 'film', 'canvas', 'media'))).toEqual(['src.mp4'])
  })

  it('marks an audio node too, by its recorded length', async () => {
    await onBoard(mediaNodeOp('music', 'theme.m4a', { mimeType: 'audio/mp4', durationMs: 8000 }, { nodeType: 'audio' }))
    expect(await run('video_clip', { nodeId: 'music', expectedContent: url('theme.m4a'), inMs: 1000, outMs: 4000 })).toMatchObject({ clip: { inMs: 1000, outMs: 4000 }, durationMs: 8000 })
    expect((await savedNode('music')).metadata).toMatchObject({ clip: { inMs: 1000, outMs: 4000 }, durationMs: 8000 })
  })

  it('refuses a bad range, a node that changed or is generating, and nodes it cannot mark', async () => {
    await onBoard(
      mediaNodeOp('shot', 'src.mp4', { durationMs: 3000 }),
      mediaNodeOp('busy', 'src.mp4', { durationMs: 3000, status: 'loading' }),
      mediaNodeOp('linked', 'src.mp4', { content: 'https://example.com/clip.mp4' }),
      mediaNodeOp('empty', 'src.mp4', { content: '' }),
      { type: 'add_node', id: 'note', nodeType: 'text', metadata: { content: '镜 1' } },
    )
    const shot = { nodeId: 'shot', expectedContent: url('src.mp4') }
    expect((await refused('video_clip', { ...shot, inMs: 2000, outMs: 2050 })).code).toBe('CANVAS_CLIP_INVALID')
    expect((await refused('video_clip', { ...shot, inMs: 2000, outMs: 3001 })).message).toMatch(/CANVAS_CLIP_INVALID: .*0–3000 ms/u)
    expect((await refused('video_clip', { ...shot, inMs: 2500, outMs: 2000 })).code).toBe('CANVAS_CLIP_INVALID')
    expect((await refused('video_clip', { ...shot, clear: true, inMs: 0 })).code).toBe('CANVAS_CLIP_INVALID')
    expect((await refused('video_clip', shot)).code).toBe('CANVAS_CLIP_INVALID')
    await expect(run('video_clip', { ...shot, inMs: 0.5, outMs: 900 })).rejects.toThrow(/integer/u)
    expect((await refused('video_clip', { ...shot, expectedContent: url('other.mp4'), inMs: 0, outMs: 900 })).code).toBe('CANVAS_CLIP_TARGET_CHANGED')
    expect((await refused('video_clip', { nodeId: 'busy', expectedContent: url('src.mp4'), inMs: 0, outMs: 900 })).code).toBe('CANVAS_CLIP_TARGET_CHANGED')
    expect((await refused('video_clip', { nodeId: 'linked', expectedContent: 'https://example.com/clip.mp4', inMs: 0, outMs: 900 })).message).toMatch(/CANVAS_CLIP_TARGET: .*not a file of this film/u)
    expect((await refused('video_clip', { nodeId: 'empty', expectedContent: '', inMs: 0, outMs: 900 })).code).toBe('CANVAS_CLIP_TARGET')
    expect((await refused('video_clip', { nodeId: 'note', expectedContent: '镜 1', inMs: 0, outMs: 900 })).code).toBe('CANVAS_CLIP_TARGET')
    expect((await refused('video_clip', { nodeId: 'gone', expectedContent: '', inMs: 0, outMs: 900 })).code).toBe('CANVAS_NODE_NOT_FOUND')
    // A file the Host cannot read has no length to mark against.
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(media('broken.mp4'), 'not a video')
    await onBoard(mediaNodeOp('broken', 'broken.mp4'))
    expect((await refused('video_clip', { nodeId: 'broken', expectedContent: url('broken.mp4'), inMs: 0, outMs: 900 })).code).toBe('CANVAS_CLIP_TARGET')
    expect((await savedNode('shot')).metadata.clip).toBeUndefined()
  })

  it('decides the saved board\'s edit from the node as it is under the board\'s lock', async () => {
    await writeFixture(media('src.mp4'), { frames: 75 })
    await onBoard(mediaNodeOp('shot', 'src.mp4', { clip: { inMs: 200, outMs: 900 } }))
    const change = (metadata: Record<string, unknown>) => async (): Promise<void> => {
      duringProbe = undefined
      await run('canvas_apply_ops', { ops: [{ type: 'update_node', id: 'shot', metadata }] })
    }
    // Someone moves the mark while the tool reads the file's length: an edge left out keeps the new mark's.
    duringProbe = change({ clip: { inMs: 400, outMs: 900 } })
    expect((await run('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), outMs: 1500 })).clip).toEqual({ inMs: 400, outMs: 1500 })
    expect((await savedNode('shot')).metadata.clip).toEqual({ inMs: 400, outMs: 1500 })
    // The file changes meanwhile: nothing is written.
    await onBoard({ type: 'update_node', id: 'shot', metadata: { durationMs: null } })
    duringProbe = change({ content: url('other.mp4') })
    expect((await refused('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), inMs: 0, outMs: 500 })).code).toBe('CANVAS_CLIP_TARGET_CHANGED')
    expect((await savedNode('shot')).metadata).toMatchObject({ clip: { inMs: 400, outMs: 1500 }, content: url('other.mp4') })
    // A split checks the mark again too.
    await onBoard(mediaNodeOp('second', 'src.mp4', { clip: { inMs: 0, outMs: 2000 } }, { position: { x: 100, y: 600 } }))
    duringProbe = async () => {
      duringProbe = undefined
      await run('canvas_apply_ops', { ops: [{ type: 'update_node', id: 'second', metadata: { clip: { inMs: 1500, outMs: 2000 } } }] })
    }
    expect((await refused('video_split', { nodeId: 'second', expectedContent: url('src.mp4'), atMs: 1000 })).message).toMatch(/CANVAS_CLIP_INVALID: .*1500–2000 ms/u)
    expect((await savedBoard()).nodes).toHaveLength(2)
  })

  it('marks through the open page with an update_node op the page runs, leaving the saved board to the page', async () => {
    const page = openPage([nodeOf(mediaNodeOp('shot', 'src.mp4', { durationMs: 3000 }))])
    const marked = await run('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), inMs: 500, outMs: 1500 })
    expect(marked).toMatchObject({ source: 'live', target: page.target, changed: true, clip: { inMs: 500, outMs: 1500 } })
    expect(page.calls()).toEqual([expect.objectContaining({ name: 'canvas_apply_ops', input: { boardId: film.id, project: film.id, ops: [{ type: 'update_node', id: 'shot', metadata: { clip: { inMs: 500, outMs: 1500 } } }] } })])
    expect(page.board().nodes![0]!.metadata!.clip).toEqual({ inMs: 500, outMs: 1500 })
    expect((await savedBoard()).nodes).toEqual([])
    // Cleared on the page: null, which the page reads as no mark.
    await run('video_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), clear: true })
    expect(page.calls()[1].input.ops).toEqual([{ type: 'update_node', id: 'shot', metadata: { clip: null } }])
  })
})

describe('video_split', () => {
  const cues = [
    { id: 'early', startMs: 600, endMs: 1200, text: '早' },
    { id: 'across', startMs: 1400, endMs: 1700, text: '跨' },
    { id: 'late', startMs: 2000, endMs: 2400, text: '晚' },
  ]
  const sequence = { directorNodeId: 'desk', renderId: 'r1', shots: [{ shotId: 's1', cameraId: 'c1', sourceIn: 0, sourceOut: 1.3, start: 0, end: 1.3 }, { shotId: 's2', cameraId: 'c2', sourceIn: 5, sourceOut: 6.7, start: 1.3, end: 3 }] }

  it('splits a node on the saved board into its first part and a sibling on the same file, cues and shots following', async () => {
    await onBoard(mediaNodeOp('shot', 'src.mp4', {
      durationMs: 3000, clip: { inMs: 500, outMs: 2500 }, prompt: '雨夜门口', subtitleEntries: cues, directorSequence: sequence,
      videoTaskId: 'task-1', videoAttempt: { attemptId: 'a', status: 'succeeded' }, gatewayReceipt: { taskId: 'g' },
    }))
    const split = await run('video_split', { nodeId: 'shot', expectedContent: url('src.mp4'), atMs: 1500 })
    expect(split).toMatchObject({ source: 'persisted', nodeId: 'shot', clips: { shot: { inMs: 500, outMs: 1500 } }, totalNodeCount: 2 })
    const newNodeId = split.newNodeId as string
    expect(newNodeId).toMatch(/^video-/u)
    expect(split.clips[newNodeId]).toEqual({ inMs: 1500, outMs: 2500 })
    const board = await savedBoard()
    const original = board.nodes.find((node: { id: string }) => node.id === 'shot')
    const sibling = board.nodes.find((node: { id: string }) => node.id === newNodeId)
    expect(original.metadata).toMatchObject({ clip: { inMs: 500, outMs: 1500 }, durationMs: 3000, videoTaskId: 'task-1' })
    expect(sibling).toMatchObject({ type: 'video', title: '镜头（后段）', position: { x: 516, y: 50 }, width: 320, height: 180 })
    expect(sibling.metadata).toMatchObject({ content: url('src.mp4'), status: 'success', mimeType: 'video/mp4', durationMs: 3000, prompt: '雨夜门口', clip: { inMs: 1500, outMs: 2500 } })
    expect(sibling.metadata.subtitleEntries.map((cue: { id: string }) => cue.id)).toEqual(['across', 'late'])
    expect(sibling.metadata.subtitleEntries[0]).toEqual(cues[1])
    expect(sibling.metadata.directorSequence).toMatchObject({ renderId: 'r1', shots: [{ shotId: 's2' }] })
    for (const key of ['videoTaskId', 'videoAttempt', 'gatewayReceipt']) expect(sibling.metadata[key], key).toBeUndefined()
    expect(board.connections).toEqual([{ id: `derived:${newNodeId}:shot`, fromNodeId: 'shot', toNodeId: newNodeId }])
    // Splitting the original again sends the new sibling down past the first.
    const again = await run('video_split', { nodeId: 'shot', expectedContent: url('src.mp4'), atMs: 1000 })
    const second = await savedNode(again.newNodeId)
    expect(second.position.x).toBe(516)
    expect(second.position.y).toBeGreaterThanOrEqual(50 + 180)
    expect(second.metadata.clip).toEqual({ inMs: 1000, outMs: 1500 })
  })

  it('refuses a split within 100 ms of an edge of the part the node plays, and an audio node', async () => {
    await onBoard(
      mediaNodeOp('shot', 'src.mp4', { durationMs: 3000, clip: { inMs: 500, outMs: 2500 } }),
      mediaNodeOp('music', 'theme.m4a', { durationMs: 3000 }, { nodeType: 'audio' }),
    )
    for (const atMs of [550, 2450, 100, 2900]) {
      expect((await refused('video_split', { nodeId: 'shot', expectedContent: url('src.mp4'), atMs })).message, String(atMs)).toMatch(/CANVAS_CLIP_INVALID: .*500–2500 ms/u)
    }
    expect((await refused('video_split', { nodeId: 'music', expectedContent: url('theme.m4a'), atMs: 1000 })).code).toBe('CANVAS_CLIP_TARGET')
    expect((await refused('video_split', { nodeId: 'shot', expectedContent: 'stale', atMs: 1000 })).code).toBe('CANVAS_CLIP_TARGET_CHANGED')
    expect((await savedBoard()).nodes).toHaveLength(2)
  })

  it('splits an unmarked node on the open page with the ops the page runs', async () => {
    await writeFixture(media('src.mp4'), { frames: 75 })
    const page = openPage([nodeOf(mediaNodeOp('shot', 'src.mp4'))])
    const split = await run('video_split', { nodeId: 'shot', expectedContent: url('src.mp4'), atMs: 1200 })
    expect(split).toMatchObject({ source: 'live', nodeId: 'shot', clips: { shot: { inMs: 0, outMs: 1200 } } })
    const ops = page.calls()[0].input.ops as BoardOp[]
    expect(ops.map(op => op.type)).toEqual(['update_node', 'add_node', 'connect_nodes'])
    expect(ops[0]).toMatchObject({ id: 'shot', metadata: { clip: { inMs: 0, outMs: 1200 }, durationMs: split.durationMs } })
    expect(ops[1]).toMatchObject({ id: split.newNodeId, nodeType: 'video', position: { x: 516, y: 50 }, metadata: { content: url('src.mp4'), clip: { inMs: 1200, outMs: split.durationMs } } })
    expect(page.board().connections).toEqual([{ id: `derived:${split.newNodeId}:shot`, fromNodeId: 'shot', toNodeId: split.newNodeId }])
    expect((await savedBoard()).nodes).toEqual([])
  })
})

describe('video_render_clip', () => {
  it('renders a mark as a Host task and lands the clip right of the source with an edge, its prompt, cues and shots', async () => {
    await writeFixture(media('src.mp4'), { frames: 75 })
    await onBoard(mediaNodeOp('shot', 'src.mp4', {
      clip: { inMs: 1000, outMs: 2000 }, prompt: '雨夜门口',
      subtitleEntries: [{ id: 'line', startMs: 900, endMs: 1500, text: '有人吗' }, { id: 'later', startMs: 2500, endMs: 2900, text: '后来' }],
      directorSequence: { renderId: 'r1', shots: [{ shotId: 's1', cameraId: 'c1', sourceIn: 10, sourceOut: 13, start: 0, end: 3 }] },
    }))
    const requestId = 'render-0000-0001'
    const started = await run('video_render_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), requestId })
    expect(started).toMatchObject({ taskId: expect.any(String), nodeId: 'shot', clip: { inMs: 1000, outMs: 2000 }, note: expect.stringContaining('media_get_task') })
    expect((await run('video_render_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), requestId })).taskId).toBe(started.taskId)
    const task = await finished(started.taskId)
    expect(task).toMatchObject({ status: 'done', progress: '完成', file: { kind: 'video', mime: 'video/mp4', landedNodeId: expect.stringMatching(/^video-/u) } })
    expect(task.file.name).toMatch(/^canvas\/media\/clip-[0-9a-f]{10}\.mp4$/u)
    const board = await savedBoard()
    const landed = board.nodes.find((node: { id: string }) => node.id === task.file.landedNodeId)
    const placed = landed.metadata.derivedFrom.sources[0] as { inMs: number; outMs: number; atMs: number }
    expect(landed).toMatchObject({ type: 'video', title: '镜头 · 片段', position: { x: 516, y: 50 } })
    expect(landed.metadata).toMatchObject({
      content: `/api/projects/${film.id}/raw/${task.file.name}`, status: 'success', prompt: '雨夜门口',
      derivedFrom: { v: 1, op: 'cut', engine: 'host-copy', requestId, sources: [{ nodeId: 'shot', path: 'canvas/media/src.mp4', inMs: 1000, atMs: 0 }] },
    })
    expect(placed.outMs).toBeGreaterThanOrEqual(2000)
    // Cues and shots of the part, in the clip's own time.
    expect(landed.metadata.subtitleEntries).toEqual([{ id: 'line', startMs: 0, endMs: 500, text: '有人吗' }])
    expect(landed.metadata.directorSequence).toEqual({ renderId: 'r1', shots: [{ shotId: 's1', cameraId: 'c1', sourceIn: 11, sourceOut: 11 + (placed.outMs - 1000) / 1000, start: 0, end: (placed.outMs - 1000) / 1000 }] })
    for (const key of ['clip', 'videoTaskId', 'videoAttempt', 'videoGenerationInput', 'gatewayReceipt']) expect(landed.metadata[key], key).toBeUndefined()
    expect(board.connections).toEqual([{ id: `derived:${landed.id}:shot`, fromNodeId: 'shot', toNodeId: landed.id }])
    expect(seen).toContainEqual({ type: 'story-canvas-changed', projectId: film.id, boardId: film.id })
  })

  it('refuses a node without a mark, one that changed, and a file the Host cannot reach', async () => {
    await onBoard(
      mediaNodeOp('plain', 'src.mp4', { durationMs: 3000 }),
      mediaNodeOp('cleared', 'src.mp4', { durationMs: 3000, clip: null }),
      mediaNodeOp('linked', 'src.mp4', { content: 'https://example.com/clip.mp4', clip: { inMs: 0, outMs: 1000 } }),
    )
    expect((await refused('video_render_clip', { nodeId: 'plain', expectedContent: url('src.mp4'), requestId: 'render-0000-0002' })).message).toMatch(/^CANVAS_CLIP_NONE: .*video_clip/u)
    expect((await refused('video_render_clip', { nodeId: 'cleared', expectedContent: url('src.mp4'), requestId: 'render-0000-0003' })).code).toBe('CANVAS_CLIP_NONE')
    expect((await refused('video_render_clip', { nodeId: 'plain', expectedContent: 'stale', requestId: 'render-0000-0004' })).code).toBe('CANVAS_CLIP_TARGET_CHANGED')
    expect((await refused('video_render_clip', { nodeId: 'linked', expectedContent: 'https://example.com/clip.mp4', requestId: 'render-0000-0005' })).code).toBe('CANVAS_CLIP_TARGET')
    expect(await tasks.list(cwd)).toEqual([])
  })

  it('takes the mark from the open page and lands on the saved board, which the page merges in', async () => {
    await writeFixture(media('src.mp4'), { frames: 50 })
    await onBoard(mediaNodeOp('shot', 'src.mp4'))
    const page = openPage([nodeOf(mediaNodeOp('shot', 'src.mp4', { clip: { inMs: 500, outMs: 1500 } }))])
    const started = await run('video_render_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), requestId: 'render-0000-0006' })
    expect(started.clip).toEqual({ inMs: 500, outMs: 1500 })
    const task = await finished(started.taskId)
    expect(task.status).toBe('done')
    // No page ops: the Host wrote the saved board and announced it.
    expect(page.calls()).toEqual([])
    const landed = await savedNode(task.file.landedNodeId)
    expect(landed.metadata.derivedFrom.sources[0]).toMatchObject({ nodeId: 'shot', inMs: 500 })
    expect((await savedBoard()).connections).toEqual([{ id: `derived:${landed.id}:shot`, fromNodeId: 'shot', toNodeId: landed.id }])
    expect(seen).toContainEqual({ type: 'story-canvas-changed', projectId: film.id, boardId: film.id })
  })
})

describe('video_join', () => {
  it('joins compatible clips as a Host task into a final cut right of the last clip, with an edge from every clip', async () => {
    await writeFixture(media('a.mp4'), { frames: 50 })
    await writeFixture(media('b.mp4'), { frames: 50 })
    await onBoard(
      mediaNodeOp('first', 'a.mp4', { subtitleEntries: [{ id: 'x', startMs: 200, endMs: 900, text: '一' }] }),
      mediaNodeOp('second', 'b.mp4', { clip: { inMs: 1000, outMs: 2000 }, subtitleEntries: [{ id: 'y', startMs: 1200, endMs: 1600, text: '二' }] }, { position: { x: 100, y: 400 } }),
    )
    const started = await run('video_join', { nodeIds: ['first', 'second'], requestId: 'join-0000-0001' })
    expect(started).toMatchObject({ taskId: expect.any(String), nodeIds: ['first', 'second'] })
    const task = await finished(started.taskId)
    expect(task).toMatchObject({ status: 'done', file: { kind: 'video', landedNodeId: expect.any(String) } })
    expect(task.file.name).toMatch(/^canvas\/media\/join-[0-9a-f]{10}\.mp4$/u)
    expect(task.file.durationMs).toBeGreaterThanOrEqual(3000)
    const board = await savedBoard()
    const landed = board.nodes.find((node: { id: string }) => node.id === task.file.landedNodeId)
    expect(landed).toMatchObject({ type: 'video', title: '拼接成片 · 2 段', position: { x: 516, y: 400 } })
    expect(landed.metadata).toMatchObject({
      workflowKind: 'final', videoEditOperation: 'concat',
      derivedFrom: { op: 'join', engine: 'host-copy', sources: [{ nodeId: 'first', inMs: 0, atMs: 0 }, { nodeId: 'second', inMs: 1000 }] },
    })
    const secondAt = landed.metadata.derivedFrom.sources[1].atMs as number
    expect(landed.metadata.subtitleEntries).toEqual([
      { id: 'x', startMs: 200, endMs: 900, text: '一' },
      { id: 'y', startMs: secondAt + 200, endMs: secondAt + 600, text: '二' },
    ])
    expect(board.connections).toEqual([
      { id: `derived:${landed.id}:first`, fromNodeId: 'first', toNodeId: landed.id },
      { id: `derived:${landed.id}:second`, fromNodeId: 'second', toNodeId: landed.id },
    ])
  })

  it('answers VIDEO_JOIN_NEEDS_PAGE with each clip\'s reasons and starts nothing', async () => {
    await writeFixture(media('src.mp4'), { frames: 50 })
    await writeFixture(media('wide.mp4'), { width: 96 })
    await writeFixture(media('mute.mp4'), { audio: false })
    await onBoard(mediaNodeOp('a', 'src.mp4'), mediaNodeOp('wide', 'wide.mp4'), mediaNodeOp('mute', 'mute.mp4', { clip: { inMs: 500, outMs: 2000 } }))
    const error = await refused('video_join', { nodeIds: ['a', 'wide', 'mute'], requestId: 'join-0000-0002' })
    expect(error.code).toBe('VIDEO_JOIN_NEEDS_PAGE')
    expect(error.message).toMatch(/^VIDEO_JOIN_NEEDS_PAGE: .*clip 2 \(wide\) resolution.*clip 3 \(mute\) missing-audio.*open the 分镜 tab.*拼接/u)
    expect(error.body.reasons.map((reason: any) => [reason.nodeId, reason.reason])).toEqual([['wide', 'resolution'], ['mute', 'missing-audio'], ['mute', 'not-keyframe']])
    expect(await tasks.list(cwd)).toEqual([])
    expect((await readdir(join(cwd, 'film', 'canvas', 'media'))).sort()).toEqual(['mute.mp4', 'src.mp4', 'wide.mp4'])
    // With the page open, the person joins them right there.
    openPage((await savedBoard()).nodes)
    expect((await refused('video_join', { nodeIds: ['a', 'wide'], requestId: 'join-0000-0003' })).message).toMatch(/on the open 分镜 tab/u)
  })

  it('refuses fewer than two clips and anything but video nodes with film files', async () => {
    await onBoard(mediaNodeOp('a', 'src.mp4'), mediaNodeOp('music', 'theme.m4a', {}, { nodeType: 'audio' }), mediaNodeOp('linked', 'src.mp4', { content: 'blob:abc' }))
    expect((await refused('video_join', { nodeIds: ['a'], requestId: 'join-0000-0004' })).code).toBe('CANVAS_CLIP_INVALID')
    expect((await refused('video_join', { nodeIds: ['a', 'music'], requestId: 'join-0000-0005' })).code).toBe('CANVAS_CLIP_TARGET')
    expect((await refused('video_join', { nodeIds: ['a', 'linked'], requestId: 'join-0000-0006' })).message).toMatch(/CANVAS_CLIP_TARGET: .*not a file of this film/u)
    expect((await refused('video_join', { nodeIds: ['a', 'gone'], requestId: 'join-0000-0007' })).code).toBe('CANVAS_NODE_NOT_FOUND')
  })
})

describe('video_extract_audio', () => {
  it('copies the sound of a marked video into an audio node beside it', async () => {
    await writeFixture(media('src.mp4'), { frames: 50 })
    await onBoard(mediaNodeOp('shot', 'src.mp4', { clip: { inMs: 500, outMs: 1500 } }))
    const started = await run('video_extract_audio', { nodeId: 'shot', expectedContent: url('src.mp4'), requestId: 'sound-0000-0001' })
    expect(started).toMatchObject({ taskId: expect.any(String), clip: { inMs: 500, outMs: 1500 } })
    const task = await finished(started.taskId)
    expect(task).toMatchObject({ status: 'done', file: { kind: 'audio', mime: 'audio/mp4' } })
    expect(task.file.name).toMatch(/^canvas\/media\/extract-[0-9a-f]{10}\.m4a$/u)
    const landed = await savedNode(task.file.landedNodeId)
    expect(landed).toMatchObject({ type: 'audio', title: '镜头 · 音频', position: { x: 516, y: 50 }, metadata: { mimeType: 'audio/mp4', derivedFrom: { op: 'extract-audio', sources: [{ nodeId: 'shot', inMs: 500 }] } } })
    expect(landed.metadata.prompt).toBeUndefined()
  })

  it('answers VIDEO_NO_AUDIO_TRACK for a silent video, and refuses a node that changed', async () => {
    await writeFixture(media('mute.mp4'), { audio: false })
    await onBoard(mediaNodeOp('mute', 'mute.mp4'))
    expect((await refused('video_extract_audio', { nodeId: 'mute', expectedContent: url('mute.mp4'), requestId: 'sound-0000-0002' })).message).toMatch(/^VIDEO_NO_AUDIO_TRACK: 这个视频没有音轨。/u)
    expect((await refused('video_extract_audio', { nodeId: 'mute', expectedContent: 'stale', requestId: 'sound-0000-0003' })).code).toBe('CANVAS_CLIP_TARGET_CHANGED')
    expect(await tasks.list(cwd)).toEqual([])
  })
})

describe('media_cancel_task on an edit', () => {
  it('leaves a finished edit done, with its node on the board', async () => {
    await writeFixture(media('src.mp4'), { frames: 50 })
    await onBoard(mediaNodeOp('shot', 'src.mp4', { clip: { inMs: 0, outMs: 1000 } }))
    const started = await run('video_render_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), requestId: 'render-0000-0009' })
    const task = await finished(started.taskId)
    expect(await run('media_cancel_task', { taskId: started.taskId })).toMatchObject({ status: 'done', file: { landedNodeId: task.file.landedNodeId } })
    expect(await savedNode(task.file.landedNodeId)).toBeDefined()
  })
})
