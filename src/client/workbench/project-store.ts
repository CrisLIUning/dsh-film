/**
 * The project of each workspace, shared by every open part: a change made in
 * one tab shows in the others at once. A part coming back on screen reads the
 * file again, which picks up changes the agent made.
 *
 * There is no form to start a film: the first part on screen that finds none
 * asks the Host to create it (one request per workspace at a time, and only
 * after the Host answered "no film", never over a broken or newer project file).
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { FilmApiError, ensureProject as ensureOnHost, fetchProject, updateProject } from './api.ts'
import type { FilmProject, ProjectChange } from './api.ts'

export type ProjectState =
  | { status: 'loading' }
  | { status: 'ready'; project: FilmProject | null }
  /** `during: 'start'`: creating the film failed, rather than reading it. */
  | { status: 'failed'; code: string; message: string; during?: 'start' }

const LOADING: ProjectState = { status: 'loading' }

const states = new Map<string, ProjectState>()
const listeners = new Map<string, Set<() => void>>()
const reads = new Map<string, Promise<void>>()
const ensures = new Map<string, Promise<void>>()
/** Counts the project versions this window wrote, so a read that started before one cannot undo it. */
const writes = new Map<string, number>()

/**
 * The workspace's project state as last read.
 * @param cwd - the workspace directory.
 * @returns the state; `loading` before the first read settles.
 */
export function projectState(cwd: string): ProjectState {
  return states.get(cwd) ?? LOADING
}

function publish(cwd: string, state: ProjectState): void {
  states.set(cwd, state)
  for (const listener of listeners.get(cwd) ?? []) listener()
}

/** Show a project this window just wrote. */
function publishWritten(cwd: string, project: FilmProject): void {
  writes.set(cwd, (writes.get(cwd) ?? 0) + 1)
  publish(cwd, { status: 'ready', project })
}

const failure = (error: unknown): { code: string; message: string } => ({
  code: error instanceof FilmApiError ? error.code : 'UNREACHABLE',
  message: error instanceof Error ? error.message : String(error),
})

/**
 * Read the workspace's project file, once at a time per workspace. When the
 * Host could not be reached, a project already shown stays on screen; when
 * the Host answered that the file is broken or gone, that answer replaces it.
 * @param cwd - the workspace directory.
 * @returns settles when the read is done.
 */
export function readProject(cwd: string): Promise<void> {
  const running = reads.get(cwd)
  if (running !== undefined) return running
  const written = writes.get(cwd) ?? 0
  const read = fetchProject(cwd)
    .then((project) => {
      // This window created or changed the film while the read was out: the read is older.
      if ((writes.get(cwd) ?? 0) !== written) return
      publish(cwd, { status: 'ready', project })
    })
    .catch((error: unknown) => {
      const shown = states.get(cwd)
      const answered = error instanceof FilmApiError && error.status >= 400 && error.status < 500
      if (!answered && shown?.status === 'ready' && shown.project !== null) return
      publish(cwd, { status: 'failed', ...failure(error) })
    })
    .finally(() => { reads.delete(cwd) })
  reads.set(cwd, read)
  return read
}

/**
 * Create the workspace's film when the Host said it has none: one request at
 * a time per workspace, and nothing at all unless the state shown is exactly
 * "read, no film" (a broken, newer or unreadable project file is never
 * started over).
 * @param cwd - the workspace directory.
 * @returns settles when the film is shown, or the failure is.
 */
export function ensureProject(cwd: string): Promise<void> {
  const running = ensures.get(cwd)
  if (running !== undefined) return running
  const shown = states.get(cwd)
  if (shown?.status !== 'ready' || shown.project !== null) return Promise.resolve()
  const ensure = ensureOnHost(cwd)
    .then(({ project }) => { publishWritten(cwd, project) })
    .catch((error: unknown) => { publish(cwd, { status: 'failed', ...failure(error), during: 'start' }) })
    .finally(() => { ensures.delete(cwd) })
  ensures.set(cwd, ensure)
  return ensure
}

/**
 * Rename the film or change its frame, and show the result in every part.
 * @param cwd - the workspace directory.
 * @param change - the new title and/or frame.
 * @returns the film as saved; a refusal is thrown for the caller to show.
 */
export async function changeProject(cwd: string, change: ProjectChange): Promise<FilmProject> {
  const project = await updateProject(cwd, change)
  publishWritten(cwd, project)
  return project
}

/**
 * The workspace's project state, read on first use and again whenever the
 * part comes back on screen; a part on screen that finds no film creates it.
 * @param cwd - the workspace directory.
 * @param visible - whether the part is on screen.
 * @returns the state and a way to read the file again.
 */
export function useProject(cwd: string, visible: boolean): { state: ProjectState; reload: () => void } {
  const subscribe = useCallback((listener: () => void) => {
    let set = listeners.get(cwd)
    if (set === undefined) listeners.set(cwd, set = new Set())
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(cwd)
    }
  }, [cwd])
  const state = useSyncExternalStore(subscribe, () => projectState(cwd))
  useEffect(() => {
    if (visible) void readProject(cwd)
  }, [cwd, visible])
  const missing = state.status === 'ready' && state.project === null
  useEffect(() => {
    if (visible && missing) void ensureProject(cwd)
  }, [cwd, visible, missing])
  const reload = useCallback(() => {
    if (states.get(cwd)?.status === 'failed') publish(cwd, LOADING)
    void readProject(cwd)
  }, [cwd])
  return { state, reload }
}
