/** Clip marks and split siblings — the page's rules (canvas clip-marks / derived-media) for the agent's cutting tools. */

import { describe, expect, it } from 'vitest'
import { mediaFacts, readClip, siblingMetadata, splitClip, storedClip } from '../src/canvas/clip-marks.js'
import { siblingCues } from '../src/canvas/media-time.js'

const cues = [
  { id: 'a', startMs: 0, endMs: 900, text: '开场' },
  { id: 'b', startMs: 1500, endMs: 2600, text: '跨过入点' },
  { id: 'c', startMs: 3000, endMs: 3500, text: '片段中间' },
  { id: 'd', startMs: 4900, endMs: 6000, text: '跨过出点' },
]

const sequence = {
  directorNodeId: 'director',
  renderId: 'render-1',
  shots: [
    { shotId: 's1', cameraId: 'c1', sourceIn: 10, sourceOut: 12, start: 0, end: 2 },
    { shotId: 's2', cameraId: 'c2', sourceIn: 20, sourceOut: 23, start: 2, end: 5 },
  ],
}

describe('clip marks', () => {
  it('reads a mark as whole ms inside the file, and null or anything malformed as none', () => {
    expect(readClip({ clip: { inMs: 500.4, outMs: 2000.6 } })).toEqual({ inMs: 500, outMs: 2001 })
    expect(readClip({ clip: { inMs: 500, outMs: 9000 }, durationMs: 3000 })).toEqual({ inMs: 500, outMs: 3000 })
    expect(readClip({ clip: { inMs: 500, outMs: 9000 } }, 3000)).toEqual({ inMs: 500, outMs: 3000 })
    for (const clip of [null, undefined, 'x', [], { inMs: -1, outMs: 500 }, { inMs: 0, outMs: 99 }, { inMs: 'a', outMs: 500 }, { inMs: 3000, outMs: 4000 }]) {
      expect(readClip({ clip, durationMs: 3000 }), JSON.stringify(clip)).toBeUndefined()
    }
  })

  it('stores a mark covering the whole file, or shorter than 100 ms, as null', () => {
    expect(storedClip({ inMs: 0, outMs: 3000 }, 3000)).toBeNull()
    expect(storedClip({ inMs: 0, outMs: 3500 }, 3000)).toBeNull()
    expect(storedClip({ inMs: 2950, outMs: 3500 }, 3000)).toBeNull()
    expect(storedClip({ inMs: 0, outMs: 2000 }, 3000)).toEqual({ inMs: 0, outMs: 2000 })
    expect(storedClip({ inMs: 1000.4, outMs: 3000 }, 3000)).toEqual({ inMs: 1000, outMs: 3000 })
  })

  it('splits only 100 ms or more inside the range', () => {
    expect(splitClip({ inMs: 1000, outMs: 4000 }, 2500)).toEqual([{ inMs: 1000, outMs: 2500 }, { inMs: 2500, outMs: 4000 }])
    expect(splitClip({ inMs: 1000, outMs: 4000 }, 1100)).toEqual([{ inMs: 1000, outMs: 1100 }, { inMs: 1100, outMs: 4000 }])
    expect(splitClip({ inMs: 1000, outMs: 4000 }, 1099)).toBeNull()
    expect(splitClip({ inMs: 1000, outMs: 4000 }, 3901)).toBeNull()
    expect(splitClip({ inMs: 1000, outMs: 4000 }, Number.NaN)).toBeNull()
  })

  it('gives a sibling the media facts and the overlapping cues and shots, never the generation task', () => {
    const metadata = {
      content: '/api/projects/p/raw/canvas/media/shot.mp4', storageKey: '', mimeType: 'video/mp4', bytes: 10, durationMs: 5000, prompt: '海边',
      videoTaskId: 'task-1', videoAttempt: { attemptId: 'a' }, videoGenerationInput: { model: 'm' }, gatewayReceipt: { taskId: 'g' }, status: 'success',
      subtitleEntries: cues, directorSequence: sequence,
    }
    expect(mediaFacts(metadata)).toEqual({ status: 'success', content: metadata.content, mimeType: 'video/mp4', bytes: 10, durationMs: 5000, prompt: '海边' })
    const sibling = siblingMetadata(metadata, { inMs: 2500, outMs: 5000 })
    expect(sibling).toMatchObject({ content: metadata.content, clip: { inMs: 2500, outMs: 5000 }, prompt: '海边' })
    expect(sibling.subtitleEntries).toEqual(siblingCues(cues, { inMs: 2500, outMs: 5000 }))
    expect((sibling.subtitleEntries as Array<{ id: string }>).map(cue => cue.id)).toEqual(['b', 'c', 'd'])
    expect((sibling.directorSequence as typeof sequence).shots.map(shot => shot.shotId)).toEqual(['s2'])
    for (const key of ['videoTaskId', 'videoAttempt', 'videoGenerationInput', 'gatewayReceipt', 'storageKey']) expect(sibling[key], key).toBeUndefined()
    // Nothing overlapping, or cleared (null): no empty lists.
    const bare = siblingMetadata({ ...metadata, subtitleEntries: null, directorSequence: null }, { inMs: 0, outMs: 100 })
    expect(bare).not.toHaveProperty('subtitleEntries')
    expect(bare).not.toHaveProperty('directorSequence')
  })

  it('gives a sibling the cues\' style, save time and media key, since it shows the same file', () => {
    const metadata = {
      content: '/api/projects/p/raw/canvas/media/shot.mp4', bytes: 10, durationMs: 5000,
      subtitleEntries: [...cues, { startMs: 3600, endMs: 3900, text: '  无 id  ' }], subtitleStyle: { v: 1, position: 'top', color: '#abc' },
      subtitleUpdatedAt: '2026-10-01T00:00:00.000Z', subtitleMediaKey: '/api/projects/p/raw/canvas/media/shot.mp4|10|5000',
    }
    const sibling = siblingMetadata(metadata, { inMs: 2500, outMs: 5000 })
    expect(sibling).toMatchObject({
      subtitleStyle: { v: 1, fontScale: 5, color: '#AABBCC', position: 'top', backdrop: 'shadow', maxCharsPerEntry: 35, autoResegment: true },
      subtitleUpdatedAt: metadata.subtitleUpdatedAt, subtitleMediaKey: metadata.subtitleMediaKey,
    })
    // Cleaned as the page reads them: a cue without an id gets the page's derived one.
    expect((sibling.subtitleEntries as Array<{ id: string; text: string }>).map(cue => cue.text)).toEqual(['跨过入点', '片段中间', '无 id', '跨过出点'])
    expect((sibling.subtitleEntries as Array<{ id: string }>)[2]!.id).toMatch(/^[A-Za-z0-9_-]{10}$/u)
    // Cues saved without a style or key (a split from before 0.3) stay without one.
    const plain = siblingMetadata({ ...metadata, subtitleStyle: undefined, subtitleUpdatedAt: undefined, subtitleMediaKey: undefined }, { inMs: 2500, outMs: 5000 })
    expect(Object.keys(plain).filter(key => key.startsWith('subtitle'))).toEqual(['subtitleEntries'])
  })
})
