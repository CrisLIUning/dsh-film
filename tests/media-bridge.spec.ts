/** Generation from the canvas through a stand-in for dsh-media's `vibedevMedia` service. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canvasCatalogue } from '../src/media/catalogue.js'
import type { HostMediaModel } from '../src/media/catalogue.js'
import { FilmMediaTasks } from '../src/media/tasks.js'
import type { MediaServiceLike, MediaTaskLike } from '../src/media/tasks.js'
import { createStudioRouter } from '../src/routes.js'

const MODELS: HostMediaModel[] = [
  {
    id: 'gpt-image-2.5-flare', name: 'GPT Image', kind: 'image', inputModalities: ['text', 'image'],
    pricing: { currency: 'CNY', tiers: [{ tier: '1K', unit: 'generation', amount: 0.1 }] },
  },
  {
    id: 'seedance-2.0', name: 'Seedance 2.0', kind: 'video', inputModalities: ['text', 'image', 'video', 'audio'],
    pricing: { currency: 'CNY', tiers: [{ tier: '720p', unit: 'second', amount: 0.99 }] },
    video: {
      ratios: ['16:9', '9:16'], resolutions: ['720p'], durations: [5, 10], nativeAudio: true,
      maxReferenceImages: 9, maxReferenceVideos: 3, maxReferenceAudios: 3,
      modes: {
        text_to_video: { inputs: {}, requiredAnyOf: [] },
        first_frame: { inputs: { firstFrame: { min: 1, max: 1, hosted: true } }, requiredAnyOf: [['firstFrame']] },
        omni_reference: { inputs: { referenceImages: { min: 0, max: 9, hosted: true }, referenceVideos: { min: 0, max: 3, hosted: true } }, requiredAnyOf: [['referenceImages'], ['referenceVideos']], durations: [5] },
      },
    },
  },
]

let cwd: string
let created: FilmMediaTasks[]

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-media-'))
  created = []
})

afterEach(async () => {
  for (const tasks of created) {
    tasks.dispose()
    await tasks.settled()
  }
  await rm(cwd, { recursive: true, force: true })
})

/** Media tasks the test cleans up after (their saves land before the folder goes). */
function newTasks(media: () => MediaServiceLike | undefined): FilmMediaTasks {
  const tasks = new FilmMediaTasks(media)
  created.push(tasks)
  return tasks
}

const routerWith = (service?: MediaServiceLike) => {
  const media = () => service
  return createStudioRouter({ media, tasks: newTasks(media) })
}

/** A stand-in service that saves a tiny file and lets tests drive video tasks. */
function fakeMedia() {
  const listeners = new Map<string, (task: MediaTaskLike) => void>()
  const tasks = new Map<string, MediaTaskLike>()
  const calls: { kind: string; request: unknown; target: unknown }[] = []
  const service: MediaServiceLike = {
    models: async () => MODELS,
    generateImages: async (request, target) => {
      calls.push({ kind: 'image', request, target })
      const absolutePath = join(target.folder, `${target.stem}.png`)
      await mkdir(target.folder, { recursive: true })
      await writeFile(absolutePath, 'png')
      return { model: request.model ?? 'gpt-image-2.5-flare', images: [{ absolutePath, mediaType: 'image/png', bytes: 3 }] }
    },
    startVideo: async (request, target) => {
      calls.push({ kind: 'video', request, target })
      const task: MediaTaskLike = { id: 'mt-1', model: 'seedance-2.0', status: 'pending' }
      tasks.set(task.id, task)
      return task
    },
    task: async id => tasks.get(id),
    onTask: (id, listener) => {
      listeners.set(id, listener)
      return () => { listeners.delete(id) }
    },
  }
  const push = (task: MediaTaskLike): void => {
    tasks.set(task.id, task)
    listeners.get(task.id)?.(task)
  }
  return { service, calls, push }
}

async function call(router: ReturnType<typeof createStudioRouter>, path: string, body?: unknown) {
  const url = new URL(`http://host/api/dsh-film/${body === undefined ? 'studio' : 'studio-write'}`)
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', path)
  if (body !== undefined) url.searchParams.set('method', 'POST')
  const response = await router.dispatch(new Request(url, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { status: response.status, body: await response.json() as any }
}

async function waitDone(router: ReturnType<typeof createStudioRouter>, taskId: string) {
  let since = 0
  for (let round = 0; round < 20; round++) {
    const { body } = await call(router, `/api/media/tasks/${taskId}/wait`, { since, timeoutMs: 200 })
    since = body.nextSince
    if (['done', 'failed', 'interrupted'].includes(body.status)) return body
  }
  throw new Error('task did not finish')
}

describe('canvas catalogue', () => {
  it('carries the gateway video modes and limits in the canvas vocabulary', () => {
    const catalogue = canvasCatalogue(MODELS) as any
    expect(catalogue.providers).toEqual([{ id: 'vibedev-gateway', label: 'VibeDev', integrated: true, configured: true, configurationSource: 'vibedev-gateway' }])
    expect(catalogue.image[0]).toMatchObject({ id: 'gpt-image-2.5-flare', provider: 'vibedev-gateway', pricing: { amountCny: 0.1, unit: 'generation', exact: true, source: 'gateway' } })
    const video = catalogue.video[0]
    expect(video.videoCapabilities).toMatchObject({
      videoModeSchemaVersion: 1,
      videoModes: ['text-to-video', 'image-to-video', 'reference'],
      textToVideo: true, imageToVideo: true, referenceImageInput: true, referenceVideoInput: true, nativeAudioOutput: true,
      maxReferenceImages: 9, supportedAspects: ['16:9', '9:16'],
    })
    expect(video.videoCapabilities.videoModeConstraints.reference).toEqual({
      inputs: { referenceImages: { min: 0, max: 9, source: 'gateway_media_asset' }, referenceVideos: { min: 0, max: 3, source: 'gateway_media_asset' } },
      requiredAnyOf: [['referenceImages'], ['referenceVideos']],
      supportedAspects: ['16:9', '9:16'], supportedResolutions: ['720p'], supportedDurationsSeconds: [5],
    })
    expect(catalogue.videoLengthsSec).toEqual([5, 10])
  })

  it('passes the reference-video, asset, combination and relay limits through', () => {
    const video: HostMediaModel = {
      id: 'seedance-2-0-official', name: 'Seedance 2.0', kind: 'video', inputModalities: ['text', 'image', 'video', 'audio'],
      video: {
        ...MODELS[1]!.video!,
        minReferenceVideoSeconds: 2, maxReferenceVideoSeconds: 13, maxTotalReferenceVideoSeconds: 15, maxAssetBytes: 52_428_800,
        gatewayRelayRequired: true, combinations: [{ duration: 5, ratio: '16:9', resolution: '720p' }, { duration: 10 }],
      },
    }
    const caps = (canvasCatalogue([video]) as any).video[0].videoCapabilities
    expect(caps).toMatchObject({
      minReferenceVideoSeconds: 2, maxReferenceVideoSeconds: 13, maxTotalReferenceVideoSeconds: 15, maxAssetBytes: 52_428_800,
      gatewayRelayRequired: true, combinations: [{ duration: 5, ratio: '16:9', resolution: '720p' }, { duration: 10 }],
    })
    // Copies: the canvas's catalogue never shares arrays with dsh-media's models.
    expect(caps.combinations[0]).not.toBe(video.video!.combinations![0])
    // Undeclared limits stay out rather than reading as 0.
    const plain = (canvasCatalogue(MODELS) as any).video[0].videoCapabilities
    for (const field of ['minReferenceVideoSeconds', 'maxReferenceVideoSeconds', 'maxTotalReferenceVideoSeconds', 'maxAssetBytes', 'gatewayRelayRequired', 'combinations']) {
      expect(plain, field).not.toHaveProperty(field)
    }
  })

  it('gives every image model the Host image profile, and video models none', () => {
    const catalogue = canvasCatalogue([MODELS[0]!, { ...MODELS[0]!, id: 'gpt-image-2.5-sunburst' }, MODELS[1]!]) as any
    const profile = {
      v: 1,
      source: 'host-profile',
      sizes: [{ value: '1024x1024', aspect: '1:1' }, { value: '1536x1024', aspect: '3:2' }, { value: '1024x1536', aspect: '2:3' }],
      qualities: ['auto', 'low', 'medium', 'high'],
      maxOutputs: 4,
      maxReferenceImages: 16,
      maxReferenceImageBytes: 20_971_520,
      allowedImageMimes: ['image/png', 'image/jpeg', 'image/webp'],
    }
    expect(catalogue.image.map((model: any) => model.imageCapabilities)).toEqual([profile, profile])
    expect(catalogue.video[0].imageCapabilities).toBeUndefined()
    // Each model gets its own copy.
    catalogue.image[0].imageCapabilities.sizes.pop()
    expect(catalogue.image[1].imageCapabilities.sizes).toHaveLength(3)
    expect((canvasCatalogue([MODELS[0]!]) as any).image[0].imageCapabilities).toEqual(profile)
  })
})

describe('canvas generation', () => {
  it('says generation needs dsh-media when it is not running', async () => {
    const router = routerWith()
    const catalogue = await call(router, '/api/media/models?allSources=1')
    expect(catalogue.body.providers[0]).toMatchObject({ configured: false })
    const refused = await call(router, '/api/projects/p1/media/generate', { surface: 'image', prompt: 'x' })
    expect(refused).toMatchObject({ status: 503, body: { error: { code: 'MEDIA_SERVICE_UNAVAILABLE' } } })
  })

  it('generates an image into the project path the canvas asked for', async () => {
    const media = fakeMedia()
    const router = routerWith(media.service)
    const started = await call(router, '/api/projects/p1/media/generate', {
      surface: 'image', model: 'gpt-image-2.5-flare', prompt: '雨夜客栈', aspect: '16:9',
      images: ['canvas/refs/ref-1.png'], referenceImages: ['https://cdn.test/a.png'], output: 'canvas/media/image-abc.png',
    })
    expect(started.status).toBe(202)
    const done = await waitDone(router, started.body.taskId)
    expect(done).toMatchObject({ status: 'done', file: { name: 'canvas/media/image-abc.png', kind: 'image', mime: 'image/png', size: 3 } })
    expect(media.calls[0]).toMatchObject({
      request: { prompt: '雨夜客栈', size: '1536x1024', references: ['https://cdn.test/a.png', join(cwd, 'film', 'canvas', 'refs', 'ref-1.png')] },
      target: { cwd, folder: join(cwd, 'film', 'canvas', 'media'), stem: 'image-abc' },
    })
    // One image per call, whatever count the page shows (imageCapabilities.maxOutputs is separate calls).
    expect(media.calls[0]!.request).not.toHaveProperty('n')
    expect(await readFile(join(cwd, 'film', 'canvas', 'media', 'image-abc.png'), 'utf8')).toBe('png')
  })

  it('submits a video and mirrors dsh-media\'s task until it ends', async () => {
    const media = fakeMedia()
    const router = routerWith(media.service)
    const started = await call(router, '/api/projects/p1/media/generate', {
      surface: 'video', model: 'seedance-2.0', prompt: '推门而入', videoMode: 'image-to-video', images: ['canvas/refs/first.png'], length: 5, aspect: '16:9',
      output: 'canvas/media/video-xyz.mp4',
    })
    const taskId = started.body.taskId
    let snapshot = (await call(router, `/api/media/tasks/${taskId}/wait`, { since: 0, timeoutMs: 100 })).body
    for (let round = 0; round < 10 && media.calls.length === 0; round++) snapshot = (await call(router, `/api/media/tasks/${taskId}/wait`, { since: snapshot.nextSince, timeoutMs: 100 })).body
    expect(media.calls[0]?.request).toMatchObject({ mode: 'first_frame', firstFrame: join(cwd, 'film', 'canvas', 'refs', 'first.png'), duration: 5, aspectRatio: '16:9' })
    media.push({ id: 'mt-1', model: 'seedance-2.0', status: 'pending', progress: 'running' })
    media.push({ id: 'mt-1', model: 'seedance-2.0', status: 'completed', outputs: [{ path: join(cwd, 'film', 'canvas', 'media', 'video-xyz.mp4') }] })
    const done = await waitDone(router, taskId)
    expect(done).toMatchObject({ status: 'done', file: { name: 'canvas/media/video-xyz.mp4', kind: 'video', mime: 'video/mp4' } })
  })

  it('holds a wait until the task changes', async () => {
    const media = fakeMedia()
    const tasks = newTasks(() => media.service)
    const { taskId } = await tasks.generate(cwd, 'p1', { surface: 'video', prompt: 'x', output: 'canvas/media/v.mp4' })
    const first = await tasks.wait(cwd, taskId, 0, 100)
    const pending = tasks.wait(cwd, taskId, first.nextSince, 5_000)
    let settled = false
    void pending.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    media.push({ id: 'mt-1', model: 'seedance-2.0', status: 'failed', error: { code: 'UPSTREAM_FAILED', message: '上游失败' } })
    const failed = await pending
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'UPSTREAM_FAILED', message: '上游失败' } })
    tasks.dispose()
  })

  it('marks an image request that a restart cut off as interrupted', async () => {
    await mkdir(join(cwd, 'film', '.tasks'), { recursive: true })
    await writeFile(join(cwd, 'film', '.tasks', 'old-task.json'), JSON.stringify({
      taskId: 'old-task', projectId: 'p1', surface: 'image', model: 'm', status: 'running', startedAt: 1, endedAt: null, progress: ['已提交', '生成中'], error: null,
    }))
    const tasks = newTasks(() => fakeMedia().service)
    const snapshot = await tasks.wait(cwd, 'old-task', 2, 100)
    expect(snapshot).toMatchObject({ status: 'interrupted', progress: ['已中断'], error: { code: 'MEDIA_TASK_INTERRUPTED' } })
  })

  it('refuses outputs outside the project and unknown tasks', async () => {
    const router = routerWith(fakeMedia().service)
    expect((await call(router, '/api/projects/p1/media/generate', { surface: 'image', prompt: 'x', output: '../escape.png' })).body.error.code).toBe('MEDIA_PATH_INVALID')
    expect((await call(router, '/api/media/tasks/nope/wait', { since: 0, timeoutMs: 10 })).status).toBe(404)
  })
})
