// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { SpatialStructureCandidate } from "./modelStructure.js";
import type { Vec3 } from "./vec3.js";

export interface TaggedStairPart { candidate: SpatialStructureCandidate; alignedBox: boolean }
/** Consolidate only a complete, explicitly tagged, uniform straight flight.
 * This proposes a support proxy, not exact mesh topology or clearance beneath the stairs. */
export function consolidateStairCandidates(candidates: SpatialStructureCandidate[], parts: TaggedStairPart[], incompleteGroups: ReadonlySet<string> = new Set()): SpatialStructureCandidate[] {
  const groups = new Map<string, TaggedStairPart[]>();
  for (const part of parts) {
    const group = part.candidate.group;
    if (group && !incompleteGroups.has(group)) groups.set(group, [...(groups.get(group) ?? []), part]);
  }
  const replacement = new Map<string, SpatialStructureCandidate | null>();
  for (const groupParts of groups.values()) {
    if (groupParts.length < 2 || groupParts.length > 256 || groupParts.some(p => !p.alignedBox)) continue;
    const ordered = groupParts.map(p => p.candidate).sort((a, b) => a.volume.bounds.min[1] - b.volume.bounds.min[1]);
    const first = ordered[0], bounds = first.volume.bounds;
    const rise = bounds.max[1] - bounds.min[1];
    const delta = ordered[1].volume.bounds.min.map((v, i) => v - bounds.min[i]);
    const tolerance = 1e-6 * Math.max(1, ...bounds.max.map((v,i)=>v-bounds.min[i]));
    const near = (a: number, b: number) => Math.abs(a - b) <= tolerance + Number.EPSILON * Math.max(Math.abs(a), Math.abs(b)) * 8;
    const moving = ([0, 2] as const).filter(axis => !near(delta[axis], 0));
    if (moving.length !== 1) continue;
    const axis = moving[0], cross = axis === 0 ? 2 : 0;
    const direction = delta[axis] > 0 ? 1 : -1;
    const going = bounds.max[axis] - bounds.min[axis];
    if (!near(Math.abs(delta[axis]), going)) continue;
    if (!ordered.every((item, index) => {
      const b = item.volume.bounds;
      return near(b.min[1], bounds.min[1] + rise * index)
        && near(b.max[1], bounds.max[1] + rise * index)
        && near(b.min[axis], bounds.min[axis] + direction * going * index)
        && near(b.max[axis], bounds.max[axis] + direction * going * index)
        && near(b.min[cross], bounds.min[cross]) && near(b.max[cross], bounds.max[cross]);
    })) continue;
    const combined = {
      min: [0, 1, 2].map(i => Math.min(...ordered.map(c => c.volume.bounds.min[i]))) as Vec3,
      max: [0, 1, 2].map(i => Math.max(...ordered.map(c => c.volume.bounds.max[i]))) as Vec3,
    };
    const flight: SpatialStructureCandidate = {
      volume: {
        id: `${first.volume.id}:flight`, name: `${first.group} · 直梯（${ordered.length}级）`, role: "floor", bounds: combined,
        surface: { axis: axis === 0 ? "x" : "z", direction, steps: ordered.length },
      },
      group: first.group, evidence: "metadata", recommended: false,
      sourcePartIds: ordered.flatMap(c => c.sourcePartIds),
      composition: { kind: "stair-flight", parts: ordered.length, sourceVolumeIds: ordered.map(c=>c.volume.id) },
      warnings: [`${ordered.length} 个连续等高台阶，单级 ${rise.toFixed(3)} m；请核对上下平台与楼梯洞后采用`, "这是整段楼梯的简化支撑，梯下空域需另行复核"],
    };
    // Stable source order; no duplicate originals alongside the consolidated flight.
    groupParts.forEach((part, index) => replacement.set(part.candidate.volume.id, index === 0 ? flight : null));
  }
  return candidates.flatMap(candidate => replacement.has(candidate.volume.id) ? replacement.get(candidate.volume.id) ?? [] : candidate);
}
