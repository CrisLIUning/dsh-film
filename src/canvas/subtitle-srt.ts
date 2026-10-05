/**
 * Subtitle text files for the agent's subtitle tools: SubRip (.srt) and
 * WebVTT (.vtt) read into cues, SubRip written out — the storyboard page's
 * rules (canvas `web/src/lib/subtitles/srt.ts`, VibeDev's own), so text the
 * agent passes reads as the page's 导入 reads the same file.
 *
 * Reading is forgiving, since files come from many tools: a BOM; CRLF, CR or
 * LF line ends; ',' or '.' before the fraction, which may have one to three
 * digits ('.5' is half a second); one to three hour digits, or none; blocks
 * with or without their number; cues that follow each other without the blank
 * line; the WebVTT header, NOTE / STYLE / REGION blocks, cue identifiers and
 * cue settings. Formatting tags, WebVTT voice / class / timestamp tags and ASS
 * override codes are dropped, and WebVTT character references decoded. A
 * block that cannot be a cue is skipped and counted, never fatal.
 * @module dsh-film/canvas/subtitle-srt
 */

export interface ParsedSubtitleCue {
  startMs: number
  endMs: number
  text: string
}

export interface SubtitleParseResult {
  cues: ParsedSubtitleCue[]
  format: 'srt' | 'vtt'
  /** Blocks meant as cues that could not be used: no readable timing, end <= start, or no text. */
  skipped: number
}

/** The most subtitle text read at once, as the page's 导入 allows for a file. */
export const MAX_SUBTITLE_FILE_BYTES = 10 * 1024 * 1024

const BYTE_ORDER_MARK = '﻿'
const ARROW = '-->'
/** `[H:]M:S` with an optional fraction: hours 1–3 digits, minutes and seconds 1–2 digits (checked below 60 separately). */
const TIMESTAMP = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,9}))?$/u
/** A line holding only a number: a SubRip cue's index. */
const CUE_NUMBER = /^\d+$/u
const WEBVTT_SIGNATURE = /^WEBVTT(?:[ \t]|$)/u
/** WebVTT blocks that hold no cue: a comment, a style sheet, a region definition. */
const WEBVTT_SIDE_BLOCK = /^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/u
/** `{\an8}`, `{\pos(10,20)}`: ASS override codes some SubRip files carry. */
const ASS_OVERRIDE = /\{\\[^{}]*\}/gu
/** `<i>`, `</font>`, `<font color="#ff0">`, `<v Name>`, `<c.yellow>`, and WebVTT timestamp tags such as `<00:00:01.500>`; a bare '<' in text is left alone. */
const MARKUP_TAG = /<\/?(?:[A-Za-z][^<>]*|\d[\d:.,]*)>/gu
const CHARACTER_REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z]{2,8}));/gu
const NAMED_REFERENCES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', '\''],
  ['nbsp', ' '],
  ['lrm', '‎'],
  ['rlm', '‏'],
])

type Format = SubtitleParseResult['format']
interface OpenCue { startMs: number; endMs: number; lines: string[] }

const withoutBom = (text: string): string => text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text
const linesOf = (text: string): string[] => withoutBom(text).split(/\r\n|\r|\n/u)
const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/**
 * One timestamp in milliseconds (`01:02:03,004`, `0:00:01.5`, `02:03.4`).
 * @param value - the timestamp as written.
 * @returns the time, or `null` when it is none.
 */
export function parseTimestamp(value: string): number | null {
  const match = TIMESTAMP.exec(value.trim())
  if (match === null) return null
  const hours = match[1] === undefined ? 0 : Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  if (minutes >= 60 || seconds >= 60) return null
  // The digits are a decimal fraction of a second: '5' is 500 ms, '25' is 250 ms, '004' is 4 ms.
  const fractionMs = match[4] === undefined ? 0 : Math.round(Number(`0.${match[4]}`) * 1000)
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + fractionMs
}

/**
 * A timing line (`start --> end`, maybe followed by WebVTT cue settings or
 * SubRip coordinates) as two times, in the order written: a reversed pair is
 * still a timing line, and the cue it opens is refused later.
 * @param line - one line of the file.
 * @returns the two times, or `null` when it is no timing line.
 */
export function parseTimingLine(line: string): { startMs: number; endMs: number } | null {
  const arrow = line.indexOf(ARROW)
  if (arrow < 0) return null
  const startMs = parseTimestamp(line.slice(0, arrow))
  if (startMs === null) return null
  const [endText = ''] = line.slice(arrow + ARROW.length).trim().split(/\s+/u, 1)
  const endMs = parseTimestamp(endText)
  return endMs === null ? null : { startMs, endMs }
}

const isWebVtt = (lines: readonly string[]): boolean => WEBVTT_SIGNATURE.test((lines.find(line => line.trim() !== '') ?? '').trim())

/**
 * Whether a text is a timed subtitle file (SubRip or WebVTT) rather than plain lines.
 * @param text - the text.
 * @returns whether it has a WebVTT header or a timing line.
 */
export function looksLikeTimedSubtitles(text: string): boolean {
  const lines = linesOf(text)
  return isWebVtt(lines) || lines.some(line => line.includes(ARROW) && parseTimingLine(line.trim()) !== null)
}

function decodeCharacterReferences(text: string): string {
  return text.replace(CHARACTER_REFERENCE, (whole: string, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_REFERENCES.get(name.toLowerCase()) ?? whole
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16)
    const usable = code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF)
    return usable ? String.fromCodePoint(code) : whole
  })
}

/** A cue's lines as plain text: markup and override codes removed, blank lines dropped. */
function plainCueText(lines: readonly string[], format: Format): string {
  const kept: string[] = []
  for (const line of lines) {
    let text = line.replace(ASS_OVERRIDE, '').replace(MARKUP_TAG, '')
    // References are decoded after the tags are gone, so an escaped '&lt;i&gt;' stays text.
    if (format === 'vtt') text = decodeCharacterReferences(text)
    text = text.trim()
    if (text !== '') kept.push(text)
  }
  return kept.join('\n')
}

/** A block without a timing line that is no lost cue: a lone cue number, or in WebVTT the header or a NOTE / STYLE / REGION block. */
function isQuietBlock(block: readonly string[], format: Format): boolean {
  const first = block[0] ?? ''
  if (block.length === 1 && CUE_NUMBER.test(first)) return true
  return format === 'vtt' && (WEBVTT_SIGNATURE.test(first) || WEBVTT_SIDE_BLOCK.test(first))
}

/**
 * The cues of a SubRip or WebVTT text, in file order (not sorted), with the
 * number of blocks that could not be read.
 * @param input - the text.
 * @returns the cues, the format and the skipped count.
 */
export function parseSubtitleText(input: string): SubtitleParseResult {
  const lines = linesOf(input)
  const format: Format = isWebVtt(lines) ? 'vtt' : 'srt'
  const cues: ParsedSubtitleCue[] = []
  let skipped = 0
  // The cue being read, and the lines of a block that has not reached a timing line (a cue number, a WebVTT identifier, a header, junk).
  let open: OpenCue | null = null
  let loose: string[] = []

  const settle = (cue: OpenCue): void => {
    const text = plainCueText(cue.lines, format)
    if (text !== '' && cue.endMs > cue.startMs) cues.push({ startMs: cue.startMs, endMs: cue.endMs, text })
    else skipped++
  }

  // A blank line after the last line closes whatever is still open.
  for (const raw of [...lines, '']) {
    const line = raw.trim()
    if (line === '') {
      if (open !== null) settle(open)
      open = null
      if (loose.length > 0 && !isQuietBlock(loose, format)) skipped++
      loose = []
      continue
    }
    const timing = line.includes(ARROW) ? parseTimingLine(line) : null
    if (timing !== null) {
      if (open !== null) {
        // Written without the blank line between cues: the number just before this timing line belongs to the next cue.
        const last = open.lines.at(-1)
        if (last !== undefined && CUE_NUMBER.test(last)) open.lines.pop()
        settle(open)
      }
      open = { startMs: timing.startMs, endMs: timing.endMs, lines: [] }
      loose = []
    } else if (open !== null) {
      open.lines.push(line)
    } else {
      loose.push(line)
    }
  }
  return { cues, format, skipped }
}

/**
 * `HH:MM:SS,mmm` (more hour digits past 99 hours); a negative or unknown time is written as 0.
 * @param ms - the time.
 * @returns the SubRip timestamp.
 */
export function formatSrtTimestamp(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor(total / 60_000) % 60
  const seconds = Math.floor(total / 1000) % 60
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(total % 1000, 3)}`
}

/**
 * A SubRip text of the cues in the order given. A blank line ends a SubRip
 * cue, so each text keeps only its non-blank lines, trimmed; a cue left with
 * no text is not written.
 * @param cues - the cues.
 * @param firstNumber - the number of the first cue written (a later page of a long list continues the count).
 * @returns the text.
 */
export function serializeSrt(cues: ReadonlyArray<{ startMs: number; endMs: number; text: string }>, firstNumber = 1): string {
  const blocks: string[] = []
  for (const cue of cues) {
    const lines = (typeof cue.text === 'string' ? cue.text : '').split(/\r\n|\r|\n/u).map(line => line.trim()).filter(line => line !== '')
    if (lines.length === 0) continue
    blocks.push(`${firstNumber + blocks.length}\n${formatSrtTimestamp(cue.startMs)} ${ARROW} ${formatSrtTimestamp(cue.endMs)}\n${lines.join('\n')}\n`)
  }
  return blocks.join('\n')
}
