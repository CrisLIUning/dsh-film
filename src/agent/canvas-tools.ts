/**
 * The storyboard's tools (Studio's `canvas_*` MCP tools and board agent,
 * apps/daemon/src/mcp.ts and canvas-board-agent.ts).
 *
 * With a storyboard page open, the tools reach it live: reads answer from the
 * board it last reported, and writes compile to ops the page runs with its
 * own executor, so what the agent builds is what the person is watching (and
 * can undo). Studio requires that page. Here the board sits in a sidebar tab
 * that is often closed, so without a page reads come from the saved board and
 * writes go to it through the board's own writer; an open page merges them
 * in. Running a generation is the page's alone.
 * @module dsh-film/agent/canvas-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BoardAgentError } from '../canvas/board-agent.js'
import type { BoardPage } from '../canvas/board-agent.js'
import { BoardOpError, applyBoardOps } from '../canvas/board-ops.js'
import type { BoardSnapshot } from '../canvas/board-ops.js'
import {
  CanvasToolError, buildBoardOps, compactSnapshot, generationStatusPage, mutationReceipt, readNodeContent, savedCanvasPage, snapshotOfDocument,
} from '../canvas/board-tools.js'
import type { CanvasWriteTool } from '../canvas/board-tools.js'
import { CanvasDocumentStore, CanvasDocumentUpdateError, emptyFilmBoard } from '../canvas/documents.js'
import { FilmToolError, callStudio } from './studio-client.js'
import { filmPathFor, filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices, FilmWorkspace } from './context.js'

const WRITE_REPLY = ' Write replies use resultView:changes: nodes/connections hold only what changed, with removedNodeIds/removedConnectionIds and the board totals; '
  + 'they are not a full board.'

const PAGE_CLOSED_NOTE = 'No storyboard page is open: this is the saved board, and edits are saved to it (they appear when the 分镜 tab opens). Running a generation needs the page.'

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

const generationMode = { type: 'string', enum: ['text', 'image', 'video', 'audio'] } as const

const OP_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', required: true, enum: ['add_node', 'update_node', 'delete_node', 'delete_connections', 'connect_nodes', 'set_viewport', 'select_nodes', 'run_generation'] },
    id: { type: 'string', description: 'Node id for add_node/update_node/delete_node, connection id for delete_connections; update_node takes id, never nodeId.' },
    ids: { type: 'array', items: { type: 'string' } },
    nodeType: { type: 'string', description: 'text, image, video, audio, config (a generation), group or director.' },
    title: { type: 'string' },
    position: { type: 'object', additionalProperties: true, description: '{x, y}: the top-left corner.' },
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    metadata: { type: 'object', additionalProperties: true, description: 'Node text is metadata.content; a generation\'s prompt is metadata.prompt and metadata.composerContent.' },
    patch: { type: 'object', additionalProperties: true, description: 'update_node: title, position, width, height or metadata. Node identity cannot change.' },
    all: { type: 'boolean' },
    fromNodeId: { type: 'string' },
    toNodeId: { type: 'string' },
    viewport: { type: 'object', additionalProperties: true, description: '{x, y, k}.' },
    nodeId: { type: 'string', description: 'run_generation only: the staged node.' },
    mode: generationMode,
    prompt: { type: 'string' },
  },
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Board failures as tool failures with their code. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof BoardAgentError || error instanceof BoardOpError || error instanceof CanvasToolError || error instanceof CanvasDocumentUpdateError) {
      const message = error.message.startsWith(`${error.code}:`) ? error.message : `${error.code}: ${error.message}`
      throw new FilmToolError(error.code, message)
    }
    throw error
  }
}

/**
 * Build the canvas tools.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function canvasTools(services: FilmToolServices): ToolDefinition[] {
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

  const read = <A extends { target?: unknown }>(exec: ToolRunContext, args: A, answer: (snapshot: BoardSnapshot, film: FilmWorkspace) => Record<string, unknown>) => guarded(async () => {
    const film = await filmWorkspace(exec)
    const { page, snapshot } = await board(film, args.target)
    if (snapshot === null) return plain({ ...where(page), boardId: film.boardId, empty: true, nodes: [], connections: [], note: 'This film\'s board has no nodes yet.' })
    return plain({ ...where(page), ...answer(snapshot, film) })
  })

  const write = (tool: CanvasWriteTool, exec: ToolRunContext, args: Record<string, unknown>) => guarded(async () => {
    const film = await filmWorkspace(exec)
    const { page, snapshot } = await board(film, args.target)
    if (page !== undefined) {
      const ops = buildBoardOps(tool, args, snapshot)
      const result = await services.boardAgent.call(page.target, 'canvas_apply_ops', { ops, boardId: film.boardId, project: film.projectId }, { signal: exec.signal })
      const receipt = mutationReceipt(snapshot, result)
      return plain({ ...where(page), ...(isRecord(receipt) ? receipt : { result: receipt }) })
    }
    if (tool === 'canvas_run_generation' || (tool === 'canvas_create_generation_flow' && args.autoRun === true)) {
      throw new FilmToolError('CANVAS_BOARD_NOT_OPEN', 'Running a generation needs the storyboard page open (the 分镜 tab of the film workbench). '
        + 'Ask the person to open it, or stage the flow with autoRun:false, or generate with the media tools and attach the file with canvas_attach_media.')
    }
    let before: BoardSnapshot | null = null
    let after: BoardSnapshot | null = null
    await store(film).update((current) => {
      if (current !== null && current.id !== film.boardId) {
        throw new FilmToolError('CANVAS_BOARD_MISMATCH', `The saved board (${current.id}) is not this film's board (${film.boardId}); open the 分镜 tab to repair it.`)
      }
      // A film from before boards came with it may still have none.
      const base = current ?? emptyFilmBoard(film.boardId, film.project.title)
      before = snapshotOfDocument(base)
      after = applyBoardOps(before, buildBoardOps(tool, args, before))
      return { ...base, nodes: after.nodes ?? [], connections: after.connections ?? [], viewport: after.viewport, updatedAt: new Date().toISOString() }
    })
    services.events.emit(film.cwd, { type: 'story-canvas-changed', projectId: film.projectId, boardId: film.boardId })
    const receipt = mutationReceipt(before, after)
    return plain({ ...where(undefined), ...(isRecord(receipt) ? receipt : {}) })
  })

  return [
    defineTool({
      name: 'canvas_list_clients',
      description: 'List the storyboard pages open on this film\'s board (the 分镜 tab, in any window). Several pages may show the same board. With none open, '
        + 'canvas tools read and edit the saved board, and running a generation needs a page.',
      parameters: {},
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const film = await filmWorkspace(exec)
        const clients = services.boardAgent.list(film.projectId)
        return plain({ boardId: film.boardId, clients, ...(clients.length === 0 ? { note: 'No storyboard page is open.' } : {}) })
      },
    }),
    defineTool({
      name: 'canvas_get_state',
      description: 'Read the board overview: nodes, positions, titles, wires and selection. Node text is nodes[i].metadata.content (not nodes[i].content); a '
        + 'generation\'s prompt is metadata.prompt/composerContent. Long fields come back as previews listed in truncatedFields (read them exactly with '
        + 'canvas_read_node); bulky ones such as a director scene are listed in omittedFields. Call this before changing the board so ids are real; never '
        + 'guess ids or reuse an array index from an earlier read.',
      parameters: { target },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => read(exec, args, snapshot => ({ ...compactSnapshot(snapshot) })),
    }),
    defineTool({
      name: 'canvas_get_selection',
      description: 'Read the nodes the person has selected on the open storyboard page. A closed board has no selection.',
      parameters: { target },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => read(exec, args, (snapshot) => {
        const selected = new Set(snapshot.selectedNodeIds ?? [])
        return { nodes: (compactSnapshot(snapshot).nodes ?? []).filter(node => selected.has(node.id)) }
      }),
    }),
    defineTool({
      name: 'canvas_read_node',
      description: 'Read the exact text of one node by stable id: content for a text or media node, prompt/composerContent for a generation node. Returns content, '
        + 'totalLength, nextOffset and contentDigest; continue with nextOffset and the same contentDigest until nextOffset is null. Changed content is refused '
        + 'rather than mixing versions. Offsets count UTF-16 code units.',
      parameters: {
        target,
        nodeId: { type: 'string', required: true, description: 'The node id from canvas_get_state.' },
        field: { type: 'string', required: true, enum: ['content', 'prompt', 'composerContent'] },
        offset: { type: 'integer', description: 'Omit for the first page; then use nextOffset.' },
        limit: { type: 'integer', description: 'At most this many UTF-16 code units (2–12000, default 4000).' },
        contentDigest: { type: 'string', description: 'Required after the first page: the digest that page returned.' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => read(exec, args, snapshot => readNodeContent(snapshot, args)),
    }),
    defineTool({
      name: 'canvas_get_generation_status',
      description: 'Read compact generation progress for 1–50 node ids: nodes, missingNodeIds, nextNodeIds (query them next when nonempty) and allSucceeded; no '
        + 'prompts or image bodies. A generation (config) node lists outputNodeIds: query those, its own acknowledgement is not an output. Status comes from '
        + 'the board, not a fresh provider poll; outputs[].task names a media task when one was recorded. An interrupted or missing result is not authorization '
        + 'to pay for the generation again.',
      parameters: {
        target,
        nodeIds: { type: 'array', required: true, items: { type: 'string' }, description: 'Stable output node ids, not titles, positions or task ids.' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => read(exec, args, (snapshot, film) => generationStatusPage(snapshot, args.nodeIds, film.projectId)),
    }),
    defineTool({
      name: 'canvas_get_document',
      description: 'Read a bounded page of the SAVED board — nodes with their content previews, prompts, statuses and media task ids, and their links — whether or '
        + 'not a page is open. This is persisted state, not the live selection or unsaved edits. Follow nextOffset, or pass nodeId for one node: that view '
        + 'adds adoptionTarget (the node\'s exact saved prompt, composerContent and references — story_adopt\'s expectedTarget) and its screenplay links. '
        + 'Never read or write film/canvas/document.json with file tools: it is the live board.',
      parameters: {
        nodeId: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer', description: '1–50 nodes, default 25.' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => guarded(async () => {
        const film = await filmWorkspace(exec)
        const document = await store(film).read(film.boardId)
        if (document === null) return plain({ source: 'persisted', boardId: film.boardId, empty: true, nodes: [], totalNodes: 0, note: 'This film\'s board has no nodes yet.' })
        return plain(savedCanvasPage(document, {
          projectId: film.projectId,
          ...(args.nodeId !== undefined ? { nodeId: args.nodeId } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }))
      }),
    }),
    defineTool({
      name: 'canvas_create_text_nodes',
      description: 'Put text nodes on the board in one call — a batch of copy, scene descriptions, a shot list. Laid out in a row by default (direction "column" '
        + 'stacks them), right of everything already there unless x/y say otherwise. Nothing is generated and nothing is billed.' + WRITE_REPLY,
      parameters: {
        target,
        items: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string', required: true, description: 'The node body.' }, title: { type: 'string' } },
          },
        },
        x: { type: 'number' },
        y: { type: 'number' },
        gap: { type: 'number' },
        direction: { type: 'string', enum: ['row', 'column'] },
      },
      output: jsonOutput,
      execute: (args, exec) => write('canvas_create_text_nodes', exec, args),
    }),
    defineTool({
      name: 'canvas_create_generation_flow',
      description: 'Build a visible prompt node and a generation node, with referenceNodeIds wired in and mentioned as inputs. Staged by default. When the person '
        + 'has already asked for this output, use autoRun:true and go on to check the result without asking again; for planning or staging keep autoRun:false. '
        + 'Returns the board acknowledgement, not a finished generation. autoRun needs the storyboard page open.' + WRITE_REPLY,
      parameters: {
        target,
        prompt: { type: 'string', required: true },
        mode: generationMode,
        model: { type: 'string', description: 'A model id from media_models; omit for the board\'s default.' },
        title: { type: 'string' },
        referenceNodeIds: { type: 'array', items: { type: 'string' }, description: 'Existing nodes to wire in as references — a character sheet, a previous shot.' },
        autoRun: { type: 'boolean', description: 'Default false. True starts the generation at once; a direct request for this output is the authorization.' },
        x: { type: 'number' },
        y: { type: 'number' },
        size: { type: 'string' },
        count: { type: 'number' },
        seconds: { type: 'string' },
        generateAudio: { type: 'boolean', description: 'Ask a video model that speaks natively to voice the prompt\'s dialogue itself.' },
      },
      output: jsonOutput,
      execute: (args, exec) => write('canvas_create_generation_flow', exec, args),
    }),
    defineTool({
      name: 'canvas_run_generation',
      description: 'Run an existing staged generation node within the person\'s requested scope, without asking again for an approval already given. Image, '
        + 'video and audio may be billed: check pending and finished outputs first so nothing is submitted twice. Omit mode to keep the node\'s own. The '
        + 'acknowledgement is not completion; read the outputs before reporting success. Needs the storyboard page open.' + WRITE_REPLY,
      parameters: {
        target,
        nodeId: { type: 'string', required: true },
        mode: { ...generationMode, description: 'Optional override; omit to keep the node\'s generation mode.' },
        prompt: { type: 'string' },
      },
      output: jsonOutput,
      execute: (args, exec) => write('canvas_run_generation', exec, args),
    }),
    defineTool({
      name: 'canvas_connect_nodes',
      description: 'Wire nodes together — how a board says one thing feeds another (a reference into a generation, a prompt into its node).' + WRITE_REPLY,
      parameters: {
        target,
        connections: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { fromNodeId: { type: 'string', required: true }, toNodeId: { type: 'string', required: true } },
          },
        },
      },
      output: jsonOutput,
      execute: (args, exec) => write('canvas_connect_nodes', exec, args),
    }),
    defineTool({
      name: 'canvas_delete_nodes',
      description: 'Delete nodes (and their wires) from the board.' + WRITE_REPLY,
      parameters: {
        target,
        ids: { type: 'array', required: true, items: { type: 'string' } },
      },
      output: jsonOutput,
      execute: (args, exec) => write('canvas_delete_nodes', exec, args),
    }),
    defineTool({
      name: 'canvas_apply_ops',
      description: 'The board\'s full write vocabulary, for what the named tools do not cover. Ops: add_node, update_node, delete_node, delete_connections, '
        + 'connect_nodes, set_viewport, select_nodes, run_generation (page only). The whole batch applies or none of it. Prefer a named tool when one fits.' + WRITE_REPLY,
      parameters: {
        target,
        ops: { type: 'array', required: true, items: OP_ITEM },
      },
      output: jsonOutput,
      execute: (args, exec) => write('canvas_apply_ops', exec, args),
    }),
    defineTool({
      name: 'canvas_attach_media',
      description: 'Put an already generated file into an existing image/video/audio node — the node a staged flow or a screenplay handoff made — keeping its '
        + 'place, links and source. No generation is submitted. path is the file in the film (relative to film/) or any media file of the workspace, relative '
        + 'to it (media/… where the media tools save, or elsewhere outside film/; it is copied into the film first, once). expectedContent is the node\'s '
        + 'current content as just read (empty for an empty node); a node that changed or is generating is refused. Attaching the same file again changes '
        + 'nothing. Works whether or not the storyboard is open.',
      parameters: {
        targetNodeId: { type: 'string', required: true },
        path: { type: 'string', required: true },
        expectedContent: { type: 'string', required: true },
      },
      output: jsonOutput,
      execute: (args, exec) => guarded(async () => {
        const film = await filmWorkspace(exec)
        // A workspace file: the film keeps its own copy, made by the board's import.
        const path = await filmPathFor(film, args.path, { studio: services.studio, signal: exec.signal, failureCode: 'CANVAS_MEDIA_IMPORT_FAILED' })
        return plain(await callStudio(services.studio, film.cwd, {
          method: 'POST',
          path: `/api/canvas/assets/${segment(film.boardId)}/attach?project=${segment(film.projectId)}`,
          body: { path, targetNodeId: args.targetNodeId, expectedContent: args.expectedContent },
        }, exec.signal))
      }),
    }),
  ]
}
