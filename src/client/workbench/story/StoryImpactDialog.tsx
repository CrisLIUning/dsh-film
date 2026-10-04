/**
 * 制作影响: what the storyboard and the cut adopted from this screenplay,
 * compared with the saved text — production inputs, generated outputs,
 * director-shot links and timeline clips — each with a way to the canvas
 * node or the timeline. Read-only: a change notice adopts nothing.
 *
 * Ported from Studio `apps/web/src/components/production/screenwriter/
 * StoryImpact.tsx` (a drawer there, a DSH modal here).
 * @module dsh-film/client/workbench/story/StoryImpactDialog
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StoryImpactItem, StoryImpactResponse } from '../../../screenwriter/contracts/assets.ts'
import type { Translate } from '../../types.ts'
import { impactAction, impactItemKey } from './handoff.ts'
import type { StoryApi } from './story-api.ts'
import css from './screenwriter.module.css'

const STATUS_TONES: Record<StoryImpactItem['status'], TagTone> = { unchanged: 'success', changed: 'warning', 'source-missing': 'danger', unavailable: 'neutral' }

/**
 * The impact report.
 * @param props - the screenplay, whether the body has unsaved text, and where items lead.
 */
export function ImpactDialog({ api, documentId, revision, dirty, t, onClose, onLocate, onOpenTimeline }: {
  api: StoryApi
  documentId: string
  /** The saved revision; a new one re-reads the report. */
  revision: string
  dirty: boolean
  t: Translate
  onClose: () => void
  onLocate: (nodeId: string) => void
  onOpenTimeline: () => void
}): ReactNode {
  const [result, setResult] = useState<StoryImpactResponse | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    setError(undefined)
    setResult(null)
    api.impact(documentId)
      .then((value) => { if (live) setResult(value) })
      .catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [api, documentId, revision, refresh])

  return (
    <Modal open onClose={onClose} title={t('sw.impact.title')} description={t('sw.impact.hint')} closeLabel={t('sw.close')} contentClassName={css.exchangeBody}>
      <div className={css.form}>
        {dirty && <p className={css.banner} data-tone="info">{t('sw.impact.savedOnly')}</p>}
        <div className={css.actions}>
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => { setRefresh(value => value + 1) }}>{t('sw.impact.refresh')}</Button>
        </div>
        {loading && <p className={css.quiet} role="status">{t('sw.loading')}</p>}
        {error !== undefined && <p className={css.error} role="alert">{error}</p>}
        {result !== null && (
          <>
            <details className={css.idDetails}>
              <summary>{t('sw.impact.revision')}</summary>
              <code>{result.currentRevision}</code>
            </details>
            {result.items.length === 0 && <p className={css.quiet}>{t('sw.impact.empty')}</p>}
            <div className={css.impactList}>
              {result.items.map((item) => {
                const action = impactAction(item)
                return (
                  <article key={impactItemKey(item)} className={css.impactItem}>
                    <span className={css.impactSource}>{t(`sw.impact.source.${item.sourceType ?? 'input'}`)}</span>
                    <strong className={css.cardTitle}>{item.title || t('sw.unnamed')}</strong>
                    <span className={css.meta}>
                      <span>{item.field === 'prompt' ? t('sw.impact.prompt') : t('sw.ref.title')}</span>
                      <Tag tone={STATUS_TONES[item.status]}>{t(`sw.impact.status.${item.status}`)}</Tag>
                    </span>
                    {item.manualChanged && <p className={css.quiet}>{t('sw.impact.manual')}</p>}
                    {item.inputsChanged === true && <p className={css.quiet}>{t('sw.impact.inputsChanged')}</p>}
                    <details className={css.idDetails}>
                      <summary>{t('sw.impact.sourceInfo')}</summary>
                      <div className={css.impactMeta}>
                        <span>{t('sw.impact.adoptedRevision')} <code>{item.adoptedRevision}</code></span>
                        {item.nodeId !== '' && <span>{t('sw.impact.node')} <code>{item.nodeId}</code></span>}
                        {item.clipId !== undefined && <span>{t('sw.impact.clip')} <code>{item.clipId}</code></span>}
                        {item.directorShotId !== undefined && <span>{t('sw.impact.directorShot')} <code>{item.directorShotId}</code></span>}
                        {item.outputPath !== undefined && <span>{t('sw.impact.output')} <code>{item.outputPath}</code></span>}
                      </div>
                    </details>
                    <div className={css.actions}>
                      {action.kind === 'timeline'
                        ? <Button size="sm" variant="ghost" onClick={onOpenTimeline}>{t('sw.impact.openTimeline')}</Button>
                        : <Button size="sm" variant="ghost" disabled={action.kind === 'none'} onClick={() => { if (action.kind === 'canvas') onLocate(action.nodeId) }}>{t('sw.impact.locate')}</Button>}
                    </div>
                  </article>
                )
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
