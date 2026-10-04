/**
 * The 剧本 tab's reference-image rules: bindings in effect, the cover, the
 * bind plan, the scene switch and read states (the intent of Studio's
 * `StoryReferences.test.tsx`, as pure functions; these tests run without a DOM).
 * @module dsh-film/tests/client/references.spec
 */

import { describe, expect, it } from 'vitest'
import type { StoryAssetCandidate } from '../../src/screenwriter/contracts/assets.ts'
import type { StoryBinding, StoryMetadata, StoryReferenceOverride } from '../../src/screenwriter/contracts/types.ts'
import {
  bindPlan,
  bindingFileName,
  bindingScope,
  coverBinding,
  currentReferenceRead,
  effectiveBindings,
  filterCandidates,
  overrideToggle,
  referenceReadKey,
  referenceRowStatus,
  setMainOperations,
  toggleSelection,
} from '../../src/client/workbench/story/references.ts'
import type { ReferenceRead } from '../../src/client/workbench/story/references.ts'

const person = { kind: 'entity' as const, id: 'person_lin' }

const binding = (id: string, more: Partial<StoryBinding> = {}): StoryBinding => ({
  id,
  target: person,
  scope: { kind: 'document' },
  purpose: 'appearance',
  primary: false,
  assetId: `asset_${id}`,
  assetVersionId: `v_${id}`,
  ...more,
})

const override = (purpose: string, mode: StoryReferenceOverride['mode'], sceneId = 'scene_2'): StoryReferenceOverride => ({
  id: `override_${purpose}_${mode}`,
  target: person,
  scope: { kind: 'scene', sceneId },
  purpose,
  mode,
})

const metadata = (bindings: StoryBinding[], referenceOverrides: StoryReferenceOverride[] = []): StoryMetadata => ({
  format: 'vibedev.screenwriter',
  formatVersion: '1.0',
  document: { id: 'doc', kind: 'short', title: 't' },
  entities: [{ id: 'person_lin', kind: 'person', profileBlockId: 'block_p' }],
  scenes: [],
  shots: [],
  assets: bindings.map(item => ({ id: item.assetId, versionId: item.assetVersionId, mediaType: 'image/png', projectRelativePath: `canvas/media/${item.id}.png`, sha256: 'a'.repeat(64) })),
  bindings,
  referenceOverrides,
  speech: [],
  appearances: [],
  beats: [],
  relationships: [],
  claims: [],
  sceneOrder: [],
  shotOrder: [],
  deletedObjects: [],
} as unknown as StoryMetadata)

const candidate = (id: string, more: Partial<StoryAssetCandidate> = {}): StoryAssetCandidate => ({
  id: `canvas-file:${id}`,
  title: id,
  filePath: `canvas/media/${id}`,
  mimeType: 'image/png',
  sizeBytes: 10,
  sha256: id.padEnd(64, '0'),
  canvasNodeIds: [],
  ...more,
})

describe('the bindings in effect for a card', () => {
  const lookDoc = binding('look', { primary: true })
  const costumeDoc = binding('coat', { purpose: 'costume', primary: true })
  const lookScene = binding('wet', { scope: { kind: 'scene', sceneId: 'scene_2' }, primary: true })
  const other = binding('other', { target: { kind: 'entity', id: 'someone' } })

  it('shows only the whole-screenplay bindings in the whole-screenplay view', () => {
    const result = effectiveBindings(metadata([lookDoc, costumeDoc, lookScene, other]), person, 'document', 'appearance')
    expect(result.bindings.map(item => item.id)).toEqual(['look', 'coat'])
    expect(result.direct.map(item => item.id)).toEqual(['look', 'coat'])
    expect(result).toMatchObject({ inherited: false, suppressed: false, override: undefined })
  })

  it('inherits whole-screenplay references in a scene without its own', () => {
    const result = effectiveBindings(metadata([lookDoc, costumeDoc]), person, 'scene_1', 'appearance')
    expect(result.bindings.map(item => item.id)).toEqual(['look', 'coat'])
    expect(result.direct).toEqual([])
    expect(result.inherited).toBe(true)
  })

  it('lets a scene replace only the purposes it binds itself', () => {
    const result = effectiveBindings(metadata([lookDoc, costumeDoc, lookScene]), person, 'scene_2', 'appearance')
    // The scene's own look replaces the document look; the document costume still applies.
    expect(result.bindings.map(item => item.id)).toEqual(['wet', 'coat'])
    expect(result.direct.map(item => item.id)).toEqual(['wet'])
    expect(result.inherited).toBe(true)
  })

  it('treats a replace override with no scene bindings as an explicit empty set', () => {
    const result = effectiveBindings(metadata([lookDoc], [override('appearance', 'replace')]), person, 'scene_2', 'appearance')
    expect(result.bindings).toEqual([])
    expect(result).toMatchObject({ inherited: false, suppressed: false })
    expect(result.override?.mode).toBe('replace')
  })

  it('shows nothing for a purpose the scene turned off, and says so for that purpose only', () => {
    const data = metadata([lookDoc, costumeDoc], [override('appearance', 'disabled')])
    const look = effectiveBindings(data, person, 'scene_2', 'appearance')
    expect(look.bindings.map(item => item.id)).toEqual(['coat'])
    expect(look.suppressed).toBe(true)
    expect(effectiveBindings(data, person, 'scene_2', 'costume').suppressed).toBe(false)
    // Another scene is unaffected.
    expect(effectiveBindings(data, person, 'scene_3', 'appearance').bindings.map(item => item.id)).toEqual(['look', 'coat'])
  })
})

describe('the card cover', () => {
  it('prefers the appearance main reference, then identity, then any main reference', () => {
    const identity = binding('id', { purpose: 'identity', primary: true })
    const look = binding('look', { primary: true })
    const prop = binding('prop', { purpose: 'detail', primary: true })
    expect(coverBinding(metadata([identity, prop, look]), person)?.id).toBe('look')
    expect(coverBinding(metadata([prop, identity]), person)?.id).toBe('id')
    expect(coverBinding(metadata([prop]), person)?.id).toBe('prop')
  })

  it('never uses an additional or a scene reference', () => {
    expect(coverBinding(metadata([binding('extra'), binding('wet', { primary: true, scope: { kind: 'scene', sceneId: 'scene_2' } })]), person)).toBeUndefined()
    expect(coverBinding(metadata([binding('look', { primary: true, target: { kind: 'shot', id: 'person_lin' } })]), person)).toBeUndefined()
  })
})

describe('the bind plan', () => {
  const picked = [candidate('a.png'), candidate('b.png')]

  it('makes the first image the main reference when the scope has none for the purpose', () => {
    const plan = bindPlan(picked, { target: person, scope: 'document', purpose: 'appearance', direct: [binding('coat', { purpose: 'costume', primary: true })] })
    expect(plan).toEqual([
      { filePath: 'canvas/media/a.png', expectedSha256: picked[0]!.sha256, target: person, scope: { kind: 'document' }, purpose: 'appearance', primary: true },
      { filePath: 'canvas/media/b.png', expectedSha256: picked[1]!.sha256, target: person, scope: { kind: 'document' }, purpose: 'appearance', primary: false },
    ])
  })

  it('adds additional references next to an existing main reference', () => {
    const plan = bindPlan(picked, { target: person, scope: 'scene_2', purpose: 'appearance', direct: [binding('wet', { primary: true, scope: { kind: 'scene', sceneId: 'scene_2' } })] })
    expect(plan.map(item => item.primary)).toEqual([false, false])
    expect(plan[0]!.scope).toEqual({ kind: 'scene', sceneId: 'scene_2' })
  })

  it('keeps the main reference when replacing a binding', () => {
    const plan = bindPlan([picked[1]!], { target: person, scope: 'document', purpose: 'appearance', replace: 'look', direct: [binding('look', { primary: true })] })
    expect(plan).toEqual([{ filePath: 'canvas/media/b.png', expectedSha256: picked[1]!.sha256, target: person, scope: { kind: 'document' }, purpose: 'appearance', primary: true, replaceBindingId: 'look' }])
  })

  it('stores a copy of the target, without extra fields', () => {
    const plan = bindPlan([picked[0]!], { target: { ...person, extra: 1 } as typeof person, scope: 'document', purpose: 'appearance', direct: [] })
    expect(plan[0]!.target).toEqual(person)
  })

  it('names scopes as binding records', () => {
    expect(bindingScope('document')).toEqual({ kind: 'document' })
    expect(bindingScope('scene_9')).toEqual({ kind: 'scene', sceneId: 'scene_9' })
  })
})

describe('the scene switch and set-main', () => {
  it('records a disabled override, reusing the scene record for the purpose, and removes it', () => {
    const empty = metadata([])
    expect(overrideToggle(empty, person, 'scene_2', 'appearance', true, () => 'new')).toEqual([{
      kind: 'upsertRecord',
      collection: 'referenceOverrides',
      record: { id: 'override_new', target: person, scope: { kind: 'scene', sceneId: 'scene_2' }, purpose: 'appearance', mode: 'disabled' },
    }])
    const withReplace = metadata([], [override('appearance', 'replace')])
    expect(overrideToggle(withReplace, person, 'scene_2', 'appearance', true, () => 'new')[0]).toMatchObject({ record: { id: 'override_appearance_replace', mode: 'disabled' } })
    expect(overrideToggle(withReplace, person, 'scene_2', 'appearance', false, () => 'new')).toEqual([{ kind: 'removeRecord', collection: 'referenceOverrides', id: 'override_appearance_replace' }])
    expect(overrideToggle(empty, person, 'scene_2', 'appearance', false, () => 'new')).toEqual([])
    // Another purpose or scene has its own record.
    expect(overrideToggle(withReplace, person, 'scene_3', 'appearance', false, () => 'new')).toEqual([])
  })

  it('sets a binding as main through the contracts, which demote the former one', () => {
    expect(setMainOperations(binding('extra'))).toEqual([{ kind: 'upsertBinding', binding: { ...binding('extra'), primary: true } }])
  })
})

describe('the picker', () => {
  const library = [candidate('rain.png', { title: '雨夜', canvasNodeIds: ['node_1'] }), candidate('sun.png', { title: '晴天' })]

  it('filters by the current canvas and by title or path', () => {
    expect(filterCandidates(library, { canvasOnly: false, search: '' }).map(item => item.title)).toEqual(['雨夜', '晴天'])
    expect(filterCandidates(library, { canvasOnly: true, search: '' }).map(item => item.title)).toEqual(['雨夜'])
    expect(filterCandidates(library, { canvasOnly: false, search: 'SUN' }).map(item => item.title)).toEqual(['晴天'])
    expect(filterCandidates(library, { canvasOnly: false, search: '雨' }).map(item => item.title)).toEqual(['雨夜'])
  })

  it('toggles a multi-selection, and keeps exactly one image when replacing', () => {
    expect(toggleSelection([], 'a', false)).toEqual(['a'])
    expect(toggleSelection(['a', 'b'], 'a', false)).toEqual(['b'])
    expect(toggleSelection(['a', 'b'], 'c', true)).toEqual(['c'])
  })
})

describe('reference read states', () => {
  const look = binding('look', { primary: true })
  const key = referenceReadKey('doc', 'rev-2')
  const loaded = (status: 'available' | 'relocated' | 'missing' | 'version-mismatch' | 'ambiguous'): ReferenceRead => ({
    key,
    status: 'loaded',
    references: [{ asset: { id: look.assetId, versionId: look.assetVersionId, mediaType: 'image/png', projectRelativePath: 'a.png', sha256: 'a'.repeat(64) }, status }],
  })

  it('treats an answer for another revision as still loading, so a slow old read never shows', () => {
    const stale: ReferenceRead = { ...loaded('missing'), key: referenceReadKey('doc', 'rev-1') }
    expect(currentReferenceRead(stale, key)).toBeNull()
    expect(referenceRowStatus(currentReferenceRead(stale, key), look).status).toBe('loading')
    expect(currentReferenceRead(null, key)).toBeNull()
  })

  it('tells a failed read and a missing entry apart from an unavailable file', () => {
    expect(referenceRowStatus({ key, status: 'failed', references: [] }, look).status).toBe('failed')
    expect(referenceRowStatus({ key, status: 'loaded', references: [] }, look).status).toBe('failed')
    expect(referenceRowStatus(loaded('missing'), look)).toMatchObject({ status: 'unavailable', resolution: { status: 'missing' } })
    expect(referenceRowStatus(loaded('ambiguous'), look).status).toBe('unavailable')
    expect(referenceRowStatus(loaded('version-mismatch'), look).status).toBe('unavailable')
  })

  it('shows available and relocated versions', () => {
    expect(referenceRowStatus(loaded('available'), look).status).toBe('available')
    expect(referenceRowStatus(loaded('relocated'), look).status).toBe('available')
  })

  it('names a binding by its recorded file', () => {
    const data = metadata([look])
    expect(bindingFileName(data, look)).toBe('look.png')
    expect(bindingFileName(data, binding('gone'))).toBe('asset_gone')
  })
})
