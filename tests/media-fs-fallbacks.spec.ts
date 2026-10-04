/**
 * What the file system does on some machines and not on the test machine:
 * a copy that fails half way (a full disk), how an import asks for its copy
 * (a clone where the file system has them), and OneDrive's cloud
 * placeholders, which a Windows directory listing reports as links.
 */

import { constants } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({
  linkCalls: 0,
  copyModes: [] as number[],
  copyFailure: undefined as string | undefined,
  placeholders: new Set<string>(),
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
  }
})

const { importWorkspaceFile } = await import('../src/canvas/workspace-import.js')
const { invalidateWorkspaceMedia, scanWorkspaceMedia } = await import('../src/media.js')
const { CanvasAssetStore } = await import('../src/canvas/assets.js')

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-fs-'))
  fs.linkCalls = 0
  fs.copyModes = []
  fs.copyFailure = undefined
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
