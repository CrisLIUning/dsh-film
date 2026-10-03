/**
 * The 正文 view: the screenplay read as prose, edited section by section, or
 * edited as the whole file. Section edits go through the marker guard, so
 * they can never damage the hidden structure; the whole-file editor can, and
 * says so.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { projectStoryBody } from '../../../screenwriter/contracts/tokens.ts'
import type { Translate } from '../../types.ts'
import { replaceStoryEditorSection, sectionRole, storyEditorSections } from './body-sections.ts'
import css from './screenwriter.module.css'

export type BodyMode = 'read' | 'edit' | 'source'

type GrowingTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  value: string
  minHeight?: number
  inputRef?: (node: HTMLTextAreaElement | null) => void
}

/** A textarea that grows with its text, and again when the pane changes width. */
export function GrowingTextarea({ value, minHeight = 38, inputRef, ...rest }: GrowingTextareaProps): ReactNode {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const fit = (): void => {
    const node = ref.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${Math.max(minHeight, node.scrollHeight)}px`
  }
  useLayoutEffect(fit, [value, minHeight])
  useEffect(() => {
    const node = ref.current
    if (node === null || typeof ResizeObserver === 'undefined') return
    let width = node.clientWidth
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return
      width = node.clientWidth
      fit()
    })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [])
  return <textarea ref={(node) => { ref.current = node; inputRef?.(node) }} value={value} rows={1} {...rest} />
}

const Reading = memo(function Reading({ draft, labels, t }: { draft: string; labels: MarkdownLabels; t: Translate }): ReactNode {
  const text = useMemo(() => projectStoryBody(draft).trim(), [draft])
  if (text === '') return <p className={css.quiet}>{t('sw.body.empty')}</p>
  return <div className={css.reading}><MarkdownText text={text} labels={labels} /></div>
})

export interface BodyViewProps {
  draft: string
  semanticEditable: boolean
  mode: BodyMode
  /** Typing is accepted (not while a conflict waits or the file is being replaced). */
  editable: boolean
  /** Which block to bring into view and focus, once per request. */
  focus: { blockId: string; nonce: number } | null
  onEdit: (draft: string) => void
  t: Translate
}

/**
 * The body in the chosen mode.
 * @param props - the text, the mode and what to do with edits.
 */
export function BodyView({ draft, semanticEditable, mode, editable, focus, onEdit, t }: BodyViewProps): ReactNode {
  const labels = useMemo<MarkdownLabels>(() => ({ code: { copyLabel: t('sw.md.copy'), copiedLabel: t('sw.md.copied') }, footnotes: t('sw.md.footnotes') }), [t])
  if (mode === 'read') return <Reading draft={draft} labels={labels} t={t} />
  if (mode === 'source') {
    return (
      <div className={css.sourceEditor}>
        <p className={css.quiet}>{t('sw.body.source.hint')}</p>
        <GrowingTextarea
          className={css.textarea}
          value={draft}
          minHeight={240}
          spellCheck={false}
          readOnly={!editable}
          aria-label={t('sw.mode.source')}
          onChange={(event) => { onEdit(event.currentTarget.value) }}
        />
      </div>
    )
  }
  return <Sections draft={draft} semanticEditable={semanticEditable} editable={editable} focus={focus} onEdit={onEdit} t={t} />
}

function Sections({ draft, semanticEditable, editable, focus, onEdit, t }: Omit<BodyViewProps, 'mode'>): ReactNode {
  const sections = useMemo(() => storyEditorSections(draft, semanticEditable), [draft, semanticEditable])
  const [rejected, setRejected] = useState(false)
  const inputs = useRef(new Map<string, HTMLTextAreaElement>())
  const handled = useRef<number | null>(null)
  useEffect(() => {
    if (focus === null || handled.current === focus.nonce) return
    const input = inputs.current.get(`block:${focus.blockId}`)
    if (input === undefined) return
    handled.current = focus.nonce
    input.focus()
    input.scrollIntoView?.({ block: 'center' })
  }, [focus, sections])
  if (sections === null) return <p className={css.notice} role="status">{t('sw.body.broken')}</p>
  return (
    // Keys typed here are the editor's, not the Host's shortcuts.
    <div className={css.sections} onKeyDown={(event) => { event.stopPropagation() }}>
      <p className={css.quiet}>{t('sw.body.hint')}</p>
      {rejected && <p className={css.notice} role="alert">{t('sw.body.rejected')}</p>}
      {sections.map((section, index) => {
        const role = sectionRole(section)
        const label = `${t(`sw.role.${role}`)} ${index + 1}`
        return (
          <label key={section.key} className={css.section} data-role={role}>
            <span className={css.sectionLabel}>{label}</span>
            <GrowingTextarea
              inputRef={(node) => {
                if (node === null) inputs.current.delete(section.key)
                else inputs.current.set(section.key, node)
              }}
              className={css.textarea}
              value={section.text}
              readOnly={!editable}
              spellCheck
              aria-label={label}
              onChange={(event) => {
                const next = replaceStoryEditorSection(draft, section, event.currentTarget.value)
                setRejected(next === null)
                if (next !== null) onEdit(next)
              }}
            />
          </label>
        )
      })}
    </div>
  )
}
