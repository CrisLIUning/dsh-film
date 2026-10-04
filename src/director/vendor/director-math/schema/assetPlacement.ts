// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { defaultCharacterHeight, validateCharacterHeight } from "./characterSizing.js";
import type { DirectorAssetRef, DirectorObject } from "./directorProject.js";

const ADDED_MODEL_WORLD_SPACING = 1.25;

export function getNextSequentialId(existingIds: string[], prefix: string, minimumIndex = 1) {
  let maxIndex = minimumIndex - 1;

  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue;

    const suffix = id.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;

    maxIndex = Math.max(maxIndex, Number.parseInt(suffix, 10));
  }

  return `${prefix}${maxIndex + 1}`;
}

export function getAddedModelColumnOffset(index: number) {
  const side = index % 2 === 1 ? -1 : 1;
  const step = Math.ceil(index / 2);

  return side * step * ADDED_MODEL_WORLD_SPACING;
}

/** One asset reference may have many scene instances; geometry and rig metadata remain on the asset. */
export function createSceneObjectFromAsset(asset: DirectorAssetRef, existingObjects: DirectorObject[], options: { position?: [number, number, number]; id?: string } = {}) {
  if (asset.sourceType !== "model" || asset.kind === "panorama") throw new Error("该素材不能作为场景模型放置");
  if (options.position && (options.position.length !== 3 || !options.position.every(Number.isFinite))) throw new Error("放置位置必须是三个有限数字");
  if (options.id !== undefined && (!options.id.trim() || existingObjects.some(object => object.id === options.id))) throw new Error("对象 ID 为空或已存在");
  const nextObjectId = options.id ?? getNextSequentialId(
    existingObjects.map((item) => item.id),
    "obj_",
    existingObjects.length + 1
  );

  const sameKindCount = existingObjects.filter((item) => item.kind === asset.kind).length;
  const initialPosition: [number, number, number] = asset.kind === "character" && sameKindCount > 0
    ? [getAddedModelColumnOffset(sameKindCount), 0, 0]
    : [0, 0, 0];
  const object = {
    id: nextObjectId,
    name: asset.name ?? asset.fileName.replace(/\.(fbx|obj|glb|gltf)$/i, ""),
    kind: asset.kind,
    visible: true,
    locked: false,
    assetRefId: asset.id,
    color: "#ffffff",
    transform: { position: [...(options.position ?? initialPosition)] as [number, number, number], rotation: [0, 0, 0], scale: [1, 1, 1] },
  } satisfies DirectorObject;

  if (asset.kind !== "character") return object;

  const heightMetres = asset.characterHeightMetres ?? defaultCharacterHeight();
  validateCharacterHeight(heightMetres);
  return {
    ...object,
    heightMetres,
    bodyType: "mannequin",
    characterRig: {
      rigType: "mixamo",
      posePresetId: "stand",
      actionPresetId: null,
      controls: {},
    },
  } satisfies DirectorObject;
}

