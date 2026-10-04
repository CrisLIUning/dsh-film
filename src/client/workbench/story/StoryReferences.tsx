/**
 * A card's reference images and its way to the storyboard, inside the card
 * dialog: the scope (whole screenplay or one scene) and purpose, the bindings
 * in effect with set-main / replace / unbind, the scene switch that turns a
 * purpose off, the image picker (项目素材库 / 当前画布), and 送到画布 with the
 * production purposes and a preview of what the canvas receives.
 *
 * Ported from Studio `apps/web/src/components/production/screenwriter/
 * StoryReferences.tsx`, drawn with DSH's primitives. Studio's per-scene visual
 * settings editor (`StoryProductionSettings`) is not part of this port. The
 * rules live in `references.ts` and `handoff.ts`; every write goes through
 * the store's compare-and-swap with the latest saved revision.
 * @module dsh-film/client/workbench/story/StoryReferences
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StoryAssetCandidate, StorySourcePreview } from '../../../screenwriter/contracts/assets.ts'
import type { StoryProductionPurpose } from '../../../screenwriter/contracts/production.ts'
import type { StoryBindingScope, StoryDocument, StoryMutationResult } from '../../../screenwriter/contracts/types.ts'
import type { Translate } from '../../types.ts'
import { orderedScenes } from './CardViews.tsx'
import { cardName } from './cards.ts'
import { productionActions } from './handoff.ts'
import {
  DEFAULT_PURPOSE,
  SUGGESTED_PURPOSES,
  bindPlan,
  bindingFileName,
  bindingScope,
  currentReferenceRead,
  effectiveBindings,
  filterCandidates,
  overrideToggle,
  referenceReadKey,
  referenceRowStatus,
  setMainOperations,
  toggleSelection,
} from './references.ts'
import type { ReferenceRead, ReferenceScope, ReferenceTarget } from './references.ts'
import { StoryConflictError } from './story-api.ts'
import type { StoryApi } from './story-api.ts'
import type { StoryStore } from './story-store.ts'
import css from './screenwriter.module.css'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * A purpose as the person reads it: the suggested ones translated, any other as typed.
 * @param purpose - the stored purpose.
 * @param t - translate.
 * @returns the label.
 */
export function purposeLabel(purpose: string, t: Translate): string {
  return (SUGGESTED_PURPOSES as readonly string[]).includes(purpose) ? t(`sw.ref.purpose.${purpose}`) : purpose
}

export interface StoryReferencesProps {
  api: StoryApi
  store: StoryStore
  /** The open screenplay as last saved. */
  document: StoryDocument
  target: ReferenceTarget
  /** Card operations may run now (nothing unsaved, no conflict). */
  canMutate: boolean
  /** The card form has unsaved fields; references wait for it, as in Studio. */
  cardDirty: boolean
  /** Open the picker at once (the card's 选择参考 button). */
  autoOpen: boolean
  t: Translate
  /** Send the card to the board; resolves false when it could not be sent now (something unsaved). */
  onSend: (scope: StoryBindingScope, purpose?: StoryProductionPurpose) => Promise<boolean>
}

/**
 * The references and production section of a card dialog.
 * @param props - the screenplay, the card and the actions.
 */
export function StoryReferences({ api, store, document, target, canMutate, cardDirty, autoOpen, t, onSend }: StoryReferencesProps): ReactNode {
  const [scope, setScope] = useState<ReferenceScope>('document')
  const [purpose, setPurpose] = useState(DEFAULT_PURPOSE)
  const [picker, setPicker] = useState(false)
  const [canvasOnly, setCanvasOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [assets, setAssets] = useState<StoryAssetCandidate[] | undefined>()
  const [read, setRead] = useState<ReferenceRead | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [replace, setReplace] = useState<string | undefined>()
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [source, setSource] = useState<StorySourcePreview | null>(null)
  const [error, setError] = useState<string | undefined>()
  const metadata = document.parsed.metadata
  const key = referenceReadKey(document.documentId, document.revision)
  const current = currentReferenceRead(read, key)

  // Every saved revision may resolve differently; an answer for an older one is ignored.
  useEffect(() => {
    let live = true
    api.references(document.documentId)
      .then((references) => { if (live) setRead({ key, status: 'loaded', references }) })
      .catch((reason: unknown) => {
        if (!live) return
        setRead({ key, status: 'failed', references: [] })
        setError(message(reason))
      })
    return () => { live = false }
  }, [api, document.documentId, key])

  // A source preview describes one revision and scope.
  useEffect(() => { setSource(null) }, [document.revision, scope])

  const openPicker = async (replaceId?: string): Promise<void> => {
    setBusy(true)
    setReplace(replaceId)
    setSelected([])
    setPicker(true)
    try {
      setAssets(await api.assets())
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }
  // Only when the dialog opens for this card (it is keyed by the card).
  useEffect(() => { if (autoOpen) void openPicker() }, [])

  if (metadata === null) return null
  const disabled = !canMutate || cardDirty
  const effective = effectiveBindings(metadata, target, scope, purpose)
  const scenes = orderedScenes(metadata)
  const blocks = new Map(document.parsed.blocks.map(block => [block.id, block]))
  const actions = productionActions(metadata, target)

  /** A refused write: a stale baseline brings in the latest version; the message stays in the dialog. */
  const recover = (reason: unknown): boolean => {
    if (reason instanceof StoryConflictError) store.replace(reason.current)
    setError(message(reason))
    return true
  }
  const run = async (change: (latest: StoryDocument) => Promise<StoryMutationResult>): Promise<boolean> => {
    setBusy(true)
    setError(undefined)
    try {
      return await store.mutate(change, recover)
    } finally {
      setBusy(false)
    }
  }

  const bindSelected = async (): Promise<void> => {
    const chosen = selected.map(id => assets?.find(asset => asset.id === id)).filter((asset): asset is StoryAssetCandidate => asset !== undefined)
    const plan = bindPlan(chosen, { target, scope, purpose: purpose.trim(), replace, direct: effective.direct })
    setBusy(true)
    setError(undefined)
    try {
      // One compare-and-swap per image, each on the revision the previous one saved; a failure stops
      // with the bindings made so far in place, never a false "all done".
      for (const item of plan) {
        const ok = await store.mutate(latest => api.bind(latest.documentId, { ...item, expectedRevision: latest.revision, operationId: crypto.randomUUID() }), recover)
        if (!ok) return
      }
      setPicker(false)
    } finally {
      setBusy(false)
    }
  }

  const send = async (purposeToMake?: StoryProductionPurpose): Promise<void> => {
    setSending(true)
    setError(undefined)
    setSent(false)
    try {
      setSent(await onSend(bindingScope(scope), purposeToMake))
    } catch (reason) {
      recover(reason)
    } finally {
      setSending(false)
    }
  }

  const showSource = async (): Promise<void> => {
    setSending(true)
    setError(undefined)
    try {
      setSource(await api.source(document.documentId, target.id, bindingScope(scope)))
    } catch (reason) {
      setError(message(reason))
    } finally {
      setSending(false)
    }
  }

  const shown = picker && assets !== undefined ? filterCandidates(assets, { canvasOnly, search }) : []
  const statusText = (status: 'loading' | 'failed' | 'unavailable', detail?: string): string =>
    status === 'loading' ? t('sw.loading') : status === 'failed' ? t('sw.ref.readFailed') : `${t('sw.ref.unavailable')}${detail !== undefined ? ` · ${t(`sw.ref.status.${detail}`)}` : ''}`

  return (
    <>
      <section className={css.references} aria-label={t('sw.ref.title')}>
        <header className={css.sectionHeader}>
          <h3 className={css.sectionTitle}>{t('sw.ref.title')}</h3>
          <Button size="sm" variant="outline" disabled={disabled || busy || effective.suppressed} onClick={() => { void openPicker() }}>{t('sw.ref.choose')}</Button>
        </header>
        <div className={css.referenceControls}>
          <label className={css.inlineField}>
            <span>{t('sw.ref.scope')}</span>
            <select className={css.select} value={scope} disabled={busy} onChange={(event) => { setScope(event.currentTarget.value); setPicker(false); setPreview(null) }}>
              <option value="document">{t('sw.ref.allScenes')}</option>
              {scenes.map((scene, index) => <option key={scene.id} value={scene.id}>{index + 1}. {cardName(blocks.get(scene.headingBlockId)?.markdown ?? '') || t('sw.unnamed')}</option>)}
            </select>
          </label>
          <label className={css.inlineField}>
            <span>{t('sw.ref.purpose')}</span>
            <Input value={purpose} list="dsh-film-ref-purposes" maxLength={80} onChange={(event) => { setPurpose(event.target.value) }} />
            <datalist id="dsh-film-ref-purposes">
              {SUGGESTED_PURPOSES.map(item => <option key={item} value={item} label={t(`sw.ref.purpose.${item}`)} />)}
            </datalist>
          </label>
        </div>
        {effective.inherited && <p className={css.quiet}>{t('sw.ref.inherited')}</p>}
        {scope !== 'document' && (
          <Checkbox
            checked={effective.suppressed}
            disabled={disabled || busy || purpose.trim() === ''}
            label={t('sw.ref.noneThisScene')}
            onChange={(on: boolean) => {
              void run((latest) => {
                const operations = overrideToggle(latest.parsed.metadata ?? metadata, target, scope, purpose.trim(), on, () => crypto.randomUUID())
                return operations.length === 0
                  ? Promise.resolve({ document: latest, changed: false })
                  : api.apply(latest.documentId, { expectedRevision: latest.revision, operations, operationId: crypto.randomUUID() })
              })
            }}
          />
        )}
        {effective.bindings.length === 0 && <p className={css.quiet}>{t('sw.ref.none')}</p>}
        {effective.bindings.map((binding) => {
          const row = referenceRowStatus(current, binding)
          const url = api.referenceUrl(document.documentId, binding.assetId, binding.assetVersionId)
          const name = bindingFileName(metadata, binding)
          const inherited = scope !== 'document' && binding.scope.kind === 'document'
          return (
            <article key={binding.id} className={css.reference}>
              {row.status === 'available'
                ? (
                    <button type="button" className={css.referenceThumb} aria-label={t('sw.ref.preview', { name })} aria-pressed={preview === url} onClick={() => { setPreview(preview === url ? null : url) }}>
                      <img src={url} alt={name} />
                    </button>
                  )
                : <span className={css.referenceThumb} data-status={row.status}>{statusText(row.status, row.resolution?.status)}</span>}
              <div className={css.referenceInfo}>
                <strong title={name}>{name}</strong>
                <span className={css.referenceMeta}>
                  {purposeLabel(binding.purpose, t)}
                  <Tag tone={binding.primary ? 'info' : 'quiet'}>{binding.primary ? t('sw.ref.main') : t('sw.ref.additional')}</Tag>
                  {inherited && <Tag tone="neutral">{t('sw.ref.allScenes')}</Tag>}
                  {row.resolution?.status === 'relocated' && <Tag tone="warning">{t('sw.ref.status.relocated')}</Tag>}
                </span>
                <code className={css.referenceVersion} title={binding.assetVersionId}>{binding.assetVersionId}</code>
                {!inherited && (
                  <div className={css.actions}>
                    {!binding.primary && (
                      <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => {
                        void run(latest => api.apply(latest.documentId, { expectedRevision: latest.revision, operations: setMainOperations(binding), operationId: crypto.randomUUID() }))
                      }}
                      >
                        {t('sw.ref.setMain')}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => { setPurpose(binding.purpose); void openPicker(binding.id) }}>{t('sw.ref.replace')}</Button>
                    <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => { void run(latest => api.unbind(latest.documentId, binding.id, latest.revision)) }}>{t('sw.ref.unbind')}</Button>
                  </div>
                )}
              </div>
            </article>
          )
        })}
        {preview !== null && <img className={css.referencePreview} src={preview} alt={t('sw.ref.title')} />}
        <p className={css.quiet}>{t('sw.ref.hint')}</p>
        {error !== undefined && <p className={css.error} role="alert">{error}</p>}

        {picker && (
          <div className={css.picker}>
            <div className={css.pickerHead}>
              <div className={css.pickerTabs} role="group" aria-label={t('sw.ref.library')}>
                <Button size="sm" variant={canvasOnly ? 'ghost' : 'outline'} aria-pressed={!canvasOnly} onClick={() => { setCanvasOnly(false) }}>{t('sw.ref.projectAssets')}</Button>
                <Button size="sm" variant={canvasOnly ? 'outline' : 'ghost'} aria-pressed={canvasOnly} onClick={() => { setCanvasOnly(true) }}>{t('sw.ref.currentCanvas')}</Button>
              </div>
              <Input value={search} aria-label={t('sw.ref.find')} placeholder={t('sw.ref.find')} onChange={(event) => { setSearch(event.target.value) }} />
            </div>
            {replace !== undefined && <p className={css.quiet}>{t('sw.ref.replacing')}</p>}
            <div className={css.assetGrid}>
              {shown.map(asset => (
                <button
                  key={asset.id}
                  type="button"
                  className={css.assetChoice}
                  aria-pressed={selected.includes(asset.id)}
                  title={asset.filePath}
                  onClick={() => { setSelected(toggleSelection(selected, asset.id, replace !== undefined)) }}
                >
                  <img src={api.fileUrl(asset.filePath)} alt="" loading="lazy" />
                  <span className={css.assetTitle}>{asset.title}</span>
                  <small className={css.assetMeta}>{asset.sha256.slice(0, 12)}</small>
                </button>
              ))}
            </div>
            {assets === undefined && busy && <p className={css.quiet}>{t('sw.loading')}</p>}
            {assets !== undefined && shown.length === 0 && <p className={css.quiet}>{assets.length === 0 ? t('sw.ref.noAssets') : t('sw.ref.noMatch')}</p>}
            <div className={css.actions}>
              <Button size="sm" variant="primary" disabled={busy || disabled || effective.suppressed || purpose.trim() === '' || selected.length === 0} onClick={() => { void bindSelected() }}>
                {t('sw.ref.bindSelected', { count: selected.length })}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setPicker(false) }}>{t('sw.cancel')}</Button>
            </div>
          </div>
        )}
      </section>

      <section className={css.references} aria-label={t('sw.handoff.title')}>
        <header className={css.sectionHeader}>
          <h3 className={css.sectionTitle}>{t('sw.handoff.title')}</h3>
        </header>
        <p className={css.quiet}>{t(scope === 'document' ? 'sw.handoff.scopeDocument' : 'sw.handoff.scopeScene')}</p>
        <div className={css.actions}>
          <Button size="sm" variant="outline" disabled={disabled || busy || sending} onClick={() => { void send(actions.image) }}>{t('sw.handoff.prepareImage')}</Button>
          {actions.sheet !== undefined && <Button size="sm" variant="ghost" disabled={disabled || busy || sending} onClick={() => { void send(actions.sheet) }}>{t('sw.handoff.prepareSheet')}</Button>}
          <Button size="sm" variant="ghost" disabled={disabled || busy || sending} onClick={() => { void send() }}>{t('sw.handoff.send')}</Button>
          <Button size="sm" variant="ghost" disabled={busy || sending} onClick={() => { void showSource() }}>{t('sw.handoff.preview')}</Button>
        </div>
        <p className={css.quiet}>{t('sw.handoff.hint')}</p>
        {sent && <p className={css.quiet} role="status">{t('sw.handoff.sent')}</p>}
        {source !== null && <SourcePreview preview={source} api={api} t={t} />}
      </section>
    </>
  )
}

/**
 * What the canvas's source card will show for this object: its brief, the
 * references resolved for the scope, and the revision it is pinned to.
 * @param props - the plugin's source preview.
 */
export function SourcePreview({ preview, api, t }: { preview: StorySourcePreview; api: StoryApi; t: Translate }): ReactNode {
  const text = (preview.productionText ?? preview.markdown).trim()
  return (
    <div className={css.sourcePreview}>
      <div className={css.sourceHead}>
        <strong>{preview.title || t('sw.unnamed')}</strong>
        <code title={preview.revision}>{t('sw.handoff.revision', { revision: preview.revision.slice(0, 12) })}</code>
      </div>
      {preview.references.length > 0 && (
        <div className={css.sourceRefs}>
          {preview.references.map(reference => (
            <figure key={`${reference.assetId}/${reference.assetVersionId}`} className={css.sourceRef}>
              {reference.url !== undefined
                ? <img src={api.studioUrl(reference.url)} alt={reference.title ?? reference.assetId} />
                : <span className={css.referenceThumb} data-status="unavailable">{t(`sw.ref.status.${reference.status}`)}</span>}
              <figcaption>{reference.primary ? t('sw.ref.main') : t('sw.ref.additional')}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {text !== '' ? <pre className={css.sourceText}>{text}</pre> : <p className={css.quiet}>{t('sw.handoff.emptyText')}</p>}
      {(preview.dependencies?.length ?? 0) > 0 && <p className={css.quiet}>{t('sw.handoff.dependencies', { count: preview.dependencies!.length })}</p>}
    </div>
  )
}
