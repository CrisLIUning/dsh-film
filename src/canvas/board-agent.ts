/**
 * The open canvas pages, as Studio's board agent sees them
 * (apps/daemon/src/canvas-board-agent.ts): each page subscribes to
 * `/api/canvas/agent/events`, receives a lease (`hello`), and keeps pushing
 * snapshots of its board and selection. A later step sends agent tool calls
 * to a page the same way (`tool_call`); for now this keeps the pages
 * connected and remembers their latest state.
 * @module dsh-film/canvas/board-agent
 */

import { randomUUID } from 'node:crypto'
import type { EventStream } from '../studio/sse.js'

export interface BoardTarget {
  projectId: string
  clientId: string
  incarnation: string
}

export interface BoardLease {
  target: BoardTarget
  generation: string
  writeToken: string
}

interface Client extends BoardLease {
  stream: EventStream
  snapshot: unknown
  sequence: number
}

export class BoardAgentError extends Error {
  override name = 'BoardAgentError'

  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u

/**
 * Read a page's identity from untrusted input.
 * @param input - the query or body member naming the page.
 * @returns the target.
 */
export function parseBoardTarget(input: unknown): BoardTarget {
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const pick = (key: keyof BoardTarget): string => {
    const raw = value[key]
    if (typeof raw !== 'string' || !ID.test(raw)) throw new BoardAgentError(400, 'CANVAS_BOARD_TARGET_REQUIRED', `${key} is required`)
    return raw
  }
  return { projectId: pick('projectId'), clientId: pick('clientId'), incarnation: pick('incarnation') }
}

const keyOf = (target: BoardTarget): string => `${target.projectId}\0${target.clientId}\0${target.incarnation}`

export class CanvasBoardAgent {
  private readonly clients = new Map<string, Client>()

  /**
   * Register a page's event stream and send it its lease.
   * @param target - the page.
   * @param stream - its event stream.
   * @returns releases the registration.
   */
  connect(target: BoardTarget, stream: EventStream): () => void {
    const key = keyOf(target)
    const prior = this.clients.get(key)
    if (prior !== undefined) prior.stream.close()
    const client: Client = { target, generation: randomUUID(), writeToken: randomUUID(), stream, snapshot: null, sequence: 0 }
    this.clients.set(key, client)
    stream.send('hello', { target, generation: client.generation, writeToken: client.writeToken })
    return () => {
      if (this.clients.get(key) === client) this.clients.delete(key)
    }
  }

  private owned(lease: BoardLease): Client | undefined {
    const client = this.clients.get(keyOf(lease.target))
    return client !== undefined && client.generation === lease.generation && client.writeToken === lease.writeToken ? client : undefined
  }

  /**
   * Remember a page's latest board snapshot.
   * @param lease - the page's lease.
   * @param snapshot - its board and selection, or `null`.
   * @param sequence - increases with every push.
   * @returns whether the lease is current.
   */
  setSnapshot(lease: BoardLease, snapshot: unknown, sequence: number): boolean {
    const client = this.owned(lease)
    if (client === undefined) return false
    if (sequence > client.sequence) {
      client.sequence = sequence
      client.snapshot = snapshot
    }
    return true
  }

  /**
   * Accept a page's answer to a tool call.
   * @param lease - the page's lease.
   * @returns whether the lease is current.
   */
  resolve(lease: BoardLease): boolean {
    return this.owned(lease) !== undefined
  }

  /**
   * The pages open for a project.
   * @param projectId - the project.
   * @returns their targets and whether each has reported its board.
   */
  list(projectId: string): { target: BoardTarget; ready: boolean }[] {
    return [...this.clients.values()]
      .filter(client => client.target.projectId === projectId)
      .map(client => ({ target: client.target, ready: client.snapshot !== null }))
  }
}

/**
 * Read a lease from a page's request body.
 * @param body - the body.
 * @returns the lease.
 */
export function parseLease(body: Record<string, unknown>): BoardLease {
  const target = parseBoardTarget(body.target)
  if (typeof body.generation !== 'string' || typeof body.writeToken !== 'string') {
    throw new BoardAgentError(400, 'CANVAS_BOARD_LEASE_REQUIRED', 'The active connection generation and write token are required.')
  }
  return { target, generation: body.generation, writeToken: body.writeToken }
}
