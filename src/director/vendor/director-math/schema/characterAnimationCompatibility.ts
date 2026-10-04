// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type {
  CharacterRigProfile,
  DirectorAnimationAssetRef,
  DirectorAssetRef,
} from "./directorProject.js";

export function normalizeAnimationRigProfile(
  profile: string,
): CharacterRigProfile {
  if (profile === "mixamorig1") return "mixamo-alt";
  if (profile === "generic") return "generic-humanoid";
  if (profile === "mixamo" || profile === "bip" || profile === "cc-base")
    return profile;
  return "unknown";
}

export function areAnimationProfilesCompatible(
  model: CharacterRigProfile,
  animation: CharacterRigProfile,
  hasCompleteBoneMap = false,
) {
  const mixamoProfiles = new Set<CharacterRigProfile>(["mixamo", "mixamo-alt"]);
  if (mixamoProfiles.has(model) && mixamoProfiles.has(animation)) return true;
  if (hasCompleteBoneMap && animation !== "unknown") return true;
  return model !== "unknown" && model === animation;
}

export function isNativeAnimationForCharacter(
  animationAsset: DirectorAnimationAssetRef,
  characterAsset: DirectorAssetRef | undefined,
) {
  if (!characterAsset) return false;
  if (animationAsset.sourceCharacterAssetId)
    return animationAsset.sourceCharacterAssetId === characterAsset.id;
  return (
    animationAsset.url === characterAsset.url &&
    animationAsset.fileName === characterAsset.fileName
  );
}
