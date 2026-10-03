/**
 * The film project: one per workspace, described by `film/film.json`. The
 * project file names the film and its frame; the other parts (script,
 * storyboard, timeline, director scenes) live beside it under `film/` and
 * arrive in later versions.
 * @module dsh-film/project
 */

import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { FilmError } from './errors.js'

/** The folder under the workspace that holds every film file. */
export const FILM_DIR = 'film'
/** The project file, relative to the workspace. */
export const PROJECT_FILE = `${FILM_DIR}/film.json`
/** The project file's format tag and version. */
export const PROJECT_FORMAT = 'vibedev.film'
export const PROJECT_VERSION = 1

/** Frame shapes a project can use. */
export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '2.39:1'] as const
export type AspectRatio = typeof ASPECT_RATIOS[number]

/** The longest title, in characters. */
export const TITLE_MAX = 80

/** The contents of `film/film.json`. */
export interface FilmProject {
  format: typeof PROJECT_FORMAT
  version: typeof PROJECT_VERSION
  /** Stable identity, kept when the folder is copied or renamed. */
  id: string
  title: string
  aspectRatio: AspectRatio
  /** ISO 8601 times. */
  createdAt: string
  updatedAt: string
}

/** What a new project needs from the user. */
export interface NewProject {
  title: string
  aspectRatio?: AspectRatio
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAspectRatio = (value: unknown): value is AspectRatio =>
  typeof value === 'string' && (ASPECT_RATIOS as readonly string[]).includes(value)

/**
 * Clean a title the user typed: whitespace runs fold to one space, control
 * characters go, and the result is cut to {@link TITLE_MAX} characters.
 * @param title - the typed title.
 * @returns the cleaned title, possibly empty.
 */
export function cleanTitle(title: string): string {
  const folded = title.normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return [...folded].slice(0, TITLE_MAX).join('').trim()
}

/**
 * Validate the input for a new project.
 * @param input - the request body.
 * @returns the title and frame to create the project with.
 */
export function parseNewProject(input: unknown): Required<NewProject> {
  if (!isRecord(input)) throw new FilmError('BAD_REQUEST', 'The request body must be a JSON object.')
  const title = typeof input.title === 'string' ? cleanTitle(input.title) : ''
  if (title === '') throw new FilmError('BAD_REQUEST', 'A project needs a title.')
  const aspectRatio = input.aspectRatio ?? '16:9'
  if (!isAspectRatio(aspectRatio)) {
    throw new FilmError('BAD_REQUEST', `aspectRatio must be one of ${ASPECT_RATIOS.join(', ')}.`)
  }
  return { title, aspectRatio }
}

/**
 * Read a project file's text, refusing anything that is not a project of a
 * version this plugin understands.
 * @param text - the file's contents.
 * @returns the project.
 */
export function parseProject(text: string): FilmProject {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new FilmError('PROJECT_INVALID', `${PROJECT_FILE} is not valid JSON: ${(error as Error).message}`)
  }
  if (!isRecord(value) || value.format !== PROJECT_FORMAT) {
    throw new FilmError('PROJECT_INVALID', `${PROJECT_FILE} is not a ${PROJECT_FORMAT} project file.`)
  }
  if (value.version !== PROJECT_VERSION) {
    throw new FilmError('PROJECT_UNSUPPORTED', `${PROJECT_FILE} has version ${String(value.version)}; this plugin reads version ${PROJECT_VERSION}. Update dsh-film.`)
  }
  const { id, title, aspectRatio, createdAt, updatedAt } = value
  if (typeof id !== 'string' || id === '') throw new FilmError('PROJECT_INVALID', `${PROJECT_FILE} has no id.`)
  if (typeof title !== 'string') throw new FilmError('PROJECT_INVALID', `${PROJECT_FILE} has no title.`)
  if (!isAspectRatio(aspectRatio)) throw new FilmError('PROJECT_INVALID', `${PROJECT_FILE} has an unknown aspectRatio.`)
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') {
    throw new FilmError('PROJECT_INVALID', `${PROJECT_FILE} is missing its times.`)
  }
  return { format: PROJECT_FORMAT, version: PROJECT_VERSION, id, title, aspectRatio, createdAt, updatedAt }
}

/**
 * Check that a workspace path names an existing directory.
 * @param cwd - the absolute workspace path the client sent.
 * @returns the same path.
 */
export async function workspaceDirectory(cwd: string | null | undefined): Promise<string> {
  if (typeof cwd !== 'string' || cwd === '' || cwd.includes('\0') || !isAbsolute(cwd)) {
    throw new FilmError('BAD_REQUEST', 'An absolute workspace path (cwd) is required.')
  }
  const info = await stat(cwd).catch(() => undefined)
  if (info?.isDirectory() !== true) throw new FilmError('WORKSPACE_NOT_FOUND', `The workspace ${cwd} does not exist.`)
  return cwd
}

/**
 * Read the workspace's project.
 * @param cwd - the workspace directory.
 * @returns the project, or `null` when the workspace has none yet.
 */
export async function readProject(cwd: string): Promise<FilmProject | null> {
  let text: string
  try {
    text = await readFile(join(cwd, PROJECT_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return parseProject(text)
}

/**
 * Write a file only if nothing is at its path yet. The content goes to a
 * temporary file first and is linked into place, so the final name never
 * holds a partial file; file systems without hard links fall back to an
 * exclusive create.
 * @param path - the final path.
 * @param data - the content.
 * @returns whether the file was created (`false`: something was already there).
 */
export async function createExclusive(path: string, data: string): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, data, { flag: 'wx' })
  try {
    await link(temporary, path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS') throw error
  } finally {
    await rm(temporary, { force: true })
  }
  try {
    await writeFile(path, data, { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/**
 * Start a project in the workspace. An existing project is never replaced.
 * @param cwd - the workspace directory.
 * @param input - the title and frame.
 * @param now - the creation time.
 * @returns the new project, or the existing one with `created: false`.
 */
export async function createProject(
  cwd: string,
  input: Required<NewProject>,
  now: Date = new Date(),
): Promise<{ project: FilmProject; created: boolean }> {
  const time = now.toISOString()
  const project: FilmProject = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: randomUUID(),
    title: input.title,
    aspectRatio: input.aspectRatio,
    createdAt: time,
    updatedAt: time,
  }
  await mkdir(join(cwd, FILM_DIR), { recursive: true })
  if (await createExclusive(join(cwd, PROJECT_FILE), `${JSON.stringify(project, null, 2)}\n`)) {
    return { project, created: true }
  }
  const existing = await readProject(cwd)
  if (existing === null) throw new FilmError('PROJECT_INVALID', `${PROJECT_FILE} disappeared while it was being created.`)
  return { project: existing, created: false }
}
