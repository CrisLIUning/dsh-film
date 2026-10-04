// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { characterActionSourceSeconds } from "./characterPerformance.js";
import type { DirectorCharacterActionClip } from "./directorProject.js";
export interface PerformanceClipOperation {
  clipId: string;
  action: "move" | "trim" | "stretch" | "duplicate" | "split" | "remove";
  start?: number;
  end?: number;
  at?: number;
  id?: string;
}
export function nextPerformanceClipId(
  clips: { id: string }[],
  prefix: string,
  requested?: string,
) {
  if (requested) {
    if (clips.some((c) => c.id === requested))
      throw new Error("片段 ID 已存在");
    return requested;
  }
  let i = 1;
  while (clips.some((c) => c.id === `${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}
/** Both action and head tracks preserve source phase under move, crop and split. */
export function editPerformanceClip<
  T extends Pick<
    DirectorCharacterActionClip,
    "id" | "name" | "start" | "end" | "source"
  >,
>(clips: T[], input: PerformanceClipOperation, prefix: string, label: string, idScope: {id: string}[] = clips) {
  const old = clips.find((c) => c.id === input.clipId);
  if (!old) throw new Error(`${label}片段不存在`);
  let next: T[],
    clipId: string | null = old.id;
  const start = input.start ?? old.start,
    end = input.end ?? old.end;
  let clip = { ...old };
  switch (input.action) {
    case "remove":
      next = clips.filter((c) => c.id !== old.id);
      clipId = null;
      break;
    case "move":
      clip = { ...old, start, end: start + old.end - old.start };
      next = clips.map((c) => (c.id === old.id ? clip : c));
      break;
    case "stretch":
      clip = { ...old, start, end };
      next = clips.map((c) => (c.id === old.id ? clip : c));
      break;
    case "trim": {
      // Restorable trimming extrapolates the original playback rate, inside the retained original source range.
      const rate = (old.source.out - old.source.in) / (old.end - old.start);
      const source = {
        ...old.source,
        in: old.source.in + (start - old.start) * rate,
        out: old.source.out + (end - old.end) * rate,
      };
      if (Math.abs(source.in) < 1e-10) source.in = 0;
      if (Math.abs(source.out - source.duration) < 1e-10)
        source.out = source.duration;
      clip = { ...old, start, end, source };
      next = clips.map((c) => (c.id === old.id ? clip : c));
      break;
    }
    case "duplicate": {
      clipId = nextPerformanceClipId(idScope, prefix, input.id);
      const begin = input.start ?? Math.max(...clips.map((c) => c.end));
      clip = {
        ...old,
        id: clipId,
        name: `${old.name ?? label} 副本`,
        start: begin,
        end: begin + old.end - old.start,
        source: { ...old.source },
      };
      next = [...clips, clip];
      break;
    }
    case "split": {
      const at = input.at!;
      if (at <= old.start || at >= old.end)
        throw new Error(`分割点必须在${label}片段内`);
      clipId = nextPerformanceClipId(idScope, prefix, input.id);
      const sourceAt = characterActionSourceSeconds(old, at);
      const first = {
        ...old,
        end: at,
        source: { ...old.source, out: sourceAt },
      };
      clip = {
        ...old,
        id: clipId,
        name: `${old.name ?? label} 后段`,
        start: at,
        source: { ...old.source, in: sourceAt },
      };
      next = [...clips.filter((c) => c.id !== old.id), first, clip];
      break;
    }
  }
  return { clips: next, clipId };
}
