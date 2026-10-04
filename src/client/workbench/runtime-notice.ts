/**
 * The restart notice. DeepSeek Harness installs a new dsh-film over the old
 * one in place and asks for a restart; until then the Host keeps the code it
 * started with, the entry bundle is the one it snapshotted at start, and this
 * chunk (client.workbench.js) is read from disk on its first request. So a
 * page can be newer than the Host serving it, or an open page older than what
 * is installed. The page asks `GET /api/dsh-film/runtime` and says "restart"
 * when the Host is older than the page (the route is missing), runs another
 * version than the page was built as, or runs another version than the one
 * installed now. Network errors and server failures say nothing.
 *
 * The copy has a built-in fallback: an older entry still in memory registered
 * an older dictionary, whose translate function echoes keys it lacks.
 */

import { useEffect, useRef, useState } from 'react'
import type { Translate } from '../types.ts'

/** The version this bundle was built as (tsdown defines it); `dev` where nothing does (node tests). */
export const CLIENT_VERSION: string = typeof __DSH_FILM_VERSION__ === 'string' ? __DSH_FILM_VERSION__ : 'dev'

/** What the runtime route answered. */
export type RuntimeProbe =
  | { status: 'ok'; version: string; installed: string | null }
  /** The route is not there: the Host is older than this page. */
  | { status: 'missing' }
  /** No answer worth reading: a network error or a server failure. */
  | { status: 'unreachable' }

/** A restart is needed; the versions are given when they are known. */
export interface RestartNotice {
  /** The version the Host runs. */
  running?: string
  /** The version installed now. */
  installed?: string
}

/**
 * Whether the page should ask for a restart.
 * @param client - the version this page was built as.
 * @param answer - what the runtime route answered.
 * @returns the notice, or `null` when nothing is wrong (or nothing is known).
 */
export function restartNotice(client: string, answer: RuntimeProbe): RestartNotice | null {
  if (answer.status === 'unreachable') return null
  // The page is the installed version, read from disk; the Host predates the route.
  if (answer.status === 'missing') return { installed: client }
  if (answer.version === client && answer.installed === answer.version) return null
  return { running: answer.version, ...(answer.installed !== null ? { installed: answer.installed } : {}) }
}

type Language = 'zh' | 'en'

/** The copy an older dictionary may lack (the same as locales.ts, which this chunk must not import). */
export const RUNTIME_FALLBACK: Readonly<Record<Language, Readonly<Record<string, string>>>> = {
  zh: {
    'runtime.restart': '影视工作台已更新：已安装 {installed}，正在运行 {running}。请重启 DeepSeek Harness / VibeDev，新版本才会生效；重启之前这里的页面无法使用。',
    'runtime.older': '更早的版本',
    'runtime.unknown': '未知版本',
    'runtime.retiredView': '这个标签已不再提供。',
  },
  en: {
    'runtime.restart': 'The film workbench was updated: {installed} is installed, {running} is running. Restart DeepSeek Harness / VibeDev for the new version to take effect; until then the pages here cannot be used.',
    'runtime.older': 'an earlier version',
    'runtime.unknown': 'an unknown version',
    'runtime.retiredView': 'This tab is no longer offered.',
  },
}

const fill = (text: string, params: Readonly<Record<string, string>> = {}): string =>
  text.replace(/\{(\w+)\}/gu, (whole, name: string) => params[name] ?? whole)

/** The page's language, for the fallback copy. */
function pageLanguage(): Language {
  const lang = typeof document !== 'undefined' ? document.documentElement?.lang : undefined
  const preferred = lang !== undefined && lang !== '' ? lang : typeof navigator !== 'undefined' ? navigator.language : ''
  return preferred.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Translate one of the runtime keys, falling back to the built-in copy when
 * the dictionary in memory does not have it (its translate function echoes the key).
 * @param t - the bound translate function.
 * @param key - the key.
 * @param params - the placeholders.
 * @param language - the fallback's language; the page's when left out.
 * @returns the text.
 */
export function runtimeText(t: Translate, key: string, params?: Record<string, string>, language: Language = pageLanguage()): string {
  const text = t(key, params)
  if (text !== key && text !== '') return text
  return fill(RUNTIME_FALLBACK[language][key] ?? key, params)
}

/**
 * The banner's sentence.
 * @param t - the bound translate function.
 * @param notice - the notice.
 * @param language - the fallback's language; the page's when left out.
 * @returns the text.
 */
export function restartText(t: Translate, notice: RestartNotice, language: Language = pageLanguage()): string {
  return runtimeText(t, 'runtime.restart', {
    installed: notice.installed ?? runtimeText(t, 'runtime.unknown', undefined, language),
    running: notice.running ?? runtimeText(t, 'runtime.older', undefined, language),
  }, language)
}

/** How often the route is asked at most, in milliseconds. */
export const RUNTIME_PROBE_INTERVAL_MS = 30_000

/**
 * Ask the runtime route.
 * @returns what it answered.
 */
export async function probeRuntime(): Promise<RuntimeProbe> {
  try {
    const response = await fetch(new URL('api/dsh-film/runtime', document.baseURI), { credentials: 'same-origin', cache: 'no-store' })
    if (response.status === 404) return { status: 'missing' }
    if (!response.ok) return { status: 'unreachable' }
    const body = await response.json() as { version?: unknown; installed?: unknown } | null
    if (typeof body?.version !== 'string') return { status: 'unreachable' }
    return { status: 'ok', version: body.version, installed: typeof body.installed === 'string' ? body.installed : null }
  } catch {
    return { status: 'unreachable' }
  }
}

/** The last answer, shared by every tab of this window. */
let last: { at: number; notice: RestartNotice | null } | undefined
let pending: Promise<RestartNotice | null> | undefined

/** The notice, asking the route again only when the last answer is older than the interval. */
function currentNotice(now: number): Promise<RestartNotice | null> {
  if (last !== undefined && now - last.at < RUNTIME_PROBE_INTERVAL_MS) return Promise.resolve(last.notice)
  pending ??= probeRuntime()
    .then((answer) => {
      const notice = restartNotice(CLIENT_VERSION, answer)
      last = { at: Date.now(), notice }
      return notice
    })
    .finally(() => { pending = undefined })
  return pending
}

/**
 * The restart notice for a tab: asked when the tab mounts and whenever it
 * comes back on screen, at most every {@link RUNTIME_PROBE_INTERVAL_MS}.
 * @param visible - whether the tab is on screen.
 * @returns the notice, or `null`.
 */
export function useRestartNotice(visible: boolean): RestartNotice | null {
  const [notice, setNotice] = useState<RestartNotice | null>(last?.notice ?? null)
  const mounted = useRef(false)
  useEffect(() => {
    const first = !mounted.current
    mounted.current = true
    if (!first && !visible) return
    let live = true
    void currentNotice(Date.now()).then((next) => { if (live) setNotice(next) })
    return () => { live = false }
  }, [visible])
  return notice
}
