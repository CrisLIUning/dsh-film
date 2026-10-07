/**
 * Serving one file from disk: the byte range the client asked for (so media can
 * be scrubbed, and so a player can reach a trailing `moov`), a validator for
 * cheap revalidation, and a streamed body that stops when the client goes away.
 *
 * A range response carries exactly the bytes the request named — no server-side
 * chunking. Memory stays bounded and a lost client stops the read because the
 * body is a file stream, not a buffer; capping the bytes instead would hand a
 * player a truncated file it cannot demux.
 * @module dsh-film/files
 */

import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/**
 * Read a `Range` header against a file size.
 * @param header - the request's `Range` header.
 * @param size - the file size in bytes.
 * @returns the inclusive byte range to send, `'unsatisfiable'` for a range
 *   past the end, or `undefined` to send the whole file (no header, or one
 *   this server does not serve: several ranges or a malformed one).
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (header === null) return undefined
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (match === null) return undefined
  const [, first = '', last = ''] = match
  let start: number
  let end: number
  if (first === '') {
    if (last === '') return undefined
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(first)
    if (last !== '' && Number(last) < start) return undefined
    if (start >= size) return 'unsatisfiable'
    end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  }
  return { start, end }
}

/** What {@link serveFile} needs to know about the file. */
export interface ServedFile {
  path: string
  size: number
  modified: Date
  type: string
  /** Extra response headers (caching, content security). */
  headers?: Readonly<Record<string, string>>
}

/**
 * The weak validator of a file version: size and modification time.
 * @param size - the file size.
 * @param modified - the modification time.
 * @returns the ETag value.
 */
export function weakTag(size: number, modified: Date): string {
  return `W/"${size.toString(36)}-${Math.trunc(modified.getTime()).toString(36)}"`
}

/**
 * Answer a GET or HEAD for one file, honouring `If-None-Match` and a single
 * byte range.
 * @param request - the request.
 * @param file - the file and how to describe it.
 * @returns the response.
 */
export function serveFile(request: Request, file: ServedFile): Response {
  const { path, size, modified, type } = file
  const tag = weakTag(size, modified)
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    ...file.headers,
    'Content-Type': type,
    'Last-Modified': modified.toUTCString(),
    ETag: tag,
  }
  const known = request.headers.get('if-none-match')
  if (known !== null && known.split(',').some(value => value.trim() === tag)) {
    return new Response(null, { status: 304, headers })
  }
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = size === 0 ? 0 : end - start + 1
  headers['Content-Length'] = String(length)
  if (range !== undefined) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  const status = range === undefined ? 200 : 206
  if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers })
  const stream = createReadStream(path, { start, end })
  const stop = (): void => { stream.destroy() }
  request.signal.addEventListener('abort', stop, { once: true })
  stream.once('close', () => { request.signal.removeEventListener('abort', stop) })
  const body = Readable.toWeb(stream) as WebReadableStream<Uint8Array>
  return new Response(body as unknown as ReadableStream<Uint8Array>, { status, headers })
}
