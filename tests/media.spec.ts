import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilmError } from '../src/errors.js'
import { RANGE_CHUNK, parseRange } from '../src/files.js'
import {
  WORKSPACE_MEDIA_DEPTH, WorkspaceMediaError, checkWorkspaceMediaPath, entryKind, invalidateWorkspaceMedia, isSkippedDirName, listAssets, listFilmMedia,
  listWorkspaceMedia, mediaTypeOf, resolveWorkspaceMedia, scanWorkspaceMedia, serveMedia, workspaceMediaUrl,
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

  it('caps one response at RANGE_CHUNK bytes', () => {
    expect(parseRange('bytes=0-', 100 * RANGE_CHUNK)).toEqual({ start: 0, end: RANGE_CHUNK - 1 })
    expect(parseRange('bytes=5-', 100 * RANGE_CHUNK)).toEqual({ start: 5, end: RANGE_CHUNK + 4 })
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

  it('spells the path as the file system does', async () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return
    await file('Footage/Take.mp4')
    expect((await resolveWorkspaceMedia(cwd, 'footage/take.mp4')).path).toBe('Footage/Take.mp4')
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

  it('builds the URL pages play a workspace file from', () => {
    const url = new URL(workspaceMediaUrl('C:\\ws', 'footage/a b.mp4'), 'http://host')
    expect(url.pathname).toBe('/api/dsh-film/media')
    expect(Object.fromEntries(url.searchParams)).toEqual({ cwd: 'C:\\ws', path: 'footage/a b.mp4' })
  })
})

describe('the workspace scanner', () => {
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
    expect(await scanWorkspaceMedia(cwd, { budgetMs: -1 })).toEqual({ files: [], truncated: true })
    expect((await scanWorkspaceMedia(cwd, { files: 6 })).truncated).toBe(false)
  })

  it('keeps a listing for a moment and reads again after a plugin event', async () => {
    await file('media/a.png')
    expect(paths((await listWorkspaceMedia(cwd)).files)).toEqual(['media/a.png'])
    await file('media/b.png', 'b', new Date(Date.now() + 60_000))
    expect(paths((await listWorkspaceMedia(cwd)).files)).toEqual(['media/a.png'])
    new ProjectEvents().emit(cwd, { type: 'file-changed', projectId: 'film', path: 'canvas/media/x.png' })
    expect(paths((await listWorkspaceMedia(cwd)).files)).toEqual(['media/b.png', 'media/a.png'])
    const first = await listWorkspaceMedia(cwd)
    first.files.length = 0
    expect((await listWorkspaceMedia(cwd)).files).toHaveLength(2)
  })

  it('names folders it never enters', () => {
    expect(['.git', 'node_modules', 'NODE_MODULES', 'dist.', 'pack-x', '.ssh', '.anything'].every(isSkippedDirName)).toBe(true)
    expect(['media', 'packages', 'footage', 'outputs', 'wt'].some(isSkippedDirName)).toBe(false)
  })
})

describe('the film\'s listing', () => {
  it('lists every media file under film/, past any count the workspace scan stops at', async () => {
    for (let index = 0; index < 30; index++) await file(`film/canvas/media/${index}.png`)
    await file('film/.versions/old.png')
    await file('film/models/m/node_modules/x.png')
    await file('film/models/m/build/capture.png')
    await file('media/outside.png')
    const listed = paths(await listFilmMedia(cwd))
    expect(listed).toHaveLength(31)
    expect(listed).toContain('models/m/build/capture.png')
    expect(listed.every(path => !path.startsWith('.') && !path.includes('node_modules'))).toBe(true)
  })
})

describe('listAssets', () => {
  it('lists the film\'s media and the workspace\'s own, newest first', async () => {
    await file('media/images/old.png', 'p', new Date('2026-10-01T00:00:00Z'))
    await file('media/videos/new.mp4', 'v', new Date('2026-10-03T00:00:00Z'))
    await file('film/media/voice.wav', 'a', new Date('2026-10-02T00:00:00Z'))
    await file('footage/take.mov', 'm', new Date('2026-09-30T00:00:00Z'))
    await file('film/film.json', '{}')
    await file('media/.cache/hidden.png', 'h')
    await file('media/node_modules/pkg/logo.png', 'n')
    const { assets, truncated } = await listAssets(cwd)
    expect(truncated).toBe(false)
    expect(assets.map(asset => [asset.path, asset.kind, asset.bytes])).toEqual([
      ['media/videos/new.mp4', 'video', 1],
      ['film/media/voice.wav', 'audio', 1],
      ['media/images/old.png', 'image', 1],
      ['footage/take.mov', 'video', 1],
    ])
  })

  it('stops at the limit and says so', async () => {
    for (let index = 0; index < 5; index++) await file(`media/${index}.png`)
    const { assets, truncated } = await listAssets(cwd, 3)
    expect(assets).toHaveLength(3)
    expect(truncated).toBe(true)
  })

  it('returns nothing for a workspace without media', async () => {
    expect(await listAssets(cwd)).toEqual({ assets: [], truncated: false })
  })
})
