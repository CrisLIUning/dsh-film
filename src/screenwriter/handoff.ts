/**
 * Screenplay sources for production, ported from Studio's StoryHandoff
 * (apps/daemon/src/screenwriter/handoff.ts): one saved entity, scene or shot
 * read as a canvas source preview; sending it to an independent source card
 * on the film's board (optionally with a wired, editable image node for a
 * production purpose); and explicitly adopting its description or reference
 * images into one production node.
 *
 * Everything works on the saved stores, so the 分镜 tab may be closed: the
 * board is changed under its own lock and an open page merges the change
 * when it hears the board changed. Nothing here generates media or calls a
 * model.
 *
 * Differences from Studio: the film has one board, whose id is the project's
 * (film.json), so any other board id is refused before anything is read
 * (`STORY_BOARD_MISMATCH` for a handoff, `STORY_BOARD_NOT_FOUND` for an
 * adoption); a new board takes the film's title; the reference snapshot is
 * written atomically under `film/canvas/story-references/`.
 * @module dsh-film/screenwriter/handoff
 */

import { createHash, randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { resolveStoryReferences, storyEntityProductionText, storyProductionInstruction, STORY_PRODUCTION_PURPOSES } from './contracts/index.js'
import type { StoryAdoption, StoryAdoptRequest, StoryBindingScope, StoryFieldAdoption, StoryHandoffRequest, StorySourcePreview } from './contracts/index.js'
import { BOARD_ID_PATTERN, CanvasDocumentStore, emptyFilmBoard } from '../canvas/documents.js'
import { filmWriteTarget } from '../film-files.js'
import { readProject } from '../project.js'
import type { FilmProject } from '../project.js'
import type { StoryAssets } from './assets.js'
import { StoryError } from './service.js'
import type { StoryService } from './service.js'

/** A board node as the host writes it; the canvas owns the rest of its shape. */
export interface StoryBoardNode {
  id: string
  type: string
  title: string
  position: { x: number; y: number }
  width: number
  height: number
  metadata: Record<string, unknown>
  [key: string]: unknown
}

/** What a handoff answers (Studio's StoryHandoffResponse with the nodes typed). */
export interface StoryHandoffResult {
  created: boolean
  node: StoryBoardNode
  preview: StorySourcePreview
  boardId: string
  productionNode?: StoryBoardNode
  connection?: { id: string; fromNodeId: string; toNodeId: string }
}

/** What an adoption answers. */
export interface StoryAdoptResult {
  node: StoryBoardNode
  adoption: StoryAdoption | undefined
  preview: StorySourcePreview
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * The film of a workspace, which every production service needs: its id is
 * the id in previews and URLs and the board's id.
 * @param cwd - the workspace directory.
 * @returns the film.
 */
export async function filmProjectOf(cwd: string): Promise<FilmProject> {
  const project = await readProject(cwd)
  if (project === null) throw new StoryError(404, 'PROJECT_NOT_FOUND', 'This workspace has no film yet. It is created when a film tab opens in the sidebar (or with film_project).')
  return project
}

export class StoryHandoff {
  /**
   * @param story - the screenplay store.
   * @param assets - reference resolution.
   * @param fileChanged - told about each film file a reference adoption writes (relative to `film/`), with the film's id.
   */
  constructor(private readonly story: StoryService, private readonly assets: StoryAssets, private readonly fileChanged: (cwd: string, path: string, projectId: string) => void = () => {}) {}

  /**
   * One saved entity, scene or shot as a canvas source preview: its text,
   * its production brief, its revision and its resolved reference versions.
   * @param cwd - the workspace directory.
   * @param documentId - the screenplay.
   * @param objectId - the entity, scene or shot.
   * @param scope - document scope, or a scene whose reference overrides apply.
   * @returns the preview.
   */
  async preview(cwd: string, documentId: string, objectId: string, scope?: StoryBindingScope): Promise<StorySourcePreview> {
    const projectId = (await filmProjectOf(cwd)).id
    const document = await this.story.get(cwd, documentId)
    const metadata = document.parsed.metadata
    if (!metadata || !document.parsed.semanticEditable) throw new StoryError(422, 'STORY_SOURCE_UNRESOLVED', 'Repair the screenplay relationships before handing it to production.')
    const entity = metadata.entities.find(item => item.id === objectId)
    const scene = metadata.scenes.find(item => item.id === objectId)
    const shot = metadata.shots.find(item => item.id === objectId)
    if (!entity && !scene && !shot) {
      if (document.parsed.blocks.some(block => block.id === objectId)) throw new StoryError(422, 'STORY_SOURCE_KIND_UNSUPPORTED', 'objectId must name an entity, scene or shot, not a text block. Use canvas_create_text_nodes for briefs or notes.')
      throw new StoryError(404, 'STORY_SOURCE_NOT_FOUND', 'The source entity, scene or shot does not exist in this revision.')
    }
    const objectKind = entity ? 'entity' : scene ? 'scene' : 'shot'
    const blockIds = entity ? [entity.profileBlockId] : scene ? scene.blockIds : [shot!.descriptionBlockId]
    const blocks = blockIds.flatMap(id => document.parsed.blocks.filter(block => block.id === id))
    const markdown = blocks.map(block => block.markdown).join('\n\n')
    const title = (blocks[0]?.markdown.split('\n').find(line => line.trim()) ?? objectId).replace(/^\s*#{1,6}\s+/u, '').trim()
    // A shot uses its own scene's overrides; a scope names the scene explicitly.
    const sceneId = scope?.kind === 'scene' ? scope.sceneId : shot?.sceneId ?? scene?.id
    if (scope && scope.kind !== 'document' && scope.kind !== 'scene') throw new StoryError(400, 'STORY_SCOPE_INVALID', 'Choose document or scene scope.')
    if (sceneId && !metadata.scenes.some(item => item.id === sceneId)) throw new StoryError(400, 'STORY_SCOPE_NOT_FOUND', 'The reference scope scene does not exist.')
    const resolved = await this.assets.resolve(cwd, document, projectId)
    const relatedEntityIds = [...new Set(entity ? [entity.id] : shot ? [
      ...shot.entityIds,
      ...metadata.scenes.filter(item => item.id === shot.sceneId).flatMap(item => item.placeId ? [item.placeId] : []),
    ] : [
      ...(scene?.placeId ? [scene.placeId] : []),
      ...metadata.speech.filter(item => blockIds.includes(item.blockId)).map(item => item.speakerId),
      ...metadata.appearances.filter(item => item.sceneId === scene?.id && typeof item.entityId === 'string').map(item => item.entityId as string),
    ])]
    const relatedEntities = metadata.entities.filter(item => relatedEntityIds.includes(item.id))
    const selected = resolveStoryReferences(metadata, { target: { kind: entity ? 'entity' : 'shot', id: objectId }, ...(sceneId ? { sceneId } : {}) }).flatMap(group => group.bindings)
    if (!entity) {
      for (const related of relatedEntities) {
        for (const group of resolveStoryReferences(metadata, { target: { kind: 'entity', id: related.id }, ...(sceneId ? { sceneId } : {}) })) {
          const primary = group.bindings.filter(binding => binding.primary)
          selected.push(...(primary.length ? primary : group.bindings))
        }
      }
    }
    const productionText = [markdown,
      typeof metadata.document.visualStyle === 'string' && metadata.document.visualStyle.trim() ? `项目视觉风格：${metadata.document.visualStyle.trim()}` : '',
      ...relatedEntities.map((related) => {
        const profile = entity ? '' : document.parsed.blocks.find(block => block.id === related.profileBlockId)?.markdown ?? ''
        return [profile, storyEntityProductionText(related, metadata, sceneId)].filter(Boolean).join('\n')
      }),
    ].filter(Boolean).join('\n\n')
    const dependencyIds = [...new Set([
      ...(shot?.sourceBlockIds ?? blockIds),
      ...metadata.entities.filter(item => relatedEntityIds.includes(item.id)).map(item => item.profileBlockId),
    ])]
    return {
      projectId, documentId, objectId, objectKind, ...(entity ? { entityKind: entity.kind } : {}), title, markdown, productionText, revision: document.revision,
      dependencies: dependencyIds.flatMap(id => document.parsed.blocks.filter(block => block.id === id).map(block => ({ blockId: block.id, markdown: block.markdown }))),
      relatedEntityIds,
      references: [...new Map(selected.map(binding => [`${binding.assetId}/${binding.assetVersionId}`, binding])).values()].map((binding) => {
        const reference = resolved.references.find(item => item.asset.id === binding.assetId && item.asset.versionId === binding.assetVersionId)
        return {
          assetId: binding.assetId, assetVersionId: binding.assetVersionId, status: reference?.status ?? 'missing', primary: binding.primary,
          ...(reference ? { title: reference.asset.projectRelativePath, sha256: reference.asset.sha256 } : {}),
          ...(reference?.resolvedPath ? { url: storyReferenceUrl(projectId, documentId, binding.assetId, binding.assetVersionId) } : {}),
        }
      }),
    }
  }

  /**
   * Send a saved object to a source card on the film's board, reusing the
   * card of the same document, object and scope unless `duplicate`; with
   * `production`, also a wired, editable, idle image node for that purpose.
   * @param cwd - the workspace directory.
   * @param documentId - the screenplay.
   * @param request - the object, its revision, the board and the options.
   * @returns the card, the preview and any production node and wire.
   */
  async send(cwd: string, documentId: string, request: StoryHandoffRequest): Promise<StoryHandoffResult> {
    const film = await filmProjectOf(cwd)
    const projectId = film.id
    validateBoard(request.boardId)
    if (request.boardId !== projectId) throw new StoryError(409, 'STORY_BOARD_MISMATCH', 'This project has a different active canvas.')
    const preview = await this.preview(cwd, documentId, request.objectId, request.scope)
    if (preview.revision !== request.expectedRevision) throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay changed before handoff.', await this.story.get(cwd, documentId))
    if (request.production && (!STORY_PRODUCTION_PURPOSES.includes(request.production.purpose) || typeof request.production.requestId !== 'string' || !REQUEST_ID.test(request.production.requestId))) {
      throw new StoryError(400, 'STORY_PRODUCTION_INVALID', 'Choose a supported purpose and a stable requestId.')
    }
    if ((request.production?.purpose === 'character-sheet' && preview.entityKind !== 'person') || (request.production?.purpose === 'scene-sheet' && preview.entityKind !== 'place')
      || (request.production?.purpose === 'prop-sheet' && preview.entityKind !== 'prop')) {
      throw new StoryError(422, 'STORY_PRODUCTION_KIND', 'The requested sheet must match the screenplay entity kind.')
    }
    if (request.production && request.duplicate) throw new StoryError(400, 'STORY_PRODUCTION_INVALID', 'Production reuses its source card; duplicate applies only to source handoff.')
    let productionNode: StoryBoardNode | undefined
    let connection: { id: string; fromNodeId: string; toNodeId: string } | undefined
    let created = false
    let sourceNode: StoryBoardNode | undefined
    await new CanvasDocumentStore(cwd, projectId).update((current) => {
      if (current && current.id !== request.boardId) throw new StoryError(409, 'STORY_BOARD_MISMATCH', 'This project has a different active canvas.')
      const board = current ?? emptyFilmBoard(request.boardId, film.title)
      const nodes = Array.isArray(board.nodes) ? board.nodes as StoryBoardNode[] : []
      sourceNode = !request.duplicate
        ? nodes.find((node) => {
          const source = node.metadata?.storySource as Record<string, unknown> | undefined
          return (node.type === 'text' || node.type === 'story-source') && source?.documentId === documentId && source?.objectId === request.objectId
            && (source.projectId === undefined || source.projectId === projectId)
            && isDeepStrictEqual(source.scope ?? { kind: 'document' }, request.scope ?? { kind: 'document' })
        })
        : undefined
      if (!sourceNode) {
        created = true
        sourceNode = {
          id: `story-source-${randomUUID()}`, type: 'text', title: preview.title,
          position: { x: nodes.reduce((right, node) => Math.max(right, (node.position?.x ?? 0) + (node.width ?? 0)), 0) + 64, y: 80 }, width: 340, height: 410,
          metadata: { content: preview.productionText ?? preview.markdown, storySource: { projectId, documentId, objectId: request.objectId, objectKind: preview.objectKind, scope: request.scope ?? { kind: 'document' }, snapshot: preview }, storyNote: '' },
        }
      }
      if (!created) {
        const source = sourceNode.metadata.storySource as Record<string, unknown>
        const snapshot = source.snapshot as StorySourcePreview | undefined
        const savedText = snapshot?.productionText ?? snapshot?.markdown
        const content = sourceNode.metadata.content
        // Reuse the same id and all metadata/wires. An edited body (even '')
        // survives refresh; only text still following its snapshot advances.
        sourceNode = { ...sourceNode, type: 'text', metadata: { ...sourceNode.metadata,
          ...(content === undefined ? { content: savedText ?? preview.productionText ?? preview.markdown } : {}),
          ...(request.production ? {
            storySource: { ...source, snapshot: preview },
            ...(content === undefined || content === savedText ? { content: preview.productionText ?? preview.markdown } : {}),
          } : {}),
        } }
      }
      const nextNodes = created ? [...nodes, sourceNode] : nodes.map(node => node.id === sourceNode!.id ? sourceNode! : node)
      if (request.production) {
        const id = `story-production-${request.production.requestId}`
        productionNode = nodes.find(node => node.id === id)
        const identity = { projectId, documentId, objectId: request.objectId, scope: request.scope ?? { kind: 'document' }, purpose: request.production.purpose, revision: preview.revision, sourceNodeId: sourceNode.id }
        if (productionNode && !isDeepStrictEqual(productionNode.metadata.storyProduction, identity)) throw new StoryError(409, 'STORY_PRODUCTION_CONFLICT', 'This requestId already belongs to another production request.')
        if (!productionNode) {
          const prompt = storyProductionInstruction(request.production.purpose)
          const below = nodes.filter(node => (node.metadata?.storyProduction as { sourceNodeId?: string } | undefined)?.sourceNodeId === sourceNode!.id)
            .reduce((bottom, node) => Math.max(bottom, node.position.y + node.height + 40), sourceNode.position.y)
          productionNode = {
            id, type: 'image', title: `${preview.title} · ${request.production.purpose === 'image' ? '制作图' : request.production.purpose === 'shot' ? '分镜图' : '设定卡'}`,
            position: { x: sourceNode.position.x + sourceNode.width + 80, y: below }, width: 340, height: 340,
            metadata: {
              prompt, composerContent: prompt, generationMode: 'image', status: 'idle', ...(request.production.purpose.endsWith('-sheet') ? { count: 1 } : {}),
              storyProduction: identity, promptPurpose: request.production.purpose,
            },
          }
          nextNodes.push(productionNode)
          connection = { id: `story-wire-${request.production.requestId}`, fromNodeId: sourceNode.id, toNodeId: id }
        }
      }
      return { ...board, nodes: nextNodes, connections: [...(Array.isArray(board.connections) ? board.connections : []), ...(connection ? [connection] : [])], updatedAt: new Date().toISOString() }
    })
    return { created, node: sourceNode!, preview, boardId: request.boardId, ...(productionNode ? { productionNode } : {}), ...(connection ? { connection } : {}) }
  }

  /**
   * Explicitly adopt the description and/or the reference images of a saved
   * object into one production node, if that node's saved fields are still
   * what the caller compared. Reference adoption snapshots the selected bytes.
   * @param cwd - the workspace directory.
   * @param documentId - the screenplay.
   * @param request - the object, revision, target node, fields and the target's expected values.
   * @returns the updated node, its adoption record and the preview adopted.
   */
  async adopt(cwd: string, documentId: string, request: StoryAdoptRequest): Promise<StoryAdoptResult> {
    const projectId = (await filmProjectOf(cwd)).id
    validateBoard(request.boardId)
    if (!Array.isArray(request.fields) || !request.fields.length || request.fields.some(field => field !== 'prompt' && field !== 'references') || !request.expectedTarget || typeof request.expectedTarget !== 'object') {
      throw new StoryError(400, 'STORY_ADOPTION_FIELDS', 'Choose prompt and/or references, with the current target fields for comparison.')
    }
    if (request.boardId !== projectId) throw new StoryError(404, 'STORY_BOARD_NOT_FOUND', 'Target canvas not found.')
    const preview = await this.preview(cwd, documentId, request.objectId, request.scope)
    const document = await this.story.get(cwd, documentId)
    if (document.revision !== preview.revision || preview.revision !== request.expectedRevision) throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay changed before adoption.', document)
    let resultNode: StoryBoardNode | undefined
    let adoption: StoryAdoption | undefined
    await new CanvasDocumentStore(cwd, projectId).update(async (board) => {
      if (!board || board.id !== request.boardId || !Array.isArray(board.nodes)) throw new StoryError(404, 'STORY_BOARD_NOT_FOUND', 'Target canvas not found.')
      const nodes = board.nodes as StoryBoardNode[]
      const target = nodes.find(node => node.id === request.targetNodeId)
      if (!target || !['text', 'config', 'image', 'video', 'audio'].includes(target.type)) {
        throw new StoryError(422, 'STORY_PRODUCTION_NODE_UNSUPPORTED', 'Choose a text, configuration, image, video or audio production node that consumes these fields.')
      }
      if (target.type === 'audio' && request.fields.includes('references')) throw new StoryError(422, 'STORY_PRODUCTION_FIELD_UNSUPPORTED', 'Audio production accepts the description; it does not consume image references.')
      const metadata = target.metadata ?? {}
      const keys = request.fields.flatMap(field => field === 'prompt' ? ['prompt', 'composerContent'] as const : ['references'] as const)
      for (const key of keys) {
        if (!isDeepStrictEqual(metadata[key], request.expectedTarget[key])) throw new StoryError(409, 'STORY_TARGET_CONFLICT', `Production field ${key} changed. Compare it again before adopting.`)
      }
      const patch: Record<string, unknown> = {}
      if (request.fields.includes('prompt')) {
        patch.prompt = preview.productionText ?? preview.markdown
        patch.composerContent = preview.productionText ?? preview.markdown
      }
      if (request.fields.includes('references')) {
        const urls: string[] = []
        for (const reference of preview.references) {
          if (!reference.url || !reference.sha256) throw new StoryError(409, 'STORY_ASSET_UNAVAILABLE', 'A selected reference version is unavailable; existing generation inputs remain unchanged.')
          const file = await this.assets.readReference(cwd, document, reference.assetId, reference.assetVersionId, projectId)
          const extension = file.mime === 'image/jpeg' ? 'jpg' : file.mime.split('/')[1]?.replace(/[^a-z0-9]/giu, '') || 'png'
          const filePath = `canvas/story-references/${reference.sha256}.${extension}`
          // Adoption is explicit. Its immutable byte snapshot keeps future
          // original-file edits from silently changing production inputs.
          await writeAtomically(cwd, filePath, file.buffer)
          this.fileChanged(cwd, filePath, projectId)
          urls.push(`/api/projects/${encodeURIComponent(projectId)}/raw/${filePath}`)
        }
        patch.references = [...new Set(urls)]
      }
      const provenance: StoryFieldAdoption = {
        projectId, documentId, objectId: request.objectId, objectKind: preview.objectKind, revision: preview.revision, scope: request.scope ?? { kind: 'document' },
        snapshot: preview, adoptedAt: new Date().toISOString(), contentDigest: sha256Json(patch),
      }
      const prior = metadata.storyAdoption as StoryAdoption | undefined
      const fieldAdoptions: StoryAdoption['fieldAdoptions'] = { ...prior?.fieldAdoptions }
      // Older source cards recorded one adoption for a field set. Preserve that
      // evidence when the first partial adoption adds per-field provenance.
      if (prior?.revision && Array.isArray(prior.fields)) {
        for (const field of prior.fields) {
          if ((field === 'prompt' || field === 'references') && !fieldAdoptions[field]) {
            const { fields: _fields, fieldAdoptions: _byField, ...oldSource } = prior
            fieldAdoptions[field] = oldSource
          }
        }
      }
      for (const field of request.fields) {
        const adopted = field === 'prompt' ? { prompt: patch.prompt, composerContent: patch.composerContent } : { references: patch.references }
        fieldAdoptions[field] = { ...provenance, contentDigest: sha256Json(adopted) }
      }
      adoption = { ...provenance, fields: [...new Set(request.fields)], fieldAdoptions }
      resultNode = { ...target, metadata: { ...metadata, ...patch, storyAdoption: adoption } }
      return { ...board, nodes: nodes.map(node => node.id === target.id ? resultNode! : node), updatedAt: new Date().toISOString() }
    })
    return { node: resultNode!, adoption, preview }
  }
}

/**
 * The Studio path of one bound reference version's bytes, as previews carry it.
 * @param projectId - the film.
 * @param documentId - the screenplay.
 * @param assetId - the asset.
 * @param versionId - its version.
 * @returns the path.
 */
export function storyReferenceUrl(projectId: string, documentId: string, assetId: string, versionId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/story/documents/${encodeURIComponent(documentId)}/references/${encodeURIComponent(assetId)}/${encodeURIComponent(versionId)}`
}

const sha256Json = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function validateBoard(boardId: unknown): void {
  if (typeof boardId !== 'string' || !BOARD_ID_PATTERN.test(boardId)) throw new StoryError(400, 'STORY_BOARD_ID_REQUIRED', 'A stable target board ID is required.')
}

/** Write a film file through a temporary file in the same, proven-inside, folder. */
async function writeAtomically(cwd: string, filePath: string, bytes: Buffer): Promise<void> {
  const path = await filmWriteTarget(cwd, filePath).catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'EPATHESCAPE' ? new StoryError(400, 'STORY_PATH_ESCAPE', `${filePath} leaves the film.`) : error
  })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, bytes)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
