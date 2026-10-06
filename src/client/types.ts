/**
 * Types shared by the entry and the lazily loaded workbench. Type-only, so
 * importing them creates no runtime link between the two bundles (the Host's
 * loader cannot resolve one bundle file requiring another).
 */

import type { SuiteView } from './suite.ts'

/** The workbench parts, one right-sidebar tab type each. */
export type FilmView = 'story' | 'board' | 'director'

/** Bound translate function of this plugin's dictionary. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** What a tab body hands the workbench. */
export interface WorkbenchProps {
  view: FilmView
  /** The session's workspace directory. */
  cwd: string
  /** Whether the tab is on screen; hidden tabs stop polling and pause players. */
  visible: boolean
  t: Translate
  /** Open another part in the sidebar. */
  openView: (view: FilmView) => void
  /** What this Host has of the VibeDev components the workbench leans on, and the way to the rest. */
  suite: SuiteView
}
