/**
 * The film project: one per workspace, described by `film/film.json`. The
 * project file names the film and its frame; the other parts (script,
 * storyboard, timeline, director scenes) live beside it under `film/`.
 *
 * The workbench creates the film the first time one of its tabs is on screen,
 * named after the workspace folder; the person renames it and picks its frame
 * in the tabs' shared header.
 * @module dsh-film/project
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CanvasDocumentStore, emptyFilmBoard, savedBoardId } from './canvas/documents.js'
import { FilmError } from './errors.js'
import { createExclusive, withFileLock } from './file-writes.js'
import { refusedFolderOf } from './path-rules.js'

export { createExclusive } from './file-writes.js'

/** The folder under the workspace that holds every film file. */
export const FILM_DIR = 'film'
/** The project file, relative to the workspace. */
export const PROJECT_FILE = `${FILM_DIR}/film.json`
/** The project file's format tag and version. */
export const PROJECT_FORMAT = 'vibedev.film'
export const PROJECT_VERSION = 1

/**
 * Frames a film can be given: exactly the editing desk's own set (the video
 * editor's `HOST_PROJECT_ASPECTS`), so a new cut opens in the film's frame.
 */
export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5', '21:9', '2.39:1'] as const
export type AspectRatio = typeof ASPECT_RATIOS[number]

/**
 * Frames earlier versions offered that the editing desk does not cut in. A
 * film that has one keeps it and shows it as it is; it is never offered.
 */
export const LEGACY_ASPECT_RATIOS = ['4:3'] as const
/** A frame a project file may hold. */
export type StoredAspectRatio = AspectRatio | typeof LEGACY_ASPECT_RATIOS[number]

/** The frame of a film nobody chose one for. */
export const DEFAULT_ASPECT_RATIO: AspectRatio = '16:9'

/** The longest title, in characters. */
export const TITLE_MAX = 80

/** The title of a film whose workspace folder gives no name. */
export const UNTITLED = 'Untitled film'

/** The contents of `film/film.json`. */
export interface FilmProject {
  format: typeof PROJECT_FORMAT
  version: typeof PROJECT_VERSION
  /** Stable identity, kept when the folder is copied or renamed. */
  id: string
  title: string
  aspectRatio: StoredAspectRatio
  /** ISO 8601 times. */
  createdAt: string
  updatedAt: string
}

/** What a new project is made with. */
export interface NewProject {
  title: string
  aspectRatio: AspectRatio
}

/** A change to a project: a new title, a new frame, or both. */
export interface ProjectChange {
  title?: string
  aspectRatio?: AspectRatio
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAspectRatio = (value: unknown): value is AspectRatio =>
  typeof value === 'string' && (ASPECT_RATIOS as readonly string[]).includes(value)

const isStoredAspectRatio = (value: unknown): value is StoredAspectRatio =>
  isAspectRatio(value) || (typeof value === 'string' && (LEGACY_ASPECT_RATIOS as readonly string[]).includes(value))

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
 * The title a film starts with: its workspace folder's name, cleaned.
 * @param cwd - the workspace directory.
 * @returns the folder name, or {@link UNTITLED} when it gives none.
 */
export function defaultTitle(cwd: string): string {
  return cleanTitle(basename(cwd)) || UNTITLED
}

function parseAspectRatio(value: unknown): AspectRatio {
  if (!isAspectRatio(value)) throw new FilmError('BAD_REQUEST', `aspectRatio must be one of ${ASPECT_RATIOS.join(', ')}.`)
  return value
}

/**
 * Validate the input for a new project. Everything is optional: no title (or
 * a blank one) names the film after its folder, and the frame defaults to 16:9.
 * @param input - the request body or tool arguments.
 * @param cwd - the workspace directory, for the default title.
 * @returns the title and frame to create the project with.
 */
export function parseNewProject(input: unknown, cwd: string): NewProject {
  if (!isRecord(input)) throw new FilmError('BAD_REQUEST', 'The request body must be a JSON object.')
  if (input.title !== undefined && input.title !== null && typeof input.title !== 'string') throw new FilmError('BAD_REQUEST', 'title must be a string.')
  const title = typeof input.title === 'string' ? cleanTitle(input.title) : ''
  return {
    title: title === '' ? defaultTitle(cwd) : title,
    aspectRatio: input.aspectRatio === undefined || input.aspectRatio === null ? DEFAULT_ASPECT_RATIO : parseAspectRatio(input.aspectRatio),
  }
}

/**
 * Validate a change to a project: a non-blank title, a frame the editing desk
 * cuts in, or both.
 * @param input - the request body or tool arguments.
 * @returns the change.
 */
export function parseProjectChange(input: unknown): ProjectChange {
  if (!isRecord(input)) throw new FilmError('BAD_REQUEST', 'The request body must be a JSON object.')
  const change: ProjectChange = {}
  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? cleanTitle(input.title) : ''
    if (title === '') throw new FilmError('BAD_REQUEST', 'A title must have at least one visible character.')
    change.title = title
  }
  if (input.aspectRatio !== undefined) change.aspectRatio = parseAspectRatio(input.aspectRatio)
  if (change.title === undefined && change.aspectRatio === undefined) throw new FilmError('BAD_REQUEST', 'Give a title, an aspectRatio or both.')
  return change
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
  if (!isStoredAspectRatio(aspectRatio)) throw new FilmError('PROJECT_INVALID', `${PROJECT_FILE} has an unknown aspectRatio.`)
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
 * Refuse a workspace inside a hidden folder or a credential store (`.ssh`,
 * `.aws`, `.gnupg`, `.azure`, `.kube`), by the path given and by its real
 * path, so a link cannot carry a film into one. A film is never started
 * there, and nothing there is served or imported.
 * @param cwd - the workspace directory.
 */
export async function checkWorkspaceLocation(cwd: string): Promise<void> {
  const real = await realpath(cwd).catch(() => cwd)
  for (const path of new Set([cwd, real])) {
    const folder = refusedFolderOf(path)
    if (folder !== undefined) {
      throw new FilmError('WORKSPACE_REFUSED', `The workspace ${cwd} is inside the hidden or credential folder "${folder}"; the film workbench does not keep or read a film there.`)
    }
  }
}

/**
 * Check that a workspace is a film workspace: in a place a film may be (see
 * {@link checkWorkspaceLocation}) and with its project file. Routes that read
 * the workspace outside `film/` (playing and importing its media) require it,
 * so a caller cannot point them at any folder it likes.
 * @param cwd - the workspace directory, already checked by {@link workspaceDirectory}.
 * @returns the film project.
 */
export async function requireFilmWorkspace(cwd: string): Promise<FilmProject> {
  await checkWorkspaceLocation(cwd)
  const project = await readProject(cwd)
  if (project === null) throw new FilmError('PROJECT_NOT_FOUND', `The workspace ${cwd} has no film project (${PROJECT_FILE}).`)
  return project
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

/** How often, and how far apart, a project file another writer is still writing is read again. */
const LOSER_READS = 10
const LOSER_READ_DELAY_MS = 20

/**
 * Read the project another writer has just created. Where hard links are
 * missing, {@link createExclusive} creates the file and then writes it, so the
 * first read may meet an empty or half-written file: it is read again for a
 * moment before a broken file is reported.
 * @param cwd - the workspace directory.
 * @returns the project.
 */
async function readCreatedProject(cwd: string): Promise<FilmProject> {
  for (let attempt = 1; ; attempt++) {
    let project: FilmProject | null
    try {
      project = await readProject(cwd)
    } catch (error) {
      if (!(error instanceof FilmError) || error.code !== 'PROJECT_INVALID' || attempt >= LOSER_READS) throw error
      project = null
    }
    if (project !== null) return project
    if (attempt >= LOSER_READS) throw new FilmError('PROJECT_INVALID', `${PROJECT_FILE} disappeared while it was being created.`)
    await delay(LOSER_READ_DELAY_MS)
  }
}

/**
 * Start a project in the workspace, with its empty storyboard. An existing
 * project is never replaced, and neither is a board already saved (even a
 * damaged one) or the tombstone of the board deleted under the new film's id;
 * a tombstone an older board left is cleared (see {@link CanvasDocumentStore.create}).
 * A board saved before the film existed keeps its place: the film takes that
 * board's id. A workspace inside a hidden or credential folder is refused
 * ({@link checkWorkspaceLocation}).
 * @param cwd - the workspace directory.
 * @param input - the title and frame.
 * @param now - the creation time.
 * @returns the new project, or the existing one with `created: false`.
 */
export async function createProject(
  cwd: string,
  input: NewProject,
  now: Date = new Date(),
): Promise<{ project: FilmProject; created: boolean }> {
  await checkWorkspaceLocation(cwd)
  const time = now.toISOString()
  await mkdir(join(cwd, FILM_DIR), { recursive: true })
  const project: FilmProject = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: await savedBoardId(cwd) ?? randomUUID(),
    title: input.title,
    aspectRatio: input.aspectRatio,
    createdAt: time,
    updatedAt: time,
  }
  if (await createExclusive(join(cwd, PROJECT_FILE), `${JSON.stringify(project, null, 2)}\n`)) {
    // The film exists either way: a board that could not be written now is
    // made when the storyboard first lists its boards.
    await new CanvasDocumentStore(cwd, project.id).create(emptyFilmBoard(project.id, project.title, time)).catch(() => undefined)
    return { project, created: true }
  }
  return { project: await readCreatedProject(cwd), created: false }
}

/**
 * Rename the film or change its frame. The file is replaced atomically under
 * its lock, and fields this version does not know are kept. A frame applies to
 * new cuts; an existing cut keeps its own until it is changed in the editing desk.
 * @param cwd - the workspace directory.
 * @param change - the new title and/or frame.
 * @param now - the change time.
 * @returns the project as saved, and whether anything changed.
 */
export async function updateProject(
  cwd: string,
  change: ProjectChange,
  now: Date = new Date(),
): Promise<{ project: FilmProject; changed: boolean }> {
  const path = join(cwd, PROJECT_FILE)
  return withFileLock(path, async () => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FilmError('PROJECT_NOT_FOUND', 'This workspace has no film yet; it is created when a film tab opens.')
      }
      throw error
    }
    const current = parseProject(text)
    const title = change.title ?? current.title
    const aspectRatio = change.aspectRatio ?? current.aspectRatio
    if (title === current.title && aspectRatio === current.aspectRatio) return { project: current, changed: false }
    const project: FilmProject = { ...current, title, aspectRatio, updatedAt: now.toISOString() }
    const raw = JSON.parse(text) as Record<string, unknown>
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({ ...raw, ...project }, null, 2)}\n`, 'utf8')
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
    return { project, changed: true }
  })
}
