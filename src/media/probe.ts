/**
 * What a media file is, read from the file itself: length, picture size and
 * whether it carries sound.
 * mediabunny (MPL-2.0) reads the container in-process, so the Host half needs
 * no ffmpeg on the machine. A file it cannot read gives no facts, not an error.
 * @module dsh-film/media/probe
 */

import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny'

export interface MediaFacts {
  /** Seconds, when the file has a length. */
  durationSeconds?: number
  /** Display size of the first picture track. */
  width?: number
  height?: number
  /** Whether the file has a sound track (a rendered clip's own sound joins the mix only then). */
  hasAudio?: boolean
}

/**
 * Read a video or audio file's length, picture size and whether it has sound.
 * @param path - the absolute file path.
 * @returns what could be read.
 */
export async function probeMedia(path: string): Promise<MediaFacts> {
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS })
  try {
    const [duration, video, audio] = await Promise.all([input.computeDuration(), input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
    return {
      ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
      ...(video !== null && video.displayWidth > 0 && video.displayHeight > 0 ? { width: video.displayWidth, height: video.displayHeight } : {}),
      hasAudio: audio !== null,
    }
  } catch {
    return {}
  } finally {
    input.dispose()
  }
}

/**
 * Whether a file carries a sound track, read without ffprobe (Studio asks
 * ffprobe; the Host need not have it).
 * @param path - the absolute file path.
 * @returns the answer, or `undefined` when the file could not be read.
 */
export async function probeHasAudio(path: string): Promise<boolean | undefined> {
  return (await probeMedia(path)).hasAudio
}
