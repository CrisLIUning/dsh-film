// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorAssetRef, DirectorProject } from "./directorProject.js";
import { applyEulerXYZ, type Vec3 } from "./vec3.js";

export interface ModelBounds { min: Vec3; max: Vec3 }
export interface ModelCalibration {
  metresPerUnit: number;
  /** Intrinsic XYZ radians, applied before instance transforms. */
  rotation: Vec3;
  /** Source coordinates, or the centre/bottom centre of the rotated source bounds. */
  anchor: "source" | "center" | "ground-center";
}
export interface CalibrateAssetCommand {
  type: "calibrate_asset";
  assetId: string;
  /** null explicitly restores the historical 2 m fit. */
  calibration: ModelCalibration | null;
  /** Optional measured source AABB, before calibration or instance transforms. */
  bounds?: ModelBounds;
}
const vector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number" && Number.isFinite(x));
export function validateModelBounds(value: unknown): asserts value is ModelBounds {
  const b = value as ModelBounds | undefined;
  if (!b || !vector(b.min) || !vector(b.max) || b.min.some((v, i) => v > b.max[i])) throw new Error("模型包围盒需要有效的 min/max 三维坐标");
}
export function validateModelCalibration(value: unknown): asserts value is ModelCalibration {
  const c = value as ModelCalibration | undefined;
  if (!c || typeof c.metresPerUnit !== "number" || !Number.isFinite(c.metresPerUnit) || c.metresPerUnit <= 0 || !vector(c.rotation) || !["source", "center", "ground-center"].includes(c.anchor)) throw new Error("模型校正需要正数米/单位、XYZ 弧度和有效落点");
}
export function parseCalibrateAsset(value: unknown): CalibrateAssetCommand {
  const raw = value as CalibrateAssetCommand;
  if (!raw || raw.type !== "calibrate_asset" || typeof raw.assetId !== "string" || !raw.assetId.trim()) throw new Error("模型校正需要 assetId");
  if (raw.calibration !== null) validateModelCalibration(raw.calibration);
  if (raw.bounds !== undefined) validateModelBounds(raw.bounds);
  return { type: "calibrate_asset", assetId: raw.assetId, calibration: raw.calibration === null ? null : { ...raw.calibration, rotation: [...raw.calibration.rotation] }, ...(raw.bounds ? { bounds: { min: [...raw.bounds.min], max: [...raw.bounds.max] } } : {}) };
}
export function canCalibrateModel(asset: DirectorAssetRef) {
  return asset.sourceType === "model" && (asset.kind === "scene" || asset.kind === "prop") && !asset.url.startsWith("builtin:");
}

/** A bounding-box transform, shared by renderer and daemon. This is not mesh collision geometry. */
export function resolveModelCalibration(bounds: ModelBounds, calibration?: ModelCalibration) {
  validateModelBounds(bounds);
  if (calibration) validateModelCalibration(calibration);
  const rotation: Vec3 = calibration?.rotation ?? [0, 0, 0];
  const corners = [0,1,2,3,4,5,6,7].map(mask => applyEulerXYZ([0,1,2].map(i => mask & (1 << i) ? bounds.max[i] : bounds.min[i]) as Vec3, rotation));
  const min = [0,1,2].map(i => Math.min(...corners.map(p => p[i]))) as Vec3;
  const max = [0,1,2].map(i => Math.max(...corners.map(p => p[i]))) as Vec3;
  const span = max.map((v,i) => v - min[i]) as Vec3;
  const scale = calibration?.metresPerUnit ?? (Math.max(...span) > 0 ? 2 / Math.max(...span) : 1);
  const anchor = calibration?.anchor ?? "ground-center";
  const pivot = anchor === "source" ? [0,0,0] : min.map((v,i) => anchor === "ground-center" && i === 1 ? v : (v + max[i]) / 2);
  const position = pivot.map(v => -v * scale) as Vec3;
  if (![...position, ...span.map(v => v * scale)].every(Number.isFinite)) throw new Error("校正后的模型尺寸超出可表示范围");
  return { position, rotation, scale, size: span.map(v => v * scale) as Vec3,
    bounds: { min: min.map((v,i) => v * scale + position[i]) as Vec3, max: max.map((v,i) => v * scale + position[i]) as Vec3 } };
}

export function applyModelCalibration(project: DirectorProject, input: CalibrateAssetCommand): DirectorProject {
  const edit = parseCalibrateAsset(input);
  const asset = project.assets.find(a => a.id === edit.assetId);
  if (!asset || !canCalibrateModel(asset) || project.objects.some(o => o.assetRefId === asset.id && o.kind === "character")) throw new Error("请选择静态场景或道具模型；人物骨架尺寸由人物导入流程管理");
  if (project.objects.some(o => o.assetRefId === asset.id && o.locked)) throw new Error("该素材有锁定实例，请先解锁或复制素材后校正");
  if (edit.bounds ?? asset.modelBounds) resolveModelCalibration((edit.bounds ?? asset.modelBounds)!, edit.calibration ?? undefined);
  const updated = { ...asset, ...(edit.bounds ? { modelBounds: edit.bounds } : {}) };
  if (edit.calibration === null) delete updated.modelCalibration;
  else updated.modelCalibration = edit.calibration;
  if (JSON.stringify(updated) === JSON.stringify(asset)) return project;
  return { ...project, assets: project.assets.map(a => a === asset ? updated : a),
    objects: project.objects.some(o=>o.assetRefId===asset.id&&o.spatial) ? project.objects.map(o=>o.assetRefId===asset.id&&o.spatial?{...o,spatialNeedsReview:true}:o) : project.objects };
}
