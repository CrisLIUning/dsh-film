/**
 * The board's write vocabulary — the ops the canvas page's executor speaks
 * (`add_node`, `update_node`, `delete_node`, `delete_connections`,
 * `connect_nodes`, `set_viewport`, `select_nodes`, `run_generation`) — with
 * the call-shape check Studio runs before queueing any page work
 * (apps/daemon/src/canvas-board-ops.ts).
 *
 * The page owns what a node means, and an open page runs every op. A closed
 * board is still the film's board, though: in DSH it lives in a sidebar tab
 * that is often not open, and an agent that can only work while that tab is
 * on screen cannot build a storyboard on its own. So the same ops also run
 * here against the saved document, ported from the page's executor
 * (canvas `web/src/lib/canvas/canvas-agent-ops.ts`, `applyCanvasAgentOps`,
 * with the built-in node specs of `web/src/constant/canvas.ts`). Generation
 * is the page's alone: `run_generation` needs an open page.
 * @module dsh-film/canvas/board-ops
 */

import { randomUUID } from 'node:crypto'

/** The fields each op takes besides `type`. */
export const BOARD_OP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  add_node: ['id', 'nodeType', 'title', 'position', 'x', 'y', 'width', 'height', 'metadata'],
  update_node: ['id', 'patch', 'metadata'],
  delete_node: ['id', 'ids', 'nodeType'],
  delete_connections: ['id', 'ids', 'all'],
  connect_nodes: ['id', 'fromNodeId', 'toNodeId'],
  set_viewport: ['viewport'],
  select_nodes: ['ids'],
  run_generation: ['nodeId', 'mode', 'prompt'],
}

export type BoardOp = Record<string, unknown> & { type: string }

/**
 * Check a batch's shape before anything runs it.
 * @param ops - the batch.
 * @returns the first problem, or `undefined` when every op is well formed.
 */
export function validateBoardOps(ops: readonly unknown[]): string | undefined {
  for (const [index, value] of ops.entries()) {
    const fail = (detail: string): string => `ops[${index}]: ${detail}`
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('operation must be an object')
    const op = value as Record<string, unknown>
    if (typeof op.type !== 'string' || !Object.hasOwn(BOARD_OP_FIELDS, op.type)) return fail(`unknown operation; use ${Object.keys(BOARD_OP_FIELDS).join(', ')}`)
    for (const key of Object.keys(op)) if (key !== 'type' && !BOARD_OP_FIELDS[op.type]!.includes(key)) return fail(`unexpected field ${key} for ${op.type}`)
    const required = op.type === 'update_node' ? ['id'] : op.type === 'connect_nodes' ? ['fromNodeId', 'toNodeId'] : op.type === 'run_generation' ? ['nodeId'] : []
    for (const key of required) if (typeof op[key] !== 'string' || op[key] === '') return fail(`${key} must be a non-empty string`)
    for (const key of ['patch', 'metadata', 'position', 'viewport']) {
      if (op[key] !== undefined && (op[key] === null || typeof op[key] !== 'object' || Array.isArray(op[key]))) return fail(`${key} must be an object`)
    }
    if (op.patch !== undefined && Object.keys(op.patch as object).some(key => !['title', 'position', 'width', 'height', 'metadata'].includes(key))) {
      return fail('patch cannot change node identity or contain unknown fields')
    }
  }
  return undefined
}

/** A node as the board stores it. */
export interface BoardNode {
  id: string
  type: string
  title?: string
  position: { x: number; y: number }
  width: number
  height: number
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface BoardConnection {
  id: string
  fromNodeId: string
  toNodeId: string
  [key: string]: unknown
}

/** The board as the page reports it, and as the saved document reads. */
export interface BoardSnapshot {
  projectId?: string
  title?: string
  nodes?: BoardNode[]
  connections?: BoardConnection[]
  selectedNodeIds?: string[]
  viewport?: { x: number; y: number; k: number }
  [key: string]: unknown
}

/** The canvas's built-in node types and what a new one of each starts as (its zh-CN titles). */
const NODE_SPECS: Readonly<Record<string, { width: number; height: number; title: string; metadata: Record<string, unknown> }>> = {
  image: { width: 340, height: 240, title: '图片', metadata: { content: '', status: 'idle' } },
  text: { width: 340, height: 240, title: '文本', metadata: { content: '', status: 'idle', fontSize: 14 } },
  config: { width: 340, height: 240, title: '生成配置', metadata: { content: '', status: 'idle', generationMode: 'image' } },
  video: { width: 420, height: 236, title: '视频', metadata: { content: '', status: 'idle' } },
  audio: { width: 340, height: 120, title: '音频', metadata: { content: '', status: 'idle' } },
  group: { width: 760, height: 480, title: '组', metadata: { status: 'idle' } },
  director: { width: 420, height: 300, title: '3D 导演台', metadata: { status: 'idle' } },
}

/** Node types this module can create on a closed board. */
export const BUILT_IN_NODE_TYPES: readonly string[] = Object.keys(NODE_SPECS)

export class BoardOpError extends Error {
  override name = 'BoardOpError'

  constructor(message: string, readonly code = 'CANVAS_OP_INVALID') {
    super(message)
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Run a batch against a board the way the page's executor does: all of it, or
 * none of it when one op is refused.
 * @param snapshot - the board before the batch.
 * @param ops - the batch, already shape-checked.
 * @returns the board after the batch.
 */
export function applyBoardOps(snapshot: BoardSnapshot, ops: readonly BoardOp[]): BoardSnapshot {
  let nodes = snapshot.nodes ?? []
  let connections = snapshot.connections ?? []
  let selectedNodeIds = snapshot.selectedNodeIds ?? []
  let viewport = snapshot.viewport ?? { x: 0, y: 0, k: 1 }

  ops.forEach((op, index) => {
    const fail = (message: string): never => { throw new BoardOpError(`CANVAS_OP_INVALID: ops[${index}] ${message}`) }
    const requireNode = (id: unknown): void => {
      if (typeof id !== 'string' || id === '' || !nodes.some(node => node.id === id)) fail(`node ${String(id)} does not exist; use the node id from canvas_get_state`)
    }
    if ('metadata' in op && op.metadata !== undefined && !isObject(op.metadata)) fail('metadata must be an object')
    if ('id' in op && op.id !== undefined && (typeof op.id !== 'string' || op.id === '')) fail('id must be a non-empty string')
    if ('title' in op && op.title !== undefined && typeof op.title !== 'string') fail('title must be text')
    if ('ids' in op && op.ids !== undefined && (!Array.isArray(op.ids) || !op.ids.every(id => typeof id === 'string'))) fail('ids must be a string array')
    switch (op.type) {
      case 'add_node': {
        if (typeof op.id === 'string' && nodes.some(node => node.id === op.id)) fail(`duplicate node ${op.id}`)
        const nodeType = typeof op.nodeType === 'string' ? op.nodeType : 'text'
        const spec = NODE_SPECS[nodeType]
        if (spec === undefined) {
          fail(`node type ${nodeType} can only be added while the storyboard is open (a closed board takes ${BUILT_IN_NODE_TYPES.join(', ')})`)
        }
        const position = op.position
        if (position !== undefined && (!isObject(position) || !finite(position.x) || !finite(position.y))) fail('position needs finite x and y')
        for (const value of [op.x, op.y]) if (value !== undefined && !finite(value)) fail('position must contain finite numbers')
        for (const value of [op.width, op.height]) if (value !== undefined && (!finite(value) || value <= 0)) fail('size must be positive')
        const node: BoardNode = {
          id: typeof op.id === 'string' ? op.id : `${nodeType}-${Date.now()}-${index}`,
          type: nodeType,
          title: typeof op.title === 'string' && op.title !== '' ? op.title : spec!.title,
          position: isObject(position) ? { x: position.x as number, y: position.y as number } : { x: finite(op.x) ? op.x : index * 36, y: finite(op.y) ? op.y : index * 36 },
          width: finite(op.width) ? op.width : spec!.width,
          height: finite(op.height) ? op.height : spec!.height,
          metadata: { ...spec!.metadata, ...(isObject(op.metadata) ? op.metadata : {}) },
        }
        nodes = [...nodes, node]
        selectedNodeIds = [node.id]
        break
      }
      case 'update_node': {
        requireNode(op.id)
        const patch = op.patch
        if (patch !== undefined && !isObject(patch)) fail('patch must be an object')
        const fields = isObject(patch) ? patch : {}
        if (Object.keys(fields).some(key => !['title', 'position', 'width', 'height', 'metadata'].includes(key))) {
          fail('patch may update title, position, width, height or metadata; node identity cannot change')
        }
        if (fields.metadata !== undefined && !isObject(fields.metadata)) fail('patch.metadata must be an object')
        if (fields.title !== undefined && typeof fields.title !== 'string') fail('patch.title must be text')
        if (fields.position !== undefined && (!isObject(fields.position) || !finite(fields.position.x) || !finite(fields.position.y))) fail('patch.position needs finite x and y')
        for (const value of [fields.width, fields.height]) if (value !== undefined && (!finite(value) || value <= 0)) fail('patch size must be positive')
        nodes = nodes.map(node => node.id === op.id
          ? { ...node, ...fields, metadata: { ...node.metadata, ...(isObject(fields.metadata) ? fields.metadata : {}), ...(isObject(op.metadata) ? op.metadata : {}) } } as BoardNode
          : node)
        break
      }
      case 'delete_node': {
        if (op.id === undefined && op.ids === undefined && op.nodeType === undefined) fail('delete_node requires id, ids or nodeType')
        const ids = new Set<string>(Array.isArray(op.ids)
          ? op.ids as string[]
          : typeof op.id === 'string' ? [op.id] : nodes.filter(node => node.type === op.nodeType).map(node => node.id))
        nodes = nodes.filter(node => !ids.has(node.id))
        connections = connections.filter(connection => !ids.has(connection.fromNodeId) && !ids.has(connection.toNodeId))
        selectedNodeIds = selectedNodeIds.filter(id => !ids.has(id))
        break
      }
      case 'delete_connections': {
        if (op.id === undefined && op.ids === undefined && op.all !== true) fail('delete_connections requires id, ids or all')
        const ids = new Set<string>(Array.isArray(op.ids) ? op.ids as string[] : typeof op.id === 'string' ? [op.id] : [])
        connections = op.all === true ? [] : connections.filter(connection => !ids.has(connection.id))
        break
      }
      case 'connect_nodes': {
        requireNode(op.fromNodeId)
        requireNode(op.toNodeId)
        if (!connections.some(connection => connection.fromNodeId === op.fromNodeId && connection.toNodeId === op.toNodeId)) {
          connections = [...connections, { id: typeof op.id === 'string' ? op.id : randomUUID(), fromNodeId: op.fromNodeId as string, toNodeId: op.toNodeId as string }]
        }
        break
      }
      case 'set_viewport': {
        const next = op.viewport
        if (!isObject(next) || ![next.x, next.y, next.k].every(finite) || (next.k as number) <= 0) fail('viewport requires finite x/y and positive k')
        viewport = { x: (next as { x: number }).x, y: (next as { y: number }).y, k: (next as { k: number }).k }
        break
      }
      case 'select_nodes': {
        if (!Array.isArray(op.ids)) fail('ids must be an array')
        ;(op.ids as unknown[]).forEach(requireNode)
        selectedNodeIds = op.ids as string[]
        break
      }
      case 'run_generation':
        throw new BoardOpError('Generation runs in the storyboard page, which is not open. Ask the person to open the 分镜 tab of the film workbench, or generate with the media tools and attach the file with canvas_attach_media.', 'CANVAS_BOARD_NOT_OPEN')
      default:
        fail('unknown operation; use add_node/update_node/delete_node/delete_connections/connect_nodes/set_viewport/select_nodes/run_generation')
    }
  })

  return { ...snapshot, nodes, connections, selectedNodeIds, viewport }
}
