/**
 * Stand-ins for the caption runner's windows and page: a window is an event
 * stream opened on the real events route; a page claims, reports and posts
 * through the real Host routes, as `apps/editor/caption-runner.html` does.
 */

import { createHash } from 'node:crypto'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { EditorModels } from '../../src/models/service.js'
import type { EditorModelManifest } from '../../src/models/service.js'

/** One window's event stream. */
export interface RunnerWindow {
  runnerId: string
  events: Array<{ event: string; data: any }>
  /** Wait for the next event of a kind (one not yet taken). */
  next(event: string, timeoutMs?: number): Promise<any>
  close(): void
}

const routeOf = (routes: readonly ConnectionFetchRoute[], name: string): ConnectionFetchRoute => {
  const route = routes.find(candidate => candidate.path.endsWith(`/caption-runner/${name}`))
  if (route === undefined) throw new Error(`no route ${name}`)
  return route
}

/**
 * Open a window on the runner's events route.
 * @param routes - the runner routes.
 * @returns the window once its hello has arrived.
 */
export async function openWindow(routes: readonly ConnectionFetchRoute[]): Promise<RunnerWindow> {
  const controller = new AbortController()
  const response = await routeOf(routes, 'events').fetch(new Request('http://host/api/dsh-film/caption-runner/events', { signal: controller.signal }))
  const reader = response.body!.getReader()
  const events: Array<{ event: string; data: any }> = []
  const taken = new Set<number>()
  const waiters: Array<() => void> = []
  let buffer = ''
  void (async () => {
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = /^event: (.*)$/m.exec(block)?.[1]
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (event !== undefined && data !== undefined) events.push({ event, data: JSON.parse(data) })
        for (const wake of waiters.splice(0)) wake()
      }
    }
  })()
  const next = async (event: string, timeoutMs = 2000): Promise<any> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = events.findIndex((item, at) => item.event === event && !taken.has(at))
      if (index !== -1) {
        taken.add(index)
        return events[index]!.data
      }
      if (Date.now() > deadline) throw new Error(`no ${event} event`)
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, 20)
      })
    }
  }
  const hello = await next('hello')
  return { runnerId: hello.runnerId, events, next, close: () => { controller.abort() } }
}

/**
 * Post JSON to a runner route.
 * @returns the status and the parsed answer.
 */
export async function post(routes: readonly ConnectionFetchRoute[], name: 'claim' | 'progress' | 'result', body: unknown): Promise<{ status: number; body: any }> {
  const response = await routeOf(routes, name).fetch(new Request(`http://host/api/dsh-film/caption-runner/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: response.status, body: await response.json() }
}

/** GET a source URL a claim answered. */
export async function getSource(routes: readonly ConnectionFetchRoute[], url: string, headers: Record<string, string> = {}): Promise<Response> {
  return routeOf(routes, 'source').fetch(new Request(new URL(url, 'http://host'), { headers }))
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Tiny stand-ins for the two recognition models, served by a fake mirror. */
export function captionModels(root: string): EditorModels {
  const files: Record<string, Uint8Array> = {}
  const model = (id: string, artifactIds: string[]): EditorModelManifest => ({
    id, label: id === 'silero-vad' ? 'Silero VAD' : 'Whisper Small q8', capability: id === 'silero-vad' ? 'vad' : 'transcribe', revision: 'abc1234',
    license: { name: 'MIT' },
    artifacts: artifactIds.map((artifactId) => {
      const bytes = new TextEncoder().encode(`${id}/${artifactId}`)
      const source = `https://vibedev.jzsaas.com/video-editor-models/${id}/abc1234/${artifactId}`
      files[source] = bytes
      return { id: artifactId, fileName: `${artifactId}.bin`, bytes: bytes.byteLength, sha256: sha256(bytes), sources: [source] }
    }),
  })
  const fetch = (async (input: string | URL | Request) => {
    const bytes = files[String(input)]
    return bytes === undefined ? new Response('missing', { status: 404 }) : new Response(bytes.slice(), { headers: { 'content-length': String(bytes.byteLength) } })
  }) as typeof globalThis.fetch
  return new EditorModels({ root, fetch, manifests: [model('whisper-small-q8', ['config', 'encoder-q8']), model('silero-vad', ['speech-vad'])] })
}
