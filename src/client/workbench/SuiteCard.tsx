/**
 * The footer of a workbench part: what this Host still lacks for the work this part does, or,
 * when nothing is missing, one quiet way into the plugin centre for everything else.
 *
 * It is a plain card at the end of the part, drawn from the entry's own read of the Host
 * (passed in as {@link SuiteView}); nothing here installs, navigates on its own, or appears
 * before the read settled. Opening the centre is the person's click, and a Host where nothing
 * can open shows the package spec instead, to copy into the Plugins page.
 */

import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../types.ts'
import type { CenterTarget, SuiteHint, SuiteView } from '../suite.ts'
import css from './workbench.module.css'

/** What the card draws, independent of React state so a test can fire its own buttons. */
export interface SuiteCardView {
  readonly t: Translate
  /** The hint the entry's read produced; its `missing` lines are already translated. */
  readonly hint: SuiteHint
  /** The spec to offer by hand, once a click found nothing to open. */
  readonly manual?: { readonly spec: string } | undefined
  readonly copied: boolean
  /** The person asked for the centre. */
  onOpen(): void
  /** The person asked for the spec on the clipboard. */
  onCopy(spec: string): void
}

/**
 * Draw the card from a settled read.
 * @param props - the translated hint, the manual fallback and the two clicks.
 * @returns the card.
 */
export function suiteCardView({ t, hint, manual, copied, onOpen, onCopy }: SuiteCardView): ReactNode {
  const missing = hint.kind === 'missing'
  return (
    <section className={`${css.suite} ${missing ? css.suiteMissing : ''}`} data-dsh-film-suite={hint.kind}
      aria-label={t(missing ? 'suite.missing.title' : 'suite.tools.title')}>
      <p className={css.suiteTitle}>{t(missing ? 'suite.missing.title' : 'suite.tools.title')}</p>
      {hint.missing.map(want => <p className={css.suiteLine} key={want.package}>{want.line}</p>)}
      <p className={css.suiteLine}>{t(missing ? 'suite.missing.keep' : 'suite.tools.hint')}</p>
      <div className={css.suiteActions}>
        <Button variant="outline" size="sm" onClick={onOpen}>{t('suite.open')}</Button>
      </div>
      {manual === undefined ? null : (
        <div className={css.suiteManual}>
          <p className={css.suiteLine}>{t('suite.manual')}</p>
          <code className={css.suiteSpec}>{manual.spec}</code>
          <Button variant="ghost" size="sm" onClick={() => { onCopy(manual.spec) }}>
            {t(copied ? 'suite.copied' : 'suite.copy')}
          </Button>
        </div>
      )}
    </section>
  )
}

/**
 * Draw the card.
 * @param props - the entry's suite view and this plugin's dictionary.
 * @returns the card, or nothing before the first read settled.
 */
export function SuiteCard({ suite, t }: { suite: SuiteView; t: Translate }): ReactNode {
  const { read, hint } = useSyncExternalStore(suite.subscribe, suite.getSnapshot, suite.getSnapshot)
  /** Set once a click found nothing to open: the spec to copy is then on screen. */
  const [manual, setManual] = useState<{ readonly spec: string } | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  if (!read) return null
  const open = (): void => {
    const target: CenterTarget = suite.open()
    setCopied(false)
    setManual(target.kind === 'manual' ? { spec: target.spec } : undefined)
  }
  const copy = (spec: string): void => {
    void suite.copy(spec).then((written) => { setCopied(written) })
  }
  return suiteCardView({ t, hint, manual, copied, onOpen: open, onCopy: copy })
}

