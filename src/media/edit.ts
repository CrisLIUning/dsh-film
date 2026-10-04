/**
 * Lossless edits of the film's media files, run in the Host: cut a range out
 * of a video or audio file, join video clips end to end, and copy a video's
 * sound out into its own file.
 *
 * Nothing is re-encoded. mediabunny (MPL-2.0, unmodified) reads and writes
 * the containers in-process and copies the encoded packets, so the Host needs
 * no ffmpeg. What cannot be copied is refused with the reasons, and the
 * canvas page re-encodes it instead (in the browser, while the 分镜 tab is
 * open).
 *
 * - Cut: a `Conversion` with `trim` and `copy: { mode: 'forced' }`. With the
 *   default `'expand'` boundary the copy starts at the key frame before the
 *   in point and the MP4 gets an edit list that starts playback exactly at
 *   it; `'shrink'` starts at the next key frame instead (for players that
 *   ignore edit lists). Audio-only files keep their container.
 * - Join: mediabunny has no concatenation, so packets are read from each clip
 *   (`EncodedPacketSink`) and written to one video and one audio track
 *   (`EncodedVideoPacketSource` / `EncodedAudioPacketSource`) with their
 *   timestamps shifted. A track takes one decoder configuration, so every clip
 *   must match the first in codec, coded size and decoder configuration
 *   (avcC), in sound format, and every clip after the first must start on a
 *   key frame.
 * - Extract audio: a `Conversion` with the video discarded and the audio
 *   copied into an MP4 audio file (`.m4a`), or the source's own container
 *   when it is already an audio file.
 *
 * Every edit writes a hidden temporary file next to its result and renames it
 * when it is complete; a cancelled or failed edit deletes it.
 * @module dsh-film/media/edit
 */

import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import {
  ALL_FORMATS, Conversion, ConversionCanceledError, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource, FilePathSource,
  FilePathTarget, Input, Mp3OutputFormat, Mp4OutputFormat, Output, WavOutputFormat,
} from 'mediabunny'
import type { EncodedPacket, InputAudioTrack, InputVideoTrack, OutputFormat } from 'mediabunny'

/** The shortest range an edit takes. */
export const MIN_EDIT_MS = 100
/** The most key frames a probe lists. */
export const PROBE_KEYFRAME_LIMIT = 400
/** How far (ms) an in point may be from a key frame and still count as on it. */
const KEYFRAME_TOLERANCE_MS = 1

/** Why an edit was refused or failed; the routes answer with `status` and `code`. */
export class MediaEditError extends Error {
  override name = 'MediaEditError'

  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Readonly<Record<string, unknown>> = {}) {
    super(message)
  }
}

/** One reason a set of clips cannot be joined without re-encoding (C9). */
export interface JoinReason {
  /** The clip, by its place in the play order. */
  index: number
  reason: 'codec' | 'resolution' | 'decoder-config' | 'audio-format' | 'not-keyframe' | 'missing-audio'
  detail: string
}

export interface VideoTrackFacts {
  codec: string
  codedWidth: number
  codedHeight: number
  frameRate?: number
  /** SHA-1 of the decoder description bytes (the avcC for H.264). */
  configHash: string
}

export interface AudioTrackFacts {
  codec: string
  sampleRate: number
  channels: number
  /** SHA-1 of the decoder description bytes (the AudioSpecificConfig for AAC). */
  configHash: string
}

/** What a media file is, read for editing. */
export interface EditProbe {
  ok: boolean
  durationMs?: number
  /** Display size, rotation applied. */
  width?: number
  height?: number
  hasAudio?: boolean
  video?: VideoTrackFacts
  audio?: AudioTrackFacts
  /** Presentation times of the first {@link PROBE_KEYFRAME_LIMIT} key frames. */
  keyframesMs?: number[]
  /** The picture's rotation metadata, in degrees (not part of the route answer). */
  rotation?: number
  /** What of the sound's decoder configuration must match to share a track ({@link audioConfigKey}; not part of the route answer). */
  audioConfigKey?: string
}

/** What a finished edit wrote. */
export interface EditResult {
  /** The absolute path of the result. */
  path: string
  size: number
  durationMs?: number
  width?: number
  height?: number
  hasAudio?: boolean
}

export interface EditOptions {
  signal?: AbortSignal
  /** Told how far the writing is, 0–1. */
  onProgress?: (fraction: number) => void
}

/** A range of a source file, in ms; `outMs` undefined means to the end. */
export interface EditRange {
  inMs?: number
  outMs?: number
}

const hashOf = (bytes: Uint8Array | ArrayBufferLike | ArrayBufferView | undefined, fallback: string): string => {
  const hash = createHash('sha1')
  if (bytes === undefined) hash.update(fallback)
  else if (ArrayBuffer.isView(bytes)) hash.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  else hash.update(new Uint8Array(bytes))
  return hash.digest('hex')
}

const AUDIO_CONTAINERS = new Set(['.m4a', '.mp3', '.wav'])

const openInput = (path: string): Input => new Input({ source: new FilePathSource(path), formats: ALL_FORMATS })

async function videoFacts(track: InputVideoTrack): Promise<VideoTrackFacts> {
  const [codec, codedWidth, codedHeight, config, parameter] = await Promise.all([
    track.getCodec(), track.getCodedWidth(), track.getCodedHeight(), track.getDecoderConfig(), track.getCodecParameterString(),
  ])
  const stats = await track.computePacketStats(120).catch(() => undefined)
  const description = config?.description as ArrayBufferView | ArrayBufferLike | undefined
  return {
    codec: codec ?? 'unknown',
    codedWidth,
    codedHeight,
    ...(stats !== undefined && Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0 ? { frameRate: Math.round(stats.averagePacketRate * 1000) / 1000 } : {}),
    configHash: hashOf(description, parameter ?? codec ?? ''),
  }
}

const bytesOf = (value: ArrayBufferView | ArrayBufferLike | undefined): Uint8Array | undefined =>
  value === undefined ? undefined : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value)

/**
 * What of a sound track's decoder configuration must match for its packets to
 * share one track. For AAC that is the AudioSpecificConfig's object type,
 * sample rate and channels, and whether SBR or PS is signalled: encoders
 * differ in whether they append the explicit "no SBR" extension (`56e500`),
 * which decodes the same. Anything else compares every byte.
 * @param codec - mediabunny's codec name.
 * @param description - the decoder description.
 * @param fallback - what identifies a track without one.
 * @returns the key.
 */
export function audioConfigKey(codec: string, description: Uint8Array | undefined, fallback: string): string {
  if (codec !== 'aac' || description === undefined || description.length < 2 || description[0]! >> 3 === 31 || (description[0]! & 0x07) === 0x07 && description[1]! >> 7 === 1) {
    return hashOf(description, fallback)
  }
  const core = Buffer.from(description.subarray(0, 2)).toString('hex')
  if (description.length < 4) return core
  // After the 16 core bits: syncExtensionType 0x2B7, extensionAudioObjectType (5 bits), and for SBR (5) a presence flag.
  const word = (description[2]! << 16) | (description[3]! << 8) | (description[4] ?? 0)
  const sync = word >> 13
  const extension = (word >> 8) & 0x1f
  const present = (word >> 7) & 1
  if (sync !== 0x2b7) return hashOf(description, fallback)
  if (extension === 5 && present === 0) return core
  return `${core}:${Buffer.from(description.subarray(2)).toString('hex')}`
}

async function audioFacts(track: InputAudioTrack): Promise<AudioTrackFacts & { configKey: string }> {
  const [codec, sampleRate, channels, config, parameter] = await Promise.all([
    track.getCodec(), track.getSampleRate(), track.getNumberOfChannels(), track.getDecoderConfig(), track.getCodecParameterString(),
  ])
  const description = bytesOf(config?.description as ArrayBufferView | ArrayBufferLike | undefined)
  const fallback = parameter ?? codec ?? ''
  return { codec: codec ?? 'unknown', sampleRate, channels, configHash: hashOf(description, fallback), configKey: audioConfigKey(codec ?? 'unknown', description, fallback) }
}

async function keyframesOf(track: InputVideoTrack): Promise<number[]> {
  const sink = new EncodedPacketSink(track)
  const times: number[] = []
  let packet = await sink.getFirstKeyPacket({ metadataOnly: true })
  while (packet !== null && times.length < PROBE_KEYFRAME_LIMIT) {
    times.push(Math.round(packet.timestamp * 1000))
    packet = await sink.getNextKeyPacket(packet, { metadataOnly: true })
  }
  return times
}

/**
 * Read what an edit needs to know about a media file: its length, picture,
 * codecs and decoder configurations, and where its key frames are.
 * @param path - the absolute file path.
 * @returns the facts; `ok: false` when the file cannot be read as media.
 */
export async function probeDetailed(path: string): Promise<EditProbe> {
  const input = openInput(path)
  try {
    const [duration, video, audio] = await Promise.all([input.computeDuration(), input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
    if (video === null && audio === null) return { ok: false }
    const probe: EditProbe = { ok: true, hasAudio: audio !== null }
    if (Number.isFinite(duration) && duration > 0) probe.durationMs = Math.round(duration * 1000)
    if (video !== null) {
      const [width, height, rotation] = await Promise.all([video.getDisplayWidth(), video.getDisplayHeight(), video.getRotation()])
      if (width > 0 && height > 0) {
        probe.width = width
        probe.height = height
      }
      probe.rotation = rotation
      probe.video = await videoFacts(video)
      probe.keyframesMs = await keyframesOf(video)
    }
    if (audio !== null) {
      const { configKey, ...facts } = await audioFacts(audio)
      probe.audio = facts
      probe.audioConfigKey = configKey
    }
    return probe
  } catch {
    return { ok: false }
  } finally {
    input.dispose()
  }
}

/**
 * Check a range against a file's length.
 * @param range - the requested range.
 * @param durationMs - the file's length.
 * @returns the range with both ends set.
 */
export function checkRange(range: EditRange, durationMs: number | undefined): { inMs: number; outMs: number } {
  const length = durationMs ?? 0
  const inMs = range.inMs ?? 0
  const outMs = range.outMs ?? length
  if (!Number.isInteger(inMs) || !Number.isInteger(outMs) || inMs < 0) throw new MediaEditError(400, 'MEDIA_EDIT_INVALID', 'inMs and outMs must be whole milliseconds, inMs from 0.')
  if (length <= 0) throw new MediaEditError(422, 'MEDIA_EDIT_UNSUPPORTED', 'The file has no length that can be read.')
  if (outMs > length + KEYFRAME_TOLERANCE_MS) throw new MediaEditError(400, 'MEDIA_EDIT_INVALID', `The range ends at ${outMs} ms, past the end of the file (${length} ms).`)
  if (outMs - inMs < MIN_EDIT_MS) throw new MediaEditError(400, 'MEDIA_EDIT_INVALID', `The range must be at least ${MIN_EDIT_MS} ms long.`)
  return { inMs, outMs: Math.min(outMs, length) }
}

/** The output format a lossless copy of a file goes into, and the result's extension. */
export function copyTarget(source: string, probe: EditProbe, audioOnly: boolean): { extension: string; format: () => OutputFormat } {
  const extension = extname(source).toLowerCase()
  if (probe.video === undefined || audioOnly) {
    // An audio file keeps its container; a video's sound goes into an MP4 audio file.
    if (probe.video === undefined && AUDIO_CONTAINERS.has(extension)) {
      if (extension === '.mp3') return { extension, format: () => new Mp3OutputFormat() }
      if (extension === '.wav') return { extension, format: () => new WavOutputFormat() }
    }
    return { extension: '.m4a', format: () => new Mp4OutputFormat() }
  }
  return { extension: '.mp4', format: () => new Mp4OutputFormat() }
}

/**
 * Why a file cannot be copied into its output container, if it cannot.
 * @param probe - the file.
 * @param format - the output container.
 * @param audioOnly - only the sound is copied.
 * @returns the reason, or `undefined` when it can.
 */
export function copyProblem(probe: EditProbe, format: OutputFormat, audioOnly: boolean): JoinReason | undefined {
  if (!audioOnly && probe.video !== undefined && !(format.getSupportedVideoCodecs() as string[]).includes(probe.video.codec)) {
    return { index: 0, reason: 'codec', detail: `画面编码 ${probe.video.codec} 不能无损写入 MP4，需要重新编码。` }
  }
  if (probe.audio !== undefined && !(format.getSupportedAudioCodecs() as string[]).includes(probe.audio.codec)) {
    return { index: 0, reason: 'audio-format', detail: `声音编码 ${probe.audio.codec} 不能无损写入这个格式，需要重新编码。` }
  }
  return undefined
}

/** Whether the edit was cancelled (a call, so checks after an await are not narrowed away). */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true

/** The rejection an aborted signal carries, as an error. */
const abortError = (signal: AbortSignal | undefined): Error =>
  signal?.reason instanceof Error ? signal.reason : new Error('cancelled')

/**
 * Give a finished temporary file its name: `wanted`, or the first free
 * `<stem>-N` name. `link` refuses an existing name, so two edits never take
 * the same one.
 * @param temporary - the complete temporary file.
 * @param wanted - the absolute path wanted.
 * @returns the absolute path it got.
 */
async function settle(temporary: string, wanted: string): Promise<string> {
  const extension = extname(wanted)
  const stem = wanted.slice(0, wanted.length - extension.length)
  for (let index = 1; index < 10_000; index++) {
    const candidate = index === 1 ? wanted : `${stem}-${index}${extension}`
    try {
      await link(temporary, candidate)
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      // A file system without hard links (exFAT, some network drives): rename onto a name nothing holds.
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw error
      if (await lstat(candidate).then(() => true, () => false)) continue
      await rename(temporary, candidate)
      return candidate
    }
  }
  throw new MediaEditError(409, 'MEDIA_EDIT_NAME_TAKEN', `No free name for ${basename(wanted)}.`)
}

/** A hidden temporary file beside `target`. */
const temporaryFor = (target: string): string => join(dirname(target), `.edit-${randomUUID()}${extname(target)}.tmp`)

async function resultFacts(path: string): Promise<EditResult> {
  const [info, probe] = await Promise.all([stat(path), probeDetailed(path)])
  return {
    path,
    size: info.size,
    ...(probe.durationMs !== undefined ? { durationMs: probe.durationMs } : {}),
    ...(probe.width !== undefined && probe.height !== undefined ? { width: probe.width, height: probe.height } : {}),
    ...(probe.hasAudio !== undefined ? { hasAudio: probe.hasAudio } : {}),
  }
}

/**
 * Run one copying `Conversion` into a temporary file, then name it.
 * @param source - the absolute source path.
 * @param target - the absolute result path wanted.
 * @param format - the output container.
 * @param conversion - what to copy.
 * @param options - cancel and progress.
 * @returns the result.
 */
async function convert(
  source: string,
  target: string,
  format: OutputFormat,
  conversion: { trim?: { start: number; end: number }; boundary: 'expand' | 'shrink'; audioOnly: boolean },
  options: EditOptions,
): Promise<EditResult> {
  const { signal } = options
  if (isAborted(signal)) throw abortError(signal)
  const temporary = temporaryFor(target)
  const input = openInput(source)
  const output = new Output({ format, target: new FilePathTarget(temporary) })
  let running: Conversion | undefined
  const stop = (): void => { void running?.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    running = await Conversion.init({
      input,
      output,
      ...(conversion.audioOnly ? { video: { discard: true } } : {}),
      ...(conversion.trim !== undefined ? { trim: conversion.trim } : {}),
      copy: { mode: 'forced', boundaryPolicy: conversion.boundary },
      showWarnings: false,
    })
    const refused = running.discardedTracks.find(entry => entry.reason === 'cannot_copy' && (entry.track.isAudioTrack() || entry.track.isVideoTrack()))
    if (refused !== undefined || !running.isValid) {
      const what = refused?.track.isAudioTrack() === true ? '声音' : '画面'
      throw new MediaEditError(422, 'MEDIA_EDIT_NEEDS_TRANSCODE', `${what}不能无损复制到结果里，需要在分镜页里重新编码。`, {
        reasons: [{ index: 0, reason: refused?.track.isAudioTrack() === true ? 'audio-format' : 'codec', detail: `${what}不能无损复制。` }],
      })
    }
    if (isAborted(signal)) throw abortError(signal)
    running.onProgress = (progress) => { options.onProgress?.(Math.min(1, Math.max(0, progress))) }
    await running.execute()
    if (isAborted(signal)) throw abortError(signal)
    const named = await settle(temporary, target)
    return await resultFacts(named)
  } catch (error) {
    if (output.state === 'started' || output.state === 'pending') await output.cancel().catch(() => undefined)
    if (error instanceof ConversionCanceledError || isAborted(signal)) throw abortError(signal)
    throw error
  } finally {
    signal?.removeEventListener('abort', stop)
    input.dispose()
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/**
 * Cut a range out of a video or audio file, without re-encoding.
 * @param source - the absolute source path.
 * @param target - the absolute result path wanted (`.mp4` for a video, the source's container for audio).
 * @param range - the range, in ms of the source.
 * @param boundary - `'expand'` starts at the key frame before the in point (with an edit list); `'shrink'` at the one after.
 * @param options - cancel and progress.
 * @returns the result.
 */
export async function cutFile(source: string, target: string, range: { inMs: number; outMs: number }, boundary: 'expand' | 'shrink', options: EditOptions = {}): Promise<EditResult> {
  const probe = await probeDetailed(source)
  if (!probe.ok) throw new MediaEditError(422, 'MEDIA_EDIT_UNSUPPORTED', 'The file cannot be read as video or audio.')
  const { format } = copyTarget(source, probe, false)
  return convert(source, target, format(), { trim: { start: range.inMs / 1000, end: range.outMs / 1000 }, boundary, audioOnly: false }, options)
}

/**
 * Copy the sound of a video (or a range of it) into its own file, without re-encoding.
 * @param source - the absolute source path.
 * @param target - the absolute result path wanted (`.m4a`, or the source's container for an audio file).
 * @param range - the range, when only part is wanted.
 * @param options - cancel and progress.
 * @returns the result.
 */
export async function extractAudio(source: string, target: string, range: { inMs: number; outMs: number } | undefined, options: EditOptions = {}): Promise<EditResult> {
  const probe = await probeDetailed(source)
  if (!probe.ok) throw new MediaEditError(422, 'MEDIA_EDIT_UNSUPPORTED', 'The file cannot be read as video or audio.')
  if (probe.audio === undefined) throw new MediaEditError(422, 'VIDEO_NO_AUDIO_TRACK', '这个视频没有音轨。')
  const { format } = copyTarget(source, probe, true)
  return convert(source, target, format(), {
    ...(range !== undefined ? { trim: { start: range.inMs / 1000, end: range.outMs / 1000 } } : {}),
    boundary: 'expand',
    audioOnly: true,
  }, options)
}

/** One clip of a join: a file and the range of it that plays. */
export interface JoinClip {
  /** The absolute file path. */
  path: string
  inMs: number
  outMs: number
}

/**
 * The key packet a clip starts from, when its in point is one.
 * @param track - the clip's picture.
 * @param inMs - the in point.
 * @returns the packet, or `null` when no key frame lies within a millisecond of it.
 */
async function keyPacketAt(track: InputVideoTrack, inMs: number): Promise<EncodedPacket | null> {
  const sink = new EncodedPacketSink(track)
  const packet = inMs === 0
    ? await sink.getFirstKeyPacket({ verifyKeyPackets: true })
    // Looked up just past the in point: probes list key frames rounded to the millisecond (1458 for 1458.33).
    : await sink.getKeyPacket((inMs + KEYFRAME_TOLERANCE_MS) / 1000, { verifyKeyPackets: true })
  if (packet === null) return null
  return inMs === 0 || Math.abs(packet.timestamp * 1000 - inMs) <= KEYFRAME_TOLERANCE_MS ? packet : null
}

/**
 * Why clips cannot be joined by copying their packets, compared with the
 * first clip: nothing means they can.
 * @param clips - the clips in play order, each with its probe.
 * @returns the reasons.
 */
export async function joinProblems(clips: ReadonlyArray<JoinClip & { probe: EditProbe }>): Promise<JoinReason[]> {
  const reasons: JoinReason[] = []
  const first = clips[0]?.probe
  if (first === undefined) return reasons
  const mp4 = new Mp4OutputFormat()
  for (const [index, { probe, path, inMs }] of clips.entries()) {
    const video = probe.video
    if (video === undefined) {
      reasons.push({ index, reason: 'codec', detail: '这一段没有画面。' })
      continue
    }
    if (index === 0 && !(mp4.getSupportedVideoCodecs() as string[]).includes(video.codec)) {
      reasons.push({ index, reason: 'codec', detail: `画面编码 ${video.codec} 不能无损写入 MP4。` })
    }
    if (index > 0 && first.video !== undefined) {
      if (video.codec !== first.video.codec) reasons.push({ index, reason: 'codec', detail: `画面编码是 ${video.codec}，第一段是 ${first.video.codec}。` })
      else if (video.codedWidth !== first.video.codedWidth || video.codedHeight !== first.video.codedHeight || (probe.rotation ?? 0) !== (first.rotation ?? 0)) {
        reasons.push({ index, reason: 'resolution', detail: `尺寸是 ${video.codedWidth}×${video.codedHeight}${probe.rotation ? `（旋转 ${probe.rotation}°）` : ''}，第一段是 ${first.video.codedWidth}×${first.video.codedHeight}${first.rotation ? `（旋转 ${first.rotation}°）` : ''}。` })
      } else if (video.configHash !== first.video.configHash) {
        reasons.push({ index, reason: 'decoder-config', detail: '编码参数（SPS/PPS）和第一段不同。' })
      }
    }
    if ((probe.audio !== undefined) !== (first.audio !== undefined)) {
      reasons.push({ index, reason: 'missing-audio', detail: probe.audio === undefined ? '这一段没有声音，其他段有。' : '这一段有声音，第一段没有。' })
    } else if (index > 0 && probe.audio !== undefined && first.audio !== undefined) {
      const a = probe.audio, b = first.audio
      const sameConfig = (probe.audioConfigKey ?? a.configHash) === (first.audioConfigKey ?? b.configHash)
      if (a.codec !== b.codec || a.sampleRate !== b.sampleRate || a.channels !== b.channels || !sameConfig) {
        reasons.push({ index, reason: 'audio-format', detail: `声音是 ${a.codec} ${a.sampleRate} Hz ${a.channels} 声道，第一段是 ${b.codec} ${b.sampleRate} Hz ${b.channels} 声道${!sameConfig && a.codec === b.codec ? '（编码参数不同）' : ''}。` })
      }
    } else if (index === 0 && probe.audio !== undefined && !(mp4.getSupportedAudioCodecs() as string[]).includes(probe.audio.codec)) {
      reasons.push({ index, reason: 'audio-format', detail: `声音编码 ${probe.audio.codec} 不能无损写入 MP4。` })
    }
    // A clip after the first must start on a key frame, or its pre-roll would show mid-film.
    if (index > 0 && inMs > 0) {
      const input = openInput(path)
      try {
        const track = await input.getPrimaryVideoTrack()
        if (track === null || await keyPacketAt(track, inMs) === null) {
          const near = probe.keyframesMs?.filter(time => time <= inMs).at(-1)
          reasons.push({ index, reason: 'not-keyframe', detail: `入点 ${inMs} ms 不在关键帧上${near !== undefined ? `（前一个关键帧在 ${near} ms）` : ''}。` })
        }
      } finally {
        input.dispose()
      }
    }
  }
  return reasons
}

/**
 * Of a clip's picture packets in decode order, the ones it copies for
 * [start, end) — Conversion's own rule, also used to measure the clip first.
 * A packet showing at or after the end is still copied while a B-frame a few
 * packets later shows inside the range (it is that frame's reference); the
 * clip then runs that frame long, and the next clip starts after it.
 */
async function* clipPackets(sink: EncodedPacketSink, start: EncodedPacket, end: number, metadataOnly: boolean): AsyncGenerator<EncodedPacket> {
  for await (const packet of sink.packets(start, undefined, metadataOnly ? { metadataOnly: true } : {})) {
    if (packet.timestamp >= end) {
      let current = packet
      let found = false
      for (let step = 0; step < 6; step++) {
        const next = await sink.getNextPacket(current, { metadataOnly: true })
        if (next === null) break
        if (next.timestamp < end) {
          found = true
          break
        }
        current = next
      }
      if (!found) return
    }
    yield packet
  }
}

/**
 * Join video clips end to end by copying their packets, without re-encoding.
 * Call {@link joinProblems} first: clips it finds problems with cannot be joined here.
 * @param clips - two or more clips in play order.
 * @param target - the absolute result path wanted (`.mp4`).
 * @param options - cancel and progress.
 * @returns the result.
 */
export async function joinFiles(clips: readonly JoinClip[], target: string, options: EditOptions = {}): Promise<EditResult> {
  const { signal } = options
  if (isAborted(signal)) throw abortError(signal)
  const temporary = temporaryFor(target)
  const output = new Output({ format: new Mp4OutputFormat(), target: new FilePathTarget(temporary) })
  const total = clips.reduce((sum, clip) => sum + (clip.outMs - clip.inMs), 0) / 1000
  try {
    let videoSource: EncodedVideoPacketSource | undefined
    let audioSource: EncodedAudioPacketSource | undefined
    let videoConfig: VideoDecoderConfig | undefined
    let audioConfig: AudioDecoderConfig | undefined
    let offset = 0
    let audioCursor = -Infinity
    for (const [index, clip] of clips.entries()) {
      const input = openInput(clip.path)
      try {
        const video = await input.getPrimaryVideoTrack()
        const audio = await input.getPrimaryAudioTrack()
        if (video === null) throw new MediaEditError(422, 'MEDIA_EDIT_UNSUPPORTED', `Clip ${index + 1} has no picture.`)
        const sink = new EncodedPacketSink(video)
        // The first clip may start between key frames: its pre-roll gets negative times and the MP4 an edit list.
        const startPacket = index === 0
          ? (clip.inMs === 0 ? await sink.getFirstKeyPacket({ verifyKeyPackets: true }) : await sink.getKeyPacket(clip.inMs / 1000, { verifyKeyPackets: true }) ?? await sink.getFirstKeyPacket({ verifyKeyPackets: true }))
          : await keyPacketAt(video, clip.inMs)
        if (startPacket === null) throw new MediaEditError(422, 'VIDEO_JOIN_NEEDS_TRANSCODE', `Clip ${index + 1} does not start on a key frame.`)
        const clipStart = index === 0 ? clip.inMs / 1000 : startPacket.timestamp
        const end = clip.outMs / 1000
        // Measure first (from the index only), so the sound can stop where the picture does.
        let clipEnd = clipStart
        for await (const packet of clipPackets(sink, startPacket, end, true)) clipEnd = Math.max(clipEnd, packet.timestamp + packet.duration)
        if (videoSource === undefined) {
          videoConfig = (await video.getDecoderConfig()) ?? undefined
          const codec = await video.getCodec()
          if (codec === null || videoConfig === undefined) throw new MediaEditError(422, 'MEDIA_EDIT_UNSUPPORTED', 'The first clip\'s picture cannot be copied.')
          videoSource = new EncodedVideoPacketSource(codec)
          const rotation = await video.getRotation()
          output.addVideoTrack(videoSource, rotation !== 0 ? { rotation } : {})
          if (audio !== null) {
            const audioCodec = await audio.getCodec()
            audioConfig = (await audio.getDecoderConfig()) ?? undefined
            if (audioCodec !== null && audioConfig !== undefined) {
              audioSource = new EncodedAudioPacketSource(audioCodec)
              output.addAudioTrack(audioSource)
            }
          }
          await output.start()
        }
        const shift = offset - clipStart
        const pictures = clipPackets(sink, startPacket, end, false)[Symbol.asyncIterator]()
        const sounds = audioSource !== undefined && audio !== null ? clipSounds(audio, clipStart, clipEnd) : undefined
        let nextPicture = await pictures.next()
        let nextSound = await sounds?.next()
        let firstPicture = videoConfig !== undefined && index === 0
        // Interleave the two tracks by time.
        while (nextPicture.done !== true || (nextSound !== undefined && nextSound.done !== true)) {
          if (isAborted(signal)) throw abortError(signal)
          const takePicture = nextPicture.done !== true && (nextSound === undefined || nextSound.done === true || nextPicture.value.timestamp <= nextSound.value.timestamp)
          if (takePicture && nextPicture.done !== true) {
            const packet = nextPicture.value
            await videoSource.add(packet.clone({ timestamp: packet.timestamp + shift }), firstPicture ? { decoderConfig: videoConfig! } : undefined)
            firstPicture = false
            options.onProgress?.(Math.min(1, Math.max(0, (packet.timestamp + shift) / Math.max(total, 0.001))))
            nextPicture = await pictures.next()
          } else if (nextSound !== undefined && nextSound.done !== true) {
            const packet = nextSound.value
            const time = packet.timestamp + shift
            // A packet straddling the cut would overlap the previous clip's sound.
            if (time >= audioCursor - 1e-6) {
              await audioSource!.add(packet.clone({ timestamp: time }), audioCursor === -Infinity ? { decoderConfig: audioConfig! } : undefined)
              audioCursor = time + packet.duration
            }
            nextSound = await sounds!.next()
          }
        }
        offset += clipEnd - clipStart
      } finally {
        input.dispose()
      }
    }
    if (isAborted(signal)) throw abortError(signal)
    videoSource?.close()
    audioSource?.close()
    await output.finalize()
    options.onProgress?.(1)
    const named = await settle(temporary, target)
    return await resultFacts(named)
  } catch (error) {
    if (output.state === 'started' || output.state === 'pending') await output.cancel().catch(() => undefined)
    if (isAborted(signal)) throw abortError(signal)
    throw error
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** A clip's sound packets that start within [start, end). */
async function* clipSounds(track: InputAudioTrack, start: number, end: number): AsyncGenerator<EncodedPacket> {
  const sink = new EncodedPacketSink(track)
  const first = await sink.getPacket(start) ?? await sink.getFirstPacket()
  if (first === null) return
  for await (const packet of sink.packets(first)) {
    if (packet.timestamp >= end) return
    if (packet.timestamp + packet.duration <= start) continue
    yield packet
  }
}
