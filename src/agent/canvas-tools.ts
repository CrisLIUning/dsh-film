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
 *
 * Generation settings — camera moves (运镜), camera settings (相机), prompt
 * skills (提示词技能, on the node or as a skill node), first and last frames
 * and presets (C11) — are node metadata the page composes into the prompt
 * when it generates; their choices come from the canvas build's own
 * catalogues (C3).
 * @module dsh-film/agent/canvas-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BoardAgentError } from '../canvas/board-agent.js'
import type { BoardPage } from '../canvas/board-agent.js'
import { BoardOpError, applyBoardOps } from '../canvas/board-ops.js'
import type { BoardNode, BoardOp, BoardSnapshot } from '../canvas/board-ops.js'
import {
  CanvasToolError, buildBoardOps, compactSnapshot, generationStatusPage, mutationReceipt, readNodeContent, savedCanvasPage, snapshotOfDocument,
} from '../canvas/board-tools.js'
import type { CanvasWriteTool } from '../canvas/board-tools.js'
import { CAMERA_ANGLES, CAMERA_SHOT_SIZES, CanvasCatalogError, PROMPT_SKILL_CATEGORIES, readCanvasCatalog } from '../canvas/catalog.js'
import type { CanvasCatalogFiles, CanvasCatalogName } from '../canvas/catalog.js'
import { CanvasDocumentStore, CanvasDocumentUpdateError, emptyFilmBoard } from '../canvas/documents.js'
import {
  PROMPT_LIMIT_LENGTH, checkCameraControlInput, checkCameraMoveInput, checkFrameRolesInput, checkSkillInputs, findPreset, flowFrameRoles, flowSkills, mergeCameraControl,
  planGenerationOptions, presetSettings, promptLimitCheck, usesFrameRoles,
} from '../canvas/generation-options.js'
import type {
  CameraControlInput, CameraMoveInput, CameraMoveSetting, CheckedSkill, ClearableOption, FrameRolesInput, OptionCatalogs, PresetSettings, PromptLimitCheck, SkillInput,
} from '../canvas/generation-options.js'
import { skillApplies, skillTakesMode } from '../canvas/prompt-skills.js'
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

/** A camera move (运镜) as the agent passes it (C11). */
const cameraMoveParameter = {
  type: 'object',
  additionalProperties: false,
  properties: {
    moves: {
      type: 'array',
      required: true,
      description: '1–3 moves in order (ids from canvas_generation_options kind camera_moves); the first is the main move. A locked-off move stands alone.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          speed: { type: 'string', enum: ['slow', 'steady', 'fast'], description: 'Only for moves that have a speed; default steady (or the move\'s own).' },
        },
      },
    },
    combine: { type: 'string', enum: ['sequence', 'together'], description: 'sequence (default): one after another; together: at the same time.' },
  },
} as const

/** Camera settings (相机) as the agent passes them (C11). */
const cameraControlParameter = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', description: 'Default true; false keeps the settings on the node without sending them.' },
    look: { type: 'string', description: 'A look id (canvas_generation_options kind camera).' },
    lens: { type: 'string', description: 'A lens id.' },
    focalLength: { type: 'number', description: 'mm; snaps to the nearest listed stop (14–200).' },
    aperture: { type: 'number', description: 'f-number; snaps to the nearest listed stop (1.4–16).' },
    shotSize: { oneOf: [{ type: 'string', enum: CAMERA_SHOT_SIZES }, { type: 'null' }], description: 'Optional shot size; null removes it.' },
    angle: { oneOf: [{ type: 'string', enum: CAMERA_ANGLES }, { type: 'null' }], description: 'Optional camera angle; null removes it.' },
  },
} as const

const presetParameter = { type: 'string', description: 'A preset id (canvas_generation_options kind presets).' } as const

/** Prompt skills (提示词技能) as the agent passes them (C11). */
const skillsParameter = {
  type: 'array',
  description: 'Prompt skills (ids from canvas_generation_options kind skills): VibeDev prompt templates the storyboard composes into the prompt when it generates — not agent '
    + 'skills. At most one wrap and two append skills (a node composes no more, its own and its skill nodes\' together); fill the required variables.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      vars: { type: 'object', additionalProperties: true, description: 'Variable values as text, by key (the skill\'s variables); left out: the default. An empty duration variable reads the node\'s duration.' },
      as: { type: 'string', enum: ['attach', 'node'], description: 'attach (default): kept on each node itself; node: one skill node wired into the nodes, which applies to every image, video and generation node it is wired into.' },
    },
  },
} as const

/** First and last frames (首帧 / 尾帧, C1 frameRoles) as the agent passes them. */
const frameRolesParameter = {
  type: 'object',
  additionalProperties: false,
  description: 'Which wired image is the first frame and which the last, by node id (canvas_get_state); null removes a role. They apply only while the node\'s video mode '
    + 'is image-to-video (图生视频) or first-last-frame (首尾帧); otherwise the images go in connection order.',
  properties: {
    first: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'The image node of the first frame.' },
    last: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'The image node of the last frame.' },
  },
} as const

/** What the page says when it refuses a batch's runs before applying any of it (canvas generation-run.ts describeRunRefusals). */
const GENERATION_REFUSED = 'CANVAS_GENERATION_REFUSED:'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** What composition adds to these prompts, for a refusal: the prompt skills and the kinds of lines. */
function addedBy(checks: readonly PromptLimitCheck[]): string {
  const skills = [...new Set(checks.flatMap(check => check.skills))]
  const kinds = new Set<string>()
  for (const check of checks) {
    for (const line of check.lines) {
      kinds.add(/^(?:运镜：|Camera movement: )/u.test(line) ? 'camera move' : /^(?:避免：|Avoid: )/u.test(line) ? 'avoid' : 'camera')
    }
  }
  const parts = [
    ...(skills.length > 0 ? [`prompt skill${skills.length > 1 ? 's' : ''} ${skills.join(', ')}`] : []),
    ...(kinds.size > 0 ? [`the ${[...kinds].join(', ')} line${kinds.size > 1 ? 's' : ''}`] : []),
  ]
  return parts.length > 0 ? parts.join(' and ') : 'its settings'
}

/** Thrown inside the board's lock when a write changes nothing, so nothing is saved. */
class NothingToSave extends Error {}

/** Board failures as tool failures with their code. */
export async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof BoardAgentError || error instanceof BoardOpError || error instanceof CanvasToolError || error instanceof CanvasDocumentUpdateError
      || error instanceof CanvasCatalogError) {
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

  /** A canvas catalogue (C3) from the canvas build. */
  const catalog = <N extends CanvasCatalogName>(name: N): Promise<CanvasCatalogFiles[N]> => readCanvasCatalog(name, services.catalogRoot)

  /** A catalogue when the build has it; for checks that must never stop a generation. */
  const optionalCatalog = <N extends CanvasCatalogName>(name: N): Promise<CanvasCatalogFiles[N] | undefined> => catalog(name).catch(() => undefined)

  /**
   * The generations in a batch the page would refuse for length (C2),
   * estimated on the board the batch leaves. The page checks the runs itself
   * before it answers and refuses the whole batch with its reasons; one it
   * would refuse in every setup is refused here, before the batch is sent.
   */
  const lengthChecks = async (snapshot: BoardSnapshot | null, ops: readonly BoardOp[]): Promise<PromptLimitCheck[]> => {
    const runs = ops.filter(op => op.type === 'run_generation' && typeof op.nodeId === 'string')
    if (runs.length === 0 || snapshot === null) return []
    let after: BoardSnapshot
    try {
      after = applyBoardOps(snapshot, ops.filter(op => op.type !== 'run_generation'))
    } catch {
      // A batch only the page can replay (a node type of a plugin): the page judges it.
      return []
    }
    const targets = runs.map(op => after.nodes?.find(node => node.id === op.nodeId)).filter((node): node is BoardNode => node !== undefined)
    const catalogs: OptionCatalogs = {
      ...(targets.some(node => isRecord(node.metadata?.cameraMove)) ? { moves: await optionalCatalog('camera-moves') } : {}),
      ...(targets.some(node => isRecord(node.metadata?.cameraControl)) ? { camera: await optionalCatalog('camera-control') } : {}),
    }
    return runs.flatMap((op) => {
      const check = promptLimitCheck(after, { nodeId: op.nodeId as string, mode: op.mode, prompt: op.prompt }, catalogs)
      return check === undefined ? [] : [check]
    })
  }

  const overLimit = (checks: readonly PromptLimitCheck[]): FilmToolError => new FilmToolError('CANVAS_PROMPT_OVER_LIMIT',
    `With what the storyboard adds when it sends it (${addedBy(checks)}), the prompt of ${checks.map(check => `${check.nodeId} would be ${check.length} characters`).join(' and ')}, `
    + `over the ${PROMPT_LIMIT_LENGTH} the storyboard sends: the page would refuse to generate, so nothing was sent or changed. Shorten the prompt or the text wired `
    + 'into it, or clear a setting with canvas_set_generation_options (only what composition adds is refused: a prompt the person wrote past the limit is sent as it is).')

  /**
   * Run a batch on the open page. When the page refuses its runs (it checks
   * each before answering), its own reasons come back word for word.
   */
  const applyOnPage = async (page: BoardPage, film: FilmWorkspace, ops: BoardOp[], signal: AbortSignal | undefined): Promise<unknown> => {
    try {
      return await services.boardAgent.call(page.target, 'canvas_apply_ops', { ops, boardId: film.boardId, project: film.projectId }, { signal })
    } catch (error) {
      if (error instanceof BoardAgentError && error.code === 'CANVAS_BOARD_REFUSED' && error.message.startsWith(GENERATION_REFUSED)) {
        throw new FilmToolError('CANVAS_BOARD_REFUSED', `CANVAS_BOARD_REFUSED: ${error.message} — The storyboard page checked these runs before starting them and refused the `
          + 'whole batch for the reason above, in its own words: nothing was applied, generated or billed. Fix what it names (shorten the prompt, clear a setting with '
          + 'canvas_set_generation_options, wire the missing reference, pick a model) and run again.')
      }
      throw error
    }
  }

  /**
   * Run a write: on the open page as ops, or on the saved board under its lock.
   * `compile` turns the board as it is into the ops, plus what the answer
   * reports besides the changes; a write that compiles to no ops saves nothing.
   */
  const write = (tool: CanvasWriteTool, exec: ToolRunContext, args: Record<string, unknown>,
    compile: (snapshot: BoardSnapshot | null) => { ops: BoardOp[]; report?: Record<string, unknown> } = snapshot => ({ ops: buildBoardOps(tool, args, snapshot) })) => guarded(async () => {
    const film = await filmWorkspace(exec)
    const { page, snapshot } = await board(film, args.target)
    if (page !== undefined) {
      const { ops, report } = compile(snapshot)
      if (ops.length === 0) return plain({ ...where(page), changed: false, ...report })
      // Refused in every setup: refused here. A run only some setups refuse is the page's to judge (it answers with its reason).
      const refused = (await lengthChecks(snapshot, ops)).filter(check => check.refused === 'certain')
      if (refused.length > 0) throw overLimit(refused)
      const result = await applyOnPage(page, film, ops, exec.signal)
      const receipt = mutationReceipt(snapshot, result)
      return plain({ ...where(page), ...(isRecord(receipt) ? receipt : { result: receipt }), ...report })
    }
    if (tool === 'canvas_run_generation' || (tool === 'canvas_create_generation_flow' && args.autoRun === true)) {
      throw new FilmToolError('CANVAS_BOARD_NOT_OPEN', 'Running a generation needs the storyboard page open (the 分镜 tab of the film workbench). '
        + 'Ask the person to open it, or stage the flow with autoRun:false, or generate with the media tools and attach the file with canvas_attach_media.')
    }
    let before: BoardSnapshot | null = null
    let after: BoardSnapshot | null = null
    let report: Record<string, unknown> | undefined
    try {
      await store(film).update((current) => {
        if (current !== null && current.id !== film.boardId) {
          throw new FilmToolError('CANVAS_BOARD_MISMATCH', `The saved board (${current.id}) is not this film's board (${film.boardId}); open the 分镜 tab to repair it.`)
        }
        // A film from before boards came with it may still have none.
        const base = current ?? emptyFilmBoard(film.boardId, film.project.title)
        before = snapshotOfDocument(base)
        const compiled = compile(before)
        report = compiled.report
        if (compiled.ops.length === 0) throw new NothingToSave()
        after = applyBoardOps(before, compiled.ops)
        return { ...base, nodes: after.nodes ?? [], connections: after.connections ?? [], viewport: after.viewport, updatedAt: new Date().toISOString() }
      })
    } catch (error) {
      if (error instanceof NothingToSave) return plain({ ...where(undefined), changed: false, ...report })
      throw error
    }
    services.events.emit(film.cwd, { type: 'story-canvas-changed', projectId: film.projectId, boardId: film.boardId })
    const receipt = mutationReceipt(before, after)
    return plain({ ...where(undefined), ...(isRecord(receipt) ? receipt : {}), ...report })
  })

  /** The generation settings a call names, checked against the canvas catalogues: unknown ids are refused with the valid ones. */
  const checkSettings = async (args: { cameraMove?: CameraMoveInput; cameraControl?: CameraControlInput; preset?: string; skills?: SkillInput[] }): Promise<{
    cameraMove?: CameraMoveSetting; cameraControl?: CameraControlInput; preset?: PresetSettings; skills?: CheckedSkill[]; catalogs: OptionCatalogs; adjusted: string[]
  }> => {
    if (args.skills !== undefined && args.skills.length === 0) {
      throw new CanvasToolError('CANVAS_OPTION_INVALID', 'skills lists 1–3 skills (ids from canvas_generation_options kind skills). To remove a node\'s skills, pass clear: ["skills"].')
    }
    const preset = args.preset !== undefined ? findPreset(args.preset, await catalog('generation-presets')) : undefined
    const catalogs: OptionCatalogs = {
      ...(args.cameraMove !== undefined || preset?.cameraMove !== undefined ? { moves: await catalog('camera-moves') } : {}),
      ...(args.cameraControl !== undefined || preset?.cameraControl !== undefined ? { camera: await catalog('camera-control') } : {}),
      ...(args.skills !== undefined || (preset?.skills !== undefined && preset.skills.length > 0) ? { skills: await catalog('vibedev-skills') } : {}),
    }
    const move = args.cameraMove !== undefined ? checkCameraMoveInput(args.cameraMove, catalogs.moves!) : undefined
    const camera = args.cameraControl !== undefined ? checkCameraControlInput(args.cameraControl, catalogs.camera!) : undefined
    const skills = args.skills !== undefined ? checkSkillInputs(args.skills, catalogs.skills!) : undefined
    return {
      ...(move !== undefined ? { cameraMove: move.setting } : {}),
      ...(camera !== undefined ? { cameraControl: camera.input } : {}),
      ...(preset !== undefined ? { preset: presetSettings(preset, catalogs) } : {}),
      ...(skills !== undefined ? { skills } : {}),
      catalogs,
      adjusted: [...move?.adjusted ?? [], ...camera?.adjusted ?? []],
    }
  }

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
        + 'canvas_read_node); bulky ones such as a director scene are listed in omittedFields. Generation settings are in metadata too (cameraMove, cameraControl, '
        + 'frameRoles; promptSkills and a skill node\'s skillSnapshot as ids, kinds, names and variables, without their templates). Call this before changing the '
        + 'board so ids are real; never guess ids or reuse an array index from an earlier read.',
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
        + 'prompts or image bodies. A generation (config) node lists outputNodeIds: query those, its own acknowledgement is not an output. A node\'s error is '
        + 'the reason the page recorded on it (nodeStatus error): a run it stopped before anything was sent (a reference the model refuses, a prompt over the '
        + 'limit) or a generation node whose outputs failed. Status comes from the board, not a fresh provider poll; outputs[].task names a media task when '
        + 'one was recorded. An interrupted or missing result is not authorization to pay for the generation again.',
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
      description: 'Read a bounded page of the SAVED board — nodes with their content previews, prompts, statuses, media task ids and generation settings '
        + '(metadata.cameraMove, metadata.cameraControl, metadata.promptSkills, metadata.frameRoles — the first and last frame images, which apply only in video '
        + 'mode image-to-video or first-last-frame — and a skill node\'s skill), and their links — whether or not a page is open. This is persisted state, not the '
        + 'live selection or unsaved edits. Follow nextOffset, or pass nodeId for one node: that view '
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
        + 'Returns the board acknowledgement, not a finished generation. autoRun needs the storyboard page open. cameraMove (video), cameraControl, skills, '
        + 'frameRoles (video) and preset are stored on the generation node as with canvas_set_generation_options; a skill with as: "node" becomes a skill node '
        + 'wired into it.' + WRITE_REPLY,
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
        cameraMove: { ...cameraMoveParameter, description: 'Video flows only: the camera move (运镜) the storyboard appends when it generates.' },
        cameraControl: { ...cameraControlParameter, description: 'Image and video flows: the camera settings (相机); fields left out take the defaults.' },
        skills: { ...skillsParameter, description: `${skillsParameter.description} Only skills of the flow's mode.` },
        frameRoles: { ...frameRolesParameter, description: `Video flows only: ${frameRolesParameter.description} The ids are images among referenceNodeIds.` },
        preset: { ...presetParameter, description: 'A preset id (canvas_generation_options kind presets): fills the mode and the settings it names that this call leaves out.' },
      },
      output: jsonOutput,
      execute: (args, exec) => guarded(async () => {
        const checked = await checkSettings(args)
        const preset = checked.preset
        if (preset !== undefined && args.mode !== undefined && args.mode !== preset.preset.mode) {
          throw new CanvasToolError('CANVAS_OPTION_MODE', `${preset.preset.id} is a ${preset.preset.mode} preset; this flow's mode is ${args.mode}.`)
        }
        const mode = args.mode ?? preset?.preset.mode ?? 'image'
        if (checked.cameraMove !== undefined && mode !== 'video') {
          throw new CanvasToolError('CANVAS_OPTION_MODE', `Camera moves are for video; this flow's mode is ${mode}. Pass mode "video", or leave cameraMove out.`)
        }
        if (checked.cameraControl !== undefined && mode !== 'image' && mode !== 'video') {
          throw new CanvasToolError('CANVAS_OPTION_MODE', `Camera settings are for image and video generation; this flow's mode is ${mode}.`)
        }
        if (args.frameRoles !== undefined && mode !== 'video') {
          throw new CanvasToolError('CANVAS_OPTION_MODE', `First and last frames are for video; this flow's mode is ${mode}.`)
        }
        const frameRoles = args.frameRoles !== undefined ? checkFrameRolesInput(args.frameRoles) : undefined
        for (const skill of checked.skills ?? []) {
          if (!skillTakesMode(skill.entry, mode)) {
            throw new CanvasToolError('CANVAS_OPTION_MODE', `${skill.entry.id} (${skill.entry.name.zh}) is for ${skill.entry.appliesTo.join(' and ')} generation; this flow's mode is ${mode}.`)
          }
        }
        // What the preset names fills what the call leaves out.
        const fromPreset = preset?.metadata ?? {}
        const seconds = args.seconds ?? fromPreset.seconds
        const skills = flowSkills(checked.skills ?? [], preset, typeof seconds === 'string' && seconds.trim() !== '' ? seconds : undefined, checked.catalogs.skills?.catalogVersion ?? '')
        const input: Record<string, unknown> = {
          ...args,
          mode,
          model: args.model ?? fromPreset.model,
          size: args.size ?? fromPreset.size,
          // The call's count, else the preset's, else one image for a design sheet (as the canvas attaches a sheet skill).
          count: args.count ?? fromPreset.count ?? skills.purpose.count,
          seconds,
          generateAudio: args.generateAudio ?? (fromPreset.generateAudio === undefined ? undefined : fromPreset.generateAudio === 'true'),
        }
        const cameraMove = checked.cameraMove ?? fromPreset.cameraMove
        const cameraControl = checked.cameraControl !== undefined ? mergeCameraControl(checked.cameraControl, fromPreset.cameraControl, checked.catalogs.camera!) : fromPreset.cameraControl
        const settings: Record<string, unknown> = {
          ...(fromPreset.vquality !== undefined ? { vquality: fromPreset.vquality } : {}),
          ...(fromPreset.videoMode !== undefined ? { videoMode: fromPreset.videoMode } : {}),
          ...(cameraMove !== undefined ? { cameraMove } : {}),
          ...(cameraControl !== undefined ? { cameraControl } : {}),
          ...(skills.skills.length > 0 ? { promptSkills: skills.skills } : {}),
          ...(skills.purpose.promptPurpose !== undefined ? { promptPurpose: skills.purpose.promptPurpose } : {}),
        }
        const notes = [...skills.notes]
        for (const skill of skills.skills) {
          if (mode === 'video' && skill.snapshot.videoModes !== undefined && !skillApplies(skill.snapshot, 'video', settings.videoMode)) {
            notes.push(`${skill.id} applies only in video mode ${skill.snapshot.videoModes.join(' or ')}: it is kept on the generation node but not composed until its video mode is one of them`)
          }
        }
        if (frameRoles !== undefined && !usesFrameRoles(settings.videoMode)) {
          notes.push('First and last frames apply only once the generation node\'s video mode is image-to-video (图生视频) or first-last-frame (首尾帧); save one of them '
            + 'with canvas_apply_ops update_node metadata.videoMode if its model offers it (media_models lists a model\'s modes).')
        }
        const report = {
          ...(preset !== undefined ? { preset: preset.preset.id } : {}),
          ...(preset !== undefined && preset.skipped.length > 0 ? { skipped: preset.skipped } : {}),
          ...(checked.adjusted.length > 0 ? { adjusted: checked.adjusted } : {}),
          ...(notes.length > 0 ? { notes } : {}),
        }
        return write('canvas_create_generation_flow', exec, input, (snapshot) => {
          const ops = buildBoardOps('canvas_create_generation_flow', input, snapshot, { configMetadata: settings, skillNodes: skills.nodes })
          if (frameRoles !== undefined) flowFrameRoles(ops, snapshot, frameRoles)
          return { ops, report }
        })
      }),
    }),
    defineTool({
      name: 'canvas_generation_options',
      description: 'List what a generation node\'s settings can be on this storyboard: camera moves (运镜; kind camera_moves), camera settings (相机: looks, lenses, '
        + 'focal lengths, apertures, shot sizes and angles; kind camera), prompt skills (提示词技能: VibeDev prompt templates, not agent skills; kind skills) and '
        + 'generation presets (kind presets), with the ids canvas_set_generation_options and canvas_create_generation_flow take. Read from the storyboard\'s own '
        + 'build, so they are the ones the page uses. Free; nothing changes.',
      parameters: {
        kind: { type: 'string', required: true, enum: ['camera_moves', 'camera', 'skills', 'presets'] },
        mode: { type: 'string', enum: ['image', 'video', 'text'], description: 'Only what applies to this generation mode.' },
        category: { type: 'string', description: 'camera_moves: one category id (push, pull, pan, …); skills: one skill category (storyboard, design-sheet, …).' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute: args => guarded(async () => {
        if (args.category !== undefined && args.kind !== 'camera_moves' && args.kind !== 'skills') {
          throw new CanvasToolError('CANVAS_OPTION_UNKNOWN', `category filters camera_moves and skills only; ${args.kind} has no categories.`)
        }
        if (args.kind === 'skills') {
          const skills = await catalog('vibedev-skills')
          if (args.category !== undefined && !(PROMPT_SKILL_CATEGORIES as readonly string[]).includes(args.category)) {
            throw new CanvasToolError('CANVAS_OPTION_UNKNOWN', `Unknown skill category "${args.category}". The categories: ${PROMPT_SKILL_CATEGORIES.join(', ')}.`)
          }
          return plain({
            catalogVersion: skills.catalogVersion,
            kind: args.kind,
            categories: PROMPT_SKILL_CATEGORIES.filter(category => skills.skills.some(skill => skill.category === category)),
            items: skills.skills
              .filter(skill => (args.mode === undefined || (skill.appliesTo as readonly string[]).includes(args.mode)) && (args.category === undefined || skill.category === args.category))
              .map(skill => ({
                id: skill.id, version: skill.version, name: skill.name, summary: skill.summary, category: skill.category, kind: skill.kind, appliesTo: skill.appliesTo,
                ...(skill.videoModes !== undefined ? { videoModes: skill.videoModes } : {}),
                ...(skill.purpose !== undefined ? { purpose: skill.purpose } : {}),
                variables: skill.variables, composes: skill.composes, template: skill.template,
                ...(skill.negative !== undefined ? { negative: skill.negative } : {}),
                ...(skill.notes !== undefined ? { notes: skill.notes } : {}),
                tags: skill.tags,
              })),
            note: 'Prompt skills are VibeDev prompt templates the storyboard composes into the prompt when the node is generated — not agent skills, and never text to '
              + 'copy into a prompt. A wrap skill puts the node\'s prompt where {{prompt}} stands; an append skill adds its lines after it. A node composes at most one '
              + 'wrap and two append skills, its own and those of skill nodes wired into it together (its own wrap skill wins). Attach them with '
              + 'canvas_set_generation_options skills [{ id, vars? }] or put one on a skill node with as: "node", which applies it to every image, video and generation '
              + 'node it is wired into. Fill the required variables; a variable left out takes its default, and an auto one the duration the node sends. composes '
              + 'says what a skill does with the camera move and camera lines: slot (fills its {{motion}} / {{camera}}), append (the line stays) or drop (left out). A '
              + 'skill applies only in the modes it lists, and with videoModes only while the node\'s video mode is one of them. A skill with a purpose also sets the '
              + 'node\'s 制作类型 (a design sheet is one image). Use one only when it fits the request.',
          })
        }
        if (args.kind === 'camera_moves') {
          const moves = await catalog('camera-moves')
          if (args.category !== undefined && !moves.categories.some(category => category.id === args.category)) {
            throw new CanvasToolError('CANVAS_OPTION_UNKNOWN', `Unknown category "${args.category}". The categories: ${moves.categories.map(category => `${category.id} (${category.zh})`).join(', ')}.`)
          }
          const applies = args.mode === undefined || args.mode === 'video'
          return plain({
            catalogVersion: moves.catalogVersion,
            kind: args.kind,
            categories: moves.categories,
            speeds: moves.speeds,
            items: applies
              ? moves.moves.filter(move => args.category === undefined || move.category === args.category).map(move => ({
                id: move.id, category: move.category, name: move.name, summary: move.summary, speedable: move.speedable,
                ...(move.defaultSpeed !== undefined ? { defaultSpeed: move.defaultSpeed } : {}),
                ...(move.exclusive === true ? { exclusive: true } : {}),
                ...(move.bestEffort === true ? { bestEffort: true } : {}),
              }))
              : [],
            note: applies
              ? 'Camera moves are for video (video nodes and generation nodes in video mode). Set them with cameraMove { moves: [{ id, speed? }], combine? }: 1–3 moves, '
                + 'the first is the main one; an exclusive move stands alone; speed only on speedable moves (default steady, or defaultSpeed); bestEffort moves are hard '
                + 'for current models. The storyboard appends them as one 运镜 line when it generates.'
              : 'Camera moves are for video generation only.',
          })
        }
        if (args.kind === 'camera') {
          const camera = await catalog('camera-control')
          const applies = args.mode !== 'text'
          return plain({
            catalogVersion: camera.catalogVersion,
            kind: args.kind,
            items: applies
              ? {
                  looks: camera.looks.map(entry => ({ id: entry.id, name: entry.name })),
                  lenses: camera.lenses.map(entry => ({ id: entry.id, name: entry.name })),
                  focalLengths: camera.focalLengths,
                  apertures: camera.apertures,
                  shotSizes: camera.shotSizes,
                  angles: camera.angles,
                }
              : {},
            defaults: camera.defaults,
            note: applies
              ? 'Camera settings go on image, video and generation nodes (not panoramas). Set them with cameraControl { look?, lens?, focalLength?, aperture?, '
                + 'shotSize?, angle?, enabled? }: fields left out keep the node\'s current ones (or the defaults), and focal length and aperture snap to the nearest '
                + 'listed stop. The storyboard appends one camera line when it generates: it describes the rendering and tells the model to show no camera or equipment.'
              : 'Camera settings are for image and video generation only.',
          })
        }
        const presets = await catalog('generation-presets')
        return plain({
          catalogVersion: presets.catalogVersion,
          kind: args.kind,
          items: presets.presets.filter(preset => args.mode === undefined || preset.mode === args.mode),
          note: 'Apply a preset with canvas_set_generation_options preset (to nodes of its mode) or canvas_create_generation_flow preset: it fills the settings it names '
            + 'and attaches its prompt skills. The page fits duration, ratio, resolution and count to the node\'s model when it generates.',
        })
      }),
    }),
    defineTool({
      name: 'canvas_set_generation_options',
      description: 'Set or clear generation settings on 1–50 image, video or generation (config) nodes: cameraMove (运镜; video only), cameraControl (相机: look, '
        + 'lens, focal length, aperture, optional shot size and angle; fields left out keep the node\'s current ones), skills (提示词技能: prompt skills attached '
        + 'to each node, or as: "node" for one skill node wired into the nodes), frameRoles (首帧 / 尾帧: which wired image is the first and the last frame; video '
        + 'only) or a preset (fills the settings it names and attaches its skills); clear removes a setting (stored as null; with skills given too, clear '
        + '["skills"] replaces the node\'s skills). Ids come from canvas_generation_options; an unknown id is refused with the valid ones. These are node settings '
        + 'the storyboard composes into the prompt when it generates — never write them into prompt text. Answers applied: per node what was set, cleared or '
        + 'skipped and why, and for skills how each takes part (state active, or why not). With the 分镜 tab open the change runs in the page (live, '
        + 'undoable); closed, it is saved to the board. Nothing is generated.' + WRITE_REPLY,
      parameters: {
        target,
        nodeIds: { type: 'array', required: true, items: { type: 'string' }, description: '1–50 image, video or generation node ids from canvas_get_state.' },
        cameraMove: { ...cameraMoveParameter, description: 'Replaces the camera move (运镜) of the video nodes and video-mode generation nodes.' },
        cameraControl: { ...cameraControlParameter, description: 'Camera settings (相机): given fields over the node\'s current ones, or over the defaults.' },
        skills: {
          ...skillsParameter,
          description: `${skillsParameter.description} Attached skills join the node's own (a wrap skill replaces its wrap skill; a skill it has keeps its frozen `
            + 'version and takes the values given); a skill node is added once (one with the same skill and values is reused) and wired into the nodes it applies to.',
        },
        frameRoles: { ...frameRolesParameter, description: `${frameRolesParameter.description} Video nodes and video-mode generation nodes only.` },
        preset: { ...presetParameter, description: 'A preset id (canvas_generation_options kind presets); applies to nodes of its mode.' },
        clear: {
          type: 'array',
          items: { type: 'string', enum: ['cameraMove', 'cameraControl', 'skills', 'frameRoles'] },
          description: 'Settings to remove (stored as null). "skills" removes the node\'s own skills (skill nodes stay wired: delete them with canvas_delete_nodes).',
        },
      },
      output: jsonOutput,
      execute: (args, exec) => guarded(async () => {
        const ids = args.nodeIds
        if (ids.length === 0 || ids.length > 50 || ids.some(id => id.trim() === '') || new Set(ids).size !== ids.length) {
          throw new CanvasToolError('CANVAS_OPTION_INVALID', 'nodeIds lists 1–50 distinct node ids from canvas_get_state.')
        }
        const clear = [...new Set(args.clear ?? [])] as ClearableOption[]
        if (args.cameraMove === undefined && args.cameraControl === undefined && args.skills === undefined && args.frameRoles === undefined && args.preset === undefined
          && clear.length === 0) {
          throw new CanvasToolError('CANVAS_OPTION_INVALID', 'Pass cameraMove, cameraControl, skills, frameRoles, preset or clear.')
        }
        // Clearing skills while attaching some replaces them; any other setting both given and cleared is ambiguous.
        const both = clear.find(field => field !== 'skills' && args[field] !== undefined)
        if (both !== undefined) throw new CanvasToolError('CANVAS_OPTION_INVALID', `${both} is both set and cleared; pass one of them.`)
        const frameRoles: FrameRolesInput | undefined = args.frameRoles !== undefined ? checkFrameRolesInput(args.frameRoles) : undefined
        const checked = await checkSettings(args)
        const options = {
          nodeIds: ids,
          ...(checked.cameraMove !== undefined ? { cameraMove: checked.cameraMove } : {}),
          ...(checked.cameraControl !== undefined ? { cameraControl: checked.cameraControl } : {}),
          ...(checked.preset !== undefined ? { preset: checked.preset } : {}),
          ...(checked.skills !== undefined ? { skills: checked.skills } : {}),
          ...(frameRoles !== undefined ? { frameRoles } : {}),
          clear,
          catalogs: checked.catalogs,
        }
        // Both catalogues where the build has them: a node keeps settings this call does not touch.
        const lengthCatalogs: OptionCatalogs = {
          moves: checked.catalogs.moves ?? await optionalCatalog('camera-moves'),
          camera: checked.catalogs.camera ?? await optionalCatalog('camera-control'),
        }
        return write('canvas_set_generation_options', exec, args, (snapshot) => {
          const plan = planGenerationOptions(options, snapshot)
          // Whether the settings now push a changed node's prompt past the limit, generated from its own panel.
          const after = snapshot !== null && plan.ops.length > 0 ? applyBoardOps(snapshot, plan.ops) : null
          const limits = after === null ? [] : plan.applied.filter(entry => entry.changed || entry.skillNodes !== undefined).flatMap((entry) => {
            const check = promptLimitCheck(after, { nodeId: entry.nodeId }, lengthCatalogs)
            return check === undefined ? [] : [check]
          })
          return {
            ops: plan.ops,
            report: {
              applied: plan.applied,
              ...(plan.skillNodes.length > 0 ? { skillNodes: plan.skillNodes } : {}),
              ...(checked.adjusted.length > 0 ? { adjusted: checked.adjusted } : {}),
              ...(checked.preset !== undefined ? { note: 'The page fits a preset\'s duration, ratio, resolution and count to each node\'s model when it generates.' } : {}),
              ...(limits.length > 0 ? {
                warnings: limits.map(check => ({
                  code: 'CANVAS_PROMPT_OVER_LIMIT', nodeId: check.nodeId, length: check.length, limit: check.limit, certain: check.refused === 'certain',
                  note: `With what the storyboard adds when it sends it (${addedBy([check])}) this node's prompt would be ${check.length} characters, over the `
                    + `${check.limit} the storyboard sends, so generating it ${check.refused === 'certain' ? 'is' : 'may be'} refused. Shorten the prompt or clear a setting.`,
                })),
              } : {}),
            },
          }
        })
      }),
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
