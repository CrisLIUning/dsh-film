/**
 * The workbench as the storyboard canvas's host, speaking the canvas's own
 * embedding protocol (canvas `lib/host-embed.ts` and the `vibedev:*` window
 * messages Studio's film workspace exchanges with it).
 *
 * The same canvas page backs two tabs: the storyboard (`view: canvas`) and the
 * director desk (`view: director`, the canvas with its desk overlay open).
 */

import type { FilmView } from '../types.ts'
import type { FrameProtocol } from './AppFrame.tsx'
import { onCanvasFocus, requestStoryOpen, takeCanvasFocus } from './film-links.ts'
import { readHostTheme } from './host-theme.ts'
import type { HostTheme } from './host-theme.ts'

export interface CanvasHostOptions {
  /** The film project's id; the board's id too (one board per film). */
  projectId: string
  title: string
  cwd: string
  view: 'canvas' | 'director'
  /** Open another workbench part. */
  openView: (view: FilmView) => void
}

const isMessage = (data: unknown): data is { type: string; projectId?: unknown; [key: string]: unknown } =>
  typeof data === 'object' && data !== null && typeof (data as { type?: unknown }).type === 'string'

/** The page background the canvas blends into, when the Host's token is a plain colour. */
const surfaceOf = (theme: HostTheme): string | undefined => {
  const value = theme.tokens['--dsw-alias-bg-base']
  return value !== undefined && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/]+\)|oklch\([\d\s.,%/-]+\))$/i.test(value) ? value : undefined
}

let requests = 0

/**
 * The protocol for one canvas tab.
 * @param options - the project, workspace and part.
 * @returns the protocol.
 */
export function canvasProtocol(options: CanvasHostOptions): FrameProtocol {
  const { projectId, view } = options
  const viewRequest = (): Record<string, unknown> => ({ type: 'vibedev:film-view', projectId, view, requestId: `dsh-film-${++requests}` })
  // The canvas centres and selects a node on `vibedev:story-focus` (its use-story-canvas-sync); only the storyboard tab takes them.
  const focus = (nodeId: string): Record<string, unknown> => ({ type: 'vibedev:story-focus', projectId, nodeId })
  return {
    query(theme) {
      const surface = surfaceOf(theme)
      return {
        embed: '1',
        odProject: projectId,
        board: projectId,
        title: options.title,
        theme: theme.scheme,
        cwd: options.cwd,
        ...(surface !== undefined ? { surface } : {}),
      }
    },
    sendTheme(post, theme) {
      const surface = surfaceOf(theme)
      post({ type: 'vibedev:canvas-theme', projectId, theme: theme.scheme, ...(surface !== undefined ? { surface } : {}) })
    },
    receive(data, post) {
      if (!isMessage(data) || (data.projectId !== undefined && data.projectId !== projectId)) return
      switch (data.type) {
        case 'vibedev:film-view-ready': {
          // The canvas is listening: show the part this tab is for, and a node the 剧本 tab asked for while it loaded.
          post(viewRequest())
          const nodeId = view === 'canvas' ? takeCanvasFocus(projectId) : undefined
          if (nodeId !== undefined) post(focus(nodeId))
          break
        }
        case 'vibedev:canvas-theme-request':
          this.sendTheme(post, readHostTheme())
          break
        case 'vibedev:story-open':
          // 返回编剧 on a source card: the 剧本 tab opens the object it came from.
          if (typeof data.documentId === 'string' && typeof data.objectId === 'string') requestStoryOpen(projectId, { documentId: data.documentId, objectId: data.objectId })
          options.openView('story')
          break
        case 'vibedev:timeline-open':
          options.openView('timeline')
          break
        case 'vibedev:modeling-task':
          // Modeling tasks go to the agent in Studio; not wired in the workbench yet.
          post({ type: 'vibedev:modeling-result', projectId, requestId: data.requestId, accepted: false, error: '影视工作台暂不支持从这里发起建模任务。' })
          break
        default:
          break
      }
    },
    attach(post) {
      return view === 'canvas' ? onCanvasFocus(projectId, (nodeId) => { post(focus(nodeId)) }) : () => {}
    },
  }
}
