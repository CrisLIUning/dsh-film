/**
 * The director desk on screen. A desk open in a canvas page holds a scene the
 * board has not saved yet, so reads and writes go through that page; with the
 * page open and the desk closed the page keeps its node current; with no page
 * the board's document is written directly. Ported from Studio's
 * apps/daemon/src/routes/director.ts (`readLiveScene`, `currentScene`,
 * `writeScene`, `writeSceneIntoBoard`).
 *
 * One change in how the page is chosen. Studio's film workspace has one
 * canvas page per board with the desk as an overlay; in the film workbench
 * the storyboard tab and the desk page are two canvas pages on the same board, and the
 * newest page is often the one without the desk. So:
 *
 * - a scene read asks every page showing the board (`director_read_scene`)
 *   and uses the one whose desk is open — two open desks on one node are
 *   refused rather than guessed between, since each would save over the
 *   other — else the newest page, else the saved board;
 * - calls only an open desk can answer (render, output status and cancel)
 *   go to the pages newest first and move on when a page answers
 *   `{ deskOpen: false }`, which the canvas does without running anything.
 *
 * Both rely only on answers the canvas already gives, so the shipped canvas
 * build needs no change. As in Studio, only a page that is gone permits the
 * offline path: a page that refuses or times out may hold newer edits.
 * @module dsh-film/director/live
 */

import { BoardAgentError } from '../canvas/board-agent.js'
import type { BoardTarget, CanvasBoardAgent } from '../canvas/board-agent.js'
import type { CanvasDocumentStore } from '../canvas/documents.js'
import { DIRECTOR_NODE_TYPE, DirectorRefusal, envelopeFor, fingerprintOfStoredScene } from './locate.js'
import type { LocatedScene } from './locate.js'
import { resolveDirectorProject } from './scene.js'
import type { DirectorProject } from './vendor/director-math/schema/directorProject.js'

export const DIRECTOR_READ_SCENE_TOOL = 'director_read_scene'
export const DIRECTOR_WRITE_SCENE_TOOL = 'director_write_scene'

/** What every page call about a director node carries, as the canvas checks it. */
export interface DeskAddress {
  boardId: string
  nodeId: string
  /** The film's project id (the canvas's host project). */
  project: string
}

export interface LiveRead {
  desk: 'open' | 'closed' | 'none'
  scene: unknown
  fingerprint: string | null
  /** The page that answered, for the write that follows. */
  page?: BoardTarget
}

export interface CurrentScene {
  live: LiveRead
  project: DirectorProject | null
  fingerprint: string | null
  desk: 'open' | 'closed' | 'none'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const gone = (error: unknown): boolean => error instanceof BoardAgentError && error.code === 'CANVAS_BOARD_NOT_OPEN'

/** The director desks of the open canvas pages. */
export class DirectorDesks {
  constructor(private readonly agent: CanvasBoardAgent) {}

  /**
   * The pages showing a board, newest first.
   * @param address - the board.
   * @returns the pages, and whether another page of the project is still loading.
   */
  pages(address: Pick<DeskAddress, 'boardId' | 'project'>): { pages: BoardTarget[]; loading: boolean } {
    const all = this.agent.list(address.project)
    return {
      pages: all.filter(page => page.ready && page.boardId === address.boardId).map(page => page.target),
      loading: all.some(page => !page.ready),
    }
  }

  /**
   * The scene as the open desk has it now, as a page's node holds it, or
   * nothing to say when no page shows the board.
   * @param located - the scene's node.
   * @param address - the page address.
   * @param signal - the request's cancellation.
   * @returns the live read.
   */
  async readLive(located: LocatedScene, address: DeskAddress | null, signal?: AbortSignal): Promise<LiveRead> {
    const absent: LiveRead = { desk: 'none', scene: undefined, fingerprint: null }
    if (!located.boardId || address === null) return absent
    const { pages, loading } = this.pages(address)
    if (pages.length === 0) {
      // A loading page may hold newer edits than the saved board; it is not safe to work around it.
      if (loading) throw new BoardAgentError(409, 'CANVAS_BOARD_NOT_READY', 'The storyboard page is still loading its board. Try again in a moment.')
      return absent
    }
    const answers = await Promise.allSettled(pages.map(page => this.agent.call(page, DIRECTOR_READ_SCENE_TOOL, { ...address }, signal ? { signal } : {})))
    const reads: LiveRead[] = []
    for (const [index, outcome] of answers.entries()) {
      if (outcome.status === 'rejected') {
        if (gone(outcome.reason)) continue
        throw outcome.reason
      }
      const answer = outcome.value
      if (!isRecord(answer) || typeof answer.deskOpen !== 'boolean' || !(resolveDirectorProject(answer.scene) || (!answer.deskOpen && answer.scene == null))) {
        throw new BoardAgentError(502, 'DIRECTOR_LIVE_SCENE_INVALID', '页面没有返回有效场景，请刷新后重试')
      }
      reads.push({ desk: answer.deskOpen ? 'open' : 'closed', scene: answer.scene, fingerprint: fingerprintOfStoredScene(answer.scene), page: pages[index]! })
    }
    const open = reads.filter(read => read.desk === 'open')
    if (open.length > 1) {
      throw new DirectorRefusal(409, 'DIRECTOR_DESK_AMBIGUOUS', `导演台节点 ${address.nodeId} 同时在 ${open.length} 个页面里打开；关掉多余的导演台再试`, { nodeId: address.nodeId })
    }
    return open[0] ?? reads[0] ?? absent
  }

  /**
   * The scene a caller should build on: the open desk's when there is one, else the board's.
   * @param located - the scene's node (or an inline scene).
   * @param address - the page address; `null` for an inline scene.
   * @param signal - the request's cancellation.
   * @returns the scene, its fingerprint and where it came from.
   */
  async currentScene(located: LocatedScene, address: DeskAddress | null, signal?: AbortSignal): Promise<CurrentScene> {
    const live = await this.readLive(located, address, signal)
    const project = live.desk !== 'none' ? resolveDirectorProject(live.scene) : resolveDirectorProject(located.stored)
    const fingerprint = live.desk !== 'none' ? live.fingerprint : fingerprintOfStoredScene(located.stored)
    return { live, project, fingerprint, desk: located.boardId ? live.desk : 'none' }
  }

  /**
   * Put a scene where it lives: into the page that answered the read (its
   * desk, or its node when the desk is closed), else into the saved board
   * after checking, under the board's lock, that the node still holds what
   * was read.
   * @param documents - the film's board store.
   * @param located - the scene's node.
   * @param address - the page address.
   * @param live - the read this write builds on.
   * @param project - the scene to write.
   * @param announce - tells open pages the saved board changed.
   * @returns the fingerprint the scene now has and where it went.
   */
  async writeScene(
    documents: Pick<CanvasDocumentStore, 'update'>,
    located: LocatedScene,
    address: DeskAddress,
    live: LiveRead,
    project: DirectorProject,
    announce: () => void,
  ): Promise<{ fingerprint: string; desk: 'open' | 'closed' | 'none' }> {
    const envelope = envelopeFor(project)
    if (live.desk !== 'none' && live.page !== undefined) {
      const answer = await this.agent.call(live.page, DIRECTOR_WRITE_SCENE_TOOL, { ...address, scene: envelope, expectedFingerprint: live.fingerprint })
      if (!isRecord(answer) || typeof answer.deskOpen !== 'boolean' || typeof answer.fingerprint !== 'string') {
        throw new BoardAgentError(502, 'DIRECTOR_WRITE_UNCONFIRMED', '页面尚未确认场景保存成功')
      }
      return { fingerprint: answer.fingerprint, desk: answer.deskOpen ? 'open' : 'closed' }
    }
    await documents.update((document) => {
      if (!document || document.id !== located.boardId) throw new DirectorRefusal(404, 'CANVAS_DOCUMENT_NOT_FOUND', '目标画布已删除或更换')
      const nodes = Array.isArray(document.nodes) ? document.nodes : []
      const target = nodes.find(node => isRecord(node) && node.id === located.nodeId && node.type === DIRECTOR_NODE_TYPE)
      if (!isRecord(target)) throw new DirectorRefusal(404, 'DIRECTOR_NODE_NOT_FOUND', '目标导演台节点已删除')
      const metadata = isRecord(target.metadata) ? target.metadata : {}
      if (fingerprintOfStoredScene(metadata.directorProject) !== fingerprintOfStoredScene(located.stored)) {
        throw new DirectorRefusal(409, 'DIRECTOR_SCENE_CONFLICT', '场景在提交前发生变化，请重新读取再编排')
      }
      return { ...document, nodes: nodes.map(node => node === target ? { ...target, metadata: { ...metadata, directorProject: envelope } } : node), updatedAt: new Date().toISOString() }
    })
    announce()
    return { fingerprint: envelope.projectFingerprint, desk: 'none' }
  }

  /**
   * Run a call only an open desk answers: pages newest first, moving on
   * from a page whose desk is closed.
   * @param address - the page address.
   * @param name - the call.
   * @param input - its own input (the address is added).
   * @param timeoutMs - how long one page may take.
   * @returns the open desk's answer, the last closed answer, or `undefined` when no page shows the board.
   */
  async callDesk(address: DeskAddress, name: string, input: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown> | undefined> {
    let last: Record<string, unknown> | undefined
    for (const page of this.pages(address).pages) {
      let answer: unknown
      try {
        answer = await this.agent.call(page, name, { ...address, ...input }, timeoutMs !== undefined ? { timeoutMs } : {})
      } catch (error) {
        if (gone(error)) continue
        throw error
      }
      if (isRecord(answer) && answer.deskOpen === true) return answer
      last = isRecord(answer) ? answer : { deskOpen: false }
    }
    return last
  }

  /**
   * Run a call on the page that holds a scene (its open desk's page, else
   * the newest page showing the board).
   * @param located - the scene's node.
   * @param address - the page address.
   * @param name - the call.
   * @param input - its own input (the address is added).
   * @returns the page's answer, or `undefined` when no page shows the board.
   */
  async callScenePage(located: LocatedScene, address: DeskAddress, name: string, input: Record<string, unknown>): Promise<unknown | undefined> {
    const live = await this.readLive(located, address)
    if (live.page === undefined) return undefined
    return this.agent.call(live.page, name, { ...address, ...input })
  }
}
