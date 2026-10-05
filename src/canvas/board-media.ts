/**
 * Film files on the board (Studio's `canvas-board-landing.ts`).
 *
 * The board is where a film's material collects — generations, renders,
 * files someone dropped in. Its media nodes play project files by Studio's
 * raw URL. A file is put into an existing node, or landed on the board as a
 * new node, right of everything there — or, for a file made from other nodes
 * (a cut, a join, a sound copy), right of the node it came from, with an edge
 * from each source and what it carries over from them. Studio asks the open
 * board page to add that node; here the Host writes it into
 * `film/canvas/document.json` under the board's lock and announces the
 * change, and an open canvas merges it in (its story-sync refresh), so it
 * works whether or not the page is open.
 * @module dsh-film/canvas/board-media
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { CanvasDocument, CanvasDocumentStore } from './documents.js'

export type BoardMediaKind = 'video' | 'image' | 'audio'

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * The kind of media a file is, by extension, when the board can show it.
 * @param path - a file path.
 * @returns the kind, or `null`.
 */
export function mediaKindOfPath(path: string): BoardMediaKind | null {
  const extension = posix.extname(path).slice(1).toLowerCase()
  if (['mp4', 'webm', 'mov'].includes(extension)) return 'video'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return 'image'
  if (['mp3', 'wav', 'm4a'].includes(extension)) return 'audio'
  return null
}

/** How wide a landed node may be. */
const BOARD_NODE_MAX_WIDTH = 480

/**
 * A landed node's size: its longer side fits the board's usual width.
 * @param width - the file's width, 0 when unknown.
 * @param height - the file's height, 0 when unknown.
 * @returns the node size.
 */
export function boardNodeSize(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: BOARD_NODE_MAX_WIDTH, height: Math.round(BOARD_NODE_MAX_WIDTH * 9 / 16) }
  const scale = Math.min(1, BOARD_NODE_MAX_WIDTH / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/**
 * Where a landed node goes: right of everything on the board, top-aligned with it.
 * @param nodes - the board's nodes.
 * @returns the top-left corner.
 */
export function boardNodePosition(nodes: readonly unknown[]): { x: number; y: number } {
  const boxes = nodes.flatMap((raw) => {
    const node = record(raw)
    const position = record(node?.position)
    if (node === null || position === null) return []
    const x = position.x, y = position.y, width = node.width
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return []
    return [{ x, y, width: positive(width) ? width : 0 }]
  })
  if (boxes.length === 0) return { x: 0, y: 0 }
  return { x: Math.max(...boxes.map(box => box.x + box.width)) + 96, y: Math.min(...boxes.map(box => box.y)) }
}

export interface LandFileInput {
  /** The file, relative to `film/`; the project holds it already. */
  path: string
  kind: BoardMediaKind
  mimeType: string
  title?: string
  width?: number
  height?: number
  durationSeconds?: number
  size?: number
  /** More of the node's metadata. */
  metadata?: Record<string, unknown>
  /** Place the node right of this node (same top) instead of right of everything; a missing node falls back. */
  nearNodeId?: string
  /** Nodes the new node comes from: each gets an edge to it (id `derived:<new>:<from>`); missing ones are skipped. */
  connectFrom?: readonly string[]
  /**
   * More metadata worked out from the board's nodes as they are under its lock:
   * what the new node carries over from its sources (their cues with their
   * style, director shots, prompt). `media` is the new node's file as it is
   * written (content, bytes, durationMs), for the cues' media key. `metadata`
   * still wins over it.
   */
  carry?: (nodes: readonly unknown[], media: LandedMedia) => Record<string, unknown>
}

/** The file a landed node shows, as its metadata records it. */
export interface LandedMedia {
  content: string
  bytes?: number
  durationMs?: number
}

/** The gap between a node and one landed beside it. */
const BOARD_NODE_GAP = 96

/** Whether two boxes overlap. */
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * Where a node derived from another goes: right of it at the same top (Studio's
 * derived-node pattern), moved down past any node already there.
 * @param nodes - the board's nodes.
 * @param nearNodeId - the node it comes from.
 * @param size - the new node's size.
 * @returns the top-left corner, or `null` when the node is not on the board.
 */
export function derivedNodePosition(nodes: readonly unknown[], nearNodeId: string, size: { width: number; height: number }): { x: number; y: number } | null {
  const boxes = nodes.flatMap((raw) => {
    const node = record(raw)
    const position = record(node?.position)
    if (node === null || position === null || typeof position.x !== 'number' || typeof position.y !== 'number' || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return []
    return [{ id: node.id, x: position.x, y: position.y, width: positive(node.width) ? node.width : 0, height: positive(node.height) ? node.height : 0 }]
  })
  const near = boxes.find(box => box.id === nearNodeId)
  if (near === undefined) return null
  const box = { x: near.x + near.width + BOARD_NODE_GAP, y: near.y, ...size }
  for (let step = 0; step < 100; step++) {
    const blocking = boxes.find(other => overlaps(box, other))
    if (blocking === undefined) break
    box.y = blocking.y + blocking.height + BOARD_NODE_GAP / 2
  }
  return { x: box.x, y: box.y }
}

/**
 * Put a project file on the board as a node.
 * @param store - the board's store.
 * @param boardId - the board.
 * @param projectId - the project id the board's URLs name.
 * @param input - the file and what is known about it.
 * @returns the new node's id, or `null` when there is no board yet.
 */
export async function landFileOnBoard(store: CanvasDocumentStore, boardId: string, projectId: string, input: LandFileInput): Promise<string | null> {
  if (await store.read(boardId) === null) return null
  const nodeId = `${input.kind}-${randomUUID()}`
  const url = `/api/projects/${encodeURIComponent(projectId)}/raw/${input.path.split('/').map(encodeURIComponent).join('/')}`
  const media: LandedMedia = {
    content: url,
    ...(positive(input.size) ? { bytes: input.size } : {}),
    ...(positive(input.durationSeconds) ? { durationMs: Math.round(input.durationSeconds * 1000) } : {}),
  }
  let landed = false
  await store.update((current): CanvasDocument => {
    // Checked again under the lock: the board may have gone meanwhile.
    if (current === null || current.id !== boardId) throw new BoardGoneError()
    const size = boardNodeSize(input.width ?? 0, input.height ?? 0)
    const near = input.nearNodeId === undefined ? null : derivedNodePosition(current.nodes, input.nearNodeId, size)
    const node = {
      id: nodeId,
      type: input.kind,
      title: input.title ?? posix.basename(input.path),
      position: near ?? boardNodePosition(current.nodes),
      width: size.width,
      height: size.height,
      metadata: {
        content: url,
        storageKey: '',
        status: 'success',
        ...(positive(input.width) ? { naturalWidth: input.width } : {}),
        ...(positive(input.height) ? { naturalHeight: input.height } : {}),
        ...(media.bytes !== undefined ? { bytes: media.bytes } : {}),
        mimeType: input.mimeType,
        ...(media.durationMs !== undefined ? { durationMs: media.durationMs } : {}),
        ...input.carry?.(current.nodes, media),
        ...input.metadata,
      },
    }
    landed = true
    const present = new Set(current.nodes.map(raw => record(raw)?.id).filter((id): id is string => typeof id === 'string'))
    const edges = [...new Set(input.connectFrom ?? [])].filter(from => present.has(from))
      .map(from => ({ id: `derived:${nodeId}:${from}`, fromNodeId: from, toNodeId: nodeId }))
    return {
      ...current,
      nodes: [...current.nodes, node],
      ...(edges.length > 0 ? { connections: [...(Array.isArray(current.connections) ? current.connections : []), ...edges] } : {}),
      updatedAt: new Date().toISOString(),
    }
  }).catch((error: unknown) => {
    if (!(error instanceof BoardGoneError)) throw error
  })
  return landed ? nodeId : null
}

class BoardGoneError extends Error {
  override name = 'BoardGoneError'
}

/** Why a file could not be attached to a node (Studio's `CanvasTimelinePlaceError` codes). */
export class BoardAttachError extends Error {
  override name = 'BoardAttachError'

  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export interface AttachFileInput extends LandFileInput {
  /** The reviewed media node the file goes into. */
  targetNodeId: string
  /** The node's content as it was read (empty for an empty node); anything else means it changed meanwhile. */
  expectedContent: string
  /** The file's SHA-256, so attaching the same file again changes nothing. */
  sha256: string
}

/**
 * Put an already saved project file into an existing media node — the node
 * a screenplay handoff or a staged flow made — keeping its place, links and
 * source (Studio's `attachBoardMedia`). It goes through the board's own
 * writer, so it works with the page closed; an open page merges it in.
 * @param store - the board's store.
 * @param boardId - the board.
 * @param projectId - the project id the board's URLs name.
 * @param input - the file, the node and the content the node was read with.
 * @returns the node's id.
 */
export async function attachFileToNode(store: CanvasDocumentStore, boardId: string, projectId: string, input: AttachFileInput): Promise<string> {
  const content = `/api/projects/${encodeURIComponent(projectId)}/raw/${input.path.split('/').map(encodeURIComponent).join('/')}`
  await store.update((current): CanvasDocument => {
    if (current === null || current.id !== boardId) throw new BoardAttachError(404, 'CANVAS_DOCUMENT_NOT_FOUND', 'The target board no longer exists.')
    const nodes = current.nodes as Array<Record<string, unknown>>
    const target = nodes.find(node => node.id === input.targetNodeId)
    if (target === undefined) throw new BoardAttachError(404, 'CANVAS_MEDIA_TARGET_NOT_FOUND', 'The target node no longer exists. Re-read canvas_get_state.')
    if (target.type !== input.kind) throw new BoardAttachError(422, 'CANVAS_MEDIA_TARGET_KIND', 'The file type does not match the target media node.')
    const metadata = record(target.metadata) ?? {}
    if (metadata.content === content && record(metadata.attachedMedia)?.sha256 === input.sha256) return current
    if ((typeof metadata.content === 'string' ? metadata.content : '') !== input.expectedContent || metadata.status === 'loading') {
      throw new BoardAttachError(409, 'CANVAS_MEDIA_TARGET_CHANGED', 'The target changed or is generating. Re-read it before attaching this file.')
    }
    const { error: _error, errorDetails: _errorDetails, ...kept } = metadata
    return {
      ...current,
      updatedAt: new Date().toISOString(),
      nodes: nodes.map(node => node !== target ? node : {
        ...node,
        metadata: {
          ...kept,
          content,
          storageKey: '',
          status: 'success',
          mimeType: input.mimeType,
          ...(positive(input.size) ? { bytes: input.size } : {}),
          ...(positive(input.width) ? { naturalWidth: input.width } : {}),
          ...(positive(input.height) ? { naturalHeight: input.height } : {}),
          ...(positive(input.durationSeconds) ? { durationMs: Math.round(input.durationSeconds * 1000) } : {}),
          attachedMedia: { path: input.path, sha256: input.sha256 },
        },
      }),
    }
  })
  return input.targetNodeId
}
