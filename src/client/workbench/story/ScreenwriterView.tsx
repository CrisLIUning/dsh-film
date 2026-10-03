/**
 * The 剧本 tab: the workspace's screenplays (`film/story/*.md`) — the text,
 * its scenes, shots, people, places and props, and their saved versions.
 * Built on DSH's own primitives; the file format and the plugin endpoints are
 * Studio's screenwriter, so the agent's screenwriting tools and this view
 * edit the same files.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, SegmentedControl, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels, SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StoryEntity, StoryObjectTarget, StoryOperation, StoryScene } from '../../../screenwriter/contracts/types.ts'
import type { Translate } from '../../types.ts'
import type { FilmProject } from '../api.ts'
import { BodyView } from './BodyView.tsx'
import type { BodyMode } from './BodyView.tsx'
import { EntitiesView, ShotsView, StructureView, orderedScenes, orderedShots } from './CardViews.tsx'
import type { CardViewContext, EntityKind, ObjectFilter } from './CardViews.tsx'
import type { StoryCardTarget } from './cards.ts'
import { CardDialog, ConflictDialog, DeleteDialog, HistoryDialog, NewDocumentDialog, VersionDialog } from './StoryDialogs.tsx'
import { storyApi } from './story-api.ts'
import { StoryStore } from './story-store.ts'
import css from './screenwriter.module.css'

type View = 'body' | 'structure' | 'shots' | 'person' | 'place' | 'prop'

type Dialog =
  | { kind: 'new' }
  | { kind: 'version' }
  | { kind: 'history' }
  | { kind: 'conflict' }
  | { kind: 'delete'; target: StoryObjectTarget }
  | { kind: 'card'; target: StoryCardTarget }

const VIEWS: readonly View[] = ['body', 'structure', 'shots', 'person', 'place', 'prop']

const uid = (kind: string): string => `${kind}_${crypto.randomUUID()}`

/**
 * Follow the project's change stream for screenplay changes.
 * @param cwd - the workspace.
 * @param projectId - the film project.
 * @param onChange - called on every screenplay change.
 * @returns stops following.
 */
function watchStories(cwd: string, projectId: string, onChange: () => void): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  const url = new URL('api/dsh-film/studio', document.baseURI)
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', `/api/projects/${encodeURIComponent(projectId)}/events`)
  const source = new EventSource(url, { withCredentials: true })
  source.addEventListener('story-changed', onChange)
  return () => { source.close() }
}

export interface ScreenwriterViewProps {
  cwd: string
  project: FilmProject
  visible: boolean
  t: Translate
}

/**
 * The screenplay editor.
 * @param props - the workspace, its project and whether the tab shows.
 */
export function ScreenwriterView({ cwd, project, visible, t }: ScreenwriterViewProps): ReactNode {
  const api = useMemo(() => storyApi(cwd, project.id), [cwd, project.id])
  const store = useMemo(() => new StoryStore({ api, watch: onChange => watchStories(cwd, project.id, onChange) }), [api, cwd, project.id])
  useEffect(() => {
    void store.start()
    return () => { store.dispose() }
  }, [store])
  useEffect(() => { store.setVisible(visible) }, [store, visible])
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const [view, setView] = useState<View>('body')
  const [mode, setMode] = useState<BodyMode>('read')
  const [filter, setFilter] = useState<ObjectFilter>('active')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [focus, setFocus] = useState<{ blockId: string; nonce: number } | null>(null)
  const labels = useMemo<MarkdownLabels>(() => ({ code: { copyLabel: t('sw.md.copy'), copiedLabel: t('sw.md.copied') }, footnotes: t('sw.md.footnotes') }), [t])

  const { document: doc, draft, saving, saveFailed, conflict, error } = state
  const dirty = store.dirty
  const canMutate = store.canMutate
  const metadata = doc?.parsed.metadata ?? null
  const blocks = useMemo(() => new Map((doc?.parsed.blocks ?? []).map(block => [block.id, block])), [doc?.parsed.blocks])
  const busy = saving || dirty || conflict !== null

  const focusBlock = useCallback((blockId: string) => {
    setDialog(null)
    setView('body')
    setMode('edit')
    setFocus({ blockId, nonce: Date.now() })
  }, [])

  const apply = (operations: StoryOperation[]): Promise<boolean> => store.apply(operations)
  const context: CardViewContext | null = metadata === null ? null : {
    metadata,
    blocks,
    filter,
    canMutate,
    t,
    onAddScene: (beforeSceneId) => {
      setFilter('active')
      const headingBlockId = uid('block')
      const actionId = uid('block')
      void apply([{
        kind: 'upsertScene',
        ...(beforeSceneId !== undefined ? { beforeSceneId } : {}),
        scene: { id: uid('scene'), headingBlockId, blockIds: [headingBlockId, actionId] },
        blocks: [
          { id: headingBlockId, kind: 'scene-heading', markdown: `## ${t('sw.newScene')}\n` },
          { id: actionId, kind: 'action', markdown: '\n' },
        ],
      }])
    },
    onAddShot: () => {
      setFilter('active')
      const shot = { id: uid('shot'), descriptionBlockId: uid('block'), sourceBlockIds: [], entityIds: [] }
      void apply([{ kind: 'upsertShot', shot, descriptionMarkdown: `### ${t('sw.newShot')}\n` }]).then((ok) => {
        if (ok) setDialog({ kind: 'card', target: { kind: 'shot', id: shot.id } })
      })
    },
    onAddEntity: (kind: EntityKind) => {
      setFilter('active')
      const entity: StoryEntity = { id: uid(kind), kind, profileBlockId: uid('block') }
      void apply([{ kind: 'upsertEntity', entity, profileMarkdown: `### ${t('sw.unnamed')}\n\n` }]).then((ok) => {
        if (ok) setDialog({ kind: 'card', target: { kind: 'entity', id: entity.id } })
      })
    },
    onMove: (kind, id, direction) => {
      const order = [...(kind === 'scene' ? metadata.sceneOrder : metadata.shotOrder)]
      const shown = (kind === 'scene' ? orderedScenes(metadata) : orderedShots(metadata))
        .filter(item => filter === 'archived' ? item.archived === true : item.archived !== true)
        .map(item => item.id)
      const neighbour = shown[shown.indexOf(id) + direction]
      if (neighbour === undefined) return
      const from = order.indexOf(id)
      const to = order.indexOf(neighbour)
      ;[order[from], order[to]] = [order[to]!, order[from]!]
      void apply([kind === 'scene' ? { kind: 'reorderScenes', sceneIds: order } : { kind: 'reorderShots', shotIds: order }])
    },
    onArchive: (target, archived) => { void apply([{ kind: 'setObjectArchived', target, archived }]) },
    onDelete: target => { setDialog({ kind: 'delete', target }) },
    onRestore: (target) => {
      void apply([{ kind: 'restoreObject', target }]).then((ok) => { if (ok) setFilter('active') })
    },
    onScenePlace: (scene: StoryScene, placeId) => { void apply([{ kind: 'upsertScene', scene: { ...scene, placeId } }]) },
    onOpenCard: target => { setDialog({ kind: 'card', target }) },
    onEditBlock: focusBlock,
  }

  const status = saving ? t('sw.status.saving') : saveFailed ? t('sw.status.failed') : dirty ? t('sw.status.unsaved') : t('sw.status.saved')
  const tabs = VIEWS.map((item): SegmentedTab<View> => ({ value: item, label: t(`sw.view.${item}`), id: `dsh-film-sw-tab-${item}`, panelId: 'dsh-film-sw-panel' })) as [SegmentedTab<View>, ...SegmentedTab<View>[]]

  if (state.status === 'loading') return <p className={css.notice} role="status">{t('sw.loading')}</p>
  if (state.status === 'failed') {
    return (
      <div className={css.notice} role="alert">
        <p>{t('sw.loadFailed', { message: error?.message ?? '' })}</p>
        <Button size="sm" variant="outline" onClick={() => { void store.start() }}>{t('sw.retry')}</Button>
      </div>
    )
  }

  return (
    <section className={css.root}>
      <div className={css.bar}>
        <select
          className={css.documentSelect}
          aria-label={t('sw.document')}
          value={doc?.documentId ?? ''}
          disabled={busy || state.documents.length === 0}
          onChange={(event) => { setDialog(null); setFocus(null); void store.open(event.currentTarget.value) }}
        >
          {doc === null && <option value="">{t('sw.document')}</option>}
          {state.documents.map(item => <option key={item.documentId} value={item.documentId}>{item.title || t('sw.unnamed')}</option>)}
        </select>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDialog({ kind: 'new' }) }}>{t('sw.new')}</Button>
        {doc !== null && <Button size="sm" variant="ghost" disabled={saving} onClick={() => { setDialog({ kind: 'history' }) }}>{t('sw.history')}</Button>}
        {doc !== null && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDialog({ kind: 'version' }) }}>{t('sw.saveVersion')}</Button>}
        {doc !== null && (
          <span className={css.status} role="status" aria-live="polite" data-failed={saveFailed || undefined}>
            {status}
            {saveFailed && <Button size="sm" variant="ghost" onClick={() => { void store.save() }}>{t('sw.retry')}</Button>}
          </span>
        )}
      </div>

      {doc === null
        ? (
            <div className={css.empty}>
              <h3 className={css.emptyTitle}>{t('sw.empty.title')}</h3>
              <p className={css.quiet}>{t('sw.empty.body')}</p>
              <Button variant="primary" onClick={() => { setDialog({ kind: 'new' }) }}>{t('sw.new')}</Button>
            </div>
          )
        : (
            <>
              <SegmentedTabs className={css.tabs} items={tabs} value={view} label={t('sw.views')} onChange={(next) => { setView(next); setDialog(null) }} />
              {error !== null && (
                <div className={css.banner} data-tone="error" role="alert">
                  <span>{error.message}</span>
                  {error.diagnostics.length > 0 && (
                    <ul className={css.diagnostics}>
                      {error.diagnostics.map((item, index) => <li key={index}>{item.message}{item.objectId ? ` · ${item.objectId}` : ''}</li>)}
                    </ul>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => { store.dismissError() }}>{t('sw.close')}</Button>
                </div>
              )}
              {conflict !== null && (
                <div className={css.banner} data-tone="warn" role="alert">
                  <span>{t('sw.conflict')}</span>
                  <Button size="sm" variant="outline" onClick={() => { setDialog({ kind: 'conflict' }) }}>{t('sw.compare')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { store.adopt() }}>{t('sw.takeTheirs')}</Button>
                </div>
              )}
              {view !== 'body' && dirty && <p className={css.banner} data-tone="info">{t('sw.dirtyHint')}</p>}
              {view !== 'body' && !doc.parsed.semanticEditable && doc.parsed.format !== 'plain' && <p className={css.banner} data-tone="info">{t('sw.readOnlyHint')}</p>}
              {doc.parsed.diagnostics.length > 0 && (
                <details className={css.diagnosticsBox}>
                  <summary>{t('sw.diagnostics', { count: doc.parsed.diagnostics.length })}</summary>
                  <ul className={css.diagnostics}>
                    {doc.parsed.diagnostics.map((item, index) => <li key={index}>{item.message}{item.objectId ? ` · ${item.objectId}` : ''}</li>)}
                  </ul>
                </details>
              )}
              <div className={css.toolbar}>
                {view === 'body'
                  ? (
                      <SegmentedControl
                        id="dsh-film-sw-mode"
                        label={t('sw.mode')}
                        value={mode}
                        options={[
                          { value: 'read', label: t('sw.mode.read') },
                          { value: 'edit', label: t('sw.mode.edit') },
                          { value: 'source', label: t('sw.mode.source') },
                        ]}
                        onChange={setMode}
                      />
                    )
                  : (
                      <SegmentedControl
                        id="dsh-film-sw-filter"
                        label={t('sw.filter')}
                        value={filter}
                        options={[
                          { value: 'active', label: t('sw.filter.active') },
                          { value: 'archived', label: t('sw.filter.archived') },
                          { value: 'deleted', label: t('sw.filter.deleted') },
                        ]}
                        onChange={setFilter}
                      />
                    )}
              </div>
              <div id="dsh-film-sw-panel" role="tabpanel" aria-labelledby={`dsh-film-sw-tab-${view}`} className={css.panel}>
                {view === 'body' && (
                  <BodyView
                    key={`${doc.documentId}:${state.epoch}`}
                    draft={draft}
                    semanticEditable={doc.parsed.semanticEditable}
                    mode={mode}
                    editable={conflict === null}
                    focus={focus}
                    onEdit={(next) => { store.edit(next) }}
                    t={t}
                  />
                )}
                {context !== null && view === 'structure' && <StructureView context={context} />}
                {context !== null && view === 'shots' && <ShotsView context={context} />}
                {context !== null && (view === 'person' || view === 'place' || view === 'prop') && <EntitiesView kind={view} context={context} />}
                {context === null && view !== 'body' && <p className={css.quiet}>{t('sw.readOnlyHint')}</p>}
              </div>
            </>
          )}

      {dialog?.kind === 'new' && (
        <NewDocumentDialog store={store} t={t} onClose={() => { setDialog(null) }} onCreated={() => { setDialog(null); setView('body'); setMode('edit') }} />
      )}
      {dialog?.kind === 'version' && doc !== null && (
        <VersionDialog document={doc} api={api} t={t} onClose={(saved) => { setDialog(saved ? { kind: 'history' } : null) }} />
      )}
      {dialog?.kind === 'history' && doc !== null && (
        <HistoryDialog document={doc} api={api} store={store} canRestore={!dirty && conflict === null && !saving} labels={labels} t={t} onClose={() => { setDialog(null) }} />
      )}
      {dialog?.kind === 'conflict' && conflict !== null && (
        <ConflictDialog conflict={conflict} draft={draft} store={store} t={t} onClose={() => { setDialog(null) }} />
      )}
      {dialog?.kind === 'delete' && doc !== null && (
        <DeleteDialog target={dialog.target} document={doc} api={api} store={store} t={t} onClose={() => { setDialog(null) }} />
      )}
      {dialog?.kind === 'card' && doc !== null && (
        <CardDialog
          key={`${dialog.target.kind}:${dialog.target.id}`}
          target={dialog.target}
          document={doc}
          api={api}
          store={store}
          canMutate={canMutate}
          t={t}
          onClose={() => { setDialog(null) }}
          onEditBlock={focusBlock}
          onDelete={(target) => { setDialog({ kind: 'delete', target }) }}
        />
      )}
    </section>
  )
}
