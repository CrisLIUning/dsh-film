/**
 * Finding the scene a director request means: a director node on the film's
 * board, or a desk project handed over inline. Ported from Studio's
 * apps/daemon/src/routes/director.ts (`directorNodesOf`, `locateDirectorScene`,
 * `envelopeFor`, `projectFileOfUrl`) with its refusal codes and texts; Studio
 * returns refusals as values, here they are thrown as {@link DirectorRefusal}.
 * @module dsh-film/director/locate
 */

import type { CanvasDocumentStore } from '../canvas/documents.js'
import type { DirectorQuerySourceEcho } from './contracts/index.js'
import { fingerprintOfStoredScene, getDirectorProjectFingerprint } from './fingerprint.js'
import { resolveDirectorProject } from './scene.js'
import type { DirectorProject } from './vendor/director-math/schema/directorProject.js'

/** The director node's type on a board. */
export const DIRECTOR_NODE_TYPE = 'director'

/** A refusal in Studio's director shape: `{ error, code, ...details }` with this status. */
export class DirectorRefusal extends Error {
  override name = 'DirectorRefusal'

  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
  }
}

/** What a director node's metadata holds: the desk's own `project.get` envelope. */
export interface DirectorSceneEnvelope {
  protocolVersion: number
  projectSchemaVersion: number
  projectFingerprint: string
  project: DirectorProject
}

/** Where a request's scene lives. */
export interface LocatedScene {
  echo: DirectorQuerySourceEcho
  /** `null` for a scene handed over inline. */
  boardId: string | null
  nodeId: string | null
  /** What the board's node holds, as stored; undefined for a node never opened as a desk. */
  stored: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

interface BoardDirectorNode {
  id: string
  name: string
  scene: unknown
}

/**
 * The director nodes of a board, with the name a person knows them by.
 * @param document - the saved board.
 * @returns each node's id, name and stored scene.
 */
export function directorNodesOf(document: Record<string, unknown>): BoardDirectorNode[] {
  const nodes = Array.isArray(document.nodes) ? document.nodes : []
  return nodes.flatMap((node): BoardDirectorNode[] => {
    if (!isRecord(node) || node.type !== DIRECTOR_NODE_TYPE || typeof node.id !== 'string') return []
    const metadata = isRecord(node.metadata) ? node.metadata : {}
    const name = typeof metadata.title === 'string' && metadata.title.trim()
      ? metadata.title
      : typeof node.title === 'string' && node.title.trim() ? node.title : node.id
    return [{ id: node.id, name, scene: metadata.directorProject }]
  })
}

/**
 * The envelope a scene is written in, the shape the desk itself saves.
 * @param project - the project.
 * @returns the envelope.
 */
export function envelopeFor(project: DirectorProject): DirectorSceneEnvelope {
  return {
    protocolVersion: 1,
    projectSchemaVersion: project.version,
    projectFingerprint: getDirectorProjectFingerprint(project),
    project,
  }
}

/**
 * Where a served project file lives: `/api/projects/<id>/raw/<path>`.
 * @param url - the url.
 * @returns the project and the path, or `null` for any other url.
 */
export function projectFileOfUrl(url: unknown): { project: string; path: string } | null {
  if (typeof url !== 'string') return null
  const match = url.match(/^\/api\/projects\/([^/]+)\/raw\/(.+)$/)
  if (!match) return null
  try {
    return { project: decodeURIComponent(match[1]!), path: match[2]!.split('/').map(decodeURIComponent).join('/') }
  } catch {
    return null
  }
}

/**
 * Which scene a request means. A board with one director node needs no node
 * id; with several the caller has to say, and the refusal lists them so the
 * next call can. A node never opened as a desk holds nothing yet — a refusal
 * for a read and a starting point for a write.
 * @param documents - the film's board store.
 * @param source - `{ boardId, nodeId? }` or `{ directorProject }`.
 * @returns where the scene lives.
 */
export async function locateDirectorScene(documents: Pick<CanvasDocumentStore, 'read'>, source: unknown): Promise<LocatedScene> {
  if (!isRecord(source)) throw new DirectorRefusal(400, 'DIRECTOR_SOURCE_INVALID', 'source 要么是 { boardId, nodeId? },要么是 { directorProject }')
  if ('directorProject' in source) {
    if (!resolveDirectorProject(source.directorProject)) {
      throw new DirectorRefusal(400, 'DIRECTOR_PROJECT_INVALID', 'directorProject 不是导演台工程:需要 version、scene、objects、cameras')
    }
    return { echo: {}, boardId: null, nodeId: null, stored: source.directorProject }
  }
  if (typeof source.boardId !== 'string' || !source.boardId) {
    throw new DirectorRefusal(400, 'DIRECTOR_SOURCE_INVALID', 'source 要么是 { boardId, nodeId? },要么是 { directorProject }')
  }
  const boardId = source.boardId
  const document = await documents.read(boardId)
  if (!document) throw new DirectorRefusal(404, 'CANVAS_DOCUMENT_NOT_FOUND', `没有这块板子:${boardId}`)
  const nodes = directorNodesOf(document)
  const requested = typeof source.nodeId === 'string' && source.nodeId ? source.nodeId : null
  const node = requested ? nodes.find(item => item.id === requested) : nodes.length === 1 ? nodes[0] : null
  if (!node) {
    const directorNodes = nodes.map(item => ({ id: item.id, name: item.name }))
    if (requested || nodes.length === 0) {
      throw new DirectorRefusal(404, 'DIRECTOR_NODE_NOT_FOUND', requested ? `板子上没有导演台节点 ${requested}` : '这块板子上没有导演台节点', { directorNodes })
    }
    throw new DirectorRefusal(409, 'DIRECTOR_NODE_AMBIGUOUS', '板子上有不止一个导演台节点,用 nodeId 指明是哪一个', { directorNodes })
  }
  return { echo: { boardId, nodeId: node.id }, boardId, nodeId: node.id, stored: node.scene }
}

export { fingerprintOfStoredScene }
