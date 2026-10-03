import { describe, expect, it } from 'vitest';
import { applyTextEdits, editJsonValue, parseJsonCst } from '../../src/screenwriter/contracts/json-cst.js';

describe('story JSON localized token editing', () => {
  const change = (source: string, value: unknown) => applyTextEdits(source, editJsonValue(parseJsonCst(source, 0, source.length), value));
  it('edits array insertions, removals and middle replacements without touching survivors', () => {
    const source = '[ { "id" : "a", "x":"\\u0061" },\n { "id":"b" },\n { "id":"c" } ]';
    const values = JSON.parse(source) as Array<Record<string, unknown>>;
    const variants = [[], [values[0]], [values[1]], [values[2]], [values[0], values[2]], [...values, { id: 'd' }], [{ id: 'd' }, ...values], [values[0], { id: 'd' }, values[2]]];
    for (const next of variants) {
      const actual = change(source, next);
      expect(JSON.parse(actual)).toEqual(next);
      if (next.includes(values[0])) expect(actual).toContain('{ "id" : "a", "x":"\\u0061" }');
    }
  });

  it('removes object members while retaining untouched token spelling and unknown whitespace', () => {
    const source = '{ "a" : "\\u0061",\n "b":2, "c" : 3, "d":4 }';
    for (const next of [{}, { a: 'a' }, { b: 2 }, { c: 3 }, { d: 4 }, { a: 'a', c: 3 }, { b: 2, d: 4 }]) {
      const actual = change(source, next);
      expect(JSON.parse(actual)).toEqual(next);
      if ('a' in next) expect(actual).toContain('"a" : "\\u0061"');
    }
  });

  it('rejects duplicate keys and retains own prototype-named JSON properties as data', () => {
    expect(() => parseJsonCst('{"same":1,"same":2}', 0, 19)).toThrow();
    const source = '{"__proto__":{"polluted":true},"constructor":"author"}';
    const parsed = parseJsonCst(source, 0, source.length);
    expect(Object.getPrototypeOf(parsed.value)).toBe(null);
    expect(change(source, parsed.value)).toBe(source);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
