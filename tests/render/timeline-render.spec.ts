/**
 * The film's cut rendered by the Host (ported from Studio's
 * canvas-timeline-render.test.ts): how a request is read, which project file a
 * clip plays, how a cut is refused, how the plan is made, and — with a Node
 * script standing in for ffmpeg, so it runs on Windows — what a finished,
 * failed, stuck or cancelled render leaves behind. With a real ffmpeg on the
 * machine (resolveFfmpeg finds one) a still and a clip with sound render for real.
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeMedia } from '../../src/media/probe.js'
import { ffmpegFilterNames, resolveFfmpeg, runFfmpeg } from '../../src/render/ffmpeg.js'
import {
  RENDER_STALL_TIMEOUT_MS,
  TimelineRenderError,
  buildTimelinePlan,
  captionFontIdsOf,
  collectRenderMedia,
  keepRender,
  normalizeRenderRequest,
  partialPathFor,
  removeStalePartials,
  renderFirstOutputMs,
  renderOutputPath,
  renderSizeFor,
  renderTimeLimitMs,
  renderTimeline,
  segmentProjectPath,
} from '../../src/render/timeline-render.js'
import type { FfmpegRunner } from '../../src/render/timeline-render.js'
import { createEmptyTimelineArchive } from '../../src/timeline/archive.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function still(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'clip-1',
    type: 'image',
    name: 'still.png',
    duration: 1,
    assetId: 'canvas-file:canvas/media/still.png',
    assetVersionId: 'canvas-file:canvas/media/still.png',
    sourceUrl: '/api/projects/film-1/raw/canvas/media/still.png',
    src: '/api/projects/film-1/raw/canvas/media/still.png',
    archiveMediaId: 'canvas-file:canvas/media/still.png',
    sourceStart: 0,
    sourceDuration: 0,
    playbackRate: 1,
    muted: false,
    integrity: { sha256: 'x', size: PNG.length, mimeType: 'image/png', archivePath: 'canvas/media/still.png' },
    ...overrides,
  }
}

function take(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return still({
    id: 'take-1', type: 'video', name: 'take.mp4', duration: 2, sourceDuration: 2,
    assetId: 'canvas-file:canvas/media/take.mp4', assetVersionId: 'canvas-file:canvas/media/take.mp4', archiveMediaId: 'canvas-file:canvas/media/take.mp4',
    sourceUrl: '/api/projects/film-1/raw/canvas/media/take.mp4', src: '/api/projects/film-1/raw/canvas/media/take.mp4',
    integrity: { sha256: 'x', size: 4, mimeType: 'video/mp4', archivePath: 'canvas/media/take.mp4' },
    ...overrides,
  })
}

function cut(visuals: Record<string, unknown>[], extra: Record<string, unknown> = {}): { project: Record<string, unknown> } {
  const archive = createEmptyTimelineArchive('16:9')
  archive.project.visualSegments = visuals
  Object.assign(archive.project, extra)
  return archive
}

let projectDir = ''
let scratch = ''

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'dsh-film-render-'))
  scratch = await mkdtemp(join(tmpdir(), 'dsh-film-render-fake-'))
  await mkdir(join(projectDir, 'canvas', 'media'), { recursive: true })
  await writeFile(join(projectDir, 'canvas', 'media', 'still.png'), PNG)
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const settings = { frameRate: 30 as const, resolution: '720' as const }

/** A stand-in ffmpeg: a Node script run with this Node, given the arguments ffmpeg would get. */
async function fakeFfmpeg(body: string): Promise<{ runner: FfmpegRunner; calls: string[][] }> {
  const script = join(scratch, `ffmpeg-${Math.random().toString(36).slice(2)}.mjs`)
  await writeFile(script, body)
  const calls: string[][] = []
  return {
    calls,
    runner: (run) => {
      calls.push(run.argv)
      return runFfmpeg({ ...run, binary: process.execPath, argv: [script, ...run.argv] })
    },
  }
}

/** Writes an MP4-looking file where the output goes, reports progress, and meters loudness when asked. */
const WORKING = `
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args.includes('ebur128=peak=none')) {
  process.stderr.write('[Parsed_ebur128_0] Summary:\\n  Integrated loudness:\\n    I:         -16.3 LUFS\\n')
  process.exit(0)
}
writeFileSync(args.at(-1), Buffer.from('0000ftypisom-not-really-a-movie'))
process.stdout.write('out_time_us=250000\\nout_time_us=500000\\nout_time_us=1000000\\nprogress=end\\n')
`

describe('what a render request may say', () => {
  it('fills the defaults: 30 fps, 720p', () => {
    expect(normalizeRenderRequest({})).toEqual({ frameRate: 30, resolution: '720' })
    expect(normalizeRenderRequest({ frameRate: 24, resolution: '1080p', baseRevision: 3, fileName: ' final ' }))
      .toEqual({ frameRate: 24, resolution: '1080', baseRevision: 3, fileName: 'final' })
    expect(normalizeRenderRequest({ check: true })).toEqual({ frameRate: 30, resolution: '720', check: true })
    // Studio's name for the same thing.
    expect(normalizeRenderRequest({ dryRun: true }).check).toBe(true)
  })

  it('refuses a frame rate or resolution the renderer does not offer', () => {
    expect(() => normalizeRenderRequest({ frameRate: 25 })).toThrow(TimelineRenderError)
    expect(() => normalizeRenderRequest({ resolution: '4k' })).toThrowError(/resolution/)
    expect(normalizeRenderRequest({ resolution: '2160p' }).resolution).toBe('2160')
    expect(() => normalizeRenderRequest({ baseRevision: -1 })).toThrowError(/baseRevision/)
    expect(() => normalizeRenderRequest({ check: 'yes' })).toThrowError(/check/)
    expect(() => normalizeRenderRequest({ fileName: '  ' })).toThrowError(/fileName/)
  })

  it('sizes the short side to the resolution for every aspect, both sides even', () => {
    expect(renderSizeFor('16:9', '720')).toEqual({ width: 1280, height: 720 })
    expect(renderSizeFor('9:16', '720')).toEqual({ width: 720, height: 1280 })
    expect(renderSizeFor('1:1', '1080')).toEqual({ width: 1080, height: 1080 })
    expect(renderSizeFor('4:5', '1080')).toEqual({ width: 1080, height: 1350 })
    expect(renderSizeFor(undefined, '1080')).toEqual({ width: 1920, height: 1080 })
    expect(renderSizeFor('16:9', '1440')).toEqual({ width: 2560, height: 1440 })
    expect(renderSizeFor('9:16', '2160')).toEqual({ width: 2160, height: 3840 })
    // The cinema frames come from the editor's own base pairs, so the browser export and this render agree to the pixel.
    expect(renderSizeFor('21:9', '1080')).toEqual({ width: 2520, height: 1080 })
    expect(renderSizeFor('2.39:1', '1080')).toEqual({ width: 2580, height: 1080 })
    expect(renderSizeFor('2.39:1', '720')).toEqual({ width: 1720, height: 720 })
    expect(renderSizeFor('2.39:1', '2160')).toEqual({ width: 5160, height: 2160 })
  })

  it('names the file after the film, the revision and the moment, or after the caller, never after a path', () => {
    const now = new Date(2026, 8, 6, 14, 5, 9)
    expect(renderOutputPath({ boardId: 'film-1', revision: 7, now })).toBe('canvas/renders/film-1-r7-20260906-140509.mp4')
    expect(renderOutputPath({ boardId: '1f2e', revision: 7, title: '雨夜/来客', now })).toBe('canvas/renders/来客-r7-20260906-140509.mp4')
    expect(renderOutputPath({ boardId: 'b', revision: 1, fileName: '../../etc/成片 v2.mp4', now })).toBe('canvas/renders/成片 v2.mp4')
    expect(renderOutputPath({ boardId: 'b', revision: 1, fileName: 'C:\\\\x\\\\final', now })).toBe('canvas/renders/final.mp4')
    expect(renderOutputPath({ boardId: 'b', revision: 1, fileName: '...', title: '...', now })).toBe('canvas/renders/b-r1-20260906-140509.mp4')
  })
})

describe('where a clip plays from', () => {
  it('takes the integrity record first, then the version id, then the raw URL', () => {
    expect(segmentProjectPath(still())).toBe('canvas/media/still.png')
    expect(segmentProjectPath({ assetVersionId: 'canvas-file:canvas/media/a.mp4' })).toBe('canvas/media/a.mp4')
    expect(segmentProjectPath({ src: 'http://127.0.0.1:7456/api/projects/film-1/raw/canvas/uploads/%E6%9C%BA%E4%BD%8D2.mp4?x=1' })).toBe('canvas/uploads/机位2.mp4')
    expect(segmentProjectPath({ src: 'blob:http://localhost/abc' })).toBeNull()
  })

  it('keys every entry by the segment id and maps its path to the real file', async () => {
    const { media, extractedFiles, missing } = await collectRenderMedia(cut([still()]).project, projectDir)
    expect(missing).toEqual([])
    expect(media.visuals).toEqual([{ id: 'clip-1', path: 'canvas/media/still.png' }])
    expect(extractedFiles.get('canvas/media/still.png')).toBe(join(await realpath(projectDir), 'canvas', 'media', 'still.png'))
  })

  it('reports a clip whose file is not in the project, one that escapes it, and one that is no project file', async () => {
    // A link out of the project, where the system lets a test make one.
    const outside = join(scratch, 'outside.png')
    await writeFile(outside, PNG)
    const linked = await symlink(outside, join(projectDir, 'canvas', 'media', 'outside.png')).then(() => true, () => false)
    const { missing } = await collectRenderMedia(cut([
      still({ id: 'gone', integrity: { archivePath: 'canvas/media/gone.png' }, assetVersionId: undefined, assetId: 'asset-1', sourceUrl: undefined, src: undefined }),
      still({ id: 'escape', integrity: { archivePath: '../still.png' }, assetVersionId: undefined, assetId: 'asset-2', sourceUrl: undefined, src: undefined }),
      still({ id: 'blob', integrity: undefined, assetVersionId: undefined, assetId: 'asset-3', sourceUrl: undefined, src: 'blob:http://x/y' }),
      ...(linked ? [still({ id: 'link', integrity: { archivePath: 'canvas/media/outside.png' } })] : []),
    ]).project, projectDir)
    expect(missing.map(item => item.clipId)).toEqual(['gone', 'escape', 'blob', ...(linked ? ['link'] : [])])
  })

  it('lets a video clip\'s own sound in only when a probe finds a sound stream, and never for a muted clip', async () => {
    await writeFile(join(projectDir, 'canvas', 'media', 'take.mp4'), Buffer.from('ftyp'))
    const probed: string[] = []
    const heard = await collectRenderMedia(cut([take(), still()]).project, projectDir, { probeHasAudio: async (file) => { probed.push(basename(file)); return true } })
    expect(heard.media.sourceAudioSegments).toEqual([{ id: 'take-1', path: 'canvas/media/take.mp4' }])
    expect(probed).toEqual(['take.mp4'])
    expect((await collectRenderMedia(cut([take()]).project, projectDir, { probeHasAudio: async () => false })).media.sourceAudioSegments).toEqual([])
    expect((await collectRenderMedia(cut([take()]).project, projectDir, { probeHasAudio: async () => undefined })).media.sourceAudioSegments).toEqual([])
    expect((await collectRenderMedia(cut([take()]).project, projectDir)).media.sourceAudioSegments).toEqual([])
    for (const quiet of [take({ muted: true }), take({ sourceAudioDisabled: true })]) {
      expect((await collectRenderMedia(cut([quiet]).project, projectDir, { probeHasAudio: async () => true })).media.sourceAudioSegments).toEqual([])
    }
    expect((await collectRenderMedia(cut([take()], { trackVisibility: { source: false } }).project, projectDir, { probeHasAudio: async () => true })).media.sourceAudioSegments).toEqual([])
  })

  it('does not need a file for a clip on a muted lane, but does for music', async () => {
    const project = cut([still()], {
      audioSegments: [{ id: 'vo', start: 0, duration: 1, muted: true, integrity: { archivePath: 'canvas/media/missing.mp3' } }],
      musicSegments: [{ id: 'bgm', start: 0, duration: 1, integrity: { archivePath: 'canvas/media/missing.mp3' } }],
    }).project
    const { missing, media } = await collectRenderMedia(project, projectDir)
    expect(missing.map(item => item.clipId)).toEqual(['bgm'])
    expect(media.audioSegments).toEqual([])
  })
})

describe('planning the render', () => {
  it('refuses a film with no cut, and a cut with no picture', async () => {
    await expect(buildTimelinePlan({ document: null, projectDir, ...settings })).rejects.toMatchObject({ status: 422, code: 'EMPTY_TIMELINE' })
    await expect(buildTimelinePlan({ document: createEmptyTimelineArchive('16:9'), projectDir, ...settings })).rejects.toMatchObject({ code: 'EMPTY_TIMELINE' })
  })

  it('refuses a clip the Host cannot find, naming it', async () => {
    const document = cut([still({ id: 'ghost', integrity: { archivePath: 'canvas/media/ghost.png' }, assetVersionId: undefined, assetId: 'a', sourceUrl: undefined, src: undefined })])
    await expect(buildTimelinePlan({ document, projectDir, ...settings })).rejects.toMatchObject({
      status: 422,
      code: 'MISSING_MEDIA',
      message: expect.stringContaining('visuals/ghost (canvas/media/ghost.png)'),
      detail: { missing: [{ track: 'visuals', clipId: 'ghost', path: 'canvas/media/ghost.png' }] },
    })
  })

  it('passes the planner\'s own refusal through: an unsupported filter is not rendered wrong', async () => {
    await expect(buildTimelinePlan({ document: cut([still({ filterId: 'not-a-filter' })]), projectDir, ...settings })).rejects.toMatchObject({ status: 422, code: 'UNSUPPORTED_RENDER_FEATURE' })
  })

  it('builds the plan at the requested size and rate, with the project file as input', async () => {
    const { plan, width, height } = await buildTimelinePlan({ document: cut([still()]), projectDir, frameRate: 24, resolution: '1080' })
    expect([width, height]).toEqual([1920, 1080])
    expect(plan.frameRate).toBe(24)
    expect(plan.duration).toBe(1)
    expect(plan.args.slice(0, 2)).toEqual(['-hide_banner', '-y'])
    expect(plan.args).toContain(join(await realpath(projectDir), 'canvas', 'media', 'still.png'))
    expect(plan.args.slice(-2)).toEqual(['-movflags', '+faststart'])
    expect(plan.hasAudio).toBe(false)
  })

  it('writes captions as a sidecar with the default font, and asks for a downloaded one by id', async () => {
    const { plan } = await buildTimelinePlan({ document: cut([still()], { captionSegments: [{ id: 'c1', text: '你好', start: 0, end: 1 }] }), projectDir, ...settings })
    expect(plan.sidecars?.[0]).toMatchObject({ filename: 'captions.ass' })
    expect((plan.sidecars?.[0] as { content: string }).content).toContain('Dialogue:')

    const fancy = cut([still()], { captionSegments: [{ id: 'c1', text: '你好', start: 0, end: 1, fontId: 'noto-sans-sc' }] })
    expect(captionFontIdsOf(fancy.project)).toEqual(['noto-sans-sc'])
    await expect(buildTimelinePlan({ document: fancy, projectDir, ...settings, resolveCaptionFont: async () => null }))
      .rejects.toMatchObject({ code: 'MISSING_RENDER_RESOURCE', message: expect.stringContaining('还没下载') })
    const font = join(projectDir, 'font.ttf')
    await writeFile(font, 'not really a font')
    const asked: string[] = []
    const withFont = await buildTimelinePlan({ document: fancy, projectDir, ...settings, resolveCaptionFont: async (id) => { asked.push(id); return font } })
    expect(asked).toEqual(['noto-sans-sc'])
    expect(withFont.captionFonts).toEqual(['noto-sans-sc'])
    expect(withFont.plan.sidecars?.map(item => item.filename)).toEqual(['captions.ass', 'caption-font-noto-sans-sc.ttf'])
  })

  it('gives a long or graded cut more time than Studio\'s fixed 30 minutes', () => {
    const at720p30 = { width: 1280, height: 720, frameRate: 30 }
    expect(renderTimeLimitMs({ args: ['-filter_complex', 'scale=1:1'], duration: 10, ...at720p30 })).toBe(30 * 60_000)
    expect(renderTimeLimitMs({ args: ['-filter_complex', 'format=gbrp,geq=r=1'], duration: 180, ...at720p30 })).toBe(180 * 40_000)
    expect(renderTimeLimitMs({ args: [], duration: 100_000, ...at720p30 })).toBe(6 * 60 * 60_000)
  })

  it('grows the time limits with the frame size and rate, not the length alone', () => {
    const graded = ['-filter_complex', 'format=gbrp,geq=r=1']
    // A one-minute graded cut: 40 minutes at 720p30, nine times the pixels and twice the frames at 4K60.
    expect(renderTimeLimitMs({ args: graded, duration: 60, width: 1280, height: 720, frameRate: 30 })).toBe(60 * 40_000)
    expect(renderTimeLimitMs({ args: graded, duration: 20, width: 3840, height: 2160, frameRate: 60 })).toBe(20 * 40_000 * 18)
    expect(renderTimeLimitMs({ args: [], duration: 600, width: 1920, height: 1080, frameRate: 60 })).toBe(Math.round(600 * 6_000 * 4.5))
    expect(renderTimeLimitMs({ args: graded, duration: 600, width: 3840, height: 2160, frameRate: 60 })).toBe(6 * 60 * 60_000)
    // Before the first packet the encoder fills its lookahead: minutes for a large graded frame, the stall timeout otherwise.
    expect(renderFirstOutputMs({ args: [], duration: 60, width: 1280, height: 720, frameRate: 30 })).toBe(RENDER_STALL_TIMEOUT_MS)
    expect(renderFirstOutputMs({ args: graded, duration: 60, width: 1920, height: 1080, frameRate: 30 })).toBe(180_000)
    expect(renderFirstOutputMs({ args: graded, duration: 60, width: 3840, height: 2160, frameRate: 60 })).toBe(720_000)
  })
})

describe('running the plan (a script stands in for ffmpeg)', () => {
  it('renders into canvas/renders through a hidden partial, with progress, loudness and digest', async () => {
    const ffmpeg = await fakeFfmpeg(WORKING)
    const progress: number[] = []
    const output = await renderTimeline({
      document: cut([still()]), projectDir, ...settings, outputPath: 'canvas/renders/test.mp4', ffmpegBinary: 'ffmpeg', runner: ffmpeg.runner,
      onProgress: ({ percent }) => { progress.push(percent) },
    })
    expect(output).toMatchObject({ path: 'canvas/renders/test.mp4', width: 1280, height: 720, frameRate: 30, durationSeconds: 1, hasAudio: false, targetLoudnessLufs: -14 })
    expect(output.loudnessLufs).toBeUndefined()
    expect(progress).toEqual([25, 50, 99])
    const bytes = await readFile(join(projectDir, 'canvas', 'renders', 'test.mp4'))
    expect(output.size).toBe(bytes.length)
    expect(output.sha256).toMatch(/^[0-9a-f]{64}$/)
    // ffmpeg wrote the hidden partial, with progress on stdout; nothing of it is left.
    const argv = ffmpeg.calls[0]!
    expect(argv.slice(0, 5)).toEqual(['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'])
    expect(basename(argv.at(-1)!)).toBe('.test.partial.mp4')
    expect(await readdir(join(projectDir, 'canvas', 'renders'))).toEqual(['test.mp4'])
    // A silent cut is not metered.
    expect(ffmpeg.calls).toHaveLength(1)
  })

  it('meters a cut with sound and reads the loudness back', async () => {
    await writeFile(join(projectDir, 'canvas', 'media', 'take.mp4'), Buffer.from('ftyp'))
    const ffmpeg = await fakeFfmpeg(WORKING)
    const output = await renderTimeline({
      document: cut([take()], { targetLoudnessLufs: -16 }), projectDir, ...settings, outputPath: 'canvas/renders/heard.mp4', ffmpegBinary: 'ffmpeg', runner: ffmpeg.runner,
      probeHasAudio: async () => true,
    })
    expect(output).toMatchObject({ hasAudio: true, loudnessLufs: -16.3, targetLoudnessLufs: -16 })
    expect(ffmpeg.calls[1]).toContain('ebur128=peak=none')
  })

  it('reports a failed ffmpeg with its last words and leaves no file behind, not even the partial', async () => {
    const ffmpeg = await fakeFfmpeg(`
import { writeFileSync } from 'node:fs'
writeFileSync(process.argv.at(-1), 'partial')
process.stderr.write('Conversion failed!\\n')
process.exit(3)
`)
    await expect(renderTimeline({ document: cut([still()]), projectDir, ...settings, outputPath: 'canvas/renders/bad.mp4', ffmpegBinary: 'ffmpeg', runner: ffmpeg.runner }))
      .rejects.toMatchObject({ code: 'FFMPEG_FAILED', message: expect.stringContaining('退出码 3）: Conversion failed!'), details: { retryable: true } })
    expect(await readdir(join(projectDir, 'canvas', 'renders'))).toEqual([])
  })

  it('stops an ffmpeg that produces no frames — a corrupt still under -loop 1 never ends on its own', async () => {
    const ffmpeg = await fakeFfmpeg(`
process.stdout.write('out_time_us=0\\n')
process.stderr.write('Invalid PNG signature\\n')
setInterval(() => {}, 1000)
`)
    const started = Date.now()
    await expect(renderTimeline({ document: cut([still()]), projectDir, ...settings, outputPath: 'canvas/renders/stuck.mp4', ffmpegBinary: 'ffmpeg', runner: ffmpeg.runner, stallTimeoutMs: 300 }))
      .rejects.toMatchObject({ code: 'FFMPEG_STALLED', message: expect.stringContaining('0.3s'), details: { retryable: false } })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await readdir(join(projectDir, 'canvas', 'renders'))).toEqual([])
  })

  it('stops ffmpeg when cancelled, and says so', async () => {
    const ffmpeg = await fakeFfmpeg(`
let us = 0
setInterval(() => { us += 100000; process.stdout.write('out_time_us=' + us + '\\n') }, 20)
`)
    const controller = new AbortController()
    const running = renderTimeline({
      document: cut([still()]), projectDir, ...settings, outputPath: 'canvas/renders/stop.mp4', ffmpegBinary: 'ffmpeg', runner: ffmpeg.runner, signal: controller.signal,
      onProgress: () => { controller.abort() },
    })
    await expect(running).rejects.toMatchObject({ status: 499, code: 'RENDER_CANCELED' })
    expect(await readdir(join(projectDir, 'canvas', 'renders'))).toEqual([])
    const before = new AbortController()
    before.abort()
    await expect(renderTimeline({ document: cut([still()]), projectDir, ...settings, outputPath: 'canvas/renders/never.mp4', ffmpegBinary: 'ffmpeg', runner: ffmpeg.runner, signal: before.signal }))
      .rejects.toMatchObject({ code: 'RENDER_CANCELED' })
  })

  it('uses a plan it is handed rather than planning again', async () => {
    const ffmpeg = await fakeFfmpeg(WORKING)
    const planned = await buildTimelinePlan({ document: cut([still()]), projectDir, ...settings })
    // The document is gone: only the handed plan can render.
    const output = await renderTimeline({ document: null, planned, projectDir, ...settings, outputPath: 'canvas/renders/once.mp4', ffmpegBinary: 'ffmpeg', runner: ffmpeg.runner })
    expect(output.path).toBe('canvas/renders/once.mp4')
  })

  it('never replaces a file that took the reserved name while it rendered: it keeps the next free name and says so', async () => {
    // Someone saves canvas/renders/taken.mp4 while ffmpeg is still writing the partial.
    const ffmpeg = await fakeFfmpeg(`
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const partial = process.argv.at(-1)
writeFileSync(join(dirname(partial), 'taken.mp4'), 'somebody else')
writeFileSync(partial, Buffer.from('0000ftypisom-render'))
process.stdout.write('out_time_us=1000000\\n')
`)
    const output = await renderTimeline({ document: cut([still()]), projectDir, ...settings, outputPath: 'canvas/renders/taken.mp4', ffmpegBinary: 'ffmpeg', runner: ffmpeg.runner })
    expect(output.path).toBe('canvas/renders/taken-2.mp4')
    expect(output.absolutePath).toBe(join(projectDir, 'canvas', 'renders', 'taken-2.mp4'))
    expect(await readFile(join(projectDir, 'canvas', 'renders', 'taken.mp4'), 'utf8')).toBe('somebody else')
    expect(await readFile(output.absolutePath, 'utf8')).toBe('0000ftypisom-render')
    expect((await readdir(join(projectDir, 'canvas', 'renders'))).sort()).toEqual(['taken-2.mp4', 'taken.mp4'])
  })

  it('keeps a render under a free name on a file system without hard links too', async () => {
    const folder = join(projectDir, 'canvas', 'renders')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'cut.mp4'), 'first')
    const partial = join(folder, '.cut.partial.mp4')
    await writeFile(partial, 'rendered')
    const nolink = async (): Promise<void> => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }) }
    const kept = await keepRender(partial, join(folder, 'cut.mp4'), { link: nolink })
    expect(kept).toBe(join(folder, 'cut-2.mp4'))
    expect(await readFile(join(folder, 'cut.mp4'), 'utf8')).toBe('first')
    expect(await readFile(kept, 'utf8')).toBe('rendered')
    expect((await readdir(folder)).sort()).toEqual(['cut-2.mp4', 'cut.mp4'])
  })

  it('gives ffmpeg the encoder\'s lookahead before the first frame, and says which clock stopped it', async () => {
    const runs: Array<Parameters<FfmpegRunner>[0]> = []
    const silent = await fakeFfmpeg(`setInterval(() => {}, 1000)`)
    const runner: FfmpegRunner = (run) => { runs.push(run); return silent.runner(run) }
    await expect(renderTimeline({ document: cut([still()]), projectDir, ...settings, outputPath: 'canvas/renders/slow.mp4', ffmpegBinary: 'ffmpeg', runner, stallTimeoutMs: 100, firstOutputTimeoutMs: 400 }))
      .rejects.toMatchObject({ code: 'FFMPEG_STALLED', message: expect.stringContaining('0.4s 仍没有产出第一帧') })
    expect(runs[0]).toMatchObject({ stallTimeoutMs: 100, firstOutputTimeoutMs: 400 })
    // Without an override the allowance comes from the plan: at least the stall timeout.
    const quick = await fakeFfmpeg(WORKING)
    const planned: Array<Parameters<FfmpegRunner>[0]> = []
    await renderTimeline({ document: cut([still()]), projectDir, ...settings, outputPath: 'canvas/renders/quick.mp4', ffmpegBinary: 'ffmpeg', runner: (run) => { planned.push(run); return quick.runner(run) } })
    expect(planned[0]).toMatchObject({ stallTimeoutMs: RENDER_STALL_TIMEOUT_MS, firstOutputTimeoutMs: RENDER_STALL_TIMEOUT_MS })
  })

  it('finds the partials a stopped render left, and only those', async () => {
    const folder = join(projectDir, 'canvas', 'renders')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, '.old.partial.mp4'), 'x')
    await writeFile(join(folder, 'kept.mp4'), 'x')
    expect(basename(partialPathFor(join(folder, 'kept.mp4')))).toBe('.kept.partial.mp4')
    await removeStalePartials(folder)
    expect(await readdir(folder)).toEqual(['kept.mp4'])
  })
})

const real = resolveFfmpeg()
const hasXfade = real !== undefined ? (await ffmpegFilterNames(real.binary)).has('xfade') : false

describe.skipIf(real === undefined)('rendering with this machine\'s ffmpeg', () => {
  const ffmpeg = real?.binary ?? 'ffmpeg'

  it('turns a one-second still into a 720p MP4 in canvas/renders', async () => {
    const output = await renderTimeline({ document: cut([still()]), projectDir, ...settings, outputPath: 'canvas/renders/test.mp4', ffmpegBinary: ffmpeg })
    expect([output.width, output.height, output.frameRate]).toEqual([1280, 720, 30])
    expect(output.durationSeconds).toBeGreaterThan(0.9)
    expect(output.durationSeconds).toBeLessThan(1.2)
    expect(output.hasAudio).toBe(false)
    const file = join(projectDir, 'canvas', 'renders', 'test.mp4')
    expect((await stat(file)).size).toBe(output.size)
    expect((await readFile(file)).subarray(4, 8).toString('latin1')).toBe('ftyp')
    expect(await probeMedia(file)).toMatchObject({ width: 1280, height: 720, hasAudio: false })
  }, 60_000)

  it.skipIf(!hasXfade)('joins two clips with a fade transition', async () => {
    const output = await renderTimeline({
      document: cut([still({ id: 'one', transition: { id: 'fade', duration: 0.5 } }), still({ id: 'two' })]),
      projectDir, ...settings, outputPath: 'canvas/renders/fade.mp4', ffmpegBinary: ffmpeg,
    })
    expect(output.durationSeconds).toBeGreaterThan(1.8)
    expect(output.durationSeconds).toBeLessThan(2.2)
  }, 60_000)

  it('keeps a clip\'s own sound, normalises the mix to the target and reads the loudness back off the file', async () => {
    const file = join(projectDir, 'canvas', 'media', 'take.mp4')
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { windowsHide: true })
    const probeHasAudio = async (path: string): Promise<boolean | undefined> => (await probeMedia(path)).hasAudio
    const heard = await renderTimeline({ document: cut([take()], { targetLoudnessLufs: -18 }), projectDir, ...settings, outputPath: 'canvas/renders/heard.mp4', ffmpegBinary: ffmpeg, probeHasAudio })
    expect(heard.hasAudio).toBe(true)
    expect(heard.targetLoudnessLufs).toBe(-18)
    expect(Math.abs(heard.loudnessLufs! - (-18))).toBeLessThan(4)
    expect((await probeMedia(heard.absolutePath)).hasAudio).toBe(true)
    const muted = await renderTimeline({ document: cut([take({ muted: true })]), projectDir, ...settings, outputPath: 'canvas/renders/muted.mp4', ffmpegBinary: ffmpeg, probeHasAudio })
    expect(muted.hasAudio).toBe(false)
    expect(muted.loudnessLufs).toBeUndefined()
  }, 120_000)
})
