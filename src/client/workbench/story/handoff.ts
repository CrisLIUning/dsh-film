/**
 * Sending screenplay objects to the storyboard canvas (送到画布) and reading
 * back what the canvas and the cut adopted (制作影响), apart from React: which
 * production purposes a card offers, the handoff request, and how impact
 * items are labelled and acted on.
 *
 * Ported from Studio `apps/web/src/components/production/screenwriter/
 * ScreenwriterWorkspace.tsx` (`sendToCanvas`), `StoryReferences.tsx`
 * (准备生成图片 / 准备生成设定卡) and `StoryImpact.tsx`. Handoff only writes the
 * saved board: a source card, and with a purpose an idle image node wired to
 * it. Nothing is generated.
 * @module dsh-film/client/workbench/story/handoff
 */

import type { StoryHandoffRequest, StoryImpactItem } from '../../../screenwriter/contracts/assets.js'
import type { StoryProductionPurpose } from '../../../screenwriter/contracts/production.js'
import type { StoryBindingScope, StoryEntity, StoryMetadata } from '../../../screenwriter/contracts/types.js'

/** The production buttons a card shows: one image purpose, and a dossier sheet for people, places and props. */
export interface ProductionActions {
  image: StoryProductionPurpose
  sheet: StoryProductionPurpose | undefined
}

const SHEETS: Record<StoryEntity['kind'], StoryProductionPurpose> = { person: 'character-sheet', place: 'scene-sheet', prop: 'prop-sheet' }

/**
 * The production purposes for a card (Studio `StoryReferences.tsx:117-121`):
 * a shot gets a storyboard frame; a card gets a production image and the
 * sheet its kind calls for.
 * @param metadata - the saved screenplay's metadata.
 * @param target - the card.
 * @returns the purposes.
 */
export function productionActions(metadata: StoryMetadata, target: { kind: 'entity' | 'shot'; id: string }): ProductionActions {
  if (target.kind === 'shot') return { image: 'shot', sheet: undefined }
  const entity = metadata.entities.find(item => item.id === target.id)
  return { image: 'image', sheet: entity === undefined ? undefined : SHEETS[entity.kind] }
}

/**
 * The handoff request (Studio `sendToCanvas`): against the saved revision,
 * onto the film's one board, with a fresh request id per click so a repeat
 * after an edit is a new production node, never a conflict.
 * @param options - the revision, the object, the board, the scope and the purpose.
 * @returns the request.
 */
export function handoffRequest(options: {
  revision: string
  objectId: string
  boardId: string
  scope?: StoryBindingScope | undefined
  purpose?: StoryProductionPurpose | undefined
  requestId: () => string
}): StoryHandoffRequest {
  const { revision, objectId, boardId, scope, purpose, requestId } = options
  return {
    expectedRevision: revision,
    boardId,
    objectId,
    scope: scope ?? { kind: 'document' },
    ...(purpose !== undefined ? { production: { purpose, requestId: requestId() } } : {}),
  }
}

/**
 * The node to show after a handoff: the new production node when one was
 * made, else the source card.
 * @param response - the plugin's answer.
 * @returns the node id.
 */
export function handoffFocusNode(response: { node: { id: string }; productionNode?: { id: string } | undefined }): string {
  return response.productionNode?.id ?? response.node.id
}

/**
 * A stable React key for an impact item (Studio `StoryImpact.tsx:49`).
 * @param item - the item.
 * @returns the key.
 */
export function impactItemKey(item: StoryImpactItem): string {
  const usage = item.usageId ?? `${item.sourceType ?? 'input'}:${item.nodeId}:${item.clipId ?? ''}:${item.directorShotId ?? ''}:${item.outputPath ?? ''}`
  return `${usage}:${item.field}`
}

/**
 * Where an impact item leads: the timeline for cut items, the canvas node
 * otherwise, or nowhere when the item names no node.
 * @param item - the item.
 * @returns the action.
 */
export function impactAction(item: StoryImpactItem): { kind: 'timeline' } | { kind: 'canvas'; nodeId: string } | { kind: 'none' } {
  if (item.sourceType === 'timeline-media' || item.sourceType === 'timeline-slot') return { kind: 'timeline' }
  return item.nodeId.trim() !== '' ? { kind: 'canvas', nodeId: item.nodeId } : { kind: 'none' }
}
