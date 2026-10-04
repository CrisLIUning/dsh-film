/**
 * Server-sent event streams over the Host's API channel, for the daemon's
 * event routes the hosted apps subscribe to.
 * @module dsh-film/studio/sse
 */

/** One open event stream. */
export interface EventStream {
  /** Send one event; returns false once the stream has closed. */
  send(event: string, data: unknown): boolean
  close(): void
  readonly closed: boolean
}

const encoder = new TextEncoder()

/**
 * Open an event stream answering `request`.
 * @param request - the subscribing request; the stream closes when it aborts.
 * @param start - called with the stream once it is open; may return a cleanup.
 * @param pingMs - keep-alive interval.
 * @returns the streaming response.
 */
export function eventStream(request: Request, start: (stream: EventStream) => void | (() => void), pingMs = 15_000): Response {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  let cleanup: (() => void) | void
  let ping: ReturnType<typeof setInterval> | undefined
  const close = (): void => {
    if (closed) return
    closed = true
    if (ping !== undefined) clearInterval(ping)
    request.signal.removeEventListener('abort', close)
    try {
      cleanup?.()
    } finally {
      try {
        controller.close()
      } catch {
        // Already closed by the reader.
      }
    }
  }
  const stream: EventStream = {
    send(event, data) {
      if (closed) return false
      try {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        return true
      } catch {
        close()
        return false
      }
    },
    close,
    get closed() { return closed },
  }
  const body = new ReadableStream<Uint8Array>({
    start(created) {
      controller = created
    },
    cancel() {
      close()
    },
  })
  request.signal.addEventListener('abort', close, { once: true })
  queueMicrotask(() => {
    if (closed) return
    cleanup = start(stream)
    if (closed) {
      // Closed while starting: nothing to keep alive, and the cleanup it returned is still owed.
      cleanup?.()
      return
    }
    ping = setInterval(() => { stream.send('ping', {}) }, pingMs)
  })
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
