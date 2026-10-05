/**
 * What the agent's canvas tools say and how their answers read, ported from
 * Studio's board agent (apps/daemon/src/canvas-board-agent.ts,
 * canvas-board-document.ts, services/canvas-generation-status.ts).
 *
 * The write tools are sugar: each compiles to the board's op vocabulary, the
 * only one the page's executor has. Reads come from a board snapshot — the
 * open page's, or the saved document's when no page is open — trimmed before
 * it reaches a model: a board carries prompts, data URLs and whole director
 * scenes, and the whole of one is neither useful nor affordable.
 * @module dsh-film/canvas/board-tools
 */

import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { validateBoardOps } from './board-ops.js'
import type { BoardConnection, BoardNode, BoardOp, BoardSnapshot } from './board-ops.js'
import { compactCameraControl, compactCameraMove, planGenerationOptions } from './generation-options.js'
import type { CheckedGenerationOptions } from './generation-options.js'
import { CanvasToolError } from './tool-error.js'

export { CanvasToolError } from './tool-error.js'

export const CANVAS_WRITE_TOOLS = [
  'canvas_apply_ops',
  'canvas_create_text_nodes',
  'canvas_create_generation_flow',
  'canvas_set_generation_options',
  'canvas_run_generation',
  'canvas_connect_nodes',
  'canvas_delete_nodes',
] as const

export type CanvasWriteTool = (typeof CANVAS_WRITE_TOOLS)[number]

/** What some write tools compile with besides their arguments: values already checked against the canvas catalogues. */
export interface BoardOpsContext {
  /** canvas_create_generation_flow: generation settings stored on the new generation node (camera move, camera, preset fields). */
  configMetadata?: Record<string, unknown>
  /** canvas_set_generation_options: the options, checked. */
  generationOptions?: CheckedGenerationOptions
}

type GenerationMode = 'text' | 'image' | 'video' | 'audio'

function generationMode(value: unknown): GenerationMode {
  return value === 'text' || value === 'video' || value === 'audio' ? value : 'image'
}

function generationTitle(mode: GenerationMode): string {
  if (mode === 'text') return '文本生成'
  if (mode === 'video') return '视频生成'
  if (mode === 'audio') return '音频生成'
  return '图片生成'
}

/** Where new nodes go when the caller does not say: right of everything, so a batch never lands on existing work. */
function nextX(snapshot: BoardSnapshot | null): number {
  const nodes = snapshot?.nodes ?? []
  return nodes.length > 0 ? Math.max(...nodes.map(node => node.position.x + node.width)) + 80 : 0
}

function withoutBlanks(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''))
}

function textNodeOp(input: { id?: string; text?: string; title?: string }, x: number, y: number): BoardOp {
  return {
    type: 'add_node',
    ...(input.id !== undefined ? { id: input.id } : {}),
    nodeType: 'text',
    ...(input.title !== undefined && input.title !== '' ? { title: input.title } : {}),
    position: { x, y },
    metadata: { content: input.text ?? '', status: 'success', fontSize: 14 },
  }
}

function configNodeOp(id: string, input: Record<string, unknown>, x: number, y: number, settings: Record<string, unknown> = {}): BoardOp {
  const mode = generationMode(input.mode)
  const prompt = String(input.prompt ?? '')
  return {
    type: 'add_node',
    id,
    nodeType: 'config',
    title: typeof input.title === 'string' && input.title !== '' ? input.title : generationTitle(mode),
    position: { x, y },
    metadata: withoutBlanks({
      generationMode: mode,
      composerContent: prompt,
      prompt,
      status: 'idle',
      model: input.model,
      size: input.size,
      count: input.count,
      seconds: input.seconds,
      // A video model that declares native audio speaks the line only when asked.
      generateAudio: input.generateAudio,
      // Settings the page composes into the prompt when it generates (camera move, camera), never prompt text.
      ...settings,
    }),
  }
}

/**
 * A prompt node, a generation node, and the wires into it — the shape a person
 * builds by hand, so the prompt stays a visible, editable node.
 * @param input - the tool's arguments.
 * @param snapshot - the board, for placement.
 * @param settings - generation settings for the generation node, already checked against the catalogues.
 * @returns the ops.
 */
export function generationFlowOps(input: Record<string, unknown>, snapshot: BoardSnapshot | null, settings: Record<string, unknown> = {}): BoardOp[] {
  const mode = generationMode(input.mode)
  const prompt = String(input.prompt ?? '')
  const x = typeof input.x === 'number' ? input.x : nextX(snapshot)
  const y = typeof input.y === 'number' ? input.y : 0
  const textId = `text-${randomUUID()}`
  const configId = `config-${randomUUID()}`
  const referenceNodeIds = Array.isArray(input.referenceNodeIds) ? input.referenceNodeIds.filter((id): id is string => typeof id === 'string') : []
  const tokens = [`@[node:${textId}]`, ...referenceNodeIds.map(id => `@[node:${id}]`)]
  return [
    textNodeOp({ id: textId, text: prompt, title: typeof input.title === 'string' && input.title !== '' ? input.title : '提示词' }, x, y),
    configNodeOp(configId, { ...input, prompt: tokens.join('\n') }, x + 420, y, settings),
    { type: 'connect_nodes', fromNodeId: textId, toNodeId: configId },
    ...referenceNodeIds.map(fromNodeId => ({ type: 'connect_nodes', fromNodeId, toNodeId: configId })),
    { type: 'select_nodes', ids: [configId] },
    // Staged, not run, unless asked: building the flow is free and reviewable; running it may be billed.
    ...(input.autoRun === true ? [{ type: 'run_generation', nodeId: configId, mode, prompt: tokens.join('\n') }] : []),
  ]
}

/**
 * Compile a write tool's call into the ops the board runs.
 * @param tool - the tool.
 * @param input - its arguments.
 * @param snapshot - the board, for placement.
 * @param context - what the tool checked against the canvas catalogues before compiling.
 * @returns the ops.
 */
export function buildBoardOps(tool: CanvasWriteTool, input: Record<string, unknown>, snapshot: BoardSnapshot | null, context: BoardOpsContext = {}): BoardOp[] {
  switch (tool) {
    case 'canvas_apply_ops': {
      const ops = input.ops
      if (!Array.isArray(ops) || ops.length === 0) throw new CanvasToolError('CANVAS_BOARD_INVALID', 'ops must be a non-empty array')
      const error = validateBoardOps(ops)
      if (error !== undefined) throw new CanvasToolError('CANVAS_OP_INVALID', error)
      return ops as BoardOp[]
    }
    case 'canvas_create_text_nodes': {
      const items = Array.isArray(input.items) ? input.items as Array<Record<string, unknown>> : []
      if (items.length === 0) throw new CanvasToolError('CANVAS_BOARD_INVALID', 'items must be a non-empty array')
      const x = typeof input.x === 'number' ? input.x : nextX(snapshot)
      const y = typeof input.y === 'number' ? input.y : 0
      const gap = typeof input.gap === 'number' ? input.gap : 40
      const row = input.direction !== 'column'
      return items.map((item, index) => textNodeOp(
        { text: String(item.text ?? ''), ...(typeof item.title === 'string' ? { title: item.title } : {}) },
        row ? x + index * (340 + gap) : x,
        row ? y : y + index * (240 + gap),
      ))
    }
    case 'canvas_create_generation_flow':
      return generationFlowOps(input, snapshot, context.configMetadata)
    case 'canvas_set_generation_options': {
      // One update_node per node whose settings change; values were checked against the catalogues first.
      if (context.generationOptions === undefined) throw new CanvasToolError('CANVAS_BOARD_INVALID', 'generation options must be checked against the canvas catalogues first')
      return planGenerationOptions(context.generationOptions, snapshot).ops
    }
    case 'canvas_run_generation': {
      const nodeId = typeof input.nodeId === 'string' ? input.nodeId : ''
      if (nodeId === '') throw new CanvasToolError('CANVAS_BOARD_INVALID', 'nodeId is required')
      return [{
        type: 'run_generation',
        nodeId,
        // The page resolves an omitted mode from the staged node; a video flow must not restart as an image.
        ...(input.mode !== undefined ? { mode: generationMode(input.mode) } : {}),
        ...(typeof input.prompt === 'string' && input.prompt !== '' ? { prompt: input.prompt } : {}),
      }]
    }
    case 'canvas_connect_nodes': {
      const connections = Array.isArray(input.connections) ? input.connections as Array<Record<string, unknown>> : []
      if (connections.length === 0) throw new CanvasToolError('CANVAS_BOARD_INVALID', 'connections must be a non-empty array')
      return connections.map(connection => ({ type: 'connect_nodes', fromNodeId: String(connection.fromNodeId ?? ''), toNodeId: String(connection.toNodeId ?? '') }))
    }
    case 'canvas_delete_nodes': {
      const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === 'string') : []
      if (ids.length === 0) throw new CanvasToolError('CANVAS_BOARD_INVALID', 'ids must be a non-empty array')
      return [{ type: 'delete_node', ids }]
    }
  }
}

/** Fields read exactly with canvas_read_node. */
export type NodeTextField = 'content' | 'prompt' | 'composerContent'
const TEXT_FIELDS: readonly NodeTextField[] = ['content', 'composerContent', 'prompt']

/** A node as a model reads it. */
export interface CompactNode extends BoardNode {
  /** Text fields shortened here; read them exactly with canvas_read_node. */
  truncatedFields?: Array<{ field: NodeTextField; totalLength: number; previewLength: number }>
  /** Bulky metadata (a director scene, inline data) left out; canvas_get_document reads a saved node. */
  omittedFields?: string[]
}

function compactNode(node: BoardNode): CompactNode {
  const metadata: Record<string, unknown> = { ...(node.metadata ?? {}) }
  const truncatedFields: NonNullable<CompactNode['truncatedFields']> = []
  const omittedFields: string[] = []
  for (const [key, value] of Object.entries(metadata)) {
    if ((TEXT_FIELDS as readonly string[]).includes(key)) {
      if (typeof value === 'string' && value.startsWith('data:')) {
        metadata[key] = '[inline data omitted]'
        omittedFields.push(key)
      } else if (typeof value === 'string' && value.length > 240) {
        metadata[key] = `${value.slice(0, 120)}…`
        truncatedFields.push({ field: key as NodeTextField, totalLength: value.length, previewLength: 120 })
      }
      continue
    }
    if (typeof value === 'string' && (value.startsWith('data:') || value.length > 2000)) {
      metadata[key] = value.startsWith('data:') ? '[inline data omitted]' : `[${value.length} characters omitted]`
      omittedFields.push(key)
    } else if (value !== null && typeof value === 'object' && JSON.stringify(value).length > 2000) {
      metadata[key] = `[${Array.isArray(value) ? 'list' : 'object'} omitted]`
      omittedFields.push(key)
    }
  }
  return {
    ...node,
    metadata,
    ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
    ...(omittedFields.length > 0 ? { omittedFields } : {}),
  }
}

/**
 * A board trimmed for a model.
 * @param snapshot - the board.
 * @returns the same board with long and bulky fields shortened.
 */
export function compactSnapshot(snapshot: BoardSnapshot): BoardSnapshot {
  return { ...snapshot, nodes: (snapshot.nodes ?? []).map(compactNode) }
}

/**
 * A write's answer: what changed, not another dump of the board.
 * @param before - the board before.
 * @param after - the board the write produced.
 * @returns changed nodes and connections, what was removed, and the board's totals.
 */
export function mutationReceipt(before: BoardSnapshot | null, after: unknown): unknown {
  if (after === null || typeof after !== 'object' || !Array.isArray((after as BoardSnapshot).nodes)) return after
  const board = after as BoardSnapshot
  const previousNodes = new Map((before?.nodes ?? []).map(node => [node.id, node]))
  const previousConnections = new Map((before?.connections ?? []).map(connection => [connection.id, connection]))
  const nodeIds = new Set(board.nodes!.map(node => node.id))
  const connectionIds = new Set((board.connections ?? []).map(connection => connection.id))
  return {
    ...compactSnapshot({
      ...board,
      nodes: board.nodes!.filter(node => !isDeepStrictEqual(previousNodes.get(node.id), node)),
      connections: (board.connections ?? []).filter(connection => !isDeepStrictEqual(previousConnections.get(connection.id), connection)),
    }),
    resultView: 'changes',
    totalNodeCount: board.nodes!.length,
    totalConnectionCount: board.connections?.length ?? 0,
    removedNodeIds: [...previousNodes.keys()].filter(id => !nodeIds.has(id)),
    removedConnectionIds: [...previousConnections.keys()].filter(id => !connectionIds.has(id)),
  }
}

/**
 * Read one node's exact text in pages, by stable id; a digest keeps two pages
 * of different edits from being stitched together.
 * @param snapshot - the board.
 * @param input - nodeId, field, offset, limit and the first page's digest.
 * @returns the page.
 */
export function readNodeContent(snapshot: BoardSnapshot, input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.nodeId !== 'string' || input.nodeId === '' || typeof input.field !== 'string' || !(TEXT_FIELDS as readonly string[]).includes(input.field)) {
    throw new CanvasToolError('CANVAS_NODE_READ_INVALID', 'Pass nodeId from canvas_get_state and field: content, prompt or composerContent.')
  }
  const offset = input.offset ?? 0
  const limit = input.limit ?? 4000
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 2 || (limit as number) > 12000) {
    throw new CanvasToolError('CANVAS_NODE_READ_INVALID', 'offset must be a non-negative integer; limit must be 2..12000.')
  }
  const node = snapshot.nodes?.find(item => item.id === input.nodeId)
  if (node === undefined) throw new CanvasToolError('CANVAS_NODE_NOT_FOUND', 'The board has no node with that ID. Re-read canvas_get_state.')
  const field = input.field as NodeTextField
  const content = node.metadata?.[field]
  if (typeof content !== 'string') throw new CanvasToolError('CANVAS_NODE_FIELD_NOT_FOUND', `This node has no string at metadata.${field}.`)
  const contentDigest = createHash('sha256').update(content).digest('hex')
  if (((offset as number) > 0 && typeof input.contentDigest !== 'string') || (input.contentDigest !== undefined && input.contentDigest !== contentDigest)) {
    throw new CanvasToolError('CANVAS_NODE_CONTENT_CHANGED', 'Continue with the contentDigest returned by the first page. If the content changed, restart at offset 0.')
  }
  const start = offset as number
  if (start > content.length || (start > 0 && /[\uDC00-\uDFFF]/u.test(content.charAt(start)) && /[\uD800-\uDBFF]/u.test(content.charAt(start - 1)))) {
    throw new CanvasToolError('CANVAS_NODE_READ_INVALID', 'Use the returned nextOffset; this offset is outside the content or splits a character.')
  }
  let end = Math.min(content.length, start + (limit as number))
  if (end < content.length && /[\uD800-\uDBFF]/u.test(content.charAt(end - 1)) && /[\uDC00-\uDFFF]/u.test(content.charAt(end))) end--
  return {
    nodeId: node.id, nodeType: node.type, field, content: content.slice(start, end), contentDigest, offset: start,
    totalLength: content.length, nextOffset: end < content.length ? end : null,
  }
}

type GenerationStatus = 'idle' | 'pending' | 'succeeded' | 'partial' | 'failed' | 'canceled' | 'unknown'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const shortText = (value: unknown, max = 240): string | undefined => typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined

function outputStatus(id: string, raw: unknown, projectId: string): Record<string, unknown> & { status: GenerationStatus } {
  const value = record(raw)
  const attempt = record(value.videoAttempt)
  const hasAttempt = typeof attempt.attemptId === 'string'
  // Old content may stay visible while a new request fails or is still running.
  const hasContent = typeof value.content === 'string' && value.content.trim().length > 0 && (!hasAttempt || attempt.status === 'succeeded')
  const task = hasAttempt ? attempt : record(value.generationTask)
  const taskId = typeof task.taskId === 'string' && task.taskId.length > 0 && task.taskId.length <= 512 ? task.taskId : undefined
  const error = shortText(hasAttempt ? attempt.errorDetails : value.errorDetails, 320)
  const status: GenerationStatus = hasAttempt
    ? attempt.status === 'submitting' || attempt.status === 'running' ? 'pending'
      : attempt.status === 'succeeded' && hasContent ? 'succeeded'
        : attempt.status === 'failed' ? 'failed' : 'unknown'
    : value.status === 'loading' ? 'pending'
      : value.status === 'error' ? 'failed'
        : value.status === 'canceled' || value.status === 'cancelled' ? 'canceled'
          : value.status === 'success' && hasContent ? 'succeeded'
            : value.status === 'idle' ? 'idle' : 'unknown'
  return {
    id, status, hasContent,
    ...(taskId !== undefined && task.projectId === projectId ? { task: { projectId, taskId } } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

/**
 * One node's generation progress: whitelisted fields only, never prompts or image bytes.
 *
 * `error` is the reason the page recorded on the node itself (status error
 * with errorDetails): why a batch or an agent's run stopped before anything
 * was sent — a reference the model refuses, a prompt over the limit, which the
 * page writes on a source node that has no content yet — or why a generation
 * node's outputs failed. A generation (config) node has no outputs to carry
 * it, and a node's outputs can still show an older outcome (a video's last
 * attempt), so it is reported unless an output already says the same.
 * @param node - the node.
 * @param projectId - the film's project id, for task receipts.
 * @returns its status and outputs.
 */
export function generationNodeStatus(node: BoardNode, projectId: string): Record<string, unknown> & { id: string; status: GenerationStatus; outputsTruncated: boolean } {
  const metadata = node.metadata ?? {}
  const items = Array.isArray(metadata.images) && metadata.images.length > 0 ? metadata.images
    : Array.isArray(metadata.texts) && metadata.texts.length > 0 ? metadata.texts : [metadata]
  const outputs = node.type === 'config' ? [] : items.map((item, index) => outputStatus(shortText(record(item).id) ?? `${node.id}:${index}`, item, projectId))
  const statuses = outputs.map(item => item.status)
  const status: GenerationStatus = statuses.includes('pending') ? 'pending'
    : statuses.length > 0 && statuses.every(item => item === 'succeeded') ? 'succeeded'
      : statuses.includes('succeeded') ? 'partial'
        : statuses.length > 0 && statuses.every(item => item === 'failed') ? 'failed'
          : statuses.length > 0 && statuses.every(item => item === 'canceled') ? 'canceled'
            : statuses.length > 0 && statuses.every(item => item === 'idle') ? 'idle' : 'unknown'
  const visible: typeof outputs = []
  let bytes = 0
  for (const item of outputs) {
    const size = Buffer.byteLength(JSON.stringify(item))
    if (visible.length > 0 && (visible.length >= 50 || bytes + size > 8_000)) break
    visible.push(item)
    bytes += size
  }
  const nodeStatus = shortText(metadata.status)
  const nodeError = metadata.status === 'error' ? shortText(metadata.errorDetails, 320) : undefined
  const configuredModel = shortText(metadata.model)
  return {
    id: node.id, type: node.type, title: shortText(node.title) ?? '', status,
    ...(nodeStatus !== undefined ? { nodeStatus } : {}),
    ...(nodeError !== undefined && !outputs.some(item => item.error === nodeError) ? { error: nodeError } : {}),
    ...(configuredModel !== undefined ? { configuredModel } : {}),
    outputs: visible, outputCount: outputs.length, outputsTruncated: visible.length < outputs.length,
  }
}

/**
 * Generation progress for a batch of nodes, bounded in size.
 * @param snapshot - the board.
 * @param nodeIds - 1–50 distinct node ids.
 * @param projectId - the film's project id.
 * @returns the statuses, missing ids and the ids left for the next page.
 */
export function generationStatusPage(snapshot: BoardSnapshot, nodeIds: unknown, projectId: string): Record<string, unknown> {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0 || nodeIds.length > 50 || nodeIds.some(id => typeof id !== 'string' || id.trim() === '') || new Set(nodeIds).size !== nodeIds.length) {
    throw new CanvasToolError('CANVAS_GENERATION_STATUS_INVALID', 'nodeIds must contain 1–50 distinct, non-empty node IDs. Split larger selections into pages.')
  }
  const ids = nodeIds as string[]
  const byId = new Map((snapshot.nodes ?? []).map(node => [node.id, node]))
  const summaries = ids.flatMap((id) => {
    const node = byId.get(id)
    if (node === undefined) return []
    const summary: Record<string, unknown> & { id: string; status: GenerationStatus; outputsTruncated: boolean } = generationNodeStatus(node, projectId)
    if (node.type === 'config') {
      const outputIds = [...new Set((snapshot.connections ?? []).filter(link => link.fromNodeId === id).map(link => link.toNodeId))]
      summary.outputNodeIds = outputIds.slice(0, 50)
      summary.outputNodeIdsTruncated = outputIds.length > 50
    }
    return [summary]
  })
  const missingNodeIds = ids.filter(id => !byId.has(id))
  const nodes: typeof summaries = []
  let bytes = 0
  for (const node of summaries) {
    const size = Buffer.byteLength(JSON.stringify(node))
    if (nodes.length > 0 && bytes + size > 24_000) break
    nodes.push(node)
    bytes += size
  }
  const nextNodeIds = summaries.slice(nodes.length).map(node => node.id)
  return {
    nextNodeIds, nodes, missingNodeIds,
    allSucceeded: nextNodeIds.length === 0 && missingNodeIds.length === 0 && nodes.every(node => node.status === 'succeeded' && !node.outputsTruncated),
  }
}

const savedText = (value: unknown, maximum: number): string | undefined => typeof value === 'string'
  ? value.startsWith('data:') ? '[inline data omitted]' : value.slice(0, maximum)
  : undefined

/** The production fields story_adopt compares with its expectedTarget, byte for byte. */
const ADOPTION_FIELDS = ['prompt', 'composerContent', 'references'] as const

const holdsInlineData = (value: unknown): boolean => typeof value === 'string' ? value.startsWith('data:') : Array.isArray(value) && value.some(holdsInlineData)

/**
 * One saved node's screenplay links and the exact values story_adopt
 * compares: untruncated, and only the fields the node has (an absent field is
 * omitted from expectedTarget too). Inline data is never returned; a field
 * holding it is named instead and cannot be quoted.
 * @param metadata - the node's metadata.
 * @returns the extra members of the single-node view.
 */
function storyFields(metadata: Record<string, unknown>): Record<string, unknown> {
  const adoptionTarget: Record<string, unknown> = {}
  const omitted: string[] = []
  for (const key of ADOPTION_FIELDS) {
    if (metadata[key] === undefined) continue
    if (holdsInlineData(metadata[key])) omitted.push(key)
    else adoptionTarget[key] = metadata[key]
  }
  const source = record(metadata.storySource)
  const adoption = record(metadata.storyAdoption)
  const byField = record(adoption.fieldAdoptions)
  const adopted = (value: unknown): Record<string, unknown> | undefined => {
    const field = record(value)
    return field.revision === undefined ? undefined : { documentId: field.documentId, objectId: field.objectId, revision: field.revision, scope: field.scope, adoptedAt: field.adoptedAt }
  }
  const story = {
    ...(source.documentId !== undefined
      ? { source: { documentId: source.documentId, objectId: source.objectId, objectKind: source.objectKind, scope: source.scope, revision: record(source.snapshot).revision } }
      : {}),
    ...(metadata.storyProduction !== undefined ? { production: metadata.storyProduction } : {}),
    ...(adoption.fields !== undefined || adoption.fieldAdoptions !== undefined
      ? { adoption: { fields: adoption.fields, prompt: adopted(byField.prompt ?? (Array.isArray(adoption.fields) && adoption.fields.includes('prompt') ? adoption : undefined)), references: adopted(byField.references ?? (Array.isArray(adoption.fields) && adoption.fields.includes('references') ? adoption : undefined)) } }
      : {}),
    ...(typeof metadata.promptPurpose === 'string' ? { promptPurpose: metadata.promptPurpose } : {}),
  }
  return {
    adoptionTarget,
    ...(omitted.length > 0 ? { adoptionTargetOmitted: omitted } : {}),
    ...(Object.keys(story).length > 0 ? { story } : {}),
  }
}

function summarizeSavedNode(value: unknown, projectId: string, exact = false): Record<string, unknown> {
  const node = record(value)
  const metadata = record(node.metadata)
  const content = metadata.content ?? node.content ?? ''
  const saved: Record<string, unknown> = {}
  for (const key of ['videoTaskId', 'lastVideoTaskId', 'imageTaskId', 'audioTaskId', 'taskId', 'status', 'error', 'errorMessage', 'errorDetails', 'model', 'mode', 'videoMode', 'mimeType', 'generationMode']) {
    if (typeof metadata[key] === 'string') saved[key] = savedText(metadata[key], key.startsWith('error') ? 1200 : 300)
  }
  for (const key of ['prompt', 'composerContent']) {
    if (typeof metadata[key] === 'string') saved[key] = savedText(metadata[key], 1600)
  }
  // The generation settings (C1) canvas_get_state shows whole, compactly; a cleared one (null) is no setting.
  const cameraMove = compactCameraMove(metadata.cameraMove)
  if (cameraMove !== undefined) saved.cameraMove = cameraMove
  const cameraControl = compactCameraControl(metadata.cameraControl)
  if (cameraControl !== undefined) saved.cameraControl = cameraControl
  return {
    id: node.id, type: node.type, title: savedText(metadata.title ?? node.title, 200),
    position: node.position, width: node.width, height: node.height,
    content: savedText(content, 1600),
    contentTruncated: typeof content === 'string' && (content.length > 1600 || content.startsWith('data:')),
    metadata: saved,
    generation: generationNodeStatus({ ...node, metadata } as BoardNode, projectId),
    ...(exact ? storyFields(metadata) : {}),
  }
}

/**
 * A bounded page of the saved board, readable with no page open.
 * @param document - the saved board.
 * @param input - the project id, and a node id or a page (offset, limit).
 * @returns the page.
 */
export function savedCanvasPage(document: Record<string, unknown>, input: { projectId: string; nodeId?: string; offset?: number; limit?: number }): Record<string, unknown> {
  const nodes = Array.isArray(document.nodes) ? document.nodes : []
  const base = { source: 'persisted', boardId: document.id, title: document.title, updatedAt: document.updatedAt }
  if (input.nodeId !== undefined) {
    const node = nodes.find(item => record(item).id === input.nodeId)
    if (node === undefined) throw new CanvasToolError('CANVAS_NODE_NOT_FOUND', 'The saved board has no such node.')
    return { ...base, node: summarizeSavedNode(node, input.projectId, true) }
  }
  const offset = Math.max(0, Math.floor(Number.isFinite(input.offset) ? input.offset! : 0))
  const limit = Math.min(50, Math.max(1, Math.floor(Number.isFinite(input.limit) ? input.limit! : 25)))
  const selected: Array<Record<string, unknown>> = []
  let bytes = 0
  for (const value of nodes.slice(offset, offset + limit)) {
    const node = summarizeSavedNode(value, input.projectId)
    const size = Buffer.byteLength(JSON.stringify(node))
    if (selected.length > 0 && bytes + size > 24_000) break
    selected.push(node)
    bytes += size
  }
  const ids = new Set(selected.map(node => node.id))
  const connections = (Array.isArray(document.connections) ? document.connections : [])
    .map(record).filter(edge => ids.has(edge.fromNodeId) || ids.has(edge.toNodeId))
  return {
    ...base, nodes: selected, totalNodes: nodes.length,
    nextOffset: offset + selected.length < nodes.length ? offset + selected.length : null,
    connections: connections.slice(0, 50).map(edge => ({ id: savedText(edge.id, 100), fromNodeId: savedText(edge.fromNodeId, 100), toNodeId: savedText(edge.toNodeId, 100) })),
    connectionsTruncated: connections.length > 50,
  }
}

/**
 * The saved document as a board snapshot (no selection: only a page has one).
 * @param document - the saved board.
 * @returns the snapshot.
 */
export function snapshotOfDocument(document: Record<string, unknown>): BoardSnapshot {
  const viewport = record(document.viewport)
  return {
    projectId: typeof document.id === 'string' ? document.id : undefined,
    ...(typeof document.title === 'string' ? { title: document.title } : {}),
    nodes: (Array.isArray(document.nodes) ? document.nodes : []) as BoardNode[],
    connections: (Array.isArray(document.connections) ? document.connections : []) as BoardConnection[],
    selectedNodeIds: [],
    viewport: typeof viewport.x === 'number' && typeof viewport.y === 'number' && typeof viewport.k === 'number'
      ? { x: viewport.x, y: viewport.y, k: viewport.k }
      : { x: 0, y: 0, k: 1 },
  }
}
