/**
 * The 剧本 tab's 导入 and 导出 dialogs. Import picks or pastes a Markdown file
 * or a reference package (ZIP), shows the plugin's preview and creates a new
 * copy pinned to the previewed bytes; it never overwrites. Export takes the
 * saved revision as complete Markdown, body text only, or a package with the
 * bound reference images, and hands the result to the browser as a download.
 *
 * Ported from Studio `apps/web/src/components/production/screenwriter/
 * StoryExchange.tsx` (a drawer there, two DSH modals here). The preview adds
 * a read view of the body beside Studio's raw text.
 * @module dsh-film/client/workbench/story/StoryExchangeDialogs
 */

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, MarkdownText, Modal, SegmentedControl, Tag, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StoryExportRequest, StoryExportResult, StoryImportPreview, StoryImportRequest } from '../../../screenwriter/contracts/assets.ts'
import { projectStoryBody } from '../../../screenwriter/contracts/tokens.ts'
import type { StoryDocument } from '../../../screenwriter/contracts/types.ts'
import type { Translate } from '../../types.ts'
import { GrowingTextarea } from './BodyView.tsx'
import { IMPORT_ACCEPT, ImportFileError, MAX_IMPORT_BYTES, downloadStoryExport, exportRequest, exportSummary, importApplyRequest, importPreviewSummary, importRequestFromFile } from './exchange.ts'
import { StoryApiError, StoryConflictError } from './story-api.ts'
import type { StoryApi } from './story-api.ts'
import type { StoryStore } from './story-store.ts'
import css from './screenwriter.module.css'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

const FORMAT_TONES: Record<StoryImportPreview['format'], TagTone> = { native: 'success', plain: 'neutral', unsupported: 'warning', invalid: 'danger' }

/**
 * The import dialog.
 * @param props - the store (which opens the copy), the API and copy.
 */
export function ImportDialog({ api, store, labels, t, onClose, onImported }: {
  api: StoryApi
  store: StoryStore
  labels: MarkdownLabels
  t: Translate
  onClose: () => void
  /** The copy is open. */
  onImported: () => void
}): ReactNode {
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [input, setInput] = useState<StoryImportRequest>({ format: 'markdown', encoding: 'utf8', content: '' })
  const [file, setFile] = useState<{ name: string; size: number } | undefined>()
  const [preview, setPreview] = useState<StoryImportPreview | null>(null)
  const [showSource, setShowSource] = useState<'read' | 'source'>('read')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const pick = async (picked: File): Promise<void> => {
    setBusy(true)
    setPreview(null)
    setError(undefined)
    try {
      // An oversized file is refused before it is read into memory.
      if (picked.size > MAX_IMPORT_BYTES) throw new ImportFileError('too-large')
      setInput(importRequestFromFile(picked.name, new Uint8Array(await picked.arrayBuffer())))
      setFile({ name: picked.name, size: picked.size })
    } catch (reason) {
      setError(reason instanceof ImportFileError ? t(reason.reason === 'too-large' ? 'sw.import.tooLarge' : 'sw.import.notUtf8') : message(reason))
    } finally {
      setBusy(false)
    }
  }
  const inspect = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      setPreview(await api.previewImport(input))
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }
  const create = async (): Promise<void> => {
    if (preview === null) return
    setBusy(true)
    setError(undefined)
    const ok = await store.importCopy(() => api.importCopy(importApplyRequest(input, preview)), (reason) => {
      // The bytes changed after the preview (or it was never taken): preview them again.
      if (reason instanceof StoryApiError && reason.code === 'STORY_IMPORT_PREVIEW_REQUIRED') {
        setPreview(null)
        setError(t('sw.import.previewStale'))
      } else {
        setError(message(reason))
      }
      return true
    })
    setBusy(false)
    if (ok) onImported()
    else if (store.dirty) setError(t('sw.import.blocked'))
  }

  const summary = preview === null ? undefined : importPreviewSummary(preview)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sw.import.title')}
      description={t('sw.import.hint')}
      closeLabel={t('sw.close')}
      contentClassName={css.exchangeBody}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('sw.cancel')}</Button>
          <Button variant={preview === null ? 'primary' : 'outline'} disabled={busy || input.content === ''} onClick={() => { void inspect() }}>{t('sw.import.inspect')}</Button>
          {preview !== null && <Button variant="primary" disabled={busy} onClick={() => { void create() }}>{t('sw.import.create')}</Button>}
        </>
      )}
    >
      <div className={css.form} onKeyDown={(event) => { event.stopPropagation() }}>
        <div className={css.actions}>
          <input
            ref={fileInput}
            className={css.fileInput}
            type="file"
            accept={IMPORT_ACCEPT}
            onChange={(event) => {
              const picked = event.currentTarget.files?.[0]
              if (picked !== undefined) void pick(picked)
              event.currentTarget.value = ''
            }}
          />
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { fileInput.current?.click() }}>{t('sw.import.choose')}</Button>
          {file !== undefined && <span className={css.quiet}>{file.name} · {fileSizeText(file.size)}</span>}
        </div>
        {input.format === 'markdown'
          ? (
              <label className={css.field}>
                <span className={css.label}>{t('sw.import.paste')}</span>
                <GrowingTextarea
                  className={css.textarea}
                  value={input.content}
                  minHeight={120}
                  readOnly={busy}
                  onChange={(event) => {
                    setInput({ format: 'markdown', encoding: 'utf8', content: event.currentTarget.value })
                    setFile(undefined)
                    setPreview(null)
                  }}
                />
              </label>
            )
          : (
              <p className={css.quiet}>
                {t('sw.import.packageSelected')}
                {' '}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setInput({ format: 'markdown', encoding: 'utf8', content: '' }); setFile(undefined); setPreview(null) }}>{t('sw.import.clear')}</Button>
              </p>
            )}
        {error !== undefined && <p className={css.error} role="alert">{error}</p>}
        {preview !== null && summary !== undefined && (
          <section className={css.exchangePreview} aria-label={t('sw.import.preview')}>
            <div className={css.meta}>
              <Tag tone={FORMAT_TONES[summary.format]}>{t(`sw.import.format.${summary.format}`)}</Tag>
              <span>{t('sw.import.counts', { entities: summary.entities, scenes: summary.scenes, references: summary.references })}</span>
              {summary.complete !== undefined && <Tag tone={summary.complete ? 'success' : 'warning'}>{summary.complete ? t('sw.export.complete') : t('sw.export.incomplete')}</Tag>}
            </div>
            <p className={css.quiet}>{t('sw.import.copyHint')}</p>
            {summary.missing.length > 0 && (
              <ul className={css.dependencies}>
                {summary.missing.map(item => <li key={`${item.assetId}:${item.assetVersionId}`}>{item.assetId} · {item.assetVersionId} · {t(`sw.ref.status.${item.status}`)}</li>)}
              </ul>
            )}
            {preview.diagnostics.length > 0 && (
              <details className={css.diagnosticsBox}>
                <summary>{t('sw.diagnostics', { count: preview.diagnostics.length })}</summary>
                <ul className={css.diagnostics}>
                  {preview.diagnostics.map((item, index) => <li key={index}>{item.code}: {item.message}</li>)}
                </ul>
              </details>
            )}
            <SegmentedControl
              id="dsh-film-import-view"
              label={t('sw.mode')}
              value={showSource}
              options={[{ value: 'read', label: t('sw.mode.read') }, { value: 'source', label: t('sw.mode.source') }]}
              onChange={setShowSource}
            />
            {showSource === 'read'
              ? <div className={css.exchangeText}><MarkdownText text={projectStoryBody(preview.content).trim()} labels={labels} variant="compact" /></div>
              : <GrowingTextarea className={`${css.textarea} ${css.sourceText}`} value={preview.content} readOnly minHeight={160} />}
          </section>
        )}
      </div>
    </Modal>
  )
}

/**
 * The export dialog.
 * @param props - the saved screenplay, the API, the store (for a newer version) and copy.
 */
export function ExportDialog({ document, api, store, t, onClose }: {
  document: StoryDocument
  api: StoryApi
  store: StoryStore
  t: Translate
  onClose: () => void
}): ReactNode {
  const [allowMissing, setAllowMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<StoryExportResult | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [incomplete, setIncomplete] = useState(false)
  const run = async (mode: StoryExportRequest['mode']): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setIncomplete(false)
    try {
      const exported = await api.exportDocument(document.documentId, exportRequest(document.revision, mode, allowMissing))
      setResult(exported)
      downloadStoryExport(exported)
    } catch (reason) {
      if (reason instanceof StoryConflictError) {
        // The saved screenplay moved on: show it, and export what is now saved on the next click.
        store.replace(reason.current)
        setError(t('sw.export.changed'))
      } else if (reason instanceof StoryApiError && reason.code === 'STORY_PACKAGE_INCOMPLETE') {
        setIncomplete(true)
        setError(message(reason))
      } else {
        setError(message(reason))
      }
    } finally {
      setBusy(false)
    }
  }
  const summary = result === null ? undefined : exportSummary(result)
  return (
    <Modal open onClose={onClose} title={t('sw.export.title')} description={t('sw.export.hint')} closeLabel={t('sw.close')} contentClassName={css.exchangeBody}>
      <div className={css.form}>
        <div className={css.exportOptions}>
          <div className={css.exportOption}>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => { void run('markdown') }}>{t('sw.export.markdown')}</Button>
            <span className={css.quiet}>{t('sw.export.markdownHint')}</span>
          </div>
          <div className={css.exportOption}>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run('body') }}>{t('sw.export.body')}</Button>
            <span className={css.quiet}>{t('sw.export.bodyHint')}</span>
          </div>
          <div className={css.exportOption}>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run('package') }}>{t('sw.export.package')}</Button>
            <div className={css.exportAllow} data-highlight={incomplete || undefined}>
              <Checkbox checked={allowMissing} onChange={setAllowMissing} label={t('sw.export.allowMissing')} />
            </div>
          </div>
        </div>
        {busy && <p className={css.quiet} role="status">{t('sw.export.working')}</p>}
        {error !== undefined && <p className={css.error} role="alert">{error}</p>}
        {result !== null && summary !== undefined && (
          <section className={css.exchangePreview} role="status">
            <div className={css.meta}>
              <strong>{t('sw.export.ready', { name: summary.fileName })}</strong>
              {summary.complete !== undefined && <Tag tone={summary.complete ? 'success' : 'warning'}>{summary.complete ? t('sw.export.complete') : t('sw.export.incomplete')}</Tag>}
            </div>
            {summary.complete !== undefined && <p className={css.quiet}>{t('sw.export.fileCount', { count: summary.paths.length })}</p>}
            {summary.missing.length > 0 && (
              <ul className={css.dependencies}>
                {summary.missing.map(item => <li key={`${item.assetId}:${item.assetVersionId}`}>{item.assetId} · {item.assetVersionId} · {t(`sw.ref.status.${item.status}`)}</li>)}
              </ul>
            )}
            {summary.savedPath !== undefined && <p className={css.quiet}>{t('sw.export.saved', { path: summary.savedPath })}</p>}
            <div className={css.actions}>
              <Button size="sm" variant="ghost" onClick={() => { downloadStoryExport(result) }}>{t('sw.export.again')}</Button>
            </div>
            <details className={css.idDetails}>
              <summary>{t('sw.export.details')}</summary>
              <p className={css.quiet}>{t('sw.export.revision')}</p>
              <code>{summary.revision}</code>
              {summary.paths.length > 0 && <ul className={css.dependencies}>{summary.paths.map(path => <li key={path}>{path}</li>)}</ul>}
            </details>
          </section>
        )}
      </div>
    </Modal>
  )
}
