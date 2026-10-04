/**
 * Turning what an engine heard into draft lines on the timeline, ported from
 * Studio's `mapCaptionRecognition` (`services/timeline-captions/service.ts`):
 * engine times are seconds from each source's `sourceIn`, mapped back through
 * the clip's speed curve and kept inside the stretch the clip plays.
 * @module dsh-film/captions/map
 */

import { getTimelineLocalTime } from '../../vendor/video-editor-bridge.mjs'
import type { CaptionRecognition, TimelineCaptionDraft, TimelineCaptionSource } from './contracts.js'
import { TimelineCaptionError } from './plan.js'

function sourceToTimeline(source: TimelineCaptionSource, second: number): number {
  return Math.max(source.start, Math.min(source.end, source.mapping.clipStart + getTimelineLocalTime(source.mapping.clip, second)))
}

/**
 * Map recognitions to draft lines, sorted by timeline start. Every source
 * must answer exactly once (an empty answer counts): a missing one means the
 * draft would silently skip speech.
 * @param results - one recognition per source.
 * @param sources - the plan's sources.
 * @param taskId - the recognition task (line ids are `asr:<taskId>:<n>`).
 * @returns the lines.
 */
export function mapCaptionRecognition(results: readonly CaptionRecognition[], sources: readonly TimelineCaptionSource[], taskId: string): TimelineCaptionDraft['segments'] {
  const segments: TimelineCaptionDraft['segments'] = []
  const seen = new Set<string>()
  for (const result of results) {
    const source = sources.find(candidate => candidate.clipId === result.sourceClipId)
    if (source === undefined || seen.has(result.sourceClipId)) throw new TimelineCaptionError('CAPTION_RESULT_INVALID', 'unrecognized or duplicate source')
    seen.add(result.sourceClipId)
    for (const line of result.segments) {
      if (
        typeof line.text !== 'string' || line.text.trim() === '' || line.text.length > 4000
        || !Number.isFinite(line.start) || !Number.isFinite(line.end) || line.start < 0 || line.end <= line.start
        || line.end > source.sourceOut - source.sourceIn + 0.1
      ) throw new TimelineCaptionError('CAPTION_RESULT_INVALID', 'invalid transcript or timestamps')
      const sourceIn = source.sourceIn + line.start
      const sourceOut = Math.min(source.sourceOut, source.sourceIn + line.end)
      const start = sourceToTimeline(source, sourceIn)
      const end = sourceToTimeline(source, sourceOut)
      if (end > start) {
        segments.push({
          id: `asr:${taskId}:${segments.length}`,
          text: line.text.trim(),
          ...(line.warnings !== undefined ? { warnings: line.warnings } : {}),
          start,
          end,
          sourceClipId: source.clipId,
          sourceIn,
          sourceOut,
        })
      }
    }
  }
  if (seen.size !== sources.length) throw new TimelineCaptionError('CAPTION_NO_SPEECH', 'no complete usable speech draft; no captions were changed', 422)
  return segments.sort((left, right) => left.start - right.start)
}
