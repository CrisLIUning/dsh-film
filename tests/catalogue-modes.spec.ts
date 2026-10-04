/**
 * Video modes in the canvas catalogue follow dsh-media's effective modes, on the
 * gateway's real video lanes (the 2026-10-03 catalogue as dsh-media reads it).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UNREADABLE_VIDEO_MODES_REASON, canvasCatalogue, effectiveVideoModes, videoCapabilities } from '../src/media/catalogue.js'
import type { HostMediaModel, HostVideoCapabilities } from '../src/media/catalogue.js'
import { FIRST_FRAME_AS_REFERENCE, FilmMediaTasks } from '../src/media/tasks.js'
import type { MediaServiceLike, VideoServiceRequest } from '../src/media/tasks.js'

const fixtures = resolve(import.meta.dirname, 'fixtures')
const LANES = (JSON.parse(readFileSync(join(fixtures, 'gateway-video-models-1003.json'), 'utf8')) as { models: HostMediaModel[] }).models
const BEFORE = (JSON.parse(readFileSync(join(fixtures, 'catalogue-v1-lanes-0.2.0.json'), 'utf8')) as { lanes: Record<string, Record<string, unknown>> }).lanes

/** The lanes that declare `first_frame: false` and take reference images. */
const NO_FIRST_FRAME = [
  'seedance-2.5-vibedev', 'seedance-2.5-30s-vibedev', 'seedance-2.5-480p-30s-shanhai',
  'lec-gt-seedance-2-5-720p', 'lec-md-seedance-2-5-900-720p', 'lec-seed-2-5-900',
]
const SCHEMA_V1 = [
  'seedance-2-0-official', 'seedance-2-0-official-fast', 'seedance-2-0-official-mini',
  'seedance-2.0', 'seedance-2.0-1080p', 'seedance-2.0-480p', 'seedance-2.0-4k',
]

const lane = (id: string): HostMediaModel => {
  const found = LANES.find(model => model.id === id)
  if (found === undefined) throw new Error(`no lane ${id} in the fixture`)
  return found
}
const catalogueEntry = (id: string): any => (canvasCatalogue(LANES) as any).video.find((model: { id: string }) => model.id === id)

describe('the fixture', () => {
  it('holds the 14 video lanes: six without first frames, seedance-2-5-special, and seven in modes schema 1', () => {
    expect(LANES).toHaveLength(14)
    expect(LANES.every(model => model.kind === 'video' && model.video !== undefined)).toBe(true)
    for (const id of NO_FIRST_FRAME) {
      expect(lane(id).video).toMatchObject({ firstFrame: false, imageToVideo: true })
      expect(lane(id).video?.modes).toBeUndefined()
    }
    for (const id of SCHEMA_V1) expect(lane(id).video?.modes).toBeDefined()
    expect(lane('seedance-2-5-special').video).toMatchObject({ firstFrame: true, lastFrame: false })
  })
})

describe('video modes in the canvas catalogue', () => {
  it.each(NO_FIRST_FRAME)('%s offers no 图生视频, only 文生视频 and 全能参考', id => {
    const entry = catalogueEntry(id)
    expect(entry.available).toBe(true)
    expect(entry.unavailableReason).toBeUndefined()
    const caps = entry.videoCapabilities
    expect(caps.videoModeSchemaVersion).toBe(1)
    expect(caps.videoModes).toEqual(['text-to-video', 'reference'])
    expect(Object.keys(caps.videoModeConstraints)).toEqual(['text-to-video', 'reference'])
    expect(caps.imageToVideo).toBe(false)
    expect(caps.textToVideo).toBe(true)
    const images = lane(id).video!.maxReferenceImages!
    expect(caps.videoModeConstraints.reference.inputs.referenceImages).toEqual({ min: 0, max: images })
    expect(caps.videoModeConstraints.reference.requiredAnyOf[0]).toEqual(['referenceImages'])
  })

  it('keeps 全能参考 audio riding the images on the shanhai lane, never alone', () => {
    const reference = catalogueEntry('seedance-2.5-480p-30s-shanhai').videoCapabilities.videoModeConstraints.reference
    expect(reference.inputs.referenceAudios).toEqual({ min: 0, max: 9 })
    expect(reference.requiredAnyOf).toEqual([['referenceImages']])
  })

  it('gives seedance-2-5-special 图生视频 but no 首尾帧', () => {
    const caps = catalogueEntry('seedance-2-5-special').videoCapabilities
    expect(caps.videoModes).toEqual(['text-to-video', 'image-to-video', 'reference'])
    expect(caps.videoModeConstraints['image-to-video']).toMatchObject({ inputs: { firstFrame: { min: 1, max: 1 } }, requiredAnyOf: [['firstFrame']] })
    expect(caps.videoModeConstraints['first-last-frame']).toBeUndefined()
    expect(caps.imageToVideo).toBe(true)
  })

  it.each(SCHEMA_V1)('leaves the schema-1 lane %s as 0.2.0 listed it', id => {
    const caps = catalogueEntry(id).videoCapabilities
    const before = BEFORE[id]!
    expect(caps.videoModes).toEqual(before.videoModes)
    expect(caps.videoModeConstraints).toEqual(before.videoModeConstraints)
    expect(caps).toMatchObject(before)
  })

  it('lists a model whose modes block dsh-media cannot read as unavailable, with the reason', () => {
    const unreadable: HostMediaModel = { ...lane('seedance-2.0'), id: 'future-lane', video: { ...lane('seedance-2.0').video!, modes: undefined, unreadableModesVersion: 2 } }
    const entry = (canvasCatalogue([unreadable]) as any).video[0]
    expect(entry).toMatchObject({ id: 'future-lane', available: false, unavailableReason: UNREADABLE_VIDEO_MODES_REASON })
    expect(entry.videoCapabilities).toMatchObject({ videoModeSchemaVersion: 1, videoModeConstraints: {}, videoModes: [], textToVideo: false, imageToVideo: false })
  })
})

describe('effectiveVideoModes (dsh-media\'s rule) on legacy entries', () => {
  const modes = (video: HostVideoCapabilities): string[] => Object.keys(effectiveVideoModes(video))

  it('opens the first frame for image-to-video only when nothing else takes an image', () => {
    expect(modes({ imageToVideo: true })).toEqual(['text_to_video', 'first_frame'])
    expect(modes({ imageToVideo: true, maxReferenceImages: 4 })).toEqual(['text_to_video', 'omni_reference'])
    expect(modes({ imageToVideo: true, firstFrame: false })).toEqual(['text_to_video'])
    expect(modes({ firstFrame: true, maxReferenceImages: 4 })).toEqual(['text_to_video', 'first_frame', 'omni_reference'])
  })

  it('opens first-last frames only with both flags, and never a reference of audio alone', () => {
    expect(modes({ firstFrame: true, lastFrame: true })).toEqual(['text_to_video', 'first_frame', 'first_last_frame'])
    expect(modes({ lastFrame: true })).toEqual(['text_to_video'])
    expect(modes({ textToVideo: false, maxReferenceAudios: 3 })).toEqual([])
  })

  it('marks reference videos hosted when the gateway relays them', () => {
    expect(effectiveVideoModes({ maxReferenceVideos: 2, gatewayRelayRequired: true }).omni_reference?.inputs.referenceVideos).toEqual({ min: 0, max: 2, hosted: true })
    expect(videoCapabilities({ maxReferenceVideos: 2, gatewayRelayRequired: true }).videoModeConstraints).toMatchObject({
      reference: { inputs: { referenceVideos: { min: 0, max: 2, source: 'gateway_media_asset' } } },
    })
  })

  it('serves no mode for an unreadable modes version, declared modes or not', () => {
    expect(modes({ unreadableModesVersion: 2, textToVideo: true, maxReferenceImages: 4 })).toEqual([])
  })
})

describe('an image-to-video request on a lane without first frames', () => {
  let cwd: string
  let tasks: FilmMediaTasks | undefined

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'dsh-film-modes-'))
  })

  afterEach(async () => {
    tasks?.dispose()
    await tasks?.settled()
    tasks = undefined
    await rm(cwd, { recursive: true, force: true })
  })

  /** Submit one canvas video body and return what dsh-media was asked for, and the task's progress lines. */
  async function submit(body: Record<string, unknown>, models: () => Promise<readonly HostMediaModel[]> = async () => LANES): Promise<{ request: VideoServiceRequest; progress: string[] }> {
    const requests: VideoServiceRequest[] = []
    const service: MediaServiceLike = {
      models,
      generateImages: async () => { throw new Error('not used') },
      startVideo: async request => {
        requests.push(request)
        return { id: 'mt-1', model: request.model ?? '', status: 'pending' }
      },
      task: async () => undefined,
      onTask: () => () => {},
    }
    tasks = new FilmMediaTasks(() => service)
    const { taskId } = await tasks.generate(cwd, 'p1', { surface: 'video', prompt: '推门而入', output: 'canvas/media/v.mp4', ...body })
    for (let round = 0; round < 50 && requests.length === 0; round++) await new Promise(done => setTimeout(done, 10))
    expect(requests).toHaveLength(1)
    const snapshot = await tasks.wait(cwd, taskId, 0, 10) as { progress: string[] }
    return { request: requests[0]!, progress: snapshot.progress }
  }

  const still = (): string => join(cwd, 'film', 'canvas', 'refs', 'first.png')

  it.each(NO_FIRST_FRAME)('sends the one image on %s as a 全能参考 reference image, not a first frame', async id => {
    const { request, progress } = await submit({ model: id, videoMode: 'image-to-video', images: ['canvas/refs/first.png'] })
    expect(request.mode).toBe('omni_reference')
    expect(request.referenceImages).toEqual([still()])
    expect(request.firstFrame).toBeUndefined()
    expect(progress).toContain(FIRST_FRAME_AS_REFERENCE)
  })

  it('moves an explicitly named first frame to the front of the reference images', async () => {
    const { request } = await submit({
      model: 'seedance-2.5-vibedev', videoMode: 'image-to-video', firstFrame: 'canvas/refs/first.png', referenceImages: ['https://cdn.test/style.png'],
    })
    expect(request).toMatchObject({ mode: 'omni_reference', referenceImages: [still(), 'https://cdn.test/style.png'] })
    expect(request.firstFrame).toBeUndefined()
  })

  it('keeps 图生视频 as a first frame where the lane has one', async () => {
    for (const id of ['seedance-2-5-special', 'seedance-2.0']) {
      const { request, progress } = await submit({ model: id, videoMode: 'image-to-video', images: ['canvas/refs/first.png'] })
      expect(request).toMatchObject({ mode: 'first_frame', firstFrame: still() })
      expect(request.referenceImages).toBeUndefined()
      expect(progress).not.toContain(FIRST_FRAME_AS_REFERENCE)
      tasks?.dispose()
      await tasks?.settled()
    }
  })

  it('changes nothing for an unknown model, no model, or a catalogue that cannot be read', async () => {
    for (const [body, models] of [
      [{ model: 'not-listed' }, undefined],
      [{}, undefined],
      [{ model: 'seedance-2.5-vibedev' }, async () => { throw new Error('signed out') }],
    ] as const) {
      const { request } = await submit({ ...body, videoMode: 'image-to-video', images: ['canvas/refs/first.png'] }, models)
      expect(request).toMatchObject({ mode: 'first_frame', firstFrame: still() })
      tasks?.dispose()
      await tasks?.settled()
    }
  })
})
