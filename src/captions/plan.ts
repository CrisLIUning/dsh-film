/**
 * Planning a recognition and its application, ported from Studio's
 * `services/timeline-captions/plan.ts`: which clips' original sound a request
 * covers (trims, sequence offsets, speed and speed curves honoured; reverse
 * and remaps refused), and the one `caption.replace_ranges` command a
 * reviewed draft becomes. Codes and messages are Studio's.
 * @module dsh-film/captions/plan
 */

import { getNativeTimelineFfmpegMediaRequirements, getTimelineSourceTime } from '../../vendor/video-editor-bridge.mjs'
import type { JsonObject, VideoEditorCommandPlan } from '../../vendor/video-editor-bridge.mjs'
import { isTimelineArchive } from '../timeline/archive.js'
import { CANVAS_FILE_VERSION_PREFIX } from '../timeline/commands.js'
import { CAPTION_ENGINES } from './contracts.js'
import type { CaptionEngine, TimelineCaptionDraft, TimelineCaptionSource, TimelineTranscribeRequest } from './contracts.js'

/**
 * A refused or failed caption request. The message leads with the code, as
 * Studio's does, so a caller that only shows the text still names it.
 */
export class TimelineCaptionError extends Error {
  override name = 'TimelineCaptionError'

  /**
   * @param code - the stable code.
   * @param message - what went wrong, for the caller.
   * @param status - the HTTP status the routes answer with.
   * @param extra - extra members of the JSON answer (`modelIds`, `cause`...).
   */
  constructor(readonly code: string, message: string, readonly status = 400, readonly extra: Readonly<Record<string, unknown>> = {}) {
    super(`${code}: ${message}`)
  }
}

const fail = (code: string, text: string): never => {
  throw new TimelineCaptionError(code, text)
}

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(obj) : []

function positive(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fail('CAPTION_TIMING_INVALID', key)
  return value
}

/**
 * Check a transcribe body. `range` is copied as `{start, end}` so that extra
 * keys cannot enter the request's identity (Studio kept the raw object).
 * @param value - the JSON body.
 * @returns the request.
 */
export function parseTranscribeRequest(value: unknown): TimelineTranscribeRequest {
  const r = obj(value)
  if (!Number.isSafeInteger(r.baseRevision) || Number(r.baseRevision) < 0 || typeof r.requestId !== 'string' || r.requestId.trim() === '' || r.requestId.length > 160) {
    fail('CAPTION_REQUEST_INVALID', 'baseRevision and requestId are required')
  }
  if (r.clipIds !== undefined && (
    !Array.isArray(r.clipIds) || r.clipIds.length === 0 || r.clipIds.length > 64
    || r.clipIds.some(id => typeof id !== 'string' || id === '' || id.length > 200)
    || new Set(r.clipIds).size !== r.clipIds.length
  )) fail('CAPTION_REQUEST_INVALID', 'clipIds must be unique')
  let range: { start: number; end: number } | undefined
  if (r.range !== undefined) {
    const given = obj(r.range)
    if (typeof given.start !== 'number' || !Number.isFinite(given.start) || given.start < 0 || typeof given.end !== 'number' || !Number.isFinite(given.end) || given.end <= given.start) {
      fail('CAPTION_REQUEST_INVALID', 'range is in timeline seconds')
    }
    range = { start: given.start as number, end: given.end as number }
  }
  if (r.language !== undefined && (typeof r.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(r.language))) fail('CAPTION_REQUEST_INVALID', 'invalid language')
  if (r.engine !== undefined && !CAPTION_ENGINES.includes(r.engine as CaptionEngine)) fail('CAPTION_REQUEST_INVALID', 'engine must be whisper or gateway')
  if (r.spendingConfirmed !== undefined && typeof r.spendingConfirmed !== 'boolean') fail('CAPTION_REQUEST_INVALID', 'spendingConfirmed must be true or false')
  return {
    baseRevision: Number(r.baseRevision),
    requestId: String(r.requestId),
    ...(r.clipIds !== undefined ? { clipIds: [...r.clipIds as string[]] } : {}),
    ...(range !== undefined ? { range } : {}),
    ...(r.language !== undefined ? { language: String(r.language) } : {}),
    ...(r.engine !== undefined ? { engine: r.engine as CaptionEngine } : {}),
    ...(r.spendingConfirmed === true ? { spendingConfirmed: true } : {}),
  }
}

/**
 * The project path of a Studio raw-file URL of this project
 * (`canvas-timeline-commands.ts` `outputProjectPath`): a URL of another
 * project is never this file's provenance.
 * @param value - a clip's `sourceUrl`.
 * @param projectId - the film's project id.
 * @returns the project-relative path, or `null`.
 */
export function outputProjectPath(value: unknown, projectId: string): string | null {
  if (typeof value !== 'string') return null
  const match = /^(?:https?:\/\/[^/]+)?\/api\/projects\/([^/]+)\/raw\/(.+?)(?:[?#].*)?$/u.exec(value)
  if (match === null) return null
  try {
    if (decodeURIComponent(match[1]!) !== projectId) return null
    return match[2]!.split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
}

/** A planned recognition: its sources and the merged timeline ranges they cover. */
export interface TranscriptionPlan {
  sources: TimelineCaptionSource[]
  ranges: Array<{ start: number; end: number }>
}

/**
 * Which clips' original sound a request covers, by the same audibility rules
 * as the final render. By default the video clips' own sound; audio clips
 * only when named (separated original sound).
 * @param document - the saved cut.
 * @param request - the request.
 * @param projectId - the film's project id (for raw-file URLs).
 * @returns the plan.
 */
export function planTimelineTranscription(document: unknown, request: TimelineTranscribeRequest, projectId = ''): TranscriptionPlan {
  if (!isTimelineArchive(document)) fail('CAPTION_TIMELINE_MISSING', 'read the saved timeline first')
  const project = obj(obj(document).project)
  if (obj(project.trackLocks).caption === true) fail('CAPTION_TRACK_LOCKED', 'unlock the caption track first')
  const visuals = rows(project.visualSegments)
  const audios = rows(project.audioSegments)
  const requested = request.clipIds !== undefined ? new Set(request.clipIds) : undefined
  // Analysis-only effects carry no sound; Studio strips them before asking.
  const requirements = getNativeTimelineFfmpegMediaRequirements({
    ...project,
    visualSegments: visuals.map(clip => ({ ...clip, subjectEffect: undefined, cinematicDepth: undefined, photoParallax: undefined })),
  })
  if (requested !== undefined) {
    for (const id of requested) {
      if (![...visuals, ...audios, ...requirements.sourceAudio].some(clip => clip.id === id)) fail('CAPTION_CLIP_NOT_FOUND', id)
    }
  }
  const audibleAudio = new Set(requirements.audioSegments.map(clip => clip.id))
  const audible = new Set(requirements.sourceAudio.map(clip => clip.id))
  const sources: TimelineCaptionSource[] = []
  for (const [track, clips] of [['visual', requirements.sourceAudio], ['audio', audios]] as const) {
    for (const clip of clips) {
      const duration = positive(clip.duration, String(clip.id))
      const clipStart = Number(clip.start ?? 0)
      if (!Number.isFinite(clipStart) || clipStart < 0) fail('CAPTION_TIMING_INVALID', 'invalid clip offset')
      if (requested !== undefined && !requested.has(String(clip.id))) continue
      // Default is the original video sound. Explicit audio ids support separated original sound.
      if (track === 'audio' && requested === undefined) continue
      if (track === 'visual' ? !audible.has(clip.id) : !audibleAudio.has(clip.id)) continue
      if (Number(clip.volume ?? 1) === 0) continue
      const start = Math.max(clipStart, request.range?.start ?? 0)
      const end = Math.min(clipStart + duration, request.range?.end ?? Infinity)
      if (end <= start) continue
      if (clip.availableSourceDuration !== undefined && Number(clip.availableSourceDuration) < Number(clip.sourceDuration)) {
        fail('CAPTION_TIMING_INVALID', 'speed curve extends beyond the saved source audio')
      }
      if (clip.reverse === true || Boolean(clip.timeRemap) || Boolean(clip.vibedevTimeRemapRuntime)) {
        fail('CAPTION_TIME_REMAP_UNSUPPORTED', 'reverse/freeze remapping cannot yet produce reliable speech timestamps')
      }
      const version = String(clip.assetVersionId ?? '')
      const file = version.startsWith(CANVAS_FILE_VERSION_PREFIX)
        ? version.slice(CANVAS_FILE_VERSION_PREFIX.length)
        : String(obj(clip.integrity).archivePath ?? outputProjectPath(clip.sourceUrl, projectId) ?? '')
      if (file === '' || /^(?:[a-z]+:|\/)/i.test(file) || file.replaceAll('\\', '/').split('/').some(part => part === '' || part === '.' || part === '..')) {
        fail('CAPTION_SOURCE_NOT_PINNED', `pin the original source for ${String(clip.id)} in this project`)
      }
      const mapping = {
        clipStart,
        clip: {
          duration,
          sourceStart: Number(clip.sourceStart) || 0,
          sourceDuration: Number(clip.sourceDuration) || duration * (Number(clip.playbackRate) || 1),
          playbackRate: Number(clip.playbackRate) || 1,
          ...(clip.speedCurve ? { speedCurve: clip.speedCurve } : {}),
        },
      }
      const sourceIn = getTimelineSourceTime(mapping.clip, start - clipStart)
      const sourceOut = getTimelineSourceTime(mapping.clip, end - clipStart)
      if (!Number.isFinite(sourceIn) || sourceIn < 0 || !Number.isFinite(sourceOut) || sourceOut <= sourceIn) fail('CAPTION_TIMING_INVALID', 'invalid source range')
      sources.push({ clipId: String(clip.id), track, file, assetVersionId: version, start, end, sourceIn, sourceOut, mapping })
    }
  }
  if (sources.length === 0) fail('CAPTION_NO_AUDIBLE_SOURCE', 'selected range has no audible original source')
  if (sources.length > 64 || sources.reduce((total, source) => total + source.sourceOut - source.sourceIn, 0) > 3600) {
    fail('CAPTION_RANGE_TOO_LARGE', 'transcribe up to 64 clips / 60 source minutes per task')
  }
  const ranges: Array<{ start: number; end: number }> = []
  for (const source of [...sources].sort((left, right) => left.start - right.start)) {
    const last = ranges.at(-1)
    if (last !== undefined && source.start <= last.end) last.end = Math.max(last.end, source.end)
    else ranges.push({ start: source.start, end: source.end })
  }
  return { sources, ranges }
}

/**
 * The command a reviewed draft becomes: one `caption.replace_ranges`, whose
 * operation id makes a retry a no-op. Manual and reviewed captions inside the
 * ranges are protected by the engine.
 * @param draft - the task's draft.
 * @param taskId - the recognition task.
 * @param reviewed - the person checked the draft against the original sound.
 * @param excludeSegmentIds - lines left out.
 * @returns the command plan.
 */
export function captionApplyPlan(draft: TimelineCaptionDraft, taskId: string, reviewed: boolean, excludeSegmentIds: string[] = []): VideoEditorCommandPlan {
  if (!reviewed) fail('CAPTION_REVIEW_REQUIRED', 'check the ASR draft against original sound before applying; silence/music are not verified dialogue')
  const excluded = new Set(excludeSegmentIds)
  if (excluded.size !== excludeSegmentIds.length || [...excluded].some(id => !draft.segments.some(segment => segment.id === id))) {
    fail('CAPTION_SEGMENT_NOT_FOUND', 'exclude only segment IDs from this draft')
  }
  const accepted = draft.segments.filter(segment => !excluded.has(segment.id))
  if (accepted.length === 0) fail('CAPTION_NO_SPEECH', 'empty recognition must not erase existing captions')
  return {
    schemaVersion: 1,
    baseRevision: draft.baseRevision,
    operations: [{
      id: `caption-asr:${taskId}`,
      type: 'caption.replace_ranges',
      ranges: draft.ranges,
      sourceClipIds: draft.sources.map(source => source.clipId),
      segments: accepted.map(segment => ({
        ...segment,
        source: {
          kind: 'asr',
          taskId,
          clipId: segment.sourceClipId,
          sourceIn: segment.sourceIn,
          sourceOut: segment.sourceOut,
          media: draft.sources.find(source => source.clipId === segment.sourceClipId),
          reviewStatus: 'reviewed',
        },
        reviewStatus: 'reviewed',
      })),
    } as unknown as JsonObject & { id: string; type: string }],
  }
}
