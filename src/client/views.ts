/**
 * The four parts as right-sidebar tab types: each one's registry identity, the
 * kind tabs are opened by, and its place on the sidebar's guide page.
 */

import type { ComponentType } from 'react'
import { ArtworkBoard, ArtworkDirector, ArtworkStory, ArtworkTimeline } from './artwork.tsx'
import type { ArtworkProps } from './artwork.tsx'
import type { FilmView } from './types.ts'

export interface FilmPart {
  view: FilmView
  /** The type's identity in the tab registry, and the key its body registers under. */
  id: string
  /** The kind tabs of this part are opened with (`sidebar://<kind>`). */
  kind: string
  /** Position among the guide page's entry boxes. */
  order: number
  artwork: ComponentType<ArtworkProps>
  /**
   * Keep the body mounted while another tab is shown: the screenplay holds
   * unsaved text and the document, view and filter being worked on, which a
   * hand-off to the storyboard or the editing desk must not throw away.
   */
  keepMounted?: boolean
}

export const PARTS: readonly FilmPart[] = [
  { view: 'story', id: 'dsh-film/story', kind: 'film-story', order: 100, artwork: ArtworkStory, keepMounted: true },
  { view: 'board', id: 'dsh-film/board', kind: 'film-board', order: 101, artwork: ArtworkBoard },
  { view: 'timeline', id: 'dsh-film/timeline', kind: 'film-timeline', order: 102, artwork: ArtworkTimeline },
  { view: 'director', id: 'dsh-film/director', kind: 'film-director', order: 103, artwork: ArtworkDirector },
]

/**
 * The tab kind of a part.
 * @param view - the part.
 * @returns its kind.
 */
export function kindOf(view: FilmView): string {
  const part = PARTS.find(item => item.view === view)
  if (part === undefined) throw new Error(`dsh-film: unknown part ${view}`)
  return part.kind
}
