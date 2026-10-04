// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorProject, DirectorAssetRef, DirectorAnimationClipRef, CharacterRigProfile, DirectorModelFormat } from "./directorProject.js";
import { parseAssetRelink } from "./assetRelink.js";
import { createSceneObjectFromAsset, getNextSequentialId } from "./assetPlacement.js";
import { validateCharacterHeight } from "./characterSizing.js";
import { validateModelCalibration, type ModelCalibration } from "./modelCalibration.js";
import { isCompleteDirectorCharacterBoneMap, DIRECTOR_CHARACTER_BONE_PART_OPTIONS, type DirectorCharacterBoneMap } from "./semanticBody.js";

export interface ImportModelCommand {
  type: "import_asset";
  assetId?: string;
  name: string;
  kind: "character" | "prop" | "scene";
  source: { url: string; fileName: string; modelFormat: DirectorModelFormat; byteLength: number; contentSha256: string; storageKey?: string };
  addToScene?: boolean;
  position?: [number, number, number];
  calibration?: ModelCalibration;
  character?: { heightMetres: number; rigProfile: CharacterRigProfile; readiness: "ready" | "native-only"; orientation: [number,number,number]; boneMap: DirectorCharacterBoneMap };
  animations?: DirectorAnimationClipRef[];
}
const vector = (value: unknown) => Array.isArray(value) && value.length === 3 && value.every(v => typeof v === "number" && Number.isFinite(v));
export function parseImportModel(value: unknown): ImportModelCommand {
  const raw = value as ImportModelCommand;
  if (!raw || raw.type !== "import_asset" || !["character","prop","scene"].includes(raw.kind)
    || typeof raw.name !== "string" || !raw.name.trim()
    || raw.assetId !== undefined && (typeof raw.assetId !== "string" || !raw.assetId.trim())
    || raw.addToScene !== undefined && typeof raw.addToScene !== "boolean"
    || raw.position !== undefined && !vector(raw.position)) throw new Error("导入需要名称、模型用途和有效放置位置");
  if (raw.animations !== undefined && !Array.isArray(raw.animations)) throw new Error("内嵌动作必须是数组");
  const { source } = parseAssetRelink({type:"relink_asset",assetId:"import",source:raw.source});
  if (raw.calibration !== undefined) validateModelCalibration(raw.calibration);
  if (raw.kind === "character") {
    if (raw.calibration !== undefined) throw new Error("人物请使用站立身高和骨架朝向，静态尺寸校准仅用于场景和道具");
    const c = raw.character;
    if (!c || source.modelFormat === "obj" || !["mixamo","mixamo-alt","bip","cc-base","generic-humanoid","unknown"].includes(c.rigProfile)
      || !["ready","native-only"].includes(c.readiness) || !vector(c.orientation)
      || !c.boneMap || typeof c.boneMap !== "object" || Array.isArray(c.boneMap)) throw new Error("人物导入需要已检查的骨架、朝向和身高");
    validateCharacterHeight(c.heightMetres);
    if (Object.entries(c.boneMap).some(([part,name]) => !DIRECTOR_CHARACTER_BONE_PART_OPTIONS.some(p => p.value === part) || typeof name !== "string" || !name.trim())) throw new Error("人物骨骼映射无效");
    if (c.readiness === "ready" && !isCompleteDirectorCharacterBoneMap(c.boneMap)) throw new Error("请补全人物的 15 个身体部位映射，或使用仅自带动作模式");
  } else if (raw.character || raw.animations?.length) throw new Error("静态模型不使用人物骨架或动作配置");
  const ids = new Set<string>();
  for (const clip of raw.animations ?? []) {
    if (!clip || typeof clip.id !== "string" || !clip.id || ids.has(clip.id) || typeof clip.name !== "string" || !clip.name.trim()
      || !Number.isFinite(clip.duration) || clip.duration <= 0.05 || !Number.isSafeInteger(clip.trackCount) || clip.trackCount < 1) throw new Error("内嵌动作需要唯一 ID、名称、时长和轨道数");
    ids.add(clip.id);
  }
  if (raw.character?.readiness === "native-only" && !raw.animations?.length) throw new Error("仅自带动作模式需要可播放的内嵌动作");
  return {type:"import_asset",name:raw.name.trim(),kind:raw.kind,source,
    ...(raw.assetId ? {assetId:raw.assetId} : {}), ...(raw.addToScene !== undefined ? {addToScene:raw.addToScene} : {}),
    ...(raw.position ? {position:[...raw.position] as [number,number,number]} : {}),
    ...(raw.calibration ? {calibration:{...raw.calibration,rotation:[...raw.calibration.rotation] as [number,number,number]}} : {}),
    ...(raw.character ? {character:{...raw.character,orientation:[...raw.character.orientation] as [number,number,number],boneMap:{...raw.character.boneMap}}} : {}),
    ...(raw.animations ? {animations:raw.animations.map(clip => ({...clip}))} : {})};
}
/** Import configuration has its own identity; the digest identifies bytes only. */
export function modelImportConfiguration(asset: Partial<DirectorAssetRef>) {
  const map = Object.entries(asset.characterBoneMap ?? {}).sort(([a],[b]) => a.localeCompare(b));
  const c = asset.modelCalibration;
  return JSON.stringify([asset.kind,asset.modelFormat,c ? [c.metresPerUnit,c.rotation,c.anchor] : null,asset.characterHeightMetres,
    asset.characterRigProfile,asset.characterImportReadiness,asset.characterOrientationCorrection,map]);
}
export function importModelAsset(project: DirectorProject, command: ImportModelCommand) {
  const edit = parseImportModel(command);
  const character = edit.character;
  const candidate: DirectorAssetRef = {
    id: edit.assetId ?? getNextSequentialId(project.assets.map(a => a.id),"imported_model_"),
    name:edit.name, kind:edit.kind, sourceType:"model", assetSource: edit.source.storageKey || /^(blob:|data:)/.test(edit.source.url) ? "local" : "library", ...edit.source,
    ...(edit.calibration ? {modelCalibration:edit.calibration} : {}),
    ...(character ? {characterHeightMetres:character.heightMetres,characterRigProfile:character.rigProfile,characterImportReadiness:character.readiness,characterOrientationCorrection:character.orientation,characterBoneMap:character.boneMap} : {}),
  };
  const found = project.assets.find(a => a.contentSha256 === candidate.contentSha256 && modelImportConfiguration(a) === modelImportConfiguration(candidate));
  if (!found && project.assets.some(a => a.id === candidate.id)) throw new Error("素材 ID 已被另一份模型占用");
  const asset = found ?? candidate;
  let animationAssetId: string | null = null;
  let animationAssets = project.animationAssets;
  if (character && edit.animations?.length) {
    const foundAnimation = animationAssets?.find(a => a.sourceCharacterAssetId === asset.id && a.contentSha256 === asset.contentSha256 && a.rigProfile === character.rigProfile && JSON.stringify(a.clips) === JSON.stringify(edit.animations));
    animationAssetId = foundAnimation?.id ?? getNextSequentialId((animationAssets ?? []).map(a => a.id),"imported_animation_");
    if (!foundAnimation) animationAssets = [...animationAssets ?? [], {id:animationAssetId,name:`${asset.name} 自带动作`,fileName:asset.fileName,url:asset.url,
      modelFormat:asset.modelFormat as "glb"|"fbx",contentSha256:asset.contentSha256,byteLength:asset.byteLength,
      ...(asset.storageKey ? {storageKey:asset.storageKey} : {}),...(asset.resourceVersion !== undefined ? {resourceVersion:asset.resourceVersion} : {}),
      rigProfile:character.rigProfile,sourceCharacterAssetId:asset.id,clips:edit.animations}];
  }
  const object = edit.addToScene === false ? null : createSceneObjectFromAsset(asset, project.objects, {position:edit.position});
  return {project:{...project,assets:found ? project.assets : [...project.assets,asset],...(animationAssets ? {animationAssets} : {}),objects:object ? [...project.objects,object] : project.objects},assetId:asset.id,objectId:object?.id ?? null,animationAssetId,reused:Boolean(found)};
}
