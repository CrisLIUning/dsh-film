/**
 * Project events the hosted apps listen for on `/api/projects/:id/events`
 * (`file-changed`, `story-changed`, `story-canvas-changed`, and
 * `project-changed` with the film's new title or frame), per workspace.
 * @module dsh-film/studio/events
 */

import { resolve } from 'node:path'

export interface ProjectEvent {
  type: 'file-changed' | 'story-changed' | 'story-canvas-changed' | 'project-changed'
  [key: string]: unknown
}

type Listener = (event: ProjectEvent) => void

export class ProjectEvents {
  private readonly listeners = new Map<string, Set<Listener>>()

  /**
   * Listen to one workspace's events.
   * @param cwd - the workspace directory.
   * @param listener - called with each event.
   * @returns stops listening.
   */
  subscribe(cwd: string, listener: Listener): () => void {
    const key = resolve(cwd)
    let set = this.listeners.get(key)
    if (set === undefined) this.listeners.set(key, set = new Set())
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(key)
    }
  }

  emit(cwd: string, event: ProjectEvent): void {
    for (const listener of this.listeners.get(resolve(cwd)) ?? []) {
      try {
        listener(event)
      } catch {
        // One broken subscriber must not stop the others.
      }
    }
  }
}
