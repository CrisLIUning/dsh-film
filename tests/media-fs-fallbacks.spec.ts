/**
 * What the file system does on some machines and not on the test machine:
 * a copy that fails half way (a full disk), how an import asks for its copy
 * (a clone where the file system has them), OneDrive's cloud placeholders,
 * which a Windows directory listing reports as links, and a drive without
 * hard links (FAT32/exFAT, where Windows answers a link with EISDIR).
 */

import { constants } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Output } from 'mediabunny'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({
  linkCalls: 0,
  linkFailure: undefined as string | undefined,
  copyModes: [] as number[],
  copyFailure: undefined as string | undefined,
  placeholders: new Set<string>(),
  /** Told of every rm, before it runs. */
  onRm: undefined as ((path: string) => void) | undefined,
}))

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
      if (fs.linkFailure !== undefined) throw Object.assign(new Error(`${fs.linkFailure}: illegal operation on a directory, link`), { code: fs.linkFailure })
      return actual.link(...args)
    },
    copyFile: async (source: Parameters<typeof actual.copyFile>[0], target: Parameters<typeof actual.copyFile>[1], mode?: number) => {
      fs.copyModes.push(mode ?? 0)
      if (fs.copyFailure !== undefined) {
        // Half the file landed before the disk filled up.
        await actual.writeFile(target, 'par', { flag: 'wx' })
        throw Object.assign(new Error(`${fs.copyFailure}: no space left`), { code: fs.copyFailure })
      }
      return actual.copyFile(source, target, mode)
    },
    readdir: (async (path: Parameters<typeof actual.readdir>[0], options?: { withFileTypes?: boolean }) => {
      const entries = await actual.readdir(path, options as never) as unknown[]
      if (options?.withFileTypes !== true) return entries
      return (entries as Dirent[]).map(entry => fs.placeholders.has(entry.name) ? asReparsePoint(entry) : entry)
    }) as typeof actual.readdir,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      fs.onRm?.(String(args[0]))
      return actual.rm(...args)
    },
  }
})

const { importWorkspaceFile } = await import('../src/canvas/workspace-import.js')
const { invalidateWorkspaceMedia, scanWorkspaceMedia } = await import('../src/media.js')
const { CanvasAssetStore } = await import('../src/canvas/assets.js')
const { cutFile } = await import('../src/media/edit.js')
const { writeFixture } = await import('./media-edit-fixtures.js')

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-fs-'))
  fs.linkCalls = 0
  fs.linkFailure = undefined
  fs.copyModes = []
  fs.copyFailure = undefined
  fs.placeholders.clear()
  fs.onRm = undefined
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

describe('importing', () => {
  it('copies the file — a clone where the file system has them, never a hard link — and answers the copy for the same bytes again', async () => {
    await file('footage/take.mp4', 'take')
    const imported = await importWorkspaceFile(cwd, 'footage/take.mp4')
    expect(imported).toEqual({ file: { name: 'canvas/media/take.mp4', size: 4, mime: 'video/mp4' }, kind: 'video', created: true })
    expect(fs.linkCalls).toBe(0)
    expect(fs.copyModes).toEqual([constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE])
    const [source, copy] = await Promise.all([stat(join(cwd, 'footage', 'take.mp4'), { bigint: true }), stat(join(cwd, 'film', 'canvas', 'media', 'take.mp4'), { bigint: true })])
    expect(copy.ino).not.toBe(source.ino)
    expect(source.nlink).toBe(1n)
    expect(await readFile(join(cwd, 'film', 'canvas', 'media', 'take.mp4'), 'utf8')).toBe('take')
    // The copy has the same bytes, so importing again answers it.
    expect(await importWorkspaceFile(cwd, 'footage/take.mp4')).toMatchObject({ reused: true, file: { name: 'canvas/media/take.mp4' } })
    expect(fs.copyModes).toHaveLength(1)
  })

  it('leaves no half-copied file under the name when the copy fails', async () => {
    await file('footage/take.mp4', 'take')
    fs.copyFailure = 'ENOSPC'
    await expect(importWorkspaceFile(cwd, 'footage/take.mp4')).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(await readdir(join(cwd, 'film', 'canvas', 'media'))).toEqual([])
    fs.copyFailure = undefined
    expect((await importWorkspaceFile(cwd, 'footage/take.mp4')).file.name).toBe('canvas/media/take.mp4')
  })
})

describe('cloud placeholders', () => {
  it('are listed as the files they are, by the workspace scan and the canvas library', async () => {
    fs.placeholders.add('cloud.png')
    fs.placeholders.add('cloud.mp4')
    fs.placeholders.add('synced')
    await file('media/cloud.png')
    await file('synced/inside.mp4')
    await file('film/canvas/media/cloud.mp4')
    expect((await scanWorkspaceMedia(cwd)).files.map(entry => entry.path).sort()).toEqual(['media/cloud.png', 'synced/inside.mp4'])
    const library = await new CanvasAssetStore(cwd).read('film', 'film')
    expect(library.assets.map(asset => asset.filePath)).toEqual(['canvas/media/cloud.mp4'])
  })
})

describe('a media edit that fails while it writes', () => {
  it('deletes its temporary file only once the output the failed conversion cancelled has closed it', async () => {
    const media = join(cwd, 'film', 'canvas', 'media')
    const source = await writeFixture(join(media, 'src.mp4'), { frames: 250, gop: 25 })
    // The output's close takes a while, as a file handle's does on Windows: it settles some time after mediabunny's own.
    let closed = false
    const original = Output.prototype.cancel
    const slowClose = vi.spyOn(Output.prototype, 'cancel').mockImplementation(function (this: Output) {
      return original.call(this).then(() => new Promise<void>((resolve) => {
        setTimeout(() => {
          closed = true
          resolve()
        }, 50)
      }))
    })
    const removals: boolean[] = []
    fs.onRm = (path) => { if (/\.edit-[^\\/]*\.tmp$/u.test(path)) removals.push(closed) }
    try {
      // A failure that is no cancel (a full disk, a read error) in the middle of the copy: mediabunny cancels the output itself.
      const cut = cutFile(source, join(media, 'clip-1.mp4'), { inMs: 0, outMs: 9000 }, 'expand', { onProgress: (fraction) => { if (fraction > 0) throw new Error('ENOSPC: no space left') } })
      await expect(cut).rejects.toThrow('ENOSPC: no space left')
    } finally {
      slowClose.mockRestore()
    }
    expect(removals).toEqual([true])
    expect(await readdir(media)).toEqual(['src.mp4'])
  })
})

describe('media edits on a drive without hard links', () => {
  it('name their result by renaming the temporary file onto a free name', async () => {
    fs.linkFailure = 'EISDIR'
    const media = join(cwd, 'film', 'canvas', 'media')
    const source = await writeFixture(join(media, 'src.mp4'), { frames: 50 })
    const first = await cutFile(source, join(media, 'clip-1.mp4'), { inMs: 0, outMs: 1000 }, 'expand')
    expect(first.path).toBe(join(media, 'clip-1.mp4'))
    // The name is taken now: the next one goes to the first free name, and the first file is untouched.
    const second = await cutFile(source, join(media, 'clip-1.mp4'), { inMs: 1000, outMs: 2000 }, 'expand')
    expect(second.path).toBe(join(media, 'clip-1-2.mp4'))
    expect(fs.linkCalls).toBeGreaterThanOrEqual(2)
    expect((await readdir(media)).sort()).toEqual(['clip-1-2.mp4', 'clip-1.mp4', 'src.mp4'])
    expect((await stat(join(media, 'clip-1.mp4'))).size).toBe(first.size)
  })
})
