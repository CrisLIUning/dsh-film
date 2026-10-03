/**
 * The project of each workspace, shared by every open part: creating the
 * project in one tab shows it in the others at once. A part coming back on
 * screen reads the file again, which picks up changes the agent made.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { FilmApiError, createProject, fetchProject } from './api.ts'
import type { AspectRatio, FilmProject } from './api.ts'

export type ProjectState =
  | { status: 'loading' }
  | { status: 'ready'; project: FilmProject | null }
  | { status: 'failed'; code: string; message: string }

const LOADING: ProjectState = { status: 'loading' }

const states = new Map<string, ProjectState>()
const listeners = new Map<string, Set<() => void>>()
const reads = new Map<string, Promise<void>>()

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
  const read = fetchProject(cwd)
    .then((project) => { publish(cwd, { status: 'ready', project }) })
    .catch((error: unknown) => {
      const shown = states.get(cwd)
      const answered = error instanceof FilmApiError && error.status >= 400 && error.status < 500
      if (!answered && shown?.status === 'ready' && shown.project !== null) return
      publish(cwd, {
        status: 'failed',
        code: error instanceof FilmApiError ? error.code : 'UNREACHABLE',
        message: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => { reads.delete(cwd) })
  reads.set(cwd, read)
  return read
}

/**
 * Start the workspace's project and show it in every part.
 * @param cwd - the workspace directory.
 * @param title - the film's title.
 * @param aspectRatio - the frame.
 * @returns the project.
 */
export async function startProject(cwd: string, title: string, aspectRatio: AspectRatio): Promise<FilmProject> {
  const project = await createProject(cwd, title, aspectRatio)
  publish(cwd, { status: 'ready', project })
  return project
}

/**
 * The workspace's project state, read on first use and again whenever the
 * part comes back on screen.
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
  const reload = useCallback(() => {
    if (states.get(cwd)?.status === 'failed') publish(cwd, LOADING)
    void readProject(cwd)
  }, [cwd])
  return { state, reload }
}
