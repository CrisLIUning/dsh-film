/**
 * Subtitles on video nodes — the page's rules (canvas lib/subtitles) for the
 * agent's subtitle tools and the Host's cuts and joins: the cue sanitizer,
 * the style, the media key and its tolerant mismatch rule, clip time, the
 * SubRip/WebVTT reader and writer, 自动断句, and what derived nodes carry.
 */

import { describe, expect, it } from 'vitest'
import { CUE_LENGTH_RANGE, SHORTEST_PIECE_MS, STANDARD_CUE_LENGTH, resegmentEntries, splitCue } from '../src/canvas/subtitle-resegment.js'
import { formatSrtTimestamp, looksLikeTimedSubtitles, parseSubtitleText, parseTimestamp, serializeSrt } from '../src/canvas/subtitle-srt.js'
import {
  DEFAULT_SUBTITLE_STYLE, MAX_SUBTITLE_ENTRIES, MAX_SUBTITLE_TEXT, cuesFromClipTime, cuesInClipTime, derivedSubtitleFields, joinedSubtitleFields, newSubtitleId,
  readSubtitleEntries, readSubtitleStyle, sanitizeSubtitleEntries, sanitizeSubtitleStyle, subtitleDigest, subtitleMediaChanged, subtitleMediaKeyOf,
} from '../src/canvas/subtitles.js'
import type { SubtitleEntry } from '../src/canvas/subtitles.js'

const cue = (id: string, startMs: number, endMs: number, text = id): SubtitleEntry => ({ id, startMs, endMs, text })

const ID = /^[A-Za-z0-9_-]{10}$/u

describe('sanitizeSubtitleEntries', () => {
  it('keeps well-formed cues sorted by start, and reads null or a non-list as none', () => {
    const report = sanitizeSubtitleEntries([cue('b', 3000, 4000), cue('a', 1000, 2000)])
    expect(report.entries.map(entry => entry.id)).toEqual(['a', 'b'])
    expect(report).toMatchObject({ dropped: 0, truncated: 0, overLimit: 0 })
    expect(sanitizeSubtitleEntries(null).entries).toEqual([])
    expect(sanitizeSubtitleEntries({ not: 'a list' }).entries).toEqual([])
  })

  it('drops and counts what is no cue, never throwing', () => {
    const report = sanitizeSubtitleEntries([
      null, 'text',
      { id: 'x', startMs: '1000', endMs: 2000, text: 'string time' },
      { id: 'y', startMs: 2000, endMs: 2000, text: 'zero length' },
      { id: 'z', startMs: 5000, endMs: 4000, text: 'reversed' },
      { id: 'w', startMs: 0, endMs: 900, text: '   ' },
      { id: 'v', startMs: 0, endMs: 900, text: 42 },
      { id: 'u', startMs: Number.NaN, endMs: 900, text: 'nan' },
      cue('ok', 100, 200),
    ])
    expect(report.entries.map(entry => entry.id)).toEqual(['ok'])
    expect(report.dropped).toBe(8)
  })

  it('rounds times, moves a negative start to 0 and normalizes the text', () => {
    expect(sanitizeSubtitleEntries([{ id: 'n', startMs: -40.4, endMs: 999.6, text: '  上\r\n下  ' }]).entries).toEqual([{ id: 'n', startMs: 0, endMs: 1000, text: '上\n下' }])
  })

  it('cuts text to 2000 characters (never inside a surrogate pair) and keeps at most 5000 cues', () => {
    const long = sanitizeSubtitleEntries([cue('long', 0, 1000, '字'.repeat(MAX_SUBTITLE_TEXT + 5))])
    expect(long.entries[0]!.text).toHaveLength(MAX_SUBTITLE_TEXT)
    expect(long.truncated).toBe(1)
    expect(sanitizeSubtitleEntries([cue('emoji', 0, 1000, `${'字'.repeat(MAX_SUBTITLE_TEXT - 1)}😀`)]).entries[0]!.text).toBe('字'.repeat(MAX_SUBTITLE_TEXT - 1))
    const many = Array.from({ length: MAX_SUBTITLE_ENTRIES + 3 }, (_, index) => cue(`c${index}`, index * 10, index * 10 + 5))
    const report = sanitizeSubtitleEntries(many)
    expect(report.entries).toHaveLength(MAX_SUBTITLE_ENTRIES)
    expect(report.overLimit).toBe(3)
    expect(report.entries.at(-1)!.id).toBe(`c${MAX_SUBTITLE_ENTRIES - 1}`)
  })

  it('keeps ids stable: valid ones as they are, the same derived id for a missing or broken one, a suffix for a duplicate', () => {
    const raw = [{ startMs: 0, endMs: 500, text: '没有 id' }, { id: 'has spaces!', startMs: 600, endMs: 900, text: '坏 id' }, cue('dup', 1000, 1500), cue('dup', 2000, 2500)]
    const first = sanitizeSubtitleEntries(raw).entries
    expect(first.map(entry => entry.id)).toEqual(sanitizeSubtitleEntries(raw).entries.map(entry => entry.id))
    expect(first[0]!.id).toMatch(ID)
    expect(first[1]!.id).toMatch(ID)
    expect(first[0]!.id).not.toBe(first[1]!.id)
    expect(first.slice(2).map(entry => entry.id)).toEqual(['dup', 'dup-2'])
    expect(newSubtitleId()).toMatch(ID)
    expect(newSubtitleId()).not.toBe(newSubtitleId())
  })

  it('keeps a highlight only inside its text, and reads Open AI Canvas\'s highlights kept beside the cues', () => {
    const { entries } = sanitizeSubtitleEntries([
      { ...cue('h1', 0, 1000, '重点在这里'), highlight: { start: 0, end: 2 } },
      { ...cue('h2', 1000, 2000, '太短'), highlight: { start: 1, end: 9 } },
    ])
    expect(entries.map(entry => entry.highlight)).toEqual([{ start: 0, end: 2 }, undefined])
    const legacy = { subtitleEntries: [{ index: 1, startMs: 0, endMs: 1200, text: '第一句。后面' }], subtitleHighlights: [{ entryIndex: 1, start: 0, end: 4, highlightText: '第一句。' }] }
    expect(readSubtitleEntries(legacy)[0]).toMatchObject({ text: '第一句。后面', highlight: { start: 0, end: 4 } })
    expect(readSubtitleEntries({ subtitleEntries: null })).toEqual([])
  })
})

describe('subtitle style', () => {
  it('fills the defaults (5% white, bottom, shadow, 35 characters, auto-split)', () => {
    expect(sanitizeSubtitleStyle(undefined)).toEqual({ v: 1, fontScale: 5, color: '#FFFFFF', position: 'bottom', backdrop: 'shadow', maxCharsPerEntry: 35, autoResegment: true })
    expect(readSubtitleStyle({ subtitleStyle: null })).toEqual(DEFAULT_SUBTITLE_STYLE)
  })

  it('clamps the size and the per-cue limit, normalizes the colour and ignores unknown values', () => {
    expect(sanitizeSubtitleStyle({ fontScale: 40, color: '#abc', position: 'left', backdrop: 'box', maxCharsPerEntry: 5, autoResegment: false }))
      .toEqual({ v: 1, fontScale: 12, color: '#AABBCC', position: 'bottom', backdrop: 'box', maxCharsPerEntry: 20, autoResegment: false })
    expect(sanitizeSubtitleStyle({ fontScale: 1, color: 'red', maxCharsPerEntry: 99 })).toMatchObject({ fontScale: 2, color: '#FFFFFF', maxCharsPerEntry: 60 })
  })
})

describe('subtitle media key', () => {
  const video = { content: '/api/projects/film/raw/canvas/media/a.mp4', bytes: 1000, durationMs: 5000 }
  const saved = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...video, subtitleEntries: [cue('a', 0, 100)], subtitleMediaKey: subtitleMediaKeyOf(video), ...extra })

  it('is content|bytes|durationMs, an unknown part (not a finite number) empty', () => {
    expect(subtitleMediaKeyOf(video)).toBe('/api/projects/film/raw/canvas/media/a.mp4|1000|5000')
    expect(subtitleMediaKeyOf({ content: 'x' })).toBe('x||')
    expect(subtitleMediaKeyOf({ content: 'x', bytes: Number.NaN, durationMs: '5000' })).toBe('x||')
  })

  it('flags another address, another size, or a length more than 250 ms off', () => {
    expect(subtitleMediaChanged(saved())).toBe(false)
    expect(subtitleMediaChanged(saved({ content: '/api/projects/film/raw/canvas/media/b.mp4' }))).toBe(true)
    expect(subtitleMediaChanged(saved({ bytes: 2000 }))).toBe(true)
    expect(subtitleMediaChanged(saved({ durationMs: 5250 }))).toBe(false)
    expect(subtitleMediaChanged(saved({ durationMs: 5251 }))).toBe(true)
  })

  it('compares only what both sides know, and never flags without cues or a key', () => {
    expect(subtitleMediaChanged({ ...saved(), subtitleMediaKey: `${video.content}||` })).toBe(false)
    expect(subtitleMediaChanged(saved({ bytes: undefined, durationMs: undefined }))).toBe(false)
    expect(subtitleMediaChanged(saved({ subtitleEntries: null, content: 'other' }))).toBe(false)
    expect(subtitleMediaChanged(saved({ subtitleMediaKey: null, content: 'other' }))).toBe(false)
    // A cut an older Host landed: cues, no key.
    expect(subtitleMediaChanged({ ...video, subtitleEntries: [cue('a', 0, 100)] })).toBe(false)
    // An address holding '|' still splits right.
    const piped = { ...video, content: '/raw/a|b.mp4' }
    expect(subtitleMediaChanged({ ...piped, subtitleEntries: [cue('a', 0, 100)], subtitleMediaKey: subtitleMediaKeyOf(piped) })).toBe(false)
  })
})

describe('clip time', () => {
  const entries = [cue('before', 0, 900), cue('across', 1500, 2600), cue('inside', 3000, 3500), cue('after', 6000, 7000)]

  it('lists the cues inside a clip from its in point, clamped (按片段)', () => {
    expect(cuesInClipTime(entries, { inMs: 2000, outMs: 5000 })).toEqual([cue('across', 0, 600), cue('inside', 1000, 1500)])
  })

  it('moves cues timed from the in point into file time, cut at the file\'s end', () => {
    expect(cuesFromClipTime([{ startMs: 0, endMs: 500, text: 'a' }, { startMs: 2800, endMs: 4000, text: 'b' }, { startMs: 4500, endMs: 5000, text: 'c' }], { inMs: 2000 }, 6000)).toEqual([
      { startMs: 2000, endMs: 2500, text: 'a' },
      { startMs: 4800, endMs: 6000, text: 'b' },
    ])
  })

  it('digests cues so a changed list reads as changed', () => {
    expect(subtitleDigest(entries)).toBe(subtitleDigest(entries.map(entry => ({ ...entry }))))
    expect(subtitleDigest(entries)).not.toBe(subtitleDigest([...entries.slice(0, 3), cue('after', 6000, 7001)]))
  })
})

describe('SubRip and WebVTT', () => {
  const SRT = ['1', '00:00:01,000 --> 00:00:02,500', '你好', '', '2', '00:00:03,000 --> 00:00:05,250', '第二行', '两行字幕', ''].join('\n')

  it('reads cues with multi-line text and writes them back unchanged; a later page continues the numbers', () => {
    const { cues, format, skipped } = parseSubtitleText(SRT)
    expect({ format, skipped }).toEqual({ format: 'srt', skipped: 0 })
    expect(cues).toEqual([{ startMs: 1000, endMs: 2500, text: '你好' }, { startMs: 3000, endMs: 5250, text: '第二行\n两行字幕' }])
    expect(serializeSrt(cues)).toBe(SRT)
    expect(serializeSrt(cues.slice(1), 2)).toBe(SRT.slice(SRT.indexOf('2\n00:00:03')))
    expect(serializeSrt([{ startMs: 0, endMs: 1000, text: '上\n\n下  ' }, { startMs: 0, endMs: 1, text: ' ' }])).toBe('1\n00:00:00,000 --> 00:00:01,000\n上\n下\n')
  })

  it('takes a BOM, CRLF, \'.\' before the fraction, 1–3 hour digits, blocks without numbers or blank lines between them', () => {
    expect(parseSubtitleText(`﻿${SRT.replace(/\n/gu, '\r\n')}`).cues.map(item => item.text)).toEqual(['你好', '第二行\n两行字幕'])
    expect(parseSubtitleText('1\n0:00:01.5 --> 100:00:00.25\n长\n').cues).toEqual([{ startMs: 1500, endMs: 360_000_250, text: '长' }])
    expect(parseSubtitleText('1\n00:00:01,000 --> 00:00:02,000\n一\n2\n00:00:03,000 --> 00:00:04,000\n二\n00:00:05,000 --> 00:00:06,000\n三').cues.map(item => [item.startMs, item.text]))
      .toEqual([[1000, '一'], [3000, '二'], [5000, '三']])
  })

  it('skips and counts blocks it cannot read, and strips tags and override codes', () => {
    const text = ['1', '00:00:01,000 -> 00:00:02,000', '坏的箭头', '', '2', '00:00:03,000 --> 00:00:02,000', '倒着的时间', '', '3', '00:00:04,000 --> 00:00:05,000', '', '5', '',
      '6', '00:00:06,000 --> 00:00:07,000', '{\\an8}<i>斜体</i> <font color="#ff0">黄色</font>'].join('\n')
    expect(parseSubtitleText(text)).toEqual({ cues: [{ startMs: 6000, endMs: 7000, text: '斜体 黄色' }], format: 'srt', skipped: 3 })
  })

  it('reads WebVTT: the header, NOTE and STYLE blocks, identifiers, cue settings, voice tags and references', () => {
    const vtt = ['WEBVTT - 测试', '', 'NOTE 注释', '可以多行', '', 'STYLE', '::cue { color: red }', '', 'intro', '00:01.000 --> 00:02.500 align:start position:10%',
      '<v 小明>大家好</v> &amp; 欢迎', '', '01:00:00.000 --> 01:00:01.000', '<c.yellow>一小时后</c><00:00:00.500> &#20320;&#x597D;', ''].join('\n')
    expect(parseSubtitleText(vtt)).toEqual({
      cues: [{ startMs: 1000, endMs: 2500, text: '大家好 & 欢迎' }, { startMs: 3_600_000, endMs: 3_601_000, text: '一小时后 你好' }],
      format: 'vtt', skipped: 0,
    })
  })

  it('parses and writes timestamps, and tells timed text from plain lines', () => {
    expect(parseTimestamp('01:02:03,004')).toBe(3_723_004)
    expect(parseTimestamp('02:03.4')).toBe(123_400)
    expect(parseTimestamp('00:61:00,000')).toBeNull()
    expect(formatSrtTimestamp(360_000_250)).toBe('100:00:00,250')
    expect(formatSrtTimestamp(-5)).toBe('00:00:00,000')
    expect(looksLikeTimedSubtitles(SRT)).toBe(true)
    expect(looksLikeTimedSubtitles('第一句\n第二句\n')).toBe(false)
  })
})

describe('自动断句', () => {
  const ids = (): (() => string) => {
    let next = 0
    return () => `new-${++next}`
  }
  const PARK = '今天天气很好，我们去公园散步吧'

  it('cuts at punctuation and shares the time by length; the first piece keeps the id and a highlight follows its piece', () => {
    expect(splitCue({ id: 'a', startMs: 1000, endMs: 4000, text: PARK }, { maxLength: 10, newId: ids() })).toEqual([
      { id: 'a', startMs: 1000, endMs: 2400, text: '今天天气很好，' },
      { id: 'new-1', startMs: 2400, endMs: 4000, text: '我们去公园散步吧' },
    ])
    const [, back] = splitCue({ id: 'e', startMs: 0, endMs: 3000, text: PARK, highlight: { start: 10, end: 12 } }, { maxLength: 10, newId: ids() })
    expect(back!.highlight).toEqual({ start: 3, end: 5 })
  })

  it('gives every piece at least 300 ms when it can, and leaves a cue too short to share whole', () => {
    const pieces = splitCue({ id: 'b', startMs: 0, endMs: 1000, text: '一二三四五六七八九十' }, { maxLength: 4, newId: ids() })
    expect(pieces.map(piece => [piece.text, piece.startMs, piece.endMs])).toEqual([['一二三四', 0, 400], ['五六七八', 400, 700], ['九十', 700, 1000]])
    expect(Math.min(...pieces.map(piece => piece.endMs - piece.startMs))).toBe(SHORTEST_PIECE_MS)
    const tiny = { id: 'd', startMs: 0, endMs: 2, text: '一二三四五六七八九十' }
    expect(splitCue(tiny, { maxLength: 4, newId: ids() })).toEqual([tiny])
  })

  it('splits only the cues over the limit (default 35, clamped to 20–60), in order', () => {
    // The design values of the subtitle contract (C1): 20–60 units, 35 when the style names none, pieces of at least 300 ms.
    expect([CUE_LENGTH_RANGE.min, STANDARD_CUE_LENGTH, CUE_LENGTH_RANGE.max, SHORTEST_PIECE_MS]).toEqual([20, 35, 60, 300])
    const long = { id: 'k', startMs: 0, endMs: 6000, text: '一'.repeat(50) }
    const short = { id: 'l', startMs: 6000, endMs: 7000, text: '二' }
    const out = resegmentEntries([long, short], 5, ids())
    expect(out.map(entry => entry.text.length)).toEqual([20, 20, 10, 1])
    expect(out.map(entry => entry.id)).toEqual(['k', 'new-1', 'new-2', 'l'])
    expect(resegmentEntries([long], Number.NaN, ids()).map(entry => entry.text.length)).toEqual([35, 15])
  })
})

describe('what derived nodes carry', () => {
  const source = {
    content: '/api/projects/film/raw/canvas/media/shot.mp4', bytes: 1000, durationMs: 6000,
    subtitleEntries: [{ ...cue('a', 500, 1500), highlight: { start: 0, end: 1 } }, cue('b', 2500, 3500), cue('c', 4000, 5000)],
    subtitleStyle: { v: 1, fontScale: 7, color: '#ff0000', position: 'top', backdrop: 'box', maxCharsPerEntry: 30, autoResegment: false },
    subtitleUpdatedAt: '2026-10-01T00:00:00.000Z',
    subtitleMediaKey: '/api/projects/film/raw/canvas/media/shot.mp4|1000|6000',
  }
  const style = { v: 1, fontScale: 7, color: '#FF0000', position: 'top', backdrop: 'box', maxCharsPerEntry: 30, autoResegment: false }

  it('a split sibling keeps the overlapping cues in source time, with the same style, save time and key (the same file)', () => {
    expect(derivedSubtitleFields(source, { kind: 'sibling', inMs: 3000, outMs: 6000 })).toEqual({
      subtitleEntries: [cue('b', 2500, 3500), cue('c', 4000, 5000)], subtitleStyle: style, subtitleUpdatedAt: source.subtitleUpdatedAt, subtitleMediaKey: source.subtitleMediaKey,
    })
  })

  it('a rendered cut shifts its cues by the in point, keeps highlights and keys the new file, so it is not flagged', () => {
    const media = { content: '/api/projects/film/raw/canvas/media/clip-1.mp4', bytes: 400, durationMs: 3500 }
    const fields = derivedSubtitleFields(source, { kind: 'cut', inMs: 1000, outMs: 4500, atMs: 0 }, media, '2026-10-05T00:00:00.000Z')
    expect(fields).toEqual({
      subtitleEntries: [{ ...cue('a', 0, 500), highlight: { start: 0, end: 1 } }, cue('b', 1500, 2500), cue('c', 3000, 3500)],
      subtitleStyle: style, subtitleUpdatedAt: '2026-10-05T00:00:00.000Z', subtitleMediaKey: '/api/projects/film/raw/canvas/media/clip-1.mp4|400|3500',
    })
    expect(subtitleMediaChanged({ ...media, ...fields })).toBe(false)
    // Without a saved style, none is made up: the page draws its defaults.
    expect(derivedSubtitleFields({ ...source, subtitleStyle: undefined }, { kind: 'cut', inMs: 0, outMs: 2000 }, { content: 'x' })).not.toHaveProperty('subtitleStyle')
  })

  it('adds nothing when no cue survives, reads a cleared source as none, and cleans cues an older Host landed raw', () => {
    expect(derivedSubtitleFields(source, { kind: 'cut', inMs: 5500, outMs: 6000 }, { content: 'x' })).toEqual({})
    expect(derivedSubtitleFields({ ...source, subtitleEntries: null }, { kind: 'sibling', inMs: 0, outMs: 6000 })).toEqual({})
    const raw = { subtitleEntries: [{ startMs: 100, endMs: 900, text: '  无 id  ' }, { startMs: 'x' }] }
    const fields = derivedSubtitleFields(raw, { kind: 'cut', inMs: 0, outMs: 1000 }, { content: 'y', durationMs: 1000 }, 'now') as { subtitleEntries: SubtitleEntry[] }
    expect(fields.subtitleEntries).toEqual([{ id: expect.stringMatching(ID), startMs: 100, endMs: 900, text: '无 id' }])
    expect(fields).toMatchObject({ subtitleUpdatedAt: 'now', subtitleMediaKey: 'y||1000' })
  })

  it('a join places every segment\'s cues where it starts, with the first styled segment\'s style and the new file\'s key, at most 5000', () => {
    const plain = { subtitleEntries: [cue('p', 0, 800)] }
    const fields = joinedSubtitleFields([
      { inMs: 0, outMs: 2000, metadata: plain },
      { inMs: 2000, outMs: 4000, atMs: 2040, metadata: source },
    ], { content: '/api/projects/film/raw/canvas/media/join-1.mp4', bytes: 2000, durationMs: 4040 }, '2026-10-05T00:00:00.000Z')
    expect(fields).toEqual({
      subtitleEntries: [cue('p', 0, 800), cue('b', 2540, 3540)], subtitleStyle: style, subtitleUpdatedAt: '2026-10-05T00:00:00.000Z',
      subtitleMediaKey: '/api/projects/film/raw/canvas/media/join-1.mp4|2000|4040',
    })
    // Two full sources joined: the first 5000 cues, ids still unique.
    const full = { subtitleEntries: Array.from({ length: MAX_SUBTITLE_ENTRIES }, (_, index) => cue(`c${index}`, index * 200, index * 200 + 150)) }
    const span = MAX_SUBTITLE_ENTRIES * 200
    const joined = joinedSubtitleFields([{ inMs: 0, outMs: span, metadata: full }, { inMs: 0, outMs: span, metadata: full }], { content: 'z' }) as { subtitleEntries: SubtitleEntry[] }
    expect(joined.subtitleEntries).toHaveLength(MAX_SUBTITLE_ENTRIES)
    expect(joined.subtitleEntries.at(-1)).toEqual(cue(`c${MAX_SUBTITLE_ENTRIES - 1}`, span - 200, span - 50))
    expect(new Set(joined.subtitleEntries.map(entry => entry.id)).size).toBe(MAX_SUBTITLE_ENTRIES)
  })
})
