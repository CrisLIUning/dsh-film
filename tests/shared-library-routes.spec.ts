import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/project.js'
import { createStudioRouter } from '../src/routes.js'
import { Config } from '../src/index.js'

let root: string
let library: string
let cwd: string
let other: string
let router: ReturnType<typeof createStudioRouter>
const prefix = '/api/canvas/library'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'film-shared-library-'))
  library = join(root, 'global')
  cwd = join(root, 'project-a')
  other = join(root, 'project-b')
  await mkdir(cwd)
  await mkdir(other)
  await createProject(cwd, { title: 'A', aspectRatio: '16:9' })
  await createProject(other, { title: 'B', aspectRatio: '16:9' })
  router = createStudioRouter({ sharedAssetsDir: library })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

async function call(path = '', options: { method?: string; json?: unknown; body?: Uint8Array; headers?: Record<string, string>; cwd?: string; router?: typeof router } = {}) {
  const url = new URL('http://host/api/dsh-film/studio')
  url.searchParams.set('cwd', options.cwd ?? cwd)
  url.searchParams.set('path', prefix + path)
  const method = options.method ?? 'GET'
  if (!['GET', 'HEAD'].includes(method)) url.searchParams.set('method', method)
  const response = await (options.router ?? router).dispatch(new Request(url, {
    method: ['GET', 'HEAD'].includes(method) ? method : 'POST',
    headers: options.json !== undefined ? { ...options.headers, 'content-type': 'application/json' } : options.headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body as unknown as RequestInit['body'],
  }))
  const body = (response.headers.get('content-type') ?? '').startsWith('application/json') && method !== 'HEAD'
    ? await response.json() as any : undefined
  return { status: response.status, body, response }
}

async function textAsset(extra: Record<string, unknown> = {}) {
  const saved = await call('/assets', { method: 'POST', json: { kind: 'text', title: '人物设定', folderId: 'characters', text: '林，雨夜来客。', ...extra } })
  expect(saved.status).toBe(200)
  expect(saved.body.createdAssetId).toBe(saved.body.assets.at(-1).id)
  return saved.body.assets.at(-1) as { id: string; [key: string]: any }
}

async function upload(name = 'shot.png', kind = 'image', bytes = new Uint8Array([1, 2, 3, 4, 5])) {
  const query = new URLSearchParams({ name, kind, title: '画面', folderId: 'scenes' })
  const saved = await call(`/assets/upload?${query}`, { method: 'POST', body: bytes })
  expect(saved.status).toBe(200)
  expect(saved.body.createdAssetId).toBe(saved.body.assets.at(-1).id)
  return saved.body.assets.at(-1) as { id: string; [key: string]: any }
}

describe('computer-wide shared library', () => {
  it('keeps old configs compatible and does not create storage merely by constructing a router', async () => {
    expect(Config({ appsDir: '' })).toMatchObject({ appsDir: '' })
    expect(Config({ appsDir: '', sharedAssetsDir: library })).toMatchObject({ sharedAssetsDir: library })
    await expect(readdir(library)).rejects.toMatchObject({ code: 'ENOENT' })
    const { SharedAssetLibrary, sharedAssetsDirectory } = await import('../src/canvas/shared-library.js')
    expect(new SharedAssetLibrary(library).directory).toBe(library)
    expect(sharedAssetsDirectory()).toBe(sharedAssetsDirectory(''))
    expect(() => sharedAssetsDirectory('relative-assets')).toThrow('absolute')
    await expect(readdir(library)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('seeds six stable folders and persists across two projects and a reopened router', async () => {
    const initial = await call()
    expect(initial.status).toBe(200)
    expect(initial.body.folders.map((f: any) => [f.id, f.title])).toEqual([
      ['characters', '角色'], ['scenes', '场景'], ['props', '物品'], ['styles', '风格'], ['sounds', '音效'], ['uncategorized', '未分类'],
    ])
    expect(typeof initial.body.revision).toBe('string')
    const asset = await textAsset({ tags: ['主角'], note: '细节', source: '原始设定' })
    const shared = await call('', { cwd: other })
    expect(shared.body.assets).toContainEqual(asset)
    const reopened = createStudioRouter({ sharedAssetsDir: library })
    expect((await call('', { cwd: other, router: reopened })).body).toEqual(shared.body)
    expect(shared.body.revision).not.toBe(initial.body.revision)
    expect(await readdir(join(cwd, 'film', 'canvas'))).not.toContain('shared-library.json')
  })

  it('copies film and workspace bytes and preserves provenance and metadata after originals are removed', async () => {
    await writeFile(join(cwd, 'portrait.png'), new Uint8Array([9, 8, 7]))
    await mkdir(join(cwd, 'film', 'source'))
    await writeFile(join(cwd, 'film', 'source', 'voice.wav'), 'sound')
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const saved = await call('/assets', { method: 'POST', json: { kind: 'image', title: '林', folderId: 'characters', workspacePath: 'portrait.png', tags: ['人物'], note: '说明', source: 'https://example.invalid/original', width: 50, height: 60 } })
    expect(saved.status).toBe(200)
    const image = saved.body.assets[0]
    expect(image).toMatchObject({ kind: 'image', title: '林', sizeBytes: 3, mimeType: 'image/png', width: 50, height: 60, source: 'https://example.invalid/original', tags: ['人物'], note: '说明' })
    expect(image.fileName).toBeUndefined()
    expect(image.sha256).toBeUndefined()
    expect((await call('/assets', { method: 'POST', json: { kind: 'audio', title: '人声', folderId: 'sounds', projectPath: 'source/voice.wav', durationMs: 1500 } })).status).toBe(200)
    await rm(join(cwd, 'portrait.png'))
    await rm(join(cwd, 'film', 'source'), { recursive: true })
    const raw = await call(`/assets/${image.id}/raw`, { cwd: other })
    expect(raw.status).toBe(200)
    expect(new Uint8Array(await raw.response.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]))
    expect(network).not.toHaveBeenCalled()
    const imported = await call('/import', { cwd: other, method: 'POST', json: { assetIds: [image.id] } })
    expect(imported.status).toBe(200)
    expect(imported.body.assets[0]).toMatchObject({ ...image, file: { mime: 'image/png', size: 3 } })
    expect(await readFile(join(other, 'film', imported.body.assets[0].file.name))).toEqual(Buffer.from([9, 8, 7]))
  })

  it('persists uploaded media facts through JSON patches, reopen and cross-project import', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const cases = [
      { name: 'portrait.png', kind: 'image', facts: { width: 1920, height: 1080 } },
      { name: 'scene.mp4', kind: 'video', facts: { width: 3840, height: 2160, durationMs: 4500 } },
      { name: 'voice.wav', kind: 'audio', facts: { durationMs: 0 } },
    ] as const
    for (const { name, kind, facts } of cases) {
      const uploaded = await upload(name, kind)
      const before = (await call()).body
      const metadata = { ...facts, source: `原始来源/${name}`, tags: ['已知 facts'], note: '私密提示词只通过 JSON 发送' }
      const patched = await call(`/assets/${uploaded.id}`, { method: 'PATCH', json: { ...metadata, expectedRevision: before.revision } })
      expect(patched.status).toBe(200)
      expect(patched.body.revision).not.toBe(before.revision)
      const changed = patched.body.assets.find((asset: any) => asset.id === uploaded.id)
      expect(changed).toMatchObject({ ...uploaded, ...metadata, updatedAt: expect.any(String) })
      const reopened = createStudioRouter({ sharedAssetsDir: library })
      expect((await call('', { cwd: other, router: reopened })).body).toEqual(patched.body)
      const imported = await call('/import', { method: 'POST', cwd: other, router: reopened, json: { assetIds: [uploaded.id] } })
      expect(imported.status).toBe(200)
      expect(imported.body.assets[0]).toMatchObject(changed)
      expect(await readFile(join(other, 'film', imported.body.assets[0].file.name))).toEqual(Buffer.from([1, 2, 3, 4, 5]))
      expect(new Uint8Array(await (await call(`/assets/${uploaded.id}/raw`)).response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    }
    expect(network).not.toHaveBeenCalled()
  })

  it('validates patched media facts exactly like create and preserves the snapshot on failure', async () => {
    const asset = await upload()
    const before = (await call()).body
    for (const facts of [
      { width: 0 }, { width: -1 }, { width: '1920' }, { width: null },
      { height: 0 }, { height: -1 }, { height: null },
      { durationMs: -1 }, { durationMs: '1000' }, { durationMs: null },
      { source: 123 }, { source: 'x'.repeat(8193) },
    ]) {
      const patch = await call(`/assets/${asset.id}`, { method: 'PATCH', json: facts })
      const create = await call('/assets', { method: 'POST', json: { kind: 'text', title: 'bad', folderId: 'styles', text: 'bad', ...facts } })
      expect(patch.status).toBe(400)
      expect(create.status).toBe(400)
      expect((await call()).body).toEqual(before)
    }
    for (const fields of [{ kind: 'video' }, { mimeType: 'video/mp4' }, { sizeBytes: 0 }, { projectPath: 'other.png' }]) {
      expect((await call(`/assets/${asset.id}`, { method: 'PATCH', json: fields })).status).toBe(400)
    }
    expect((await call()).body).toEqual(before)
  })

  it('patches only editable fields and soft deletes/restores bytes and metadata', async () => {
    const image = await upload()
    const patched = await call(`/assets/${image.id}`, { method: 'PATCH', json: { title: '新名字', folderId: 'props', tags: ['道具'], note: '备忘' } })
    const changed = patched.body.assets[0]
    expect(changed).toMatchObject({ ...image, updatedAt: expect.any(String), title: '新名字', folderId: 'props', tags: ['道具'], note: '备忘', createdAt: image.createdAt })
    const removed = await call(`/assets/${image.id}`, { method: 'DELETE' })
    expect(removed.body.assets).toEqual([])
    expect(removed.body.deletedAssets).toMatchObject([changed])
    const deletedRaw = await call(`/assets/${image.id}/raw`)
    expect(deletedRaw.status).toBe(200)
    expect(new Uint8Array(await deletedRaw.response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect((await call('/import', { method: 'POST', json: { assetIds: [image.id] } })).status).toBe(404)
    const restored = await call(`/assets/${image.id}/restore`, { method: 'POST' })
    expect(restored.status).toBe(200)
    expect(restored.body.assets[0]).toMatchObject({ ...changed, createdAt: image.createdAt })
    expect(restored.body.deletedAssets).toEqual([])
    expect(new Uint8Array(await (await call(`/assets/${image.id}/raw`)).response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  it('serves trash image/video/audio raw, HEAD and ranges without restoring or importing deleted assets', async () => {
    const active = await upload('active.png')
    const reopened = createStudioRouter({ sharedAssetsDir: library })
    for (const [name, kind, mime] of [
      ['portrait.png', 'image', 'image/png'],
      ['scene.mp4', 'video', 'video/mp4'],
      ['voice.wav', 'audio', 'audio/wav'],
    ] as const) {
      const asset = await upload(name, kind)
      expect((await call(`/assets/${asset.id}`, { method: 'DELETE' })).status).toBe(200)
      const before = (await call()).body
      const request = { cwd: other, router: reopened }
      const raw = await call(`/assets/${asset.id}/raw`, request)
      expect(raw.status).toBe(200)
      expect(raw.response.headers.get('content-type')).toBe(mime)
      expect(raw.response.headers.get('content-length')).toBe('5')
      expect(raw.response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(raw.response.headers.get('content-security-policy')).toContain('sandbox')
      expect(raw.response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      expect(new Uint8Array(await raw.response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
      const range = await call(`/assets/${asset.id}/raw`, { ...request, headers: { range: 'bytes=1-3' } })
      expect(range.status).toBe(206)
      expect(range.response.headers.get('content-range')).toBe('bytes 1-3/5')
      expect(new Uint8Array(await range.response.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4]))
      const head = await call(`/assets/${asset.id}/raw`, { ...request, method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.response.headers.get('content-length')).toBe('5')
      expect(await head.response.text()).toBe('')
      expect((await call(`/assets/${asset.id}/raw`, { ...request, headers: { range: 'bytes=20-' } })).status).toBe(416)
      expect((await call('/import', { ...request, method: 'POST', json: { assetIds: [asset.id] } })).status).toBe(404)
      expect((await call('/import', { ...request, method: 'POST', json: { assetIds: [active.id, asset.id] } })).status).toBe(404)
      expect(await readdir(join(other, 'film', 'canvas'))).not.toContain('media')
      expect((await call()).body).toEqual(before)
    }
  })

  it('still rejects deleted text raw and missing library-owned trash media', async () => {
    const text = await textAsset()
    await call(`/assets/${text.id}`, { method: 'DELETE' })
    expect((await call(`/assets/${text.id}/raw`)).status).toBe(404)
    const image = await upload()
    await call(`/assets/${image.id}`, { method: 'DELETE' })
    const manifest = JSON.parse(await readFile(join(library, 'manifest.json'), 'utf8'))
    const fileName = manifest.assets.find((asset: any) => asset.id === image.id).fileName
    await rm(join(library, 'files', fileName))
    expect((await call(`/assets/${image.id}/raw`)).status).toBe(404)
  })

  it('supports folder creation/moves/renames, rejects cycles and only deletes empty subtrees', async () => {
    const first = await call('/folders', { method: 'POST', json: { title: '资产包', parentId: 'characters', icon: '📦' } })
    expect(first.status).toBe(200)
    const pack = first.body.folders.at(-1).id
    const second = await call('/folders', { method: 'POST', json: { title: '子目录', parentId: pack } })
    const child = second.body.folders.at(-1).id
    expect((await call(`/folders/${pack}`, { method: 'PATCH', json: { parentId: child } })).status).toBe(400)
    expect((await call(`/folders/${pack}`, { method: 'PATCH', json: { parentId: pack } })).status).toBe(400)
    expect((await call(`/folders/${pack}`, { method: 'PATCH', json: { parentId: 'missing' } })).status).toBe(404)
    const moved = await call(`/folders/${pack}`, { method: 'PATCH', json: { parentId: 'scenes', title: '新包' } })
    expect(moved.body.folders.find((f: any) => f.id === pack)).toMatchObject({ parentId: 'scenes', title: '新包', icon: '📦' })
    const asset = await textAsset({ folderId: child })
    expect((await call(`/folders/${pack}`, { method: 'DELETE' })).status).toBe(409)
    await call(`/assets/${asset.id}`, { method: 'DELETE' })
    // A recycle-bin entry still needs its folder for an exact restore.
    expect((await call(`/folders/${pack}`, { method: 'DELETE' })).status).toBe(409)
    await call(`/assets/${asset.id}/restore`, { method: 'POST' })
    await call(`/assets/${asset.id}`, { method: 'PATCH', json: { folderId: 'uncategorized' } })
    const deleted = await call(`/folders/${pack}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(deleted.body.folders.some((f: any) => [pack, child].includes(f.id))).toBe(false)
    expect((await call('/folders/characters', { method: 'DELETE' })).status).toBe(409)
    expect((await call('/folders/characters', { method: 'PATCH', json: { title: '人物' } })).body.folders[0].title).toBe('人物')
    expect((await call('/folders', { method: 'POST', json: { title: 'bad', parentId: 'missing' } })).status).toBe(404)
  })

  it('serializes concurrent routers and rejects stale revisions without losing independent patches', async () => {
    const asset = await textAsset()
    const initial = (await call()).body
    const second = createStudioRouter({ sharedAssetsDir: library })
    const updates = await Promise.all([
      call(`/assets/${asset.id}`, { method: 'PATCH', json: { title: '新的' } }),
      call(`/assets/${asset.id}`, { method: 'PATCH', router: second, json: { note: '并发备注' } }),
      ...Array.from({ length: 12 }, (_, i) => call('/folders', { method: 'POST', router: i % 2 ? second : router, json: { title: `包${i}` } })),
    ])
    expect(updates.map(r => r.status)).toEqual(Array(14).fill(200))
    const current = (await call()).body
    expect(current.folders).toHaveLength(18)
    expect(current.assets[0]).toMatchObject({ title: '新的', note: '并发备注' })
    const stale = await call(`/assets/${asset.id}`, { method: 'PATCH', json: { title: '过期', expectedRevision: initial.revision } })
    expect(stale.status).toBe(409)
    expect((await call()).body).toEqual(current)
    expect((await call(`/assets/${asset.id}`, { method: 'PATCH', json: { tags: [], expectedRevision: current.revision } })).status).toBe(200)
    expect((await readdir(library)).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([])
  })

  it('streams supported media uploads, ignores offered MIME and refuses invalid names/kinds and the 2GB limit', async () => {
    for (const [name, kind] of [['clip.mp4', 'video'], ['voice.wav', 'audio']] as const) {
      const asset = await upload(name, kind)
      expect(asset.kind).toBe(kind)
    }
    for (const [name, kind] of [['../escape.png', 'image'], ['C:\\escape.png', 'image'], ['x.svg', 'image'], ['x.png', 'video'], ['x.txt', 'text']] as const) {
      const query = new URLSearchParams({ name, kind, title: 'bad', folderId: 'scenes' })
      expect((await call(`/assets/upload?${query}`, { method: 'POST', body: new Uint8Array([1]) })).status).toBe(400)
    }
    const huge = await call('/assets/upload?name=x.png&kind=image&title=big&folderId=scenes', { method: 'POST', body: new Uint8Array([1]), headers: { 'content-length': String(2 * 1024 ** 3 + 1) } })
    expect(huge.status).toBe(413)
    expect((await call()).body.assets).toHaveLength(2)
  })

  it('serves bounded byte ranges and HEAD with safe headers, and never accepts arbitrary paths', async () => {
    const asset = await upload()
    const raw = await call(`/assets/${asset.id}/raw`, { headers: { range: 'bytes=1-3' } })
    expect(raw.status).toBe(206)
    expect(raw.response.headers.get('content-range')).toBe('bytes 1-3/5')
    expect(raw.response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(raw.response.headers.get('content-security-policy')).toContain('sandbox')
    expect(new Uint8Array(await raw.response.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4]))
    const suffix = await call(`/assets/${asset.id}/raw`, { headers: { range: 'bytes=-2' } })
    expect(new Uint8Array(await suffix.response.arrayBuffer())).toEqual(new Uint8Array([4, 5]))
    const pastEnd = await call(`/assets/${asset.id}/raw`, { headers: { range: 'bytes=20-' } })
    expect(pastEnd.status).toBe(416)
    const head = await call(`/assets/${asset.id}/raw`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.response.text()).toBe('')
    expect((await call('/assets/missing/raw')).status).toBe(404)
    expect((await call('/assets/..%2Fsecret.png/raw')).status).toBe(400)
    expect((await call(`/assets/${(await textAsset()).id}/raw`)).status).toBe(404)
  })

  it('imports complete text/media batches with deterministic deduplication and collision-safe copies', async () => {
    const text = await textAsset()
    const image = await upload()
    const request = { method: 'POST', cwd: other, json: { assetIds: [text.id, image.id] } }
    const imported = await call('/import', request)
    expect(imported.status).toBe(200)
    expect(imported.body.assets[0]).toEqual(text)
    const name = imported.body.assets[1].file.name
    expect(name).toMatch(/^canvas\/media\/shared-[a-zA-Z0-9_-]+-[a-f0-9]{64}(?:-\d+)?\.png$/)
    expect((await call('/import', request)).body).toEqual(imported.body)
    expect(await readdir(join(other, 'film', 'canvas', 'media'))).toHaveLength(1)
    await writeFile(join(other, 'film', name), 'existing different bytes')
    const collision = await call('/import', request)
    expect(collision.status).toBe(200)
    expect(collision.body.assets[1].file.name).not.toBe(name)
    expect(await readFile(join(other, 'film', name), 'utf8')).toBe('existing different bytes')
    expect((await call('/import', request)).body).toEqual(collision.body)
    expect(new Uint8Array(await (await call(`/assets/${image.id}/raw`)).response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  it('validates the entire batch and every source file before creating destination files', async () => {
    const image = await upload()
    expect((await call('/import', { method: 'POST', cwd: other, json: { assetIds: [image.id, 'missing'] } })).status).toBe(404)
    expect(await readdir(join(other, 'film', 'canvas'))).not.toContain('media')
    const second = await upload('other.png')
    const manifest = JSON.parse(await readFile(join(library, 'manifest.json'), 'utf8'))
    const file = manifest.assets.find((a: any) => a.id === second.id).fileName
    await rm(join(library, 'files', file))
    expect((await call('/import', { method: 'POST', cwd: other, json: { assetIds: [image.id, second.id] } })).status).toBe(404)
    expect(await readdir(join(other, 'film', 'canvas'))).not.toContain('media')
    expect((await call('/import', { method: 'POST', json: { assetIds: [] } })).status).toBe(400)
    expect((await call('/import', { method: 'POST', json: { assetIds: [image.id, image.id] } })).status).toBe(400)
  })

  it('rejects missing, traversing, external and mismatched media sources and unauthorized workspaces', async () => {
    const plain = join(root, 'no-film')
    await mkdir(plain)
    await writeFile(join(plain, 'x.png'), 'private')
    expect((await call('/assets', { method: 'POST', cwd: plain, json: { kind: 'image', title: 'bad', folderId: 'scenes', workspacePath: 'x.png' } })).status).toBe(404)
    expect((await call('/import', { method: 'POST', cwd: plain, json: { assetIds: [(await textAsset()).id] } })).status).toBe(404)
    for (const workspacePath of ['../x.png', 'C:\\x.png', '.ssh/x.png', 'https://example.com/x.png', 'missing.png']) {
      expect((await call('/assets', { method: 'POST', json: { kind: 'image', title: 'bad', folderId: 'scenes', workspacePath } })).status).toBe(workspacePath === 'missing.png' ? 404 : 400)
    }
    expect((await call('/assets', { method: 'POST', json: { kind: 'image', title: 'bad', folderId: 'scenes', projectPath: '../x.png' } })).status).toBe(400)
    await writeFile(join(cwd, 'x.png'), 'image')
    expect((await call('/assets', { method: 'POST', json: { kind: 'audio', title: 'bad', folderId: 'scenes', workspacePath: 'x.png' } })).status).toBe(400)
    expect((await call('/assets', { method: 'POST', json: { kind: 'image', title: 'bad', folderId: 'scenes', source: 'https://example.com/x.png' } })).status).toBe(400)
    expect((await call('/assets/missing', { method: 'PATCH', json: { title: 'bad' } })).status).toBe(404)
    expect((await call('/assets', { method: 'POST', json: { kind: 'text', title: 'bad', folderId: 'missing', text: 'x' } })).status).toBe(404)
  })

  it('rejects symlinks in workspace sources, library files and import destination ancestors', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'x.png'), 'secret')
    await symlink(outside, join(cwd, 'linked'), 'junction')
    expect((await call('/assets', { method: 'POST', json: { kind: 'image', title: 'bad', folderId: 'scenes', workspacePath: 'linked/x.png' } })).status).toBe(400)
    const image = await upload()
    await symlink(outside, join(other, 'film', 'canvas', 'media'), 'junction')
    expect((await call('/import', { method: 'POST', cwd: other, json: { assetIds: [image.id] } })).status).toBe(400)
    expect(await readdir(outside)).toEqual(['x.png'])
    await rm(join(library, 'files'), { recursive: true })
    await symlink(outside, join(library, 'files'), 'junction')
    expect((await call(`/assets/${image.id}/raw`)).status).toBe(400)
    expect((await call('/assets/upload?name=z.png&kind=image&title=bad&folderId=scenes', { method: 'POST', body: new Uint8Array([1]) })).status).toBe(400)
    expect(await readdir(outside)).toEqual(['x.png'])
  })

  it('refuses damaged manifests instead of overwriting user data', async () => {
    await textAsset()
    await writeFile(join(library, 'manifest.json'), '{ damaged')
    expect((await call()).status).toBe(422)
    expect((await call('/folders', { method: 'POST', json: { title: 'bad' } })).status).toBe(422)
    expect(await readFile(join(library, 'manifest.json'), 'utf8')).toBe('{ damaged')
  })

  it('rejects invalid patch fields without changing the revision or immutable metadata', async () => {
    const asset = await textAsset()
    const before = (await call()).body
    for (const json of [{ text: 'overwrite' }, { source: 123 }, { kind: 'image' }, { assets: [] }, { folderId: 'missing' }, { tags: 'bad' }, { title: '' }]) {
      const result = await call(`/assets/${asset.id}`, { method: 'PATCH', json })
      expect([400, 404]).toContain(result.status)
      expect((await call()).body).toEqual(before)
    }
    expect((await call('/assets', { method: 'POST', json: { kind: 'text', title: 'x', folderId: 'characters', text: 'x', width: -1 } })).status).toBe(400)
  })

  it('allows clearing a folder parent/icon and protects default descendants from subtree deletion', async () => {
    const parent = (await call('/folders', { method: 'POST', json: { title: '包', icon: '📦', parentId: 'styles' } })).body.folders.at(-1)
    const cleared = await call(`/folders/${parent.id}`, { method: 'PATCH', json: { parentId: null, icon: null } })
    const folder = cleared.body.folders.find((f: any) => f.id === parent.id)
    expect(folder.parentId).toBeUndefined()
    expect(folder.icon).toBeUndefined()
    await call('/folders/characters', { method: 'PATCH', json: { parentId: parent.id } })
    expect((await call(`/folders/${parent.id}`, { method: 'DELETE' })).status).toBe(409)
    expect((await call('/folders/characters', { method: 'PATCH', json: { parentId: null } })).status).toBe(200)
    expect((await call(`/folders/${parent.id}`, { method: 'DELETE' })).status).toBe(200)
  })

  it('preflights same-size corrupted bytes, and rejects links at destination filename, canvas and film', async () => {
    const image = await upload()
    const manifest = JSON.parse(await readFile(join(library, 'manifest.json'), 'utf8'))
    const stored = manifest.assets.find((a: any) => a.id === image.id)
    await writeFile(join(library, 'files', stored.fileName), new Uint8Array([5, 4, 3, 2, 1]))
    expect((await call('/import', { method: 'POST', cwd: other, json: { assetIds: [image.id] } })).status).toBe(422)
    expect(await readdir(join(other, 'film', 'canvas'))).not.toContain('media')
    await writeFile(join(library, 'files', stored.fileName), new Uint8Array([1, 2, 3, 4, 5]))
    const outside = join(root, 'safe-outside')
    await mkdir(outside)
    // A junction may appear above the target, not just at media/ itself.
    await rm(join(other, 'film', 'canvas'), { recursive: true })
    await symlink(outside, join(other, 'film', 'canvas'), 'junction')
    expect((await call('/import', { method: 'POST', cwd: other, json: { assetIds: [image.id] } })).status).toBe(400)
    expect(await readdir(outside)).toEqual([])
    await rm(join(other, 'film', 'canvas'))
    await mkdir(join(other, 'film', 'canvas', 'media'), { recursive: true })
    const target = join(other, 'film', 'canvas', 'media', `shared-${image.id}-${stored.sha256}.png`)
    await symlink(outside, target, 'junction')
    expect((await call('/import', { method: 'POST', cwd: other, json: { assetIds: [image.id] } })).status).toBe(400)
    expect(await readdir(outside)).toEqual([])
    await rm(join(other, 'film'), { recursive: true })
    // requireFilmWorkspace must see a valid film file before path validation rejects this link.
    await writeFile(join(outside, 'film.json'), await readFile(join(cwd, 'film', 'film.json')))
    await symlink(outside, join(other, 'film'), 'junction')
    expect((await call('/import', { method: 'POST', cwd: other, json: { assetIds: [image.id] } })).status).toBe(400)
    expect(await readdir(outside)).toEqual(['film.json'])
  })

  it('cleans failed streaming uploads and rejects a linked manifest without overwriting it', async () => {
    const { SharedAssetLibrary } = await import('../src/canvas/shared-library.js')
    const store = new SharedAssetLibrary(library)
    await store.read()
    let chunks = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]))
        else controller.error(new Error('interrupted body'))
      },
    })
    const request = new Request('http://host/upload', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    await expect(store.upload(request, { name: 'partial.png', kind: 'image', title: 'partial', folderId: 'scenes' })).rejects.toThrow('interrupted body')
    expect((await store.read()).assets).toEqual([])
    expect(await readdir(join(library, 'files'))).toEqual([])
    const outside = join(root, 'manifest-target')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'never touch')
    await rm(join(library, 'manifest.json'))
    await symlink(outside, join(library, 'manifest.json'), 'junction')
    expect((await call()).status).toBe(400)
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('never touch')
  })

  it('cancels a stalled upload on request abort, releases the lock and leaves no partial asset', async () => {
    const { SharedAssetLibrary } = await import('../src/canvas/shared-library.js')
    const store = new SharedAssetLibrary(library)
    const controller = new AbortController()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const request = new Request('http://host/upload', { method: 'POST', body: stream, signal: controller.signal, duplex: 'half' } as RequestInit)
    const result = store.upload(request, { name: 'abort.png', kind: 'image', title: 'abort', folderId: 'scenes' })
    const outcome = result.then(() => 'saved', error => error.message as string)
    for (let i = 0; i < 100 && !await readdir(join(library, 'files')).catch(() => undefined); i++) await new Promise(done => setTimeout(done, 5))
    await new Promise(done => setTimeout(done, 20))
    controller.abort(new Error('client disconnected'))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      expect(await Promise.race([outcome, new Promise<string>(done => { timer = setTimeout(() => done('stalled'), 500) })])).toBe('client disconnected')
      expect(cancelled).toBe(true)
      expect((await store.read()).assets).toEqual([])
      expect(await readdir(join(library, 'files'))).toEqual([])
    } finally { if (timer) clearTimeout(timer) }
  })

  it('rolls back only newly copied files when a later import destination is a link', async () => {
    const first = await upload('first.png')
    const second = await upload('second.png')
    const manifest = JSON.parse(await readFile(join(library, 'manifest.json'), 'utf8'))
    const stored = manifest.assets.find((a: any) => a.id === second.id)
    const media = join(other, 'film', 'canvas', 'media')
    await mkdir(media, { recursive: true })
    const outside = join(root, 'batch-outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'keep')
    const filename = `shared-${second.id}-${stored.sha256}.png`
    await symlink(outside, join(media, filename), 'junction')
    const refused = await call('/import', { method: 'POST', cwd: other, json: { assetIds: [first.id, second.id] } })
    expect(refused.status).toBe(400)
    expect(await readdir(media)).toEqual([filename])
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('keep')
  })

  it('bounds the queue while a slow upload holds the library lock and releases every waiter', async () => {
    const { SharedAssetLibrary, SHARED_LIBRARY_QUEUE_LIMIT } = await import('../src/canvas/shared-library.js')
    const store = new SharedAssetLibrary(library)
    let finish!: () => void
    let started!: () => void
    const ready = new Promise<void>(done => { started = done })
    const stream = new ReadableStream<Uint8Array>({ start(controller) { finish = () => { controller.enqueue(new Uint8Array([1])); controller.close() } }, pull() { started() } })
    const request = new Request('http://host/upload', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    const uploading = store.upload(request, { name: 'slow.png', kind: 'image', title: 'slow', folderId: 'scenes' })
    await ready
    // Wait until the first operation is reading its body, rather than merely buffering Request.
    for (let i = 0; i < 100 && !await readdir(join(library, 'files')).catch(() => undefined); i++) await new Promise(done => setTimeout(done, 5))
    const waiting = Array.from({ length: SHARED_LIBRARY_QUEUE_LIMIT + 1 }, () => new SharedAssetLibrary(library).read())
    try {
      const refused = await Promise.any(waiting.map(promise => promise.then(() => Promise.reject(new Error('unexpected completed read')), error => error)))
      expect(refused).toMatchObject({ status: 503, code: 'SHARED_LIBRARY_BUSY' })
    } finally { finish() }
    expect((await uploading).createdAssetId).toBeDefined()
    const results = await Promise.allSettled(waiting)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(2)
    expect((await store.read()).assets).toHaveLength(1)
    expect(await readdir(library)).not.toContain('.manifest.lock')
  })
})
