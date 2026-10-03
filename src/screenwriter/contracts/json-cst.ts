import type { StoryRange } from './types.js';

export interface JsonProperty { key: string; keyRange: StoryRange; value: JsonNode }
export interface JsonNode extends StoryRange {
  value: unknown;
  properties?: JsonProperty[];
  elements?: JsonNode[];
}
export interface TextEdit extends StoryRange { text: string }
export class StorySyntaxError extends Error {
  constructor(message: string, readonly offset: number) { super(message); }
}

/** JSON CST records original tokens. Never use JSON.parse/stringify as a whole-file editor. */
export function parseJsonCst(source: string, start: number, end: number): JsonNode {
  let cursor = start;
  const space = () => { while (cursor < end && /[\t\r\n ]/.test(source[cursor]!)) cursor++; };
  const fail = (message: string): never => { throw new StorySyntaxError(message, cursor); };
  const string = (): JsonNode => {
    const begin = cursor++;
    let escaped = false;
    while (cursor < end) {
      const char = source[cursor++]!;
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') {
        try { return { start: begin, end: cursor, value: JSON.parse(source.slice(begin, cursor)) as unknown }; }
        catch { return fail('Invalid JSON string.'); }
      }
    }
    return fail('Unterminated JSON string.');
  };
  const value = (depth: number): JsonNode => {
    if (depth > 128) return fail('Metadata exceeds the nesting limit.');
    space();
    const begin = cursor;
    const char = source[cursor];
    if (char === '"') return string();
    if (char === '{') {
      cursor++; space();
      const properties: JsonProperty[] = [];
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (source[cursor] !== '}') {
        while (cursor < end) {
          if (source[cursor] !== '"') return fail('Expected a JSON object member.');
          const key = string();
          if (Object.prototype.hasOwnProperty.call(result, key.value as string)) return fail(`Duplicate JSON member: ${String(key.value)}.`);
          space();
          if (source[cursor++] !== ':') return fail('Expected a colon.');
          const child = value(depth + 1);
          result[key.value as string] = child.value;
          properties.push({ key: key.value as string, keyRange: { start: key.start, end: key.end }, value: child });
          space();
          if (source[cursor] !== ',') break;
          cursor++; space();
        }
      }
      if (source[cursor++] !== '}') return fail('Expected a closing object brace.');
      return { start: begin, end: cursor, value: result, properties };
    }
    if (char === '[') {
      cursor++; space();
      const elements: JsonNode[] = [];
      if (source[cursor] !== ']') {
        while (cursor < end) {
          elements.push(value(depth + 1)); space();
          if (source[cursor] !== ',') break;
          cursor++; space();
        }
      }
      if (source[cursor++] !== ']') return fail('Expected a closing array bracket.');
      return { start: begin, end: cursor, value: elements.map((element) => element.value), elements };
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(cursor, end));
    if (!match) return fail('Expected a JSON value.');
    cursor += match[0].length;
    const parsed = JSON.parse(match[0]) as unknown;
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) return fail('JSON number must be finite.');
    return { start: begin, end: cursor, value: parsed };
  };
  const root = value(0); space();
  if (cursor !== end) fail('Unexpected text after metadata JSON.');
  return root;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function storyJson(value: unknown, indent?: number): string {
  const serialized = JSON.stringify(value, null, indent);
  if (serialized === undefined) throw new Error('A story metadata value cannot be undefined.');
  // Prevent a value from terminating its containing HTML comment (or creating another one).
  return serialized.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

export function applyTextEdits(source: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = 0;
  const parts: string[] = [];
  for (const edit of sorted) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < previousEnd || edit.end < edit.start || edit.end > source.length) {
      throw new Error('Story text edits overlap or address an invalid source range.');
    }
    parts.push(source.slice(previousEnd, edit.start), edit.text);
    previousEnd = edit.end;
  }
  parts.push(source.slice(previousEnd));
  return parts.join('');
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]));
  }
  return false;
}

/** Only touched values/separators change; untouched member spacing and escapes are retained. */
export function editJsonValue(node: JsonNode, next: unknown): TextEdit[] {
  if (equal(node.value, next)) return [];
  if (node.properties && isJsonObject(next)) {
    const edits: TextEdit[] = [];
    const properties = node.properties;
    const kept = properties.filter((property) => Object.hasOwn(next, property.key));
    if (kept.length !== properties.length) {
      // Remove contiguous runs, retaining every surviving property's exact spelling.
      for (let index = 0; index < properties.length;) {
        if (Object.hasOwn(next, properties[index]!.key)) { index++; continue; }
        const first = index;
        while (index < properties.length && !Object.hasOwn(next, properties[index]!.key)) index++;
        const previous = properties[first - 1];
        const following = properties[index];
        edits.push({ start: following ? properties[first]!.keyRange.start : previous?.value.end ?? properties[first]!.keyRange.start,
          end: following?.keyRange.start ?? properties[index - 1]!.value.end, text: '' });
      }
    }
    for (const property of kept) edits.push(...editJsonValue(property.value, next[property.key]));
    const additions = Object.keys(next).filter((key) => !properties.some((property) => property.key === key));
    if (additions.length) {
      const position = properties.at(-1)?.value.end ?? node.start + 1;
      if (kept.length !== properties.length) {
        // An uncommon combined add/remove replaces the object; normal record patches merge unknown fields.
        return [{ start: node.start, end: node.end, text: storyJson(next) }];
      }
      edits.push({ start: position, end: position,
        text: `${properties.length ? ',' : ''}${additions.map((key) => `${storyJson(key)}:${storyJson(next[key])}`).join(',')}` });
    }
    return edits;
  }
  if (node.elements && Array.isArray(next)) {
    const elements = node.elements;
    if (elements.length === next.length) return elements.flatMap((element, index) => editJsonValue(element, next[index]));
    let prefix = 0;
    while (prefix < elements.length && prefix < next.length && equal(elements[prefix]!.value, next[prefix])) prefix++;
    let suffix = 0;
    while (suffix < elements.length - prefix && suffix < next.length - prefix && equal(elements[elements.length - suffix - 1]!.value, next[next.length - suffix - 1])) suffix++;
    const inserted = next.slice(prefix, next.length - suffix);
    const previous = elements[prefix - 1];
    const following = elements[elements.length - suffix];
    const first = elements[prefix];
    const last = elements[elements.length - suffix - 1];
    const content = inserted.map((item) => storyJson(item)).join(',');
    if (following) {
      return [{ start: first?.start ?? following.start, end: following.start, text: content ? `${content},` : '' }];
    }
    const start = previous?.end ?? first?.start ?? node.start + 1;
    return [{ start, end: last?.end ?? start, text: `${previous && inserted.length ? ',' : ''}${content}` }];
  }
  return [{ start: node.start, end: node.end, text: storyJson(next) }];
}
