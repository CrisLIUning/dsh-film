/**
 * One hosted app (storyboard canvas, editing desk, director desk) in a frame
 * filling the tab. The app is served by this plugin's Host half from
 * `api/dsh-film/apps/<app>/index.html`, on the Host's own origin, so it calls
 * the plugin's routes with the same sign-in as the page.
 *
 * Messages between the page and the app carry a `source` tag:
 * - page → app `{ source: 'dsh-film', type: 'theme', theme }` when the app
 *   loads and whenever the Host's look changes;
 * - app → page `{ source: 'dsh-film-app', type, ... }`, handed to `onMessage`
 *   (`type: 'ready'` makes the page send the look again).
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../types.ts'
import { observeHostTheme, readHostTheme } from './host-theme.ts'
import css from './workbench.module.css'

export interface AppMessage {
  source: 'dsh-film-app'
  type: string
  [key: string]: unknown
}

export interface AppFrameProps {
  /** The app's directory name under `apps/`. */
  app: string
  /** Query parameters for the app page. */
  query: Readonly<Record<string, string>>
  /** The frame's accessible name. */
  title: string
  t: Translate
  /** What to show when this build does not carry the app. */
  missing: ReactNode
  onMessage?: (message: AppMessage) => void
}

type Availability = 'checking' | 'present' | 'missing' | 'failed'

const pageUrl = (app: string, query: Readonly<Record<string, string>> = {}): URL => {
  const url = new URL(`api/dsh-film/apps/${app}/index.html`, document.baseURI)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url
}

const isAppMessage = (data: unknown): data is AppMessage =>
  typeof data === 'object' && data !== null && (data as { source?: unknown }).source === 'dsh-film-app'
  && typeof (data as { type?: unknown }).type === 'string'

/**
 * Draw a hosted app, after checking this build carries it.
 * @param props - the app, its parameters and the page's handlers.
 * @returns the frame, or the missing-app notice.
 */
export function AppFrame({ app, query, title, t, missing, onMessage }: AppFrameProps): ReactNode {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const [availability, setAvailability] = useState<Availability>('checking')
  const [attempt, setAttempt] = useState(0)
  const handler = useRef(onMessage)
  handler.current = onMessage

  useEffect(() => {
    const controller = new AbortController()
    setAvailability('checking')
    fetch(pageUrl(app), { method: 'HEAD', credentials: 'same-origin', signal: controller.signal })
      .then((response) => { setAvailability(response.ok ? 'present' : response.status === 404 ? 'missing' : 'failed') })
      .catch(() => { if (!controller.signal.aborted) setAvailability('failed') })
    return () => { controller.abort() }
  }, [app, attempt])

  useEffect(() => {
    if (availability !== 'present') return
    const send = (): void => {
      frame.current?.contentWindow?.postMessage({ source: 'dsh-film', type: 'theme', theme: readHostTheme() }, location.origin)
    }
    const receive = (event: MessageEvent): void => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || !isAppMessage(event.data)) return
      if (event.data.type === 'ready') send()
      handler.current?.(event.data)
    }
    window.addEventListener('message', receive)
    const stop = observeHostTheme(send)
    return () => {
      window.removeEventListener('message', receive)
      stop()
    }
  }, [availability])

  if (availability === 'checking') return <p className={css.notice} role="status">{t('app.loading')}</p>
  if (availability === 'missing') return <div className={css.notice}>{missing}</div>
  if (availability === 'failed') {
    return (
      <div className={css.notice} role="alert">
        <p>{t('app.failed')}</p>
        <Button variant="outline" size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('tab.retry')}</Button>
      </div>
    )
  }
  return (
    <iframe
      ref={frame}
      className={css.appFrame}
      src={pageUrl(app, query).href}
      title={title}
      allow="fullscreen; clipboard-read; clipboard-write; autoplay"
      onLoad={() => {
        frame.current?.contentWindow?.postMessage({ source: 'dsh-film', type: 'theme', theme: readHostTheme() }, location.origin)
      }}
    />
  )
}
