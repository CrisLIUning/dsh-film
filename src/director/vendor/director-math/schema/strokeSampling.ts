// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
/** Shared by ground routes and camera strokes. Geometry is independent of pointer frequency. */
export interface StrokeSample { position: [number, number, number]; time: number }
export type StrokePace = "uniform" | "drawn";
const TOLERANCE = 0.03;
const SPACING = 0.5;
const distance = (a: StrokeSample, b: StrokeSample) => Math.hypot(...a.position.map((v, i) => v - b.position[i]));
const interpolate = (a: StrokeSample, b: StrokeSample, t: number): StrokeSample => ({
  position: a.position.map((v, i) => v + (b.position[i] - v) * t) as StrokeSample['position'],
  time: a.time + (b.time - a.time) * t,
});

/** Timed simplification preserves pauses in drawn mode; uniform mode removes hand jitter. */
export function thinStroke(samples: StrokeSample[], pace: StrokePace): StrokeSample[] {
  if (samples.length < 2) return samples.map(p => interpolate(p, p, 0));
  const keep = new Set([0, samples.length - 1]);
  const pending: [number, number][] = [[0, samples.length - 1]];
  while (pending.length) {
    const [first, last] = pending.pop()!;
    const a = samples[first], b = samples[last];
    const delta = b.position.map((v, i) => v - a.position[i]);
    const lengthSq = delta.reduce((sum, v) => sum + v * v, 0);
    let error = TOLERANCE, index = -1;
    for (let i = first + 1; i < last; i++) {
      const p = samples[i];
      const fraction = pace === 'drawn'
        ? (p.time - a.time) / (b.time - a.time || 1)
        : Math.max(0, Math.min(1, delta.reduce((sum, v, axis) => sum + (p.position[axis] - a.position[axis]) * v, 0) / (lengthSq || 1)));
      const gap = distance(p, interpolate(a, b, fraction));
      if (gap > error) { error = gap; index = i; }
    }
    if (index >= 0) { keep.add(index); pending.push([first, index], [index, last]); }
  }
  return [...keep].sort((a, b) => a - b).map(i => interpolate(samples[i], samples[i], 0));
}

/** Half-metre arc spacing, balanced at endpoints. Deliberate corners remain exact;
 * insert a shape point only when a resampled chord would cut more than 3 cm off the route.
 * Stored clips are never passed through this function again. */
export function sampleStroke(samples: StrokeSample[], pace: StrokePace = 'uniform'): StrokeSample[] {
  const points = thinStroke(samples, pace);
  if (pace === 'drawn' || points.length < 2) {
    if (points.length > 256) throw new Error('路线过于复杂，请分成几段绘制');
    return points;
  }
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + distance(points[i - 1], points[i]));
  const total = lengths[lengths.length - 1];
  if (total < 1e-8) return [points[0], points[points.length - 1]];
  const anchors = [0];
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i].position.map((v, axis) => v - points[i - 1].position[axis]);
    const after = points[i + 1].position.map((v, axis) => v - points[i].position[axis]);
    const cosine = before.reduce((sum, v, axis) => sum + v * after[axis], 0) / (Math.hypot(...before) * Math.hypot(...after) || 1);
    if (cosine < Math.SQRT1_2) anchors.push(i);
  }
  anchors.push(points.length - 1);
  const targets = new Set<number>([0, total]);
  for (let i = 1; i < anchors.length; i++) {
    const from = lengths[anchors[i - 1]], span = lengths[anchors[i]] - from;
    const count = Math.max(1, Math.ceil(span / SPACING));
    if (count > 255) throw new Error('路线过长，请分成几段绘制');
    for (let n = 0; n <= count; n++) targets.add(n === count ? lengths[anchors[i]] : from + span * n / count);
  }
  function at(value: number) {
    if (value >= total) return points[points.length - 1];
    const next = lengths.findIndex(length => length >= value);
    if (next <= 0) return points[0];
    return interpolate(points[next - 1], points[next], (value - lengths[next - 1]) / (lengths[next] - lengths[next - 1] || 1));
  }
  // Resolve deviations inside each distance interval without changing the order at crossings.
  const pending = [...targets].sort((a, b) => a - b).slice(1).map((to, i, list) => [i ? list[i - 1] : 0, to] as [number, number]);
  while (pending.length) {
    const [from, to] = pending.pop()!;
    let worst = TOLERANCE, split = -1;
    for (let i = 1; i < points.length - 1; i++) {
      if (lengths[i] <= from + 1e-8 || lengths[i] >= to - 1e-8) continue;
      const error = distance(points[i], interpolate(at(from), at(to), (lengths[i] - from) / (to - from)));
      if (error > worst) { worst = error; split = lengths[i]; }
    }
    if (split >= 0) { targets.add(split); pending.push([from, split], [split, to]); }
    if (targets.size > 256) throw new Error('路线过于复杂，请分成几段绘制');
  }
  if (targets.size > 256) throw new Error('路线过于复杂，请分成几段绘制');
  return [...targets].sort((a, b) => a - b).map(at);
}
