import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CANVAS_DOCUMENT_FILE, CANVAS_TOMBSTONE_FILE, emptyFilmBoard } from '../src/canvas/documents.js'
import { FilmError } from '../src/errors.js'
import {
  ASPECT_RATIOS, PROJECT_FILE, TITLE_MAX, UNTITLED, cleanTitle, createExclusive, createProject, defaultTitle, parseNewProject, parseProject,
  parseProjectChange, readProject, updateProject, workspaceDirectory,
} from '../src/project.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-project-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof FilmError ? error.code : String(error)
  }
}

describe('cleanTitle', () => {
  it('folds whitespace and drops control characters', () => {
    expect(cleanTitle('  雨夜\t\n来客 \u0007 ')).toBe('雨夜 来客')
  })

  it('cuts long titles by character, not by UTF-16 unit', () => {
    const title = cleanTitle('😀'.repeat(TITLE_MAX + 10))
    expect([...title]).toHaveLength(TITLE_MAX)
  })
})

describe('frames', () => {
  it('offers exactly the editing desk\'s frames (the video editor\'s HOST_PROJECT_ASPECTS)', () => {
    expect([...ASPECT_RATIOS].sort()).toEqual(['9:16', '16:9', '1:1', '4:5', '21:9', '2.39:1'].sort())
    expect(ASPECT_RATIOS).not.toContain('4:3')
  })
})

describe('defaultTitle', () => {
  it('names a film after its workspace folder, cleaned', () => {
    expect(defaultTitle(join(cwd, '雨夜  来客'))).toBe('雨夜 来客')
    expect(defaultTitle(join(cwd, 'x'.repeat(TITLE_MAX + 5)))).toHaveLength(TITLE_MAX)
  })

  it('falls back to a fixed title when the folder gives none', () => {
    expect(defaultTitle(parse(cwd).root)).toBe(UNTITLED)
    expect(UNTITLED).toBe('Untitled film')
  })
})

describe('parseNewProject', () => {
  it('defaults the title to the folder and the frame to 16:9', () => {
    expect(parseNewProject({ title: '短片' }, cwd)).toEqual({ title: '短片', aspectRatio: '16:9' })
    expect(parseNewProject({}, join(cwd, '修表铺'))).toEqual({ title: '修表铺', aspectRatio: '16:9' })
    expect(parseNewProject({ title: '   ', aspectRatio: '21:9' }, join(cwd, '修表铺'))).toEqual({ title: '修表铺', aspectRatio: '21:9' })
  })

  it('refuses a frame the editing desk lacks, a title that is not text and a body that is not an object', () => {
    expect(() => parseNewProject({ aspectRatio: '4:3' }, cwd)).toThrow(/aspectRatio must be one of/)
    expect(() => parseNewProject({ title: 3 }, cwd)).toThrow(/title must be a string/)
    expect(() => parseNewProject('x', cwd)).toThrow(/JSON object/)
  })
})

describe('parseProjectChange', () => {
  it('takes a title, a frame or both', () => {
    expect(parseProjectChange({ title: '  雨夜\n来客 ' })).toEqual({ title: '雨夜 来客' })
    expect(parseProjectChange({ aspectRatio: '9:16' })).toEqual({ aspectRatio: '9:16' })
    expect(parseProjectChange({ title: 'T', aspectRatio: '1:1', other: 1 })).toEqual({ title: 'T', aspectRatio: '1:1' })
  })

  it('refuses an empty change, a blank title and a frame the editing desk lacks', () => {
    expect(() => parseProjectChange({})).toThrow(/title, an aspectRatio or both/)
    expect(() => parseProjectChange({ title: ' \t ' })).toThrow(/visible character/)
    expect(() => parseProjectChange({ aspectRatio: '4:3' })).toThrow(/aspectRatio must be one of/)
    expect(() => parseProjectChange(null)).toThrow(/JSON object/)
  })
})

describe('parseProject', () => {
  const valid = { format: 'vibedev.film', version: 1, id: 'p1', title: 'T', aspectRatio: '9:16', createdAt: 'a', updatedAt: 'b' }

  it('reads a valid project and drops unknown fields', () => {
    expect(parseProject(JSON.stringify({ ...valid, extra: true }))).toEqual(valid)
  })

  it('keeps a frame an earlier version offered, which the editing desk lacks', () => {
    expect(parseProject(JSON.stringify({ ...valid, aspectRatio: '4:3' })).aspectRatio).toBe('4:3')
    expect(parseProject(JSON.stringify({ ...valid, aspectRatio: '21:9' })).aspectRatio).toBe('21:9')
  })

  it('names what is wrong with a broken file', () => {
    expect(() => parseProject('{')).toThrow(/not valid JSON/)
    expect(() => parseProject(JSON.stringify({ ...valid, format: 'other' }))).toThrow(/not a vibedev.film project/)
    expect(() => parseProject(JSON.stringify({ ...valid, aspectRatio: '5:4' }))).toThrow(/unknown aspectRatio/)
  })

  it('tells a newer project apart from a broken one', () => {
    try {
      parseProject(JSON.stringify({ ...valid, version: 2 }))
      expect.unreachable()
    } catch (error) {
      expect((error as FilmError).code).toBe('PROJECT_UNSUPPORTED')
    }
  })
})

describe('workspaceDirectory', () => {
  it('accepts an existing absolute directory only', async () => {
    await expect(workspaceDirectory(cwd)).resolves.toBe(cwd)
    expect(await codeOf(workspaceDirectory('relative/dir'))).toBe('BAD_REQUEST')
    expect(await codeOf(workspaceDirectory(null))).toBe('BAD_REQUEST')
    expect(await codeOf(workspaceDirectory(join(cwd, 'missing')))).toBe('WORKSPACE_NOT_FOUND')
    await writeFile(join(cwd, 'file.txt'), 'x')
    expect(await codeOf(workspaceDirectory(join(cwd, 'file.txt')))).toBe('WORKSPACE_NOT_FOUND')
  })
})

describe('createProject', () => {
  it('writes film/film.json and reads it back', async () => {
    expect(await readProject(cwd)).toBeNull()
    const { project, created } = await createProject(cwd, { title: '雨夜来客', aspectRatio: '2.39:1' }, new Date('2026-10-04T01:00:00Z'))
    expect(created).toBe(true)
    expect(project).toMatchObject({ format: 'vibedev.film', version: 1, title: '雨夜来客', aspectRatio: '2.39:1', createdAt: '2026-10-04T01:00:00.000Z' })
    expect(JSON.parse(await readFile(join(cwd, PROJECT_FILE), 'utf8'))).toEqual(project)
    expect(await readProject(cwd)).toEqual(project)
  })

  it('never replaces an existing project', async () => {
    const first = await createProject(cwd, { title: 'A', aspectRatio: '16:9' })
    const second = await createProject(cwd, { title: 'B', aspectRatio: '1:1' })
    expect(second).toEqual({ project: first.project, created: false })
  })

  it('lets exactly one of two simultaneous creations win', async () => {
    const results = await Promise.all([
      createProject(cwd, { title: 'A', aspectRatio: '16:9' }),
      createProject(cwd, { title: 'B', aspectRatio: '16:9' }),
    ])
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(results[0]?.project.id).toBe(results[1]?.project.id)
  })

  it('creates the film\'s empty board with it, in the full shape', async () => {
    const { project } = await createProject(cwd, { title: '雨夜来客', aspectRatio: '16:9' }, new Date('2026-10-04T01:00:00Z'))
    const time = '2026-10-04T01:00:00.000Z'
    expect(JSON.parse(await readFile(join(cwd, CANVAS_DOCUMENT_FILE), 'utf8'))).toEqual({
      id: project.id, title: '雨夜来客', createdAt: time, updatedAt: time,
      nodes: [], connections: [], chatSessions: [], activeChatId: null,
      backgroundMode: 'lines', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
    })
    expect(emptyFilmBoard(project.id, '雨夜来客', time)).toEqual(JSON.parse(await readFile(join(cwd, CANVAS_DOCUMENT_FILE), 'utf8')))
  })

  it('takes the id of a board saved before the film, and leaves that board as it is', async () => {
    const board = { id: 'board-from-studio', title: '旧画板', nodes: [{ id: 'n1' }], connections: [] }
    await mkdir(join(cwd, 'film', 'canvas'), { recursive: true })
    await writeFile(join(cwd, CANVAS_DOCUMENT_FILE), JSON.stringify(board))
    const { project, created } = await createProject(cwd, { title: 'A', aspectRatio: '16:9' })
    expect(created).toBe(true)
    expect(project.id).toBe('board-from-studio')
    expect(JSON.parse(await readFile(join(cwd, CANVAS_DOCUMENT_FILE), 'utf8'))).toEqual(board)
  })

  it('never replaces a damaged board or a deleted board\'s tombstone', async () => {
    await mkdir(join(cwd, 'film', 'canvas'), { recursive: true })
    await writeFile(join(cwd, CANVAS_DOCUMENT_FILE), '{ not json')
    const damaged = await createProject(cwd, { title: 'A', aspectRatio: '16:9' })
    expect(damaged.project.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(await readFile(join(cwd, CANVAS_DOCUMENT_FILE), 'utf8')).toBe('{ not json')

    await rm(join(cwd, 'film'), { recursive: true })
    await mkdir(join(cwd, 'film', 'canvas'), { recursive: true })
    await writeFile(join(cwd, CANVAS_TOMBSTONE_FILE), JSON.stringify({ id: 'old', deletedAt: 'x' }))
    expect((await createProject(cwd, { title: 'B', aspectRatio: '16:9' })).created).toBe(true)
    await expect(readFile(join(cwd, CANVAS_DOCUMENT_FILE))).rejects.toThrow()
  })

  it('does not touch the board of an existing film', async () => {
    const first = await createProject(cwd, { title: 'A', aspectRatio: '16:9' })
    await rm(join(cwd, CANVAS_DOCUMENT_FILE))
    expect((await createProject(cwd, { title: 'B', aspectRatio: '16:9' })).created).toBe(false)
    await expect(readFile(join(cwd, CANVAS_DOCUMENT_FILE))).rejects.toThrow()
    expect(first.created).toBe(true)
  })
})

describe('updateProject', () => {
  it('renames the film and changes its frame, keeping its id, its birth and fields it does not know', async () => {
    const { project } = await createProject(cwd, { title: 'A', aspectRatio: '16:9' }, new Date('2026-10-04T01:00:00Z'))
    const raw = JSON.parse(await readFile(join(cwd, PROJECT_FILE), 'utf8'))
    await writeFile(join(cwd, PROJECT_FILE), JSON.stringify({ ...raw, later: { kept: true } }))
    const renamed = await updateProject(cwd, { title: '雨夜来客' }, new Date('2026-10-04T02:00:00Z'))
    expect(renamed).toEqual({ changed: true, project: { ...project, title: '雨夜来客', updatedAt: '2026-10-04T02:00:00.000Z' } })
    const reframed = await updateProject(cwd, { aspectRatio: '9:16' }, new Date('2026-10-04T03:00:00Z'))
    expect(reframed.project).toMatchObject({ id: project.id, title: '雨夜来客', aspectRatio: '9:16', createdAt: project.createdAt, updatedAt: '2026-10-04T03:00:00.000Z' })
    expect(await readProject(cwd)).toEqual(reframed.project)
    expect(JSON.parse(await readFile(join(cwd, PROJECT_FILE), 'utf8')).later).toEqual({ kept: true })
  })

  it('saves nothing when nothing changes', async () => {
    const { project } = await createProject(cwd, { title: 'A', aspectRatio: '16:9' })
    const before = await readFile(join(cwd, PROJECT_FILE), 'utf8')
    expect(await updateProject(cwd, { title: 'A', aspectRatio: '16:9' })).toEqual({ project, changed: false })
    expect(await readFile(join(cwd, PROJECT_FILE), 'utf8')).toBe(before)
  })

  it('keeps a legacy frame when only the title changes', async () => {
    await createProject(cwd, { title: 'A', aspectRatio: '16:9' })
    const raw = JSON.parse(await readFile(join(cwd, PROJECT_FILE), 'utf8'))
    await writeFile(join(cwd, PROJECT_FILE), JSON.stringify({ ...raw, aspectRatio: '4:3' }))
    expect((await updateProject(cwd, { title: 'B' })).project).toMatchObject({ title: 'B', aspectRatio: '4:3' })
  })

  it('applies two changes made at once, one after the other', async () => {
    await createProject(cwd, { title: 'A', aspectRatio: '16:9' })
    await Promise.all([updateProject(cwd, { title: 'B' }), updateProject(cwd, { aspectRatio: '1:1' })])
    expect(await readProject(cwd)).toMatchObject({ title: 'B', aspectRatio: '1:1' })
    expect((await readdir(join(cwd, 'film'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses a workspace without a film and a broken project file', async () => {
    expect(await codeOf(updateProject(cwd, { title: 'B' }))).toBe('PROJECT_NOT_FOUND')
    await mkdir(join(cwd, 'film'))
    await writeFile(join(cwd, PROJECT_FILE), '{')
    expect(await codeOf(updateProject(cwd, { title: 'B' }))).toBe('PROJECT_INVALID')
    expect(await readFile(join(cwd, PROJECT_FILE), 'utf8')).toBe('{')
  })
})

describe('createExclusive', () => {
  it('leaves no temporary files behind', async () => {
    await mkdir(join(cwd, 'film'))
    expect(await createExclusive(join(cwd, 'film', 'x.json'), '1')).toBe(true)
    expect(await createExclusive(join(cwd, 'film', 'x.json'), '2')).toBe(false)
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(join(cwd, 'film'))).toEqual(['x.json'])
    expect(await readFile(join(cwd, 'film', 'x.json'), 'utf8')).toBe('1')
  })
})
