/**
 * The agent's `place_model` op for director_stage (C10): put a model file —
 * the film's own, or one anywhere in the workspace — into the scene at its
 * real size, without the agent computing digests or calibrations.
 *
 * `{ type: 'place_model', path, kind?: 'prop'|'scene', at?: [x,z]|[x,y,z],
 * facing?: degrees, metresPerUnit?: >0, size?: { height|width|depth|longest: metres },
 * name?, id?, assetId? }`
 *
 * Two steps, so the stage route can keep its rule that nothing waits between
 * reading the live scene and writing it:
 *
 * 1. {@link prepareModelPlacements} does all the I/O before the scene is read:
 *    it finds the file, measures it in full, hashes it, works out its units,
 *    and copies a workspace file into `film/canvas/models/` (only when it is
 *    not a dry run; a dry run reports the name the copy would get).
 * 2. {@link expandModelPlacements} is synchronous: against the scene just read
 *    it turns each placement into the desk's own ops — `import_asset` (with
 *    the calibration), `calibrate_asset` (the measured bounds, so the size is
 *    stored), `place_asset` and, with a facing, `transform_objects` — reusing
 *    an asset with the same bytes and configuration, as the desk's import does.
 *
 * Units: an explicit `metresPerUnit`, else `size` divided by the matching
 * dimension of the measured box, else the file's own (glTF metres, an FBX's
 * UnitScaleFactor). Otherwise the op is refused with the raw size: an OBJ
 * never gets a guessed unit here.
 * @module dsh-film/director/model-placement
 */

import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { stat } from 'node:fs/promises'
import { importWorkspaceFile, predictWorkspaceImport } from '../canvas/workspace-import.js'
import { digestFile, projectRawUrl, resolveFilmFile } from '../film-files.js'
import { WorkspaceMediaError, resolveWorkspaceFile } from '../media.js'
import { modelFacts } from '../model-files/facts.js'
import { modelTypeOf } from '../model-files/types.js'
import type { ModelBox, ModelFacts, Vec3 } from '../model-files/types.js'
import { FILM_DIR } from '../project.js'
import { DirectorRefusal } from './locate.js'
import { DirectorStageError } from './staging.js'
import type { DirectorProject } from './vendor/director-math/schema/directorProject.js'
import type { ModelCalibration } from './vendor/director-math/schema/modelCalibration.js'
import { modelImportConfiguration } from './vendor/director-math/schema/modelImport.js'

/** The most place_model ops one plan may carry. */
export const MAX_PLACE_MODEL_OPS = 40

const SIZE_KEYS = ['height', 'width', 'depth', 'longest'] as const
type SizeKey = typeof SIZE_KEYS[number]

/** A place_model op as the wire allows it. */
export interface PlaceModelOp {
  type: 'place_model'
  path: string
  kind?: 'prop' | 'scene'
  at: [number, number] | [number, number, number]
  facing?: number
  metresPerUnit?: number
  size?: { key: SizeKey; metres: number }
  name?: string
  id?: string
  assetId?: string
}

/** Where a placement's units came from. */
export type SizeFrom = 'explicit' | 'size' | 'gltf-metres' | 'fbx-unit'

/** One placement after its I/O: the file in the film (or the name it would get), measured and hashed. */
export interface PreparedPlacement {
  op: PlaceModelOp
  /** Film-relative, `/`-separated. */
  filmPath: string
  format: 'glb' | 'fbx' | 'obj'
  byteLength: number
  contentSha256: string
  bounds?: ModelBox
  kind: 'prop' | 'scene'
  metresPerUnit: number
  sizeFrom: SizeFrom
  sizeMetres?: Vec3
  /** A copy of a workspace file was made for this op. */
  imported: boolean
  /** A dry run of a workspace file: the film name its copy would get. */
  wouldImport?: string
}

/** What the answer reports per placement. */
export interface PlacedModel {
  op: number
  path: string
  assetId: string
  objectId: string
  kind: 'prop' | 'scene'
  metresPerUnit: number
  sizeFrom: SizeFrom
  sizeMetres?: Vec3
  imported: boolean
  wouldImport?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Whether a raw op is a place_model. */
export const isPlaceModel = (op: unknown): boolean => isRecord(op) && op.type === 'place_model'

const optionalText = (raw: Record<string, unknown>, key: string, index: number): string | undefined => {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new DirectorStageError(`place_model 的 ${key} 要是非空字符串`, index)
  return value.trim()
}

/**
 * Check one place_model op's shape.
 * @param raw - the op as sent.
 * @param index - its index in the agent's plan.
 * @returns the op.
 */
export function parsePlaceModel(raw: unknown, index: number): PlaceModelOp {
  if (!isRecord(raw)) throw new DirectorStageError('每一步要有 type', index)
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  if (path === '') throw new DirectorStageError('place_model 需要 path：film/…、相对 film/ 的路径，或工作区里的模型文件', index)
  if (raw.kind === 'character') {
    throw new DirectorStageError('place_model 不放人物：带骨架的人物要在导演 tab 的空间库里导入（导演台要检查骨架）；静态模型用 kind prop 或 scene', index)
  }
  if (raw.kind !== undefined && raw.kind !== 'prop' && raw.kind !== 'scene') throw new DirectorStageError('place_model 的 kind 只能是 prop 或 scene', index)
  const at = raw.at ?? [0, 0]
  if (!Array.isArray(at) || (at.length !== 2 && at.length !== 3) || !at.every(finite)) throw new DirectorStageError('place_model 的 at 要是 [x, z] 或 [x, y, z]', index)
  if (raw.facing !== undefined && !finite(raw.facing)) throw new DirectorStageError('place_model 的 facing 要是角度（数字）', index)
  if (raw.metresPerUnit !== undefined && !(finite(raw.metresPerUnit) && raw.metresPerUnit > 0)) throw new DirectorStageError('place_model 的 metresPerUnit 要是正数', index)
  let size: PlaceModelOp['size']
  if (raw.size !== undefined) {
    const entries = isRecord(raw.size) ? Object.entries(raw.size) : []
    const [entry] = entries
    if (entries.length !== 1 || entry === undefined || !(SIZE_KEYS as readonly string[]).includes(entry[0]) || !(finite(entry[1]) && entry[1] > 0)) {
      throw new DirectorStageError('place_model 的 size 只写一项：{ height | width | depth | longest: 米 }', index)
    }
    size = { key: entry[0] as SizeKey, metres: entry[1] }
  }
  if (raw.metresPerUnit !== undefined && size !== undefined) throw new DirectorStageError('place_model 的 metresPerUnit 和 size 只能给一个', index)
  const name = optionalText(raw, 'name', index)
  const id = optionalText(raw, 'id', index)
  const assetId = optionalText(raw, 'assetId', index)
  return {
    type: 'place_model',
    path,
    ...(raw.kind !== undefined ? { kind: raw.kind as 'prop' | 'scene' } : {}),
    at: [...at] as PlaceModelOp['at'],
    ...(raw.facing !== undefined ? { facing: raw.facing as number } : {}),
    ...(raw.metresPerUnit !== undefined ? { metresPerUnit: raw.metresPerUnit as number } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(assetId !== undefined ? { assetId } : {}),
  }
}

const span = (box: ModelBox): Vec3 => box.max.map((value, axis) => value - box.min[axis]!) as Vec3
const metres = (value: number): string => Number(value.toPrecision(4)).toString()

/** Where a placement's file is: the film's own, or a workspace file (outside film/) to copy in. */
type Located =
  | { where: 'film'; filmPath: string; absolute: string; workspacePath: string }
  | { where: 'workspace'; workspacePath: string; absolute: string; resolved: Awaited<ReturnType<typeof resolveWorkspaceFile>> }

/** Find the file a placement names, the way filmPathFor reads the agent's paths. */
async function locate(cwd: string, path: string, index: number): Promise<Located> {
  let clean = path
  if (isAbsolute(clean)) {
    const offset = relative(cwd, clean)
    if (offset === '' || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new DirectorStageError(`${path} 不在这个工作区里`, index)
    clean = offset
  }
  clean = clean.replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '')
  const film = async (filmPath: string): Promise<Located> => {
    try {
      const file = await resolveFilmFile(cwd, filmPath)
      return { where: 'film', filmPath, absolute: file.absolute, workspacePath: `${FILM_DIR}/${filmPath}` }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new DirectorStageError(code === 'ENOENT' ? `影片里没有 ${filmPath}` : `${filmPath} 不是影片里的文件`, index)
    }
  }
  if (clean.startsWith(`${FILM_DIR}/`)) return film(clean.slice(FILM_DIR.length + 1))
  const inFilm = await stat(join(cwd, FILM_DIR, ...clean.split('/'))).then(info => info.isFile(), () => false)
  if (inFilm) return film(clean)
  try {
    const resolved = await resolveWorkspaceFile(cwd, clean, { models: true })
    if (resolved.filmPath !== undefined) return film(resolved.filmPath)
    if (resolved.kind !== 'model') throw new DirectorStageError(`${clean} 不是模型文件（GLB、FBX、OBJ）`, index)
    return { where: 'workspace', workspacePath: resolved.path, absolute: resolved.absolute, resolved }
  } catch (error) {
    if (!(error instanceof WorkspaceMediaError)) throw error
    throw new DirectorStageError(error.problem === 'not-found' ? `工作区里没有模型文件 ${clean}` : error.message, index)
  }
}

/** The units of a placement, or the refusal that names the raw size. */
function unitsOf(op: PlaceModelOp, facts: ModelFacts, index: number): { metresPerUnit: number; sizeFrom: SizeFrom } {
  if (op.metresPerUnit !== undefined) return { metresPerUnit: op.metresPerUnit, sizeFrom: 'explicit' }
  if (op.size !== undefined) {
    if (facts.bounds === undefined) {
      throw new DirectorStageError(`${facts.format === 'fbx' ? 'FBX' : '这个文件'}没有 Host 量得出的尺寸，size 用不上：改给 metresPerUnit${facts.metresPerUnit !== undefined ? `（文件自己声明的是 ${facts.metresPerUnit}）` : ''}`, index)
    }
    const dimensions = span(facts.bounds)
    const raw = op.size.key === 'width' ? dimensions[0] : op.size.key === 'height' ? dimensions[1] : op.size.key === 'depth' ? dimensions[2] : Math.max(...dimensions)
    if (!(raw > 0)) throw new DirectorStageError(`模型在 ${op.size.key} 方向上没有尺寸，换一个方向`, index)
    return { metresPerUnit: op.size.metres / raw, sizeFrom: 'size' }
  }
  if (facts.metresPerUnit !== undefined) return { metresPerUnit: facts.metresPerUnit, sizeFrom: facts.format === 'fbx' ? 'fbx-unit' : 'gltf-metres' }
  const raw = facts.bounds !== undefined ? span(facts.bounds).map(metres).join(' × ') : undefined
  const message = facts.format === 'obj'
    ? `OBJ 不带单位：原始尺寸 ${raw ?? '未知'}（文件单位，宽 × 高 × 深）。给 metresPerUnit（厘米是 0.01，毫米是 0.001）或 size（例如 { height: 1.8 }）`
    : `这个 FBX 没有声明单位（UnitScaleFactor）：给 metresPerUnit（厘米是 0.01）`
  throw new DirectorRefusal(400, 'DIRECTOR_MODEL_UNITS_UNKNOWN', `第 ${index + 1} 步:${message}`, { op: index, ...(facts.bounds !== undefined ? { rawSize: span(facts.bounds) } : {}) })
}

/**
 * Everything a plan's placements need from the disk, before the scene is read.
 * @param rawOps - the agent's plan ops.
 * @param film - the workspace and the film's id.
 * @param options - `dryRun` copies nothing.
 * @returns the placements, by the agent's op index.
 */
export async function prepareModelPlacements(rawOps: readonly unknown[], film: { cwd: string; projectId: string }, options: { dryRun: boolean }): Promise<Map<number, PreparedPlacement>> {
  const indices = rawOps.flatMap((op, index) => isPlaceModel(op) ? [index] : [])
  if (indices.length > MAX_PLACE_MODEL_OPS) throw new DirectorStageError(`一份计划最多 ${MAX_PLACE_MODEL_OPS} 个 place_model`)
  const ops = indices.map(index => [index, parsePlaceModel(rawOps[index], index)] as const)
  const prepared = new Map<number, PreparedPlacement>()
  for (const [index, op] of ops) {
    const found = await locate(film.cwd, op.path, index)
    const type = modelTypeOf(found.absolute) ?? modelTypeOf(found.workspacePath)
    if (type === undefined) throw new DirectorStageError(`${op.path} 不是模型文件（GLB、FBX、OBJ）`, index)
    if (type.format === 'gltf') throw new DirectorStageError(`${op.path} 是 .gltf：它的 .bin 和贴图是单独的文件，先转成 GLB 再放`, index)
    const facts = await modelFacts(found.absolute, found.workspacePath)
    if (!facts.placeable) throw new DirectorStageError(`${op.path} 读不出来，不能放：${facts.problem ?? '文件已损坏'}`, index)
    const units = unitsOf(op, facts, index)
    const kind = op.kind ?? (facts.suggestedKind === 'scene' ? 'scene' : 'prop')
    let filmPath: string
    let absolute = found.absolute
    let imported = false
    let wouldImport: string | undefined
    if (found.where === 'film') {
      filmPath = found.filmPath
    } else if (options.dryRun) {
      filmPath = wouldImport = (await predictWorkspaceImport(film.cwd, found.resolved)).name
    } else {
      const copy = await importWorkspaceFile(film.cwd, found.workspacePath)
      filmPath = copy.file.name
      absolute = join(film.cwd, FILM_DIR, ...filmPath.split('/'))
      imported = copy.created
    }
    const info = await stat(absolute)
    if (info.size <= 0) throw new DirectorStageError(`${op.path} 是空文件`, index)
    prepared.set(index, {
      op,
      filmPath,
      format: type.format,
      byteLength: info.size,
      contentSha256: await digestFile(absolute),
      ...(facts.bounds !== undefined ? { bounds: facts.bounds } : {}),
      kind,
      metresPerUnit: units.metresPerUnit,
      sizeFrom: units.sizeFrom,
      ...(facts.bounds !== undefined ? { sizeMetres: span(facts.bounds).map(value => value * units.metresPerUnit) as Vec3 } : {}),
      imported,
      ...(wouldImport !== undefined ? { wouldImport } : {}),
    })
  }
  return prepared
}

/** The prefixes of the asset and object ids a placement makes up when the op names none. */
export const PLACED_ASSET_PREFIX = 'placed_model_'
export const PLACED_OBJECT_PREFIX = 'placed_obj_'

/** The largest numeric suffix of ids with this prefix. */
function highest(ids: Iterable<string>, prefix: string): number {
  let most = 0
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue
    const suffix = id.slice(prefix.length)
    if (/^\d+$/u.test(suffix)) most = Math.max(most, Number.parseInt(suffix, 10))
  }
  return most
}

/**
 * Turn the plan's placements into the desk's own ops against the scene just
 * read. Synchronous: the stage route calls it between reading the scene and
 * writing it.
 * @param rawOps - the agent's plan ops.
 * @param prepared - the placements, by the agent's op index.
 * @param project - the scene the plan applies to.
 * @param projectId - the film's id, for the files' raw URLs.
 * @returns the expanded ops, the agent's op index of each, and what each placement will make.
 */
export function expandModelPlacements(rawOps: readonly unknown[], prepared: ReadonlyMap<number, PreparedPlacement>, project: DirectorProject, projectId: string): { ops: unknown[]; origin: number[]; placed: PlacedModel[] } {
  // Placements get ids of their own prefixes, which the desk's allocators never hand out
  // (`imported_model_N` and `obj_N` from the highest taken, `obj_N` from the first free),
  // so the agent's own id-less imports and placements anywhere in the plan cannot take
  // one first. Only ids the plan names itself, or the scene already has, are avoided.
  const named = new Set<string>()
  for (const op of rawOps) {
    if (!isRecord(op)) continue
    for (const key of ['id', 'assetId', 'objectId', 'cameraId']) if (typeof op[key] === 'string') named.add(op[key] as string)
  }
  const assetIds = new Set([...project.assets.map(asset => asset.id), ...named])
  const objectIds = new Set([...project.objects.map(object => object.id), ...project.cameras.map(camera => camera.id), ...named])
  let nextAsset = highest(assetIds, PLACED_ASSET_PREFIX) + 1
  let nextObject = highest(objectIds, PLACED_OBJECT_PREFIX) + 1
  const freeAsset = (): string => {
    while (assetIds.has(`${PLACED_ASSET_PREFIX}${nextAsset}`)) nextAsset++
    const id = `${PLACED_ASSET_PREFIX}${nextAsset++}`
    assetIds.add(id)
    return id
  }
  const freeObject = (): string => {
    while (objectIds.has(`${PLACED_OBJECT_PREFIX}${nextObject}`)) nextObject++
    const id = `${PLACED_OBJECT_PREFIX}${nextObject++}`
    objectIds.add(id)
    return id
  }

  const added: Array<{ id: string; contentSha256: string; configuration: string }> = []
  const ops: unknown[] = []
  const origin: number[] = []
  const placed: PlacedModel[] = []
  for (const [index, raw] of rawOps.entries()) {
    const placement = prepared.get(index)
    if (!isPlaceModel(raw) || placement === undefined) {
      ops.push(raw)
      origin.push(index)
      continue
    }
    const { op } = placement
    const calibration = (): ModelCalibration => ({ metresPerUnit: placement.metresPerUnit, rotation: [0, 0, 0], anchor: placement.kind === 'scene' ? 'source' : 'ground-center' })
    const configuration = modelImportConfiguration({ kind: placement.kind, modelFormat: placement.format, modelCalibration: calibration() })
    const existing = project.assets.find(asset => asset.contentSha256 === placement.contentSha256 && modelImportConfiguration(asset) === configuration)
    const earlier = added.find(asset => asset.contentSha256 === placement.contentSha256 && asset.configuration === configuration)
    // The agent's own import of the same bytes and configuration earlier in the plan would be reused under its id.
    const imports = rawOps.slice(0, index).filter((other): other is Record<string, unknown> => isRecord(other) && other.type === 'import_asset'
      && isRecord(other.source) && String(other.source.contentSha256 ?? '').toLowerCase() === placement.contentSha256
      && modelImportConfiguration({ kind: other.kind as never, modelFormat: (other.source as Record<string, unknown>).modelFormat as never, modelCalibration: other.calibration as never }) === configuration)
    if (existing === undefined && earlier === undefined && imports.length > 0 && typeof imports[0]!.assetId !== 'string') {
      throw new DirectorStageError('同一份计划里已经用 import_asset 导入了这个文件：给那个 import_asset 写上 assetId，或者去掉其中一个', index)
    }
    const reused = existing?.id ?? earlier?.id ?? (imports.length > 0 ? imports[0]!.assetId as string : undefined)
    const assetId = reused ?? op.assetId ?? freeAsset()
    const objectId = op.id ?? freeObject()
    const fileName = basename(placement.filmPath)
    ops.push({
      type: 'import_asset',
      assetId,
      name: op.name ?? basename(placement.filmPath, extname(placement.filmPath)),
      kind: placement.kind,
      source: { url: projectRawUrl(projectId, placement.filmPath), fileName, modelFormat: placement.format, byteLength: placement.byteLength, contentSha256: placement.contentSha256 },
      addToScene: false,
      calibration: calibration(),
    })
    origin.push(index)
    // The measured bounds are stored on a new asset only. A reused one has the same bytes and
    // calibration already, and bounds the desk measured itself (exact, where the Host's may be
    // approximate) — or, without bounds, a locked instance that refuses any calibration.
    const lockedOrMeasured = existing !== undefined && (existing.modelBounds != null || project.objects.some(object => object.assetRefId === existing.id && object.locked))
    if (placement.bounds !== undefined && earlier === undefined && !lockedOrMeasured) {
      ops.push({ type: 'calibrate_asset', assetId, calibration: calibration(), bounds: { min: [...placement.bounds.min], max: [...placement.bounds.max] } })
      origin.push(index)
    }
    ops.push({ type: 'place_asset', assetId, at: [...op.at], id: objectId })
    origin.push(index)
    if (op.facing !== undefined) {
      ops.push({ type: 'transform_objects', objectIds: [objectId], rotation: { y: op.facing } })
      origin.push(index)
    }
    if (reused === undefined) added.push({ id: assetId, contentSha256: placement.contentSha256, configuration })
    placed.push({
      op: index,
      path: placement.filmPath,
      assetId,
      objectId,
      kind: placement.kind,
      metresPerUnit: placement.metresPerUnit,
      sizeFrom: placement.sizeFrom,
      ...(placement.sizeMetres !== undefined ? { sizeMetres: placement.sizeMetres } : {}),
      imported: placement.imported,
      ...(placement.wouldImport !== undefined ? { wouldImport: placement.wouldImport } : {}),
    })
  }
  return { ops, origin, placed }
}

/**
 * Run a parse or a staging of the expanded plan, answering a refusal with the
 * agent's own op number instead of the expanded one.
 * @param run - the work.
 * @param origin - the agent's op index of each expanded op.
 * @returns what `run` returns.
 */
export function withAgentOps<T>(run: () => T, origin: readonly number[]): T {
  try {
    return run()
  } catch (error) {
    if (!(error instanceof DirectorStageError) || error.op == null) throw error
    const message = error.message.replace(/^第 \d+ 步:/u, '')
    throw new DirectorStageError(message, origin[error.op] ?? error.op)
  }
}
