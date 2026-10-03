/**
 * Editing a screenplay's body without touching its hidden structure (ported
 * from Studio's `body-editor.ts`). The file interleaves prose with managed
 * markers — the document declaration and block anchors, HTML comments the
 * reader never sees. The editor offers the text between them as sections;
 * an edit is accepted only when the markers come out exactly as they went
 * in, so typing or pasting can never add, remove or reorder structure.
 */

import { pairStoryBlocks, scanStoryTokens } from '../../../screenwriter/contracts/tokens.js'
import type { StoryRange } from '../../../screenwriter/contracts/types.js'

export interface StoryEditorSection {
  key: string
  /** The block kind (`scene-heading`, `action`, `speech`...), or `paragraph` for free text. */
  kind: string
  /** The editable range in the file. */
  range: StoryRange
  text: string
  /** Whether the section starts with a Markdown heading (its `#`s stay out of the editable text). */
  heading: boolean
  /** A line break the file needs back when an empty block gets text. */
  insertionSuffix?: string
}

/**
 * The editable sections of a screenplay.
 * @param source - the file.
 * @param semanticEditable - whether the plugin's full parse found the
 *   structure sound (its schema checks are not repeated here).
 * @returns the sections in file order, or `null` when the structure is broken
 *   and only the whole-file editor can help.
 */
export function storyEditorSections(source: string, semanticEditable: boolean): StoryEditorSection[] | null {
  const scan = scanStoryTokens(source)
  if (scan.diagnostics.some(d => d.severity === 'error') || (scan.tokens.length > 0 && !semanticEditable)) return null
  const paired = pairStoryBlocks(source, scan.tokens)
  if (paired.diagnostics.some(d => d.severity === 'error')) return null
  const metadata = scan.tokens.filter(token => token.kind === 'metadata')
  if (metadata.length > 1) return null
  const sections: StoryEditorSection[] = []
  const add = (start: number, end: number, key: string, kind: string, keepEmpty = false): void => {
    const raw = source.slice(start, end)
    if (!raw.trim() && !keepEmpty) return
    // Only the line breaks next to managed markers are wrappers. In particular,
    // typed spaces and extra line breaks belong to the author, never trim them.
    const firstBreak = /^(?:\r\n|\n)/.exec(raw)?.[0] ?? ''
    const lastBreak = /(?:\r\n|\n)$/.exec(raw)?.[0] ?? ''
    const from = start + firstBreak.length
    const to = Math.max(from, end - lastBreak.length)
    const content = source.slice(from, to)
    const headingPrefix = /^(?:\r?\n)*#{1,6}[ \t]+/.exec(content)
    const editableStart = from + (headingPrefix?.[0].length ?? 0)
    sections.push({
      key, kind, heading: headingPrefix !== null, range: { start: editableStart, end: to },
      text: source.slice(editableStart, to),
      // An empty block may have just one shared separator line break.
      ...(keepEmpty && raw === firstBreak && firstBreak !== '' ? { insertionSuffix: firstBreak } : {}),
    })
  }
  const managed = [
    ...metadata.map(token => ({ range: token.range, block: null })),
    ...paired.blocks.map(block => ({ range: block.range, block })),
  ].sort((a, b) => a.range.start - b.range.start)
  let cursor = 0
  managed.forEach((item, index) => {
    add(cursor, item.range.start, `gap-${index}`, 'paragraph')
    if (item.block) add(item.block.contentRange.start, item.block.contentRange.end, `block:${item.block.id}`, item.block.kind, true)
    cursor = item.range.end
  })
  add(cursor, source.length, 'tail', 'paragraph', sections.length === 0)
  return sections
}

/**
 * Put new text into a section.
 * @param source - the file the section was cut from.
 * @param section - the section.
 * @param value - its new text.
 * @returns the new file, or `null` when the file moved under the section or
 *   the text would change the hidden structure.
 */
export function replaceStoryEditorSection(source: string, section: StoryEditorSection, value: string): string | null {
  if (source.slice(section.range.start, section.range.end) !== section.text) return null
  const next = source.slice(0, section.range.start) + value
    + (value !== '' ? section.insertionSuffix ?? '' : '') + source.slice(section.range.end)
  const before = scanStoryTokens(source)
  const after = scanStoryTokens(next)
  if (after.diagnostics.some(d => d.severity === 'error')) return null
  const markers = (text: string, scan: ReturnType<typeof scanStoryTokens>): string[] =>
    scan.tokens.map(token => text.slice(token.range.start, token.range.end))
  if (JSON.stringify(markers(source, before)) !== JSON.stringify(markers(next, after))) return null
  return next
}

/** What a section is, for its label. */
export function sectionRole(section: StoryEditorSection): 'heading' | 'action' | 'speech' | 'paragraph' {
  if (section.heading) return 'heading'
  if (section.kind === 'action') return 'action'
  if (section.kind === 'speech' || section.kind === 'dialogue') return 'speech'
  return 'paragraph'
}
