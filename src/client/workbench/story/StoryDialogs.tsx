/**
 * The 剧本 tab's dialogs: a new screenplay, a saved version, the history, a
 * merge after a conflict, deleting an object and a card's details.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, Input, MarkdownText, Modal, SegmentedControl, Tag, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { projectStoryBody, storyBlockTitle } from '../../../screenwriter/contracts/tokens.ts'
import type { StoryDeletionPreviewResponse, StoryDocument, StoryDocumentKind, StoryEntity, StoryObjectTarget } from '../../../screenwriter/contracts/types.ts'
import type { Translate } from '../../types.ts'
import { GrowingTextarea } from './BodyView.tsx'
import { orderedScenes } from './CardViews.tsx'
import { cardName, mergeStoryCardFields, readStoryCard, storyCardChanged, storyCardOperations } from './cards.ts'
import type { StoryCardField, StoryCardFields, StoryCardSnapshot, StoryCardTarget } from './cards.ts'
import { StoryConflictError } from './story-api.ts'
import type { StoryApi, StoryVersion } from './story-api.ts'
import type { StoryStore } from './story-store.ts'
import css from './screenwriter.module.css'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function NewDocumentDialog({ store, t, onClose, onCreated }: { store: StoryStore; t: Translate; onClose: () => void; onCreated: () => void }): ReactNode {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<StoryDocumentKind>('short')
  const [busy, setBusy] = useState(false)
  const create = async (): Promise<void> => {
    setBusy(true)
    const ok = await store.create(title.trim(), kind)
    setBusy(false)
    if (ok) onCreated()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sw.newDocument.title')}
      closeLabel={t('sw.close')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('sw.cancel')}</Button>
          <Button variant="primary" disabled={busy || title.trim() === ''} onClick={() => { void create() }}>{t('sw.create')}</Button>
        </>
      )}
    >
      <div className={css.form}>
        <label className={css.field}>
          <span className={css.label}>{t('sw.newDocument.name')}</span>
          <Input data-modal-autofocus value={title} maxLength={120} placeholder={t('sw.newDocument.placeholder')} onChange={(event) => { setTitle(event.target.value) }} />
        </label>
        <div className={css.field}>
          <span className={css.label}>{t('sw.kind')}</span>
          <SegmentedControl
            id="dsh-film-story-kind"
            label={t('sw.kind')}
            value={kind}
            options={[{ value: 'short', label: t('sw.kind.short') }, { value: 'episode', label: t('sw.kind.episode') }]}
            onChange={setKind}
          />
        </div>
      </div>
    </Modal>
  )
}

export function VersionDialog({ document, api, t, onClose }: { document: StoryDocument; api: StoryApi; t: Translate; onClose: (saved: boolean) => void }): ReactNode {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await api.checkpoint(document.documentId, { expectedRevision: document.revision, label: label.trim() })
      onClose(true)
    } catch (reason) {
      setError(message(reason))
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={() => { onClose(false) }}
      title={t('sw.version.title')}
      closeLabel={t('sw.close')}
      footer={(
        <>
          <Button variant="ghost" onClick={() => { onClose(false) }}>{t('sw.cancel')}</Button>
          <Button variant="primary" disabled={busy || label.trim() === ''} onClick={() => { void save() }}>{t('sw.save')}</Button>
        </>
      )}
    >
      <label className={css.field}>
        <span className={css.label}>{t('sw.version.label')}</span>
        <Input data-modal-autofocus value={label} maxLength={120} placeholder={t('sw.version.placeholder')} onChange={(event) => { setLabel(event.target.value) }} />
      </label>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
    </Modal>
  )
}

/** A version's name: its note, or its number (the plugin names unnoted versions in English). */
const versionTitle = (version: StoryVersion, t: Translate): string =>
  version.label !== '' && version.label !== `Version ${version.version}` ? version.label : t('sw.history.number', { number: version.version })

export function HistoryDialog({ document, api, store, canRestore, labels, t, onClose }: {
  document: StoryDocument
  api: StoryApi
  store: StoryStore
  canRestore: boolean
  labels: MarkdownLabels
  t: Translate
  onClose: () => void
}): ReactNode {
  const [versions, setVersions] = useState<StoryVersion[] | undefined>()
  const [selected, setSelected] = useState<StoryVersion | undefined>()
  const [content, setContent] = useState<{ id: string; text: string } | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api.history(document.documentId)
      .then((list) => { if (live) setVersions([...list].sort((a, b) => b.createdAt - a.createdAt || b.version - a.version)) })
      .catch((reason: unknown) => { if (live) setError(message(reason)) })
    return () => { live = false }
  }, [api, document.documentId])
  useEffect(() => {
    if (selected === undefined) return
    let live = true
    setContent(undefined)
    api.version(document.documentId, selected.id)
      .then((answer) => { if (live) setContent({ id: selected.id, text: projectStoryBody(answer.content).trim() }) })
      .catch((reason: unknown) => { if (live) setError(t('sw.history.loadFailed', { message: message(reason) })) })
    return () => { live = false }
  }, [api, document.documentId, selected, t])
  const restore = async (): Promise<void> => {
    if (selected === undefined) return
    setBusy(true)
    const ok = await store.restore(selected.id)
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Modal open onClose={onClose} title={t('sw.history.title')} closeLabel={t('sw.close')} contentClassName={css.historyBody}>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      {versions === undefined && error === undefined && <p className={css.quiet}>{t('sw.loading')}</p>}
      {versions?.length === 0 && <p className={css.quiet}>{t('sw.history.empty')}</p>}
      {versions !== undefined && versions.length > 0 && (
        <div className={css.history}>
          <ul className={css.versions}>
            {versions.map(version => (
              <li key={version.id}>
                <button type="button" className={css.version} aria-pressed={selected?.id === version.id} onClick={() => { setSelected(version) }}>
                  <span className={css.versionTitle}>{versionTitle(version, t)}</span>
                  <span className={css.versionMeta}>
                    {new Date(version.createdAt).toLocaleString()}
                    <Tag tone="quiet">{t(`sw.history.source.${version.source}`)}</Tag>
                    {version.current && <Tag tone="info">{t('sw.history.current')}</Tag>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className={css.versionPreview}>
            {selected === undefined && <p className={css.quiet}>{t('sw.history.pick')}</p>}
            {selected !== undefined && content?.id === selected.id && (
              <>
                <div className={css.actions}>
                  <Button size="sm" variant="primary" disabled={!canRestore || busy || selected.current} onClick={() => { void restore() }}>{t('sw.history.restore')}</Button>
                </div>
                {!canRestore && <p className={css.quiet}>{t('sw.history.restoreBlocked')}</p>}
                <div className={css.reading}><MarkdownText text={content.text} labels={labels} variant="compact" /></div>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

export function ConflictDialog({ conflict, draft, store, t, onClose }: { conflict: StoryDocument; draft: string; store: StoryStore; t: Translate; onClose: () => void }): ReactNode {
  const [mine, setMine] = useState(draft)
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true)
    const ok = await store.resolve(mine)
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sw.conflict.title')}
      description={t('sw.conflict.hint')}
      closeLabel={t('sw.close')}
      contentClassName={css.mergeBody}
      footer={(
        <>
          <Button variant="ghost" onClick={() => { store.adopt(); onClose() }}>{t('sw.takeTheirs')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void save() }}>{t('sw.conflict.save')}</Button>
        </>
      )}
    >
      <div className={css.merge} onKeyDown={(event) => { event.stopPropagation() }}>
        <label className={css.field}>
          <span className={css.label}>{t('sw.conflict.theirs')}</span>
          <GrowingTextarea className={css.textarea} value={conflict.content} readOnly minHeight={200} />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('sw.conflict.mine')}</span>
          <GrowingTextarea className={css.textarea} value={mine} minHeight={200} onChange={(event) => { setMine(event.currentTarget.value) }} />
        </label>
      </div>
    </Modal>
  )
}

const objectKindLabel = (target: StoryObjectTarget, t: Translate): string =>
  t(target.kind === 'entity' ? 'sw.kind.entity' : target.kind === 'scene' ? 'sw.kind.scene' : 'sw.kind.shotObject')

export function DeleteDialog({ target, document, api, store, t, onClose }: { target: StoryObjectTarget; document: StoryDocument; api: StoryApi; store: StoryStore; t: Translate; onClose: () => void }): ReactNode {
  const [preview, setPreview] = useState<StoryDeletionPreviewResponse | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [revision, setRevision] = useState(document.revision)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    setPreview(undefined)
    api.deletionPreview(document.documentId, target)
      .then((answer) => { if (live) setPreview(answer) })
      .catch((reason: unknown) => { if (live) setError(message(reason)) })
    return () => { live = false }
  }, [api, document.documentId, target, revision])
  const remove = async (): Promise<void> => {
    if (preview === undefined) return
    setBusy(true)
    const ok = await store.mutate(
      () => api.apply(document.documentId, { expectedRevision: preview.revision, operations: [{ kind: 'deleteObject', target }], operationId: crypto.randomUUID() }),
      (reason) => {
        if (!(reason instanceof StoryConflictError)) return false
        store.replace(reason.current)
        setError(t('sw.delete.changed'))
        setRevision(reason.current.revision)
        return true
      },
    )
    setBusy(false)
    if (ok) onClose()
  }
  const archive = async (): Promise<void> => {
    setBusy(true)
    const ok = await store.apply([{ kind: 'setObjectArchived', target, archived: true }])
    setBusy(false)
    if (ok) onClose()
  }
  // One line per object that still uses the target, named as the person knows it.
  const blocking = [...new Map((preview?.dependencies ?? []).filter(dependency => dependency.blocksDeletion).map(dependency => [`${dependency.collection}:${dependency.id}`, dependency])).values()]
  const metadata = document.parsed.metadata
  const titleOf = (blockId: string | undefined): string => cardName(document.parsed.blocks.find(block => block.id === blockId)?.markdown ?? '') || t('sw.unnamed')
  const dependencyLabel = (dependency: { collection: string; id: string }): string => {
    switch (dependency.collection) {
      case 'shots': return t('sw.dep.shot', { title: titleOf(metadata?.shots.find(item => item.id === dependency.id)?.descriptionBlockId) })
      case 'scenes': return t('sw.dep.scene', { title: titleOf(metadata?.scenes.find(item => item.id === dependency.id)?.headingBlockId) })
      case 'entities': return t('sw.dep.entity', { title: titleOf(metadata?.entities.find(item => item.id === dependency.id)?.profileBlockId) })
      case 'speech': return t('sw.dep.speech')
      case 'bindings': return t('sw.dep.binding')
      default: return t('sw.dep.other', { collection: dependency.collection })
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sw.delete.title', { kind: objectKindLabel(target, t) })}
      closeLabel={t('sw.close')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('sw.cancel')}</Button>
          {preview !== undefined && !preview.archived && <Button variant="outline" disabled={busy} onClick={() => { void archive() }}>{t('sw.delete.archiveInstead')}</Button>}
          <Button variant="primary" disabled={busy || preview?.canDelete !== true} onClick={() => { void remove() }}>{t('sw.delete.confirm')}</Button>
        </>
      )}
    >
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      {preview === undefined && error === undefined && <p className={css.quiet}>{t('sw.delete.loading')}</p>}
      {preview !== undefined && (
        <div className={css.form}>
          <p><strong>{preview.title || t('sw.unnamed')}</strong></p>
          <p className={css.quiet}>{preview.canDelete ? t('sw.delete.body') : t('sw.delete.blocked')}</p>
          {blocking.length > 0 && (
            <>
              <p className={css.label}>{t('sw.delete.dependencies')}</p>
              <ul className={css.dependencies}>
                {blocking.map(dependency => <li key={`${dependency.collection}:${dependency.id}`}>{dependencyLabel(dependency)}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

class CardConflict extends Error {
  constructor(readonly document: StoryDocument, readonly latest: StoryCardSnapshot | null, readonly fields: StoryCardField[]) {
    super('The card changed while its form was open.')
  }
}

const fieldText = (value: StoryCardFields[StoryCardField]): string => Array.isArray(value) ? value.join(', ') : value === null || value === '' ? '—' : String(value)

export function CardDialog({ target, document, api, store, canMutate, t, onClose, onEditBlock, onDelete }: {
  target: StoryCardTarget
  document: StoryDocument
  api: StoryApi
  store: StoryStore
  canMutate: boolean
  t: Translate
  onClose: () => void
  onEditBlock: (blockId: string) => void
  onDelete: (target: StoryObjectTarget) => void
}): ReactNode {
  const [baseline, setBaseline] = useState<StoryCardSnapshot | null>(() => readStoryCard(document, target))
  const [fields, setFields] = useState<StoryCardFields | null>(() => baseline?.fields ?? null)
  const [seconds, setSeconds] = useState(() => baseline?.fields.estimatedSeconds === null || baseline === null ? '' : String(baseline.fields.estimatedSeconds))
  const [review, setReview] = useState<{ latest: StoryCardSnapshot | null; fields: StoryCardField[] } | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const metadata = document.parsed.metadata
  const blocks = useMemo(() => new Map(document.parsed.blocks.map(block => [block.id, block])), [document.parsed.blocks])
  const record = target.kind === 'entity' ? metadata?.entities.find(item => item.id === target.id) : metadata?.shots.find(item => item.id === target.id)
  const title = target.kind === 'shot' ? t('sw.detail.shot') : t(`sw.detail.${(record as StoryEntity | undefined)?.kind ?? 'person'}`)
  if (baseline === null || fields === null) {
    return (
      <Modal open onClose={onClose} title={title} closeLabel={t('sw.close')}>
        <p className={css.quiet}>{t('sw.detail.removed')}</p>
      </Modal>
    )
  }
  const secondsValue = seconds.trim() === '' ? null : Number(seconds)
  const secondsValid = secondsValue === null || (Number.isFinite(secondsValue) && secondsValue >= 0)
  const form: StoryCardFields = { ...fields, estimatedSeconds: secondsValid ? secondsValue : fields.estimatedSeconds }
  const dirty = storyCardChanged(baseline.fields, form)
  const set = (change: Partial<StoryCardFields>): void => { setFields({ ...fields, ...change }) }
  const toggle = (key: 'sourceBlockIds' | 'entityIds', id: string, on: boolean): void => {
    set({ [key]: on ? [...fields[key], id] : fields[key].filter(item => item !== id) })
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    const ok = await store.mutate(async () => {
      const latest = await api.read(document.documentId)
      const card = readStoryCard(latest, target)
      if (card === null || card.blockId !== baseline.blockId) throw new CardConflict(latest, null, [])
      const compared = mergeStoryCardFields(baseline.fields, form, card.fields)
      if (compared.conflicts.length > 0) throw new CardConflict(latest, card, compared.conflicts)
      const operations = storyCardOperations(card, compared.merged)
      if (operations.length === 0) return { document: latest, changed: false }
      return api.apply(latest.documentId, { expectedRevision: latest.revision, operations, operationId: crypto.randomUUID() })
    }, (reason) => {
      if (reason instanceof CardConflict) {
        store.replace(reason.document)
        setReview({ latest: reason.latest, fields: reason.fields })
        return true
      }
      if (reason instanceof StoryConflictError) {
        const latest = readStoryCard(reason.current, target)
        store.replace(reason.current)
        setReview({ latest, fields: latest === null ? [] : mergeStoryCardFields(baseline.fields, form, latest.fields).conflicts })
        return true
      }
      return false
    })
    setBusy(false)
    if (ok) onClose()
  }
  const resolve = (field: StoryCardField, useTheirs: boolean): void => {
    if (review?.latest == null) return
    const remote = review.latest.fields[field]
    if (useTheirs) {
      setFields({ ...fields, [field]: remote })
      if (field === 'estimatedSeconds') setSeconds(remote === null ? '' : String(remote))
    }
    setBaseline({ ...baseline, revision: review.latest.revision, fields: { ...baseline.fields, [field]: remote } })
    const remaining = review.fields.filter(key => key !== field)
    setReview(remaining.length > 0 ? { ...review, fields: remaining } : null)
  }
  const fieldLabels: Record<StoryCardField, string> = {
    name: t('sw.detail.name'), description: t('sw.detail.description'), visualIdentity: t('sw.detail.visualIdentity'), visualState: t('sw.detail.visualState'),
    sceneId: t('sw.scene'), estimatedSeconds: t('sw.seconds'), sourceBlockIds: t('sw.detail.sources'), entityIds: t('sw.detail.entities'),
  }
  const blocked = review !== null && (review.latest === null || review.fields.length > 0)
  const archived = record?.archived === true
  const editable = canMutate && !busy
  const speech = target.kind === 'entity' && (record as StoryEntity | undefined)?.kind === 'person'
    ? (metadata?.speech ?? []).filter(item => item.speakerId === target.id)
    : []
  const people = (metadata?.entities ?? []).filter(entity => entity.kind === 'person')
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      closeLabel={t('sw.close')}
      contentClassName={css.cardBody}
      footer={(
        <>
          <Button variant="ghost" disabled={!canMutate || dirty} onClick={() => { onDelete(target) }}>{t('sw.delete')}</Button>
          <Button variant="ghost" disabled={!canMutate || dirty} onClick={() => { void store.apply([{ kind: 'setObjectArchived', target, archived: !archived }]).then((ok) => { if (ok) onClose() }) }}>{archived ? t('sw.unarchive') : t('sw.archive')}</Button>
          <Button variant="ghost" disabled={dirty} onClick={() => { onEditBlock(baseline.blockId) }}>{t('sw.editInBody')}</Button>
          <Button variant="primary" disabled={!editable || !dirty || blocked || !secondsValid} onClick={() => { void save() }}>{t('sw.save')}</Button>
        </>
      )}
    >
      <div className={css.form} onKeyDown={(event) => { event.stopPropagation() }}>
        <label className={css.field}>
          <span className={css.label}>{t('sw.detail.name')}</span>
          <Input data-modal-autofocus value={fields.name} disabled={!editable} onChange={(event) => { set({ name: event.target.value }) }} />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('sw.detail.description')}</span>
          <GrowingTextarea className={css.textarea} value={fields.description} readOnly={!editable} onChange={(event) => { set({ description: event.currentTarget.value }) }} />
        </label>
        {target.kind === 'entity' && (
          <>
            <label className={css.field}>
              <span className={css.label}>{t('sw.detail.visualIdentity')}</span>
              <GrowingTextarea className={css.textarea} value={fields.visualIdentity} placeholder={t('sw.detail.visualIdentityHint')} readOnly={!editable} onChange={(event) => { set({ visualIdentity: event.currentTarget.value }) }} />
            </label>
            <label className={css.field}>
              <span className={css.label}>{t('sw.detail.visualState')}</span>
              <GrowingTextarea className={css.textarea} value={fields.visualState} placeholder={t('sw.detail.visualStateHint')} readOnly={!editable} onChange={(event) => { set({ visualState: event.currentTarget.value }) }} />
            </label>
            {speech.map(item => (
              <label key={item.id} className={css.inlineField}>
                <span>{t('sw.detail.speech')} · {(blocks.get(item.blockId)?.markdown.trim() ?? '').slice(0, 40)}</span>
                <select
                  className={css.select}
                  value={item.speakerId}
                  disabled={!editable || dirty}
                  onChange={(event) => { void store.apply([{ kind: 'setSpeechSpeaker', speechId: item.id, speakerId: event.currentTarget.value }]) }}
                >
                  {people.map(person => <option key={person.id} value={person.id}>{cardName(blocks.get(person.profileBlockId)?.markdown ?? '') || t('sw.unnamed')}</option>)}
                </select>
              </label>
            ))}
          </>
        )}
        {target.kind === 'shot' && metadata !== null && metadata !== undefined && (
          <>
            <label className={css.inlineField}>
              <span>{t('sw.seconds')}</span>
              <Input type="number" min="0" step="0.1" value={seconds} disabled={!editable} onChange={(event) => { setSeconds(event.target.value) }} />
            </label>
            <label className={css.inlineField}>
              <span>{t('sw.scene')}</span>
              <select className={css.select} value={fields.sceneId ?? ''} disabled={!editable} onChange={(event) => { set({ sceneId: event.currentTarget.value || null }) }}>
                <option value="">{t('sw.noScene')}</option>
                {orderedScenes(metadata).map(scene => <option key={scene.id} value={scene.id}>{cardName(blocks.get(scene.headingBlockId)?.markdown ?? '') || t('sw.unnamed')}</option>)}
              </select>
            </label>
            <fieldset className={css.checklist}>
              <legend className={css.label}>{t('sw.detail.sources')}</legend>
              {document.parsed.blocks.filter(block => block.id !== baseline.blockId).map(block => (
                <Checkbox
                  key={block.id}
                  checked={fields.sourceBlockIds.includes(block.id)}
                  disabled={!editable}
                  onChange={(on: boolean) => { toggle('sourceBlockIds', block.id, on) }}
                  label={storyBlockTitle(block).slice(0, 60) || block.kind}
                />
              ))}
            </fieldset>
            <fieldset className={css.checklist}>
              <legend className={css.label}>{t('sw.detail.entities')}</legend>
              {metadata.entities.map(entity => (
                <Checkbox
                  key={entity.id}
                  checked={fields.entityIds.includes(entity.id)}
                  disabled={!editable}
                  onChange={(on: boolean) => { toggle('entityIds', entity.id, on) }}
                  label={cardName(blocks.get(entity.profileBlockId)?.markdown ?? '') || t('sw.unnamed')}
                />
              ))}
            </fieldset>
          </>
        )}
        {review !== null && (
          <section className={css.review} role="alert">
            <p>{review.latest === null ? t('sw.detail.removed') : t('sw.detail.conflict')}</p>
            {review.latest !== null && review.fields.map(field => (
              <div key={field} className={css.reviewField}>
                <strong>{fieldLabels[field]}</strong>
                <span className={css.quiet}>{t('sw.detail.theirs', { value: fieldText(review.latest!.fields[field]) })}</span>
                <span className={css.quiet}>{t('sw.detail.mine', { value: fieldText(form[field]) })}</span>
                <div className={css.actions}>
                  <Button size="sm" variant="ghost" onClick={() => { resolve(field, false) }}>{t('sw.detail.keepMine')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { resolve(field, true) }}>{t('sw.detail.useTheirs')}</Button>
                </div>
              </div>
            ))}
          </section>
        )}
        <details className={css.idDetails}>
          <summary>{t('sw.detail.id')}</summary>
          <code>{target.id}</code>
          <Button size="sm" variant="ghost" onClick={() => { void writeClipboard(target.id).then(setCopied) }}>{copied ? t('sw.detail.copied') : t('sw.detail.copyId')}</Button>
        </details>
      </div>
    </Modal>
  )
}
