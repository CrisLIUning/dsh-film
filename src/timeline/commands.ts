/**
 * Timeline commands against the cut (Studio's `canvas-timeline-commands.ts`).
 *
 * The editor's capabilities — speak a line, caption a clip, repair a shot —
 * end by placing a file on the timeline, and that placement is a command the
 * host applies. On a board an asset is its file: `asset.place_version` names
 * a file under `film/`, this module fills in the file's facts, and the
 * bridge's command engine (a pure function) edits the cut, which is then
 * saved through the same revision check as every other save.
 * @module dsh-film/timeline/commands
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { executeVideoEditorCommandPlan } from '../../vendor/video-editor-bridge.mjs'
import type { JsonObject, JsonValue, VideoEditorCommandPlan } from '../../vendor/video-editor-bridge.mjs'
import { createEmptyTimelineArchive, isTimelineArchive } from './archive.js'
import { TimelineConflictError } from './store.js'
import type { TimelineStore } from './store.js'

/** How an asset version names a file of the film project. */
export const CANVAS_FILE_VERSION_PREFIX = 'canvas-file:'

type MediaType = 'image' | 'video' | 'audio'

const MEDIA_BY_EXTENSION: Readonly<Record<string, { mediaType: MediaType; mimeType: string }>> = {
  png: { mediaType: 'image', mimeType: 'image/png' },
  jpg: { mediaType: 'image', mimeType: 'image/jpeg' },
  jpeg: { mediaType: 'image', mimeType: 'image/jpeg' },
  webp: { mediaType: 'image', mimeType: 'image/webp' },
  gif: { mediaType: 'image', mimeType: 'image/gif' },
  mp3: { mediaType: 'audio', mimeType: 'audio/mpeg' },
  wav: { mediaType: 'audio', mimeType: 'audio/wav' },
  m4a: { mediaType: 'audio', mimeType: 'audio/mp4' },
  mp4: { mediaType: 'video', mimeType: 'video/mp4' },
  webm: { mediaType: 'video', mimeType: 'video/webm' },
  mov: { mediaType: 'video', mimeType: 'video/quicktime' },
}

/** A still with no stated duration gets this long on the timeline. */
const DEFAULT_IMAGE_SECONDS = 5

/** Fields of `asset.place_version` passed on to the engine's `asset.import` as they are. */
const PASSED_THROUGH = [
  'start', 'volume', 'muted', 'replace', 'replaceClipId', 'disableSourceClipId', 'muteMusicClipId', 'sourceOffsets',
  'linkedSourceAssetId', 'muteOverlayClipId', 'preserveOriginal', 'restoreOriginal', 'sourceStart', 'sourceDuration',
  'playbackRate', 'width', 'height', 'layer', 'x', 'y', 'scale', 'rotation', 'opacity', 'keyframes',
] as const

export class TimelineCommandError extends Error {
  override name = 'TimelineCommandError'

  constructor(readonly code: string, message: string, readonly operationId?: string) {
    super(message)
  }
}

/**
 * The film-relative path behind a version id.
 * @param versionId - an asset version id.
 * @returns the path, or `null` when the id does not name a file.
 */
export function canvasFilePathFromVersionId(versionId: string): string | null {
  if (!versionId.startsWith(CANVAS_FILE_VERSION_PREFIX)) return null
  const rest = versionId.slice(CANVAS_FILE_VERSION_PREFIX.length).replaceAll('\\', '/')
  return rest === '' ? null : rest
}

/** The file a version names, proven (on real paths) to be inside the project. */
async function ownedFile(projectRoot: string, path: string, operationId: string): Promise<{ absolutePath: string; size: number }> {
  if (path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '')) {
    throw new TimelineCommandError('ASSET_VERSION_FILE_INVALID', 'asset file path must stay inside the project', operationId)
  }
  try {
    const root = await realpath(projectRoot)
    const file = await realpath(join(root, ...path.split('/')))
    const offset = relative(root, file)
    if (offset === '' || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error('escapes')
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    return { absolutePath: file, size: info.size }
  } catch {
    throw new TimelineCommandError('ASSET_VERSION_FILE_INVALID', 'asset file is missing or outside the project', operationId)
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => { resolve(hash.digest('hex')) })
  })
}

function text(operation: Record<string, unknown>, key: string, operationId: string): string {
  const value = operation[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TimelineCommandError('ASSET_VERSION_PLACEMENT_INVALID', `${key} is required for asset.place_version`, operationId)
  }
  return value.trim()
}

/**
 * The URL Studio gives a project file; documents keep these, so a cut stays
 * readable by Studio too.
 * @param projectId - the film project's id.
 * @param path - the film-relative path.
 * @returns the URL.
 */
export function projectRawUrl(projectId: string, path: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/raw/${path.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Turn every `asset.place_version` into the prepared `asset.import` the engine
 * takes, with the file's facts filled in. Other operations pass as they are.
 * @param input - the film folder, the project id and the plan.
 * @returns the plan the engine runs.
 */
export async function resolveCommandPlan(input: { projectRoot: string; projectId: string; plan: VideoEditorCommandPlan }): Promise<VideoEditorCommandPlan> {
  const operations: VideoEditorCommandPlan['operations'] = []
  const facts = new Map<string, { sha256: string; size: number }>()
  for (const raw of input.plan.operations) {
    if (raw.type !== 'asset.place_version') {
      operations.push(structuredClone(raw))
      continue
    }
    const operation = raw as Record<string, unknown>
    const operationId = text(operation, 'id', String(operation.id ?? 'asset.place_version'))
    const assetId = text(operation, 'assetId', operationId)
    const versionId = text(operation, 'versionId', operationId)
    const clipId = text(operation, 'clipId', operationId)
    const track = text(operation, 'track', operationId)
    if (!['visuals', 'audio', 'music', 'source'].includes(track)) {
      throw new TimelineCommandError('ASSET_VERSION_PLACEMENT_INVALID', 'track must be visuals, audio, music, or source', operationId)
    }
    const path = canvasFilePathFromVersionId(versionId)
    if (path === null) throw new TimelineCommandError('ASSET_VERSION_NOT_FOUND', `version "${versionId}" is not a file of this film`, operationId)
    const extension = extname(path).slice(1).toLowerCase()
    const media = MEDIA_BY_EXTENSION[extension]
    if (media === undefined) throw new TimelineCommandError('ASSET_VERSION_MEDIA_UNSUPPORTED', `.${extension || '?'} cannot go on the timeline`, operationId)
    const restoringSound = ['audio', 'source'].includes(track) && operation.restoreOriginal === true && media.mediaType === 'video'
    if ((track === 'visuals') !== (media.mediaType !== 'audio') && !restoringSound) {
      throw new TimelineCommandError('ASSET_VERSION_TRACK_MISMATCH', `.${extension} cannot be placed on ${track}`, operationId)
    }
    let fact = facts.get(path)
    if (fact === undefined) {
      const owned = await ownedFile(input.projectRoot, path, operationId)
      fact = { sha256: await sha256File(owned.absolutePath), size: owned.size }
      facts.set(path, fact)
    }
    const requested = operation.duration
    const duration = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? requested
      : media.mediaType === 'image' ? DEFAULT_IMAGE_SECONDS : undefined
    if (duration === undefined) throw new TimelineCommandError('ASSET_VERSION_DURATION_REQUIRED', 'audio and video placement needs a duration', operationId)
    // The asset id is the version id: the editor authorizes a clip by version
    // and insists the asset id agrees, and a clip it cannot resolve it drops.
    const prepared: Record<string, unknown> = {
      id: operationId,
      type: 'asset.import',
      clipId,
      track,
      prepared: true,
      mediaType: media.mediaType,
      assetId: versionId,
      requestedAssetId: assetId,
      assetVersionId: versionId,
      name: typeof operation.name === 'string' && operation.name.trim() !== '' ? operation.name.trim() : basename(path),
      duration,
      sha256: fact.sha256,
      size: fact.size,
      mimeType: media.mimeType,
      archivePath: path,
      sourceUrl: projectRawUrl(input.projectId, path),
      storyMediaSource: null,
    }
    for (const key of PASSED_THROUGH) {
      if (operation[key] !== undefined) prepared[key] = operation[key]
    }
    if (operation.director !== null && typeof operation.director === 'object' && !Array.isArray(operation.director)) {
      prepared.director = { ...(operation.director as Record<string, unknown>) }
    }
    operations.push(prepared as VideoEditorCommandPlan['operations'][number])
  }
  return { ...input.plan, operations }
}

/**
 * The cut as it should be stored: without fields that only mean something
 * while an editor runs (object URLs, decoded frames). What a clip plays is
 * `integrity.archivePath`, `assetVersionId` and `sourceUrl`, which stay.
 * @param document - a cut.
 * @returns the cut without runtime fields.
 */
export function withoutRuntimeFields(document: unknown): unknown {
  const root = document !== null && typeof document === 'object' ? document as Record<string, unknown> : null
  const project = root?.project !== null && typeof root?.project === 'object' ? root.project as Record<string, unknown> : null
  if (root === null || project === null) return document
  const runtime = new Set(['src', 'url', 'blob', 'trackFrames', 'peaks'])
  let touched = false
  const cleaned: Record<string, unknown> = { ...project }
  for (const key of ['visualSegments', 'visualOverlaySegments', 'audioSegments', 'musicSegments', 'stickerSegments']) {
    const clips = project[key]
    if (!Array.isArray(clips)) continue
    cleaned[key] = clips.map((clip: unknown) => {
      if (clip === null || typeof clip !== 'object' || Array.isArray(clip)) return clip
      const entries = Object.entries(clip as Record<string, unknown>).filter(([name]) => !runtime.has(name))
      if (entries.length === Object.keys(clip).length) return clip
      touched = true
      return Object.fromEntries(entries)
    })
  }
  return touched ? { ...root, project: cleaned } : document
}

export interface TimelineCommandResult {
  committed: boolean
  revision: number
  documentVersionId?: string
  candidateRevision: number
  duplicate: boolean
  appliedOperationIds: string[]
  warnings: JsonValue[]
  changes: JsonObject
  before: JsonObject
  after: JsonObject
}

/**
 * Apply a plan to the cut and save the result. `plan.baseRevision` must match
 * the stored revision; a cut never made starts from the empty archive.
 * @param input - the store, the film folder, ids and the plan.
 * @returns what the engine did and the revision after.
 */
export async function executeTimelineCommands(input: {
  store: TimelineStore
  projectRoot: string
  projectId: string
  boardId: string
  dryRun: boolean
  plan: VideoEditorCommandPlan
}): Promise<TimelineCommandResult> {
  const current = await input.store.read()
  if (input.plan.baseRevision !== current.revision) throw new TimelineConflictError(current.revision, input.plan.baseRevision)
  const document = isTimelineArchive(current.document) ? current.document : createEmptyTimelineArchive()
  const plan = await resolveCommandPlan({ projectRoot: input.projectRoot, projectId: input.projectId, plan: input.plan })
  const execution = executeVideoEditorCommandPlan(document as JsonObject, plan)
  if (!execution.ok) throw new TimelineCommandError(execution.code, execution.message, execution.operationId)
  // The engine skips an operation id it has applied before; a plan it skipped
  // entirely changed nothing and is not a new revision.
  const duplicate = execution.appliedOperationIds.length === 0
  const base = {
    candidateRevision: execution.revision,
    duplicate,
    appliedOperationIds: execution.appliedOperationIds,
    warnings: execution.warnings,
    changes: execution.changes,
    before: execution.before,
    after: execution.after,
  }
  if (input.dryRun || duplicate) return { committed: false, revision: current.revision, ...base }
  const saved = await input.store.save({
    document: withoutRuntimeFields(execution.document),
    baseRevision: input.plan.baseRevision,
    ...(current.document === null ? { initialDocument: withoutRuntimeFields(document) } : {}),
  })
  return { committed: true, revision: saved.revision, documentVersionId: `canvas:${input.boardId}:${saved.revision}`, ...base }
}
