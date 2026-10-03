/**
 * The board as a staging table: one of its media nodes (or a project file),
 * put on the cut (Studio's `canvas-timeline-place.ts`). One
 * `asset.place_version` through the cut's revision check, with the same
 * refusals as every other write. Video and images join the visual track,
 * which plays its clips one after another; audio goes to the voice or music
 * track, at a given time or after what is there.
 * @module dsh-film/timeline/place
 */

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { listBoardMedia, mediaKindOfPath } from '../canvas/board-media.js'
import type { BoardMediaKind } from '../canvas/board-media.js'
import { CANVAS_FILE_VERSION_PREFIX, executeTimelineCommands } from './commands.js'
import type { TimelineCommandResult } from './commands.js'
import type { TimelineStore } from './store.js'

export type PlaceTrack = 'visuals' | 'audio' | 'music'

export class TimelinePlaceError extends Error {
  override name = 'TimelinePlaceError'

  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export interface PlaceRequest {
  source?: unknown
  track?: unknown
  at?: unknown
  durationSeconds?: unknown
  name?: unknown
}

export interface Placement {
  path: string
  kind: BoardMediaKind
  track: PlaceTrack
  name: string
  durationSeconds?: number
  at?: number
  width?: number
  height?: number
}

export interface Placed {
  clipId: string
  track: PlaceTrack
  path: string
  name: string
  start: number
  durationSeconds: number
}

const TRACKS: readonly PlaceTrack[] = ['visuals', 'audio', 'music']
/** A still's length when nobody says; the command layer's own default. */
const DEFAULT_IMAGE_SECONDS = 5
const INVALID = 'CANVAS_TIMELINE_PLACE_INVALID'

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const invalid = (message: string): TimelinePlaceError => new TimelinePlaceError(400, INVALID, message)

/**
 * A request as a placement, checked field by field.
 * @param request - what the caller asked for.
 * @param board - the board document, for a node source.
 * @returns the placement.
 */
export function resolvePlacement(request: PlaceRequest, board: unknown): Placement {
  const source = record(request.source)
  if (source === null) throw invalid('source must name a media node on the board, or a project file')
  let path: string
  let title: string | undefined
  let durationSeconds: number | undefined
  let size: { width: number; height: number } | undefined
  if (typeof source.nodeId === 'string' && source.nodeId !== '') {
    const node = listBoardMedia(board).find(item => item.nodeId === source.nodeId)
    if (node === undefined) throw new TimelinePlaceError(404, 'CANVAS_TIMELINE_PLACE_NODE_NOT_FOUND', `the board has no media node "${source.nodeId}" that plays a file in this project`)
    path = node.path
    title = node.title
    durationSeconds = node.durationSeconds
    if (node.width !== undefined && node.height !== undefined) size = { width: node.width, height: node.height }
  } else {
    if (typeof source.path !== 'string' || source.path.trim() === '') throw invalid('source needs a nodeId on the board, or a project-relative path')
    path = source.path.trim().replaceAll('\\', '/').replace(/^\.\//, '')
    if (path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '')) throw invalid(`source: "${source.path}" must be a path inside the project`)
    if (finite(source.durationSeconds) && source.durationSeconds > 0) durationSeconds = source.durationSeconds
  }
  const kind = mediaKindOfPath(path)
  if (kind === null) throw invalid(`the timeline cannot take "${path}" — it plays video, images and audio`)
  const track = request.track === undefined ? (kind === 'audio' ? 'audio' : 'visuals') : request.track
  if (typeof track !== 'string' || !(TRACKS as readonly string[]).includes(track)) throw invalid(`track must be one of ${TRACKS.join(', ')}`)
  const placeTrack = track as PlaceTrack
  if ((placeTrack === 'visuals') !== (kind !== 'audio')) throw invalid(`${kind} cannot go on the ${placeTrack} track — video and images play on visuals, audio on audio or music`)
  const placement: Placement = { path, kind, track: placeTrack, name: '', ...(size ?? {}) }
  if (request.durationSeconds !== undefined) {
    if (!finite(request.durationSeconds) || request.durationSeconds <= 0) throw invalid('durationSeconds must be a positive number of seconds')
    durationSeconds = request.durationSeconds
  }
  if (durationSeconds !== undefined) placement.durationSeconds = durationSeconds
  if (request.at !== undefined) {
    if (!finite(request.at) || request.at < 0) throw invalid('at must be a non-negative number of seconds')
    // Said rather than ignored: asking for a time on the visual track means an
    // insert, and the caller would not otherwise learn the clip went to the end.
    if (placeTrack === 'visuals') throw invalid('at is for the audio and music tracks; the visual track plays its clips one after another, so a visual placement lands at the end')
    placement.at = request.at
  }
  if (request.name !== undefined) {
    if (typeof request.name !== 'string' || request.name.trim() === '') throw invalid('name must be a non-empty string')
    placement.name = request.name.trim().slice(0, 120)
  } else {
    placement.name = title ?? path.split('/').pop() ?? path
  }
  return placement
}

/** Visual clips play one after another, so a new one starts where they end. */
function visualEnd(document: unknown): number {
  const clips = record(record(document)?.project)?.visualSegments
  if (!Array.isArray(clips)) return 0
  return clips.reduce((total: number, raw: unknown) => {
    const clip = record(raw)
    return total + Math.max(0, clip !== null && finite(clip.duration) ? clip.duration : 0)
  }, 0)
}

/** Where a clip on an audio lane goes when nobody names a time: after what is there. */
function laneEnd(document: unknown, track: PlaceTrack): number {
  const clips = record(record(document)?.project)?.[track === 'music' ? 'musicSegments' : 'audioSegments']
  if (!Array.isArray(clips)) return 0
  return clips.reduce((end: number, raw: unknown) => {
    const clip = record(raw)
    if (clip === null) return end
    return Math.max(end, (finite(clip.start) ? clip.start : 0) + (finite(clip.duration) ? clip.duration : 0))
  }, 0)
}

/** The file behind a film-relative path, proven inside the project. */
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

export interface PlaceMediaInput {
  store: TimelineStore
  /** The film folder. */
  projectRoot: string
  projectId: string
  boardId: string
  board: unknown
  request: PlaceRequest
  /** Required for an apply; a dry run defaults to the current revision. */
  baseRevision?: number
  dryRun: boolean
  operationId: string
  /** Seconds a file lasts, when it can be read. */
  probeDuration?: (absolutePath: string) => Promise<number | undefined>
}

/**
 * Put one piece of the board's material on the cut.
 * @param input - the store, the board, the request and the revision reviewed.
 * @returns what the engine did and where the clip went.
 */
export async function placeBoardMediaOnTimeline(input: PlaceMediaInput): Promise<{ result: TimelineCommandResult; placed: Placed }> {
  const placement = resolvePlacement(input.request, input.board)
  const current = await input.store.read()
  const baseRevision = input.baseRevision ?? current.revision
  const absolute = await ownedFile(input.projectRoot, placement.path)
  if (absolute === null) throw new TimelinePlaceError(422, 'CANVAS_TIMELINE_PLACE_FILE_NOT_FOUND', `${placement.path} is not a file in this project`)
  let durationSeconds = placement.durationSeconds
  if (durationSeconds === undefined && placement.kind !== 'image') durationSeconds = await input.probeDuration?.(absolute)
  if (durationSeconds === undefined) {
    if (placement.kind !== 'image') throw new TimelinePlaceError(422, 'CANVAS_TIMELINE_PLACE_DURATION', `the length of ${placement.path} could not be read — pass durationSeconds`)
    durationSeconds = DEFAULT_IMAGE_SECONDS
  }
  const clipId = `${input.operationId}-${placement.track}`
  const versionId = `${CANVAS_FILE_VERSION_PREFIX}${placement.path}`
  const start = placement.track === 'visuals' ? visualEnd(current.document) : placement.at ?? laneEnd(current.document, placement.track)
  const operation = {
    id: `place:${input.operationId}`,
    type: 'asset.place_version',
    clipId,
    assetId: versionId,
    versionId,
    track: placement.track,
    duration: durationSeconds,
    name: placement.name,
    // A clip that already knows its pixels is one the editor need not measure and save back.
    ...(placement.width !== undefined && placement.height !== undefined ? { width: placement.width, height: placement.height } : {}),
    ...(placement.track === 'visuals' ? {} : { start }),
  }
  const result = await executeTimelineCommands({
    store: input.store,
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    boardId: input.boardId,
    dryRun: input.dryRun,
    plan: { schemaVersion: 1, baseRevision, operations: [operation] },
  })
  return { result, placed: { clipId, track: placement.track, path: placement.path, name: placement.name, start, durationSeconds } }
}
