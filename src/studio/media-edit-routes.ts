/**
 * The canvas's lossless media edits (C9), run by the Host as film tasks (C10):
 *
 * - `POST /api/canvas/video/:boardId/probe` — `{ paths }` (1–20 film-relative
 *   paths): codec, size, decoder configuration hash and key frames of each,
 *   so the page can tell what the Host can copy.
 * - `POST /api/canvas/video/:boardId/cut` — `{ requestId, source: { nodeId?,
 *   path }, inMs, outMs, boundary?, land? }`: the range as a new file
 *   `canvas/media/clip-<id>.mp4` (an audio file keeps its container).
 * - `POST /api/canvas/video/:boardId/join` — `{ requestId, clips: [{ nodeId?,
 *   path, inMs?, outMs? }] (2–20, play order), land? }`: one file
 *   `canvas/media/join-<id>.mp4`, or 422 `VIDEO_JOIN_NEEDS_TRANSCODE` with the
 *   reasons when the clips cannot be copied into one track.
 * - `POST /api/canvas/video/:boardId/extract-audio` — `{ requestId, source,
 *   inMs?, outMs?, land? }`: the sound as `canvas/media/extract-<id>.m4a`, or
 *   422 `VIDEO_NO_AUDIO_TRACK`.
 *
 * Edits answer 202 `{ taskId, status }`; the page waits and cancels through
 * the media task routes. A repeated `requestId` answers with the task it
 * started. With `land: { nearNodeId, connectFrom, title? }` the Host puts the
 * result on the board right of `nearNodeId` with an edge from each of
 * `connectFrom` and `metadata.derivedFrom` (C1); without it the page lands it
 * itself. A path is the file relative to `film/` (or the board's raw URL of
 * it) and never leaves `film/`.
 *
 * Errors answer `{ error: <text>, code }` like Studio's canvas routes.
 * @module dsh-film/studio/media-edit-routes
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { landFileOnBoard, mediaKindOfPath } from '../canvas/board-media.js'
import type { BoardMediaKind } from '../canvas/board-media.js'
import { CanvasDocumentStore, CanvasDocumentUpdateError } from '../canvas/documents.js'
import { mediaTypeOf } from '../media.js'
import { MediaEditError, checkRange, copyProblem, copyTarget, cutFile, extractAudio, joinFiles, joinProblems, probeDetailed } from '../media/edit.js'
import type { EditProbe, EditResult } from '../media/edit.js'
import { FilmMediaError, filmUrlOf } from '../media/tasks.js'
import type { FilmMediaTasks, FilmTaskFile, LocalCapability } from '../media/tasks.js'
import { projectOf } from './canvas-routes.js'
import type { ProjectEvents } from './events.js'
import { StudioReply } from './router.js'
import type { StudioRequest, StudioRouter } from './router.js'

export const MEDIA_PROBE_PATH = '/api/canvas/video/:boardId/probe'
export const MEDIA_CUT_PATH = '/api/canvas/video/:boardId/cut'
export const MEDIA_JOIN_PATH = '/api/canvas/video/:boardId/join'
export const MEDIA_EXTRACT_AUDIO_PATH = '/api/canvas/video/:boardId/extract-audio'

/** Where edits write their results, relative to `film/`. */
const OUTPUT_FOLDER = 'canvas/media'
const PROJECT_DIR = 'film'
const MAX_PROBE_PATHS = 20
const MAX_JOIN_CLIPS = 20

type Body = Record<string, unknown>

const reply = (status: number, code: string, message: string, extra: Body = {}): never => {
  throw new StudioReply(status, { error: message, code, ...extra })
}

const isObject = (value: unknown): value is Body => typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** A film file an edit reads: as the caller named it, relative to `film/`, and absolute. */
interface SourceFile {
  given: string
  path: string
  absolute: string
}

/**
 * The film-relative path a caller named: a path relative to `film/`, or the
 * board's raw URL of one (`/api/projects/<id>/raw/<path>`, as node content holds it).
 * @param value - what the caller sent.
 * @returns the path with `/` separators.
 */
function filmPathOf(value: unknown): string {
  const given = text(value)
  if (given === undefined) return reply(400, 'MEDIA_EDIT_INVALID', 'A path relative to film/ is required.')
  const raw = filmUrlOf(given)
  const path = (raw?.kind === 'raw' ? raw.path : given).replace(/\\/g, '/')
  const parts = path.split('/').filter(part => part !== '' && part !== '.')
  if (path.includes('\0') || isAbsolute(path) || /^[A-Za-z]:/.test(path) || parts.length === 0 || parts.some(part => part === '..')) {
    return reply(400, 'MEDIA_EDIT_INVALID', `"${given}" is not a path inside film/.`)
  }
  return parts.join('/')
}

/**
 * Resolve a source file inside `film/`, following links only as far as `film/` reaches.
 * @param cwd - the workspace.
 * @param value - the path the caller sent.
 * @param missing - what a missing file answers: an error, or `null`.
 * @returns the file, or `null` when it is missing and `missing` is `'null'`.
 */
async function sourceFile(cwd: string, value: unknown, missing: 'throw' | 'null' = 'throw'): Promise<SourceFile | null> {
  const path = filmPathOf(value)
  const absolute = join(cwd, PROJECT_DIR, ...path.split('/'))
  const info = await lstat(absolute).catch(() => undefined)
  const root = await realpath(join(cwd, PROJECT_DIR)).catch(() => undefined)
  const real = info === undefined ? undefined : await realpath(absolute).catch(() => undefined)
  if (root === undefined || real === undefined) {
    if (missing === 'null') return null
    return reply(404, 'MEDIA_EDIT_SOURCE_NOT_FOUND', `${path} is not a file in this film.`)
  }
  const offset = relative(root, real)
  if (offset === '' || offset.startsWith('..') || isAbsolute(offset)) return reply(400, 'MEDIA_EDIT_INVALID', `${path} is outside film/.`)
  const realInfo = await lstat(real).catch(() => undefined)
  if (realInfo?.isFile() !== true) {
    if (missing === 'null') return null
    return reply(404, 'MEDIA_EDIT_SOURCE_NOT_FOUND', `${path} is not a file in this film.`)
  }
  return { given: text(value)!, path, absolute }
}

/** How the result lands on the board, when the Host is to land it. */
interface Landing {
  nearNodeId: string
  connectFrom: string[]
  title?: string
}

function landingOf(value: unknown): Landing | undefined {
  if (value === undefined || value === null) return undefined
  const nearNodeId = isObject(value) ? text(value.nearNodeId) : undefined
  const connectFrom = isObject(value) ? value.connectFrom ?? [] : undefined
  if (nearNodeId === undefined || !Array.isArray(connectFrom) || connectFrom.length > 40 || connectFrom.some(id => typeof id !== 'string' || id === '')) {
    return reply(400, 'MEDIA_EDIT_INVALID', 'land needs nearNodeId and connectFrom (node ids).')
  }
  const title = isObject(value) ? text(value.title) : undefined
  return { nearNodeId, connectFrom: connectFrom as string[], ...(title !== undefined ? { title: title.slice(0, 120) } : {}) }
}

function wholeMs(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) return reply(400, 'MEDIA_EDIT_INVALID', `${name} must be whole milliseconds.`)
  return value
}

/** Read and check a source file for an edit. */
async function probedSource(cwd: string, value: unknown): Promise<SourceFile & { probe: EditProbe }> {
  const file = (await sourceFile(cwd, value))!
  if (mediaKindOfPath(file.path) === null || mediaKindOfPath(file.path) === 'image') return reply(400, 'MEDIA_EDIT_INVALID', `${file.path} is not a video or audio file.`)
  const probe = await probeDetailed(file.absolute)
  if (!probe.ok) return reply(422, 'MEDIA_EDIT_UNSUPPORTED', `${file.path} cannot be read as video or audio.`)
  return { ...file, probe }
}

/** A new result path: `canvas/media/<prefix>-<10 characters>.<ext>`. */
function resultPath(prefix: string, extension: string): string {
  return `${OUTPUT_FOLDER}/${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10)}${extension}`
}

/** Progress lines `写入 n%`, one per tenth. */
function writingProgress(progress: (line: string) => void): (fraction: number) => void {
  let shown = 0
  return (fraction) => {
    const step = Math.floor(fraction * 10) * 10
    if (step > shown) {
      shown = step
      progress(`写入 ${step}%`)
    }
  }
}

/** One source of a derived node (C1 `derivedFrom.sources`). */
interface DerivedSource {
  nodeId: string
  path: string
  inMs: number
  outMs: number
}

/**
 * Add the media edit routes to a router.
 * @param router - the Studio-compatible router.
 * @param tasks - the film's media tasks.
 * @param events - the project event bus; new files and landed nodes are announced on it.
 */
export function addMediaEditRoutes(router: StudioRouter, tasks: FilmMediaTasks, events: ProjectEvents): void {
  const handle = (handler: (request: StudioRequest) => Promise<unknown>) => async (request: StudioRequest): Promise<unknown> => {
    try {
      return await handler(request)
    } catch (error) {
      if (error instanceof MediaEditError) return reply(error.status, error.code, error.message, { ...error.extra })
      if (error instanceof FilmMediaError) return reply(error.status, error.code, error.message)
      throw error
    }
  }

  const accepted = (started: { taskId: string; status: string }): Response => new Response(JSON.stringify({ taskId: started.taskId, status: started.status }), {
    status: 202,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

  /** The request id of an edit, and the task it already started, if any. */
  const requestOf = async (request: StudioRequest, body: Body, capability: LocalCapability): Promise<{ requestId: string; existing?: { taskId: string; status: string } }> => {
    const requestId = text(body.requestId)
    if (requestId === undefined || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) return reply(400, 'MEDIA_EDIT_INVALID', 'requestId (a UUID) is required.')
    const existing = await tasks.findLocal(request.cwd, requestId, capability)
    return { requestId, ...(existing !== undefined ? { existing } : {}) }
  }

  /**
   * Start the edit as a task: run it, announce the file, land it when asked.
   * @returns the 202 answer.
   */
  const start = async (
    request: StudioRequest,
    edit: {
      capability: LocalCapability
      requestId: string
      parameters: Body
      surface: 'video' | 'audio'
      op: 'cut' | 'join' | 'extract-audio'
      target: string
      sources: DerivedSource[]
      land: Landing | undefined
      metadata?: Body
      run: (absolute: string, options: { signal: AbortSignal; onProgress: (fraction: number) => void }) => Promise<EditResult>
    },
  ): Promise<Response> => {
    const cwd = request.cwd
    const projectId = projectOf(request)
    const boardId = request.params.boardId!
    const absoluteTarget = join(cwd, PROJECT_DIR, ...edit.target.split('/'))
    const started = await tasks.startLocal(cwd, projectId, { capability: edit.capability, requestId: edit.requestId, parameters: edit.parameters, surface: edit.surface }, async (signal, progress) => {
      await mkdir(join(cwd, PROJECT_DIR, ...OUTPUT_FOLDER.split('/')), { recursive: true })
      const result = await edit.run(absoluteTarget, { signal, onProgress: writingProgress(progress) })
      const name = relative(join(cwd, PROJECT_DIR), result.path).split(sep).join('/')
      events.emit(cwd, { type: 'file-changed', projectId, path: name })
      const kind: BoardMediaKind = mediaKindOfPath(name) ?? edit.surface
      const mime = mediaTypeOf(name)?.type ?? (kind === 'audio' ? 'audio/mp4' : 'video/mp4')
      const derivedFrom = { v: 1, op: edit.op, requestId: edit.requestId, engine: 'host-copy', sources: edit.sources, createdAt: new Date().toISOString() }
      let landedNodeId: string | null = null
      let landError: string | undefined
      if (edit.land !== undefined) {
        try {
          landedNodeId = await landFileOnBoard(new CanvasDocumentStore(cwd, projectId), boardId, projectId, {
            path: name,
            kind,
            mimeType: mime,
            title: edit.land.title ?? name.split('/').pop()!,
            ...(result.width !== undefined ? { width: result.width } : {}),
            ...(result.height !== undefined ? { height: result.height } : {}),
            ...(result.durationMs !== undefined ? { durationSeconds: result.durationMs / 1000 } : {}),
            size: result.size,
            metadata: { derivedFrom, ...edit.metadata },
            nearNodeId: edit.land.nearNodeId,
            connectFrom: edit.land.connectFrom,
          })
        } catch (error) {
          // The file is made; a board that cannot be written leaves it for the page to land.
          if (!(error instanceof CanvasDocumentUpdateError)) throw error
          landError = error.message
        }
        if (landedNodeId !== null) events.emit(cwd, { type: 'story-canvas-changed', projectId, boardId })
      }
      const file: FilmTaskFile = {
        name,
        size: result.size,
        kind,
        mime,
        surface: kind,
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
        ...(result.width !== undefined ? { width: result.width } : {}),
        ...(result.height !== undefined ? { height: result.height } : {}),
        ...(result.hasAudio !== undefined ? { hasAudio: result.hasAudio } : {}),
        ...(landedNodeId !== null ? { landedNodeId } : {}),
        ...(landError !== undefined ? { landError } : {}),
        derivedFrom,
      }
      return file
    })
    return accepted(started)
  }

  router.add('POST', MEDIA_PROBE_PATH, handle(async (request) => {
    const body = await request.json()
    const paths = body.paths
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PROBE_PATHS) return reply(400, 'MEDIA_EDIT_INVALID', `paths must list 1 to ${MAX_PROBE_PATHS} files.`)
    const items = []
    for (const value of paths) {
      const file = await sourceFile(request.cwd, value, 'null')
      const given = typeof value === 'string' ? value : ''
      if (file === null) {
        items.push({ path: given, ok: false })
        continue
      }
      const { rotation: _rotation, audioConfigKey: _audioConfigKey, ...probe } = await probeDetailed(file.absolute)
      items.push({ path: given, ...probe })
    }
    return { items }
  }))

  router.add('POST', MEDIA_CUT_PATH, handle(async (request) => {
    const body = await request.json()
    const { requestId, existing } = await requestOf(request, body, 'video.cut')
    if (existing !== undefined) return accepted(existing)
    const sourceValue = isObject(body.source) ? body.source : { path: body.source }
    const source = await probedSource(request.cwd, sourceValue.path)
    const boundary = body.boundary === undefined || body.boundary === null ? 'expand' : body.boundary
    if (boundary !== 'expand' && boundary !== 'shrink') return reply(400, 'MEDIA_EDIT_INVALID', 'boundary must be expand or shrink.')
    const inMs = wholeMs(body.inMs, 'inMs')
    const outMs = wholeMs(body.outMs, 'outMs')
    if (inMs === undefined || outMs === undefined) return reply(400, 'MEDIA_EDIT_INVALID', 'inMs and outMs are required.')
    const range = checkRange({ inMs, outMs }, source.probe.durationMs)
    const { extension, format } = copyTarget(source.path, source.probe, false)
    const problem = copyProblem(source.probe, format(), false)
    if (problem !== undefined) return reply(422, 'MEDIA_EDIT_NEEDS_TRANSCODE', problem.detail, { reasons: [problem] })
    const land = landingOf(body.land)
    const nodeId = text(sourceValue.nodeId) ?? ''
    return start(request, {
      capability: 'video.cut',
      requestId,
      parameters: { source: { nodeId, path: source.path }, inMs: range.inMs, outMs: range.outMs, boundary, ...(land !== undefined ? { land } : {}) },
      surface: source.probe.video === undefined ? 'audio' : 'video',
      op: 'cut',
      target: resultPath('clip', extension),
      sources: [{ nodeId, path: source.path, inMs: range.inMs, outMs: range.outMs }],
      land,
      run: (target, options) => cutFile(source.absolute, target, range, boundary, options),
    })
  }))

  router.add('POST', MEDIA_JOIN_PATH, handle(async (request) => {
    const body = await request.json()
    const { requestId, existing } = await requestOf(request, body, 'video.join')
    if (existing !== undefined) return accepted(existing)
    if (!Array.isArray(body.clips) || body.clips.length < 2 || body.clips.length > MAX_JOIN_CLIPS) return reply(400, 'MEDIA_EDIT_INVALID', `clips must list 2 to ${MAX_JOIN_CLIPS} clips in play order.`)
    const clips: Array<SourceFile & { probe: EditProbe; inMs: number; outMs: number; nodeId: string }> = []
    for (const [index, value] of (body.clips as unknown[]).entries()) {
      if (!isObject(value)) return reply(400, 'MEDIA_EDIT_INVALID', `Clip ${index + 1} must be an object with a path.`)
      const source = await probedSource(request.cwd, value.path)
      if (source.probe.video === undefined) {
        return reply(422, 'VIDEO_JOIN_NEEDS_TRANSCODE', `Clip ${index + 1} has no picture.`, { reasons: [{ index, reason: 'codec', detail: '这一段没有画面。' }] })
      }
      const range = checkRange({ inMs: wholeMs(value.inMs, 'inMs'), outMs: wholeMs(value.outMs, 'outMs') }, source.probe.durationMs)
      clips.push({ ...source, ...range, nodeId: text(value.nodeId) ?? '' })
    }
    const reasons = await joinProblems(clips.map(clip => ({ path: clip.absolute, inMs: clip.inMs, outMs: clip.outMs, probe: clip.probe })))
    if (reasons.length > 0) return reply(422, 'VIDEO_JOIN_NEEDS_TRANSCODE', '这些片段不能无损拼接，需要在分镜页里重新编码。', { reasons })
    const land = landingOf(body.land)
    const sources = clips.map(clip => ({ nodeId: clip.nodeId, path: clip.path, inMs: clip.inMs, outMs: clip.outMs }))
    return start(request, {
      capability: 'video.join',
      requestId,
      parameters: { clips: sources, ...(land !== undefined ? { land } : {}) },
      surface: 'video',
      op: 'join',
      target: resultPath('join', '.mp4'),
      sources,
      land,
      metadata: { workflowKind: 'final', videoEditOperation: 'concat' },
      run: (target, options) => joinFiles(clips.map(clip => ({ path: clip.absolute, inMs: clip.inMs, outMs: clip.outMs })), target, options),
    })
  }))

  router.add('POST', MEDIA_EXTRACT_AUDIO_PATH, handle(async (request) => {
    const body = await request.json()
    const { requestId, existing } = await requestOf(request, body, 'video.extract-audio')
    if (existing !== undefined) return accepted(existing)
    const sourceValue = isObject(body.source) ? body.source : { path: body.source }
    const source = await probedSource(request.cwd, sourceValue.path)
    if (source.probe.audio === undefined) return reply(422, 'VIDEO_NO_AUDIO_TRACK', '这个视频没有音轨。')
    const inMs = wholeMs(body.inMs, 'inMs')
    const outMs = wholeMs(body.outMs, 'outMs')
    const range = inMs === undefined && outMs === undefined ? undefined : checkRange({ inMs, outMs }, source.probe.durationMs)
    const { extension, format } = copyTarget(source.path, source.probe, true)
    const problem = copyProblem(source.probe, format(), true)
    if (problem !== undefined) return reply(422, 'MEDIA_EDIT_NEEDS_TRANSCODE', problem.detail, { reasons: [problem] })
    const land = landingOf(body.land)
    const nodeId = text(sourceValue.nodeId) ?? ''
    const span = range ?? { inMs: 0, outMs: source.probe.durationMs ?? 0 }
    return start(request, {
      capability: 'video.extract-audio',
      requestId,
      parameters: { source: { nodeId, path: source.path }, ...(range ?? {}), ...(land !== undefined ? { land } : {}) },
      surface: 'audio',
      op: 'extract-audio',
      target: resultPath('extract', extension),
      sources: [{ nodeId, path: source.path, inMs: span.inMs, outMs: span.outMs }],
      land,
      run: (target, options) => extractAudio(source.absolute, target, range, options),
    })
  }))
}
