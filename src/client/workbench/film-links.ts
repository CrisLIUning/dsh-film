/**
 * Requests between the workbench's sidebar tabs: the 剧本 tab asks the
 * storyboard to show a node (after 送到画布, or 定位画布 in the impact report),
 * and the storyboard's 返回编剧 asks the 剧本 tab to open a screenplay object.
 *
 * Studio passes these through its film workspace (`FilmWorkspace.tsx`
 * focus/open requests, `CanvasBoardFrame.tsx` posting `vibedev:story-focus`).
 * Here each request is a window event for the tab already showing, plus a
 * short-lived pending value per project for a tab that is still opening.
 * @module dsh-film/client/workbench/film-links
 */

/** A request to open a screenplay object. */
export interface StoryOpenRequest {
  documentId: string
  objectId: string
}

/** How long a request waits for a tab that is still loading. */
const PENDING_MS = 30_000

const FOCUS_EVENT = 'dsh-film:canvas-focus'
const OPEN_EVENT = 'dsh-film:story-open'

interface Pending<T> { value: T; at: number }

const focusPending = new Map<string, Pending<string>>()
const openPending = new Map<string, Pending<StoryOpenRequest>>()

const target = (): EventTarget | undefined => (globalThis as { window?: EventTarget }).window

function take<T>(pending: Map<string, Pending<T>>, projectId: string, now: number): T | undefined {
  const entry = pending.get(projectId)
  pending.delete(projectId)
  return entry !== undefined && now - entry.at <= PENDING_MS ? entry.value : undefined
}

function listen<T>(name: string, projectId: string, listener: (value: T) => void): () => void {
  const events = target()
  if (events === undefined) return () => {}
  const handle = (event: Event): void => {
    const detail = (event as CustomEvent<{ projectId: string; value: T }>).detail
    if (detail?.projectId === projectId) listener(detail.value)
  }
  events.addEventListener(name, handle)
  return () => { events.removeEventListener(name, handle) }
}

function announce<T>(name: string, projectId: string, value: T): void {
  target()?.dispatchEvent(new CustomEvent(name, { detail: { projectId, value } }))
}

/**
 * Ask the storyboard to centre and select a node.
 * @param projectId - the film project (its board).
 * @param nodeId - the node.
 * @param now - the clock, for tests.
 */
export function requestCanvasFocus(projectId: string, nodeId: string, now = Date.now()): void {
  focusPending.set(projectId, { value: nodeId, at: now })
  announce(FOCUS_EVENT, projectId, nodeId)
}

/**
 * The focus request a storyboard that just became ready should still apply.
 * @param projectId - the film project.
 * @param now - the clock, for tests.
 * @returns the node id, once.
 */
export function takeCanvasFocus(projectId: string, now = Date.now()): string | undefined {
  return take(focusPending, projectId, now)
}

/**
 * Follow focus requests while a storyboard is showing.
 * @param projectId - the film project.
 * @param listener - receives the node id.
 * @returns stops following.
 */
export function onCanvasFocus(projectId: string, listener: (nodeId: string) => void): () => void {
  return listen(FOCUS_EVENT, projectId, listener)
}

/**
 * Ask the 剧本 tab to open a screenplay object.
 * @param projectId - the film project.
 * @param request - the screenplay and the object.
 * @param now - the clock, for tests.
 */
export function requestStoryOpen(projectId: string, request: StoryOpenRequest, now = Date.now()): void {
  openPending.set(projectId, { value: request, at: now })
  announce(OPEN_EVENT, projectId, request)
}

/**
 * The open request a 剧本 tab that just became ready should still apply.
 * @param projectId - the film project.
 * @param now - the clock, for tests.
 * @returns the request, once.
 */
export function takeStoryOpen(projectId: string, now = Date.now()): StoryOpenRequest | undefined {
  return take(openPending, projectId, now)
}

/**
 * Follow open requests while the 剧本 tab is mounted.
 * @param projectId - the film project.
 * @param listener - receives the request.
 * @returns stops following.
 */
export function onStoryOpen(projectId: string, listener: (request: StoryOpenRequest) => void): () => void {
  return listen(OPEN_EVENT, projectId, (request: StoryOpenRequest) => {
    // Handled now, so a later mount does not replay it.
    openPending.delete(projectId)
    listener(request)
  })
}
