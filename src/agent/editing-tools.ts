/**
 * The storyboard's cutting tools — the `editing` tool group (C12): mark,
 * split, render, join and copy the sound of the board's video nodes, and read
 * and write their subtitles.
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
 *
 * Subtitles are a video node's cues (C1 `subtitleEntries`, in ms of its whole
 * file) with their style, save time and media key. They are read from the
 * open page's board or the saved one, and written like marks — one
 * `update_node` of the four fields, the page's 保存 — through the page's own
 * rules (canvas/subtitles.ts): SubRip and WebVTT read as its 导入 reads them,
 * cues cleaned and long ones split as it does, and keyed to the node's current
 * video so the page does not flag them; `null` clears them. A list written
 * replaces only the cues of the view it was read in (the clip view's cues of
 * the mark, or one page), and a write that would drop cues of that view is
 * refused unless the agent says so (`replaceAll`): reading part of a list
 * and writing it back never deletes the rest.
 * @module dsh-film/agent/editing-tools
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
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
import { CUE_LENGTH_RANGE, STANDARD_CUE_LENGTH, resegmentEntries } from '../canvas/subtitle-resegment.js'
import { MAX_SUBTITLE_FILE_BYTES, looksLikeTimedSubtitles, parseSubtitleText, serializeSrt } from '../canvas/subtitle-srt.js'
import {
  MAX_SUBTITLE_ENTRIES, MAX_SUBTITLE_TEXT, SUBTITLE_BACKDROPS, SUBTITLE_FONT_SCALE_RANGE, SUBTITLE_ID_PATTERN, SUBTITLE_POSITIONS, cuesFromClipTime, cuesInClipTime,
  newSubtitleId, normalizeSubtitleColor, readSubtitleEntries, readSubtitleStyle, sanitizeSubtitleEntries, sanitizeSubtitleStyle, subtitleDigest, subtitleMediaChanged,
  subtitleMediaKeyOf,
} from '../canvas/subtitles.js'
import type { SubtitleEntry } from '../canvas/subtitles.js'
import { filmUrlOf } from '../media/tasks.js'
import { guarded } from './canvas-tools.js'
import { filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices, FilmWorkspace } from './context.js'
import { FilmToolError, callStudio } from './studio-client.js'

/** The group's line in film_tools (C12). */
export const EDITING_GROUP_DESCRIPTION = 'Cut, split, render, join and extract the sound of video nodes, and read or write their subtitles (video_*). Only cutting and joining: no '
  + 'transitions, music or effects.'

const PAGE_CLOSED_NOTE = 'No storyboard page is open: the edit is saved to the board and appears when the 分镜 tab opens.'

const TASK_NOTE = 'Started as a film task: read it with media_get_task until status is done (or failed/interrupted), then report file.landedNodeId — the new node right of '
  + 'the source with an edge back — not the request. The same requestId again, for the same edit, answers with this task and makes no second file; for another '
  + 'file, range or boundary it is refused (MEDIA_EDIT_REQUEST_CONFLICT), so give a new edit a new id.'

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
  description: 'A new id of your own for this edit (8–80 letters, digits, - or _; a UUID works). Retrying the same edit with the same id answers with the same task; '
    + 'another edit under an id already used (another node\'s file, mark or clips) is refused with MEDIA_EDIT_REQUEST_CONFLICT.',
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
 * @param code - the refusal's code when the node is not one of them.
 * @returns the node.
 */
function mediaNode(snapshot: BoardSnapshot | null, nodeId: string, kinds: readonly MediaKind[], code = 'CANVAS_CLIP_TARGET'): BoardNode {
  const node = snapshot?.nodes?.find(item => item.id === nodeId)
  if (node === undefined) throw new CanvasToolError('CANVAS_NODE_NOT_FOUND', `The board has no node ${nodeId}. Re-read canvas_get_state.`)
  const content = node.metadata?.content
  if (!(kinds as readonly string[]).includes(node.type) || typeof content !== 'string' || content.trim() === '') {
    throw new CanvasToolError(code, `${nodeId} is not a ${kinds.join(' or ')} node with a file (it is a ${node.type} node${typeof content === 'string' && content.trim() !== '' ? '' : ' without a file'}).`)
  }
  return node
}

/** Refuse a node whose file changed since it was read, or that is generating. */
function expectContent(node: BoardNode, expected: string, code = 'CANVAS_CLIP_TARGET_CHANGED'): void {
  if (node.metadata?.content !== expected || node.metadata?.status === 'loading') {
    throw new CanvasToolError(code, `${node.id} changed or is generating. Read it again (canvas_get_state, or canvas_read_node field content) and pass its current content as expectedContent.`)
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

/** Cues per page of video_get_subtitles: by default, and at most. */
const SUBTITLE_PAGE = { default: 200, max: 500 } as const

const subtitleInvalid = (message: string): CanvasToolError => new CanvasToolError('CANVAS_SUBTITLE_INVALID', message)

const subtitlesChanged = (nodeId: string): CanvasToolError => new CanvasToolError('CANVAS_SUBTITLE_TARGET_CHANGED',
  `${nodeId}'s subtitles changed since they were read (their contentDigest is another now). Read them again with video_get_subtitles and work from what is there.`)

const MEDIA_CHANGED_NOTE = 'mediaChanged: the node\'s video is not the one these cues were saved against (another file, size or length), so their timing may be '
  + 'off: check it before relying on them. Writing them with video_set_subtitles saves them against the current video.'

/** A cue as the agent passes one. */
interface CueInput {
  id?: string
  startMs: number
  endMs: number
  text: string
  highlight?: { start: number; end: number }
}

/** Style changes as the agent passes them. */
interface StyleInput {
  fontScale?: number
  color?: string
  position?: string
  backdrop?: string
  maxCharsPerEntry?: number
  autoResegment?: boolean
}

/** `1 cue`, `3 cues`. */
const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** The verb for `count` things: `agree(1, 'starts', 'start')`. */
const agree = (count: number, one: string, many: string): string => count === 1 ? one : many

/** `was` or `were`. */
const was = (count: number): string => agree(count, 'was', 'were')

/**
 * Style changes, checked: a value the page cannot draw is refused, never clamped behind the agent's back.
 * @param style - the changes as passed.
 * @returns the changes to lay over the node's style.
 */
function checkStyle(style: StyleInput | undefined): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  if (style === undefined) return changes
  if (style.fontScale !== undefined) {
    if (!(style.fontScale >= SUBTITLE_FONT_SCALE_RANGE.min && style.fontScale <= SUBTITLE_FONT_SCALE_RANGE.max)) {
      throw subtitleInvalid(`style.fontScale is the text height as a % of the picture's, ${SUBTITLE_FONT_SCALE_RANGE.min}–${SUBTITLE_FONT_SCALE_RANGE.max}; ${style.fontScale} is not.`)
    }
    changes.fontScale = style.fontScale
  }
  if (style.color !== undefined) {
    const color = normalizeSubtitleColor(style.color)
    if (color === undefined) throw subtitleInvalid(`style.color is '#RRGGBB' (or '#RGB'); "${style.color}" is not.`)
    changes.color = color
  }
  if (style.position !== undefined) changes.position = style.position
  if (style.backdrop !== undefined) changes.backdrop = style.backdrop
  if (style.maxCharsPerEntry !== undefined) {
    if (style.maxCharsPerEntry < CUE_LENGTH_RANGE.min || style.maxCharsPerEntry > CUE_LENGTH_RANGE.max) {
      throw subtitleInvalid(`style.maxCharsPerEntry is ${CUE_LENGTH_RANGE.min}–${CUE_LENGTH_RANGE.max} characters; ${style.maxCharsPerEntry} is not.`)
    }
    changes.maxCharsPerEntry = style.maxCharsPerEntry
  }
  if (style.autoResegment !== undefined) changes.autoResegment = style.autoResegment
  return changes
}

/** The same cue: its times and text (how a rewritten list finds the ids of the cues it keeps). */
const cueKey = (cue: { startMs: number; endMs: number; text: string }): string => `${cue.startMs}|${cue.endMs}|${cue.text}`

/** How many cues start before an earlier one ends (the page shows overlapping cues together). */
function overlapCount(entries: readonly SubtitleEntry[]): number {
  let reach = Number.NEGATIVE_INFINITY
  let count = 0
  for (const entry of entries) {
    if (entry.startMs < reach) count++
    reach = Math.max(reach, entry.endMs)
  }
  return count
}

/**
 * Which stored cues a written list replaces — the view video_get_subtitles
 * listed them in: every cue, the cues of the node's mark (timeBase clip), or
 * one page of either (offset/limit).
 */
type SubtitleScope = 'all' | 'clip' | 'page'

/**
 * A clip view shows a cue that crosses an edge of the mark cut at that edge.
 * Written back with its edge still on the mark's edge, the cue keeps the part
 * outside the mark it had; moved off the edge, it takes the time given.
 * @param cues - the written cues, moved into file time.
 * @param shown - the cues of the clip view the write replaces (clip time, stored ids).
 * @param stored - the node's cues (file time).
 * @param inMs - the mark's in point.
 * @returns the cues, edges restored.
 */
function restoreEdges<T extends { id?: string; startMs: number; endMs: number }>(cues: readonly T[], shown: readonly SubtitleEntry[], stored: readonly SubtitleEntry[], inMs: number): T[] {
  const original = new Map(stored.map(cue => [cue.id, cue]))
  const byId = new Map<string, SubtitleEntry>()
  const byTimes = new Map<string, SubtitleEntry[]>()
  for (const cue of shown) {
    const view = { ...cue, startMs: cue.startMs + inMs, endMs: cue.endMs + inMs }
    byId.set(view.id, view)
    const times = `${view.startMs}|${view.endMs}`
    byTimes.set(times, [...byTimes.get(times) ?? [], view])
  }
  const used = new Set<string>()
  return cues.map((cue) => {
    const id = typeof cue.id === 'string' && SUBTITLE_ID_PATTERN.test(cue.id) ? cue.id : undefined
    // By its id, or — a cue without one, as SubRip gives them — by the times the view showed.
    const view = id !== undefined ? byId.get(id) : byTimes.get(`${cue.startMs}|${cue.endMs}`)?.find(entry => !used.has(entry.id))
    const before = view === undefined ? undefined : original.get(view.id)
    if (view === undefined || before === undefined || used.has(view.id)) return cue
    used.add(view.id)
    const startMs = cue.startMs === view.startMs && before.startMs < view.startMs ? before.startMs : cue.startMs
    const endMs = cue.endMs === view.endMs && before.endMs > view.endMs ? before.endMs : cue.endMs
    return startMs === cue.startMs && endMs === cue.endMs ? cue : { ...cue, startMs, endMs }
  })
}

/**
 * The stored cues a written list does not stand for: none of its cues carries
 * their id or overlaps their time (an edited cue keeps one or the other).
 * @param stored - the cues the list replaces.
 * @param written - the list, sorted by start.
 * @returns the cues it would remove.
 */
function uncoveredCues(stored: readonly SubtitleEntry[], written: readonly SubtitleEntry[]): SubtitleEntry[] {
  const ids = new Set(written.map(cue => cue.id))
  // The latest end among the written cues up to each one (they are sorted by start).
  const reach: number[] = []
  let far = Number.NEGATIVE_INFINITY
  for (const cue of written) reach.push(far = Math.max(far, cue.endMs))
  return stored.filter((cue) => {
    if (ids.has(cue.id)) return false
    // How many written cues start before this one ends; one of them reaching past its start overlaps it.
    let low = 0
    let high = written.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (written[middle]!.startMs < cue.endMs) low = middle + 1
      else high = middle
    }
    return !(low > 0 && reach[low - 1]! > cue.startMs)
  })
}

/** A cue as a refusal names it: id, times and the start of its text. */
function cueLine(cue: SubtitleEntry): string {
  const characters = Array.from(cue.text.replace(/\n/gu, ' '))
  return `${cue.id} ${cue.startMs}–${cue.endMs} ms "${characters.length > 20 ? `${characters.slice(0, 20).join('')}…` : characters.join('')}"`
}

/** What video_set_subtitles stores on a node, and what it says about it. */
interface SubtitlePlan {
  /** The node's new subtitle fields: one `update_node`, like the page's 保存. */
  patch: Record<string, unknown>
  /** The node already holds exactly this. */
  unchanged: boolean
  /** The cues the node holds after the write. */
  count: number
  /** Which stored cues the written list replaced (omitted for a restyle or a clear). */
  scope?: SubtitleScope
  /** Stored cues outside the part replaced, left as they were. */
  kept: number
  /** Stored cues the write deleted: a clear's, or those of the part replaced the list no longer has (replaceAll). */
  removed: number
  /** Cues (or SubRip blocks) of the input that could not be stored. */
  dropped: number
  warnings: string[]
  resegmented?: { from: number; to: number; maxCharsPerEntry: number }
  contentDigest: string
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
    defineTool({
      name: 'video_get_subtitles',
      description: 'Read a video node\'s subtitles: its cues (id, startMs, endMs, text) in ms of the node\'s whole file, as stored and whatever its in/out mark '
        + '(timeBase clip counts from the mark and lists only the cues inside it), as JSON or as SubRip text (format srt), in pages: follow nextOffset with the '
        + 'same contentDigest. A page, or the clip view (outsideClip counts the cues it leaves out), is only part of the list: to edit what you read, write it '
        + 'back with video_set_subtitles in the same view — the same timeBase, and offset/limit for a page — so only those cues are replaced and the rest stay. '
        + 'Also returns the style the 分镜 page draws them in, and mediaChanged: true when the node\'s video is no longer the one they were saved against '
        + '(another file, size, or a length more than 250 ms off), so their timing may be off. Reads the open page\'s board, or the saved board when the 分镜 '
        + 'tab is closed. Free; nothing changes.',
      parameters: {
        target,
        nodeId: { type: 'string', required: true, description: 'A video node with a file, from canvas_get_state.' },
        format: { type: 'string', enum: ['json', 'srt'], description: 'json (default): entries [{ id, startMs, endMs, text, highlight? }]; srt: the page as SubRip text, numbered from offset + 1.' },
        timeBase: { type: 'string', enum: ['source', 'clip'], description: 'source (default): ms of the node\'s whole file, as stored; clip: ms from its in point, only the cues inside its mark, clamped to it.' },
        offset: { type: 'integer', description: 'The first cue of the page (0 first); then use nextOffset.' },
        limit: { type: 'integer', description: `Cues per page, 1–${SUBTITLE_PAGE.max} (default ${SUBTITLE_PAGE.default}).` },
        contentDigest: { type: 'string', description: 'From the second page on: the contentDigest the first page returned, so two versions are never stitched together.' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => guarded(async () => {
        const offset = args.offset ?? 0
        const limit = args.limit ?? SUBTITLE_PAGE.default
        if (offset < 0) throw subtitleInvalid('offset counts cues from 0; use the nextOffset a page returned.')
        if (limit < 1 || limit > SUBTITLE_PAGE.max) throw subtitleInvalid(`limit is 1–${SUBTITLE_PAGE.max} cues per page; ${limit} is not.`)
        const film = await filmWorkspace(exec)
        const { page, snapshot } = await board(film, args.target)
        const node = mediaNode(snapshot, args.nodeId, ['video'], 'CANVAS_SUBTITLE_TARGET')
        const metadata = node.metadata ?? {}
        const entries = readSubtitleEntries(metadata)
        const contentDigest = subtitleDigest(entries)
        if (args.contentDigest !== undefined && args.contentDigest !== contentDigest) throw subtitlesChanged(node.id)
        const clipTime = args.timeBase === 'clip'
        const clip = readClip(metadata)
        const listed = clipTime && clip !== undefined ? cuesInClipTime(entries, clip) : entries
        const shown = listed.slice(offset, offset + limit)
        const end = offset + shown.length
        const mediaChanged = subtitleMediaChanged(metadata)
        // The clip view leaves out the cues outside the mark (and those touching it for less than 100 ms): say so, they still exist.
        const outsideClip = clipTime && clip !== undefined ? entries.length - listed.length : 0
        const notes = [
          ...(mediaChanged ? [MEDIA_CHANGED_NOTE] : []),
          ...(clipTime && clip === undefined ? ['The node has no in/out mark, so clip time is the file\'s time.'] : []),
          ...(outsideClip > 0
            ? [`${counted(outsideClip, 'cue')} outside the mark (or touching it for less than 100 ms) ${agree(outsideClip, 'is', 'are')} not listed; `
              + `video_set_subtitles with timeBase clip keeps ${agree(outsideClip, 'it', 'them')}.`]
            : []),
        ]
        const key = metadata.subtitleMediaKey
        return plain({
          ...(page !== undefined ? { source: 'live', target: page.target } : { source: 'persisted' }),
          nodeId: node.id,
          timeBase: clipTime ? 'clip' : 'source',
          ...(clipTime ? { clip: clip ?? null, outsideClip } : {}),
          ...(positive(metadata.durationMs) ? { durationMs: Math.round(metadata.durationMs) } : {}),
          total: listed.length,
          offset,
          nextOffset: end < listed.length ? end : null,
          ...(args.format === 'srt' ? { srt: serializeSrt(shown, offset + 1) } : { entries: shown }),
          style: readSubtitleStyle(metadata),
          ...(typeof key === 'string' && key !== '' ? { subtitleMediaKey: key } : {}),
          ...(typeof metadata.subtitleUpdatedAt === 'string' ? { subtitleUpdatedAt: metadata.subtitleUpdatedAt } : {}),
          mediaChanged,
          contentDigest,
          ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
        })
      }),
    }),
    defineTool({
      name: 'video_set_subtitles',
      description: 'Write a video node\'s subtitles: replace cues with SubRip or WebVTT text (srt) or a cue list (entries), restyle them (style, alone or with '
        + 'either), or remove them all (clear:true, stored as null). A list replaces the cues of the view it was read in: by default every cue (times in whole '
        + 'ms of the node\'s whole file); with timeBase clip only the cues inside the node\'s in/out mark, timed from its in point — cues outside the mark stay, '
        + 'and a cue crossing an edge of the mark, written back with that edge, keeps its part outside; with offset/limit (and the read\'s contentDigest) only '
        + 'that page of the view. A list that no longer has a cue of the part it replaces — none with its id or at its time — is refused, naming the cues, '
        + 'unless replaceAll is true: writing back part of a list never deletes the rest. Cues are cleaned as the 分镜 page cleans an import — sorted, end '
        + 'after start, text up to 2000 characters, at most 5000; what cannot be used is counted in dropped and explained in warnings — long ones are split '
        + 'at punctuation when resegment is on (by default for srt, when the style\'s autoResegment is on), and they are saved against the node\'s current '
        + 'video, so the page does not flag them. Answers count (cues the node holds now), kept (cues outside the part written, left as they were), removed '
        + 'and dropped. When you edit a list you read, pass its contentDigest: a list changed meanwhile is refused, not overwritten. With the 分镜 tab open the '
        + 'edit runs in the page (live, undoable); with it closed it is saved to the board. Nothing is generated.',
      parameters: {
        target,
        nodeId: { type: 'string', required: true, description: 'A video node with a file, from canvas_get_state.' },
        expectedContent,
        srt: {
          type: 'string',
          description: 'SubRip (.srt) or WebVTT (.vtt) text; replaces the cues of the view (every cue, the mark\'s with timeBase clip, one page with offset/limit). '
            + 'Tags are dropped; blocks that cannot be read are skipped and counted.',
        },
        entries: {
          type: 'array',
          description: `The cues, replacing those of the view (as srt): whole ms with endMs after startMs, text up to ${MAX_SUBTITLE_TEXT} characters (a line break makes `
            + `two lines), at most ${MAX_SUBTITLE_ENTRIES}; they are sorted for you.`,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Keep a cue\'s id from video_get_subtitles when you change it; a new cue gets one.' },
              startMs: { type: 'integer', required: true },
              endMs: { type: 'integer', required: true },
              text: { type: 'string', required: true },
              highlight: {
                type: 'object',
                additionalProperties: false,
                description: 'Keep a highlight video_get_subtitles returned: [start, end) in the text (UTF-16 units).',
                properties: { start: { type: 'integer', required: true }, end: { type: 'integer', required: true } },
              },
            },
          },
        },
        timeBase: {
          type: 'string',
          enum: ['source', 'clip'],
          description: 'How srt or entries are timed, and what they replace: source (default), ms of the node\'s whole file, replacing every cue; clip, ms from its '
            + 'in point, replacing only the cues inside its mark (cues past the file\'s end are left out; cues outside the mark stay).',
        },
        offset: {
          type: 'integer',
          description: 'With srt or entries, the page you read: the offset you gave video_get_subtitles (same timeBase), with that read\'s contentDigest. Only '
            + 'that page\'s cues are replaced; the cues before and after it stay.',
        },
        limit: { type: 'integer', description: `The limit that page was read with (1–${SUBTITLE_PAGE.max}, default ${SUBTITLE_PAGE.default}).` },
        resegment: { type: 'boolean', description: 'Split cues longer than the style\'s maxCharsPerEntry (35 unless set) at punctuation, as the page\'s 自动断句. Default: on for srt when the style\'s autoResegment is on; off for entries.' },
        style: {
          type: 'object',
          additionalProperties: false,
          description: 'Changes over the node\'s current style (the page\'s defaults when it has none): only the fields given change.',
          properties: {
            fontScale: { type: 'number', description: `Text height as a % of the picture's, ${SUBTITLE_FONT_SCALE_RANGE.min}–${SUBTITLE_FONT_SCALE_RANGE.max} (default 5).` },
            color: { type: 'string', description: '\'#RRGGBB\' (default #FFFFFF).' },
            position: { type: 'string', enum: SUBTITLE_POSITIONS, description: 'Default bottom.' },
            backdrop: { type: 'string', enum: SUBTITLE_BACKDROPS, description: 'Behind the text: none, shadow (default) or box.' },
            maxCharsPerEntry: { type: 'integer', description: `The longest cue 自动断句 leaves whole, ${CUE_LENGTH_RANGE.min}–${CUE_LENGTH_RANGE.max} characters (default ${STANDARD_CUE_LENGTH}).` },
            autoResegment: { type: 'boolean', description: 'Whether text the page imports is split by default (default true).' },
          },
        },
        clear: { type: 'boolean', description: 'true removes every cue (stored as null), instead of srt or entries.' },
        contentDigest: { type: 'string', description: 'The contentDigest video_get_subtitles returned: when the cues changed since, the call is refused instead of overwriting them.' },
        replaceAll: {
          type: 'boolean',
          description: 'With srt or entries: true deletes the cues of the part replaced that your list no longer has (none with their id or at their time). '
            + 'Without it such a write is refused (CANVAS_SUBTITLE_WOULD_REMOVE, naming them). Pass it only when those cues should go.',
        },
      },
      output: jsonOutput,
      execute: (args, exec) => guarded(async () => {
        const clear = args.clear === true
        const sources = [args.srt !== undefined, args.entries !== undefined, clear].filter(Boolean).length
        if (sources > 1) throw subtitleInvalid('Pass one of srt, entries or clear:true (style may come with any of them, or alone).')
        if (sources === 0 && args.style === undefined) throw subtitleInvalid('Pass srt or entries to replace the cues, clear:true to remove them, or style to restyle them.')
        const paged = args.offset !== undefined || args.limit !== undefined
        if (args.srt === undefined && args.entries === undefined && (args.timeBase !== undefined || args.resegment !== undefined || paged || args.replaceAll === true)) {
          throw subtitleInvalid('timeBase, offset, limit, resegment and replaceAll go with srt or entries (clear:true removes every cue).')
        }
        /** The page of the view the list was read in, when it replaces one. */
        let readPage: { offset: number; limit: number } | undefined
        if (paged) {
          const offset = args.offset ?? 0
          const limit = args.limit ?? SUBTITLE_PAGE.default
          if (offset < 0) throw subtitleInvalid('offset counts cues from 0, as the page you read did.')
          if (limit < 1 || limit > SUBTITLE_PAGE.max) throw subtitleInvalid(`limit is 1–${SUBTITLE_PAGE.max} cues per page; ${limit} is not.`)
          if (args.contentDigest === undefined) throw subtitleInvalid('offset and limit name a page of the list as you read it: pass that read\'s contentDigest too, so it is the same page.')
          readPage = { offset, limit }
        }
        const styleChanges = checkStyle(args.style)
        /** The cues given, before anything is cleaned, and the srt blocks that could not be read. */
        const input = ((): { given?: CueInput[]; skipped: number } => {
          if (args.srt !== undefined) {
            if (Buffer.byteLength(args.srt) > MAX_SUBTITLE_FILE_BYTES) throw subtitleInvalid(`srt is larger than ${MAX_SUBTITLE_FILE_BYTES / 1024 / 1024} MB.`)
            if (!looksLikeTimedSubtitles(args.srt)) throw subtitleInvalid('srt holds no SubRip or WebVTT timing line (00:00:01,000 --> 00:00:02,500). Time the cues, or pass entries.')
            const parsed = parseSubtitleText(args.srt)
            if (parsed.cues.length === 0) throw subtitleInvalid(`srt holds no cue that can be used (${counted(parsed.skipped, 'block')} without a readable timing, with end <= start or without text).`)
            return { given: parsed.cues, skipped: parsed.skipped }
          }
          if (args.entries !== undefined && args.entries.length === 0) throw subtitleInvalid('entries lists at least one cue; clear:true removes every cue.')
          return { ...(args.entries !== undefined ? { given: args.entries } : {}), skipped: 0 }
        })()
        const { given, skipped } = input
        const film = await filmWorkspace(exec)
        const { page, snapshot } = await board(film, args.target)
        const node = mediaNode(snapshot, args.nodeId, ['video'], 'CANVAS_SUBTITLE_TARGET')
        expectContent(node, args.expectedContent, 'CANVAS_SUBTITLE_TARGET_CHANGED')
        const now = new Date().toISOString()
        /** The node's new subtitle fields, worked out from the node as it is. */
        const plan = (source: BoardNode): SubtitlePlan => {
          const metadata = source.metadata ?? {}
          const current = readSubtitleEntries(metadata)
          if (args.contentDigest !== undefined && args.contentDigest !== subtitleDigest(current)) throw subtitlesChanged(source.id)
          const storedStyle = metadata.subtitleStyle
          const style = sanitizeSubtitleStyle({ ...(isRecord(storedStyle) ? storedStyle : {}), ...styleChanges })
          const sameStyle = isDeepStrictEqual(storedStyle, style)
          if (given === undefined && !clear) {
            return {
              patch: { subtitleStyle: style, subtitleUpdatedAt: now }, unchanged: sameStyle, count: current.length, kept: current.length, removed: 0, dropped: 0, warnings: [],
              contentDigest: subtitleDigest(current),
            }
          }
          if (given === undefined) {
            const none = (metadata.subtitleEntries ?? null) === null && (metadata.subtitleMediaKey ?? null) === null
            return {
              patch: { subtitleEntries: null, subtitleStyle: style, subtitleUpdatedAt: now, subtitleMediaKey: null },
              unchanged: none && (Object.keys(styleChanges).length === 0 || sameStyle), count: 0, kept: 0, removed: current.length, dropped: 0, warnings: [],
              contentDigest: subtitleDigest([]),
            }
          }
          const warnings: string[] = []
          if (skipped > 0) warnings.push(`${counted(skipped, 'block')} of srt could not be read (no usable timing, end <= start, or no text) and ${was(skipped)} skipped.`)
          const durationMs = positive(metadata.durationMs) ? Math.round(metadata.durationMs) : undefined
          const clip = readClip(metadata, durationMs)
          const clipView = args.timeBase === 'clip' && clip !== undefined
          // What the list replaces: the cues video_get_subtitles listed in the view it was read in — the clip view
          // (the cues of the mark, in clip time) with timeBase clip, one page of the view with offset/limit — else every cue.
          const view = clipView ? cuesInClipTime(current, clip) : current
          const shown = readPage !== undefined ? view.slice(readPage.offset, readPage.offset + readPage.limit) : view
          const scope: SubtitleScope = readPage !== undefined ? 'page' : clipView ? 'clip' : 'all'
          let cues = given
          let pastEnd = 0
          if (args.timeBase === 'clip') {
            const inMs = clip?.inMs ?? 0
            if (clip === undefined) warnings.push('The node has no in/out mark, so clip time is the file\'s time.')
            pastEnd = durationMs === undefined ? 0 : cues.filter(cue => cue.startMs + inMs >= durationMs).length
            cues = cuesFromClipTime(cues, { inMs }, durationMs)
            if (pastEnd > 0) warnings.push(`${counted(pastEnd, 'cue')} started past the end of the file (${durationMs} ms) from the in point and ${was(pastEnd)} left out.`)
            // The clip view cut cues crossing the mark's edges at the edge: written back so, they keep what lies outside.
            if (clipView) cues = restoreEdges(cues, shown, current, inMs)
          }
          // A cue without a usable id gets a new one — or, below, the id of a stored cue with the same times and text.
          const fresh = new Set<string>()
          const freshId = (): string => {
            const id = newSubtitleId()
            fresh.add(id)
            return id
          }
          const report = sanitizeSubtitleEntries(cues.map(cue => typeof cue.id === 'string' && SUBTITLE_ID_PATTERN.test(cue.id) ? cue : { ...cue, id: freshId() }))
          let entries = report.entries
          let resegmented: SubtitlePlan['resegmented']
          if (args.resegment ?? (args.srt !== undefined && style.autoResegment)) {
            const split = resegmentEntries(entries, style.maxCharsPerEntry, freshId)
            if (split.length !== entries.length) resegmented = { from: entries.length, to: split.length, maxCharsPerEntry: style.maxCharsPerEntry }
            entries = split
          }
          // A cue the list names by its id is replaced wherever it was; the cues outside the view that it does not name stay as they are.
          const named = new Set(entries.filter(entry => !fresh.has(entry.id)).map(entry => entry.id))
          const shownIds = new Set(shown.map(entry => entry.id))
          const replaced = current.filter(entry => shownIds.has(entry.id) || named.has(entry.id))
          const kept = current.filter(entry => !shownIds.has(entry.id) && !named.has(entry.id))
          // The cues a rewrite keeps keep their ids (and highlights), so writing the same cues twice changes nothing.
          const reusable = new Map<string, SubtitleEntry[]>()
          for (const entry of replaced) if (!named.has(entry.id)) reusable.set(cueKey(entry), [...reusable.get(cueKey(entry)) ?? [], entry])
          entries = entries.map((entry) => {
            const match = fresh.has(entry.id) ? reusable.get(cueKey(entry))?.shift() : undefined
            return match === undefined ? entry : { ...entry, id: match.id, ...(entry.highlight === undefined && match.highlight !== undefined ? { highlight: match.highlight } : {}) }
          })
          // Once more as C1 stores them: sorted, unique ids, at most 5000 (a split can pass the limit).
          const final = sanitizeSubtitleEntries(entries)
          const notCues = given.length - cues.length - pastEnd + report.dropped
          const overLimit = report.overLimit + final.overLimit
          if (notCues > 0) warnings.push(`${counted(notCues, 'cue')} had no usable times or text (endMs must be after startMs) and ${was(notCues)} left out.`)
          if (report.truncated > 0) warnings.push(`${counted(report.truncated, 'text')} ran past ${MAX_SUBTITLE_TEXT} characters and ${was(report.truncated)} cut there.`)
          if (overLimit > 0) warnings.push(`${counted(overLimit, 'cue')} past the limit of ${MAX_SUBTITLE_ENTRIES} ${was(overLimit)} left out.`)
          const written = final.entries
          if (written.length === 0) throw subtitleInvalid(`None of the cues can be stored, so nothing was changed. ${warnings.join(' ')}`)
          const part = scope === 'page' ? 'the page you read' : scope === 'clip' ? `the mark (${clip!.inMs}–${clip!.outMs} ms of the file)` : 'the list'
          if (kept.length + written.length > MAX_SUBTITLE_ENTRIES) {
            throw subtitleInvalid(`With the ${counted(kept.length, 'cue')} outside ${part}, which stay, the node would hold ${kept.length + written.length} cues, more than `
              + `${MAX_SUBTITLE_ENTRIES}; nothing was changed.`)
          }
          // Never a silent deletion: a stored cue of the part replaced that the list no longer stands for goes only when asked.
          const removed = uncoveredCues(replaced, written)
          if (removed.length > 0 && args.replaceAll !== true) {
            throw new CanvasToolError('CANVAS_SUBTITLE_WOULD_REMOVE', `This write would remove ${counted(removed.length, 'stored cue')} of ${part}: your list has no cue with `
              + `${agree(removed.length, 'its', 'their')} id or at ${agree(removed.length, 'its', 'their')} time (${removed.slice(0, 5).map(cueLine).join('; ')}`
              + `${removed.length > 5 ? `; and ${removed.length - 5} more` : ''}). `
              + (scope === 'all'
                ? 'This list replaces every cue: if you read only part of the list (a page, or the clip view of a marked node), write it back the same way '
                  + '(offset/limit with the contentDigest, or timeBase clip), and only that part is replaced. '
                : '')
              + 'To delete them, pass replaceAll: true. Nothing was changed.')
          }
          const merged = kept.length === 0 ? written : sanitizeSubtitleEntries([...kept, ...written]).entries
          const beyond = durationMs === undefined ? 0 : written.filter(entry => entry.startMs >= durationMs).length
          if (beyond > 0) warnings.push(`${counted(beyond, 'cue')} ${agree(beyond, 'starts', 'start')} at or after the end of the video (${durationMs} ms) and will never show.`)
          const outside = clip === undefined ? 0 : written.filter(entry => entry.endMs <= clip.inMs || entry.startMs >= clip.outMs).length
          if (clip !== undefined && outside > 0) {
            warnings.push(`${counted(outside, 'cue')} ${agree(outside, 'lies', 'lie')} outside the node's in/out mark (${clip.inMs}–${clip.outMs} ms of the file): `
              + `${agree(outside, 'it is', 'they are')} kept with the file's subtitles, but this node plays only its mark, so ${agree(outside, 'it does', 'they do')} not show on it.`)
          }
          const overlaps = overlapCount(merged)
          if (overlaps > 0) warnings.push(`${counted(overlaps, 'cue')} ${agree(overlaps, 'starts', 'start')} before an earlier cue ends; the page shows overlapping cues together.`)
          const key = subtitleMediaKeyOf(metadata)
          return {
            patch: { subtitleEntries: merged, subtitleStyle: style, subtitleUpdatedAt: now, subtitleMediaKey: key },
            unchanged: isDeepStrictEqual(metadata.subtitleEntries, merged) && sameStyle && metadata.subtitleMediaKey === key,
            count: merged.length,
            scope,
            kept: kept.length,
            removed: removed.length,
            dropped: skipped + pastEnd + notCues + overLimit,
            warnings,
            ...(resegmented !== undefined ? { resegmented } : {}),
            contentDigest: subtitleDigest(merged),
          }
        }
        let planned = plan(node)
        const facts = (): Record<string, unknown> => ({
          nodeId: node.id, count: planned.count, ...(planned.scope !== undefined ? { scope: planned.scope } : {}), kept: planned.kept, removed: planned.removed,
          dropped: planned.dropped, warnings: planned.warnings, ...(planned.resegmented !== undefined ? { resegmented: planned.resegmented } : {}),
          contentDigest: planned.contentDigest,
        })
        if (planned.unchanged) return plain({ ...where(page), changed: false, ...facts() })
        const receipt = await applyEdit(film, page, snapshot!, (current) => {
          // On the saved board this runs under its lock: the node as it is now.
          const source = mediaNode(current, node.id, ['video'], 'CANVAS_SUBTITLE_TARGET')
          expectContent(source, args.expectedContent, 'CANVAS_SUBTITLE_TARGET_CHANGED')
          planned = plan(source)
          return [{ type: 'update_node', id: node.id, metadata: planned.patch }]
        }, exec.signal)
        return plain({ ...where(page), ...receipt, changed: true, ...facts() })
      }),
    }),
  ]
}
