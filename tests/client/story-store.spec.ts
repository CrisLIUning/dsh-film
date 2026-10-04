/** The 剧本 tab's state: autosave, changes on disk, conflicts and operations, against a stand-in API. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoryDocument, StoryMutationResult } from '../../src/screenwriter/contracts/types.ts'
import { StoryApiError, StoryConflictError } from '../../src/client/workbench/story/story-api.ts'
import type { StoryApi } from '../../src/client/workbench/story/story-api.ts'
import { StoryStore } from '../../src/client/workbench/story/story-store.ts'

const doc = (documentId: string, content: string, revision: string, title = documentId): StoryDocument => ({
  documentId,
  title,
  kind: 'short',
  filePath: `film/story/${documentId}.md`,
  revision,
  updatedAt: '2026-10-04T00:00:00.000Z',
  content,
  parsed: { source: content, format: 'plain', metadata: null, metadataRange: null, blocks: [], diagnostics: [], semanticEditable: true },
  versionId: null,
})

/** An in-memory plugin: one revision per write, writes checked against it. */
function fakeApi(initial: StoryDocument[]) {
  const files = new Map(initial.map(item => [item.documentId, item]))
  let counter = 0
  const writes: { documentId: string; expectedRevision: string; content: string; operationId: string }[] = []
  let gate: Promise<void> | undefined
  let failNext: Error | undefined
  const commit = (documentId: string, content: string): StoryMutationResult => {
    const next = doc(documentId, content, `r${++counter}`, files.get(documentId)?.title)
    files.set(documentId, next)
    return { document: next, changed: true }
  }
  const api: StoryApi = {
    // Sorted by title, as the plugin lists them.
    list: async () => [...files.values()].map(({ content: _c, parsed: _p, versionId: _v, ...summary }) => summary).sort((x, y) => x.title.localeCompare(y.title)),
    read: async (documentId) => {
      const found = files.get(documentId)
      if (found === undefined) throw new StoryApiError('not found', 404, 'STORY_NOT_FOUND')
      return found
    },
    create: async ({ title }) => {
      const created = doc(`doc_${++counter}`, `# ${title}\n`, `r${counter}`, title)
      files.set(created.documentId, created)
      return { document: created, changed: true }
    },
    write: async (documentId, input) => {
      writes.push({ documentId, ...input })
      if (gate !== undefined) await gate
      if (failNext !== undefined) {
        const error = failNext
        failNext = undefined
        throw error
      }
      const current = files.get(documentId)!
      if (current.revision !== input.expectedRevision) throw new StoryConflictError('changed', current)
      return commit(documentId, input.content)
    },
    apply: vi.fn(async (documentId: string, input: { expectedRevision: string; operations: unknown[] }) => {
      const current = files.get(documentId)!
      if (current.revision !== input.expectedRevision) throw new StoryConflictError('changed', current)
      return commit(documentId, `${current.content}<!-- ${input.operations.length} operations -->\n`)
    }),
    deletionPreview: async () => { throw new Error('unused') },
    history: async () => [],
    version: async () => { throw new Error('unused') },
    checkpoint: async () => { throw new Error('unused') },
    restore: async (documentId) => commit(documentId, 'restored\n'),
    assets: async () => [],
    references: async () => [],
    bind: async () => { throw new Error('unused') },
    unbind: async () => { throw new Error('unused') },
    fileUrl: path => path,
    referenceUrl: (documentId, assetId, versionId) => `${documentId}/${assetId}/${versionId}`,
    studioUrl: path => path,
    previewImport: async () => { throw new Error('unused') },
    importCopy: async ({ content }) => {
      if (gate !== undefined) await gate
      const created = doc(`doc_${++counter}`, content, `r${counter}`, `副本 ${counter}`)
      files.set(created.documentId, created)
      return { document: created, changed: true }
    },
    exportDocument: async () => { throw new Error('unused') },
    source: async () => { throw new Error('unused') },
    handoff: async () => { throw new Error('unused') },
    impact: async () => { throw new Error('unused') },
  }
  return {
    api,
    writes,
    files,
    /** Hold writes until the returned function is called. */
    holdWrites: () => {
      let release!: () => void
      gate = new Promise((resolve) => { release = resolve })
      return () => { gate = undefined; release() }
    },
    failNextWrite: (error: Error) => { failNext = error },
    /** Someone else (the agent) edits a file. */
    external: (documentId: string, content: string) => commit(documentId, content),
  }
}

const make = (fake: ReturnType<typeof fakeApi>) => {
  let ids = 0
  return new StoryStore({ api: fake.api, saveDelayMs: 500, pollMs: 60_000, randomId: () => `op-${++ids}` })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the screenplay store', () => {
  it('opens the first screenplay and saves a pause after typing, against the revision typed on', async () => {
    const fake = fakeApi([doc('b', 'second\n', 'r-b', '乙'), doc('a', 'first\n', 'r-a', '甲')])
    const store = make(fake)
    await store.start()
    expect(store.getState()).toMatchObject({ status: 'ready', draft: 'first\n', epoch: 1 })
    expect(store.getState().documents.map(item => item.title)).toEqual(['甲', '乙'])
    store.edit('first\nmore\n')
    expect(store.dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(499)
    expect(fake.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.writes).toEqual([{ documentId: 'a', expectedRevision: 'r-a', content: 'first\nmore\n', operationId: 'op-1' }])
    expect(store.dirty).toBe(false)
    expect(store.getState()).toMatchObject({ saving: false, saveFailed: false })
  })

  it('finishes loading when the tab shows while the first screenplay is being read', async () => {
    const fake = fakeApi([doc('a', 'first\n', 'r-a')])
    const store = make(fake)
    const started = store.start()
    store.setVisible(true)
    await started
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState()).toMatchObject({ status: 'ready', draft: 'first\n' })
    store.dispose()
  })

  it('saves typing done during a save next, on the new revision', async () => {
    const fake = fakeApi([doc('a', 'x\n', 'r0')])
    const store = make(fake)
    await store.start()
    const release = fake.holdWrites()
    store.edit('x\n1\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(store.getState().saving).toBe(true)
    store.edit('x\n1\n2\n')
    await vi.advanceTimersByTimeAsync(500)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().draft).toBe('x\n1\n2\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(fake.writes.map(write => [write.expectedRevision, write.content])).toEqual([['r0', 'x\n1\n'], ['r1', 'x\n1\n2\n']])
    expect(store.dirty).toBe(false)
  })

  it('retries a failed save with the same operation, and stops at a conflict until it is settled', async () => {
    const fake = fakeApi([doc('a', 'x\n', 'r0')])
    const store = make(fake)
    await store.start()
    fake.failNextWrite(new Error('offline'))
    store.edit('x\nmine\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(store.getState()).toMatchObject({ saveFailed: true, error: { message: 'offline' } })
    expect(await store.save()).toBe(true)
    expect(fake.writes.map(write => write.operationId)).toEqual(['op-1', 'op-1'])

    fake.external('a', 'x\nmine\nagent\n')
    store.edit('x\nmine\nmore\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(store.getState().conflict?.content).toBe('x\nmine\nagent\n')
    expect(store.getState().saveFailed).toBe(false)
    store.edit('x\nmine\nmore\nstill\n')
    await vi.advanceTimersByTimeAsync(2000)
    expect(fake.writes).toHaveLength(3)
    expect(await store.resolve('x\nmine\nagent\nmore\n')).toBe(true)
    expect(store.getState()).toMatchObject({ conflict: null, draft: 'x\nmine\nagent\nmore\n' })
    expect(fake.files.get('a')?.content).toBe('x\nmine\nagent\nmore\n')
  })

  it('takes over a change on disk while nothing is unsaved, and holds it as a conflict otherwise', async () => {
    const fake = fakeApi([doc('a', 'x\n', 'r0')])
    const store = make(fake)
    await store.start()
    fake.external('a', 'x\nagent\n')
    await store.refresh()
    expect(store.getState()).toMatchObject({ draft: 'x\nagent\n', conflict: null, epoch: 2 })

    store.edit('x\nagent\nmine\n')
    fake.external('a', 'x\nagent\nagain\n')
    await store.refresh()
    expect(store.getState().draft).toBe('x\nagent\nmine\n')
    expect(store.getState().conflict?.content).toBe('x\nagent\nagain\n')
    store.adopt()
    expect(store.getState()).toMatchObject({ draft: 'x\nagent\nagain\n', conflict: null })
    expect(store.dirty).toBe(false)
  })

  it('runs operations only on a saved screenplay, and does not switch away from unsaved text', async () => {
    const fake = fakeApi([doc('a', 'x\n', 'r0'), doc('b', 'y\n', 'r-b')])
    const store = make(fake)
    await store.start()
    store.edit('x\nunsaved\n')
    expect(store.canMutate).toBe(false)
    expect(await store.apply([{ kind: 'renameEntity', entityId: 'p', name: 'n' }])).toBe(false)
    expect(fake.api.apply).not.toHaveBeenCalled()
    expect(await store.open('b')).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(await store.apply([{ kind: 'renameEntity', entityId: 'p', name: 'n' }])).toBe(true)
    expect(store.getState().draft).toBe('x\nunsaved\n<!-- 1 operations -->\n')
    expect(await store.open('b')).toBe(true)
    expect(store.getState().draft).toBe('y\n')
  })

  it('sends a pending save when the tab goes away', async () => {
    const fake = fakeApi([doc('a', 'x\n', 'r0')])
    const store = make(fake)
    await store.start()
    store.edit('x\nlast words\n')
    store.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.writes.map(write => write.content)).toEqual(['x\nlast words\n'])
  })

  it('creates a screenplay and opens it', async () => {
    const fake = fakeApi([])
    const store = make(fake)
    await store.start()
    expect(store.getState()).toMatchObject({ status: 'ready', document: null })
    expect(await store.create('雨夜来客', 'short')).toBe(true)
    expect(store.getState()).toMatchObject({ draft: '# 雨夜来客\n', documents: [{ title: '雨夜来客' }] })
  })
})

describe('importing a copy', () => {
  it('opens the copy and adds it to the list', async () => {
    const fake = fakeApi([doc('a', 'x\n', 'r0', '甲')])
    const store = make(fake)
    await store.start()
    const epoch = store.getState().epoch
    expect(await store.importCopy(() => fake.api.importCopy({ format: 'markdown', content: '# 导入\n', expectedPreviewDigest: 'd' }))).toBe(true)
    expect(store.getState()).toMatchObject({ draft: '# 导入\n', saving: false, epoch: epoch + 1 })
    expect(store.getState().documents.map(item => item.title)).toEqual(['副本 1', '甲'])
  })

  it('is refused while the open screenplay has unsaved text', async () => {
    const fake = fakeApi([doc('a', 'x\n', 'r0')])
    const store = make(fake)
    await store.start()
    store.edit('x\nunsaved\n')
    const run = vi.fn(() => fake.api.importCopy({ format: 'markdown', content: 'y\n', expectedPreviewDigest: 'd' }))
    expect(await store.importCopy(run)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps the person on their text when they typed while the import ran, and saves it', async () => {
    const fake = fakeApi([doc('a', 'x\n', 'r0', '甲')])
    const store = make(fake)
    await store.start()
    const release = fake.holdWrites()
    const imported = store.importCopy(() => fake.api.importCopy({ format: 'markdown', content: '# 导入\n', expectedPreviewDigest: 'd' }))
    store.edit('x\ntyped\n')
    await vi.advanceTimersByTimeAsync(500)
    release()
    expect(await imported).toBe(false)
    expect(store.getState().document?.documentId).toBe('a')
    expect(store.getState().documents.map(item => item.title)).toEqual(['副本 1', '甲'])
    await vi.advanceTimersByTimeAsync(500)
    expect(fake.writes.map(write => write.content)).toEqual(['x\ntyped\n'])
    expect(store.dirty).toBe(false)
  })

  it('hands a refusal to the caller, and shows one the caller does not take', async () => {
    const fake = fakeApi([doc('a', 'x\n', 'r0')])
    const store = make(fake)
    await store.start()
    const stale = new StoryApiError('preview again', 409, 'STORY_IMPORT_PREVIEW_REQUIRED')
    const seen: unknown[] = []
    expect(await store.importCopy(async () => { throw stale }, (error) => { seen.push(error); return true })).toBe(false)
    expect(seen).toEqual([stale])
    expect(store.getState()).toMatchObject({ saving: false, error: null })
    expect(await store.importCopy(async () => { throw stale })).toBe(false)
    expect(store.getState().error?.message).toBe('preview again')
  })

  it('reports a stale send by bringing in the version on disk', async () => {
    const fake = fakeApi([doc('a', 'x\n', 'r0')])
    const store = make(fake)
    await store.start()
    store.report(new StoryConflictError('changed', doc('a', 'x\nagent\n', 'r9')))
    expect(store.getState()).toMatchObject({ draft: 'x\nagent\n', conflict: null, error: { message: 'changed' } })
  })
})
