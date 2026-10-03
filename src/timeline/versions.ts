/**
 * Which take a slot plays (Studio's `canvas-timeline-versions.ts`).
 *
 * A shot gets made more than once: the board fills up with takes, and the cut
 * holds whichever was placed first. The slot is what this works on, not the
 * file: its candidates are the compatible media on the board, and choosing one
 * exchanges the material underneath while the slot keeps its id (for a shot,
 * the shot), its order, its length and its grade.
 * @module dsh-film/timeline/versions
 */

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { listBoardMedia, mediaKindOfPath } from '../canvas/board-media.js'
import type { BoardMediaKind } from '../canvas/board-media.js'
import { CANVAS_FILE_VERSION_PREFIX, canvasFilePathFromVersionId, executeTimelineCommands } from './commands.js'
import type { TimelineCommandResult } from './commands.js'
import type { TimelineStore } from './store.js'

export type SlotTrack = 'visuals' | 'audio' | 'music'

export class TimelineVersionError extends Error {
  override name = 'TimelineVersionError'

  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/** A clip of the cut whose material can be exchanged. */
export interface Slot {
  clipId: string
  track: SlotTrack
  name: string
  path: string
  kind: BoardMediaKind
  durationSeconds: number
  shotId?: string
  start?: number
}

/** What a swap hands back to the engine so the clip stays itself. */
interface SlotInternals {
  volume?: number
  muted?: boolean
  width?: number
  height?: number
}

export interface ResolvedSlot extends Slot {
  keep: SlotInternals
}

/** One take that could fill a slot. */
export interface Take {
  path: string
  name: string
  kind: BoardMediaKind
  nodeId?: string
  durationSeconds?: number
  width?: number
  height?: number
  current: boolean
  /** Why it cannot fill the slot, when it cannot; it is still listed. */
  refusal?: string
}

const INVALID = 'CANVAS_TIMELINE_VERSION_INVALID'
/** Slack for a take's measured length against the slot's, in seconds. */
const LENGTH_TOLERANCE = 1 / 60
const TRACK_KEYS: ReadonlyArray<[SlotTrack, string]> = [['visuals', 'visualSegments'], ['audio', 'audioSegments'], ['music', 'musicSegments']]

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const invalid = (message: string): TimelineVersionError => new TimelineVersionError(400, INVALID, message)

/** The film file a stored clip plays, however the clip records it. */
function clipPath(clip: Record<string, unknown>): string | null {
  const archived = record(clip.integrity)?.archivePath
  if (typeof archived === 'string' && archived.trim() !== '') return archived.trim().replaceAll('\\', '/')
  return typeof clip.assetVersionId === 'string' ? canvasFilePathFromVersionId(clip.assetVersionId) : null
}

/**
 * Every clip of the cut that plays a film file, in track order. Captions,
 * stickers and overlays are left out.
 * @param document - the cut.
 * @returns its slots.
 */
export function listSlots(document: unknown): ResolvedSlot[] {
  const project = record(record(document)?.project)
  if (project === null) return []
  const slots: ResolvedSlot[] = []
  for (const [track, key] of TRACK_KEYS) {
    const clips = project[key]
    if (!Array.isArray(clips)) continue
    for (const raw of clips) {
      const clip = record(raw)
      if (clip === null || typeof clip.id !== 'string' || clip.id === '') continue
      const path = clipPath(clip)
      if (path === null) continue
      const kind = mediaKindOfPath(path)
      if (kind === null) continue
      const director = record(clip.director)
      slots.push({
        clipId: clip.id,
        track,
        name: typeof clip.name === 'string' && clip.name.trim() !== '' ? clip.name.trim() : clip.id,
        path,
        kind,
        durationSeconds: finite(clip.duration) ? clip.duration : 0,
        ...(typeof director?.shotId === 'string' ? { shotId: director.shotId } : {}),
        ...(finite(clip.start) ? { start: clip.start } : {}),
        keep: {
          ...(finite(clip.volume) ? { volume: clip.volume } : {}),
          ...(clip.muted === true ? { muted: true } : {}),
          ...(finite(clip.width) && clip.width > 0 ? { width: clip.width } : {}),
          ...(finite(clip.height) && clip.height > 0 ? { height: clip.height } : {}),
        },
      })
    }
  }
  return slots
}

/** A slot without what only a swap needs. */
export function publicSlot(slot: ResolvedSlot): Slot {
  const { keep: _keep, ...rest } = slot
  return rest
}

/**
 * The slot a clip id names.
 * @param document - the cut.
 * @param clipId - the clip.
 * @returns the slot.
 */
export function findSlot(document: unknown, clipId: string): ResolvedSlot {
  const slots = listSlots(document)
  const slot = slots.find(item => item.clipId === clipId)
  if (slot === undefined) {
    const known = slots.map(item => item.clipId).slice(0, 8).join(', ')
    throw new TimelineVersionError(404, 'CANVAS_TIMELINE_VERSION_CLIP_NOT_FOUND', `the cut has no clip "${clipId}" that plays a file${known !== '' ? ` — it has ${known}` : ''}`)
  }
  return slot
}

const fits = (slot: Slot, kind: BoardMediaKind): boolean => slot.track === 'visuals' ? kind !== 'audio' : kind === 'audio'

/** Why a take cannot cover the slot, when its length is known and falls short. */
function tooShort(slot: Slot, kind: BoardMediaKind, durationSeconds: number | undefined): string | null {
  if (kind === 'image' || durationSeconds === undefined) return null
  if (durationSeconds + LENGTH_TOLERANCE >= slot.durationSeconds) return null
  return `比这一格短 ${(slot.durationSeconds - durationSeconds).toFixed(1)} 秒（这一格 ${slot.durationSeconds.toFixed(1)} 秒）`
}

/**
 * The takes that could fill a slot: what it plays now, then the compatible
 * media on the board, same kind first. A take too short is listed with its reason.
 * @param slot - the slot.
 * @param board - the board document.
 * @returns the candidates.
 */
export function candidatesFor(slot: Slot, board: unknown): Take[] {
  const media = listBoardMedia(board).filter(item => fits(slot, item.kind))
  const onBoard = media.find(item => item.path === slot.path)
  const takes: Take[] = [{
    path: slot.path,
    name: onBoard?.title ?? slot.name,
    kind: slot.kind,
    ...(onBoard !== undefined ? { nodeId: onBoard.nodeId } : {}),
    ...(onBoard?.durationSeconds !== undefined ? { durationSeconds: onBoard.durationSeconds } : {}),
    ...(onBoard?.width !== undefined ? { width: onBoard.width } : {}),
    ...(onBoard?.height !== undefined ? { height: onBoard.height } : {}),
    current: true,
  }]
  const rest = [
    ...media.filter(item => item.path !== slot.path && item.kind === slot.kind),
    ...media.filter(item => item.path !== slot.path && item.kind !== slot.kind),
  ]
  for (const item of rest) {
    const refusal = tooShort(slot, item.kind, item.durationSeconds)
    takes.push({
      path: item.path,
      name: item.title,
      kind: item.kind,
      nodeId: item.nodeId,
      ...(item.durationSeconds !== undefined ? { durationSeconds: item.durationSeconds } : {}),
      ...(item.width !== undefined ? { width: item.width } : {}),
      ...(item.height !== undefined ? { height: item.height } : {}),
      current: false,
      ...(refusal !== null ? { refusal } : {}),
    })
  }
  return takes
}

/** The take a request names. */
function resolveTake(request: Record<string, unknown>, slot: Slot, board: unknown): Take {
  const source = record(request.source)
  if (source === null) throw invalid('source must name a media node on the board, or a project file')
  if (typeof source.nodeId === 'string' && source.nodeId !== '') {
    const node = listBoardMedia(board).find(item => item.nodeId === source.nodeId)
    if (node === undefined) throw new TimelineVersionError(404, 'CANVAS_TIMELINE_VERSION_NODE_NOT_FOUND', `the board has no media node "${source.nodeId}" that plays a file in this project`)
    return {
      path: node.path,
      name: node.title,
      kind: node.kind,
      nodeId: node.nodeId,
      ...(node.durationSeconds !== undefined ? { durationSeconds: node.durationSeconds } : {}),
      ...(node.width !== undefined ? { width: node.width } : {}),
      ...(node.height !== undefined ? { height: node.height } : {}),
      current: node.path === slot.path,
    }
  }
  if (typeof source.path !== 'string' || source.path.trim() === '') throw invalid('source needs a nodeId on the board, or a project-relative path')
  const path = source.path.trim().replaceAll('\\', '/').replace(/^\.\//, '')
  if (path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '')) throw invalid(`source: "${source.path}" must be a path inside the project`)
  const kind = mediaKindOfPath(path)
  if (kind === null) throw invalid(`the timeline cannot take "${path}" — it plays video, images and audio`)
  return { path, name: path.split('/').pop() ?? path, kind, current: path === slot.path }
}

async function ownedFile(projectRoot: string, path: string): Promise<string | null> {
  try {
    const root = await realpath(projectRoot)
    const file = await realpath(join(root, ...path.split('/')))
    const offset = relative(root, file)
    if (offset === '' || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) return null
    return (await stat(file)).isFile() ? file : null
  } catch {
    return null
  }
}

export interface SwapVersionInput {
  store: TimelineStore
  projectRoot: string
  projectId: string
  boardId: string
  board: unknown
  request: Record<string, unknown>
  baseRevision?: number
  dryRun: boolean
  operationId: string
  probeDuration?: (absolutePath: string) => Promise<number | undefined>
}

export interface Swapped {
  clipId: string
  track: SlotTrack
  from: string
  to: string
  name: string
  durationSeconds: number
}

/**
 * Give one slot a different take. The slot's own facts win: its length, its
 * place, its volume; a take that cannot cover it is refused here rather than
 * left for the render to discover as a black tail.
 * @param input - the store, the board, the request and the revision reviewed.
 * @returns what the engine did and what was exchanged.
 */
export async function swapSlotVersion(input: SwapVersionInput): Promise<{ result: TimelineCommandResult; swapped: Swapped }> {
  const clipId = typeof input.request.clipId === 'string' ? input.request.clipId.trim() : ''
  if (clipId === '') throw invalid('clipId must name a clip on the cut')
  const current = await input.store.read()
  const baseRevision = input.baseRevision ?? current.revision
  const slot = findSlot(current.document, clipId)
  const take = resolveTake(input.request, slot, input.board)
  if (!fits(slot, take.kind)) {
    throw new TimelineVersionError(422, 'CANVAS_TIMELINE_VERSION_KIND_MISMATCH', `${take.kind} cannot fill a ${slot.track === 'visuals' ? 'visual' : 'sound'} slot — video and images play on visuals, audio on the voice and music lanes`)
  }
  const absolute = await ownedFile(input.projectRoot, take.path)
  if (absolute === null) throw new TimelineVersionError(422, 'CANVAS_TIMELINE_VERSION_FILE_NOT_FOUND', `${take.path} is not a file in this project`)
  let takeSeconds = take.durationSeconds
  if (takeSeconds === undefined && take.kind !== 'image') takeSeconds = await input.probeDuration?.(absolute)
  const short = tooShort(slot, take.kind, takeSeconds)
  if (short !== null) throw new TimelineVersionError(422, 'CANVAS_TIMELINE_VERSION_TOO_SHORT', `${take.name} ${short} — trim the slot first, or pick a longer take`)
  let name = slot.name
  if (input.request.name !== undefined) {
    if (typeof input.request.name !== 'string' || input.request.name.trim() === '') throw invalid('name must be a non-empty string')
    name = input.request.name.trim().slice(0, 120)
  }
  const versionId = `${CANVAS_FILE_VERSION_PREFIX}${take.path}`
  const width = take.width !== undefined && take.height !== undefined ? take.width : slot.keep.width
  const height = take.width !== undefined && take.height !== undefined ? take.height : slot.keep.height
  const operation = {
    id: `version:${input.operationId}`,
    type: 'asset.place_version',
    // The slot keeps its id: the engine takes the replacement's from here, and for a shot that id is the shot.
    clipId: slot.clipId,
    replaceClipId: slot.clipId,
    assetId: versionId,
    versionId,
    track: slot.track,
    duration: slot.durationSeconds,
    name,
    ...(width !== undefined && height !== undefined ? { width, height } : {}),
    // A sound clip is rebuilt rather than merged, so what it was told is said again.
    ...(slot.track === 'visuals' ? {} : {
      start: slot.start ?? 0,
      ...(slot.keep.volume !== undefined ? { volume: slot.keep.volume } : {}),
      ...(slot.keep.muted === true ? { muted: true } : {}),
    }),
  }
  const result = await executeTimelineCommands({
    store: input.store,
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    boardId: input.boardId,
    dryRun: input.dryRun,
    plan: { schemaVersion: 1, baseRevision, operations: [operation] },
  })
  return { result, swapped: { clipId: slot.clipId, track: slot.track, from: slot.path, to: take.path, name, durationSeconds: slot.durationSeconds } }
}
