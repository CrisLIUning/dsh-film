/**
 * What the file system does on some machines and not on the test machine:
 * a hard link refused (another volume), and OneDrive's cloud placeholders,
 * which a Windows directory listing reports as links.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ linkFailure: undefined as string | undefined, linkCalls: 0, placeholders: new Set<string>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  /** A directory entry as Windows lists a cloud placeholder: a reparse point, so neither a file nor a directory. */
  const asReparsePoint = (entry: Dirent): Dirent => Object.assign(Object.create(Object.getPrototypeOf(entry) as object) as Dirent, entry, {
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => true,
  })
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      fs.linkCalls++
      if (fs.linkFailure !== undefined) throw Object.assign(new Error(`${fs.linkFailure}: cannot link`), { code: fs.linkFailure })
      return actual.link(...args)
    },
    readdir: (async (path: Parameters<typeof actual.readdir>[0], options?: { withFileTypes?: boolean }) => {
      const entries = await actual.readdir(path, options as never) as unknown[]
      if (options?.withFileTypes !== true) return entries
      return (entries as Dirent[]).map(entry => fs.placeholders.has(entry.name) ? asReparsePoint(entry) : entry)
    }) as typeof actual.readdir,
  }
})

const { importWorkspaceMedia } = await import('../src/studio/material.js')
const { invalidateWorkspaceMedia, listFilmMedia, scanWorkspaceMedia } = await import('../src/media.js')
const { CanvasAssetStore } = await import('../src/canvas/assets.js')

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-fs-'))
  fs.linkFailure = undefined
  fs.linkCalls = 0
  fs.placeholders.clear()
  invalidateWorkspaceMedia()
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function file(relative: string, content = 'x'): Promise<void> {
  const path = join(cwd, ...relative.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

describe('importing where a hard link is refused', () => {
  it('copies the file instead (another volume)', async () => {
    fs.linkFailure = 'EXDEV'
    await file('footage/take.mp4', 'take')
    const imported = await importWorkspaceMedia(cwd, 'footage/take.mp4')
    expect(imported).toEqual({ file: { name: 'canvas/media/take.mp4', size: 4, mime: 'video/mp4' }, created: true })
    expect(fs.linkCalls).toBe(1)
    const [source, copy] = await Promise.all([stat(join(cwd, 'footage', 'take.mp4'), { bigint: true }), stat(join(cwd, 'film', 'canvas', 'media', 'take.mp4'), { bigint: true })])
    expect(copy.ino).not.toBe(source.ino)
    expect(await readFile(join(cwd, 'film', 'canvas', 'media', 'take.mp4'), 'utf8')).toBe('take')
    // The copy has the same bytes, so importing again answers it.
    expect(await importWorkspaceMedia(cwd, 'footage/take.mp4')).toMatchObject({ reused: true, file: { name: 'canvas/media/take.mp4' } })
  })

  it('links when it can', async () => {
    await file('still.png', 'png')
    expect((await importWorkspaceMedia(cwd, 'still.png')).file.name).toBe('canvas/media/still.png')
    expect((await stat(join(cwd, 'still.png'))).nlink).toBe(2)
  })
})

describe('cloud placeholders', () => {
  it('are listed as the files they are, by the workspace scan, the film\'s listing and the canvas library', async () => {
    fs.placeholders.add('cloud.png')
    fs.placeholders.add('cloud.mp4')
    fs.placeholders.add('synced')
    await file('media/cloud.png')
    await file('synced/inside.mp4')
    await file('film/canvas/media/cloud.mp4')
    expect((await scanWorkspaceMedia(cwd)).files.map(entry => entry.path).sort()).toEqual(['media/cloud.png', 'synced/inside.mp4'])
    expect((await listFilmMedia(cwd)).map(entry => entry.path)).toEqual(['canvas/media/cloud.mp4'])
    const library = await new CanvasAssetStore(cwd).read('film', 'film')
    expect(library.assets.map(asset => asset.filePath)).toEqual(['canvas/media/cloud.mp4'])
  })
})
