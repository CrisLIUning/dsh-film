// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorProject, DirectorTransform } from "./directorProject.js";
import { getDirectorObjectFocusTarget } from "./cameraTarget.js";

export type DirectorAxisPatch = Partial<Record<"x" | "y" | "z", number>>;
/** Absolute values; only named axes change. Rotation is in degrees at the editing boundary. */
export interface DirectorObjectTransformEdit {
  objectIds: string[];
  position?: DirectorAxisPatch;
  rotation?: DirectorAxisPatch;
  scale?: DirectorAxisPatch;
}
const fields = ["position", "rotation", "scale"] as const;
const axes = ["x", "y", "z"] as const;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function parseObjectTransformEdit(value: unknown): DirectorObjectTransformEdit {
  if (!record(value) || !Array.isArray(value.objectIds) || !value.objectIds.length || value.objectIds.some(id => typeof id !== "string" || !id.trim())) {
    throw new Error("objectIds 必须是非空对象 ID 列表");
  }
  const result: DirectorObjectTransformEdit = { objectIds: [...new Set(value.objectIds as string[])] };
  let count = 0;
  for (const field of fields) {
    const patch = value[field];
    if (patch === undefined) continue;
    if (!record(patch) || Object.keys(patch).some(axis => !axes.includes(axis as typeof axes[number]))) throw new Error(`${field} 只能包含 x / y / z`);
    const parsed: DirectorAxisPatch = {};
    for (const axis of axes) {
      if (!(axis in patch)) continue;
      const n = patch[axis];
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${field}.${axis} 必须是有限数字`);
      if (field === "scale" && n <= 0) throw new Error("缩放必须大于 0");
      parsed[axis] = n; count++;
    }
    result[field] = parsed;
  }
  if (!count) throw new Error("至少填写一个要修改的轴");
  return result;
}

/** Shared by the desk and daemon. Never touches motion clips or camera view keyframes. */
export function applyObjectTransformEdit(project: DirectorProject, input: DirectorObjectTransformEdit) {
  const edit = parseObjectTransformEdit(input);
  const ids = new Set(edit.objectIds);
  const missing = edit.objectIds.filter(id => !project.objects.some(object => object.id === id));
  if (missing.length) throw new Error(`对象已不存在：${missing.join("、")}`);
  const changedIds: string[] = [];
  const skippedIds: string[] = [];
  const objects = project.objects.map(object => {
    if (!ids.has(object.id)) return object;
    if (object.locked || object.kind === "panorama") { skippedIds.push(object.id); return object; }
    const transform = { ...object.transform };
    let changed = false;
    for (const field of fields) {
      const patch = edit[field];
      if (!patch) continue;
      transform[field] = object.transform[field].map((old, i) => {
        const requested = patch[axes[i]];
        const next = requested === undefined ? old : field === "rotation" ? requested / 180 * Math.PI : requested;
        if (next !== old) changed = true;
        return next;
      }) as DirectorTransform[typeof field];
    }
    if (!changed) return object;
    changedIds.push(object.id);
    return { ...object, transform };
  });
  if (!changedIds.length) return { project, changedIds, skippedIds };
  const changed = new Map(objects.filter(object => changedIds.includes(object.id)).map(object => [object.id, object]));
  const rigs = new Map([...changed.values()].filter(object => object.kind === "camera" && object.linkedCameraId).map(object => [object.linkedCameraId, object.transform]));
  const cameras = project.cameras.map(camera => {
    const transform = rigs.get(camera.id);
    const subject = camera.targetMode === "object" && camera.targetObjectId ? changed.get(camera.targetObjectId) : undefined;
    return transform || subject ? { ...camera, ...(transform ? { transform } : {}), ...(subject ? { target: getDirectorObjectFocusTarget(subject) } : {}) } : camera;
  });
  return { project: { ...project, objects, cameras }, changedIds, skippedIds };
}
