/** The editing desk's AI models: the packaged list, consent, verified downloads and serving. */

import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorModels, EditorModelError, defaultModelsRoot, packagedModelManifests } from '../src/models/service.js'
import type { EditorModelManifest } from '../src/models/service.js'
import { createStudioRouter } from '../src/routes.js'
import { modelFileRoute, modelFileRoutes } from '../src/studio/model-routes.js'

let root: string
let cwd: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-film-models-'))
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-models-ws-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(cwd, { recursive: true, force: true })
})

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const MIRROR = 'https://vibedev.jzsaas.com/video-editor-models/demo/abc1234'

const WEIGHTS = new TextEncoder().encode('weights-'.repeat(64))
const CONFIG = new TextEncoder().encode('{"layers":3}')

/** A model with two files on the mirror. */
function demoModel(overrides: Partial<EditorModelManifest> = {}): EditorModelManifest {
  return {
    id: 'demo-model',
    label: '演示模型',
    capability: 'segmentation',
    revision: 'abc1234',
    license: { name: 'MIT', url: 'https://opensource.org/license/mit' },
    artifacts: [
      { id: 'model.json', fileName: 'model.json', bytes: CONFIG.byteLength, sha256: sha256(CONFIG), sources: [`${MIRROR}/model.json`] },
      { id: 'weights', fileName: 'weights.bin', bytes: WEIGHTS.byteLength, sha256: sha256(WEIGHTS), sources: [`${MIRROR}/weights.bin`] },
    ],
    ...overrides,
  }
}

const font = (id: string): EditorModelManifest => ({
  id, label: id, capability: 'caption-font', revision: 'f00d123', license: { name: 'OFL-1.1' }, group: 'caption-font',
  artifacts: [{ id: 'font', fileName: `${id}.ttf`, bytes: CONFIG.byteLength, sha256: sha256(CONFIG), sources: [`https://vibedev.jzsaas.com/video-editor-models/${id}/f00d123/font.ttf`] }],
})

/** A stand-in for the network: answers by URL, counting requests. */
function fakeNetwork(files: Record<string, Uint8Array | ((init?: RequestInit) => Response)>) {
  const requests: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push(url)
    const file = files[url]
    if (file === undefined) return new Response('missing', { status: 404 })
    if (typeof file === 'function') return file(init)
    return new Response(file.slice(), { headers: { 'content-length': String(file.byteLength) } })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

const allFiles = { [`${MIRROR}/model.json`]: CONFIG, [`${MIRROR}/weights.bin`]: WEIGHTS }

async function settle(models: EditorModels, taskId: string) {
  await models.whenIdle()
  return models.task(taskId)
}

describe('the packaged model list', () => {
  const manifests = packagedModelManifests()

  it('offers only models whose licence is clear', () => {
    const ids = manifests.map(model => model.id)
    expect(ids).not.toContain('mobilefaceswap-224')
    expect(ids).not.toContain('stable-audio-3-small-music-onnx')
    expect(ids).toEqual(expect.arrayContaining(['hojo-tts-light-80m-zh', 'timeline-studio-vocal-remover', 'whisper-small-q8', 'silero-vad', 'slimsam-77-uniform']))
    for (const model of manifests) expect(model.license.name.trim()).not.toBe('')
  })

  it('downloads from trusted hosts over HTTPS and names every file with a routable segment', () => {
    const segment = /^[A-Za-z0-9_$.-]+$/
    for (const model of manifests) {
      expect(model.id).toMatch(segment)
      expect(model.revision).toMatch(segment)
      for (const artifact of model.artifacts) {
        expect(artifact.id).toMatch(segment)
        for (const source of artifact.sources) {
          const url = new URL(source)
          expect(url.protocol).toBe('https:')
          expect(['vibedev.jzsaas.com', 'raw.githubusercontent.com', 'storage.googleapis.com']).toContain(url.hostname)
        }
      }
    }
  })

  it('asks once for all caption fonts', () => {
    const fonts = manifests.filter(model => model.capability === 'caption-font')
    expect(fonts.length).toBeGreaterThan(50)
    expect(fonts.every(model => model.group === 'caption-font' && model.license.name === 'OFL-1.1')).toBe(true)
    expect(manifests.filter(model => model.group !== undefined)).toHaveLength(fonts.length)
    // Named as the editor names them, which is what the question shows.
    expect(fonts.find(model => model.id === 'caption-font-zcool-kuaile')?.label).toBe('站酷快乐体')
    expect(fonts.some(model => model.label.startsWith('Caption font'))).toBe(false)
  })

  it('keeps models under the harness home by default', () => {
    expect(defaultModelsRoot({ DSH_HOME: join(root, 'home') })).toBe(join(root, 'home', 'cache', 'dsh-film', 'video-editor-models'))
    expect(defaultModelsRoot({ DSH_HOME: '  ' })).toMatch(/\.dsh[\\/]cache[\\/]dsh-film[\\/]video-editor-models$/)
  })
})

describe('consent', () => {
  it('downloads nothing before the person agrees, and remembers the answer', async () => {
    const network = fakeNetwork(allFiles)
    const models = new EditorModels({ root, manifests: [demoModel()], fetch: network.fetch })
    await expect(models.startPrepare('demo-model')).rejects.toMatchObject({ status: 409, code: 'VIDEO_EDITOR_MODEL_CONSENT_REQUIRED' })
    expect(network.requests).toEqual([])
    expect(await models.consent('demo-model')).toEqual({ modelId: 'demo-model', granted: false })
    expect(await models.setConsent('demo-model', true)).toEqual({ modelId: 'demo-model', granted: true, modelIds: ['demo-model'] })
    expect(JSON.parse(await readFile(join(root, 'consents.json'), 'utf8'))).toEqual({ 'demo-model': true })
    const again = new EditorModels({ root, manifests: [demoModel()], fetch: network.fetch })
    expect(await again.consent('demo-model')).toEqual({ modelId: 'demo-model', granted: true })
    await expect(models.consent('nope')).rejects.toMatchObject({ status: 404, code: 'VIDEO_EDITOR_MODEL_NOT_FOUND' })
  })

  it('answers for a whole group only when asked to', async () => {
    const models = new EditorModels({ root, manifests: [font('caption-font-a'), font('caption-font-b'), demoModel()] })
    expect((await models.setConsent('caption-font-a', true, true)).modelIds).toEqual(['caption-font-a', 'caption-font-b'])
    expect((await models.consent('caption-font-b')).granted).toBe(true)
    expect((await models.setConsent('demo-model', true, true)).modelIds).toEqual(['demo-model'])
    await models.setConsent('caption-font-b', false)
    expect((await models.consent('caption-font-a')).granted).toBe(true)
    expect((await models.consent('caption-font-b')).granted).toBe(false)
  })
})

describe('preparing a model', () => {
  it('downloads and verifies every file once, then finds them on disk', async () => {
    const network = fakeNetwork(allFiles)
    const models = new EditorModels({ root, manifests: [demoModel()], fetch: network.fetch })
    await models.setConsent('demo-model', true)
    const first = await models.startPrepare('demo-model')
    // Two callers asking at once share the download.
    const second = await models.startPrepare('demo-model')
    expect(await settle(models, first.taskId)).toMatchObject({ status: 'done', progress: 100, cached: true, phase: '演示模型 已下载' })
    expect((await settle(models, second.taskId)).status).toBe('done')
    expect(network.requests).toEqual([`${MIRROR}/model.json`, `${MIRROR}/weights.bin`])
    const file = await models.artifactFile('demo-model', 'weights')
    expect(file.path).toBe(join(root, 'demo-model', 'abc1234', 'weights.bin'))
    expect(new Uint8Array(await readFile(file.path))).toEqual(WEIGHTS)
    const fresh = new EditorModels({ root, manifests: [demoModel()], fetch: network.fetch })
    const third = await fresh.startPrepare('demo-model')
    expect(await settle(fresh, third.taskId)).toMatchObject({ status: 'done', phase: '演示模型 已在本机' })
    expect(network.requests).toHaveLength(2)
  })

  it('tries the next source, and refuses bytes that do not match', async () => {
    const backup = 'https://raw.githubusercontent.com/demo/weights.bin'
    const model = demoModel()
    const withBackup = demoModel({ artifacts: [model.artifacts[0]!, { ...model.artifacts[1]!, sources: [`${MIRROR}/weights.bin`, backup] }] })
    const network = fakeNetwork({ [`${MIRROR}/model.json`]: CONFIG, [`${MIRROR}/weights.bin`]: () => new Response('down', { status: 503 }), [backup]: WEIGHTS })
    const models = new EditorModels({ root, manifests: [withBackup], fetch: network.fetch })
    await models.setConsent('demo-model', true)
    expect((await settle(models, (await models.startPrepare('demo-model')).taskId)).status).toBe('done')
    expect(network.requests).toContain(backup)

    const tampered = await mkdtemp(join(tmpdir(), 'dsh-film-models-bad-'))
    try {
      const bad = new EditorModels({ root: tampered, manifests: [demoModel()], fetch: fakeNetwork({ ...allFiles, [`${MIRROR}/weights.bin`]: new TextEncoder().encode('x'.repeat(WEIGHTS.byteLength)) }).fetch })
      await bad.setConsent('demo-model', true)
      const task = await settle(bad, (await bad.startPrepare('demo-model')).taskId)
      expect(task).toMatchObject({ status: 'failed', error: { code: 'VIDEO_EDITOR_MODEL_INTEGRITY_FAILED' } })
      expect(task.error?.message).toContain('weights.bin 校验不通过')
      expect(await readdir(join(tampered, 'demo-model', 'abc1234'))).toEqual(['model.json'])
      await expect(bad.artifactFile('demo-model', 'weights')).rejects.toMatchObject({ status: 409, code: 'VIDEO_EDITOR_MODEL_NOT_READY' })
    } finally {
      await rm(tampered, { recursive: true, force: true })
    }
  })

  it('does not follow a redirect to a host it does not trust', async () => {
    const network = fakeNetwork({
      ...allFiles,
      [`${MIRROR}/model.json`]: () => {
        const response = new Response(CONFIG.slice())
        Object.defineProperty(response, 'url', { value: 'https://evil.example/model.json' })
        return response
      },
    })
    const models = new EditorModels({ root, manifests: [demoModel()], fetch: network.fetch })
    await models.setConsent('demo-model', true)
    const task = await settle(models, (await models.startPrepare('demo-model')).taskId)
    expect(task).toMatchObject({ status: 'failed', error: { code: 'VIDEO_EDITOR_MODEL_DOWNLOAD_FAILED' } })
    expect(task.error?.message).toContain('untrusted host: evil.example')
  })

  it('gives up on a source that goes quiet', async () => {
    const silent = () => new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) }))
    const models = new EditorModels({ root, manifests: [demoModel()], fetch: fakeNetwork({ ...allFiles, [`${MIRROR}/weights.bin`]: silent }).fetch, stallTimeoutMs: 50 })
    await models.setConsent('demo-model', true)
    const task = await settle(models, (await models.startPrepare('demo-model')).taskId)
    expect(task).toMatchObject({ status: 'failed', error: { code: 'VIDEO_EDITOR_MODEL_DOWNLOAD_FAILED' } })
    expect(task.error?.message).toContain('no data for 0 s')
  })

  it('stops the download when its only follower cancels', async () => {
    let started = false
    let aborted = false
    const slow = (init?: RequestInit) => {
      started = true
      init?.signal?.addEventListener('abort', () => { aborted = true })
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(WEIGHTS.slice(0, 8)) },
        pull: () => new Promise<void>(() => {}),
      }))
    }
    const models = new EditorModels({ root, manifests: [demoModel()], fetch: fakeNetwork({ ...allFiles, [`${MIRROR}/weights.bin`]: slow }).fetch })
    await models.setConsent('demo-model', true)
    const { taskId } = await models.startPrepare('demo-model')
    for (let tries = 0; tries < 200 && !started; tries++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(models.task(taskId)).toMatchObject({ status: 'running', phase: expect.stringContaining('正在下载 演示模型') })
    expect(models.cancel(taskId)).toBe(true)
    expect(await settle(models, taskId)).toMatchObject({ status: 'interrupted', phase: '已取消', error: { code: 'VIDEO_EDITOR_MODEL_CANCELED' } })
    expect(aborted).toBe(true)
    expect((await readdir(join(root, 'demo-model', 'abc1234'))).filter(name => name.includes('.part-'))).toEqual([])
    expect(models.cancel(taskId)).toBe(false)
    expect(() => models.task('nope')).toThrow(EditorModelError)
  })

  it('stops serving a file changed behind its back', async () => {
    const models = new EditorModels({ root, manifests: [demoModel()], fetch: fakeNetwork(allFiles).fetch })
    await models.setConsent('demo-model', true)
    await settle(models, (await models.startPrepare('demo-model')).taskId)
    const { path } = await models.artifactFile('demo-model', 'weights')
    await writeFile(path, new TextEncoder().encode('y'.repeat(WEIGHTS.byteLength)))
    await utimes(path, new Date(), new Date(Date.now() + 5_000))
    await expect(models.artifactFile('demo-model', 'weights')).rejects.toMatchObject({ code: 'VIDEO_EDITOR_MODEL_NOT_READY' })
  })
})

describe('the model routes', () => {
  async function call(router: ReturnType<typeof createStudioRouter>, path: string, json?: unknown) {
    const url = new URL(`http://host/api/dsh-film/${json === undefined ? 'studio' : 'studio-write'}`)
    url.searchParams.set('cwd', cwd)
    url.searchParams.set('path', path)
    if (json !== undefined) url.searchParams.set('method', 'POST')
    return router.dispatch(new Request(url, json === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }))
  }

  it('lists, asks, prepares and serves like Studio', async () => {
    const models = new EditorModels({ root, manifests: [demoModel(), font('caption-font-a'), font('caption-font-b')], fetch: fakeNetwork(allFiles).fetch })
    const router = createStudioRouter({ models })
    const listing = await (await call(router, '/api/media/video-editor-models')).json() as { models: Record<string, unknown>[] }
    expect(listing.models[0]).toEqual({
      schemaVersion: 1, id: 'demo-model', label: '演示模型', capability: 'segmentation', revision: 'abc1234',
      license: { name: 'MIT', url: 'https://opensource.org/license/mit' }, consent: 'download',
      totalBytes: CONFIG.byteLength + WEIGHTS.byteLength, sourceHosts: ['vibedev.jzsaas.com'],
      artifacts: [
        { id: 'model.json', fileName: 'model.json', bytes: CONFIG.byteLength, sha256: sha256(CONFIG) },
        { id: 'weights', fileName: 'weights.bin', bytes: WEIGHTS.byteLength, sha256: sha256(WEIGHTS) },
      ],
    })
    expect(listing.models[1]).toMatchObject({ group: 'caption-font', groupSize: 2 })

    const refused = await call(router, '/api/media/video-editor-models/demo-model/prepare', {})
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: '下载 演示模型 之前需要你的同意。', code: 'VIDEO_EDITOR_MODEL_CONSENT_REQUIRED' })
    expect((await call(router, '/api/media/video-editor-models/demo-model/consent', { granted: 'yes' })).status).toBe(400)
    expect(await (await call(router, '/api/media/video-editor-models/caption-font-a/consent', { granted: true, group: true })).json()).toEqual({ modelId: 'caption-font-a', granted: true, modelIds: ['caption-font-a', 'caption-font-b'] })
    expect(await (await call(router, '/api/media/video-editor-models/demo-model/consent', { granted: true })).json()).toMatchObject({ granted: true })
    expect(await (await call(router, '/api/media/video-editor-models/demo-model/consent')).json()).toEqual({ modelId: 'demo-model', granted: true })

    // Not there yet: a model file route answers 404 and nothing caches it.
    const route = modelFileRoutes(models).find(entry => entry.path === modelFileRoute('demo-model', 'abc1234', 'weights'))!
    const early = await route.fetch(new Request(`http://host${route.path}`))
    expect(early.status).toBe(404)
    expect(early.headers.get('cache-control')).toBe('no-store')

    const started = await call(router, '/api/media/video-editor-models/demo-model/prepare', {})
    expect(started.status).toBe(202)
    const { taskId } = await started.json() as { taskId: string }
    await models.whenIdle()
    expect(await (await call(router, `/api/media/video-editor-model-tasks/${taskId}`)).json()).toMatchObject({ taskId, modelId: 'demo-model', status: 'done', progress: 100 })
    expect(await (await call(router, `/api/media/video-editor-model-tasks/${taskId}/cancel`, {})).json()).toEqual({ ok: true })

    const viaStudio = await call(router, '/api/media/video-editor-models/demo-model/artifacts/model.json')
    expect(viaStudio.status).toBe(200)
    expect(viaStudio.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await viaStudio.text()).toBe('{"layers":3}')
    const served = await route.fetch(new Request(`http://host${route.path}`))
    expect(served.status).toBe(200)
    expect(served.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(WEIGHTS)
    expect((await route.fetch(new Request(`http://host${route.path}`, { method: 'HEAD' }))).status).toBe(200)
    expect((await call(router, '/api/media/video-editor-models/demo-model/artifacts/other')).status).toBe(404)
    expect((await call(router, '/api/media/video-editor-model-tasks/nope')).status).toBe(404)
  })

  it('are not offered without a model store', async () => {
    expect((await call(createStudioRouter(), '/api/media/video-editor-models')).status).toBe(404)
  })
})
