// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { CharacterRigProfile, DirectorAnimationAssetRef, DirectorAnimationClipRef, DirectorProject } from "./directorProject.js";
import { parseAssetRelink } from "./assetRelink.js";
import { getNextSequentialId } from "./assetPlacement.js";
import { createImportedCharacterActionId } from "./importedCharacterAction.js";

/** Register inspected skeletal motion bytes, independently of character geometry.
 * Rig/clip metadata comes from inspection; this operation does not certify motion quality.
 */
export interface ImportAnimationCommand {
  type: "import_animation";
  animationAssetId?: string;
  name: string;
  source: { url: string; fileName: string; modelFormat: "glb" | "fbx"; byteLength: number; contentSha256: string; storageKey?: string };
  rigProfile: CharacterRigProfile;
  /** Only for clips embedded in this exact, already registered character file. */
  sourceCharacterAssetId?: string;
  clips: DirectorAnimationClipRef[];
}

export function parseImportAnimation(value: unknown): ImportAnimationCommand {
  const raw = value as ImportAnimationCommand;
  if (!raw || raw.type !== "import_animation" || typeof raw.name !== "string" || !raw.name.trim()
    || raw.animationAssetId !== undefined && (typeof raw.animationAssetId !== "string" || !raw.animationAssetId.trim())
    || raw.sourceCharacterAssetId !== undefined && (typeof raw.sourceCharacterAssetId !== "string" || !raw.sourceCharacterAssetId.trim())
    || !["mixamo", "mixamo-alt", "bip", "cc-base", "generic-humanoid", "unknown"].includes(raw.rigProfile)) {
    throw new Error("动作导入需要名称和已检查的骨架类型；无法识别的骨架请标记 unknown");
  }
  const { source } = parseAssetRelink({ type: "relink_asset", assetId: "animation", source: raw.source });
  if (source.modelFormat !== "glb" && source.modelFormat !== "fbx") throw new Error("动作文件仅支持 GLB / FBX；BVH 需要先转换并检查骨架");
  if (!Array.isArray(raw.clips) || !raw.clips.length || raw.clips.length > 256) throw new Error("动作导入需要 1–256 个已检查的动作片段");
  const ids = new Set<string>();
  const clips = raw.clips.map(clip => {
    if (!clip || typeof clip.id !== "string" || !clip.id.trim() || ids.has(clip.id)
      || typeof clip.name !== "string" || !clip.name.trim() || !Number.isFinite(clip.duration) || clip.duration <= 0.05
      || !Number.isSafeInteger(clip.trackCount) || clip.trackCount < 1) throw new Error("动作片段需要唯一 ID、名称、有效时长和轨道数");
    ids.add(clip.id);
    return { id: clip.id, name: clip.name, duration: clip.duration, trackCount: clip.trackCount };
  });
  return { type: "import_animation", name: raw.name.trim(), source: { ...source, modelFormat: source.modelFormat }, rigProfile: raw.rigProfile, clips,
    ...(raw.animationAssetId ? { animationAssetId: raw.animationAssetId } : {}),
    ...(raw.sourceCharacterAssetId ? { sourceCharacterAssetId: raw.sourceCharacterAssetId } : {}) };
}

function configuration(asset: DirectorAnimationAssetRef) {
  return JSON.stringify([asset.modelFormat, asset.rigProfile, asset.sourceCharacterAssetId ?? null,
    asset.clips.map(clip => [clip.id, clip.name, clip.duration, clip.trackCount])]);
}

export function importAnimationAsset(project: DirectorProject, command: ImportAnimationCommand) {
  const edit = parseImportAnimation(command);
  if (edit.sourceCharacterAssetId) {
    const character = project.assets.find(asset => asset.id === edit.sourceCharacterAssetId);
    if (!character || character.kind !== "character" || character.sourceType !== "model"
      || character.contentSha256 !== edit.source.contentSha256 || character.modelFormat !== edit.source.modelFormat) {
      throw new Error("自带动作必须来自已登记人物的同一份模型文件，独立生成动作不要填写 sourceCharacterAssetId");
    }
  }
  const assets = project.animationAssets ?? [];
  const candidate: DirectorAnimationAssetRef = {
    id: edit.animationAssetId ?? getNextSequentialId(assets.map(asset => asset.id), "imported_animation_"),
    name: edit.name, ...edit.source, rigProfile: edit.rigProfile, clips: edit.clips,
    ...(edit.sourceCharacterAssetId ? { sourceCharacterAssetId: edit.sourceCharacterAssetId } : {}),
  };
  const matches = (asset: DirectorAnimationAssetRef) => asset.contentSha256 === candidate.contentSha256 && configuration(asset) === configuration(candidate);
  const occupied = assets.find(asset => asset.id === candidate.id);
  if (edit.animationAssetId && occupied && !matches(occupied)) throw new Error("动作素材 ID 已被其他文件或骨架配置占用");
  const existing = assets.find(matches);
  const asset = existing ?? candidate;
  return { project: existing ? project : { ...project, animationAssets: [...assets, asset] },
    animationAssetId: asset.id, reused: Boolean(existing), actionIds: asset.clips.map(clip => createImportedCharacterActionId(asset.id, clip.id)) };
}
