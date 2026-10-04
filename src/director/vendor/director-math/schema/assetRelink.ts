// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { parseImportedCharacterActionId } from "./importedCharacterAction.js";
import type { DirectorProject, DirectorModelFormat } from "./directorProject.js";

export interface AssetRelinkCommand {
  type: "relink_asset";
  assetId: string;
  source: { url: string; fileName: string; modelFormat: DirectorModelFormat; contentSha256: string; byteLength: number; storageKey?: string };
  /** Old assets have no digest. Requires an explicit review of the original file. */
  acceptUnverified?: boolean;
}

export function parseAssetRelink(value: unknown): AssetRelinkCommand {
  const raw = value as AssetRelinkCommand;
  const source = raw?.source;
  if (raw?.type !== "relink_asset" || typeof raw.assetId !== "string" || !raw.assetId.trim() || !source
    || typeof source.fileName !== "string" || !source.fileName.trim()
    || typeof source.url !== "string" || !/^(https?:\/\/|\/(?!\/)|blob:|director-asset:\/\/local\/|data:)/.test(source.url)
    || !["glb", "fbx", "obj"].includes(source.modelFormat)
    || typeof source.contentSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(source.contentSha256)
    || !Number.isSafeInteger(source.byteLength) || source.byteLength <= 0
    || source.storageKey !== undefined && (typeof source.storageKey !== "string" || !source.storageKey)
    || raw.acceptUnverified !== undefined && typeof raw.acceptUnverified !== "boolean") throw new Error("重新关联需要有效的模型文件、格式、大小和 SHA256");
  return { type: "relink_asset", assetId: raw.assetId, source: {
    url: source.url, fileName: source.fileName, modelFormat: source.modelFormat,
    contentSha256: source.contentSha256.toLowerCase(), byteLength: source.byteLength,
    ...(source.storageKey !== undefined ? { storageKey: source.storageKey } : {}),
  }, ...(raw.acceptUnverified === true ? { acceptUnverified: true } : {}) };
}

export function relinkAsset(project: DirectorProject, command: AssetRelinkCommand): DirectorProject {
  const edit = parseAssetRelink(command);
  const asset = project.assets.find(a => a.id === edit.assetId);
  if (!asset || asset.sourceType !== "model") throw new Error("要重新关联的模型素材不存在");
  const format = asset.modelFormat ?? asset.fileName.split(".").pop()?.toLowerCase();
  if (format !== edit.source.modelFormat) throw new Error("文件格式与原模型不同，请选择原始文件");
  if (asset.contentSha256 && asset.contentSha256.toLowerCase() !== edit.source.contentSha256) throw new Error("文件内容与原模型不同，不能按同名文件重新关联；请作为新素材导入");
  if (!asset.contentSha256 && !edit.acceptUnverified) throw new Error("原素材没有内容指纹，请确认选择的是原始文件后再关联");
  const linkedAnimationIds = new Set((project.animationAssets ?? []).filter(animation =>
    animation.sourceCharacterAssetId === asset.id && animation.url === asset.url && animation.storageKey === asset.storageKey
  ).map(animation => animation.id));
  const usesAnimation = (action: string | null | undefined) => linkedAnimationIds.has(parseImportedCharacterActionId(action)?.animationAssetId ?? "");
  const locked = project.objects.find(o => o.locked && (o.assetRefId === asset.id
    || usesAnimation(o.characterRig?.actionPresetId) || o.actionClips?.some(clip => usesAnimation(clip.actionId))
    || o.motionClips?.some(clip => clip.keyframes.some(key => usesAnimation(key.actionPresetId) || usesAnimation(key.holdActionPresetId)))));
  if (locked) throw new Error(`素材包含锁定实例：${locked.name}，请先解锁`);
  const resourceVersion = (asset.resourceVersion ?? 0) + 1;
  const replace = <T extends { storageKey?: string; resourceVersion?: number }>(entry: T) => {
    const { storageKey: _previous, ...rest } = entry;
    return { ...rest, ...edit.source, resourceVersion };
  };
  return {
    ...project,
    assets: project.assets.map(a => a === asset ? replace(a) : a),
    animationAssets: project.animationAssets?.map(animation =>
      animation.sourceCharacterAssetId === asset.id && animation.url === asset.url && animation.storageKey === asset.storageKey
        ? { ...replace(animation), modelFormat: animation.modelFormat } : animation),
  };
}
