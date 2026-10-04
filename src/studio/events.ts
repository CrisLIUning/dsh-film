/**
 * Project events the hosted apps listen for on `/api/projects/:id/events`
 * (`file-changed`, `story-changed`, `story-canvas-changed`), per workspace.
 * Every event also drops the workspace's cached media listing: whatever the
 * plugin just wrote is listed by the next read.
 * @module dsh-film/studio/events
 */

import { resolve } from 'node:path'
import { invalidateWorkspaceMedia } from '../media.js'

export interface ProjectEvent {
  type: 'file-changed' | 'story-changed' | 'story-canvas-changed'
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
    invalidateWorkspaceMedia(cwd)
    for (const listener of this.listeners.get(resolve(cwd)) ?? []) {
      try {
        listener(event)
      } catch {
        // One broken subscriber must not stop the others.
      }
    }
  }
}
