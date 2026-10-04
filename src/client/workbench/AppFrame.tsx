/**
 * One hosted app (storyboard canvas, editing desk, director desk) in a frame
 * filling the tab. The app is served by this plugin's Host half from
 * `api/dsh-film/apps/<app>/index.html`, on the Host's own origin, so it calls
 * the plugin's routes with the same sign-in as the page.
 *
 * Each app keeps the host protocol it was written for; a {@link FrameProtocol}
 * speaks it for the workbench: what to put in the page URL, how to tell the
 * app the Host's look, and what to do with the app's messages.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../types.ts'
import { observeHostTheme, readHostTheme } from './host-theme.ts'
import type { HostTheme } from './host-theme.ts'
import css from './workbench.module.css'

/** Sends a message to the framed app. */
export type FramePost = (message: unknown) => void

export interface FrameProtocol {
  /** Query parameters for the app page, given the look it opens with. */
  query(theme: HostTheme): Readonly<Record<string, string>>
  /** Tell the app the Host's look: after it loads and on every change. */
  sendTheme(post: FramePost, theme: HostTheme): void
  /** Handle one message from the app (already checked to come from this frame). */
  receive(data: unknown, post: FramePost): void
  /** Start sending the app messages of the workbench's own (other tabs' requests) once it is loaded; returns the stop. */
  attach?(post: FramePost): () => void
}

export interface AppFrameProps {
  /** The app's directory name under `apps/`. */
  app: string
  protocol: FrameProtocol
  /** The frame's accessible name. */
  title: string
  t: Translate
  /** What to show when this build does not carry the app. */
  missing: ReactNode
}

type Availability = 'checking' | 'present' | 'missing' | 'failed'

const pageUrl = (app: string, query: Readonly<Record<string, string>> = {}): URL => {
  const url = new URL(`api/dsh-film/apps/${app}/index.html`, document.baseURI)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url
}

/**
 * Draw a hosted app, after checking this build carries it.
 * @param props - the app, its protocol and copy.
 * @returns the frame, or the missing-app notice.
 */
export function AppFrame({ app, protocol, title, t, missing }: AppFrameProps): ReactNode {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const [availability, setAvailability] = useState<Availability>('checking')
  const [attempt, setAttempt] = useState(0)
  const current = useRef(protocol)
  current.current = protocol
  // The page URL is fixed when the frame mounts; later looks travel by message.
  const src = useMemo(() => pageUrl(app, protocol.query(readHostTheme())).href, [app, attempt])

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
    const post: FramePost = (message) => { frame.current?.contentWindow?.postMessage(message, location.origin) }
    const receive = (event: MessageEvent): void => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return
      current.current.receive(event.data, post)
    }
    window.addEventListener('message', receive)
    const stop = observeHostTheme((theme) => { current.current.sendTheme(post, theme) })
    const detach = current.current.attach?.(post)
    return () => {
      window.removeEventListener('message', receive)
      stop()
      detach?.()
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
      src={src}
      title={title}
      allow="fullscreen; clipboard-read; clipboard-write; autoplay"
      onLoad={() => {
        current.current.sendTheme((message) => { frame.current?.contentWindow?.postMessage(message, location.origin) }, readHostTheme())
      }}
    />
  )
}
