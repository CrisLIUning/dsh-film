/**
 * The disk side of the procedural model record: hashing what a model is made
 * of, and keeping `film/models/<id>/model.json` honest. Ported from Studio's
 * apps/daemon/src/model-project.ts, with the workspace's `film/` folder as the
 * Studio project.
 *
 * Every read and write resolves through the film folder's real path, so a
 * model's source, textures and record follow the same symlink-escape rule as
 * any other project file: a model is not a special case that gets to read
 * outside the film it belongs to. The contract copy in ./contracts owns the
 * record's shape and the version arithmetic; this owns the files.
 * @module dsh-film/modeling/store
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { filmWriteTarget } from '../film-files.js'
import { FILM_DIR } from '../project.js'
import {
  canonicalModelInputs, diffModelInputs, isModelId, isProjectRelativePath, modelArtifactFreshness, modelRecordPath,
  normalizeModelProjectRecord,
} from './contracts/model-project.js'
import type {
  ModelBundleRef, ModelContentRef, ModelInputs, ModelInputsDiff, ModelKind, ModelProjectRecord, ModelReviewNote,
  ModelRunKind, ModelRunRecord, ModelVersionRecord,
} from './contracts/model-project.js'

/**
 * SHA-256 of a text or bytes, hex.
 * @param value - what to hash.
 * @returns the digest.
 */
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** A film file as read: its film-relative path, bytes and size. */
export interface FilmFile {
  path: string
  buffer: Buffer
  size: number
}

const filmRoot = (cwd: string): string => join(cwd, FILM_DIR)

/** `inner` is `outer` or below it (both real paths). */
function within(outer: string, inner: string, allowSame: boolean): boolean {
  const offset = relative(outer, inner)
  if (offset === '') return allowSame
  return !offset.startsWith('..') && !isAbsolute(offset)
}

/**
 * The absolute path of a film-relative path. The path must already be a
 * project-relative POSIX path (no traversal, scheme or backslash).
 * @param cwd - the workspace directory.
 * @param name - the film-relative path.
 * @returns the absolute path, not yet resolved through links.
 */
export function filmFilePath(cwd: string, name: string): string {
  if (!isProjectRelativePath(name)) throw new Error(`不是项目内相对路径：${name}`)
  return join(filmRoot(cwd), ...name.split('/'))
}

/**
 * Read a regular file inside the film, refusing one that resolves outside it.
 * @param cwd - the workspace directory.
 * @param name - the film-relative path.
 * @returns the file.
 * @throws when the file is absent, not a regular file, or escapes the film.
 */
export async function readFilmFile(cwd: string, name: string): Promise<FilmFile> {
  const target = filmFilePath(cwd, name)
  const [root, real] = await Promise.all([realpath(filmRoot(cwd)), realpath(target)])
  if (!within(root, real, false)) throw Object.assign(new Error(`${name} 在项目之外`), { code: 'EACCES' })
  const info = await stat(real)
  if (!info.isFile()) throw Object.assign(new Error(`${name} 不是文件`), { code: 'ENOENT' })
  const buffer = await readFile(real)
  return { path: name, buffer, size: buffer.length }
}

/**
 * Write a file inside the film atomically (a temporary file renamed over the
 * target), refusing a parent folder that resolves outside the film and a
 * target that is a link or a folder.
 * @param cwd - the workspace directory.
 * @param name - the film-relative path.
 * @param data - the content.
 */
export async function writeFilmFile(cwd: string, name: string, data: string | Uint8Array): Promise<void> {
  filmFilePath(cwd, name)
  // The parent is proven inside the film before any folder is made, and again after.
  const target = await filmWriteTarget(cwd, name).catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'EPATHESCAPE' ? Object.assign(new Error(`${name} 在项目之外`), { code: 'EACCES' }) : error
  })
  const existing = await lstat(target).catch(() => undefined)
  if (existing !== undefined && !existing.isFile()) throw Object.assign(new Error(`${name} 不是普通文件`), { code: 'EEXIST' })
  const temporary = join(dirname(target), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, data)
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * The entries of a folder inside the film, or `null` when it is absent or escapes.
 * @param cwd - the workspace directory.
 * @param name - the film-relative folder.
 * @returns its sub-folders and files, by name.
 */
export async function listFilmFolder(cwd: string, name: string): Promise<{ dirs: string[]; files: string[] } | null> {
  try {
    const [root, real] = await Promise.all([realpath(filmRoot(cwd)), realpath(filmFilePath(cwd, name))])
    if (!within(root, real, false)) return null
    const entries = await readdir(real, { withFileTypes: true })
    return {
      dirs: entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),
      files: entries.filter(entry => entry.isFile()).map(entry => entry.name).sort(),
    }
  } catch {
    return null
  }
}

/* ── inputs and version identity ───────────────────────────────────────── */

/** What a caller asks to be hashed into a version. */
export interface ModelInputSpec {
  entry: string
  /** The bundler's transitive closure, film-relative. Must contain `entry`. */
  sources: string[]
  /** Runtime assets the model loads by URL: textures, GLB references. */
  resources: string[]
  parameters: Record<string, unknown>
  toolchain: ModelInputs['toolchain']
}

export interface CollectedModelInputs {
  inputs: ModelInputs
  versionId: string
  /** Declared but absent. Reported, never silently dropped: a missing texture is a real result. */
  missing: string[]
}

/**
 * Hash every declared input and derive the version id. A path that is not
 * film-relative is refused outright rather than resolved: the version must not
 * depend on a file nothing would carry when the project moves.
 * @param cwd - the workspace directory.
 * @param spec - entry, sources, resources, parameters and toolchain.
 * @returns the inputs, their version id and what was missing.
 */
export async function collectModelInputs(cwd: string, spec: ModelInputSpec): Promise<CollectedModelInputs> {
  if (!isProjectRelativePath(spec.entry)) throw new Error(`模型入口必须是项目内相对路径：${spec.entry}`)
  const sourceNames = [...new Set([spec.entry, ...spec.sources])]
  const resourceNames = [...new Set(spec.resources)]
  for (const name of [...sourceNames, ...resourceNames]) {
    if (!isProjectRelativePath(name)) throw new Error(`模型输入必须是项目内相对路径：${name}`)
  }
  const missing: string[] = []
  const gather = async (names: string[]): Promise<ModelContentRef[]> => {
    const refs: ModelContentRef[] = []
    for (const name of names) {
      // ENOENT, a link that escapes, a folder: all "not a usable input".
      const file = await readFilmFile(cwd, name).catch(() => null)
      if (file === null) missing.push(name)
      else refs.push({ path: file.path, sha256: sha256(file.buffer), bytes: file.size })
    }
    return refs
  }
  const sources = await gather(sourceNames)
  const resources = await gather(resourceNames)
  const inputs: ModelInputs = { entry: spec.entry, sources, resources, parameters: spec.parameters ?? {}, toolchain: spec.toolchain }
  return { inputs, versionId: sha256(canonicalModelInputs(inputs)), missing }
}

/* ── the record file ───────────────────────────────────────────────────── */

/**
 * Read a model's record, normalised; `null` when it is absent, unreadable or invalid.
 * @param cwd - the workspace directory.
 * @param modelId - the model id.
 * @returns the record.
 */
export async function readModelRecord(cwd: string, modelId: string): Promise<ModelProjectRecord | null> {
  if (!isModelId(modelId)) return null
  try {
    const file = await readFilmFile(cwd, modelRecordPath(modelId))
    const record = normalizeModelProjectRecord(JSON.parse(file.buffer.toString('utf8')))
    // A record naming another model is not this folder's record: writing it back would land in the other model's folder.
    return record?.id === modelId ? record : null
  } catch {
    return null
  }
}

/**
 * Write a model's record, normalised on the way out as on the way in.
 * @param cwd - the workspace directory.
 * @param record - the record.
 */
export async function writeModelRecord(cwd: string, record: ModelProjectRecord): Promise<void> {
  const normalized = normalizeModelProjectRecord(record)
  if (normalized === null) throw new Error('模型记录不合法，拒绝写入')
  await writeFilmFile(cwd, modelRecordPath(normalized.id), `${JSON.stringify(normalized, null, 2)}\n`)
}

const updates = new Map<string, Promise<unknown>>()

/**
 * Read, change and write one model's record, one change at a time per model,
 * so two writers (the panel and the agent) cannot clobber each other.
 * @param cwd - the workspace directory.
 * @param modelId - the model id.
 * @param mutate - returns the new record (or `null` to write nothing) and a value.
 * @returns the value.
 */
export async function updateModelRecord<T>(
  cwd: string,
  modelId: string,
  mutate: (record: ModelProjectRecord | null) => Promise<{ record: ModelProjectRecord | null; value: T }> | { record: ModelProjectRecord | null; value: T },
): Promise<T> {
  const key = filmFilePath(cwd, modelRecordPath(modelId))
  const previous = updates.get(key) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    const { record, value } = await mutate(await readModelRecord(cwd, modelId))
    if (record !== null && record.id !== modelId) throw new Error(`模型记录 ${record.id} 不属于 ${modelId}，拒绝写入`)
    if (record !== null) await writeModelRecord(cwd, record)
    return value
  })
  updates.set(key, task)
  try {
    return await task
  } finally {
    if (updates.get(key) === task) updates.delete(key)
  }
}

/**
 * A fresh record: metres, Y up, +Z forward unless told otherwise.
 * @param options - id, kind, title, the time, and optional orientation and parameters.
 * @returns the record.
 */
export function createModelRecord(options: {
  id: string
  kind: ModelKind
  title: string
  now: string
  orientation?: Partial<ModelProjectRecord['orientation']>
  parameterSchema?: ModelProjectRecord['parameterSchema']
}): ModelProjectRecord {
  return {
    schemaVersion: 1,
    id: options.id,
    kind: options.kind,
    title: options.title || options.id,
    createdAt: options.now,
    updatedAt: options.now,
    orientation: { unit: 'metre', up: 'y', forward: '+z', ...options.orientation },
    parameterSchema: options.parameterSchema ?? [],
    versions: [],
    runs: [],
    checks: [],
    reviews: [],
  }
}

/**
 * File a concrete criticism against a version. Notes are never rewritten to
 * point at a newer version: editing the source does not answer a criticism,
 * it only changes which version the note is still waiting on.
 * @param record - the record.
 * @param note - the note.
 * @param now - the time.
 * @returns the new record.
 */
export function addModelReview(record: ModelProjectRecord, note: ModelReviewNote, now: string): ModelProjectRecord {
  return { ...record, updatedAt: now, reviews: [note, ...record.reviews.filter(entry => entry.id !== note.id)].slice(0, 500) }
}

/**
 * Change a note's status; any status but `open` stamps when it was resolved.
 * @param record - the record.
 * @param id - the note id.
 * @param patch - status, and optionally the resolution and the version meant to answer it.
 * @param now - the time.
 * @returns the new record.
 */
export function resolveModelReview(
  record: ModelProjectRecord,
  id: string,
  patch: { status: ModelReviewNote['status']; resolution?: string; addressedInVersionId?: string },
  now: string,
): ModelProjectRecord {
  return {
    ...record,
    updatedAt: now,
    reviews: record.reviews.map(note => note.id === id
      ? {
          ...note,
          status: patch.status,
          ...(patch.resolution ? { resolution: patch.resolution } : {}),
          ...(patch.addressedInVersionId ? { addressedInVersionId: patch.addressedInVersionId } : {}),
          ...(patch.status === 'open' ? {} : { resolvedAt: now }),
        }
      : note),
  }
}

/**
 * Record the version the user confirmed. Older ones stay adoptable.
 * @param record - the record.
 * @param versionId - the version.
 * @param now - the time.
 * @returns the new record.
 * @throws when the record has no such version.
 */
export function adoptModelVersion(record: ModelProjectRecord, versionId: string, now: string): ModelProjectRecord {
  if (!record.versions.some(version => version.versionId === versionId)) throw new Error(`这个模型没有版本 ${versionId.slice(0, 12)}`)
  return { ...record, updatedAt: now, adoptedVersionId: versionId }
}

/**
 * Put a version into the record, newest first, without disturbing the old
 * ones. A version already there keeps its original `createdAt`: a rebuild of
 * unchanged inputs is the same version, and rewriting its history would make
 * old evidence look new.
 * @param record - the record.
 * @param versionId - the version id.
 * @param inputs - its inputs.
 * @param now - the time.
 * @returns the new record.
 */
export function upsertModelVersion(record: ModelProjectRecord, versionId: string, inputs: ModelInputs, now: string): ModelProjectRecord {
  const existing = record.versions.find(version => version.versionId === versionId)
  const version: ModelVersionRecord = existing !== undefined ? { ...existing, inputs } : { versionId, createdAt: now, inputs, capabilities: [] }
  return { ...record, updatedAt: now, versions: [version, ...record.versions.filter(entry => entry.versionId !== versionId)] }
}

/**
 * Name the built bundle of a version.
 * @param record - the record.
 * @param versionId - the version.
 * @param bundle - the bundle reference.
 * @param now - the time.
 * @returns the new record.
 */
export function attachBundle(record: ModelProjectRecord, versionId: string, bundle: ModelBundleRef, now: string): ModelProjectRecord {
  return { ...record, updatedAt: now, versions: record.versions.map(version => version.versionId === versionId ? { ...version, bundle } : version) }
}

/* ── staleness ─────────────────────────────────────────────────────────── */

export interface ModelArtifactStatus {
  path: string
  kind: ModelRunKind
  versionId: string
  freshness: 'current' | 'needs-update'
  producedAt: string
}

export interface ModelStaleness {
  currentVersionId: string
  /** Whether the current inputs are a version the record already knows. */
  known: boolean
  /** What moved since the newest recorded version, when the current one is new. */
  reason: ModelInputsDiff | null
  artifacts: ModelArtifactStatus[]
}

/**
 * How the record stands against what is on disk right now. Old artefacts are
 * listed rather than hidden — they are still evidence of what that version
 * was — each with the version it came from and whether that is still the model.
 * @param record - the record.
 * @param current - the inputs as hashed now.
 * @returns the staleness.
 */
export function describeStaleness(record: ModelProjectRecord, current: CollectedModelInputs): ModelStaleness {
  const known = record.versions.some(version => version.versionId === current.versionId)
  const newest = record.versions[0]
  return {
    currentVersionId: current.versionId,
    known,
    reason: !known && newest !== undefined ? diffModelInputs(newest.inputs, current.inputs) : null,
    artifacts: record.runs.flatMap(run => run.artifacts.map(artifact => ({
      path: artifact.path,
      kind: run.kind,
      versionId: artifact.versionId,
      freshness: modelArtifactFreshness(artifact.versionId, current.versionId),
      producedAt: artifact.producedAt,
    }))),
  }
}

/**
 * A one-line reason a person can read, built from the diff.
 * @param diff - the diff, or `null`.
 * @returns the reason, or `''` when nothing moved.
 */
export function stalenessReason(diff: ModelInputsDiff | null): string {
  if (diff === null || !diff.changed) return ''
  const parts: string[] = []
  if (diff.entryChanged) parts.push('入口文件已更换')
  if (diff.changedSources.length) parts.push(`源码已修改：${diff.changedSources.slice(0, 3).join('、')}${diff.changedSources.length > 3 ? ' 等' : ''}`)
  if (diff.addedSources.length) parts.push(`新增源码 ${diff.addedSources.length} 个`)
  if (diff.removedSources.length) parts.push(`移除源码 ${diff.removedSources.length} 个`)
  if (diff.changedResources.length) parts.push(`资源已更换：${diff.changedResources.slice(0, 3).join('、')}`)
  if (diff.addedResources.length || diff.removedResources.length) parts.push('资源清单已变化')
  if (diff.changedParameters.length) parts.push(`参数已调整：${diff.changedParameters.join('、')}`)
  if (diff.changedToolchain.length) parts.push(`工具链版本变化：${diff.changedToolchain.join('、')}`)
  return parts.join('；')
}

/* ── runs ──────────────────────────────────────────────────────────────── */

export interface ModelRunView extends ModelRunRecord {
  modelId: string
  projectId: string
  versionKnown: boolean
}

/**
 * A recorded run as a reader sees it. This workbench runs no model tasks, so
 * a run left queued or running (by Studio, or by a process that stopped) reads
 * as `interrupted` — never `failed`, which would claim an outcome nobody saw.
 * @param projectId - the project id echoed back.
 * @param modelId - the model id.
 * @param run - the recorded run.
 * @returns the view.
 */
export function modelRunView(projectId: string, modelId: string, run: ModelRunRecord): ModelRunView {
  const settled = run.status === 'queued' || run.status === 'running'
    ? { ...run, status: 'interrupted' as const, error: run.error ?? 'daemon 重启，任务中断' }
    : run
  return { ...settled, projectId, modelId, versionKnown: Boolean(run.versionId) }
}
