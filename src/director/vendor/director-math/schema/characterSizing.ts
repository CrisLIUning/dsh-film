// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorObject, DirectorProject } from "./directorProject.js";
import { getGroundedLabelY } from "../runtime/mannequin/bodyTypes.js";
import { getUE4GroundedLabelY, getUE4ModelScale } from "../runtime/ue4Mannequin/ue4MannequinBody.js";

export function validateCharacterHeight(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("人物身高必须是正数米值");
}
export function defaultCharacterHeight(bodyType?: DirectorObject["bodyType"]) { return 1.82 * getUE4ModelScale(bodyType)[1]; }
/** Standing reference height before instance/scene transforms; never current crouching pose height. */
export function characterStandingSize(object: DirectorObject) {
  if (object.heightMetres !== undefined) return { height: object.heightMetres, source: "declared" as const, approximate: false };
  if (object.characterRig?.rigType === "mixamo" && object.assetRefId) return { height: 1.8, source: "normalized-import" as const, approximate: false };
  const label = object.characterRig?.rigType === "ue4-mannequin" ? getUE4GroundedLabelY(object.bodyType) : getGroundedLabelY(object.bodyType);
  return { height: label - .22, source: "legacy-estimate" as const, approximate: true };
}
export interface CharacterHeightCommand { type: "set_character_height"; objectIds: string[]; heightMetres: number | null }
export function parseCharacterHeight(value: unknown): CharacterHeightCommand {
  const raw = value as CharacterHeightCommand;
  if (!raw || raw.type !== "set_character_height" || !Array.isArray(raw.objectIds) || !raw.objectIds.length || !raw.objectIds.every(id => typeof id === "string" && id.trim())) throw new Error("人物身高编辑需要 objectIds");
  if (raw.heightMetres !== null) validateCharacterHeight(raw.heightMetres);
  return { type: "set_character_height", objectIds: [...new Set(raw.objectIds)], heightMetres: raw.heightMetres };
}
export function applyCharacterHeight(project: DirectorProject, value: CharacterHeightCommand): DirectorProject {
  const edit = parseCharacterHeight(value);
  for (const id of edit.objectIds) {
    const object = project.objects.find(o => o.id === id);
    if (!object || object.kind !== "character") throw new Error(`人物不存在：${id}`);
    if (object.locked) throw new Error(`人物已锁定：${object.name}`);
  }
  let changed = false;
  const objects = project.objects.map(object => {
    if (!edit.objectIds.includes(object.id) || object.heightMetres === (edit.heightMetres ?? undefined)) return object;
    changed = true;
    const next = { ...object };
    if (edit.heightMetres === null) delete next.heightMetres; else next.heightMetres = edit.heightMetres;
    return next;
  });
  return changed ? { ...project, objects } : project;
}
