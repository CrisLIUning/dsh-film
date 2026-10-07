/**
 * Small MP4 and M4A files for the media edit tests, written with mediabunny
 * in the test itself (no ffmpeg, no stored media).
 *
 * The H.264 bytes are a real 64×64 baseline stream's SPS, PPS, one IDR slice
 * and one P slice (from a black test card), repeated into whatever GOP layout
 * a test needs; the AAC bytes are a silent frame. Nothing decodes them here:
 * the edits copy packets, and mediabunny checks only that key packets are IDR.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, FilePathTarget, Mp4OutputFormat, Output } from 'mediabunny'

const hex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'))

const SPS = hex('6742c00ad90426c044000003000400000300c83c489920')
const PPS = hex('68cb83cb20')
/** The same picture parameters with a different last byte: another encoder setting, so another avcC. */
const OTHER_PPS = hex('68cb83cb21')
const IDR = hex('6588840cf2628000b0bc9c9c9d75d75d75d75d75d75e')
const P_SLICE = hex('419a3819e118')
const SILENT_AAC = hex('21004990021900238000')

/** An avcC record (ISO 14496-15 5.3.3.1) for one SPS and one PPS, 4-byte NAL lengths. */
function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  return Uint8Array.from([1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1, sps.length >> 8, sps.length & 0xff, ...sps, 1, pps.length >> 8, pps.length & 0xff, ...pps])
}

/** One NAL unit with its 4-byte length. */
function lengthPrefixed(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + nal.length)
  new DataView(out.buffer).setUint32(0, nal.length)
  out.set(nal, 4)
  return out
}

/** AudioSpecificConfig for AAC-LC. */
function audioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
  const index = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(sampleRate)
  const bits = (2 << 11) | (index << 7) | (channels << 3)
  return Uint8Array.from([bits >> 8, bits & 0xff])
}

export interface FixtureOptions {
  /** Picture frames; 0 for an audio-only file. Default 50. */
  frames?: number
  fps?: number
  /** Frames per GOP (a key frame every `gop` frames). Default `fps` (one a second). */
  gop?: number
  width?: number
  height?: number
  /** A different PPS, so a different decoder configuration. */
  otherConfig?: boolean
  /** Sound: false for none. Default 48 kHz stereo. */
  audio?: false | { sampleRate?: number; channels?: number }
  /** Seconds of sound; by default as long as the picture (2 without one). */
  audioSeconds?: number
  /** B-frames: after each key frame, pictures come in decode order P(n+1), B(n), as an encoder with one B-frame writes them. */
  bframes?: boolean
}

/** Presentation frame indexes in decode order. */
function decodeOrder(frames: number, gop: number, bframes: boolean): number[] {
  if (!bframes) return Array.from({ length: frames }, (_, index) => index)
  const order: number[] = []
  for (let start = 0; start < frames; start += gop) {
    const end = Math.min(start + gop, frames)
    order.push(start)
    for (let index = start + 1; index < end; index += 2) {
      if (index + 1 < end) order.push(index + 1, index)
      else order.push(index)
    }
  }
  return order
}

/**
 * Write a small MP4 (or, with `frames: 0`, an MP4 audio file).
 * @param path - the absolute path.
 * @param options - the layout.
 * @returns the path.
 */
export async function writeFixture(path: string, options: FixtureOptions = {}): Promise<string> {
  const fps = options.fps ?? 25
  const frames = options.frames ?? 50
  const gop = options.gop ?? fps
  await mkdir(dirname(path), { recursive: true })
  const output = new Output({ format: new Mp4OutputFormat(), target: new FilePathTarget(path) })
  const video = frames > 0 ? new EncodedVideoPacketSource('avc') : undefined
  if (video !== undefined) output.addVideoTrack(video, { frameRate: fps })
  const sound = options.audio === false ? undefined : { sampleRate: options.audio?.sampleRate ?? 48000, channels: options.audio?.channels ?? 2 }
  const audio = sound !== undefined ? new EncodedAudioPacketSource('aac') : undefined
  if (audio !== undefined) output.addAudioTrack(audio)
  await output.start()
  const seconds = options.audioSeconds ?? (frames > 0 ? frames / fps : 2)
  const audioFrame = sound === undefined ? 0 : 1024 / sound.sampleRate
  const audioPackets = sound === undefined ? 0 : Math.ceil(seconds / audioFrame)
  // Interleaved by time, as an encoder would write them.
  const order = decodeOrder(frames, gop, options.bframes === true)
  let picture = 0
  let soundIndex = 0
  while (picture < frames || soundIndex < audioPackets) {
    const pictureTime = picture < frames ? order[picture]! / fps : Infinity
    const soundTime = soundIndex < audioPackets ? soundIndex * audioFrame : Infinity
    if (video !== undefined && (picture < frames && picture / fps <= soundTime)) {
      const key = order[picture]! % gop === 0
      await video.add(new EncodedPacket(lengthPrefixed(key ? IDR : P_SLICE), key ? 'key' : 'delta', pictureTime, 1 / fps), picture === 0
        ? { decoderConfig: { codec: 'avc1.42c00a', codedWidth: options.width ?? 64, codedHeight: options.height ?? 64, description: avcC(SPS, options.otherConfig === true ? OTHER_PPS : PPS) } }
        : undefined)
      picture++
    } else if (audio !== undefined && sound !== undefined) {
      await audio.add(new EncodedPacket(SILENT_AAC, 'key', soundTime, audioFrame), soundIndex === 0
        ? { decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: sound.channels, sampleRate: sound.sampleRate, description: audioSpecificConfig(sound.sampleRate, sound.channels) } }
        : undefined)
      soundIndex++
    }
  }
  await output.finalize()
  return path
}

/**
 * A plain 16-bit PCM WAV of silence (a RIFF header and zeroed frames): what a
 * sound copy looks like when WAV can hold the sound as it is, so an extraction
 * can be copied losslessly instead of re-encoded.
 * @param path - the absolute path.
 * @param options - length, rate and channel count.
 * @returns the path.
 */
export async function writeWavFixture(path: string, options: { seconds?: number; sampleRate?: number; channels?: number } = {}): Promise<string> {
  const sampleRate = options.sampleRate ?? 48000
  const channels = options.channels ?? 2
  const frames = Math.round((options.seconds ?? 2) * sampleRate)
  const data = Buffer.alloc(frames * channels * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.concat([header, data]))
  return path
}
