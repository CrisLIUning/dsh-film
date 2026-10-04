/** The window's caption runner: hidden frames mounted, handed over and removed as the Host's events say (stubbed DOM and EventSource). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeEventSource {
  static last: FakeEventSource | undefined
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>()
  closed = false
  constructor(readonly url: URL, readonly init: unknown) {
    FakeEventSource.last = this
  }
  addEventListener(name: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], listener])
  }
  emit(name: string, data: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) })
  }
  close(): void {
    this.closed = true
  }
}

interface FakeFrame {
  src: string
  title: string
  tabIndex: number
  style: { cssText: string }
  attributes: Record<string, string>
  removed: boolean
  contentWindow: { postMessage: ReturnType<typeof vi.fn> }
  setAttribute(name: string, value: string): void
  remove(): void
}

let frames: FakeFrame[]
let messageListeners: Array<(event: unknown) => void>

beforeEach(() => {
  frames = []
  messageListeners = []
  vi.useFakeTimers()
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('location', { origin: 'http://host' })
  vi.stubGlobal('window', {
    addEventListener: (name: string, listener: (event: unknown) => void) => { if (name === 'message') messageListeners.push(listener) },
    removeEventListener: (name: string, listener: (event: unknown) => void) => { messageListeners = messageListeners.filter(item => item !== listener) },
  })
  vi.stubGlobal('document', {
    baseURI: 'http://host/base/',
    body: { appendChild: (frame: FakeFrame) => { frames.push(frame) } },
    createElement: (): FakeFrame => {
      const frame: FakeFrame = {
        src: '', title: '', tabIndex: 0, style: { cssText: '' }, attributes: {}, removed: false,
        contentWindow: { postMessage: vi.fn() },
        setAttribute(name, value) { this.attributes[name] = value },
        remove() { this.removed = true },
      }
      return frame
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const runner = () => import('../../src/client/caption-runner.ts')

describe('caption runner (client)', () => {
  it('mounts a hidden frame per offered job and removes it when another window claims it or the job ends', async () => {
    const stop = (await runner()).startCaptionRunner()
    const source = FakeEventSource.last!
    expect(String(source.url)).toBe('http://host/base/api/dsh-film/caption-runner/events')
    source.emit('job', { jobId: 'early', kind: 'whisper' })
    // Nothing before the Host has named this window.
    expect(frames).toHaveLength(0)
    source.emit('hello', { runnerId: 'r1' })
    source.emit('job', { jobId: 'j1', kind: 'whisper' })
    source.emit('job', { jobId: 'j1', kind: 'whisper' })
    expect(frames).toHaveLength(1)
    const url = new URL(frames[0]!.src)
    expect(url.pathname).toBe('/base/api/dsh-film/apps/editor/caption-runner.html')
    expect(Object.fromEntries(url.searchParams)).toEqual({ job: 'j1', runner: 'r1' })
    expect(frames[0]!.style.cssText).toContain('visibility:hidden')
    source.emit('claimed', { jobId: 'j1', runnerId: 'r1' })
    expect(frames[0]!.removed).toBe(false)
    source.emit('done', { jobId: 'j1' })
    expect(frames[0]!.removed).toBe(true)
    source.emit('job', { jobId: 'j2', kind: 'extract' })
    source.emit('claimed', { jobId: 'j2', runnerId: 'someone-else' })
    expect(frames[1]!.removed).toBe(true)
    stop()
    expect(source.closed).toBe(true)
  })

  it('forwards a cancel to the frame and removes it after a grace period; the page may also say it is done', async () => {
    const stop = (await runner()).startCaptionRunner()
    const source = FakeEventSource.last!
    source.emit('hello', { runnerId: 'r1' })
    source.emit('job', { jobId: 'j1' })
    source.emit('cancel', { jobId: 'j1' })
    expect(frames[0]!.contentWindow.postMessage).toHaveBeenCalledWith({ type: 'cancel', jobId: 'j1' }, 'http://host')
    expect(frames[0]!.removed).toBe(false)
    vi.advanceTimersByTime(2000)
    expect(frames[0]!.removed).toBe(true)
    source.emit('job', { jobId: 'j2' })
    // A message from elsewhere is ignored; the frame's own is not.
    for (const listener of messageListeners) listener({ origin: 'http://evil', source: frames[1]!.contentWindow, data: { type: 'done', jobId: 'j2' } })
    expect(frames[1]!.removed).toBe(false)
    for (const listener of messageListeners) listener({ origin: 'http://host', source: frames[1]!.contentWindow, data: { type: 'done', jobId: 'j2' } })
    expect(frames[1]!.removed).toBe(true)
    // A reconnect is a new runner: frames of the old one go.
    source.emit('job', { jobId: 'j3' })
    source.emit('hello', { runnerId: 'r2' })
    expect(frames[2]!.removed).toBe(true)
    stop()
    expect(messageListeners).toHaveLength(0)
  })
})
