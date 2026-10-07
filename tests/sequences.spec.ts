import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { SequenceStore } from '../src/canvas/sequences.js'

const roots: string[] = []
const fresh = async () => { const cwd = await mkdtemp(join(tmpdir(), 'film-sequences-')); roots.push(cwd); return { cwd, store: new SequenceStore(cwd, 'film-a') } }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const plan = () => ({ id: 'edit-a', title: '初剪', clips: [{ id: 'entry-a', nodeId: 'node-a', title: '镜头一', path: 'canvas/media/a.mp4', inMs: 1000, outMs: 4000, durationMs: 8000 }] })

describe('film edit plans', () => {
  it('re-opens the exact source ranges and unique occurrences after a restart without making a board', async () => {
    const { store, cwd } = await fresh()
    const content = plan(); content.clips.push({ ...content.clips[0]!, id: 'entry-b', inMs: 4000, outMs: 6000 })
    const saved = await store.save(content, null, 'save-one')
    expect(await new SequenceStore(cwd, 'film-a').list()).toEqual([saved])
    await expect(readFile(join(cwd, 'film/canvas/document.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(cwd, 'film/canvas/timeline.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(saved.clips.map(clip => clip.id)).toEqual(['entry-a', 'entry-b'])
  })
  it('refuses a stale window save and preserves the winning edit', async () => {
    const { store } = await fresh()
    const initial = await store.save(plan(), null, 'save-one')
    const results = await Promise.allSettled([store.save({ ...plan(), title: '窗口一' }, initial.revision, 'save-two'), store.save({ ...plan(), title: '窗口二' }, initial.revision, 'save-three')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'SEQUENCE_CONFLICT' } })
    expect((await store.list())[0]?.title).toBe('窗口一')
    expect(await store.save({ ...plan(), title: '窗口一' }, initial.revision, 'save-two')).toEqual((results[0] as PromiseFulfilledResult<unknown>).value)
  })
  it('leaves damaged, unknown-version or other-film records untouched', async () => {
    const { store, cwd } = await fresh(); const file = join(cwd, 'film/edits/sequences.json'); await mkdir(join(cwd, 'film/edits'), { recursive: true })
    for (const raw of ['{broken', JSON.stringify({ format: 'vibedev.edit-sequences', version: 2, projectId: 'film-a', drafts: [] }), JSON.stringify({ format: 'vibedev.edit-sequences', version: 1, projectId: 'film-b', drafts: [] })]) {
      await writeFile(file, raw)
      await expect(store.save(plan(), null, 'save-one')).rejects.toMatchObject({ code: 'SEQUENCES_UNREADABLE' })
      expect(await readFile(file, 'utf8')).toBe(raw)
    }
  })
  it('rejects duplicate occurrence ids, paths outside the film and invalid ranges', async () => {
    const { store } = await fresh()
    for (const clips of [[plan().clips[0]!, plan().clips[0]!], [{ ...plan().clips[0], path: '../private.mp4' }], [{ ...plan().clips[0], outMs: 1050 }], [{ ...plan().clips[0], outMs: 9000 }]]) {
      await expect(store.save({ ...plan(), clips }, null, 'save-one')).rejects.toMatchObject({ code: 'SEQUENCE_INVALID' })
    }
    expect(await store.list()).toEqual([])
  })
  it('detects changed bytes even when the file name and size stay the same', async () => {
    const { store, cwd } = await fresh()
    await mkdir(join(cwd, 'film/canvas/media'), { recursive: true })
    const media = join(cwd, 'film/canvas/media/a.mp4')
    await writeFile(media, 'abc')
    const saved = await store.save(plan(), null, 'save-one')
    expect(saved.clips[0]?.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect((await store.get(saved.id)).sources[0]?.status).toBe('available')
    await writeFile(media, 'xyz')
    expect((await store.get(saved.id)).sources[0]?.status).toBe('changed')
    await expect(store.save(saved, saved.revision, 'save-two')).rejects.toMatchObject({ code: 'SEQUENCE_SOURCE_CHANGED' })
    expect((await store.list())[0]?.revision).toBe(saved.revision)
    await rm(media)
    expect((await store.get(saved.id)).sources[0]?.status).toBe('missing')
  })
  it('refuses the same save id with different content even with the latest revision', async () => {
    const { store } = await fresh()
    const saved = await store.save(plan(), null, 'save-one')
    await expect(store.save({ ...plan(), title: 'different' }, saved.revision, 'save-one')).rejects.toMatchObject({ code: 'SEQUENCE_OPERATION_CONFLICT' })
    expect((await store.list())[0]?.title).toBe('初剪')
  })
  it('can delete only the revision it read', async () => {
    const { store } = await fresh(); const saved = await store.save(plan(), null, 'save-one')
    await expect(store.remove(saved.id, 'old-revision')).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' })
    await store.remove(saved.id, saved.revision)
    expect(await store.list()).toEqual([])
  })
})
