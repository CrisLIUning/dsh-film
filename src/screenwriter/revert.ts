import { parseStoryMarkdown, type StoryRange } from './contracts/index.js';
/** An operation's inverse is anchored to its actual saved text. It never
 * restores the whole file over edits made after that operation. */
export interface StoryTextChange { before: string; after: string; prefix: string; suffix: string; beforeRange: StoryRange; afterRange: StoryRange }

export function storyTextChanges(before: string, after: string): StoryTextChange[] {
  const a = before.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const b = after.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const offsets = (lines: string[]) => { let offset = 0; return [...lines.map((line) => { const start = offset; offset += line.length; return start; }), offset]; };
  const aOffsets = offsets(a);
  const bOffsets = offsets(b);
  // Bound pathological memory usage. A conservative single hunk is safe: it
  // may require manual resolution, but cannot silently drop later edits.
  if (a.length * b.length > 1_000_000) return singleChange(before, after);
  const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    rows[i]![j] = a[i] === b[j] ? rows[i + 1]![j + 1]! + 1 : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
  }
  const matches: Array<[number, number]> = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { matches.push([i++, j++]); }
    else if (rows[i + 1]![j]! >= rows[i]![j + 1]!) i++;
    else j++;
  }
  matches.push([a.length, b.length]);
  const changes: StoryTextChange[] = [];
  let ai = 0; let bi = 0;
  for (const [am, bm] of matches) {
    if (ai !== am || bi !== bm) {
      const old = a.slice(ai, am).join(''); const next = b.slice(bi, bm).join('');
      // Trim within a changed line so later edits to another field on that
      // line are retained when the actual replaced range remains unambiguous.
      const trimmed = singleChange(old, next)[0];
      if (trimmed) changes.push({
        before: trimmed.before, after: trimmed.after,
        prefix: (b.slice(Math.max(0, bi - 2), bi).join('') + trimmed.prefix).slice(-160),
        suffix: (trimmed.suffix + b.slice(bm, bm + 2).join('')).slice(0, 160),
        beforeRange: { start: aOffsets[ai]! + trimmed.beforeRange.start, end: aOffsets[ai]! + trimmed.beforeRange.end },
        afterRange: { start: bOffsets[bi]! + trimmed.afterRange.start, end: bOffsets[bi]! + trimmed.afterRange.end },
      });
    }
    ai = am + 1; bi = bm + 1;
  }
  return changes;
}

function singleChange(before: string, after: string): StoryTextChange[] {
  if (before === after) return [];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  return [{ before: before.slice(start, before.length - end), after: after.slice(start, after.length - end), prefix: after.slice(Math.max(0, start - 160), start), suffix: end ? after.slice(after.length - end, after.length - end + 160) : '',
    beforeRange: { start, end: before.length - end }, afterRange: { start, end: after.length - end } }];
}

function mapUntouchedRange(after: string, current: string, range: StoryRange): StoryRange {
  let shift = 0;
  for (const edit of storyTextChanges(after, current)) {
    const from = edit.beforeRange;
    const overlaps = from.start < range.end && from.end > range.start;
    const insertsWithin = from.start === from.end && from.start > range.start && from.start < range.end;
    const replacesDeletedPoint = range.start === range.end && from.start <= range.start && from.end >= range.end;
    if (overlaps || insertsWithin || replacesDeletedPoint) throw new Error('Later edits overlap the original operation range.');
    if (from.end <= range.start) shift += edit.after.length - edit.before.length;
  }
  const mapped = { start: range.start + shift, end: range.end + shift };
  if (after.slice(range.start, range.end) !== current.slice(mapped.start, mapped.end)) throw new Error('The original operation range no longer matches.');
  return mapped;
}

export function revertStoryText(before: string, after: string, current: string): string {
  if (current === after) return before;
  const saved = parseStoryMarkdown(after);
  const working = parseStoryMarkdown(current);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const change of storyTextChanges(before, after)) {
    const owner = saved.blocks.find((block) => block.contentRange.start <= change.afterRange.start && block.contentRange.end >= change.afterRange.end);
    if (owner) {
      const currentOwners = working.blocks.filter((block) => block.id === owner.id);
      if (currentOwners.length !== 1) throw new Error('The original stable block is missing or ambiguous.');
      const target = currentOwners[0]!;
      const mapped = mapUntouchedRange(owner.markdown, target.markdown, {
        start: change.afterRange.start - owner.contentRange.start,
        end: change.afterRange.end - owner.contentRange.start,
      });
      edits.push({ start: target.contentRange.start + mapped.start, end: target.contentRange.start + mapped.end, text: change.before });
      continue;
    }
    // Unmanaged prose/metadata has no block identity. Require both observed edit
    // mapping and surviving text context; a nearby duplicate is not a target.
    const mapped = mapUntouchedRange(after, current, change.afterRange);
    const candidates: number[] = [];
    if (change.after) {
      let start = current.indexOf(change.after);
      while (start >= 0) { candidates.push(start); start = current.indexOf(change.after, start + 1); }
    } else {
      const anchor = change.prefix + change.suffix;
      if (!anchor) throw new Error('The deleted range has no surviving anchor.');
      let start = current.indexOf(anchor);
      while (start >= 0) { candidates.push(start + change.prefix.length); start = current.indexOf(anchor, start + 1); }
    }
    const anchored = candidates.filter((at) =>
      (!change.prefix || current.slice(0, at).endsWith(change.prefix))
      && (!change.suffix || current.slice(at + change.after.length).startsWith(change.suffix)));
    // Even a unique substring can belong to an unrelated sentence after the
    // original target changed. Require its surviving context, never guess.
    const eligible = anchored.filter((at) => at === mapped.start);
    if (eligible.length !== 1) throw new Error('The operation overlaps later edits or its target is ambiguous.');
    const start = eligible[0]!;
    edits.push({ start, end: start + change.after.length, text: change.before });
  }
  edits.sort((a, b) => b.start - a.start);
  let last = current.length + 1;
  let output = current;
  for (const edit of edits) {
    if (edit.end > last) throw new Error('The inverse ranges overlap.');
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    last = edit.start;
  }
  return output;
}
