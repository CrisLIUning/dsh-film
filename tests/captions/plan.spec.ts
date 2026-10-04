/** Planning a recognition and its application (Studio's `tests/captions/plan.test.ts`, plus the request checks). */

import { describe, expect, it } from 'vitest'
import { captionApplyPlan, outputProjectPath, parseTranscribeRequest, planTimelineTranscription } from '../../src/captions/plan.js'
import type { TimelineCaptionDraft } from '../../src/captions/contracts.js'

const document = {
  format: 'timeline-studio-archive',
  version: 3,
  project: {
    visualSegments: [
      { id: 'a', type: 'video', duration: 4, sourceStart: 2, sourceDuration: 8, playbackRate: 2, assetVersionId: 'canvas-file:a.mp4' } as Record<string, unknown>,
      { id: 'b', type: 'video', duration: 3, assetVersionId: 'canvas-file:b.mp4' } as Record<string, unknown>,
    ],
    audioSegments: [] as Record<string, unknown>[],
    captionSegments: [{ id: 'keep', text: 'outside', start: 0, end: 1 }],
  } as Record<string, unknown>,
  media: {},
}

describe('native transcription source plan', () => {
  it('intersects source trims, speed and sequence offset without touching the cut', () => {
    const before = JSON.stringify(document)
    const plan = planTimelineTranscription(document, { baseRevision: 7, requestId: 'r', range: { start: 1, end: 6 } })
    expect(plan.sources.map(source => [source.clipId, source.start, source.end, source.sourceIn, source.sourceOut])).toEqual([
      ['a', 1, 4, 4, 10],
      ['b', 4, 6, 0, 2],
    ])
    expect(plan.ranges).toEqual([{ start: 1, end: 6 }])
    expect(JSON.stringify(document)).toBe(before)
  })

  it('refuses foreign/missing/muted sources rather than transcribing other clips', () => {
    expect(() => planTimelineTranscription(document, { baseRevision: 7, requestId: 'r', clipIds: ['missing'] })).toThrow(/CLIP_NOT_FOUND/)
    const muted = structuredClone(document)
    Object.assign((muted.project.visualSegments as Record<string, unknown>[])[0]!, { muted: true })
    expect(() => planTimelineTranscription(muted, { baseRevision: 7, requestId: 'r', clipIds: ['a'] })).toThrow(/NO_AUDIBLE_SOURCE/)
  })

  it('does not apply empty or unreviewed output', () => {
    const plan = planTimelineTranscription(document, { baseRevision: 7, requestId: 'r' })
    const draft: TimelineCaptionDraft = {
      schemaVersion: 1, kind: 'timeline-caption-draft', baseRevision: 7, sources: plan.sources, ranges: plan.ranges,
      segments: [], reviewStatus: 'unreviewed', model: 'whisper-small-q8', engine: 'whisper',
    }
    expect(() => captionApplyPlan(draft, 'task', false)).toThrow(/CAPTION_REVIEW_REQUIRED/)
    expect(() => captionApplyPlan(draft, 'task', true)).toThrow(/CAPTION_NO_SPEECH/)
  })

  it('uses the persisted processed source lane, including merged offsets, rather than old video audio', () => {
    const processed = structuredClone(document)
    Object.assign(processed.project, {
      sourceAudioSource: { assetVersionId: 'canvas-file:merged.wav', assetId: 'canvas-file:merged.wav', sourceUrl: '/api/projects/p/raw/merged.wav' },
      sourceAudioDuration: 40,
      sourceAudioVolume: 1,
      sourceAudioLinked: true,
    })
    const visuals = processed.project.visualSegments as Record<string, unknown>[]
    Object.assign(visuals[0]!, { sourceAudioOffset: 12 })
    Object.assign(visuals[1]!, { sourceAudioOffset: 25 })
    const plan = planTimelineTranscription(processed, { baseRevision: 1, requestId: 'processed' }, 'p')
    expect(plan.sources.map(source => [source.file, source.sourceIn, source.sourceOut])).toEqual([
      ['merged.wav', 14, 22],
      ['merged.wav', 25, 28],
    ])
    Object.assign(processed.project, { sourceAudioVolume: 0 })
    expect(() => planTimelineTranscription(processed, { baseRevision: 1, requestId: 'silent' }, 'p')).toThrow(/NO_AUDIBLE_SOURCE/)
  })

  it('takes named audio clips only when asked, and refuses remaps, locks and unpinned sources', () => {
    const withAudio = structuredClone(document)
    withAudio.project.audioSegments = [{ id: 'voice', start: 2, duration: 3, sourceUrl: '/api/projects/p/raw/voice%20take.wav' }]
    expect(planTimelineTranscription(withAudio, { baseRevision: 1, requestId: 'r' }, 'p').sources.map(source => source.clipId)).toEqual(['a', 'b'])
    const voice = planTimelineTranscription(withAudio, { baseRevision: 1, requestId: 'r', clipIds: ['voice'] }, 'p')
    expect(voice.sources).toMatchObject([{ clipId: 'voice', track: 'audio', file: 'voice take.wav', start: 2, end: 5, sourceIn: 0, sourceOut: 3 }])
    // A raw URL of another project is not this file's provenance.
    expect(() => planTimelineTranscription(withAudio, { baseRevision: 1, requestId: 'r', clipIds: ['voice'] }, 'other')).toThrow(/CAPTION_SOURCE_NOT_PINNED/)
    const reversed = structuredClone(document)
    Object.assign((reversed.project.visualSegments as Record<string, unknown>[])[1]!, { reverse: true })
    expect(() => planTimelineTranscription(reversed, { baseRevision: 1, requestId: 'r' })).toThrow(/CAPTION_TIME_REMAP_UNSUPPORTED/)
    const locked = structuredClone(document)
    locked.project.trackLocks = { caption: true }
    expect(() => planTimelineTranscription(locked, { baseRevision: 1, requestId: 'r' })).toThrow(/CAPTION_TRACK_LOCKED/)
    expect(() => planTimelineTranscription({ project: {} }, { baseRevision: 1, requestId: 'r' })).toThrow(/CAPTION_TIMELINE_MISSING/)
  })

  it('builds one caption.replace_ranges with reviewed, sourced lines and honours exclusions', () => {
    const plan = planTimelineTranscription(document, { baseRevision: 3, requestId: 'r' })
    const draft: TimelineCaptionDraft = {
      schemaVersion: 1, kind: 'timeline-caption-draft', baseRevision: 3, sources: plan.sources, ranges: plan.ranges, reviewStatus: 'unreviewed', model: 'm', engine: 'whisper',
      segments: [
        { id: 's0', text: 'one', start: 0.5, end: 1, sourceClipId: 'a', sourceIn: 3, sourceOut: 4 },
        { id: 's1', text: 'two', start: 4.5, end: 5, sourceClipId: 'b', sourceIn: 0.5, sourceOut: 1 },
      ],
    }
    expect(() => captionApplyPlan(draft, 't', true, ['nope'])).toThrow(/CAPTION_SEGMENT_NOT_FOUND/)
    expect(() => captionApplyPlan(draft, 't', true, ['s0', 's0'])).toThrow(/CAPTION_SEGMENT_NOT_FOUND/)
    const applied = captionApplyPlan(draft, 't', true, ['s1'])
    expect(applied).toMatchObject({ schemaVersion: 1, baseRevision: 3, operations: [{ id: 'caption-asr:t', type: 'caption.replace_ranges', ranges: plan.ranges, sourceClipIds: ['a', 'b'] }] })
    const segments = (applied.operations[0] as unknown as { segments: Array<Record<string, unknown>> }).segments
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ id: 's0', reviewStatus: 'reviewed', source: { kind: 'asr', taskId: 't', clipId: 'a', sourceIn: 3, sourceOut: 4, reviewStatus: 'reviewed', media: { clipId: 'a' } } })
  })
})

describe('parseTranscribeRequest', () => {
  it('keeps Studio\'s checks and normalises the range', () => {
    expect(parseTranscribeRequest({ baseRevision: 2, requestId: 'r', range: { start: 1, end: 2, extra: true }, language: 'zh-CN', engine: 'whisper' }))
      .toEqual({ baseRevision: 2, requestId: 'r', range: { start: 1, end: 2 }, language: 'zh-CN' })
    expect(parseTranscribeRequest({ baseRevision: 0, requestId: 'r' })).toEqual({ baseRevision: 0, requestId: 'r' })
    for (const body of [
      {}, { baseRevision: -1, requestId: 'r' }, { baseRevision: 1.5, requestId: 'r' }, { baseRevision: 1, requestId: ' ' }, { baseRevision: 1, requestId: 'x'.repeat(161) },
      { baseRevision: 1, requestId: 'r', clipIds: [] }, { baseRevision: 1, requestId: 'r', clipIds: ['a', 'a'] },
      { baseRevision: 1, requestId: 'r', range: { start: 2, end: 2 } }, { baseRevision: 1, requestId: 'r', language: 'Chinese' },
      { baseRevision: 1, requestId: 'r', engine: 'sensevoice' },
    ]) {
      expect(() => parseTranscribeRequest(body)).toThrow(/CAPTION_REQUEST_INVALID/)
    }
  })

  it('refuses a request for the gateway\'s transcription, whatever else it says', () => {
    const refusal = (body: unknown): unknown => {
      try {
        parseTranscribeRequest(body)
      } catch (error) {
        return error
      }
      return undefined
    }
    for (const body of [{ baseRevision: 1, requestId: 'r', engine: 'gateway' }, { engine: 'gateway' }]) {
      expect(refusal(body)).toMatchObject({ code: 'CAPTION_ENGINE_UNSUPPORTED', status: 400, message: 'CAPTION_ENGINE_UNSUPPORTED: 网关转写不再提供字幕识别；字幕用本机 Whisper 识别。' })
    }
  })

  it('reads raw-file URLs of this project only', () => {
    expect(outputProjectPath('/api/projects/p/raw/canvas/media/a%20b.mp4?x=1', 'p')).toBe('canvas/media/a b.mp4')
    expect(outputProjectPath('http://h:1/api/projects/p/raw/x.wav', 'p')).toBe('x.wav')
    expect(outputProjectPath('/api/projects/q/raw/x.wav', 'p')).toBeNull()
    expect(outputProjectPath(3, 'p')).toBeNull()
  })
})
