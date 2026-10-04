/**
 * The 剧本 tab's state: the workspace's screenplays, the open one, the
 * person's unsaved text and what stands between them (ported from Studio's
 * `useStoryDocument`, as a store the view subscribes to).
 *
 * Body edits save by themselves shortly after typing stops, against the
 * revision they were made on. The agent and other tabs edit the same files:
 * a change on disk is taken over while the person has nothing unsaved, and
 * otherwise held as a conflict they settle. Card and structure edits are
 * operations the plugin applies to the saved file; they wait until the body
 * is saved.
 */

import type { StoryDiagnostic, StoryDocument, StoryDocumentKind, StoryDocumentSummary, StoryMutationResult, StoryOperation } from '../../../screenwriter/contracts/types.ts'
import { StoryApiError, StoryConflictError } from './story-api.ts'
import type { StoryApi } from './story-api.ts'

export interface StoryState {
  status: 'loading' | 'ready' | 'failed'
  documents: StoryDocumentSummary[]
  /** The open screenplay as last saved or read. */
  document: StoryDocument | null
  /** The body as the person has it. */
  draft: string
  saving: boolean
  /** The last autosave failed; it is retried on the next edit or on request. */
  saveFailed: boolean
  /** The version on disk, when it moved while the person had unsaved text. */
  conflict: StoryDocument | null
  error: { message: string; diagnostics: StoryDiagnostic[] } | null
  /** Bumps when the open text is replaced from outside (another document, the agent, a restore). */
  epoch: number
}

export interface StoryStoreOptions {
  api: StoryApi
  /** Opens the project's change stream; calls back on every screenplay change. */
  watch?: (onChange: () => void) => () => void
  /** How long typing must pause before a save. */
  saveDelayMs?: number
  /** How often the open screenplay is re-read while the tab shows. */
  pollMs?: number
  randomId?: () => string
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export class StoryStore {
  private state: StoryState = { status: 'loading', documents: [], document: null, draft: '', saving: false, saveFailed: false, conflict: null, error: null, epoch: 0 }
  private readonly listeners = new Set<() => void>()
  private readonly api: StoryApi
  private readonly watch: StoryStoreOptions['watch']
  private readonly saveDelayMs: number
  private readonly pollMs: number
  private readonly randomId: () => string
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private stopWatching: (() => void) | undefined
  /** The write in flight or last refused, reused (with its operation id) when retried unchanged. */
  private pendingWrite: { documentId: string; expectedRevision: string; content: string; operationId: string } | undefined
  private busy = false
  private refreshing = false
  /** Invalidates answers to requests made for an earlier document or before a dispose. */
  private generation = 0
  private disposed = false

  constructor(options: StoryStoreOptions) {
    this.api = options.api
    this.watch = options.watch
    this.saveDelayMs = options.saveDelayMs ?? 800
    this.pollMs = options.pollMs ?? 5000
    this.randomId = options.randomId ?? (() => crypto.randomUUID())
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getState = (): StoryState => this.state

  private set(change: Partial<StoryState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }

  /** Whether the body has text that is not saved. */
  get dirty(): boolean {
    return this.state.document !== null && this.state.draft !== this.state.document.content
  }

  /** Whether card and structure operations may run now. */
  get canMutate(): boolean {
    const { document, saving, conflict } = this.state
    return document !== null && !saving && !this.busy && conflict === null && !this.dirty && document.parsed.semanticEditable
  }

  private accept(document: StoryDocument, replaced = true): void {
    this.set({
      status: 'ready',
      document,
      draft: document.content,
      conflict: null,
      error: null,
      saveFailed: false,
      documents: [...this.state.documents.filter(item => item.documentId !== document.documentId), summaryOf(document)].sort(byTitle),
      ...(replaced ? { epoch: this.state.epoch + 1 } : {}),
    })
  }

  private fail(error: unknown): void {
    if (error instanceof StoryConflictError) this.set({ conflict: error.current })
    this.set({ error: { message: message(error), diagnostics: error instanceof StoryApiError ? error.diagnostics : [] } })
  }

  /** Read the list and open the first screenplay. */
  async start(): Promise<void> {
    const token = ++this.generation
    try {
      const documents = await this.api.list()
      if (token !== this.generation) return
      this.set({ documents })
      const first = documents[0]
      if (first !== undefined) {
        const document = await this.api.read(first.documentId)
        if (token !== this.generation) return
        this.accept(document)
      }
      this.set({ status: 'ready' })
    } catch (error) {
      if (token !== this.generation) return
      this.set({ status: 'failed' })
      this.fail(error)
    }
  }

  /**
   * Show or hide the tab: a showing tab follows changes on disk.
   * @param visible - whether the tab is on screen.
   */
  setVisible(visible: boolean): void {
    if (this.disposed) return
    if (visible && this.pollTimer === undefined) {
      this.pollTimer = setInterval(() => { void this.refresh() }, this.pollMs)
      this.stopWatching = this.watch?.(() => { void this.refresh() })
      void this.refresh()
    } else if (!visible && this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
      this.stopWatching?.()
      this.stopWatching = undefined
    }
  }

  /**
   * Open another screenplay; refused while the open one has unsaved text.
   * @param documentId - the screenplay.
   * @returns whether it opened.
   */
  async open(documentId: string): Promise<boolean> {
    if (this.dirty || this.state.saving || this.busy) return false
    const token = ++this.generation
    try {
      const document = await this.api.read(documentId)
      if (token !== this.generation) return false
      this.accept(document)
      return true
    } catch (error) {
      if (token === this.generation) this.fail(error)
      return false
    }
  }

  /**
   * The person changed the body; it saves once typing pauses.
   * @param draft - the whole file as it now reads.
   */
  edit(draft: string): void {
    if (this.state.document === null || draft === this.state.draft) return
    this.set({ draft })
    this.scheduleSave()
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer)
    if (this.state.conflict !== null) return
    this.saveTimer = setTimeout(() => { void this.save() }, this.saveDelayMs)
  }

  /** Save the body now (a pending autosave, or a retry after a failure). */
  async save(): Promise<boolean> {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const current = this.state.document
    if (current === null || this.state.conflict !== null || !this.dirty) return true
    if (this.state.saving) {
      // The answer to the save in flight schedules the next one.
      return false
    }
    const content = this.state.draft
    const pending = this.pendingWrite
    const request = pending?.documentId === current.documentId && pending.expectedRevision === current.revision && pending.content === content
      ? pending
      : { documentId: current.documentId, expectedRevision: current.revision, content, operationId: this.randomId() }
    this.pendingWrite = request
    const token = this.generation
    this.set({ saving: true, error: null })
    try {
      const result = await this.api.write(current.documentId, { expectedRevision: request.expectedRevision, content: request.content, operationId: request.operationId })
      if (this.pendingWrite === request) this.pendingWrite = undefined
      if (token !== this.generation) return false
      // Typing that went on during the save stays, and saves next.
      const draft = this.state.draft
      this.set({
        document: result.document,
        saving: false,
        saveFailed: false,
        documents: this.state.documents.map(item => item.documentId === result.document.documentId ? summaryOf(result.document) : item).sort(byTitle),
      })
      if (draft !== result.document.content) this.scheduleSave()
      return true
    } catch (error) {
      if (token === this.generation) {
        this.set({ saving: false, saveFailed: !(error instanceof StoryConflictError) })
        this.fail(error)
      }
      return false
    }
  }

  /** Re-read the list and the open screenplay; take over a change on disk unless the person has unsaved text. */
  async refresh(): Promise<void> {
    // The first load opens the first screenplay itself; a poll racing it would supersede it.
    if (this.refreshing || this.disposed || this.state.status !== 'ready') return
    this.refreshing = true
    const token = this.generation
    const before = this.state.document
    try {
      const [documents, latest] = await Promise.all([
        this.api.list(),
        before === null ? Promise.resolve(null) : this.api.read(before.documentId).catch((error: unknown) => {
          // The open screenplay was deleted or renamed away: keep showing the text.
          if (error instanceof StoryApiError && error.status === 404) return null
          throw error
        }),
      ])
      if (token !== this.generation || this.state.saving || this.busy) return
      this.set({ documents })
      if (before === null) {
        const first = documents[0]
        if (first !== undefined) await this.open(first.documentId)
        return
      }
      if (latest === null || this.state.document?.revision !== before.revision || latest.revision === before.revision) return
      if (this.dirty) this.set({ conflict: latest })
      else this.accept(latest)
    } catch {
      // A missed poll is retried on the next one; the person's text is untouched.
    } finally {
      this.refreshing = false
    }
  }

  /**
   * Apply operations to the saved screenplay (cards, scenes, shots).
   * @param operations - the operations.
   * @returns whether they were applied.
   */
  async apply(operations: StoryOperation[]): Promise<boolean> {
    return this.mutate(current => this.api.apply(current.documentId, { expectedRevision: current.revision, operations, operationId: this.randomId() }))
  }

  /**
   * Change the saved screenplay through the plugin, with nothing unsaved.
   * @param change - the request, given the screenplay it builds on.
   * @param recover - handles a failure itself (answers true) instead of showing it.
   * @returns whether the change landed.
   */
  async mutate(change: (current: StoryDocument) => Promise<StoryMutationResult>, recover?: (error: unknown) => boolean): Promise<boolean> {
    const current = this.state.document
    if (current === null || !this.canMutate) return false
    this.busy = true
    const token = this.generation
    this.set({ saving: true, error: null })
    try {
      const result = await change(current)
      if (token !== this.generation) return false
      this.set({ saving: false })
      this.accept(result.document)
      return true
    } catch (error) {
      if (token === this.generation) {
        this.set({ saving: false })
        if (recover?.(error) !== true) this.fail(error)
      }
      return false
    } finally {
      this.busy = false
    }
  }

  /**
   * Start a screenplay and open it.
   * @param title - its title.
   * @param kind - a short film or an episode.
   */
  async create(title: string, kind: StoryDocumentKind): Promise<boolean> {
    if (this.dirty || this.state.saving || this.busy) return false
    this.busy = true
    const token = ++this.generation
    this.set({ saving: true, error: null })
    try {
      const result = await this.api.create({ title, kind })
      if (token !== this.generation) return false
      this.set({ saving: false })
      this.accept(result.document)
      return true
    } catch (error) {
      if (token === this.generation) {
        this.set({ saving: false })
        this.fail(error)
      }
      return false
    } finally {
      this.busy = false
    }
  }

  /**
   * Create a screenplay from an import and open it (Studio's
   * `useStoryDocument.importCopy`). Refused while the open one has unsaved
   * text; if the person typed while the import ran, their text stays open and
   * the copy only joins the list.
   * @param run - the import request.
   * @param recover - handles a failure itself (answers true) instead of showing it.
   * @returns whether the copy opened.
   */
  async importCopy(run: () => Promise<StoryMutationResult>, recover?: (error: unknown) => boolean): Promise<boolean> {
    if (this.dirty || this.state.saving || this.busy) return false
    this.busy = true
    // Answers to reads started before the import (a pending open or refresh) no longer apply.
    const token = ++this.generation
    const baseline = this.state.draft
    this.set({ saving: true, error: null })
    try {
      const result = await run()
      if (token !== this.generation) return false
      this.set({ saving: false })
      if (this.state.draft !== baseline) {
        try {
          this.set({ documents: await this.api.list() })
        } catch {
          // The next poll lists the copy.
        }
        this.scheduleSave()
        return false
      }
      this.generation += 1
      this.accept(result.document)
      return true
    } catch (error) {
      if (token === this.generation) {
        this.set({ saving: false })
        if (recover?.(error) !== true) this.fail(error)
      }
      return false
    } finally {
      this.busy = false
    }
  }

  /**
   * Show a failure from a call the view made itself (sending to the canvas):
   * a stale revision brings in the version on disk first.
   * @param error - what the call threw.
   */
  report(error: unknown): void {
    if (error instanceof StoryConflictError) this.replace(error.current)
    this.set({ error: { message: message(error), diagnostics: error instanceof StoryApiError ? error.diagnostics : [] } })
  }

  /**
   * Show a newer version of the open screenplay that a card save read,
   * unless the person has unsaved text.
   * @param document - the newer version.
   */
  replace(document: StoryDocument): void {
    if (this.dirty || document.documentId !== this.state.document?.documentId) return
    this.accept(document)
  }

  /** Drop the person's unsaved text for the version on disk. */
  adopt(): void {
    const latest = this.state.conflict
    if (latest === null) return
    clearTimeout(this.saveTimer)
    this.pendingWrite = undefined
    this.accept(latest)
  }

  /**
   * Settle a conflict with the given text, written over the version on disk.
   * @param content - the text to keep.
   */
  async resolve(content: string): Promise<boolean> {
    const latest = this.state.conflict
    if (latest === null || this.state.saving) return false
    clearTimeout(this.saveTimer)
    this.pendingWrite = undefined
    const token = this.generation
    this.set({ saving: true, error: null })
    try {
      const result = await this.api.write(latest.documentId, { expectedRevision: latest.revision, content, operationId: this.randomId() })
      if (token !== this.generation) return false
      this.set({ saving: false })
      this.accept(result.document)
      return true
    } catch (error) {
      if (token === this.generation) {
        this.set({ saving: false })
        this.fail(error)
      }
      return false
    }
  }

  /**
   * Bring back a saved version.
   * @param versionId - the version.
   */
  async restore(versionId: string): Promise<boolean> {
    return this.mutate(current => this.api.restore(current.documentId, { expectedRevision: current.revision, versionId, operationId: this.randomId() }))
  }

  /** Clear the shown error. */
  dismissError(): void {
    this.set({ error: null })
  }

  /** Stop following changes; a pending autosave goes out first. */
  dispose(): void {
    if (this.disposed) return
    if (this.saveTimer !== undefined) void this.save()
    this.disposed = true
    clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.stopWatching?.()
    this.listeners.clear()
  }
}

function summaryOf(document: StoryDocument): StoryDocumentSummary {
  const { documentId, title, kind, filePath, revision, updatedAt } = document
  return { documentId, title, kind, filePath, revision, updatedAt }
}

function byTitle(left: StoryDocumentSummary, right: StoryDocumentSummary): number {
  return left.title.localeCompare(right.title, undefined, { numeric: true }) || left.documentId.localeCompare(right.documentId)
}
