import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilmError } from '../src/errors.js'
import {
  PROJECT_FILE, TITLE_MAX, cleanTitle, createExclusive, createProject, parseNewProject, parseProject, readProject, workspaceDirectory,
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

describe('parseNewProject', () => {
  it('defaults the frame to 16:9', () => {
    expect(parseNewProject({ title: '短片' })).toEqual({ title: '短片', aspectRatio: '16:9' })
  })

  it('refuses a missing title and an unknown frame', () => {
    expect(() => parseNewProject({ title: '   ' })).toThrow(FilmError)
    expect(() => parseNewProject({ title: 'x', aspectRatio: '21:9' })).toThrow(/aspectRatio must be one of/)
    expect(() => parseNewProject('x')).toThrow(/JSON object/)
  })
})

describe('parseProject', () => {
  const valid = { format: 'vibedev.film', version: 1, id: 'p1', title: 'T', aspectRatio: '9:16', createdAt: 'a', updatedAt: 'b' }

  it('reads a valid project and drops unknown fields', () => {
    expect(parseProject(JSON.stringify({ ...valid, extra: true }))).toEqual(valid)
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
