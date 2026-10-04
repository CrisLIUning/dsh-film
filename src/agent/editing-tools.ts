/**
 * The storyboard's cutting tools — the `editing` tool group (C12): mark,
 * split, render, join and copy the sound of the board's video nodes.
 *
 * Marks and splits are board edits in the board's own vocabulary
 * (`update_node`, `add_node`, `connect_nodes`): with a storyboard page open
 * they go to it as ops, so the person watches them happen and can undo them;
 * with none open they are saved to the board through its writer, the node
 * checked against `expectedContent` again under the board's lock. Clip marks
 * follow C1 (`clip = { inMs, outMs }`, whole ms in the node's file, `null`
 * when cleared — amendments C.8), by the page's own rules (canvas/clip-marks).
 *
 * Renders, joins and sound copies are the Host's lossless media edits
 * (C9/C10, studio/media-edit-routes): the tool answers with the film task at
 * once, `media_get_task` follows it and `media_cancel_task` stops it, and the
 * Host lands the result right of its source with an edge back (`derivedFrom`,
 * and `workflowKind: 'final'` / `videoEditOperation: 'concat'` on a join) —
 * page open or not, since an open page merges the saved board in. Nothing
 * here re-encodes or generates: what the Host cannot copy needs the 分镜 tab,
 * which re-encodes in the page (VIDEO_JOIN_NEEDS_PAGE for a join).
 * @module dsh-film/agent/editing-tools
 */

import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BoardPage } from '../canvas/board-agent.js'
import { derivedNodePosition } from '../canvas/board-media.js'
import { applyBoardOps } from '../canvas/board-ops.js'
import type { BoardNode, BoardOp, BoardSnapshot } from '../canvas/board-ops.js'
import { CanvasToolError, mutationReceipt, snapshotOfDocument } from '../canvas/board-tools.js'
import { MIN_CLIP_MS, readClip, siblingMetadata, splitClip, storedClip } from '../canvas/clip-marks.js'
import type { ClipMark } from '../canvas/clip-marks.js'
import { CanvasDocumentStore } from '../canvas/documents.js'
import { filmUrlOf } from '../media/tasks.js'
import { guarded } from './canvas-tools.js'
import { filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices, FilmWorkspace } from './context.js'
import { FilmToolError, callStudio } from './studio-client.js'

/** The group's line in film_tools (C12; the subtitle tools add theirs when they land). */
export const EDITING_GROUP_DESCRIPTION = 'Cut, split, render, join and extract the sound of video nodes (video_*). Only cutting and joining: no transitions, music or effects.'

const PAGE_CLOSED_NOTE = 'No storyboard page is open: the edit is saved to the board and appears when the 分镜 tab opens.'

const TASK_NOTE = 'Started as a film task: read it with media_get_task until status is done (or failed/interrupted), then report file.landedNodeId — the new node right of '
  + 'the source with an edge back — not the request. The same requestId again answers with this task and makes no second file.'

const target = {
  type: 'object',
  additionalProperties: false,
  description: 'One page from canvas_list_clients, to address that page. Omit it: the newest page showing this film\'s board answers, or the saved board when none is open.',
  properties: {
    projectId: { type: 'string', required: true },
    clientId: { type: 'string', required: true },
    incarnation: { type: 'string', required: true },
  },
} as const

const expectedContent = {
  type: 'string',
  required: true,
  description: 'The node\'s metadata.content (its file URL) exactly as just read with canvas_get_state or canvas_read_node; a node that changed meanwhile or is generating is refused.',
} as const

const requestId = {
  type: 'string',
  required: true,
  description: 'A new id of your own for this edit (8–80 letters, digits, - or _; a UUID works). Retrying with the same id answers with the same task.',
} as const

/** Where a new node goes beside one it comes from (the derived-node gap). */
const DERIVED_GAP = 96

type MediaKind = 'video' | 'audio'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

const invalid = (message: string): CanvasToolError => new CanvasToolError('CANVAS_CLIP_INVALID', message)

const sameClip = (left: ClipMark | null, right: ClipMark | null): boolean =>
  left === right || (left !== null && right !== null && left.inMs === right.inMs && left.outMs === right.outMs)

/**
 * A node of the board that holds a file of one of these kinds.
 * @param snapshot - the board.
 * @param nodeId - the node.
 * @param kinds - the node types accepted.
 * @returns the node.
 */
function mediaNode(snapshot: BoardSnapshot | null, nodeId: string, kinds: readonly MediaKind[]): BoardNode {
  const node = snapshot?.nodes?.find(item => item.id === nodeId)
  if (node === undefined) throw new CanvasToolError('CANVAS_NODE_NOT_FOUND', `The board has no node ${nodeId}. Re-read canvas_get_state.`)
  const content = node.metadata?.content
  if (!(kinds as readonly string[]).includes(node.type) || typeof content !== 'string' || content.trim() === '') {
    throw new CanvasToolError('CANVAS_CLIP_TARGET', `${nodeId} is not a ${kinds.join(' or ')} node with a file (it is a ${node.type} node${typeof content === 'string' && content.trim() !== '' ? '' : ' without a file'}).`)
  }
  return node
}

/** Refuse a node whose file changed since it was read, or that is generating. */
function expectContent(node: BoardNode, expected: string): void {
  if (node.metadata?.content !== expected || node.metadata?.status === 'loading') {
    throw new CanvasToolError('CANVAS_CLIP_TARGET_CHANGED', `${node.id} changed or is generating. Read it again (canvas_get_state, or canvas_read_node field content) and pass its current content as expectedContent.`)
  }
}

/** The film-relative path of a node's file, when it is a file of the film (its raw URL). */
function filmPathOf(node: BoardNode): string | undefined {
  const content = node.metadata?.content
  const url = typeof content === 'string' ? filmUrlOf(content) : undefined
  return url?.kind === 'raw' ? url.path : undefined
}

/** The film path of a node the Host is to read, or a refusal that says why it cannot. */
function hostPathOf(node: BoardNode): string {
  const path = filmPathOf(node)
  if (path === undefined) {
    throw new CanvasToolError('CANVAS_CLIP_TARGET', `${node.id}'s file is not a file of this film (it may be kept only in the browser or be a link), so the Host cannot copy from it. `
      + 'Ask the person to work on it in the 分镜 tab.')
  }
  return path
}

/** A node's title for the names of what is made from it. */
const nameOf = (node: BoardNode): string => typeof node.title === 'string' && node.title.trim() !== '' ? node.title.trim() : node.type === 'audio' ? '音频' : '视频'

/** The reasons a refusal of the media edit routes carries, as the routes give them. */
function reasonsOf(error: FilmToolError): Array<{ index: number; reason: string; detail: string }> {
  const reasons = error.body?.reasons
  return Array.isArray(reasons)
    ? reasons.filter((entry): entry is { index: number; reason: string; detail: string } => isRecord(entry) && typeof entry.index === 'number' && typeof entry.reason === 'string')
      .map(entry => ({ index: entry.index, reason: entry.reason, detail: typeof entry.detail === 'string' ? entry.detail : '' }))
    : []
}

/**
 * Build the cutting tools.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function editingTools(services: FilmToolServices): ToolDefinition[] {
  const store = (film: FilmWorkspace): CanvasDocumentStore => new CanvasDocumentStore(film.cwd, film.projectId)

  /** The open page to work with, or the saved board when none is. */
  const board = async (film: FilmWorkspace, chosen: unknown): Promise<{ page?: BoardPage; snapshot: BoardSnapshot | null }> => {
    const page = services.boardAgent.choose({ projectId: film.projectId, boardId: film.boardId, ...(chosen !== undefined ? { target: chosen } : {}) })
    if (page !== undefined) return { page, snapshot: page.snapshot as BoardSnapshot }
    const document = await store(film).read(film.boardId)
    return { snapshot: document === null ? null : snapshotOfDocument(document) }
  }

  const where = (page: BoardPage | undefined): Record<string, unknown> => page !== undefined
    ? { source: 'live', target: page.target }
    : { source: 'persisted', note: PAGE_CLOSED_NOTE }

  /** A media edit route of this film's board. */
  const editPath = (film: FilmWorkspace, operation: 'probe' | 'cut' | 'join' | 'extract-audio'): string =>
    `/api/canvas/video/${segment(film.boardId)}/${operation}?project=${segment(film.projectId)}`

  /** A node's file length: as the node records it, else read by the Host. */
  const lengthOf = async (film: FilmWorkspace, node: BoardNode, signal: AbortSignal | undefined): Promise<number> => {
    const known = node.metadata?.durationMs
    if (positive(known)) return Math.round(known)
    const path = filmPathOf(node)
    if (path === undefined) {
      throw new CanvasToolError('CANVAS_CLIP_TARGET', `${node.id}'s length is not recorded and its file is not a file of this film, so it cannot be marked here. Ask the person to mark it in the 分镜 tab.`)
    }
    const probe = await callStudio(services.studio, film.cwd, { method: 'POST', path: editPath(film, 'probe'), body: { paths: [path] } }, signal)
    const item = Array.isArray(probe.items) ? probe.items[0] : undefined
    const duration = isRecord(item) && item.ok === true ? item.durationMs : undefined
    if (!positive(duration)) throw new CanvasToolError('CANVAS_CLIP_TARGET', `${path} cannot be read as video or audio, so its length is unknown.`)
    return Math.round(duration)
  }

  /**
   * Apply a board edit built from the node as read: on the open page as ops,
   * or on the saved board under its lock, where `build` checks the node again.
   * @returns the write's receipt.
   */
  const applyEdit = async (film: FilmWorkspace, page: BoardPage | undefined, snapshot: BoardSnapshot, build: (board: BoardSnapshot) => BoardOp[], signal: AbortSignal | undefined): Promise<Record<string, unknown>> => {
    if (page !== undefined) {
      const result = await services.boardAgent.call(page.target, 'canvas_apply_ops', { ops: build(snapshot), boardId: film.boardId, project: film.projectId }, { signal })
      const receipt = mutationReceipt(snapshot, result)
      return isRecord(receipt) ? receipt : { result: receipt }
    }
    let before: BoardSnapshot | null = null
    let after: BoardSnapshot | null = null
    await store(film).update((current) => {
      if (current === null) throw new CanvasToolError('CANVAS_NODE_NOT_FOUND', 'This film\'s board has no nodes yet. Re-read canvas_get_state.')
      if (current.id !== film.boardId) {
        throw new CanvasToolError('CANVAS_BOARD_MISMATCH', `The saved board (${current.id}) is not this film's board (${film.boardId}); open the 分镜 tab to repair it.`)
      }
      before = snapshotOfDocument(current)
      after = applyBoardOps(before, build(before))
      return { ...current, nodes: after.nodes ?? [], connections: after.connections ?? [], updatedAt: new Date().toISOString() }
    })
    services.events.emit(film.cwd, { type: 'story-canvas-changed', projectId: film.projectId, boardId: film.boardId })
    const receipt = mutationReceipt(before, after)
    return isRecord(receipt) ? receipt : {}
  }

  /** Start one of the Host's media edits, landing its result beside its source; a copy the Host cannot make is explained. */
  const startEdit = async (film: FilmWorkspace, operation: 'cut' | 'join' | 'extract-audio', body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<{ taskId: unknown; status: unknown }> => {
    try {
      const started = await callStudio(services.studio, film.cwd, { method: 'POST', path: editPath(film, operation), body }, signal)
      return { taskId: started.taskId, status: started.status }
    } catch (error) {
      if (error instanceof FilmToolError && error.code === 'MEDIA_EDIT_NEEDS_TRANSCODE') {
        const reasons = reasonsOf(error)
        throw new FilmToolError(error.code, `The Host copies without re-encoding and cannot copy this file (${reasons.map(reason => `${reason.reason}: ${reason.detail}`).join('; ') || error.message}). `
          + `Re-encoding runs only in the 分镜 tab: ask the person to use ${operation === 'cut' ? '出片' : '分离音频'} on the node there. Nothing was started.`, error.body)
      }
      throw error
    }
  }

  return [
    defineTool({
      name: 'video_clip',
      description: 'Set or clear the in/out mark of a video or audio node: the part of its file the node stands for. The file is not touched and nothing is generated. '
        + 'The 分镜 page plays only the marked part of a video and shows it as an unrendered cut (未渲染裁剪); whatever uses the node — a generation reference, a '
        + 'download, an asset — gets that part rendered first, never the whole file. Times are whole ms in the node\'s file, not in its current mark. With the 分镜 '
        + 'tab open the edit runs in the page (live, undoable); with it closed it is saved to the board. A mark covering the whole file is stored as none (null).',
      parameters: {
        target,
        nodeId: { type: 'string', required: true, description: 'A video or audio node with a file, from canvas_get_state.' },
        expectedContent,
        inMs: { type: 'integer', description: 'Where the mark starts in the file (ms). Omit to keep the current start (0 without a mark).' },
        outMs: { type: 'integer', description: 'Where it ends (ms; at most the file\'s length, at least 100 ms after inMs). Omit to keep the current end (the file\'s end without a mark).' },
        clear: { type: 'boolean', description: 'true removes the mark (stored as null). Pass it alone.' },
      },
      output: jsonOutput,
      execute: (args, exec) => guarded(async () => {
        const clear = args.clear === true
        if (clear && (args.inMs !== undefined || args.outMs !== undefined)) throw invalid('Pass clear:true alone, or inMs/outMs to set the mark.')
        if (!clear && args.inMs === undefined && args.outMs === undefined) throw invalid('Pass inMs and/or outMs to set the mark, or clear:true to remove it.')
        const film = await filmWorkspace(exec)
        const { page, snapshot } = await board(film, args.target)
        const node = mediaNode(snapshot, args.nodeId, ['video', 'audio'])
        expectContent(node, args.expectedContent)
        const durationMs = clear ? undefined : await lengthOf(film, node, exec.signal)
        /** The mark to store on the node as it is (an edge left out keeps the node's current one). */
        const plan = (source: BoardNode): { next: ClipMark | null; recordLength: boolean; unchanged: boolean } => {
          let next: ClipMark | null = null
          if (durationMs !== undefined) {
            const current = readClip(source.metadata, durationMs) ?? { inMs: 0, outMs: durationMs }
            const inMs = args.inMs ?? current.inMs
            const outMs = args.outMs ?? current.outMs
            if (inMs < 0 || outMs > durationMs || outMs - inMs < MIN_CLIP_MS) {
              throw invalid(`A mark lies inside the file (0–${durationMs} ms) and is at least ${MIN_CLIP_MS} ms long; ${inMs}–${outMs} ms is not.`)
            }
            next = storedClip({ inMs, outMs }, durationMs)
          }
          const recordLength = durationMs !== undefined && source.metadata?.durationMs !== durationMs
          const stored = source.metadata?.clip
          const unchanged = sameClip(readClip(source.metadata, durationMs) ?? null, next) && !recordLength && (next !== null || stored === undefined || stored === null)
          return { next, recordLength, unchanged }
        }
        let planned = plan(node)
        const facts = (): Record<string, unknown> => ({ nodeId: node.id, clip: planned.next, ...(durationMs !== undefined ? { durationMs } : {}) })
        if (planned.unchanged) return plain({ ...where(page), changed: false, ...facts() })
        const receipt = await applyEdit(film, page, snapshot!, (current) => {
          // On the saved board this runs under its lock: the node as it is now.
          const source = mediaNode(current, node.id, ['video', 'audio'])
          expectContent(source, args.expectedContent)
          planned = plan(source)
          return [{ type: 'update_node', id: node.id, metadata: { clip: planned.next, ...(planned.recordLength ? { durationMs } : {}) } }]
        }, exec.signal)
        return plain({
          ...where(page), ...receipt, changed: true, ...facts(),
          ...(planned.next === null && !clear ? { note: 'The mark covers the whole file, so it is stored as none.' } : {}),
        })
      }),
    }),
    defineTool({
      name: 'video_split',
      description: 'Split a video node in two at atMs (ms in its file): the node keeps the part before, and a new node right of it — the same file, marked with the '
        + 'part after, with an edge from the original — takes the rest; each part keeps the subtitle cues and director shots that overlap it. atMs must be at least '
        + '100 ms inside the part the node plays. Nothing is rendered or generated (video_render_clip renders a part). With the 分镜 tab open it runs in the page '
        + '(live, undoable); with it closed it is saved to the board. Returns newNodeId.',
      parameters: {
        target,
        nodeId: { type: 'string', required: true, description: 'A video node with a file, from canvas_get_state.' },
        expectedContent,
        atMs: { type: 'integer', required: true, description: 'Where to split, in ms of the node\'s file.' },
      },
      output: jsonOutput,
      execute: (args, exec) => guarded(async () => {
        const film = await filmWorkspace(exec)
        const { page, snapshot } = await board(film, args.target)
        const node = mediaNode(snapshot, args.nodeId, ['video'])
        expectContent(node, args.expectedContent)
        const durationMs = await lengthOf(film, node, exec.signal)
        /** The two parts of the node as it is: [in, at] stays, [at, out] goes to the sibling. */
        const partsOf = (source: BoardNode): [ClipMark, ClipMark] => {
          const range = readClip(source.metadata, durationMs) ?? { inMs: 0, outMs: durationMs }
          const parts = splitClip(range, args.atMs)
          if (parts === null) throw invalid(`atMs must be at least ${MIN_CLIP_MS} ms inside the part the node plays (${range.inMs}–${range.outMs} ms of its file); ${args.atMs} is not.`)
          return parts
        }
        let [kept, rest] = partsOf(node)
        const newNodeId = `video-${randomUUID()}`
        const receipt = await applyEdit(film, page, snapshot!, (current) => {
          // On the saved board this runs under its lock: the node as it is now.
          const source = mediaNode(current, node.id, ['video'])
          expectContent(source, args.expectedContent)
          ;[kept, rest] = partsOf(source)
          const size = { width: positive(source.width) ? source.width : 420, height: positive(source.height) ? source.height : 236 }
          const position = derivedNodePosition(current.nodes ?? [], source.id, size) ?? { x: source.position.x + size.width + DERIVED_GAP, y: source.position.y }
          return [
            { type: 'update_node', id: source.id, metadata: { clip: storedClip(kept, durationMs), durationMs } },
            {
              type: 'add_node', id: newNodeId, nodeType: 'video', title: `${nameOf(source)}（后段）`, position, ...size,
              metadata: siblingMetadata({ ...source.metadata, durationMs }, storedClip(rest, durationMs) ?? rest),
            },
            { type: 'connect_nodes', id: `derived:${newNodeId}:${source.id}`, fromNodeId: source.id, toNodeId: newNodeId },
          ]
        }, exec.signal)
        return plain({ ...where(page), ...receipt, nodeId: node.id, newNodeId, clips: { [node.id]: kept, [newNodeId]: rest }, durationMs })
      }),
    }),
    defineTool({
      name: 'video_render_clip',
      description: 'Render a node\'s mark into a file of its own (a cut): the Host copies the marked part of the video or audio file without re-encoding into '
        + 'film/canvas/media/clip-…, and puts it on the board as a new node right of the source with an edge back, carrying the source\'s prompt and the subtitle '
        + 'cues and director shots of that part, moved to the new file\'s time. Works with the 分镜 tab open or closed. Answers at once with a film task: follow it '
        + 'with media_get_task (file.landedNodeId is the new node). CANVAS_CLIP_NONE: the node has no mark — set one with video_clip first.',
      parameters: {
        nodeId: { type: 'string', required: true, description: 'A marked video or audio node, from canvas_get_state.' },
        expectedContent,
        requestId,
      },
      output: jsonOutput,
      execute: (args, exec) => guarded(async () => {
        const film = await filmWorkspace(exec)
        const { snapshot } = await board(film, undefined)
        const node = mediaNode(snapshot, args.nodeId, ['video', 'audio'])
        expectContent(node, args.expectedContent)
        const clip = readClip(node.metadata)
        if (clip === undefined) throw new CanvasToolError('CANVAS_CLIP_NONE', `${node.id} has no clip mark: set one with video_clip first. A render copies the marked part into a file of its own.`)
        const path = hostPathOf(node)
        const started = await startEdit(film, 'cut', {
          requestId: args.requestId,
          source: { nodeId: node.id, path },
          inMs: clip.inMs,
          outMs: clip.outMs,
          land: { nearNodeId: node.id, connectFrom: [node.id], title: `${nameOf(node)} · 片段` },
        }, exec.signal)
        return plain({ ...started, nodeId: node.id, clip, note: TASK_NOTE })
      }),
    }),
    defineTool({
      name: 'video_join',
      description: 'Join 2–20 video nodes end to end, in the order given, into one file (film/canvas/media/join-…): each node gives its marked part, or its whole '
        + 'file without a mark. The Host copies without re-encoding, so the clips must match the first in codec, size, encoder settings and sound, and start on '
        + 'key frames; it puts the result on the board right of the last clip, with an edge from every clip, as a final cut (workflowKind final, '
        + 'videoEditOperation concat), carrying their subtitle cues and director shots. When they do not match, VIDEO_JOIN_NEEDS_PAGE names each clip and why: '
        + 're-encoding runs only in the 分镜 tab, where the person selects the clips and uses 拼接. Answers at once with a film task for media_get_task. Only '
        + 'cutting and joining: no transitions, music or effects.',
      parameters: {
        nodeIds: { type: 'array', required: true, items: { type: 'string' }, description: '2–20 video node ids in play order.' },
        requestId,
        title: { type: 'string', description: 'The new node\'s title; default 拼接成片 · <n> 段.' },
      },
      output: jsonOutput,
      execute: (args, exec) => guarded(async () => {
        const ids = args.nodeIds
        if (ids.length < 2 || ids.length > 20) throw invalid(`nodeIds lists 2 to 20 video nodes in play order, not ${ids.length}.`)
        const film = await filmWorkspace(exec)
        const { page, snapshot } = await board(film, undefined)
        const clips = ids.map((id) => {
          const node = mediaNode(snapshot, id, ['video'])
          return { nodeId: id, path: hostPathOf(node), ...readClip(node.metadata) }
        })
        const title = typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : `拼接成片 · ${ids.length} 段`
        let started: { taskId: unknown; status: unknown }
        try {
          started = await startEdit(film, 'join', { requestId: args.requestId, clips, land: { nearNodeId: ids.at(-1)!, connectFrom: [...new Set(ids)], title } }, exec.signal)
        } catch (error) {
          if (!(error instanceof FilmToolError) || error.code !== 'VIDEO_JOIN_NEEDS_TRANSCODE') throw error
          const reasons = reasonsOf(error).map(reason => ({ ...reason, nodeId: ids[reason.index] ?? '' }))
          throw new FilmToolError('VIDEO_JOIN_NEEDS_PAGE', 'These clips cannot be joined without re-encoding, and only the 分镜 tab re-encodes: '
            + `${reasons.map(reason => `clip ${reason.index + 1} (${reason.nodeId}) ${reason.reason}${reason.detail !== '' ? ` — ${reason.detail}` : ''}`).join('; ')}. `
            + `${page !== undefined ? 'Ask the person to select these nodes on the open 分镜 tab' : 'Ask the person to open the 分镜 tab, select these nodes'} and use 拼接 `
            + '(it re-encodes to the first clip\'s size and frame rate, silent clips padded with silence). Nothing was started.', { code: 'VIDEO_JOIN_NEEDS_PAGE', reasons })
        }
        return plain({ ...started, nodeIds: ids, note: TASK_NOTE })
      }),
    }),
    defineTool({
      name: 'video_extract_audio',
      description: 'Copy a video node\'s sound — of its marked part, when it has a mark — into an audio file (film/canvas/media/extract-….m4a) without re-encoding, '
        + 'and put it on the board as an audio node right of the video, with an edge back. Works with the 分镜 tab open or closed. Answers at once with a film task '
        + 'for media_get_task (file.landedNodeId is the audio node). VIDEO_NO_AUDIO_TRACK: the video has no sound.',
      parameters: {
        nodeId: { type: 'string', required: true, description: 'A video node with a file, from canvas_get_state.' },
        expectedContent,
        requestId,
      },
      output: jsonOutput,
      execute: (args, exec) => guarded(async () => {
        const film = await filmWorkspace(exec)
        const { snapshot } = await board(film, undefined)
        const node = mediaNode(snapshot, args.nodeId, ['video'])
        expectContent(node, args.expectedContent)
        const clip = readClip(node.metadata)
        const started = await startEdit(film, 'extract-audio', {
          requestId: args.requestId,
          source: { nodeId: node.id, path: hostPathOf(node) },
          ...clip,
          land: { nearNodeId: node.id, connectFrom: [node.id], title: `${nameOf(node)} · 音频` },
        }, exec.signal)
        return plain({ ...started, nodeId: node.id, ...(clip !== undefined ? { clip } : {}), note: TASK_NOTE })
      }),
    }),
  ]
}
