// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorCharacterActionClip, DirectorObject, DirectorProject } from "./directorProject.js";
import { getObjectMotionActionSample, getObjectMotionClips, getObjectMotionClipTimingPlan, getObjectMotionTimingSample } from "./objectMotion.js";
import { motionClipRate, motionClipSceneSeconds, motionClipSource, motionClipSourceSeconds } from "./motionClipTime.js";
import { validateCharacterActionClips } from "./characterPerformance.js";
import { nextPerformanceClipId } from "./performanceClipEditing.js";
import { getSceneDuration } from "./sceneTime.js";

/** Materialize the current scene's legacy holds below existing full-body overrides.
 * Route geometry/timing stays intact; extracted points relinquish action ownership.
 * A cropped route can hold beyond its end: that frozen continuation is an explicit,
 * editable clip through the next route or scene end, not a hidden route side effect.
 */
export function extractLegacyHoldActions(project: DirectorProject, objectId: string, motionClipId?: string) {
  const object = project.objects.find(item => item.id === objectId);
  if (!object || object.kind !== "character") throw new Error("提取停留动作需要有效人物");
  if (object.locked) throw new Error("人物已锁定");
  const routes = getObjectMotionClips(object);
  if (motionClipId !== undefined && !routes.some(clip => clip.id === motionClipId)) throw new Error("移动片段不存在");
  const actions = [...(object.actionClips ?? [])];
  validateCharacterActionClips(actions);
  const clipIds: string[] = [];
  const changed = new Map<string, Set<string>>();
  const horizon = getSceneDuration(project);
  routes.forEach((route, routeIndex) => {
    if (motionClipId !== undefined && route.id !== motionClipId) return;
    const plan = getObjectMotionClipTimingPlan(route);
    if (!plan || route.keyframes.length < 2) return;
    const source = motionClipSource(route);
    const rate = motionClipRate(route);
    const next = routes.slice(routeIndex + 1).find(clip => clip.keyframes.length > 0)?.start ?? horizon;
    const limit = Math.min(horizon, next);
    let previousDeparture = 0;
    route.keyframes.slice(0, -1).forEach((point, pointIndex) => {
      // Custom timing may overlap holds. The sampler's earlier point wins until
      // its departure; preserve that ownership instead of creating overlaps.
      const begin = Math.max(plan.arrivals[pointIndex], previousDeparture) * source.duration;
      const end = plan.departures[pointIndex] * source.duration;
      previousDeparture = Math.max(previousDeparture, plan.departures[pointIndex]);
      if (point.holdAction === "track" || end <= begin) return;
      const rawAction = point.holdAction === "stand" ? null : point.holdAction === "custom"
        ? point.holdActionPresetId ?? null : route.keyframes[Math.max(0, pointIndex - 1)].actionPresetId ?? null;
      const animationAt = (seconds: number) => point.holdAction === "stand" ? 0 : point.holdAction === "custom"
        ? Math.max(0, motionClipSourceSeconds(route, seconds) - plan.arrivals[pointIndex] * source.duration)
        : route.source ? source.origin + motionClipSourceSeconds(route, seconds) : seconds;
      const add = (start: number, finish: number, continuation: boolean) => {
        if (finish <= start) return;
        const id = nextPerformanceClipId(actions, "hold_action");
        const frozen = continuation || point.holdAction === "stand";
        const actionIn = animationAt(start);
        const actionOut = actionIn + (finish - start) * rate;
        const endSample = getObjectMotionActionSample(object, finish);
        const atEnd = getObjectMotionTimingSample(object, finish);
        const clip: DirectorCharacterActionClip = {
          id, name: `${route.name ?? "路线"} · 停留 ${pointIndex + 1}${continuation ? " · 延续" : ""}`,
          layer: "base", start, end: finish,
          actionId: rawAction ?? object.characterRig?.actionPresetId ?? null,
          source: frozen ? { duration: finish - start, in: 0, out: finish - start }
            : { duration: Math.max(actionOut, point.holdAction === "custom"
              ? end - plan.arrivals[pointIndex] * source.duration : source.origin + source.duration), in: actionIn, out: actionOut },
          ...(frozen ? { freezeAt: actionIn } : {}),
          ...(rawAction === null ? { automaticLocomotion: true } : {}),
          endExclusive: atEnd?.clipIndex !== routeIndex || endSample.holdingPointIndex !== pointIndex,
          loop: true,
        };
        actions.push(clip); clipIds.push(id);
        if (!changed.has(route.id)) changed.set(route.id, new Set());
        changed.get(route.id)!.add(point.id);
      };
      add(Math.max(route.start, motionClipSceneSeconds(route, begin)),
        Math.min(route.end, limit, motionClipSceneSeconds(route, end)), false);
      if (source.out < source.duration && source.out >= begin && source.out < end)
        add(route.end, limit, true);
    });
  });
  if (!clipIds.length) return { project, object, clipIds };
  // Collision with manually authored base clips fails atomically; never drop
  // either the original holds or a user's existing performance to make room.
  validateCharacterActionClips(actions);
  const updated: DirectorObject = {
    ...object, actionClips: actions.sort((a, b) => a.start - b.start),
    motionClips: routes.map(route => !changed.has(route.id) ? route : {
      ...route, keyframes: route.keyframes.map(point => {
        if (!changed.get(route.id)!.has(point.id)) return point;
        const { holdActionPresetId: _old, ...rest } = point;
        return { ...rest, holdAction: "track" as const };
      }),
    }),
  };
  return { project: { ...project, objects: project.objects.map(item => item.id === objectId ? updated : item) }, object: updated, clipIds };
}
