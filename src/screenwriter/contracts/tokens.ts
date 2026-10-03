/**
 * The screenplay's hidden structure without schema validation: the marker
 * scanner, block pairing, the reading projection and block titles. Free of
 * zod, so the workbench's browser bundle can use it; `parser.ts` builds the
 * validated parse on top of it.
 */
import { applyTextEdits, isJsonObject, parseJsonCst, StorySyntaxError, type JsonNode } from './json-cst.js';
import type { StoryBlock, StoryDiagnostic, StoryRange } from './types.js';

/** A stable story ID (the same rule as `StoryIdSchema`). */
export const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;

export const isStoryId = (value: unknown): value is string => typeof value === 'string' && STORY_ID.test(value);

export interface StoryToken {
  kind: 'metadata' | 'open' | 'close';
  range: StoryRange;
  payloadRange: StoryRange;
  node: JsonNode | null;
}
export interface StoryScanResult { tokens: StoryToken[]; diagnostics: StoryDiagnostic[] }

/** Recognize only standalone namespace comments outside fenced/indented code and raw HTML. */
export function scanStoryTokens(source: string): StoryScanResult {
  const tokens: StoryToken[] = [];
  const diagnostics: StoryDiagnostic[] = [];
  let cursor = 0;
  let fence: { char: string; count: number } | null = null;
  let rawTag: string | null = null;
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? source.length : newline;
    const nextLine = newline === -1 ? source.length : newline + 1;
    const line = source.slice(cursor, lineEnd).replace(/\r$/, '');
    const lineWithoutBom = cursor === 0 ? line.replace(/^﻿/, '') : line;
    if (rawTag) {
      if (new RegExp(`</${rawTag}\\s*>`, 'i').test(line)) rawTag = null;
      cursor = nextLine; continue;
    }
    const fenced = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lineWithoutBom);
    if (fence) {
      if (fenced && fenced[1]![0] === fence.char && fenced[1]!.length >= fence.count && !fenced[2]!.trim()) fence = null;
      cursor = nextLine; continue;
    }
    if (fenced && (fenced[1]![0] !== '`' || !fenced[2]!.includes('`'))) {
      fence = { char: fenced[1]![0]!, count: fenced[1]!.length };
      cursor = nextLine; continue;
    }
    const raw = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i.exec(lineWithoutBom);
    if (raw) {
      if (!new RegExp(`</${raw[1]}\\s*>`, 'i').test(line)) rawTag = raw[1]!;
      cursor = nextLine; continue;
    }
    const opening = /^ {0,3}<!--/.exec(lineWithoutBom);
    if (!opening) { cursor = nextLine; continue; }
    const start = cursor + line.indexOf('<!--');
    const close = source.indexOf('-->', start + 4);
    const end = close === -1 ? source.length : close + 3;
    const contentEnd = close === -1 ? source.length : close;
    const interior = source.slice(start + 4, contentEnd);
    const recognized = /^\s*(vibedev:screenwriter|sw:block|\/sw:block)(?=\s|$)/.exec(interior);
    if (recognized) {
      const kind = recognized[1] === 'vibedev:screenwriter' ? 'metadata' : recognized[1] === 'sw:block' ? 'open' : 'close';
      const payloadRange = { start: start + 4 + recognized[0].length, end: contentEnd };
      let node: JsonNode | null = null;
      if (close === -1) diagnostics.push({ code: 'unclosed-comment', severity: 'error', message: '技术注释尚未闭合；原稿已保留。', range: { start, end } });
      else {
        const remainderEnd = source.indexOf('\n', end);
        if (source.slice(end, remainderEnd === -1 ? source.length : remainderEnd).trim()) {
          diagnostics.push({ code: 'marker-not-standalone', severity: 'error', message: '编剧技术注释必须独占一行。', range: { start, end } });
        }
        try { node = parseJsonCst(source, payloadRange.start, payloadRange.end); }
        catch (error) {
          const offset = error instanceof StorySyntaxError ? error.offset : payloadRange.start;
          diagnostics.push({ code: 'invalid-json', severity: 'error', message: error instanceof Error ? error.message : 'Invalid metadata JSON.', range: { start: offset, end: Math.min(offset + 1, source.length) } });
        }
      }
      tokens.push({ kind, range: { start, end }, payloadRange, node });
    }
    // An ordinary multi-line author comment owns all of its contents as opaque text.
    const afterComment = source.indexOf('\n', end);
    cursor = afterComment === -1 ? source.length : afterComment + 1;
  }
  return { tokens, diagnostics };
}

/**
 * Pair block markers into blocks, in source order.
 * @param source - the Markdown source.
 * @param tokens - its scanned markers.
 * @returns the blocks, and the marker problems found while pairing.
 */
export function pairStoryBlocks(source: string, tokens: readonly StoryToken[]): { blocks: StoryBlock[]; diagnostics: StoryDiagnostic[] } {
  const blocks: StoryBlock[] = [];
  const diagnostics: StoryDiagnostic[] = [];
  const stack: StoryToken[] = [];
  for (const token of tokens) {
    if (token.kind === 'metadata') continue;
    const value = token.node?.value;
    if (!isJsonObject(value) || !isStoryId(value.id) || (token.kind === 'open' && typeof value.kind !== 'string')) {
      diagnostics.push({ code: 'invalid-block-marker', severity: 'error', message: '正文块锚点缺少合法 ID 或类型。', range: token.range }); continue;
    }
    if (token.kind === 'open') {
      if (stack.length) diagnostics.push({ code: 'nested-block', severity: 'error', message: '受管理正文块不能嵌套。', objectId: value.id as string, range: token.range });
      stack.push(token); continue;
    }
    const open = stack.at(-1);
    if (!open || (open.node?.value as Record<string, unknown>).id !== value.id) {
      diagnostics.push({ code: 'unmatched-block-close', severity: 'error', message: '正文块结束锚点没有对应开始锚点。', objectId: value.id as string, range: token.range }); continue;
    }
    stack.pop();
    blocks.push({ id: value.id as string, kind: (open.node!.value as Record<string, unknown>).kind as string,
      markdown: source.slice(open.range.end, token.range.start), range: { start: open.range.start, end: token.range.end },
      contentRange: { start: open.range.end, end: token.range.start }, openRange: open.range, closeRange: token.range });
  }
  for (const open of stack) diagnostics.push({ code: 'unclosed-block', severity: 'error', message: '正文块尚未闭合；保留原文，暂停关联操作。', range: open.range });
  blocks.sort((a, b) => a.range.start - b.range.start);
  return { blocks, diagnostics };
}

/** Reading exchange is deliberately distinct from a lossless native export (which is source itself). */
export function projectStoryBody(source: string): string {
  const scan = scanStoryTokens(source);
  // Incomplete/malformed comments are author input, never silently deleted.
  const ranges = scan.tokens.filter((token) => token.node !== null).map((token) => ({ ...token.range, text: '' }));
  return applyTextEdits(source, ranges);
}

export function storyBlockTitle(block: StoryBlock | undefined): string {
  if (!block) return '';
  const heading = /^ {0,3}#{1,6}[\t ]+(.*?)(?:[\t ]+#+[\t ]*)?\r?$/m.exec(block.markdown);
  return (heading?.[1]?.trim() ?? block.markdown.trim().split(/\r?\n/, 1)[0] ?? '').replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}
