/**
 * Downloading one file whose size and SHA-256 are known before it is fetched.
 * Each source is tried in turn; the bytes land in a temporary file beside the
 * target and are renamed into place only when both the size and the digest
 * match. Ported from Studio's `verified-download.ts`, with a stall watchdog:
 * a source that sends nothing for a while is dropped for the next one.
 * @module dsh-film/models/download
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** How long a source may send nothing before the next one is tried. */
export const STALL_TIMEOUT_MS = 60_000

export interface VerifiedDownloadOptions {
  sources: readonly string[]
  bytes: number
  sha256: string
  target: string
  signal: AbortSignal
  fetch: typeof fetch
  /** The final URL (after redirects) must be one this accepts. */
  isTrustedUrl: (url: URL) => boolean
  randomUUID: () => string
  onBytes?: (loaded: number) => void
  /** How long a source may stay silent; {@link STALL_TIMEOUT_MS} by default. */
  stallTimeoutMs?: number
}

/** Thrown when no source produced the expected bytes; an abort rethrows the abort instead. */
export class VerifiedDownloadFailure extends Error {
  override name = 'VerifiedDownloadFailure'

  constructor(
    /** A source answered with bytes of the wrong length or digest. */
    readonly integrityFailure: boolean,
    readonly lastError: unknown,
  ) {
    super(lastError instanceof Error ? lastError.message : 'no source was available')
  }
}

/** An abort error for a signal, keeping the signal's own reason when it is one. */
export function abortErrorOf(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === 'AbortError'
    ? signal.reason
    : new DOMException('The download was canceled.', 'AbortError')
}

/**
 * Download a file and verify it.
 * @param options - the file, its sources and how to fetch them.
 * @throws an `AbortError` when the signal aborts, or a
 *   {@link VerifiedDownloadFailure} when no source produced the file.
 */
export async function downloadVerifiedFile(options: VerifiedDownloadOptions): Promise<void> {
  const { signal } = options
  const stallTimeoutMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS
  let integrityFailure = false
  let lastError: unknown = null
  for (const source of options.sources) {
    if (signal.aborted) throw abortErrorOf(signal)
    const temporary = `${options.target}.part-${options.randomUUID()}`
    // One source's attempt: aborted by the caller, or by the watchdog when it goes quiet.
    const attempt = new AbortController()
    const forward = (): void => { attempt.abort(signal.reason) }
    signal.addEventListener('abort', forward, { once: true })
    let stalled = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const quiet = (): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        stalled = true
        attempt.abort(new Error(`no data for ${Math.round(stallTimeoutMs / 1000)} s`))
      }, stallTimeoutMs)
    }
    try {
      quiet()
      const response = await options.fetch(source, { signal: attempt.signal, redirect: 'follow' })
      if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
      if (response.url !== '') {
        const finalUrl = new URL(response.url)
        if (!options.isTrustedUrl(finalUrl)) throw new Error(`redirected to an untrusted host: ${finalUrl.hostname}`)
      }
      const declared = Number(response.headers.get('content-length')) || 0
      if (declared !== 0 && declared !== options.bytes) {
        integrityFailure = true
        throw new Error(`content length ${declared}, expected ${options.bytes}`)
      }
      const hash = createHash('sha256')
      let loaded = 0
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          quiet()
          loaded += chunk.byteLength
          if (loaded > options.bytes) {
            callback(new Error(`more than the declared ${options.bytes} bytes`))
            return
          }
          hash.update(chunk)
          options.onBytes?.(loaded)
          callback(null, chunk)
        },
      })
      await pipeline(
        Readable.fromWeb(response.body as never),
        counter,
        createWriteStream(temporary, { flags: 'wx' }),
        { signal: attempt.signal },
      )
      const digest = hash.digest('hex')
      if (loaded !== options.bytes || digest !== options.sha256) {
        integrityFailure = true
        throw new Error(`integrity mismatch: ${loaded} bytes, sha256 ${digest}`)
      }
      await rename(temporary, options.target)
      return
    } catch (error) {
      lastError = stalled ? attempt.signal.reason : error
      await rm(temporary, { force: true }).catch(() => {})
      if (signal.aborted) throw abortErrorOf(signal)
    } finally {
      clearTimeout(watchdog)
      signal.removeEventListener('abort', forward)
    }
  }
  throw new VerifiedDownloadFailure(integrityFailure, lastError)
}
