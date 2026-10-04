/** Lossless cut, join and sound copy in the Host (media/edit.ts), and the film tasks that run them (C10). */

import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from 'mediabunny'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MediaEditError, audioConfigKey, cutFile, extractAudio, joinFiles, joinProblems, probeDetailed } from '../src/media/edit.js'
import type { EditProbe } from '../src/media/edit.js'
import { FilmMediaTasks, LOCAL_TASK_LIMIT } from '../src/media/tasks.js'
import type { FilmTaskFile, FilmTaskSnapshot } from '../src/media/tasks.js'
import { writeFixture } from './media-edit-fixtures.js'

let cwd: string
let media: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-edit-'))
  media = join(cwd, 'film', 'canvas', 'media')
  await mkdir(media, { recursive: true })
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

/** The picture packets' presentation times, in decode order, and the first one's type. */
async function pictureTimes(path: string): Promise<{ times: number[]; firstType: string | undefined }> {
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (track === null) return { times: [], firstType: undefined }
    const sink = new EncodedPacketSink(track)
    const times: number[] = []
    let firstType: string | undefined
    for await (const packet of sink.packets()) {
      firstType ??= packet.type
      times.push(Math.round(packet.timestamp * 1000))
    }
    return { times, firstType }
  } finally {
    input.dispose()
  }
}

/** The sound packets' start times and lengths, in seconds. */
async function soundPackets(path: string): Promise<Array<{ time: number; duration: number }>> {
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (track === null) return []
    const packets: Array<{ time: number; duration: number }> = []
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) packets.push({ time: packet.timestamp, duration: packet.duration })
    return packets
  } finally {
    input.dispose()
  }
}

/** One AAC frame at 48 kHz, in seconds. */
const AAC_FRAME = 1024 / 48000

describe('probeDetailed', () => {
  it('reads length, size, codecs, decoder configuration hashes and key frames', async () => {
    const path = await writeFixture(join(media, 'a.mp4'), { frames: 75, gop: 25 })
    const probe = await probeDetailed(path)
    expect(probe).toMatchObject({
      ok: true, width: 64, height: 64, hasAudio: true,
      video: { codec: 'avc', codedWidth: 64, codedHeight: 64, frameRate: 25 },
      audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
      keyframesMs: [0, 1000, 2000],
    })
    expect(probe.durationMs).toBeGreaterThanOrEqual(3000)
    expect(probe.durationMs).toBeLessThan(3050)
    expect(probe.video?.configHash).toMatch(/^[0-9a-f]{40}$/)
    const other = await probeDetailed(await writeFixture(join(media, 'b.mp4'), { otherConfig: true }))
    expect(other.video?.configHash).not.toBe(probe.video?.configHash)
    expect(other.audio?.configHash).toBe(probe.audio?.configHash)
  })

  it('treats AAC configurations that decode the same as one (the explicit "no SBR" extension), and SBR as another', () => {
    const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
    // 44.1 kHz stereo AAC-LC as two encoders write it (a Seedance clip carries the extension).
    expect(audioConfigKey('aac', bytes('121056e500'), 'x')).toBe(audioConfigKey('aac', bytes('1210'), 'x'))
    expect(audioConfigKey('aac', bytes('121056e580'), 'x')).not.toBe(audioConfigKey('aac', bytes('1210'), 'x'))
    expect(audioConfigKey('aac', bytes('1190'), 'x')).not.toBe(audioConfigKey('aac', bytes('1210'), 'x'))
    expect(audioConfigKey('opus', bytes('1210'), 'x')).not.toBe(audioConfigKey('opus', bytes('121056e500'), 'x'))
  })

  it('gives no facts for a file that is not media', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(media, 'broken.mp4'), 'not a video')
    expect(await probeDetailed(join(media, 'broken.mp4'))).toEqual({ ok: false })
  })
})

describe('cutFile', () => {
  it('copies the range from the key frame before it, with an edit list, and lasts less than one GOP longer', async () => {
    const source = await writeFixture(join(media, 'src.mp4'), { frames: 75, gop: 25 })
    const result = await cutFile(source, join(media, 'clip-1.mp4'), { inMs: 1500, outMs: 2500 }, 'expand')
    expect(result.path).toBe(join(media, 'clip-1.mp4'))
    expect(result.durationMs).toBeGreaterThanOrEqual(1000)
    expect(result.durationMs).toBeLessThan(1000 + 1000)
    expect(result.hasAudio).toBe(true)
    const { times, firstType } = await pictureTimes(result.path)
    // The copy starts at the key frame at 1 s, half a second before the in point: it plays from -500 ms on.
    expect(firstType).toBe('key')
    expect(times[0]).toBe(-500)
    expect(times.filter(time => time >= 0)).toHaveLength(25)
    expect(await readdir(media)).toEqual(['clip-1.mp4', 'src.mp4'])
    // It holds the source from the in point to the end of the picture showing at the out point (2480–2520 ms).
    expect(result.range).toEqual({ inMs: 1500, outMs: 2520 })
    // The pre-roll is no key frame a range can start on.
    expect((await probeDetailed(result.path)).keyframesMs).toEqual([500])
  })

  it('with the shrink boundary starts picture and sound together at the next key frame, with no pre-roll', async () => {
    const source = await writeFixture(join(media, 'src.mp4'), { frames: 75, gop: 25 })
    const result = await cutFile(source, join(media, 'clip-1.mp4'), { inMs: 600, outMs: 2500 }, 'shrink')
    const { times, firstType } = await pictureTimes(result.path)
    expect(firstType).toBe('key')
    // From the key frame at 1 s to 2.5 s, shown from 0 on: nothing for an edit list to hide.
    expect(times).toHaveLength(38)
    expect(times[0]).toBe(0)
    // The sound starts at 0 too; before it only the two AAC frames a decoder primes with (under the sound's own edit list).
    const sound = await soundPackets(result.path)
    expect(sound[0]!.time).toBeGreaterThanOrEqual(-2 * AAC_FRAME - 0.005)
    expect(sound.some(packet => packet.time <= 1e-9 && packet.time + packet.duration > 0)).toBe(true)
    expect(result.durationMs).toBeLessThanOrEqual(1500 + 25)
    expect(result.range).toEqual({ inMs: 1000, outMs: 2520 })
  })

  it('with the shrink boundary refuses a range with no key frame in it', async () => {
    const source = await writeFixture(join(media, 'src.mp4'), { frames: 75, gop: 25 })
    const refused = await cutFile(source, join(media, 'clip-1.mp4'), { inMs: 1100, outMs: 1900 }, 'shrink').catch((error: unknown) => error)
    expect(refused).toMatchObject({ status: 422, code: 'MEDIA_EDIT_NEEDS_TRANSCODE', extra: { reasons: [{ index: 0, reason: 'not-keyframe' }] } })
    expect(await readdir(media)).toEqual(['src.mp4'])
  })

  it('keeps the name of an existing file and takes the next free one', async () => {
    const source = await writeFixture(join(media, 'src.mp4'))
    await writeFixture(join(media, 'clip-1.mp4'), { frames: 5 })
    const result = await cutFile(source, join(media, 'clip-1.mp4'), { inMs: 0, outMs: 1000 }, 'expand')
    expect(result.path).toBe(join(media, 'clip-1-2.mp4'))
  })

  it('cuts an audio file into its own container', async () => {
    const source = await writeFixture(join(media, 'voice.m4a'), { frames: 0, audioSeconds: 3 })
    const result = await cutFile(source, join(media, 'clip-1.m4a'), { inMs: 1000, outMs: 2000 }, 'expand')
    const probe = await probeDetailed(result.path)
    expect(probe).toMatchObject({ ok: true, hasAudio: true, audio: { codec: 'aac' } })
    expect(probe.video).toBeUndefined()
    expect(probe.durationMs).toBeGreaterThanOrEqual(1000)
    expect(probe.durationMs).toBeLessThan(1100)
  })

  it('deletes the partial file when it is cancelled', async () => {
    const source = await writeFixture(join(media, 'src.mp4'), { frames: 750, gop: 25 })
    const controller = new AbortController()
    const cut = cutFile(source, join(media, 'clip-1.mp4'), { inMs: 0, outMs: 29_000 }, 'expand', {
      signal: controller.signal,
      onProgress: (fraction) => { if (fraction > 0) controller.abort(new Error('cancelled')) },
    })
    await expect(cut).rejects.toThrow('cancelled')
    expect(await readdir(media)).toEqual(['src.mp4'])
  })
})

describe('extractAudio', () => {
  it('copies a video\'s sound into an MP4 audio file', async () => {
    const source = await writeFixture(join(media, 'src.mp4'), { frames: 50 })
    const result = await extractAudio(source, join(media, 'extract-1.m4a'), undefined)
    const probe = await probeDetailed(result.path)
    expect(probe).toMatchObject({ ok: true, hasAudio: true, audio: { codec: 'aac', sampleRate: 48000, channels: 2 } })
    expect(probe.video).toBeUndefined()
    expect(probe.durationMs).toBeGreaterThanOrEqual(2000)
    expect(probe.durationMs).toBeLessThan(2050)
    const part = await extractAudio(source, join(media, 'extract-2.m4a'), { inMs: 500, outMs: 1500 })
    expect(part.durationMs).toBeGreaterThanOrEqual(1000)
    expect(part.durationMs).toBeLessThan(1100)
  })

  it('refuses a video without sound', async () => {
    const source = await writeFixture(join(media, 'silent.mp4'), { audio: false })
    const refused = await extractAudio(source, join(media, 'extract-1.m4a'), undefined).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(MediaEditError)
    expect(refused).toMatchObject({ status: 422, code: 'VIDEO_NO_AUDIO_TRACK' })
    expect(await readdir(media)).toEqual(['silent.mp4'])
  })
})

describe('joinFiles', () => {
  const clip = async (name: string, options: Parameters<typeof writeFixture>[1] = {}) => {
    const path = await writeFixture(join(media, name), options)
    return { path, probe: await probeDetailed(path) }
  }

  it('joins compatible clips end to end: the lengths add up and every clip starts on its key frame', async () => {
    const a = await clip('a.mp4', { frames: 50 })
    const b = await clip('b.mp4', { frames: 75 })
    const clips = [{ path: a.path, inMs: 0, outMs: 2000 }, { path: b.path, inMs: 1000, outMs: 3000 }]
    expect(await joinProblems(clips.map((entry, index) => ({ ...entry, probe: [a, b][index]!.probe })))).toEqual([])
    const result = await joinFiles(clips, join(media, 'join-1.mp4'))
    expect(result.durationMs).toBeGreaterThanOrEqual(4000)
    expect(result.durationMs).toBeLessThan(4050)
    expect(result.hasAudio).toBe(true)
    const { times } = await pictureTimes(result.path)
    expect(times).toHaveLength(100)
    expect(times.slice(48, 52)).toEqual([1920, 1960, 2000, 2040])
    const joined = await probeDetailed(result.path)
    expect(joined.keyframesMs).toEqual([0, 1000, 2000, 3000])
    expect(joined.video?.configHash).toBe(a.probe.video?.configHash)
    expect(result.placements).toEqual([{ inMs: 0, outMs: 2000, atMs: 0 }, { inMs: 1000, outMs: 3000, atMs: 2000 }])
  })

  it('starts a first clip between key frames with its pre-roll hidden, and the next clip right after its in-range part', async () => {
    const a = await clip('a.mp4', { frames: 75 })
    const b = await clip('b.mp4', { frames: 75 })
    const clips = [{ path: a.path, inMs: 500, outMs: 2000 }, { path: b.path, inMs: 1000, outMs: 2000 }]
    expect(await joinProblems(clips.map((entry, index) => ({ ...entry, probe: [a, b][index]!.probe })))).toEqual([])
    const result = await joinFiles(clips, join(media, 'join-1.mp4'))
    const { times, firstType } = await pictureTimes(result.path)
    expect(firstType).toBe('key')
    // A's pictures from its key frame at 0 (shown before 0, under the edit list), then B's from 1500 ms.
    expect(times.slice(0, 2)).toEqual([-500, -460])
    expect(times).toHaveLength(75)
    expect(times.slice(49, 51)).toEqual([1460, 1500])
    expect(result.placements).toEqual([{ inMs: 500, outMs: 2000, atMs: 0 }, { inMs: 1000, outMs: 2000, atMs: 1500 }])
    expect(result.durationMs).toBeGreaterThanOrEqual(2500)
    expect(result.durationMs).toBeLessThan(2500 + 25)
    expect((await probeDetailed(result.path)).keyframesMs).toEqual([500, 1500])
  })

  it('refuses a cut\'s result as a later clip: its first picture hangs on a key frame of the hidden pre-roll', async () => {
    const a = await clip('a.mp4', { frames: 75 })
    const b = await clip('b.mp4', { frames: 75 })
    const cut = await cutFile(a.path, join(media, 'cut.mp4'), { inMs: 1500, outMs: 2500 }, 'expand')
    const cutProbe = await probeDetailed(cut.path)
    const clips = [{ path: b.path, inMs: 0, outMs: 1000 }, { path: cut.path, inMs: 0, outMs: cutProbe.durationMs! }]
    const reasons = await joinProblems([{ ...clips[0]!, probe: b.probe }, { ...clips[1]!, probe: cutProbe }])
    expect(reasons).toEqual([{ index: 1, reason: 'not-keyframe', detail: expect.stringContaining('下一个关键帧在 500 ms') }])
    // joinFiles refuses it too rather than showing the pre-roll mid-film.
    await expect(joinFiles(clips, join(media, 'join-1.mp4'))).rejects.toMatchObject({ code: 'VIDEO_JOIN_NEEDS_TRANSCODE', extra: { reasons: [{ index: 1, reason: 'not-keyframe' }] } })
    // As the first clip it joins, the pre-roll hidden by the edit list.
    const first = await joinFiles([clips[1]!, clips[0]!], join(media, 'join-2.mp4'))
    expect(first.placements?.[1]?.atMs).toBe(cut.range!.outMs - cut.range!.inMs)
  })

  it('writes the sound back to back across the cuts, never more than half a frame off the picture', async () => {
    const clips = []
    for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) clips.push({ path: (await clip(name, { frames: 50 })).path, inMs: 0, outMs: 2000 })
    const result = await joinFiles(clips, join(media, 'join-1.mp4'))
    const sound = await soundPackets(result.path)
    // Every packet is one AAC frame and starts where the one before ended: no gap a player could drop.
    expect(sound.every(packet => Math.abs(packet.duration - AAC_FRAME) < 1e-6)).toBe(true)
    expect(sound.slice(1).every((packet, index) => Math.abs(packet.time - (sound[index]!.time + sound[index]!.duration)) < 1e-6)).toBe(true)
    // Where each clip's sound starts in the result, against its picture.
    for (const placed of result.placements!.slice(1)) {
      const at = placed.atMs / 1000
      const first = sound.find(packet => packet.time >= at - AAC_FRAME / 2)!
      expect(Math.abs(first.time - at)).toBeLessThanOrEqual(AAC_FRAME / 2 + 1e-6)
    }
    const end = sound.at(-1)!.time + sound.at(-1)!.duration
    expect(Math.abs(end - 6)).toBeLessThanOrEqual(AAC_FRAME)
  })

  it('refuses a clip whose sound ends more than a frame before its picture, unless it is the last', async () => {
    const a = await clip('a.mp4', { frames: 50, audioSeconds: 1.9 })
    const b = await clip('b.mp4', { frames: 50 })
    const entries = (first: typeof a, second: typeof a) => [{ path: first.path, probe: first.probe, inMs: 0, outMs: 2000 }, { path: second.path, probe: second.probe, inMs: 0, outMs: 2000 }]
    const reasons = await joinProblems(entries(a, b))
    expect(reasons).toEqual([{ index: 0, reason: 'missing-audio', detail: expect.stringContaining('早') }])
    await expect(joinFiles(entries(a, b), join(media, 'join-1.mp4'))).rejects.toMatchObject({ code: 'VIDEO_JOIN_NEEDS_TRANSCODE', extra: { reasons: [{ index: 0, reason: 'missing-audio' }] } })
    expect(await joinProblems(entries(b, a))).toEqual([])
    expect((await readdir(media)).sort()).toEqual(['a.mp4', 'b.mp4'])
  })

  it('keeps a B-frame\'s reference past the out point and starts the next clip after it, so no two pictures share a time', async () => {
    const a = await clip('a.mp4', { frames: 50, bframes: true })
    const b = await clip('b.mp4', { frames: 50, bframes: true })
    // Out at 940 ms: the B-frame showing at 920 ms is decoded after the P-frame showing at 960 ms, which it refers to.
    const result = await joinFiles([{ path: a.path, inMs: 0, outMs: 940 }, { path: b.path, inMs: 1000, outMs: 2000 }], join(media, 'join-1.mp4'))
    const { times } = await pictureTimes(result.path)
    expect(times.slice(23, 25)).toEqual([960, 920])
    expect(times).toHaveLength(50)
    const shown = [...times].sort((x, y) => x - y)
    expect(new Set(shown).size).toBe(shown.length)
    expect(shown[0]).toBe(0)
    // Every gap between pictures is one frame: nothing missing, nothing doubled.
    expect(shown.slice(1).every((time, index) => time - shown[index]! === 40)).toBe(true)
    // The placements say so: A runs to 1000 ms, not the 940 asked for, and B starts there.
    expect(result.placements).toEqual([{ inMs: 0, outMs: 1000, atMs: 0 }, { inMs: 1000, outMs: 2000, atMs: 1000 }])
  })

  it('names every clip that cannot be copied into one track, and why', async () => {
    const first = await clip('first.mp4', { frames: 75 })
    const wide = await clip('wide.mp4', { width: 96 })
    const other = await clip('other.mp4', { otherConfig: true })
    const silent = await clip('silent.mp4', { audio: false })
    const cd = await clip('cd.mp4', { audio: { sampleRate: 44100 } })
    const sameButLate = await clip('late.mp4', { frames: 75 })
    const entries = [first, wide, other, silent, cd, sameButLate].map((entry, index) => ({
      path: entry.path, probe: entry.probe, inMs: index === 5 ? 1500 : 0, outMs: entry.probe.durationMs! - 100,
    }))
    const reasons = await joinProblems(entries)
    expect(reasons.map(reason => [reason.index, reason.reason])).toEqual([
      [1, 'resolution'], [2, 'decoder-config'], [3, 'missing-audio'], [4, 'audio-format'], [5, 'not-keyframe'],
    ])
    expect(reasons.find(reason => reason.reason === 'not-keyframe')?.detail).toContain('1000 ms')
    expect(reasons.every(reason => reason.detail !== '')).toBe(true)
  })

  it('names a clip with no picture as a codec problem', async () => {
    const first = await clip('first.mp4')
    const sound: EditProbe = { ok: true, hasAudio: true, durationMs: 2000, audio: first.probe.audio! }
    expect(await joinProblems([{ path: first.path, probe: first.probe, inMs: 0, outMs: 2000 }, { path: first.path, probe: sound, inMs: 0, outMs: 2000 }]))
      .toEqual([{ index: 1, reason: 'codec', detail: expect.any(String) }])
  })

  it('deletes the partial file when it is cancelled', async () => {
    const a = await clip('a.mp4', { frames: 250 })
    const b = await clip('b.mp4', { frames: 250 })
    const controller = new AbortController()
    const joining = joinFiles([{ path: a.path, inMs: 0, outMs: 10_000 }, { path: b.path, inMs: 0, outMs: 10_000 }], join(media, 'join-1.mp4'), {
      signal: controller.signal,
      onProgress: (fraction) => { if (fraction > 0.2) controller.abort(new Error('cancelled')) },
    })
    await expect(joining).rejects.toThrow('cancelled')
    expect((await readdir(media)).sort()).toEqual(['a.mp4', 'b.mp4'])
  })
})

describe('FilmMediaTasks.startLocal', () => {
  const file: FilmTaskFile = { name: 'canvas/media/clip-1.mp4', size: 10, kind: 'video', mime: 'video/mp4' }
  const request = (requestId: string) => ({ capability: 'video.cut' as const, requestId, parameters: { inMs: 0, outMs: 1000 }, surface: 'video' as const })

  async function settle(tasks: FilmMediaTasks, taskId: string): Promise<FilmTaskSnapshot & { lines: string[] }> {
    const lines: string[] = []
    let since = 0
    for (;;) {
      const snapshot = await tasks.wait(cwd, taskId, since, 2000)
      lines.push(...snapshot.progress)
      since = snapshot.nextSince
      if (['done', 'failed', 'interrupted'].includes(snapshot.status)) return { ...snapshot, lines }
    }
  }

  it('runs the edit as a film task with its progress lines and answers a repeated request id with the same task', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    let runs = 0
    const started = await tasks.startLocal(cwd, 'film', request('11111111-aaaa'), async (_signal, progress) => {
      runs++
      progress('写入 50%')
      return file
    })
    expect(started).toMatchObject({ status: 'running', existing: false })
    const done = await settle(tasks, started.taskId)
    expect(done).toMatchObject({ status: 'done', file, error: null })
    expect(done.lines).toEqual(['已提交', '读取片段', '写入 50%', '完成'])
    expect(await tasks.startLocal(cwd, 'film', request('11111111-aaaa'), async () => file)).toEqual({ taskId: started.taskId, status: 'done', existing: true })
    expect(runs).toBe(1)
    // Another Host instance (after a restart) finds it on disk.
    await tasks.settled()
    const later = new FilmMediaTasks(() => undefined)
    expect(await later.findLocal(cwd, '11111111-aaaa', 'video.cut')).toEqual({ taskId: started.taskId, status: 'done' })
    await expect(later.findLocal(cwd, '11111111-aaaa', 'video.join')).rejects.toMatchObject({ status: 409, code: 'MEDIA_EDIT_REQUEST_CONFLICT' })
    expect(await tasks.record(cwd, started.taskId)).toMatchObject({ kind: 'local', model: 'host-copy', request: { capability: 'video.cut', requestId: '11111111-aaaa' } })
    await tasks.settled()
  })

  it('starts one task for two identical requests that arrive together', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    const [one, two] = await Promise.all([
      tasks.startLocal(cwd, 'film', request('22222222-bbbb'), async () => file),
      tasks.startLocal(cwd, 'film', request('22222222-bbbb'), async () => file),
    ])
    expect(two.taskId).toBe(one.taskId)
    await settle(tasks, one.taskId)
    await tasks.settled()
  })

  it('cancels a running edit: the work is aborted and the task ends interrupted with its cancellation', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    let aborted = false
    const started = await tasks.startLocal(cwd, 'film', request('33333333-cccc'), signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true
        reject(signal.reason)
      })
    }))
    await tasks.cancel(cwd, started.taskId)
    const ended = await settle(tasks, started.taskId)
    expect(aborted).toBe(true)
    expect(ended).toMatchObject({ status: 'interrupted', error: { code: 'ABORTED', status: 499 } })
    expect(ended.lines.at(-1)).toBe('已取消')
    expect(await tasks.record(cwd, started.taskId)).toMatchObject({ cancellation: { code: 'ABORTED' } })
    await tasks.settled()
  })

  it('records a failed edit with its code', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    const started = await tasks.startLocal(cwd, 'film', request('44444444-dddd'), async () => {
      throw new MediaEditError(422, 'MEDIA_EDIT_NEEDS_TRANSCODE', 'cannot copy')
    })
    const failed = await settle(tasks, started.taskId)
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'MEDIA_EDIT_NEEDS_TRANSCODE', status: 422, message: 'cannot copy' } })
    expect(failed.error?.reasons).toBeUndefined()
    await tasks.settled()
  })

  it('keeps the reasons of an edit refused while it ran, so the page knows what to re-encode', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    const reasons = [{ index: 1, reason: 'missing-audio', detail: '这一段的声音比画面早 120 ms 结束。' }]
    const started = await tasks.startLocal(cwd, 'film', { ...request('44444444-eeee'), capability: 'video.join' }, async () => {
      throw new MediaEditError(422, 'VIDEO_JOIN_NEEDS_TRANSCODE', 'cannot join', { reasons })
    })
    expect(await settle(tasks, started.taskId)).toMatchObject({ status: 'failed', error: { code: 'VIDEO_JOIN_NEEDS_TRANSCODE', status: 422, reasons } })
    await tasks.settled()
    expect(await new FilmMediaTasks(() => undefined).record(cwd, started.taskId)).toMatchObject({ error: { reasons } })
  })

  it('finishes an edit done when the cancel comes after its result is named (while it lands on the board)', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    let land!: () => void
    const landing = new Promise<void>((resolve) => { land = resolve })
    let named = false
    const started = await tasks.startLocal(cwd, 'film', request('88888888-aaaa'), async (signal) => {
      named = true
      // Holding the board lock: the cancel arrives now, and landing goes on.
      await landing
      expect(signal.aborted).toBe(true)
      return { ...file, landedNodeId: 'video-1' }
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(named).toBe(true)
    await tasks.cancel(cwd, started.taskId)
    land()
    const ended = await settle(tasks, started.taskId)
    expect(ended).toMatchObject({ status: 'done', error: null, file: { name: file.name, landedNodeId: 'video-1' } })
    expect(ended.lines.at(-1)).toBe('完成')
    expect((await tasks.record(cwd, started.taskId))?.cancellation).toBeUndefined()
    await tasks.settled()
  })

  it(`runs at most ${LOCAL_TASK_LIMIT} edits at once in a workspace`, async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    const release: Array<() => void> = []
    const hold = () => new Promise<FilmTaskFile>((resolve) => { release.push(() => resolve(file)) })
    const first = await tasks.startLocal(cwd, 'film', request('55555555-0001'), hold)
    await tasks.startLocal(cwd, 'film', request('55555555-0002'), hold)
    await expect(tasks.startLocal(cwd, 'film', request('55555555-0003'), hold)).rejects.toMatchObject({ status: 503, code: 'MEDIA_EDIT_BUSY' })
    for (const done of release) done()
    await settle(tasks, first.taskId)
    await new Promise(resolve => setTimeout(resolve, 10))
    await expect(tasks.startLocal(cwd, 'film', request('55555555-0003'), async () => file)).resolves.toMatchObject({ existing: false })
    await tasks.settled()
  })

  it('leaves an edit that a restart of the Host cut off interrupted', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    const started = await tasks.startLocal(cwd, 'film', request('66666666-eeee'), () => new Promise(() => {}))
    await tasks.settled()
    const restarted = new FilmMediaTasks(() => undefined)
    const snapshot = await restarted.wait(cwd, started.taskId, 0, 0)
    expect(snapshot).toMatchObject({ status: 'interrupted', error: { code: 'MEDIA_TASK_INTERRUPTED', message: '剪辑过程中宿主重启，请重新操作。' } })
    expect(snapshot.progress.at(-1)).toBe('已中断')
    await restarted.settled()
  })

  it('leaves an edit interrupted when the plugin stops', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    const started = await tasks.startLocal(cwd, 'film', request('77777777-ffff'), signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason) })
    }))
    tasks.dispose()
    expect(await settle(tasks, started.taskId)).toMatchObject({ status: 'interrupted', error: { code: 'MEDIA_TASK_INTERRUPTED' } })
    await tasks.settled()
  })
})
