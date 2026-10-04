/**
 * Screenplay sources on director shots, ported from Studio's
 * StoryDirectorLinksService (apps/daemon/src/screenwriter/director-links.ts):
 * list the film board's director nodes with their saved cameras, and link or
 * unlink one saved screenplay object with one camera. A link is provenance
 * only (`metadata.storyDirectorLinks` on the director node): the 3D scene is
 * never created, read into or rearranged here.
 *
 * Both writes and listings are guarded by two fingerprints: the director
 * scene's (FNV-1a over the stored project, as the desk takes it) and the
 * links' own (SHA-256 of their JSON). A director desk open on a page may hold
 * an unsaved scene, so the open page is asked (`director_read_scene`); a scene
 * that differs from the saved one must be saved before linking.
 *
 * Differences from Studio: the board must be the film's (its project id);
 * cameras are read from the stored project as it is, without the desk's
 * version upgrade (every version keeps `cameras[].id` and `name`; a camera
 * that the upgrade would reject as malformed is still listed here).
 * @module dsh-film/screenwriter/director-links
 */

import { createHash } from 'node:crypto'
import type { StoryBindingScope, StoryDirectorLink, StorySourcePreview } from './contracts/index.js'
import { CanvasDocumentStore } from '../canvas/documents.js'
import { fingerprintOfStoredScene, storedDirectorProject } from '../director/fingerprint.js'
import { filmProjectOf } from './handoff.js'
import type { StoryHandoff } from './handoff.js'
import { StoryError } from './service.js'
import type { StoryService } from './service.js'

export type StoryDirectorLinks = Record<string, StoryDirectorLink[]>

interface DirectorNode { id: string; type: string; title?: string; metadata?: Record<string, unknown> }

export interface StoryDirectorLinkRequest {
  expectedRevision: string
  objectId: string
  boardId: string
  directorNodeId: string
  directorShotId: string
  scope?: StoryBindingScope
  expectedDirectorFingerprint: string
  expectedLinksFingerprint: string
  action: 'link' | 'unlink'
}

/** One director node as listed. */
export interface StoryDirectorCandidate {
  nodeId: string
  title: string
  directorFingerprint: string | null
  linksFingerprint: string
  savedScene: boolean
  shots: Array<{ directorShotId: string; name: string }>
  links: StoryDirectorLinks
}

/** What an open page says about one director node's desk. */
export type ReadLiveDirector = (boardId: string, nodeId: string, projectId: string) => Promise<{ deskOpen: boolean; scene?: unknown }>

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const safe = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)

/**
 * The cameras of a stored or live scene, as shots to choose from.
 * @param value - a node's `directorProject`, or a desk's answer.
 * @returns each camera's id and name.
 */
function directorShots(value: unknown): Array<{ directorShotId: string; name: string }> {
  const project = storedDirectorProject(value)
  return (project?.cameras ?? []).flatMap((camera) => {
    if (!object(camera) || typeof camera.id !== 'string') return []
    return [{ directorShotId: camera.id, name: typeof camera.name === 'string' && camera.name !== '' ? camera.name : camera.id }]
  })
}

export class StoryDirectorLinksService {
  /**
   * @param story - the screenplay store.
   * @param handoff - source previews.
   * @param readLive - asks the open page about a director desk; without it every desk counts as closed.
   */
  constructor(private readonly story: StoryService, private readonly handoff: StoryHandoff, private readonly readLive?: ReadLiveDirector) {}

  private async project(cwd: string, boardId: unknown): Promise<string> {
    const projectId = (await filmProjectOf(cwd)).id
    if (!safe(projectId) || !safe(boardId)) throw new StoryError(400, 'STORY_DIRECTOR_ID', 'A stable project and board ID are required.')
    if (boardId !== projectId) throw new StoryError(404, 'STORY_BOARD_NOT_FOUND', 'Canvas not found.')
    return projectId
  }

  private links(node: DirectorNode): StoryDirectorLinks {
    const value = node.metadata?.storyDirectorLinks
    if (value === undefined) return {}
    if (!object(value) || Object.values(value).some(items => !Array.isArray(items) || items.some(item => !object(item) || !object(item.preview) || typeof item.linkedAt !== 'string'))) {
      throw new StoryError(422, 'STORY_DIRECTOR_LINKS_INVALID', 'Existing director source links are malformed; they were preserved.')
    }
    return value as StoryDirectorLinks
  }

  private async state(projectId: string, boardId: string, node: DirectorNode) {
    const stored = node.metadata?.directorProject
    const storedFingerprint = fingerprintOfStoredScene(stored)
    const live = await this.readLive?.(boardId, node.id, projectId)
    const liveFingerprint = live?.deskOpen ? fingerprintOfStoredScene(live.scene) : null
    return {
      storedFingerprint,
      directorFingerprint: liveFingerprint ?? storedFingerprint,
      savedScene: Boolean(storedFingerprint && (!live?.deskOpen || liveFingerprint === storedFingerprint)),
      shots: directorShots(live?.deskOpen ? live.scene : stored),
    }
  }

  /**
   * The board's director nodes with their shots, links and fingerprints.
   * @param cwd - the workspace directory.
   * @param boardId - the film's board.
   * @returns the candidates.
   */
  async list(cwd: string, boardId: string): Promise<{ boardId: string; directors: StoryDirectorCandidate[] }> {
    const projectId = await this.project(cwd, boardId)
    const board = await new CanvasDocumentStore(cwd, projectId).read(boardId)
    const directors: StoryDirectorCandidate[] = []
    for (const node of (Array.isArray(board?.nodes) ? board.nodes : []) as DirectorNode[]) {
      if (node.type !== 'director') continue
      const state = await this.state(projectId, boardId, node)
      const links = this.links(node)
      directors.push({ nodeId: node.id, title: node.title || node.id, directorFingerprint: state.directorFingerprint, linksFingerprint: digest(links), savedScene: state.savedScene, shots: state.shots, links })
    }
    return { boardId, directors }
  }

  /**
   * Link or unlink one saved screenplay object with one director shot.
   * @param cwd - the workspace directory.
   * @param documentId - the screenplay.
   * @param request - the object, revision, node, shot, fingerprints and action.
   * @returns whether the board changed, the director node, the preview and the screenplay revision.
   */
  async mutate(cwd: string, documentId: string, request: StoryDirectorLinkRequest): Promise<{ changed: boolean; node: DirectorNode; preview: StorySourcePreview; revision: string }> {
    const projectId = await this.project(cwd, request.boardId)
    const targetId = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f]/u.test(value)
    if (!targetId(request.directorNodeId) || !targetId(request.directorShotId) || !['link', 'unlink'].includes(request.action)
      || typeof request.expectedDirectorFingerprint !== 'string' || typeof request.expectedLinksFingerprint !== 'string') {
      throw new StoryError(400, 'STORY_DIRECTOR_SELECTION', 'Read and choose an existing director node and shot before linking.')
    }
    const baseline = await this.story.get(cwd, documentId)
    if (baseline.revision !== request.expectedRevision) throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay changed before director linking.', baseline)
    let preview: StorySourcePreview | undefined
    try {
      preview = await this.handoff.preview(cwd, documentId, request.objectId, request.scope)
    } catch (error) {
      // A deleted source can still be unlinked from its saved snapshot.
      if (request.action !== 'unlink' || !(error instanceof StoryError) || error.code !== 'STORY_SOURCE_NOT_FOUND') throw error
    }
    if (preview && preview.revision !== request.expectedRevision) throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay changed before director linking.', await this.story.get(cwd, documentId))
    let changed = false
    let linkedNode: DirectorNode | undefined
    await new CanvasDocumentStore(cwd, projectId).update(async (board) => {
      if (!board || !Array.isArray(board.nodes)) throw new StoryError(404, 'STORY_BOARD_NOT_FOUND', 'Canvas not found.')
      const nodes = board.nodes as DirectorNode[]
      const node = nodes.find(item => item.id === request.directorNodeId && item.type === 'director')
      if (!node) throw new StoryError(404, 'STORY_DIRECTOR_NOT_FOUND', 'Director node not found.')
      const state = await this.state(projectId, request.boardId, node)
      if (!state.savedScene) throw new StoryError(409, 'STORY_DIRECTOR_UNSAVED', 'Save or close the director desk before linking its shots.')
      if (state.directorFingerprint !== request.expectedDirectorFingerprint) throw new StoryError(409, 'STORY_DIRECTOR_CONFLICT', 'The director scene changed. Read its shots again.')
      if (request.action === 'link' && !state.shots.some(shot => shot.directorShotId === request.directorShotId)) throw new StoryError(404, 'STORY_DIRECTOR_SHOT_NOT_FOUND', 'The selected director shot no longer exists.')
      const links = this.links(node)
      if (digest(links) !== request.expectedLinksFingerprint) throw new StoryError(409, 'STORY_DIRECTOR_LINK_CONFLICT', 'Director source links changed. Read them again.')
      const current = await this.story.get(cwd, documentId)
      if (current.revision !== request.expectedRevision) throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay changed before director linking.', current)
      const scope = request.scope ?? { kind: 'document' as const }
      const values = Object.hasOwn(links, request.directorShotId) ? links[request.directorShotId]! : []
      const matches = (item: StoryDirectorLink): boolean => item.preview.projectId === projectId && item.preview.documentId === documentId && item.preview.objectId === request.objectId
        && JSON.stringify(item.scope) === JSON.stringify(scope)
      const prior = values.find(matches)
      preview ??= prior?.preview
      if (!preview) throw new StoryError(404, 'STORY_DIRECTOR_LINK_NOT_FOUND', 'This source link no longer exists.')
      if ((request.action === 'unlink' && !prior) || (request.action === 'link' && prior?.preview.revision === preview.revision)) {
        linkedNode = node
        return board
      }
      const next = values.filter(item => !matches(item))
      if (request.action === 'link') next.push({ preview, scope, linkedAt: new Date().toISOString() })
      const updated = { ...links, [request.directorShotId]: next }
      if (!next.length) delete updated[request.directorShotId]
      linkedNode = { ...node, metadata: { ...node.metadata, storyDirectorLinks: updated } }
      changed = true
      return { ...board, nodes: nodes.map(item => item.id === node.id ? linkedNode! : item), updatedAt: new Date().toISOString() }
    })
    return { changed, node: linkedNode!, preview: preview!, revision: baseline.revision }
  }
}
