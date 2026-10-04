/** The restart notice: when a workbench page asks for a restart, and the copy it shows. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, zh } from '../../src/client/locales.ts'
import { CLIENT_VERSION, RUNTIME_FALLBACK, probeRuntime, restartNotice, restartText, runtimeText } from '../../src/client/workbench/runtime-notice.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('restartNotice', () => {
  it('asks for a restart when the Host predates the route (404)', () => {
    expect(restartNotice('0.2.0', { status: 'missing' })).toEqual({ installed: '0.2.0' })
  })

  it('says nothing when the Host could not be asked', () => {
    expect(restartNotice('0.2.0', { status: 'unreachable' })).toBeNull()
  })

  it('says nothing when the page, the Host and the installed package agree', () => {
    expect(restartNotice('0.2.0', { status: 'ok', version: '0.2.0', installed: '0.2.0' })).toBeNull()
  })

  it('asks for a restart when another version was installed over the running one', () => {
    expect(restartNotice('0.1.2', { status: 'ok', version: '0.1.2', installed: '0.2.0' })).toEqual({ running: '0.1.2', installed: '0.2.0' })
  })

  it('asks for a restart when the Host runs another version than the page was built as', () => {
    expect(restartNotice('0.2.0', { status: 'ok', version: '0.1.2', installed: '0.2.0' })).toEqual({ running: '0.1.2', installed: '0.2.0' })
  })

  it('asks for a restart when nothing is installed beside the running code', () => {
    expect(restartNotice('0.2.0', { status: 'ok', version: '0.2.0', installed: null })).toEqual({ running: '0.2.0' })
  })

  it('reads the build constant only where a bundle defines it', () => {
    expect(CLIENT_VERSION).toBe('dev')
  })
})

describe('restartText', () => {
  const dictionary = (entries: Record<string, string>) => (key: string, params?: Record<string, string | number>) =>
    (entries[key] ?? key).replace(/\{(\w+)\}/gu, (whole, name: string) => String(params?.[name] ?? whole))

  it('uses the dictionary when it has the keys', () => {
    const t = dictionary(zh)
    expect(restartText(t, { running: '0.1.2', installed: '0.2.0' }, 'en')).toBe(zh['runtime.restart'].replace('{installed}', '0.2.0').replace('{running}', '0.1.2'))
    expect(restartText(t, { installed: '0.2.0' }, 'en')).toContain('已安装 0.2.0，但正在运行的还是更早的版本。')
    expect(restartText(t, { running: '0.2.0' }, 'en')).toContain('已安装 未知版本')
  })

  it('falls back to its own copy when the dictionary in memory echoes the key', () => {
    const echo = (key: string) => key
    expect(restartText(echo, { running: '0.1.2', installed: '0.2.0' }, 'zh')).toBe('影视工作台已更新：已安装 0.2.0，正在运行 0.1.2。请重启 DeepSeek Harness / VibeDev，新版本才会生效；重启之前这里的页面无法使用。')
    expect(restartText(echo, { installed: '0.2.0' }, 'en')).toBe('The film workbench was updated: 0.2.0 is installed, but an earlier version is still running. Restart DeepSeek Harness / VibeDev for the new version to take effect; until then the pages here cannot be used.')
    expect(runtimeText(echo, 'runtime.retiredView', undefined, 'zh')).toBe('这个标签已不再提供。')
  })

  it('keeps the fallback the same as the dictionaries', () => {
    for (const key of Object.keys(RUNTIME_FALLBACK.zh)) {
      expect(RUNTIME_FALLBACK.zh[key]).toBe(zh[key as keyof typeof zh])
      expect(RUNTIME_FALLBACK.en[key]).toBe(en[key as keyof typeof en])
    }
    expect(zh['tab.loadFailed']).toContain('如果刚更新过影视工作台，请先重启 DeepSeek Harness / VibeDev')
    expect(en['tab.loadFailed']).toContain('restart DeepSeek Harness / VibeDev')
  })
})

describe('probeRuntime', () => {
  const answering = (response: Response | Error) => {
    const fetch = vi.fn(async () => { if (response instanceof Error) throw response; return response })
    vi.stubGlobal('document', { baseURI: 'http://host/base/' })
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('asks the route under the document base, never from a cache', async () => {
    const fetch = answering(new Response(JSON.stringify({ version: '0.2.0', installed: null }), { status: 200 }))
    expect(await probeRuntime()).toEqual({ status: 'ok', version: '0.2.0', installed: null })
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe('http://host/base/api/dsh-film/runtime')
    expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
  })

  it('tells a missing route from failures', async () => {
    answering(new Response('{}', { status: 404 }))
    expect(await probeRuntime()).toEqual({ status: 'missing' })
    answering(new Response('{}', { status: 502 }))
    expect(await probeRuntime()).toEqual({ status: 'unreachable' })
    answering(new TypeError('Failed to fetch'))
    expect(await probeRuntime()).toEqual({ status: 'unreachable' })
  })
})
