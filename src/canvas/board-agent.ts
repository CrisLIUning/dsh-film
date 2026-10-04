/**
 * The open canvas pages, as Studio's board agent sees them
 * (apps/daemon/src/canvas-board-agent.ts): each page subscribes to
 * `/api/canvas/agent/events`, receives a lease (`hello`), and keeps pushing
 * snapshots of its board and selection. The agent's canvas tools reach a page
 * the same way: a `tool_call` event carries the call, the page runs it with
 * its own node semantics (and undo), and posts the answer to
 * `/api/canvas/agent/result` under its lease.
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
  /** Connection order; with several pages on one board the newest answers. */
  connectedAt: number
}

interface PendingCall {
  client: Client
  name: string
  settle(outcome: { result: unknown } | { error: Error }): void
}

/** A page's answer to a call, as it posts it. */
export interface BoardCallAnswer {
  requestId: string
  result?: unknown
  error?: unknown
  /** The snapshot sequence an applied batch produced. */
  sequence?: unknown
}

/** How long a page may take to answer a call before the agent is told it did not. */
export const BOARD_CALL_TIMEOUT_MS = 30_000

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

/** The board a page's snapshot shows (the canvas reports it as `projectId`). */
const boardOf = (snapshot: unknown): string | undefined => {
  const value = typeof snapshot === 'object' && snapshot !== null ? (snapshot as { projectId?: unknown }).projectId : undefined
  return typeof value === 'string' ? value : undefined
}

/** The page a call goes to, with the board it last reported. */
export interface BoardPage {
  target: BoardTarget
  snapshot: unknown
}

export class CanvasBoardAgent {
  private readonly clients = new Map<string, Client>()
  private readonly pending = new Map<string, PendingCall>()
  private connections = 0

  /**
   * Register a page's event stream and send it its lease.
   * @param target - the page.
   * @param stream - its event stream.
   * @returns releases the registration.
   */
  connect(target: BoardTarget, stream: EventStream): () => void {
    const key = keyOf(target)
    const prior = this.clients.get(key)
    if (prior !== undefined) {
      this.release(prior)
      prior.stream.close()
    }
    const client: Client = {
      target, generation: randomUUID(), writeToken: randomUUID(), stream, snapshot: null, sequence: 0, connectedAt: ++this.connections,
    }
    this.clients.set(key, client)
    stream.send('hello', { target, generation: client.generation, writeToken: client.writeToken })
    return () => { this.release(client) }
  }

  private release(client: Client): void {
    // A late close from a replaced stream must not remove its successor.
    if (this.clients.get(keyOf(client.target)) === client) this.clients.delete(keyOf(client.target))
    // A closed page answers nothing more; its open calls fail now rather than at the timeout.
    for (const call of [...this.pending.values()]) {
      if (call.client === client) {
        call.settle({ error: new BoardAgentError(503, 'CANVAS_BOARD_GONE', 'The storyboard page closed before it answered; the outcome is unconfirmed. Read the board before deciding whether to try again.') })
      }
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
    // Late or repeated pushes are harmless no-ops.
    if (sequence > client.sequence) {
      client.sequence = sequence
      client.snapshot = snapshot
    }
    return true
  }

  /**
   * Accept a page's answer to a tool call.
   * @param lease - the page's lease.
   * @param answer - the call it answers and its outcome; without one, only the lease is checked.
   * @returns whether the lease is current (and, with an answer, whether the call was waiting for this page).
   */
  resolve(lease: BoardLease, answer?: BoardCallAnswer): boolean {
    const client = this.owned(lease)
    if (client === undefined) return false
    if (answer === undefined) return true
    const call = this.pending.get(answer.requestId)
    if (call === undefined || call.client !== client) return false
    if (answer.error !== undefined && answer.error !== null) {
      const message = typeof answer.error === 'string' ? answer.error : JSON.stringify(answer.error)
      call.settle({ error: new BoardAgentError(502, 'CANVAS_BOARD_REFUSED', message) })
      return true
    }
    // An applied batch's answer is the board it produced: readable before its caller hears back.
    const result = answer.result
    if (call.name === 'canvas_apply_ops' && typeof answer.sequence === 'number' && typeof result === 'object' && result !== null && Array.isArray((result as { nodes?: unknown }).nodes)) {
      this.setSnapshot(lease, result, answer.sequence)
    }
    call.settle({ result: result ?? null })
    return true
  }

  /**
   * The pages open for a project.
   * @param projectId - the project.
   * @returns each page, the board it shows, whether it has reported it, and its selection.
   */
  list(projectId: string): Array<{ target: BoardTarget; boardId: string | null; ready: boolean; selectedNodeIds: string[] }> {
    return [...this.clients.values()]
      .filter(client => client.target.projectId === projectId)
      .sort((left, right) => right.connectedAt - left.connectedAt)
      .map((client) => {
        const selected = (client.snapshot as { selectedNodeIds?: unknown } | null)?.selectedNodeIds
        return {
          target: client.target,
          boardId: boardOf(client.snapshot) ?? null,
          ready: client.snapshot !== null,
          selectedNodeIds: Array.isArray(selected) ? selected.filter((id): id is string => typeof id === 'string') : [],
        }
      })
  }

  /**
   * The page a call should go to: the named one, or else the newest page of
   * the project showing this board.
   * @param input - the project and board, and the caller's explicit target when it named one.
   * @returns the page, or `undefined` when the board is not open anywhere.
   */
  choose(input: { projectId: string; boardId: string; target?: unknown }): BoardPage | undefined {
    if (input.target !== undefined) {
      const target = parseBoardTarget(input.target)
      const exact = this.clients.get(keyOf(target))
      if (exact === undefined || exact.stream.closed) throw new BoardAgentError(409, 'CANVAS_BOARD_NOT_OPEN', 'The selected storyboard page is no longer open. List the pages again with canvas_list_clients.')
      if (exact.snapshot === null) throw new BoardAgentError(409, 'CANVAS_BOARD_NOT_READY', 'The selected page is still loading its board.')
      if (target.projectId !== input.projectId || boardOf(exact.snapshot) !== input.boardId) {
        throw new BoardAgentError(409, 'CANVAS_BOARD_TARGET_MISMATCH', 'The selected page does not show this film\'s board. Read the board again before writing.')
      }
      return { target: exact.target, snapshot: exact.snapshot }
    }
    const pages = [...this.clients.values()].filter(client => client.target.projectId === input.projectId && !client.stream.closed)
    if (pages.length === 0) return undefined
    const showing = pages.filter(client => client.snapshot !== null && boardOf(client.snapshot) === input.boardId)
    if (showing.length === 0) {
      // A loading page may hold newer edits than the saved board; it is not safe to write around it.
      if (pages.some(client => client.snapshot === null)) throw new BoardAgentError(409, 'CANVAS_BOARD_NOT_READY', 'The storyboard page is still loading its board. Try again in a moment.')
      return undefined
    }
    const newest = showing.reduce((best, client) => (client.connectedAt > best.connectedAt ? client : best))
    return { target: newest.target, snapshot: newest.snapshot }
  }

  /**
   * Run a tool call on one page and wait for its answer.
   * @param target - the page (from {@link choose}).
   * @param name - the call (`canvas_apply_ops`, a `director_*` call).
   * @param input - its input, as the page reads it.
   * @param options - cancellation and how long to wait.
   * @returns the page's result.
   */
  call(target: BoardTarget, name: string, input: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const client = this.clients.get(keyOf(target))
    if (client === undefined || client.stream.closed) {
      return Promise.reject(new BoardAgentError(409, 'CANVAS_BOARD_NOT_OPEN', 'The storyboard page is no longer open.'))
    }
    if (options.signal?.aborted === true) return Promise.reject(options.signal.reason as Error)
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { settle({ error: options.signal?.reason as Error }) }
      const timer = setTimeout(() => {
        settle({ error: new BoardAgentError(503, 'CANVAS_BOARD_TIMEOUT', 'The storyboard page did not answer in time; the outcome is unconfirmed. Read the board before deciding whether to try again.') })
      }, options.timeoutMs ?? BOARD_CALL_TIMEOUT_MS)
      const settle = (outcome: { result: unknown } | { error: Error }): void => {
        if (this.pending.get(requestId)?.settle !== settle) return
        this.pending.delete(requestId)
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        if ('error' in outcome) reject(outcome.error)
        else resolve(outcome.result)
      }
      // Registered first: an immediate answer must be able to settle this call.
      this.pending.set(requestId, { client, name, settle })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (!client.stream.send('tool_call', { target: client.target, generation: client.generation, requestId, name, input })) {
        settle({ error: new BoardAgentError(503, 'CANVAS_BOARD_GONE', 'The storyboard page connection failed while sending the call.') })
      }
    })
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
