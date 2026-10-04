/** Moving cues and director shots with a split, a cut or a join — the page's rules (canvas media-time-remap). */

import { describe, expect, it } from 'vitest'
import { cutCues, cutShots, joinCues, joinShots, siblingCues, siblingShots } from '../src/canvas/media-time.js'

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

describe('cues', () => {
  it('keeps a split sibling\'s overlapping cues unchanged (still source time)', () => {
    expect(siblingCues(cues, { inMs: 2000, outMs: 5000 })).toEqual([cues[1], cues[2], cues[3]])
  })

  it('shifts a rendered cut\'s cues by its in point, and drops what keeps less than 100 ms', () => {
    expect(cutCues(cues, { inMs: 2000, outMs: 5000 })).toEqual([
      { id: 'b', startMs: 0, endMs: 600, text: '跨过入点' },
      { id: 'c', startMs: 1000, endMs: 1500, text: '片段中间' },
      { id: 'd', startMs: 2900, endMs: 3000, text: '跨过出点' },
    ])
    expect(cutCues([{ id: 'd', startMs: 4950, endMs: 6000 }], { inMs: 2000, outMs: 5000 })).toEqual([])
    expect(cutCues([{ startMs: 2500, endMs: 3000 }], { inMs: 2000, outMs: 5000, atMs: 400 })).toEqual([{ startMs: 900, endMs: 1400 }])
  })

  it('ignores malformed cues, and null (cleared) as none', () => {
    expect(cutCues([{ startMs: 5, endMs: 5 }, { startMs: Number.NaN, endMs: 9 }, 'x', null], { inMs: 0, outMs: 100 })).toEqual([])
    expect(cutCues(null, { inMs: 0, outMs: 100 })).toEqual([])
    expect(siblingCues({ not: 'a list' }, { inMs: 0, outMs: 100 })).toEqual([])
  })

  it('places each joined segment\'s cues after the segments before it, or at the Host\'s atMs', () => {
    const first = [{ id: 'x', startMs: 500, endMs: 1500 }]
    const second = [{ id: 'y', startMs: 2000, endMs: 2500 }]
    expect(joinCues([{ items: first, inMs: 1000, outMs: 3000 }, { items: second, inMs: 1800, outMs: 2800 }])).toEqual([
      { id: 'x', startMs: 0, endMs: 500 },
      { id: 'y', startMs: 2200, endMs: 2700 },
    ])
    expect(joinCues([{ items: first, inMs: 1000, outMs: 3000, atMs: 0 }, { items: second, inMs: 1800, outMs: 2800, atMs: 2040 }])[1]).toEqual({ id: 'y', startMs: 2240, endMs: 2740 })
    const repeated = [{ id: 'z', startMs: 0, endMs: 800 }]
    expect(joinCues([{ items: repeated, inMs: 0, outMs: 1000 }, { items: repeated, inMs: 0, outMs: 1000 }]).map(cue => cue.id)).toEqual(['z', 'z-2'])
  })
})

describe('director shots', () => {
  it('clamps shots to a cut and moves their source times by the same amounts', () => {
    const cut = cutShots(sequence, { inMs: 1500, outMs: 4000 })
    expect(cut?.shots).toEqual([
      { shotId: 's1', cameraId: 'c1', sourceIn: 11.5, sourceOut: 12, start: 0, end: 0.5 },
      { shotId: 's2', cameraId: 'c2', sourceIn: 20, sourceOut: 22, start: 0.5, end: 2.5 },
    ])
    expect(cut?.renderId).toBe('render-1')
  })

  it('keeps the sibling\'s overlapping shots unchanged and drops a sequence with none left', () => {
    expect(siblingShots(sequence, { inMs: 2500, outMs: 5000 })?.shots.map(shot => shot.shotId)).toEqual(['s2'])
    expect(cutShots(sequence, { inMs: 5000, outMs: 6000 })).toBeUndefined()
    expect(cutShots(null, { inMs: 0, outMs: 1000 })).toBeUndefined()
    expect(cutShots({ shots: [{ start: 0, end: 1 }] }, { inMs: 0, outMs: 1000 })).toBeUndefined()
  })

  it('joins every segment\'s shots and keeps the render identity only when all came from one render', () => {
    const joined = joinShots([{ sequence, inMs: 0, outMs: 2000 }, { sequence, inMs: 2000, outMs: 5000 }])
    expect(joined?.shots.map(shot => [shot.shotId, shot.start, shot.end])).toEqual([['s1', 0, 2], ['s2', 2, 5]])
    expect(joined?.renderId).toBe('render-1')
    const other = { ...sequence, renderId: 'render-2' }
    expect(joinShots([{ sequence, inMs: 0, outMs: 2000 }, { sequence: other, inMs: 0, outMs: 2000 }])?.renderId).toBeUndefined()
    expect(joinShots([{ inMs: 0, outMs: 2000 }])).toBeUndefined()
  })
})
