/**
 * Clip marks on the board's video and audio nodes (C1): `metadata.clip =
 * { inMs, outMs }` marks the part of the node's file the node stands for —
 * whole milliseconds, 0 <= inMs < outMs <= the file's length, at least 100 ms
 * long — without touching the file; `null` means cleared (amendments C.8: an
 * agent's `update_node` cannot delete a key, so every reader treats `null` as
 * no mark). A split keeps the first part on the node and gives the rest to a
 * sibling on the same file. These are the storyboard page's rules (canvas
 * `web/src/lib/canvas/clip-marks.ts` and `derived-media.ts`, VibeDev's own)
 * for the agent's tools, so a mark or a split made here reads the same there.
 * @module dsh-film/canvas/clip-marks
 */

import { siblingCues, siblingShots } from './media-time.js'

/** The shortest clip, and the closest a split may come to either edge. */
export const MIN_CLIP_MS = 100

export interface ClipMark {
  inMs: number
  outMs: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * A node's clip mark, sanitized: whole milliseconds, 0 <= in < out <= length
 * (when the length is known), at least {@link MIN_CLIP_MS} long. `null` (the
 * agent's "cleared") and anything malformed read as no mark.
 * @param metadata - the node's metadata.
 * @param durationMs - the file's length; the node's recorded `durationMs` when omitted.
 * @returns the mark, or `undefined`.
 */
export function readClip(metadata: Record<string, unknown> | undefined, durationMs: unknown = metadata?.durationMs): ClipMark | undefined {
  const clip = metadata?.clip
  if (!isRecord(clip)) return undefined
  const inMs = Math.round(Number(clip.inMs))
  let outMs = Math.round(Number(clip.outMs))
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || inMs < 0) return undefined
  if (positive(durationMs)) {
    if (inMs >= durationMs) return undefined
    outMs = Math.min(outMs, Math.round(durationMs))
  }
  if (outMs - inMs < MIN_CLIP_MS) return undefined
  return { inMs, outMs }
}

/**
 * A mark as it is stored: whole milliseconds inside the file, or `null`
 * (cleared) when it covers the whole file or is shorter than {@link MIN_CLIP_MS}.
 * @param clip - the mark.
 * @param durationMs - the file's length.
 * @returns the stored value.
 */
export function storedClip(clip: ClipMark, durationMs: number): ClipMark | null {
  const inMs = Math.max(0, Math.round(clip.inMs))
  const outMs = Math.min(Math.round(durationMs), Math.round(clip.outMs))
  if (outMs - inMs < MIN_CLIP_MS) return null
  return inMs <= 0 && outMs >= durationMs ? null : { inMs, outMs }
}

/**
 * The two parts a split at `atMs` makes: [in, at] stays on the node, [at, out]
 * goes to a sibling; `null` when either part would be shorter than {@link MIN_CLIP_MS}.
 * @param range - the part of the file the node plays (its mark, else the whole file).
 * @param atMs - where to split, in ms of the file.
 * @returns the parts.
 */
export function splitClip(range: ClipMark, atMs: number): [ClipMark, ClipMark] | null {
  if (!Number.isFinite(atMs) || atMs < range.inMs + MIN_CLIP_MS || atMs > range.outMs - MIN_CLIP_MS) return null
  const at = Math.round(atMs)
  return [{ inMs: range.inMs, outMs: at }, { inMs: at, outMs: range.outMs }]
}

/** The media facts a node on the same file keeps (never a generation task's fields). */
const MEDIA_FACTS = ['content', 'storageKey', 'mimeType', 'bytes', 'naturalWidth', 'naturalHeight', 'durationMs', 'frameCount', 'frameRate', 'prompt'] as const

/**
 * What a node on the same file as `metadata` starts with: its media facts and
 * `status: 'success'`, and none of the source's generation-task fields (C1:
 * no videoAttempt, videoGenerationInput, videoTaskId or gatewayReceipt).
 * @param metadata - the source node's metadata.
 * @returns the facts.
 */
export function mediaFacts(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const facts: Record<string, unknown> = { status: 'success' }
  for (const key of MEDIA_FACTS) {
    const value = metadata?.[key]
    if (value !== undefined && value !== null && value !== '') facts[key] = value
  }
  return facts
}

/**
 * A split sibling's metadata: the same file with its own mark, and the cues
 * and director shots that overlap it (still in the file's time).
 * @param metadata - the source node's metadata (with its file's length).
 * @param clip - the sibling's mark.
 * @returns the metadata.
 */
export function siblingMetadata(metadata: Record<string, unknown> | undefined, clip: ClipMark): Record<string, unknown> {
  const cues = siblingCues(metadata?.subtitleEntries, clip)
  const shots = siblingShots(metadata?.directorSequence, clip)
  return {
    ...mediaFacts(metadata),
    clip,
    ...(cues.length > 0 ? { subtitleEntries: cues } : {}),
    ...(shots !== undefined ? { directorSequence: shots } : {}),
  }
}
