import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilmError } from '../src/errors.js'
import { RANGE_CHUNK, listAssets, mediaTypeOf, parseRange, serveMedia } from '../src/media.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-media-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const bytes = (count: number): Uint8Array => Uint8Array.from({ length: count }, (_, index) => index % 251)

async function file(relative: string, content: Uint8Array | string, modified?: Date): Promise<string> {
  const path = join(cwd, ...relative.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  if (modified !== undefined) await utimes(path, modified, modified)
  return path
}

const request = (path: string, init: RequestInit = {}): Request =>
  new Request(`http://host/api/dsh-film/media?path=${encodeURIComponent(path)}`, init)

describe('mediaTypeOf', () => {
  it('knows media by extension, in any case', () => {
    expect(mediaTypeOf('a/B.MP4')).toEqual({ kind: 'video', type: 'video/mp4' })
    expect(mediaTypeOf('x.wav')).toEqual({ kind: 'audio', type: 'audio/wav' })
    expect(mediaTypeOf('x.txt')).toBeUndefined()
  })
})

describe('parseRange', () => {
  it('reads the three single-range forms', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=10-5000', 1000)).toEqual({ start: 10, end: 999 })
  })

  it('serves the whole file for no header and for forms it does not serve', () => {
    expect(parseRange(null, 1000)).toBeUndefined()
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeUndefined()
    expect(parseRange('items=0-1', 1000)).toBeUndefined()
    expect(parseRange('bytes=50-10', 1000)).toBeUndefined()
    expect(parseRange('bytes=-', 1000)).toBeUndefined()
  })

  it('refuses ranges past the end', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })

  it('caps one response at RANGE_CHUNK bytes', () => {
    expect(parseRange('bytes=0-', 100 * RANGE_CHUNK)).toEqual({ start: 0, end: RANGE_CHUNK - 1 })
    expect(parseRange('bytes=5-', 100 * RANGE_CHUNK)).toEqual({ start: 5, end: RANGE_CHUNK + 4 })
  })
})

describe('serveMedia', () => {
  it('serves the whole file with its type and range support', async () => {
    const content = bytes(1000)
    const response = await serveMedia(request(await file('media/a.mp4', content)))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-length')).toBe('1000')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(content)
  })

  it('serves a byte range as 206 with Content-Range', async () => {
    const content = bytes(1000)
    const path = await file('media/a.mp4', content)
    const response = await serveMedia(request(path, { headers: { range: 'bytes=100-199' } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(response.headers.get('content-length')).toBe('100')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(content.slice(100, 200))
  })

  it('answers a range past the end with 416', async () => {
    const path = await file('media/a.mp4', bytes(10))
    const response = await serveMedia(request(path, { headers: { range: 'bytes=10-' } }))
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
  })

  it('answers HEAD with the headers only', async () => {
    const path = await file('media/a.wav', bytes(64))
    const response = await serveMedia(request(path, { method: 'HEAD' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('64')
    expect(response.body).toBeNull()
  })

  it('serves an empty file without a body', async () => {
    const response = await serveMedia(request(await file('media/empty.mp3', new Uint8Array())))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('0')
  })

  it('refuses files that are not media, missing files and relative paths', async () => {
    const code = async (input: Request): Promise<string | undefined> => {
      try {
        await serveMedia(input)
        return undefined
      } catch (error) {
        return (error as FilmError).code
      }
    }
    expect(await code(request(await file('notes.txt', 'secret')))).toBe('NOT_MEDIA')
    expect(await code(request(join(cwd, 'missing.mp4')))).toBe('FILE_NOT_FOUND')
    expect(await code(request('media/a.mp4'))).toBe('BAD_REQUEST')
    await mkdir(join(cwd, 'folder.mp4'))
    expect(await code(request(join(cwd, 'folder.mp4')))).toBe('FILE_NOT_FOUND')
  })
})

describe('listAssets', () => {
  it('lists media under media/ and film/, newest first', async () => {
    await file('media/images/old.png', 'p', new Date('2026-10-01T00:00:00Z'))
    await file('media/videos/new.mp4', 'v', new Date('2026-10-03T00:00:00Z'))
    await file('film/media/voice.wav', 'a', new Date('2026-10-02T00:00:00Z'))
    await file('film/film.json', '{}')
    await file('media/.cache/hidden.png', 'h')
    await file('media/node_modules/pkg/logo.png', 'n')
    await file('other/outside.mp4', 'o')
    const { assets, truncated } = await listAssets(cwd)
    expect(truncated).toBe(false)
    expect(assets.map(asset => [asset.path, asset.kind, asset.bytes])).toEqual([
      ['media/videos/new.mp4', 'video', 1],
      ['film/media/voice.wav', 'audio', 1],
      ['media/images/old.png', 'image', 1],
    ])
  })

  it('stops at the limit and says so', async () => {
    for (let index = 0; index < 5; index++) await file(`media/${index}.png`, 'p')
    const { assets, truncated } = await listAssets(cwd, 3)
    expect(assets).toHaveLength(3)
    expect(truncated).toBe(true)
  })

  it('returns nothing for a workspace without media folders', async () => {
    expect(await listAssets(cwd)).toEqual({ assets: [], truncated: false })
  })
})
