/**
 * The rules behind the 剧本 tab's reference images, kept apart from React so
 * they can be tested in Node: which bindings a card shows in a scope, which
 * image is its cover, what a multi-select bind sends, how a scene turns a
 * purpose off, and how a reference read is told apart from a stale one.
 *
 * Ported from Studio `apps/web/src/components/production/screenwriter/
 * StoryReferences.tsx` (bindings shown, bind requests, override checkbox,
 * read state) and `ScreenwriterWorkspace.tsx` `referenceImage` (cover). The
 * scene rule itself is the contracts' {@link resolveStoryReferences}, from its
 * zod-free module.
 * @module dsh-film/client/workbench/story/references
 */

import type { StoryAssetCandidate, StoryAssetResolution, StoryBindRequest } from '../../../screenwriter/contracts/assets.js'
import { resolveStoryReferences } from '../../../screenwriter/contracts/references.js'
import type { StoryBinding, StoryBindingScope, StoryMetadata, StoryOperation, StoryReferenceOverride } from '../../../screenwriter/contracts/types.js'

/** A card that can carry references. */
export type ReferenceTarget = { kind: 'entity' | 'shot'; id: string }

/** Where references apply: the whole screenplay, or one scene by id. */
export type ReferenceScope = 'document' | string

/** The purpose a new binding gets unless the person types another (Studio's default). */
export const DEFAULT_PURPOSE = 'appearance'

/** Purposes offered as suggestions; any other text is kept as typed, as Studio stores free text. */
export const SUGGESTED_PURPOSES = ['appearance', 'identity', 'costume'] as const

const sameTarget = (left: ReferenceTarget, right: ReferenceTarget): boolean => left.kind === right.kind && left.id === right.id

/** The target as a record stores it (a copy, so a caller's extra fields never reach the file). */
const targetRecord = (target: ReferenceTarget): StoryBinding['target'] => ({ kind: target.kind, id: target.id })

/**
 * The binding scope a scope choice stands for.
 * @param scope - `document` or a scene id.
 * @returns the scope record.
 */
export function bindingScope(scope: ReferenceScope): StoryBindingScope {
  return scope === 'document' ? { kind: 'document' } : { kind: 'scene', sceneId: scope }
}

/** What the references section shows for a card in a scope. */
export interface EffectiveBindings {
  /** The bindings in effect, in purpose order. */
  bindings: StoryBinding[]
  /** The card's bindings made in exactly this scope (the ones a new main reference competes with). */
  direct: StoryBinding[]
  /** A scene view is showing whole-screenplay references. */
  inherited: boolean
  /** The scene turned the current purpose off. */
  suppressed: boolean
  /** The scene's override record for the current purpose, if any. */
  override: StoryReferenceOverride | undefined
}

/**
 * The bindings in effect for a card (Studio `StoryReferences.tsx:35-44`): in
 * the whole-screenplay view its document bindings; in a scene view, per
 * purpose, nothing when the scene turned it off, the scene's own bindings when
 * it has some (or replaces the purpose), else the inherited document ones.
 * @param metadata - the saved screenplay's metadata.
 * @param target - the card.
 * @param scope - the scope being viewed.
 * @param purpose - the purpose being edited.
 * @returns what to show.
 */
export function effectiveBindings(metadata: StoryMetadata, target: ReferenceTarget, scope: ReferenceScope, purpose: string): EffectiveBindings {
  const own = metadata.bindings.filter(binding => sameTarget(binding.target, target))
  const direct = own.filter(binding => scope === 'document' ? binding.scope.kind === 'document' : binding.scope.kind === 'scene' && binding.scope.sceneId === scope)
  const overrides = scope === 'document' ? [] : metadata.referenceOverrides.filter(item => sameTarget(item.target, target) && item.scope.sceneId === scope)
  const bindings = scope === 'document'
    ? direct
    : resolveStoryReferences(metadata, { target: targetRecord(target), sceneId: scope }).flatMap(group => group.bindings)
  return {
    bindings,
    direct,
    inherited: scope !== 'document' && bindings.some(binding => binding.scope.kind === 'document'),
    suppressed: overrides.some(item => item.purpose === purpose && item.mode === 'disabled'),
    override: overrides.find(item => item.purpose === purpose),
  }
}

/**
 * A card's cover (Studio `ScreenwriterWorkspace.tsx:253-257`): among its
 * whole-screenplay main references, appearance first, then identity, then
 * any. Scene references never become the cover.
 * @param metadata - the saved screenplay's metadata.
 * @param target - the card.
 * @returns the binding, if the card has a main reference.
 */
export function coverBinding(metadata: StoryMetadata, target: ReferenceTarget): StoryBinding | undefined {
  const main = metadata.bindings.filter(binding => sameTarget(binding.target, target) && binding.scope.kind === 'document' && binding.primary)
  return main.find(binding => binding.purpose === 'appearance') ?? main.find(binding => binding.purpose === 'identity') ?? main[0]
}

/** One bind request without its baseline and operation id, which each call takes fresh. */
export type BindPlanItem = Omit<StoryBindRequest, 'expectedRevision' | 'operationId'>

/**
 * The bind requests for the picked images, in order (Studio
 * `StoryReferences.tsx:69-86`). Only the first can become the main reference:
 * when it replaces a binding, or when the scope has no main reference for the
 * purpose yet.
 * @param selected - the picked library images.
 * @param options - the card, scope, purpose, the binding being replaced and the scope's own bindings.
 * @returns one request per image.
 */
export function bindPlan(selected: readonly StoryAssetCandidate[], options: {
  target: ReferenceTarget
  scope: ReferenceScope
  purpose: string
  replace?: string | undefined
  direct: readonly StoryBinding[]
}): BindPlanItem[] {
  const { target, scope, purpose, replace, direct } = options
  const hasMain = direct.some(binding => binding.purpose === purpose && binding.primary)
  return selected.map((candidate, index) => ({
    filePath: candidate.filePath,
    expectedSha256: candidate.sha256,
    target: targetRecord(target),
    scope: bindingScope(scope),
    purpose,
    primary: index === 0 && (replace !== undefined || !hasMain),
    ...(replace !== undefined ? { replaceBindingId: replace } : {}),
  }))
}

/**
 * The operations behind "本场此用途不使用参考" (Studio `StoryReferences.tsx:93-96`):
 * on records a `disabled` override (reusing the scene's record for the purpose),
 * off removes it.
 * @param metadata - the saved screenplay's metadata.
 * @param target - the card.
 * @param sceneId - the scene.
 * @param purpose - the purpose.
 * @param on - whether the scene should use no reference for it.
 * @param newId - makes a fresh override id.
 * @returns the operations (none when nothing changes).
 */
export function overrideToggle(metadata: StoryMetadata, target: ReferenceTarget, sceneId: string, purpose: string, on: boolean, newId: () => string): StoryOperation[] {
  const existing = metadata.referenceOverrides.find(item => sameTarget(item.target, target) && item.scope.sceneId === sceneId && item.purpose === purpose)
  if (on) {
    return [{ kind: 'upsertRecord', collection: 'referenceOverrides', record: { id: existing?.id ?? `override_${newId()}`, target: targetRecord(target), scope: { kind: 'scene', sceneId }, purpose, mode: 'disabled' } }]
  }
  return existing === undefined ? [] : [{ kind: 'removeRecord', collection: 'referenceOverrides', id: existing.id }]
}

/**
 * Make a binding the main reference; the contracts demote the scope's former one.
 * @param binding - the binding.
 * @returns the operation.
 */
export function setMainOperations(binding: StoryBinding): StoryOperation[] {
  return [{ kind: 'upsertBinding', binding: { ...binding, primary: true } }]
}

/**
 * The library images the picker shows: all, or only those on the current
 * canvas, matching the search in title or path.
 * @param assets - the library.
 * @param options - the tab and the search text.
 * @returns the images to show.
 */
export function filterCandidates(assets: readonly StoryAssetCandidate[], options: { canvasOnly: boolean; search: string }): StoryAssetCandidate[] {
  const search = options.search.trim().toLocaleLowerCase()
  return assets.filter(asset => (!options.canvasOnly || asset.canvasNodeIds.length > 0) && `${asset.title} ${asset.filePath}`.toLocaleLowerCase().includes(search))
}

/**
 * The picker's selection after a click: a toggle, or exactly one image when replacing.
 * @param selected - the selected candidate ids.
 * @param id - the clicked one.
 * @param replacing - whether the picker replaces a binding.
 * @returns the new selection.
 */
export function toggleSelection(selected: readonly string[], id: string, replacing: boolean): string[] {
  if (replacing) return [id]
  return selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]
}

/** The answer to one references read, tied to the screenplay revision it was asked for. */
export interface ReferenceRead {
  key: string
  status: 'loaded' | 'failed'
  references: StoryAssetResolution[]
}

/**
 * The key a references read belongs to: an answer for another screenplay or
 * revision is stale and shown as still loading.
 * @param documentId - the screenplay.
 * @param revision - its revision.
 * @returns the key.
 */
export function referenceReadKey(documentId: string, revision: string): string {
  return `${documentId}:${revision}`
}

/**
 * The read that applies now.
 * @param read - the last answer, if any.
 * @param key - the current key.
 * @returns the answer, or `null` while the current read is pending.
 */
export function currentReferenceRead(read: ReferenceRead | null, key: string): ReferenceRead | null {
  return read?.key === key ? read : null
}

/** What a binding row shows in place of its thumbnail. */
export type ReferenceRowStatus = 'loading' | 'failed' | 'available' | 'unavailable'

/**
 * A binding row's status (Studio `StoryReferences.tsx:98-104`): pending, a
 * failed read (or no entry for the version), showable (available or
 * relocated), or unavailable. A pending read never blocks binding; it only
 * holds back the thumbnail.
 * @param read - the current read (see {@link currentReferenceRead}).
 * @param binding - the row's binding.
 * @returns the status and the resolution behind it.
 */
export function referenceRowStatus(read: ReferenceRead | null, binding: Pick<StoryBinding, 'assetId' | 'assetVersionId'>): { status: ReferenceRowStatus; resolution: StoryAssetResolution | undefined } {
  if (read === null) return { status: 'loading', resolution: undefined }
  const resolution = read.references.find(item => item.asset.id === binding.assetId && item.asset.versionId === binding.assetVersionId)
  if (read.status === 'failed' || resolution === undefined) return { status: 'failed', resolution }
  return { status: resolution.status === 'available' || resolution.status === 'relocated' ? 'available' : 'unavailable', resolution }
}

/**
 * The file name a binding row shows: its recorded path's last segment, or the asset id.
 * @param metadata - the saved screenplay's metadata.
 * @param binding - the binding.
 * @returns the name.
 */
export function bindingFileName(metadata: StoryMetadata, binding: Pick<StoryBinding, 'assetId' | 'assetVersionId'>): string {
  const asset = metadata.assets.find(item => item.id === binding.assetId && item.versionId === binding.assetVersionId)
  return asset?.projectRelativePath.split('/').pop() ?? binding.assetId
}
