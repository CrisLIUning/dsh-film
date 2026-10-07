import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilmError } from '../src/errors.js'
import { parseRange } from '../src/files.js'
import {
  WORKSPACE_CACHE_MS, WORKSPACE_MEDIA_DEPTH, WORKSPACE_MODEL_LIMIT, WorkspaceMediaError, checkWorkspaceFilePath, checkWorkspaceMediaPath, entryKind, invalidateWorkspaceMedia,
  isSkippedDirName, listWorkspaceMedia, mediaTypeOf, resolveWorkspaceFile, resolveWorkspaceMedia, scanWorkspaceMedia, serveMedia,
  workspaceMediaUrl, workspaceModelTypeOf,
} from '../src/media.js'
import { ProjectEvents } from '../src/studio/events.js'

let cwd: string
let outside: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-media-'))
  outside = await mkdtemp(join(tmpdir(), 'dsh-film-outside-'))
  invalidateWorkspaceMedia()
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const bytes = (count: number): Uint8Array => Uint8Array.from({ length: count }, (_, index) => index % 251)

/** Write a workspace file; returns its workspace-relative path. */
async function file(relative: string, content: Uint8Array | string = 'x', modified?: Date): Promise<string> {
  const path = join(cwd, ...relative.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  if (modified !== undefined) await utimes(path, modified, modified)
  return relative
}

const request = (path: string, init: RequestInit = {}, workspace: string = cwd): Request =>
  new Request(`http://host/api/dsh-film/media?${new URLSearchParams({ cwd: workspace, path }).toString()}`, init)

const paths = (files: ReadonlyArray<{ path: string }>): string[] => files.map(entry => entry.path)

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

  it('satisfies every single-range form in full, however large the file is', () => {
    // A server that capped a response broke a player demuxing the file: what a range names is what the client gets.
    const big = 12 * 1024 * 1024
    expect(parseRange('bytes=0-', big)).toEqual({ start: 0, end: big - 1 })
    expect(parseRange('bytes=5-', big)).toEqual({ start: 5, end: big - 1 })
    expect(parseRange('bytes=-1024', big)).toEqual({ start: big - 1024, end: big - 1 })
    expect(parseRange(`bytes=0-${big + 1024}`, big)).toEqual({ start: 0, end: big - 1 })
  })
})

describe('checkWorkspaceMediaPath', () => {
  const problem = (path: string): string | undefined => {
    try {
      checkWorkspaceMediaPath(path)
      return undefined
    } catch (error) {
      return (error as WorkspaceMediaError).problem
    }
  }

  it('accepts workspace-relative media paths, folding separators and a leading ./', () => {
    expect(checkWorkspaceMediaPath('media/a.png')).toBe('media/a.png')
    expect(checkWorkspaceMediaPath('.\\footage\\day 1\\take.MOV')).toBe('footage/day 1/take.MOV')
    expect(checkWorkspaceMediaPath('wt-take.mp4')).toBe('wt-take.mp4')
    expect(checkWorkspaceMediaPath('packages/logo.png')).toBe('packages/logo.png')
    expect(checkWorkspaceMediaPath('film/canvas/media/a.png')).toBe('film/canvas/media/a.png')
  })

  it('refuses absolute, NUL, empty, ".", ".." and hidden paths', () => {
    for (const path of ['', '/etc/a.png', 'C:\\Users\\a.png', 'C:a.png', '\\\\server\\share\\a.png', 'media/a\0.png', 'media//a.png', 'media/./a.png', 'media/../a.png', '../a.png', '.cache/a.png', 'media/.hidden.png']) {
      expect(problem(path), path).toBe('invalid')
    }
  })

  it('refuses ignored and credential folders, whatever their case or trailing dots', () => {
    for (const path of ['node_modules/pkg/a.png', 'Node_Modules/a.png', 'node_modules./a.png', 'app/dist/a.png', 'build/a.mp4', 'out/a.mp4', 'pack-20260101/a.mp4', 'wt-feature/a.png', 'DerivedData-x/a.png', '.ssh/a.png', 'x/.aws/a.png', 'a/.claude/worktrees/b.png', 'venv/a.png', '__pycache__/a.png']) {
      expect(problem(path), path).toBe('invalid')
    }
  })

  it('refuses what is not media', () => {
    expect(problem('notes.txt')).toBe('not-media')
    expect(problem('film/film.json')).toBe('not-media')
  })

  it('takes below film/ what the film\'s own listing takes: generated-looking folders yes, hidden ones and node_modules no', () => {
    expect(checkWorkspaceMediaPath('film/out/x.png')).toBe('film/out/x.png')
    expect(checkWorkspaceMediaPath('film/build/x.png')).toBe('film/build/x.png')
    expect(checkWorkspaceMediaPath('film/models/m/dist/capture.png')).toBe('film/models/m/dist/capture.png')
    for (const path of ['film/models/node_modules/x.png', 'film/.versions/x.png', 'film/.tasks/a.wav', 'out/x.png', 'media/build/x.png']) {
      expect(problem(path), path).toBe('invalid')
    }
  })
})

describe('resolveWorkspaceMedia', () => {
  it('finds a file, names the film\'s own by their film path, and refuses links out of the workspace', async () => {
    await file('footage/a.mp4', 'abc')
    expect(await resolveWorkspaceMedia(cwd, 'footage\\a.mp4')).toMatchObject({ path: 'footage/a.mp4', absolute: expect.stringContaining('a.mp4'), kind: 'video', type: 'video/mp4' })
    expect((await resolveWorkspaceMedia(cwd, 'footage/a.mp4')).filmPath).toBeUndefined()
    await file('film/canvas/media/b.png')
    expect(await resolveWorkspaceMedia(cwd, 'film/canvas/media/b.png')).toMatchObject({ path: 'film/canvas/media/b.png', filmPath: 'canvas/media/b.png' })
    await writeFile(join(outside, 'secret.png'), 'secret')
    await symlink(outside, join(cwd, 'linked'), 'junction')
    await expect(resolveWorkspaceMedia(cwd, 'linked/secret.png')).rejects.toMatchObject({ problem: 'invalid' })
    await expect(resolveWorkspaceMedia(cwd, 'footage/none.mp4')).rejects.toMatchObject({ problem: 'not-found' })
    await mkdir(join(cwd, 'folder.mp4'))
    await expect(resolveWorkspaceMedia(cwd, 'folder.mp4')).rejects.toMatchObject({ problem: 'not-found' })
  })

  it('takes GLB, FBX and OBJ models only when asked, and never a .gltf', async () => {
    await file('props/chair.glb', 'glTF')
    await file('props/lamp.gltf', '{}')
    await expect(resolveWorkspaceMedia(cwd, 'props/chair.glb')).rejects.toMatchObject({ problem: 'not-media' })
    expect(await resolveWorkspaceFile(cwd, 'props\\chair.glb', { models: true })).toMatchObject({ path: 'props/chair.glb', kind: 'model', format: 'glb', type: 'model/gltf-binary' })
    expect(checkWorkspaceFilePath('a/b.FBX', { models: true })).toBe('a/b.FBX')
    expect(checkWorkspaceFilePath('a/b.obj', { models: true })).toBe('a/b.obj')
    expect(checkWorkspaceFilePath('a/b.png', { models: true })).toBe('a/b.png')
    expect(() => checkWorkspaceFilePath('props/lamp.gltf', { models: true })).toThrow(/convert it to a GLB/u)
    expect(() => checkWorkspaceFilePath('node_modules/x/chair.glb', { models: true })).toThrow(WorkspaceMediaError)
    expect(() => checkWorkspaceFilePath('.hidden/chair.glb', { models: true })).toThrow(WorkspaceMediaError)
    expect(() => checkWorkspaceFilePath('a/b.txt', { models: true })).toThrow(/GLB, FBX, OBJ/u)
    expect(workspaceModelTypeOf('x.GLB')).toEqual({ format: 'glb', type: 'model/gltf-binary' })
    expect(workspaceModelTypeOf('x.gltf')).toBeUndefined()
  })

  it('spells the path as the file system does', async () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return
    await file('Footage/Take.mp4')
    expect((await resolveWorkspaceMedia(cwd, 'footage/take.mp4')).path).toBe('Footage/Take.mp4')
  })
})

/** Make a folder a film workspace (its project file). */
async function filmIn(workspace: string): Promise<void> {
  await mkdir(join(workspace, 'film'), { recursive: true })
  const project = { format: 'vibedev.film', version: 1, id: 'film-1', title: 'A', aspectRatio: '16:9', createdAt: 't', updatedAt: 't' }
  await writeFile(join(workspace, 'film', 'film.json'), JSON.stringify(project))
}

describe('serveMedia', () => {
  beforeEach(async () => {
    await filmIn(cwd)
  })

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
    const path = await file('footage/day1/a.mp4', content)
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

// A player asks for a range and demuxes what comes back, so a range over the old 8 MiB chunking
  // boundary has to arrive whole — including the open-ended first request and a trailing moov.
  describe('large media (over 8 MiB)', () => {
    const BIG = 9 * 1024 * 1024 // 9 MiB: over the 8 MiB an earlier server capped a response at
    /** The first and last `count` bytes of a body, and its length, without keeping the whole thing in memory. */
    async function edges(response: Response, count: number): Promise<{ length: number; first: Uint8Array; last: Uint8Array }> {
      const reader = response.body!.getReader()
      let first = new Uint8Array(0)
      let last = new Uint8Array(0)
      let length = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value as Uint8Array
        if (first.length < count) {
          const merged = new Uint8Array(Math.min(count, first.length + chunk.length))
          merged.set(first)
          merged.set(chunk.subarray(0, merged.length - first.length), first.length)
          first = merged
        }
        // Keep only a bounded tail, never the whole body.
        if (chunk.length >= count) last = chunk.slice(chunk.length - count)
        else if (last.length + chunk.length <= count) {
          const merged = new Uint8Array(last.length + chunk.length)
          merged.set(last)
          merged.set(chunk, last.length)
          last = merged
        } else {
          const keep = count - chunk.length
          const merged = new Uint8Array(count)
          merged.set(last.subarray(last.length - keep), 0)
          merged.set(chunk, keep)
          last = merged
        }
        length += chunk.length
      }
      return { length, first, last }
    }
    const tail = (content: Uint8Array, count: number): Uint8Array => content.slice(content.length - count)

    it('serves an open-ended range past 8 MiB in full, as a stream', async () => {
      const content = bytes(BIG)
      const path = await file('media/big.mp4', content)
      const response = await serveMedia(request(path, { headers: { range: 'bytes=0-' } }))
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe(`bytes 0-${BIG - 1}/${BIG}`)
      expect(response.headers.get('content-length')).toBe(String(BIG))
      expect(response.body).toBeInstanceOf(ReadableStream) // streamed, not a buffered blob
      const edge = await edges(response, 8)
      expect(edge.length).toBe(BIG)
      expect(edge.first).toEqual(content.slice(0, 8))
      expect(edge.last).toEqual(tail(content, 8))
    })

    it('serves a finite range that crosses the old 8 MiB boundary in full', async () => {
      const content = bytes(BIG)
      const path = await file('media/cross.mp4', content)
      const start = 8 * 1024 * 1024 - 200
      const end = 8 * 1024 * 1024 + 200
      const response = await serveMedia(request(path, { headers: { range: `bytes=${start}-${end}` } }))
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${BIG}`)
      expect(response.headers.get('content-length')).toBe(String(end - start + 1))
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(content.slice(start, end + 1))
    })

    it('serves a range that starts exactly at 8 MiB', async () => {
      const content = bytes(BIG)
      const path = await file('media/at.mp4', content)
      const start = 8 * 1024 * 1024
      const response = await serveMedia(request(path, { headers: { range: `bytes=${start}-${start + 92}` } }))
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${start + 92}/${BIG}`)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(content.slice(start, start + 93))
    })

    it('reaches the trailing bytes of a large file, where a moov can sit', async () => {
      const content = bytes(BIG)
      const path = await file('media/moov-last.mp4', content)
      const response = await serveMedia(request(path, { headers: { range: 'bytes=-1024' } }))
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe(`bytes ${BIG - 1024}-${BIG - 1}/${BIG}`)
      expect(response.headers.get('content-length')).toBe('1024')
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(tail(content, 1024))
    })

    it('answers HEAD for a large file with the range headers and no body', async () => {
      const content = bytes(BIG)
      const path = await file('media/head.mp4', content)
      const response = await serveMedia(request(path, { method: 'HEAD', headers: { range: 'bytes=0-' } }))
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe(`bytes 0-${BIG - 1}/${BIG}`)
      expect(response.headers.get('content-length')).toBe(String(BIG))
      expect(response.body).toBeNull()
      expect(await response.text()).toBe('')
    })

    it('stops the read when the client goes away: streaming is the bandwidth control, not a byte cap', async () => {
      const content = bytes(BIG)
      const path = await file('media/abort.mp4', content)
      const abort = new AbortController()
      const response = await serveMedia(request(path, { headers: { range: 'bytes=0-' }, signal: abort.signal }))
      expect(response.status).toBe(206)
      const reader = response.body!.getReader()
      let seen = 0
      const first = await reader.read()
      expect(first.done).toBe(false)
      seen += (first.value as Uint8Array).length
      abort.abort()
      // The read must stop here rather than draining the rest of the file into the void.
      const after = await reader.read().then((result) => (result.done ? 'closed' : 'data'), () => 'error')
      expect(['closed', 'error']).toContain(after)
      if (after === 'data') seen += (await reader.read().then((result) => (result.done ? 0 : (result.value as Uint8Array).length), () => 0))
      expect(seen).toBeLessThan(BIG)
    })
  })

  it('serves only media inside the workspace, by a path relative to it', async () => {
    const code = async (input: Request): Promise<string | undefined> => {
      try {
        await serveMedia(input)
        return undefined
      } catch (error) {
        return (error as FilmError).code
      }
    }
    await writeFile(join(outside, 'secret.png'), 'secret')
    // The old route served any absolute path it was given.
    expect(await code(request(join(outside, 'secret.png')))).toBe('BAD_REQUEST')
    expect(await code(request(join(cwd, await file('media/a.mp4'))))).toBe('BAD_REQUEST')
    expect(await code(request('../' + outside.split(/[\\/]/u).pop()! + '/secret.png'))).toBe('BAD_REQUEST')
    await symlink(outside, join(cwd, 'linked'), 'junction')
    expect(await code(request('linked/secret.png'))).toBe('BAD_REQUEST')
    expect(await code(request(await file('.private/a.png')))).toBe('BAD_REQUEST')
    expect(await code(request(await file('node_modules/pkg/a.png')))).toBe('BAD_REQUEST')
    expect(await code(request(await file('notes.txt', 'secret')))).toBe('NOT_MEDIA')
    expect(await code(request('missing.mp4'))).toBe('FILE_NOT_FOUND')
    await mkdir(join(cwd, 'folder.mp4'))
    expect(await code(request('folder.mp4'))).toBe('FILE_NOT_FOUND')
    expect(await code(new Request(`http://host/api/dsh-film/media?path=media%2Fa.mp4`))).toBe('BAD_REQUEST')
    expect(await code(request('media/a.mp4', {}, join(cwd, 'nope')))).toBe('WORKSPACE_NOT_FOUND')
    expect((await serveMedia(request(await file('film/canvas/media/b.png')))).status).toBe(200)
  })

  it('serves only a film workspace, and none inside a hidden or credential folder, whatever cwd the caller picks', async () => {
    const code = async (input: Request): Promise<string | undefined> => serveMedia(input).then(() => undefined, (error: unknown) => (error as FilmError).code)
    // Any folder that exists used to do: a cwd naming the folder holding the file widened the containment to it.
    await writeFile(join(outside, 'photo.png'), 'private')
    expect(await code(request('photo.png', {}, outside))).toBe('PROJECT_NOT_FOUND')
    const keys = join(outside, 'home', '.ssh')
    await mkdir(keys, { recursive: true })
    await writeFile(join(keys, 'id.png'), 'secret')
    await filmIn(keys)
    expect(await code(request('id.png', {}, keys))).toBe('WORKSPACE_REFUSED')
    const dotted = join(outside, '.config', 'app')
    await mkdir(dotted, { recursive: true })
    await writeFile(join(dotted, 'a.png'), 'x')
    await filmIn(dotted)
    expect(await code(request('a.png', {}, dotted))).toBe('WORKSPACE_REFUSED')
    // A junction that looks harmless but leads into one is refused by its real path.
    await symlink(keys, join(outside, 'harmless'), 'junction')
    expect(await code(request('id.png', {}, join(outside, 'harmless')))).toBe('WORKSPACE_REFUSED')
  })

  it('plays the film\'s own files in build- and out-named folders under film/ too, but not inside node_modules', async () => {
    const played = ['film/out/x.png', 'film/build/y.png', 'film/models/m/dist/z.png', 'film/canvas/media/a.png']
    for (const path of played) await file(path)
    await file('film/models/m/node_modules/hidden.png')
    for (const path of played) {
      const response = await serveMedia(request(path))
      expect(response.status, path).toBe(200)
    }
    await expect(serveMedia(request('film/models/m/node_modules/hidden.png'))).rejects.toThrow(/never listed/u)
  })

  it('builds the URL pages play a workspace file from', () => {
    const url = new URL(workspaceMediaUrl('C:\\ws', 'footage/a b.mp4'), 'http://host')
    expect(url.pathname).toBe('/api/dsh-film/media')
    expect(Object.fromEntries(url.searchParams)).toEqual({ cwd: 'C:\\ws', path: 'footage/a b.mp4' })
  })
})

describe('the workspace scanner', () => {
  beforeEach(async () => {
    await filmIn(cwd)
  })

  it('lists nothing for a folder that is not a film workspace, or a film in a hidden folder', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-film-plain-'))
    const hidden = join(outside, '.secret', 'work')
    try {
      await mkdir(join(plain, 'photos'), { recursive: true })
      await writeFile(join(plain, 'photos', 'a.png'), 'png')
      expect(await listWorkspaceMedia(plain)).toEqual({ files: [], models: [], truncated: false })
      await filmIn(hidden)
      await mkdir(join(hidden, 'photos'), { recursive: true })
      await writeFile(join(hidden, 'photos', 'a.png'), 'png')
      expect(await listWorkspaceMedia(hidden)).toEqual({ files: [], models: [], truncated: false })
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  it('lists the workspace\'s own media outside film/, newest first, skipping hidden, generated and credential folders', async () => {
    await file('media/images/old.png', 'p', new Date('2026-10-01T00:00:00Z'))
    await file('media/videos/new.mp4', 'vv', new Date('2026-10-03T00:00:00Z'))
    await file('footage/day 1/take.mov', 'm', new Date('2026-10-02T00:00:00Z'))
    await file('music.mp3', 'a', new Date('2026-09-30T00:00:00Z'))
    await file('wt-take.mp4', 'w', new Date('2026-09-29T00:00:00Z'))
    await file('packages/brand/logo.png', 'l', new Date('2026-09-28T00:00:00Z'))
    await file('film/canvas/media/own.png')
    await file('film/media/voice.wav')
    await file('notes.txt')
    for (const skipped of ['.cache/a.png', 'media/.hidden.png', 'media/node_modules/pkg/logo.png', 'Node_Modules/b.png', '.git/c.png', 'dist/d.png', 'build/e.mp4',
      'out/f.mp4', 'pack-20260727/g.mp4', 'wt-feature/h.png', '.ssh/i.png', 'venv/j.png', 'target/k.png', 'coverage/l.png', 'vendor/m.png']) {
      await file(skipped)
    }
    const { files, truncated } = await scanWorkspaceMedia(cwd)
    expect(truncated).toBe(false)
    expect(files.map(entry => [entry.path, entry.kind, entry.bytes])).toEqual([
      ['media/videos/new.mp4', 'video', 2],
      ['footage/day 1/take.mov', 'video', 1],
      ['media/images/old.png', 'image', 1],
      ['music.mp3', 'audio', 1],
      ['wt-take.mp4', 'video', 1],
      ['packages/brand/logo.png', 'image', 1],
    ])
  })

  it('does not follow junctions or links', async () => {
    await writeFile(join(outside, 'secret.png'), 'secret')
    await symlink(outside, join(cwd, 'linked'), 'junction')
    // A file symbolic link needs a privilege on Windows; where it cannot be made, the junction alone is checked.
    await symlink(join(outside, 'secret.png'), join(cwd, 'alias.png')).catch(() => {})
    await file('own.png')
    const { files } = await scanWorkspaceMedia(cwd)
    expect(paths(files)).toEqual(['own.png'])
  })

  it('asks lstat about a reparse point, so a cloud placeholder file is kept and a junction is not', async () => {
    // Windows reports OneDrive's placeholders as links in a directory listing; lstat says what they are.
    const asLink = { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true }
    await file('cloud.mp4', 'abc')
    expect(await entryKind(asLink, join(cwd, 'cloud.mp4'))).toMatchObject({ kind: 'file', stats: expect.objectContaining({ size: 3 }) })
    await mkdir(join(cwd, 'cloud folder'))
    expect((await entryKind(asLink, join(cwd, 'cloud folder'))).kind).toBe('dir')
    await symlink(outside, join(cwd, 'linked'), 'junction')
    expect((await entryKind(asLink, join(cwd, 'linked'))).kind).toBe('other')
    expect((await entryKind(asLink, join(cwd, 'gone.mp4'))).kind).toBe('other')
  })

  it('lists models beside the media, under the same rules and their own cap', async () => {
    await file('props/chair.glb', 'glTF', new Date('2026-10-03T00:00:00Z'))
    await file('props/table.fbx', 'fbx', new Date('2026-10-02T00:00:00Z'))
    await file('props/cup.obj', 'v 0 0 0', new Date('2026-10-01T00:00:00Z'))
    await file('props/lamp.gltf', '{}')
    await file('node_modules/pkg/model.glb')
    await file('.cache/model.glb')
    await file('film/canvas/models/chair.glb')
    await file('media/shot.png')
    const listing = await scanWorkspaceMedia(cwd)
    expect(paths(listing.files)).toEqual(['media/shot.png'])
    expect(listing.models).toEqual([
      { path: 'props/chair.glb', format: 'glb', bytes: 4, modifiedAt: '2026-10-03T00:00:00.000Z' },
      { path: 'props/table.fbx', format: 'fbx', bytes: 3, modifiedAt: '2026-10-02T00:00:00.000Z' },
      { path: 'props/cup.obj', format: 'obj', bytes: 7, modifiedAt: '2026-10-01T00:00:00.000Z' },
    ])
    expect((await scanWorkspaceMedia(cwd, { models: 2 })).models).toHaveLength(2)
    expect(WORKSPACE_MODEL_LIMIT).toBe(300)
  })

  it('enters folders down to the depth limit and no deeper', async () => {
    const folders = (count: number): string => Array.from({ length: count }, (_, index) => `d${index}`).join('/')
    await file(`${folders(WORKSPACE_MEDIA_DEPTH)}/deep.png`)
    await file(`${folders(WORKSPACE_MEDIA_DEPTH + 1)}/deeper.png`)
    expect(paths((await scanWorkspaceMedia(cwd)).files)).toEqual([`${folders(WORKSPACE_MEDIA_DEPTH)}/deep.png`])
  })

  it('stops at the file, entry and time limits and says so', async () => {
    for (let index = 0; index < 5; index++) await file(`media/${index}.png`)
    await file('a/b/c.png')
    expect(await scanWorkspaceMedia(cwd, { files: 3 })).toMatchObject({ files: expect.any(Array), truncated: true })
    expect((await scanWorkspaceMedia(cwd, { files: 3 })).files).toHaveLength(3)
    expect((await scanWorkspaceMedia(cwd, { entries: 2 })).truncated).toBe(true)
    expect(await scanWorkspaceMedia(cwd, { budgetMs: -1 })).toEqual({ files: [], models: [], truncated: true })
    expect((await scanWorkspaceMedia(cwd, { files: 6 })).truncated).toBe(false)
  })

  it('keeps a listing for a few seconds, through the plugin\'s own events, and reads the disk again after', async () => {
    let now = performance.now()
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      await file('media/a.png')
      expect(paths((await listWorkspaceMedia(cwd)).files)).toEqual(['media/a.png'])
      await file('media/b.png', 'b', new Date(Date.now() + 60_000))
      expect(paths((await listWorkspaceMedia(cwd)).files)).toEqual(['media/a.png'])
      // Every plugin event is about film/, which the scan never reads; a canvas autosave sends one each time.
      const events = new ProjectEvents()
      events.emit(cwd, { type: 'story-canvas-changed', projectId: 'film', boardId: 'film' })
      events.emit(cwd, { type: 'file-changed', projectId: 'film', path: 'canvas/media/x.png' })
      expect(paths((await listWorkspaceMedia(cwd)).files)).toEqual(['media/a.png'])
      now += WORKSPACE_CACHE_MS + 1
      expect(paths((await listWorkspaceMedia(cwd)).files)).toEqual(['media/b.png', 'media/a.png'])
      const first = await listWorkspaceMedia(cwd)
      first.files.length = 0
      expect((await listWorkspaceMedia(cwd)).files).toHaveLength(2)
    } finally {
      clock.mockRestore()
    }
  })

  it('names folders it never enters', () => {
    expect(['.git', 'node_modules', 'NODE_MODULES', 'dist.', 'pack-x', '.ssh', '.anything'].every(isSkippedDirName)).toBe(true)
    expect(['media', 'packages', 'footage', 'outputs', 'wt'].some(isSkippedDirName)).toBe(false)
  })
})
