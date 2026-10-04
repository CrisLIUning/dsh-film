/** The window's caption runner: hidden frames mounted, handed over and removed as the Host's events say (stubbed DOM and EventSource). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeEventSource {
  static last: FakeEventSource | undefined
  static opened = 0
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>()
  closed = false
  /** OPEN; the browser sets CONNECTING (0) while it reconnects, CLOSED (2) once it gives up. */
  readyState = 1
  constructor(readonly url: URL, readonly init: unknown) {
    FakeEventSource.last = this
    FakeEventSource.opened += 1
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
  FakeEventSource.opened = 0
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

  it('takes the runner page\'s finish message, in each of its states', async () => {
    const stop = (await runner()).startCaptionRunner()
    const source = FakeEventSource.last!
    source.emit('hello', { runnerId: 'r1' })
    const states = ['done', 'failed', 'cancelled', 'refused']
    for (const [index, state] of states.entries()) {
      source.emit('job', { jobId: `j${index}` })
      for (const listener of messageListeners) listener({ origin: 'http://host', source: frames[index]!.contentWindow, data: { type: 'caption-runner', jobId: `j${index}`, state } })
      expect(frames[index]!.removed).toBe(true)
    }
    // Not a finish: an unknown state, or another frame's message.
    source.emit('job', { jobId: 'j9' })
    const frame = frames.at(-1)!
    for (const listener of messageListeners) listener({ origin: 'http://host', source: frame.contentWindow, data: { type: 'caption-runner', jobId: 'j9', state: 'working' } })
    for (const listener of messageListeners) listener({ origin: 'http://host', source: frames[0]!.contentWindow, data: { type: 'caption-runner', jobId: 'j9', state: 'done' } })
    expect(frame.removed).toBe(false)
    stop()
  })

  it('opens a new stream after a pause when the browser gives up reconnecting (the plugin restarted)', async () => {
    const stop = (await runner()).startCaptionRunner()
    const first = FakeEventSource.last!
    first.emit('hello', { runnerId: 'r1' })
    // The Host ended the stream: the browser reconnects on its own while CONNECTING.
    first.readyState = 0
    first.emit('error', {})
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.opened).toBe(1)
    // The route was briefly gone and answered with an error: the browser stops for good.
    first.readyState = 2
    first.emit('error', {})
    expect(first.closed).toBe(true)
    vi.advanceTimersByTime(1_999)
    expect(FakeEventSource.opened).toBe(1)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.opened).toBe(2)
    const second = FakeEventSource.last!
    expect(String(second.url)).toBe('http://host/base/api/dsh-film/caption-runner/events')
    // The new hub's jobs reach this window again.
    second.emit('hello', { runnerId: 'r2' })
    second.emit('job', { jobId: 'next' })
    expect(Object.fromEntries(new URL(frames.at(-1)!.src).searchParams)).toEqual({ job: 'next', runner: 'r2' })
    // A failure again waits longer; stopping cancels the pending reconnect.
    second.readyState = 2
    second.emit('error', {})
    stop()
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.opened).toBe(2)
    expect(second.closed).toBe(true)
  })
})
