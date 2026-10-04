/**
 * Canvas pages for the director specs: each takes its lease, reports the
 * film's board, and answers `director_*` calls the way the canvas's director
 * bridge does (canvas web/src/pages/canvas/project.tsx) — a desk that is open
 * answers from its live scene, a closed one says `{ deskOpen: false }`, and a
 * write with the desk closed updates the page's node.
 */

import { CanvasBoardAgent } from '../../src/canvas/board-agent.js'
import type { BoardLease, BoardTarget } from '../../src/canvas/board-agent.js'
import type { EventStream } from '../../src/studio/sse.js'
import { fingerprintOfStoredScene } from '../../src/director/fingerprint.js'

export interface FakeDeskPage {
  target: BoardTarget
  calls: Array<{ name: string; input: Record<string, unknown> }>
  /** The scene the page holds: the open desk's, or its node's. */
  scene: unknown
  deskOpen: boolean
  release(): void
}

export interface PageBehaviour {
  deskOpen?: boolean
  scene?: unknown
  /** Answer this error to every call. */
  refuse?: string
  /** Answer instead of the default behaviour (return undefined to fall back). */
  answer?: (name: string, input: Record<string, unknown>, page: FakeDeskPage) => unknown
}

let counter = 0

/**
 * Open a page on the film's board.
 * @param agent - the board agent the router uses.
 * @param projectId - the film's id (also its board id).
 * @param behaviour - the desk's state and any scripted answers.
 * @returns the page.
 */
export function openDeskPage(agent: CanvasBoardAgent, projectId: string, behaviour: PageBehaviour = {}): FakeDeskPage {
  let lease!: BoardLease
  let closed = false
  const id = ++counter
  const target: BoardTarget = { projectId, clientId: `page-${id}`, incarnation: `load-${id}` }
  const page: FakeDeskPage = {
    target, calls: [], scene: behaviour.scene, deskOpen: behaviour.deskOpen === true,
    release: () => { closed = true; release() },
  }
  const respond = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    if (behaviour.refuse !== undefined) throw new Error(behaviour.refuse)
    const scripted = behaviour.answer?.(name, input, page)
    if (scripted !== undefined) return scripted
    switch (name) {
      case 'director_read_scene':
        return { deskOpen: page.deskOpen, scene: page.scene }
      case 'director_write_scene': {
        const expected = input.expectedFingerprint
        if (typeof expected === 'string' && fingerprintOfStoredScene(page.scene) !== expected) throw new Error('场景在读取后发生变化')
        page.scene = input.scene
        return { deskOpen: page.deskOpen, fingerprint: fingerprintOfStoredScene(input.scene) }
      }
      case 'director_render_status':
        return page.deskOpen ? { deskOpen: true, task: null } : { deskOpen: false }
      default:
        return page.deskOpen ? { deskOpen: true } : { deskOpen: false }
    }
  }
  const stream: EventStream = {
    send(event, data) {
      if (closed) return false
      if (event === 'hello') {
        const hello = data as { generation: string; writeToken: string }
        lease = { target, generation: hello.generation, writeToken: hello.writeToken }
      }
      if (event === 'tool_call') {
        const call = data as { requestId: string; name: string; input: Record<string, unknown> }
        page.calls.push({ name: call.name, input: call.input })
        void respond(call.name, call.input).then(
          result => { agent.resolve(lease, { requestId: call.requestId, result }) },
          (error: unknown) => { agent.resolve(lease, { requestId: call.requestId, error: error instanceof Error ? error.message : String(error) }) },
        )
      }
      return true
    },
    close() { closed = true },
    get closed() { return closed },
  }
  const release = agent.connect(target, stream)
  agent.setSnapshot(lease, { projectId, nodes: [], connections: [], selectedNodeIds: [] }, 1)
  return page
}
