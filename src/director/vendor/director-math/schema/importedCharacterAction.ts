// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
const IMPORTED_ACTION_PREFIX = "imported-action:";

export function createImportedCharacterActionId(animationAssetId: string, clipId: string) {
  return `${IMPORTED_ACTION_PREFIX}${encodeURIComponent(animationAssetId)}:${encodeURIComponent(clipId)}`;
}

export function parseImportedCharacterActionId(actionId: string | null | undefined) {
  if (!actionId?.startsWith(IMPORTED_ACTION_PREFIX)) return null;
  const payload = actionId.slice(IMPORTED_ACTION_PREFIX.length);
  const separator = payload.indexOf(":");
  if (separator < 1 || separator === payload.length - 1) return null;

  try {
    return {
      animationAssetId: decodeURIComponent(payload.slice(0, separator)),
      clipId: decodeURIComponent(payload.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}
