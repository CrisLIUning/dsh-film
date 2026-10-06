/**
 * One part's tab body. It finds the session's workspace and draws the
 * workbench, which is a separate bundle file loaded the first time any part
 * is opened; the entry the Host loads at every start stays small.
 */

import { Component, Suspense, lazy, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilmView, Translate, WorkbenchProps } from './types.ts'
import type { SuiteView } from './suite.ts'
import { kindOf } from './views.ts'
import css from './TabBody.module.css'

const loadWorkbench = async (): Promise<{ default: ComponentType<WorkbenchProps> }> =>
  ({ default: (await import('./workbench/workbench.tsx')).Workbench })

/** Shared by every tab: once loaded it renders at once. Replaced by a retry after a failed load. */
let Workbench = lazy(loadWorkbench)

/** The slice of the sidebar's tab information this body reads. */
interface TabInfo {
  tab: {
    visible: boolean
    actions: { openTab(kind: string): void }
  }
}

/** The slice of the session list this body reads. */
interface SessionsSnapshot {
  byId: Readonly<Record<string, { readonly cwd?: string | undefined } | undefined>>
}

export interface TabBodyProps {
  /** From the right sidebar: the tab being drawn. */
  useTabInfo: () => TabInfo
  /** From the session slot scope. */
  sessionId: string
  useSessions: <T>(select: (sessions: SessionsSnapshot) => T) => T
  /** From this plugin's registration. */
  translate: Translate
  view: FilmView
  /** From this plugin's registration: what the Host has of the components the workbench leans on. */
  suite: SuiteView
}

interface BoundaryProps {
  t: Translate
  onRetry: () => void
  children: ReactNode
}

/** Shows a failed workbench load with a retry, instead of an empty pane. */
class LoadBoundary extends Component<BoundaryProps, { error: Error | undefined }> {
  override state: { error: Error | undefined } = { error: undefined }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === undefined) return this.props.children
    return (
      <div className={css.notice} role="alert">
        <p>{this.props.t('tab.loadFailed', { message: error.message })}</p>
        <Button variant="outline" size="sm" onClick={this.props.onRetry}>{this.props.t('tab.retry')}</Button>
      </div>
    )
  }
}

/**
 * Draw one part for the session's workspace.
 * @param props - the tab, the session and this part.
 * @returns the body.
 */
export function TabBody({ useTabInfo, sessionId, useSessions, translate: t, view, suite }: TabBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const [attempt, setAttempt] = useState(0)
  if (cwd === undefined || cwd === '') return <p className={css.notice}>{t('tab.noWorkspace')}</p>
  const retry = (): void => {
    Workbench = lazy(loadWorkbench)
    setAttempt(value => value + 1)
  }
  return (
    <div className={css.root}>
      <LoadBoundary key={attempt} t={t} onRetry={retry}>
        <Suspense fallback={<p className={css.notice} role="status">{t('tab.loading')}</p>}>
          <Workbench
            view={view}
            cwd={cwd}
            visible={tab.visible}
            t={t}
            openView={(next) => { tab.actions.openTab(kindOf(next)) }}
            suite={suite}
          />
        </Suspense>
      </LoadBoundary>
    </div>
  )
}
