// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorProject, DirectorObject } from "./directorProject.js";
import { CHARACTER_ACTION_PRESETS, getCharacterActionPreset } from "./characterActionPresets.js";
import {
  areAnimationProfilesCompatible,
  isNativeAnimationForCharacter,
} from "./characterAnimationCompatibility.js";
import { createImportedCharacterActionId } from "./importedCharacterAction.js";
import { isCompleteDirectorCharacterBoneMap } from "./semanticBody.js";
import { BUNDLED_CHARACTER_ACTION_SOURCES, bundledCharacterNativeClips, characterNativeNames, characterNativeClipName, parseLegacyCharacterActionId, referencedLegacyCharacterActions } from "./characterNativeActions.js";

export interface CharacterActionChoice {
  id: string | null;
  label: string;
  duration: number;
  kind: "pose" | "preset" | "imported" | "legacy";
  available: boolean;
  detail: string;
  /** Exact source label. A library dependency is not proof of loaded bytes. */
  renderedAs?: string;
  requiresLibrary?: boolean;
}

export function characterActionCatalog(
  project: DirectorProject,
  object: DirectorObject,
): CharacterActionChoice[] {
  if (object.kind !== "character") return [];
  const asset = project.assets.find((a) => a.id === object.assetRefId);
  const rig = object.characterRig?.rigType;
  const importedRig = rig === "mixamo";
  const ready = (asset?.characterImportReadiness ?? "ready") === "ready";
  const native = (project.animationAssets ?? []).filter((a) =>
    isNativeAnimationForCharacter(a, asset),
  );
  const isGlb =
    asset?.modelFormat === "glb" || /\.glb(?:$|[?#])/i.test(asset?.url ?? "");
  const names = characterNativeNames(asset);
  const profile =
    asset?.characterRigProfile ??
    (importedRig ? "mixamo" : rig === "ue4-mannequin" ? "bip" : "unknown");
  const result: CharacterActionChoice[] = [
    {
      id: null,
      label: "基础姿势",
      duration: 2,
      kind: "pose",
      available: true,
      detail: "保持保存的姿势；走位继续，自动行走动作在此段被覆盖",
    },
  ];
  const ids = [...CHARACTER_ACTION_PRESETS.map(p => p.id), ...referencedLegacyCharacterActions(object)];
  for (const id of ids) {
    const preset = getCharacterActionPreset(id)!;
    const legacy = parseLegacyCharacterActionId(id);
    const name = characterNativeClipName(id, names);
    const clip = importedRig && isGlb && name
      ? (native.length ? native.flatMap(a => a.clips) : bundledCharacterNativeClips(asset)).find(c => c.name.toLowerCase() === name) : undefined;
    const hasLibrarySource = Boolean(preset.mixamoAnimationFile) && (preset.id !== "crouch-cycle" || Boolean(legacy));
    const available = !importedRig || Boolean(clip) || (ready && hasLibrarySource);
    const source = clip?.name ?? (importedRig && hasLibrarySource ? preset.mixamoAnimationFile : undefined);
    const detail = !available
      ? !ready ? "人物骨架尚未完成适配；仅可使用当前模型自带动作"
        : "当前人物没有匹配的蹲下起立动画，请导入兼容动作；坐下起立不会替代蹲下"
      : clip ? `当前模型实际播放：${clip.name}`
        : importedRig ? "需要随应用提供的本地动作库；导出前检查实际预览" : "内置人偶动作";
    const library = BUNDLED_CHARACTER_ACTION_SOURCES[preset.mixamoAnimationFile as keyof typeof BUNDLED_CHARACTER_ACTION_SOURCES];
    result.push({
      id,
      label: legacy ? `旧版保留 · ${preset.label}` : preset.label,
      duration: clip?.duration ?? (importedRig ? library?.duration ?? preset.mixamoDuration ?? preset.duration : preset.duration),
      kind: legacy ? "legacy" : "preset",
      available,
      detail: legacy ? `保留旧工程表演；${detail}` : detail,
      ...(source ? { renderedAs: source } : {}),
      ...(importedRig && !clip && hasLibrarySource ? { requiresLibrary: true } : {}),
    });
  }
  for (const animation of project.animationAssets ?? []) {
    const compatible =
      importedRig &&
      Boolean(asset) &&
      (isNativeAnimationForCharacter(animation, asset) ||
        (ready &&
          areAnimationProfilesCompatible(
            profile,
            animation.rigProfile,
            isCompleteDirectorCharacterBoneMap(asset?.characterBoneMap),
          )));
    for (const clip of animation.clips)
      result.push({
        id: createImportedCharacterActionId(animation.id, clip.id),
        label: `${animation.name} · ${clip.name}`,
        duration: clip.duration,
        kind: "imported",
        available:
          compatible && clip.duration > 0 && Number.isFinite(clip.duration),
        renderedAs: clip.name,
        detail: compatible
          ? `${clip.duration.toFixed(2)} 秒 · ${animation.rigProfile}`
          : !importedRig
            ? "当前内置人偶不能直接播放导入骨架动画"
            : "动作与人物骨架不兼容，请先完成适配",
      });
  }
  return result;
}

export function requireCharacterAction(
  project: DirectorProject,
  object: DirectorObject,
  id: string | null,
) {
  const choice = characterActionCatalog(project, object).find(
    (action) => action.id === id,
  );
  if (!choice) throw new Error("动作不存在；请从当前人物的动作目录选择");
  if (!choice.available) throw new Error(choice.detail);
  return choice;
}
