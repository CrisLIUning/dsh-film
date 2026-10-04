// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type {
  DirectorCharacterLookClip,
  DirectorCharacterLookTarget,
  DirectorProject,
} from "./directorProject.js";
import { validateCharacterLookClips } from "./characterLook.js";
import {
  editPerformanceClip,
  nextPerformanceClipId,
  type PerformanceClipOperation,
} from "./performanceClipEditing.js";
import { parseCharacterActionEdit } from "./characterActionEditing.js";
import { ensureSceneTimeline } from "./sceneTime.js";
export type CharacterLookEdit =
  | {
      type: "set_look_clip";
      objectId: string;
      clipId?: string;
      name?: string;
      start: number;
      end: number;
      target: DirectorCharacterLookTarget;
      source?: DirectorCharacterLookClip["source"];
      blendIn?: number;
      blendOut?: number;
      strength?: number;
      muted?: boolean;
    }
  | ({ type: "edit_look_clip"; objectId: string } & PerformanceClipOperation);
export function parseCharacterLookEdit(raw: unknown): CharacterLookEdit {
  if (!raw || typeof raw !== "object") throw new Error("看向编辑格式无效");
  const v = raw as CharacterLookEdit;
  if (v.type === "edit_look_clip") {
    const op = parseCharacterActionEdit({ ...v, type: "edit_action_clip" });
    if (op.type !== "edit_action_clip") throw new Error("看向编辑格式无效");
    return { ...op, type: "edit_look_clip" };
  }
  if (
    v.type !== "set_look_clip" ||
    typeof v.objectId !== "string" ||
    !v.objectId.trim()
  )
    throw new Error("看向编辑需要有效人物 ID");
  if (v.clipId !== undefined && (typeof v.clipId !== "string" || !v.clipId.trim())) throw new Error("看向片段 ID 无效");
  for (const key of ["blendIn", "blendOut", "strength"] as const) if (v[key] !== undefined && !Number.isFinite(v[key])) throw new Error("看向时长和强度必须是有效数字");
  const duration = v.end - v.start;
  const clip = {
    ...v,
    id: v.clipId ?? "look_new",
    source: v.source ?? { duration, in: 0, out: duration },
    blendIn: v.blendIn ?? 0,
    blendOut: v.blendOut ?? 0,
    strength: v.strength ?? 1,
  };
  validateCharacterLookClips([clip]);
  const t = v.target;
  return {
    type: v.type,
    objectId: v.objectId.trim(),
    start: v.start,
    end: v.end,
    target:
      t.kind === "point"
        ? { kind: "point", position: [...t.position] }
        : { kind: "object", objectId: t.objectId, bodyPart: t.bodyPart },
    ...(v.clipId !== undefined ? { clipId: v.clipId } : {}),
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.source !== undefined ? { source: { ...v.source } } : {}),
    ...(v.blendIn !== undefined ? { blendIn: v.blendIn } : {}),
    ...(v.blendOut !== undefined ? { blendOut: v.blendOut } : {}),
    ...(v.strength !== undefined ? { strength: v.strength } : {}),
    ...(v.muted !== undefined ? { muted: v.muted } : {}),
  };
}
export function editCharacterLook(
  project: DirectorProject,
  raw: CharacterLookEdit,
) {
  const input = parseCharacterLookEdit(raw),
    object = project.objects.find((o) => o.id === input.objectId);
  if (!object || object.kind !== "character")
    throw new Error("看向轨道需要有效人物");
  if (object.locked) throw new Error("人物已锁定");
  const clips = object.lookClips ?? [];
  validateCharacterLookClips(clips);
  let next: DirectorCharacterLookClip[], clipId: string | null;
  if (input.type === "edit_look_clip") {
    const result = editPerformanceClip(clips, input, "look", "看向");
    next = result.clips;
    clipId = result.clipId;
  } else {
    const target = input.target;
    if (
      target.kind === "object" &&
      (target.objectId === object.id ||
        !project.objects.some((o) => o.id === target.objectId && ["character","prop","scene"].includes(o.kind)))
    )
      throw new Error("请选择其他有效对象作为看向目标");
    const old = clips.find((c) => c.id === input.clipId);
    clipId = old?.id ?? nextPerformanceClipId(clips, "look", input.clipId);
    const duration = input.end - input.start;
    const clip: DirectorCharacterLookClip = {
      id: clipId,
      start: input.start,
      end: input.end,
      target: input.target,
      source: input.source ?? old?.source ?? { duration, in: 0, out: duration },
      blendIn: input.blendIn ?? old?.blendIn ?? 0,
      blendOut: input.blendOut ?? old?.blendOut ?? 0,
      strength: input.strength ?? old?.strength ?? 1,
      ...(old?.name ? { name: old.name } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(old?.muted !== undefined ? { muted: old.muted } : {}),
      ...(input.muted !== undefined ? { muted: input.muted } : {}),
    };
    next = [...clips.filter((c) => c.id !== clipId), clip];
  }
  validateCharacterLookClips(next);
  const { lookClips: _prior, ...rest } = object;
  const updated = {
    ...rest,
    ...(next.length
      ? { lookClips: next.sort((a, b) => a.start - b.start) }
      : {}),
  };
  return {
    clipId,
    object: updated,
    project: ensureSceneTimeline({
      ...project,
      objects: project.objects.map((o) => (o.id === object.id ? updated : o)),
    }),
  };
}
