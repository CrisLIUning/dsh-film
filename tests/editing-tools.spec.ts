/**
 * The cutting tools (C12, group 'editing'), called the way the agent loop
 * calls them: marks and splits on the saved board or the open page, renders,
 * joins and sound copies as Host film tasks that land their results, and the
 * subtitle tools reading and writing a video node's cues as the page does.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filmAgentTools } from '../src/agent/index.js'
import type { FilmToolServices } from '../src/agent/index.js'
import { filmProjectTool } from '../src/agent/project-tool.js'
import { callStudio } from '../src/agent/studio-client.js'
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
let studio: ReturnType<typeof createStudioRouter>
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
  studio = createStudioRouter({ events, boardAgent, tasks })
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
    // The task view keeps the sources as the landed node records them, without the request id, engine and version.
    expect(task.file.derivedFrom).toEqual({ op: 'cut', sources: landed.metadata.derivedFrom.sources })
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
    expect(task.file.derivedFrom).toEqual({ op: 'join', sources: landed.metadata.derivedFrom.sources })
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
    expect(task.file.derivedFrom).toEqual({ op: 'extract-audio', sources: landed.metadata.derivedFrom.sources })
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

/** A cue id as the page makes one (nanoid 10). */
const CUE_ID = /^[A-Za-z0-9_-]{10}$/u

const DEFAULT_STYLE = { v: 1, fontScale: 5, color: '#FFFFFF', position: 'bottom', backdrop: 'shadow', maxCharsPerEntry: 35, autoResegment: true }

const SRT = '1\n00:00:01,000 --> 00:00:02,500\n有人吗\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>谁</i>\n\n3\n00:00:05,000 --> 00:00:06,000\n门开了\n'

describe('video_set_subtitles and video_get_subtitles', () => {
  it('sets cues from SubRip on the saved board as the page saves them, and reads them back in JSON and SubRip pages', async () => {
    await onBoard(mediaNodeOp('shot', 'src.mp4', { bytes: 4096, durationMs: 9000 }))
    seen.length = 0
    const set = await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), srt: SRT })
    expect(set).toMatchObject({ source: 'persisted', changed: true, nodeId: 'shot', count: 3, dropped: 0, warnings: [], resultView: 'changes', contentDigest: expect.any(String) })
    expect(set.resegmented).toBeUndefined()
    // The four fields of the page's 保存 (W5): ids of the page's shape, the style with v: 1, the save time, the media key.
    const metadata = (await savedNode('shot')).metadata
    expect(metadata.subtitleEntries.map((cue: any) => [cue.startMs, cue.endMs, cue.text])).toEqual([[1000, 2500, '有人吗'], [3000, 4000, '谁'], [5000, 6000, '门开了']])
    for (const cue of metadata.subtitleEntries) expect(cue.id).toMatch(CUE_ID)
    expect(metadata.subtitleStyle).toEqual(DEFAULT_STYLE)
    expect(new Date(metadata.subtitleUpdatedAt).toISOString()).toBe(metadata.subtitleUpdatedAt)
    expect(metadata.subtitleMediaKey).toBe(`${url('src.mp4')}|4096|9000`)
    expect(seen).toContainEqual({ type: 'story-canvas-changed', projectId: film.id, boardId: film.id })

    // Pages: JSON first, then SubRip numbered on from the page's offset, under the same digest.
    const first = await run('video_get_subtitles', { nodeId: 'shot', limit: 2 })
    expect(first).toMatchObject({
      source: 'persisted', nodeId: 'shot', timeBase: 'source', durationMs: 9000, total: 3, offset: 0, nextOffset: 2, style: DEFAULT_STYLE, mediaChanged: false,
      subtitleMediaKey: metadata.subtitleMediaKey, subtitleUpdatedAt: metadata.subtitleUpdatedAt, contentDigest: set.contentDigest,
    })
    expect(first.entries).toEqual(metadata.subtitleEntries.slice(0, 2))
    expect(first.note).toBeUndefined()
    const second = await run('video_get_subtitles', { nodeId: 'shot', format: 'srt', offset: 2, limit: 2, contentDigest: first.contentDigest })
    expect(second).toMatchObject({ total: 3, offset: 2, nextOffset: null, srt: '3\n00:00:05,000 --> 00:00:06,000\n门开了\n' })
    expect(second.entries).toBeUndefined()
    // The whole list as SubRip is the text it came from, its tags dropped.
    expect((await run('video_get_subtitles', { nodeId: 'shot', format: 'srt' })).srt).toBe(SRT.replace('<i>谁</i>', '谁'))
    expect((await refused('video_get_subtitles', { nodeId: 'shot', limit: 501 })).code).toBe('CANVAS_SUBTITLE_INVALID')
    expect((await refused('video_get_subtitles', { nodeId: 'shot', offset: -1 })).code).toBe('CANVAS_SUBTITLE_INVALID')
  })

  it('keeps the ids of the cues a rewrite keeps, writes nothing for the same cues again, and refuses an edit of a list that changed', async () => {
    await onBoard(mediaNodeOp('shot', 'src.mp4', { durationMs: 9000 }))
    const set = await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), srt: SRT })
    const before = await savedBoard()
    // The same file again: the same ids, nothing saved.
    expect(await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), srt: SRT })).toMatchObject({ changed: false, count: 3, contentDigest: set.contentDigest })
    expect((await savedBoard()).updatedAt).toBe(before.updatedAt)
    // Editing a list read back: the ids passed stay, a new cue gets one.
    const read = await run('video_get_subtitles', { nodeId: 'shot' })
    const edited = [...read.entries.slice(0, 2), { ...read.entries[2], text: '门开了。' }, { startMs: 7000, endMs: 8000, text: '进来吧' }]
    const written = await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), entries: edited, contentDigest: read.contentDigest })
    expect(written).toMatchObject({ changed: true, count: 4 })
    const cues = (await savedNode('shot')).metadata.subtitleEntries
    expect(cues.slice(0, 3).map((cue: any) => cue.id)).toEqual(read.entries.map((cue: any) => cue.id))
    expect(cues[2].text).toBe('门开了。')
    expect(cues[3].id).toMatch(CUE_ID)
    expect(new Set(cues.map((cue: any) => cue.id)).size).toBe(4)
    // That digest is spent: the same edit, or the next page of the old read, is refused and nothing changes.
    expect((await refused('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), entries: edited, contentDigest: read.contentDigest })).message)
      .toMatch(/^CANVAS_SUBTITLE_TARGET_CHANGED: .*video_get_subtitles/u)
    expect((await refused('video_get_subtitles', { nodeId: 'shot', offset: 2, contentDigest: read.contentDigest })).code).toBe('CANVAS_SUBTITLE_TARGET_CHANGED')
    expect((await savedNode('shot')).metadata.subtitleEntries).toEqual(cues)
  })

  it('reads WebVTT, splits long cues at punctuation by the node\'s style, and restyles alone without touching the cues', async () => {
    await onBoard(mediaNodeOp('shot', 'src.mp4', { durationMs: 20000 }))
    const vtt = 'WEBVTT\n\nNOTE 来自别处\n\n00:01.000 --> 00:07.000 align:start\n今天天气很好，我们去公园散步吧，然后一起去吃午饭，下午再回家休息一会儿\n'
    const style = { fontScale: 6.5, color: '#ffcc00', position: 'top', backdrop: 'box', maxCharsPerEntry: 20 }
    const set = await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), srt: vtt, style })
    expect(set).toMatchObject({ count: 2, resegmented: { from: 1, to: 2, maxCharsPerEntry: 20 } })
    let metadata = (await savedNode('shot')).metadata
    expect(metadata.subtitleEntries.map((cue: any) => [cue.startMs, cue.endMs, cue.text])).toEqual([
      [1000, 3743, '今天天气很好，我们去公园散步吧，'],
      [3743, 7000, '然后一起去吃午饭，下午再回家休息一会儿'],
    ])
    expect(metadata.subtitleStyle).toEqual({ v: 1, fontScale: 6.5, color: '#FFCC00', position: 'top', backdrop: 'box', maxCharsPerEntry: 20, autoResegment: true })
    // resegment:false keeps the cue whole; a cue list is never split unless asked.
    expect(await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), srt: vtt, resegment: false })).toMatchObject({ count: 1 })
    const long = { startMs: 0, endMs: 6000, text: '一'.repeat(50) }
    expect(await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), entries: [long] })).toMatchObject({ count: 1 })
    expect(await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), entries: [long], resegment: true })).toMatchObject({ count: 3, resegmented: { from: 1, to: 3 } })
    // Style alone: the style and the save time change; the cues and their key stay.
    metadata = (await savedNode('shot')).metadata
    const restyled = await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), style: { position: 'center', autoResegment: false } })
    expect(restyled).toMatchObject({ changed: true, count: 3 })
    const after = (await savedNode('shot')).metadata
    expect(after.subtitleStyle).toEqual({ ...metadata.subtitleStyle, position: 'center', autoResegment: false })
    expect(after.subtitleEntries).toEqual(metadata.subtitleEntries)
    expect(after.subtitleMediaKey).toBe(metadata.subtitleMediaKey)
    expect(after.subtitleUpdatedAt >= metadata.subtitleUpdatedAt).toBe(true)
    expect(await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), style: { position: 'center' } })).toMatchObject({ changed: false })
    // Values the page cannot draw are refused, not clamped.
    for (const bad of [{ fontScale: 20 }, { fontScale: 1 }, { color: 'red' }, { maxCharsPerEntry: 10 }]) {
      expect((await refused('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), style: bad })).code, JSON.stringify(bad)).toBe('CANVAS_SUBTITLE_INVALID')
    }
    expect((await savedNode('shot')).metadata.subtitleStyle).toEqual(after.subtitleStyle)
  })

  it('stores at most 5000 cues of at most 2000 characters, says what it left out, and refuses input with nothing usable', async () => {
    await onBoard(mediaNodeOp('shot', 'src.mp4', { durationMs: 6_000_000 }))
    const many = Array.from({ length: 5003 }, (_, index) => ({ startMs: index * 1000, endMs: index * 1000 + 500, text: `第${index}句` }))
    const set = await run('video_set_subtitles', {
      nodeId: 'shot', expectedContent: url('src.mp4'),
      entries: [...many, { startMs: 50, endMs: 50, text: '零长' }, { startMs: 60, endMs: 900, text: '  ' }, { startMs: 70, endMs: 900, text: '字'.repeat(2005) }],
    })
    expect(set).toMatchObject({ changed: true, count: 5000, dropped: 6 })
    expect(set.warnings).toEqual([
      expect.stringMatching(/^2 cues had no usable times or text/u),
      expect.stringMatching(/^1 text ran past 2000 characters/u),
      expect.stringMatching(/^4 cues past the limit of 5000 were left out/u),
      expect.stringMatching(/^1 cue starts before an earlier cue ends/u),
    ])
    const cues = (await savedNode('shot')).metadata.subtitleEntries
    expect(cues).toHaveLength(5000)
    expect(cues[1].text).toHaveLength(2000)
    expect(cues.at(-1).text).toBe('第4998句')
    // Cues past the video's end are kept but named.
    const late = await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), entries: [{ startMs: 6_000_000, endMs: 6_001_000, text: '片尾之后' }] })
    expect(late.warnings).toEqual([expect.stringContaining('after the end of the video (6000000 ms)')])
    // Nothing usable, nothing given, or more than one source: refused, and the cues stay.
    const kept = (await savedNode('shot')).metadata.subtitleEntries
    const shot = { nodeId: 'shot', expectedContent: url('src.mp4') }
    for (const args of [
      { entries: [{ startMs: 500, endMs: 400, text: '倒' }] },
      { entries: [] },
      { srt: '第一句\n第二句\n' },
      { srt: '1\n00:00:02,000 --> 00:00:01,000\n倒着\n' },
      { srt: SRT, entries: [{ startMs: 0, endMs: 100, text: 'a' }] },
      { srt: SRT, clear: true },
      {},
      { timeBase: 'clip', style: { position: 'top' } },
    ]) {
      expect((await refused('video_set_subtitles', { ...shot, ...args })).code, JSON.stringify(args)).toBe('CANVAS_SUBTITLE_INVALID')
    }
    expect((await refused('video_set_subtitles', { ...shot, entries: [{ startMs: 500, endMs: 400, text: '倒' }] })).message).toMatch(/None of the cues can be stored, so nothing was changed\. 1 cue had no usable times/u)
    expect((await savedNode('shot')).metadata.subtitleEntries).toEqual(kept)
  })

  it('times cues from the in point with timeBase clip and reads them back in either time', async () => {
    await onBoard(mediaNodeOp('shot', 'src.mp4', { durationMs: 6000, clip: { inMs: 2000, outMs: 5000 } }), mediaNodeOp('whole', 'src.mp4', { durationMs: 6000 }, { position: { x: 100, y: 400 } }))
    const set = await run('video_set_subtitles', {
      nodeId: 'shot', expectedContent: url('src.mp4'), timeBase: 'clip',
      entries: [{ startMs: 0, endMs: 500, text: '一' }, { startMs: 2800, endMs: 4500, text: '二' }, { startMs: 4500, endMs: 5000, text: '三' }],
    })
    expect(set).toMatchObject({ count: 2, dropped: 1, warnings: [expect.stringContaining('past the end of the file (6000 ms)')] })
    expect((await savedNode('shot')).metadata.subtitleEntries.map((cue: any) => [cue.startMs, cue.endMs, cue.text])).toEqual([[2000, 2500, '一'], [4800, 6000, '二']])
    expect((await run('video_get_subtitles', { nodeId: 'shot' })).entries.map((cue: any) => [cue.startMs, cue.endMs])).toEqual([[2000, 2500], [4800, 6000]])
    const clipped = await run('video_get_subtitles', { nodeId: 'shot', timeBase: 'clip' })
    expect(clipped).toMatchObject({ timeBase: 'clip', clip: { inMs: 2000, outMs: 5000 }, total: 2 })
    expect(clipped.entries.map((cue: any) => [cue.startMs, cue.endMs, cue.text])).toEqual([[0, 500, '一'], [2800, 3000, '二']])
    // In the file's time, cues outside the mark are kept and named: this node does not show them.
    const outside = await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), entries: [{ startMs: 100, endMs: 900, text: '片头' }, { startMs: 2500, endMs: 3000, text: '中间' }] })
    expect(outside.warnings).toEqual([expect.stringContaining('outside the node\'s in/out mark (2000–5000 ms of the file)')])
    expect((await run('video_get_subtitles', { nodeId: 'shot', timeBase: 'clip' })).entries.map((cue: any) => cue.text)).toEqual(['中间'])
    // Without a mark, clip time is the file's time.
    const whole = await run('video_set_subtitles', { nodeId: 'whole', expectedContent: url('src.mp4'), timeBase: 'clip', entries: [{ startMs: 100, endMs: 900, text: '全片' }] })
    expect(whole.warnings).toEqual([expect.stringContaining('no in/out mark')])
    expect(await run('video_get_subtitles', { nodeId: 'whole', timeBase: 'clip' })).toMatchObject({ clip: null, total: 1, note: expect.stringContaining('no in/out mark') })
  })

  it('clears the cues with null, keeping the style, and clearing again changes nothing', async () => {
    await onBoard(mediaNodeOp('shot', 'src.mp4', { durationMs: 6000 }))
    await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), entries: [{ startMs: 0, endMs: 1000, text: '一' }], style: { position: 'top' } })
    expect(await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), clear: true })).toMatchObject({ changed: true, count: 0 })
    const metadata = (await savedNode('shot')).metadata
    expect(metadata).toMatchObject({ subtitleEntries: null, subtitleMediaKey: null, subtitleStyle: { ...DEFAULT_STYLE, position: 'top' } })
    const read = await run('video_get_subtitles', { nodeId: 'shot' })
    expect(read).toMatchObject({ total: 0, entries: [], mediaChanged: false, style: { position: 'top' } })
    expect(read.subtitleMediaKey).toBeUndefined()
    expect(await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), clear: true })).toMatchObject({ changed: false })
  })

  it('refuses a node that is not a video with a file, one that changed or is generating, and a missing one', async () => {
    await onBoard(
      mediaNodeOp('shot', 'src.mp4', { durationMs: 3000 }),
      mediaNodeOp('busy', 'src.mp4', { durationMs: 3000, status: 'loading' }),
      mediaNodeOp('music', 'theme.m4a', { mimeType: 'audio/mp4' }, { nodeType: 'audio' }),
      mediaNodeOp('empty', 'src.mp4', { content: '' }),
      { type: 'add_node', id: 'note', nodeType: 'text', metadata: { content: '镜 1' } },
    )
    const cues = { entries: [{ startMs: 0, endMs: 1000, text: '一' }] }
    expect((await refused('video_set_subtitles', { nodeId: 'shot', expectedContent: url('other.mp4'), ...cues })).message).toMatch(/^CANVAS_SUBTITLE_TARGET_CHANGED: shot changed/u)
    expect((await refused('video_set_subtitles', { nodeId: 'busy', expectedContent: url('src.mp4'), ...cues })).code).toBe('CANVAS_SUBTITLE_TARGET_CHANGED')
    expect((await refused('video_set_subtitles', { nodeId: 'music', expectedContent: url('theme.m4a'), ...cues })).message).toMatch(/^CANVAS_SUBTITLE_TARGET: music is not a video node/u)
    expect((await refused('video_set_subtitles', { nodeId: 'empty', expectedContent: '', ...cues })).code).toBe('CANVAS_SUBTITLE_TARGET')
    expect((await refused('video_set_subtitles', { nodeId: 'note', expectedContent: '镜 1', ...cues })).code).toBe('CANVAS_SUBTITLE_TARGET')
    expect((await refused('video_set_subtitles', { nodeId: 'gone', expectedContent: '', ...cues })).code).toBe('CANVAS_NODE_NOT_FOUND')
    expect((await refused('video_get_subtitles', { nodeId: 'music' })).code).toBe('CANVAS_SUBTITLE_TARGET')
    await expect(run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), entries: [{ startMs: 0.5, endMs: 900, text: 'x' }] })).rejects.toThrow(/integer/u)
    for (const id of ['shot', 'busy']) expect((await savedNode(id)).metadata.subtitleEntries, id).toBeUndefined()
  })

  it('flags cues saved against another video by the page\'s tolerant rule, and reads cues landed without a key or style', async () => {
    const cues = [{ id: 'line000001', startMs: 0, endMs: 800, text: '有人吗' }]
    const key = `${url('src.mp4')}|4096|9000`
    const saved = (id: string, file: string, metadata: Record<string, unknown>, y: number): BoardOp => mediaNodeOp(id, file, { subtitleEntries: cues, subtitleMediaKey: key, ...metadata }, { position: { x: 100, y } })
    await onBoard(
      saved('same', 'src.mp4', { bytes: 4096, durationMs: 9250 }, 0),
      saved('longer', 'src.mp4', { bytes: 4096, durationMs: 9300 }, 300),
      saved('resized', 'src.mp4', { bytes: 5000, durationMs: 9000 }, 600),
      saved('sizeless', 'src.mp4', { durationMs: 9000 }, 900),
      saved('replaced', 'other.mp4', { bytes: 4096, durationMs: 9000 }, 1200),
      // A cut an older Host landed, or a split from before: cues only, not yet cleaned.
      mediaNodeOp('landed', 'clip.mp4', { subtitleEntries: [{ startMs: 0, endMs: 800, text: '  无 id 的字幕 ' }, { startMs: 'x' }] }, { position: { x: 100, y: 1500 } }),
    )
    const changed: Record<string, boolean> = {}
    for (const id of ['same', 'longer', 'resized', 'sizeless', 'replaced', 'landed']) changed[id] = (await run('video_get_subtitles', { nodeId: id })).mediaChanged
    expect(changed).toEqual({ same: false, longer: true, resized: true, sizeless: false, replaced: true, landed: false })
    expect((await run('video_get_subtitles', { nodeId: 'longer' })).note).toMatch(/^mediaChanged: /u)
    const landed = await run('video_get_subtitles', { nodeId: 'landed' })
    expect(landed).toMatchObject({ total: 1, style: DEFAULT_STYLE, mediaChanged: false })
    expect(landed.entries).toEqual([{ id: expect.stringMatching(CUE_ID), startMs: 0, endMs: 800, text: '无 id 的字幕' }])
    expect(landed.subtitleMediaKey).toBeUndefined()
    expect((await run('video_get_subtitles', { nodeId: 'landed' })).entries[0].id).toBe(landed.entries[0].id)
    // Saving the cues again keys them to the video the node shows now.
    const longer = await run('video_get_subtitles', { nodeId: 'longer' })
    await run('video_set_subtitles', { nodeId: 'longer', expectedContent: url('src.mp4'), entries: longer.entries, contentDigest: longer.contentDigest })
    expect(await run('video_get_subtitles', { nodeId: 'longer' })).toMatchObject({ mediaChanged: false, subtitleMediaKey: `${url('src.mp4')}|4096|9300` })
    expect((await savedNode('longer')).metadata.subtitleEntries).toEqual(cues)
  })

  it('writes through the open page with one update_node of the four fields, and reads the page\'s board', async () => {
    const page = openPage([nodeOf(mediaNodeOp('shot', 'src.mp4', { bytes: 2048, durationMs: 3000 }))])
    const set = await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), entries: [{ startMs: 0, endMs: 1000, text: '页面上' }] })
    expect(set).toMatchObject({ source: 'live', target: page.target, changed: true, count: 1 })
    expect(page.calls()).toEqual([expect.objectContaining({ name: 'canvas_apply_ops', input: expect.objectContaining({ boardId: film.id, project: film.id }) })])
    expect(page.calls()[0].input.ops).toEqual([{
      type: 'update_node', id: 'shot',
      metadata: {
        subtitleEntries: [{ id: expect.stringMatching(CUE_ID), startMs: 0, endMs: 1000, text: '页面上' }],
        subtitleStyle: DEFAULT_STYLE, subtitleUpdatedAt: expect.any(String), subtitleMediaKey: `${url('src.mp4')}|2048|3000`,
      },
    }])
    expect((await savedBoard()).nodes).toEqual([])
    expect(await run('video_get_subtitles', { nodeId: 'shot' })).toMatchObject({ source: 'live', target: page.target, total: 1, contentDigest: set.contentDigest })
    // Cleared on the page: nulls, which the page reads as none.
    await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), clear: true })
    expect(page.calls()[1].input.ops[0].metadata).toEqual({ subtitleEntries: null, subtitleStyle: DEFAULT_STYLE, subtitleUpdatedAt: expect.any(String), subtitleMediaKey: null })
    expect(page.board().nodes![0]!.metadata!.subtitleEntries).toBeNull()
  })

  it('leaves a page\'s save of the board it loaded before the agent wrote to the merge, which refuses the overlap at the node\'s cues', async () => {
    await onBoard(mediaNodeOp('shot', 'src.mp4', { durationMs: 6000 }), { type: 'add_node', id: 'note', nodeType: 'text', metadata: { content: '镜 1' } })
    const loaded = await savedBoard()
    await run('video_set_subtitles', { nodeId: 'shot', expectedContent: url('src.mp4'), entries: [{ startMs: 0, endMs: 1000, text: 'Agent 写的' }] })
    const merge = (document: unknown): Promise<unknown> => callStudio(studio, cwd, { method: 'POST', path: `/api/canvas/documents/${film.id}/merge?project=${film.id}`, body: { base: loaded, document } })
    const edit = (id: string, metadata: Record<string, unknown>): unknown => ({ ...loaded, nodes: loaded.nodes.map((node: any) => node.id === id ? { ...node, metadata: { ...node.metadata, ...metadata } } : node) })
    // The page edited the same node's cues meanwhile: both are kept apart, nothing is written.
    const conflict: any = await merge(edit('shot', { subtitleEntries: [{ id: 'page000001', startMs: 0, endMs: 1200, text: '页面写的' }], subtitleUpdatedAt: '2026-10-05T00:00:00.000Z' }))
      .then(() => { throw new Error('merged') }, (error: unknown) => error)
    expect(conflict.code).toBe('CANVAS_MERGE_CONFLICT')
    expect(conflict.body.paths).toContain('nodes.shot.metadata.subtitleEntries')
    expect((await savedNode('shot')).metadata.subtitleEntries.map((cue: any) => cue.text)).toEqual(['Agent 写的'])
    // An edit of another node merges, and the agent's cues stay.
    await merge(edit('note', { content: '镜 1（改）' }))
    expect((await savedNode('note')).metadata.content).toBe('镜 1（改）')
    expect((await savedNode('shot')).metadata).toMatchObject({ subtitleEntries: [{ text: 'Agent 写的' }], subtitleStyle: DEFAULT_STYLE })
  })

  it('lands cuts and joins with the cues\' style and a key for the new file, and gives split siblings the source\'s', async () => {
    await writeFixture(media('src.mp4'), { frames: 75 })
    await writeFixture(media('b.mp4'), { frames: 50 })
    await onBoard(mediaNodeOp('shot', 'src.mp4', { clip: { inMs: 1000, outMs: 2000 } }), mediaNodeOp('second', 'b.mp4', {}, { position: { x: 100, y: 400 } }))
    const style = { v: 1, fontScale: 7, color: '#FF0000', position: 'top', backdrop: 'box', maxCharsPerEntry: 30, autoResegment: false }
    await run('video_set_subtitles', {
      nodeId: 'shot', expectedContent: url('src.mp4'), entries: [{ startMs: 900, endMs: 1500, text: '有人吗' }],
      style: { fontScale: 7, color: '#ff0000', position: 'top', backdrop: 'box', maxCharsPerEntry: 30, autoResegment: false },
    })
    const source = (await savedNode('shot')).metadata
    expect(source.subtitleMediaKey).toBe(`${url('src.mp4')}||`)
    const keyOf = (metadata: any): string => `${metadata.content}|${metadata.bytes}|${metadata.durationMs}`

    const rendered = await finished((await run('video_render_clip', { nodeId: 'shot', expectedContent: url('src.mp4'), requestId: 'render-subs-0001' })).taskId)
    const cut = await savedNode(rendered.file.landedNodeId)
    expect(cut.metadata).toMatchObject({ subtitleEntries: [{ id: source.subtitleEntries[0].id, startMs: 0, endMs: 500, text: '有人吗' }], subtitleStyle: style })
    expect(typeof cut.metadata.bytes).toBe('number')
    expect(cut.metadata.subtitleMediaKey).toBe(keyOf(cut.metadata))
    expect(cut.metadata.subtitleUpdatedAt > source.subtitleUpdatedAt).toBe(true)
    expect(await run('video_get_subtitles', { nodeId: cut.id })).toMatchObject({ total: 1, style, mediaChanged: false })

    const joinedTask = await finished((await run('video_join', { nodeIds: ['second', 'shot'], requestId: 'join-subs-0001' })).taskId)
    expect(joinedTask.status).toBe('done')
    const joined = await savedNode(joinedTask.file.landedNodeId)
    const at = joined.metadata.derivedFrom.sources[1].atMs as number
    expect(joined.metadata).toMatchObject({ subtitleEntries: [{ startMs: at, endMs: at + 500, text: '有人吗' }], subtitleStyle: style })
    expect(joined.metadata.subtitleMediaKey).toBe(keyOf(joined.metadata))
    expect((await run('video_get_subtitles', { nodeId: joined.id })).mediaChanged).toBe(false)

    // A split sibling shows the same file: the source's style, save time and key.
    const split = await run('video_split', { nodeId: 'shot', expectedContent: url('src.mp4'), atMs: 1200 })
    const sibling = await savedNode(split.newNodeId)
    expect(sibling.metadata).toMatchObject({
      subtitleEntries: source.subtitleEntries, subtitleStyle: style, subtitleUpdatedAt: source.subtitleUpdatedAt, subtitleMediaKey: source.subtitleMediaKey,
    })
    expect((await run('video_get_subtitles', { nodeId: split.newNodeId })).mediaChanged).toBe(false)
    expect((await run('video_get_subtitles', { nodeId: 'shot' })).mediaChanged).toBe(false)
  })
})
