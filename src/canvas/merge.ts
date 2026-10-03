/**
 * Three-way merge of a board save, ported unchanged from Studio
 * (apps/daemon/src/screenwriter/canvas-merge.ts): nodes and connections merge
 * per id, plain objects per key, anything else changed on both sides is a
 * conflict and nothing is written.
 * @module dsh-film/canvas/merge
 */
import { isDeepStrictEqual } from 'node:util';
import type { CanvasDocument } from './documents.js';

export class CanvasStoryMergeConflict extends Error {
  constructor(public readonly paths: string[], public readonly current: CanvasDocument | null) { super('Canvas changes overlap. The current board and your draft have both been retained.'); }
}
const absent = Symbol('absent');
type Value = unknown | typeof absent;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A normal canvas autosave and a headless story handoff share this merge.
 * ID collections merge per node/connection; reference arrays are indivisible
 * selections. Deletion conflicts with editing that same object. */
export function mergeStoryCanvas(base: CanvasDocument | null, draft: CanvasDocument, current: CanvasDocument | null): CanvasDocument {
  for (const document of [base, draft, current]) {
    if (!document) continue;
    for (const key of ['nodes', 'connections'] as const) {
      if (!Array.isArray(document[key])) throw new Error(`Canvas ${key} must be an array.`);
      const ids = new Set<string>();
      for (const item of document[key]) {
        if (!object(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error(`Canvas ${key} must have unique stable IDs.`);
        ids.add(item.id);
      }
    }
  }
  const conflicts: string[] = [];
  const merge = (before: Value, local: Value, remote: Value, at: string): Value => {
    if (isDeepStrictEqual(local, before)) return remote;
    if (isDeepStrictEqual(remote, before) || isDeepStrictEqual(local, remote)) return local;
    if (at === 'updatedAt') return local;
    if ((at === 'nodes' || at === 'connections') && [before, local, remote].every((value) => value === absent || Array.isArray(value))) {
      const entries = (value: Value) => value === absent ? [] : value as Array<Record<string, unknown>>;
      const maps = [before, local, remote].map((value) => {
        const map = new Map<string, Record<string, unknown>>();
        for (const item of entries(value)) {
          if (!object(item) || typeof item.id !== 'string' || !item.id || map.has(item.id)) throw new Error(`Canvas ${at} must have unique stable IDs.`);
          map.set(item.id, item);
        }
        return map;
      });
      const ids = new Set([...maps[1]!.keys(), ...maps[2]!.keys(), ...maps[0]!.keys()]);
      const result: unknown[] = [];
      for (const id of ids) {
        const value = merge(maps[0]!.get(id) ?? absent, maps[1]!.get(id) ?? absent, maps[2]!.get(id) ?? absent, `${at}.${id}`);
        if (value !== absent) result.push(value);
      }
      return result;
    }
    if (object(before) && object(local) && object(remote)) {
      const result: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(before), ...Object.keys(local), ...Object.keys(remote)])) {
        const value = merge(key in before ? before[key] : absent, key in local ? local[key] : absent, key in remote ? remote[key] : absent, at ? `${at}.${key}` : key);
        if (value !== absent) result[key] = value;
      }
      return result;
    }
    conflicts.push(at || 'document');
    return remote;
  };
  if ((base && base.id !== draft.id) || (current && current.id !== draft.id)) throw new Error('Canvas identity does not match the merge baseline.');
  const empty = { id: draft.id, nodes: [], connections: [] };
  const merged = merge(base ?? empty, draft, current ?? empty, '') as CanvasDocument;
  if (conflicts.length) throw new CanvasStoryMergeConflict(conflicts, current);
  return { ...merged, id: draft.id, updatedAt: new Date().toISOString() };
}
