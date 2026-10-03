/**
 * Editing a person, place, prop or shot card (ported from Studio's
 * `card-draft.ts`). A card is a record in the screenplay's declaration plus
 * its profile block in the body: the first line is the name, the rest the
 * description. Saving re-reads the screenplay and merges field by field, so
 * an agent's edit to another field of the same card survives.
 */

import type { StoryDocument, StoryEntity, StoryOperation, StoryShot } from '../../../screenwriter/contracts/types.js'

export interface StoryCardFields {
  name: string
  description: string
  visualIdentity: string
  visualState: string
  sceneId: string | null
  estimatedSeconds: number | null
  sourceBlockIds: string[]
  entityIds: string[]
}

export type StoryCardField = keyof StoryCardFields

export interface StoryCardTarget {
  kind: 'entity' | 'shot'
  id: string
}

export interface StoryCardSnapshot {
  revision: string
  target: StoryCardTarget
  blockId: string
  markdown: string
  record: StoryEntity | StoryShot
  fields: StoryCardFields
}

export const CARD_FIELDS: readonly StoryCardField[] = ['name', 'description', 'visualIdentity', 'visualState', 'sceneId', 'estimatedSeconds', 'sourceBlockIds', 'entityIds']

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The first line of a profile block, without its heading marks. */
export const cardName = (markdown: string): string => markdown.trim().split('\n')[0]?.replace(/^#{1,6}\s*/, '').trim() ?? ''

/** Everything after a profile block's first line. */
export const cardDescription = (markdown: string): string => markdown.trim().split('\n').slice(1).join('\n').trim()

/**
 * A card as the screenplay has it now.
 * @param document - the screenplay.
 * @param target - the card.
 * @returns the card, or `null` when it or its profile block is gone.
 */
export function readStoryCard(document: StoryDocument, target: StoryCardTarget): StoryCardSnapshot | null {
  const metadata = document.parsed.metadata
  const record = target.kind === 'entity'
    ? metadata?.entities.find(item => item.id === target.id)
    : metadata?.shots.find(item => item.id === target.id)
  if (record === undefined) return null
  const blockId = target.kind === 'entity' ? (record as StoryEntity).profileBlockId : (record as StoryShot).descriptionBlockId
  const block = document.parsed.blocks.find(item => item.id === blockId)
  if (block === undefined) return null
  const shot = target.kind === 'shot' ? record as StoryShot : null
  return {
    revision: document.revision,
    target,
    blockId,
    markdown: block.markdown,
    record,
    fields: {
      name: cardName(block.markdown),
      description: cardDescription(block.markdown),
      visualIdentity: typeof record.visualIdentity === 'string' ? record.visualIdentity : '',
      visualState: typeof record.visualState === 'string' ? record.visualState : '',
      sceneId: shot?.sceneId ?? null,
      estimatedSeconds: shot?.estimatedSeconds ?? null,
      sourceBlockIds: shot?.sourceBlockIds ?? [],
      entityIds: shot?.entityIds ?? [],
    },
  }
}

/**
 * Merge the person's edits into the card as it is now. Only fields they
 * changed are written; a field changed both here and elsewhere is a conflict.
 * @param baseline - the card when the form opened.
 * @param local - the form.
 * @param remote - the card now.
 */
export function mergeStoryCardFields(baseline: StoryCardFields, local: StoryCardFields, remote: StoryCardFields): { merged: StoryCardFields; conflicts: StoryCardField[] } {
  const merged = { ...remote }
  const conflicts: StoryCardField[] = []
  for (const key of CARD_FIELDS) {
    if (same(local[key], baseline[key])) continue
    if (!same(remote[key], baseline[key]) && !same(remote[key], local[key])) conflicts.push(key)
    Object.assign(merged, { [key]: local[key] })
  }
  return { merged, conflicts }
}

export function storyCardChanged(baseline: StoryCardFields, current: StoryCardFields): boolean {
  return CARD_FIELDS.some(key => !same(baseline[key], current[key]))
}

/**
 * The operations that turn a card into the given fields, starting from the
 * latest record and keeping the profile's bytes for untouched parts.
 * @param current - the card now.
 * @param fields - the fields it should have.
 * @throws when the profile block no longer starts with a heading to keep.
 */
export function storyCardOperations(current: StoryCardSnapshot, fields: StoryCardFields): StoryOperation[] {
  const operations: StoryOperation[] = []
  const nameChanged = current.fields.name !== fields.name
  const descriptionChanged = current.fields.description !== fields.description
  let markdown = current.markdown
  const heading = /^([\t \r\n]*#{1,6}[\t ]+)([^\r\n]*)(\r?\n|$)/.exec(markdown)
  if ((descriptionChanged || (current.target.kind === 'shot' && nameChanged)) && heading === null) throw new Error('这张卡片的资料块不再以标题开头，请在正文里修改。')
  if (descriptionChanged) markdown = `${heading![0]}${heading![3] || '\n'}${fields.description}${current.markdown.includes('\r\n') ? '\r\n' : '\n'}`
  if (current.target.kind === 'shot' && nameChanged) {
    const safeName = fields.name.replace(/[\\`*_{}[\]<>]/g, '\\$&')
    markdown = markdown.replace(/^([\t \r\n]*#{1,6}[\t ]+)[^\r\n]*/, (_, prefix: string) => `${prefix}${safeName}`)
  }
  if (markdown !== current.markdown) operations.push({ kind: 'replaceBlock', blockId: current.blockId, expectedMarkdown: current.markdown, markdown })
  if (current.target.kind === 'entity') {
    if (!same(current.fields.visualIdentity, fields.visualIdentity) || !same(current.fields.visualState, fields.visualState)) {
      operations.push({ kind: 'upsertEntity', entity: { ...current.record as StoryEntity, visualIdentity: fields.visualIdentity, visualState: fields.visualState } })
    }
    if (nameChanged) operations.push({ kind: 'renameEntity', entityId: current.target.id, name: fields.name })
  } else if ((['sceneId', 'estimatedSeconds', 'sourceBlockIds', 'entityIds'] as const).some(key => !same(current.fields[key], fields[key]))) {
    operations.push({ kind: 'upsertShot', shot: { ...current.record as StoryShot, sceneId: fields.sceneId, estimatedSeconds: fields.estimatedSeconds, sourceBlockIds: fields.sourceBlockIds, entityIds: fields.entityIds } })
  }
  return operations
}
