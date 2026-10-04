/**
 * Rendering through the open desk: the request as the page takes it, the
 * files it reports back, and the state of its output job. Ported from
 * Studio's apps/daemon/src/routes/director.ts (`renderAskOf`,
 * `renderedFilesOf`, `renderTaskOf` and the render timeouts) with its codes
 * and texts; refusals are thrown as {@link DirectorRefusal}.
 * @module dsh-film/director/render
 */

import type { DirectorRenderedFile, DirectorRenderRequest, DirectorRenderTask } from './contracts/index.js'
import { DirectorRefusal, projectFileOfUrl } from './locate.js'

export const DIRECTOR_RENDER_TOOL = 'director_render'

/** A render waits as long as a shot takes to record; a video longer still. */
export const DIRECTOR_RENDER_TIMEOUT_MS = 150_000
export const DIRECTOR_RENDER_WITH_VIDEO_TIMEOUT_MS = 300_000
/** Output status and cancel are quick questions to the page. */
export const DIRECTOR_RENDER_STATUS_TIMEOUT_MS = 15_000

export type RenderAsk = Pick<DirectorRenderRequest, 'frames' | 'video' | 'sheet' | 'quality' | 'expectedFingerprint'>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const invalid = (error: string): never => { throw new DirectorRefusal(400, 'DIRECTOR_RENDER_INVALID', error) }

/**
 * The render request as the page takes it — only the fields it knows, only in the shapes it knows.
 * @param body - the request body.
 * @returns the request.
 */
export function renderAskOf(body: Record<string, unknown>): RenderAsk {
  const ask: RenderAsk = {}
  if (body.expectedFingerprint !== undefined) {
    if (typeof body.expectedFingerprint !== 'string' || !body.expectedFingerprint.trim() || body.expectedFingerprint.length > 64) invalid('expectedFingerprint 必须是有效工程指纹')
    ask.expectedFingerprint = body.expectedFingerprint as string
  }
  if (body.frames !== undefined) {
    if (!Array.isArray(body.frames)) invalid('frames 要是一个数组:[{ cameraId?, at?, position? }]')
    const frames: NonNullable<RenderAsk['frames']> = []
    for (const [index, entry] of (body.frames as unknown[]).entries()) {
      if (!isRecord(entry)) return invalid(`frames[${index}] 要是 { cameraId?, at?, position? }`)
      if (entry.at !== undefined && (typeof entry.at !== 'number' || !Number.isFinite(entry.at) || entry.at < 0)) invalid(`frames[${index}].at 要是场景秒数(≥ 0)`)
      if (entry.position !== undefined && entry.position !== 'first' && entry.position !== 'current' && entry.position !== 'last') {
        invalid(`frames[${index}].position 只能是 first、current 或 last`)
      }
      if (entry.shotId !== undefined && (typeof entry.shotId !== 'string' || !entry.shotId.trim())) invalid('shotId 必须是非空镜头 ID')
      frames.push({
        ...(typeof entry.shotId === 'string' ? { shotId: entry.shotId.trim() } : {}),
        ...(typeof entry.cameraId === 'string' && entry.cameraId ? { cameraId: entry.cameraId } : {}),
        ...(typeof entry.at === 'number' ? { at: entry.at } : {}),
        ...(entry.position !== undefined ? { position: entry.position as 'first' | 'current' | 'last' } : {}),
        ...(typeof entry.fileName === 'string' && entry.fileName.trim() ? { fileName: entry.fileName.trim() } : {}),
      })
    }
    ask.frames = frames
  }
  if (body.video === true) {
    ask.video = true
  } else if (isRecord(body.video)) {
    const video = body.video
    if (video.shotId !== undefined && (typeof video.shotId !== 'string' || !video.shotId.trim())) invalid('shotId 必须是非空镜头 ID')
    if (video.sequence !== undefined && (typeof video.sequence !== 'boolean' || (video.sequence && (video.cameraId !== undefined || video.shotId !== undefined)))) {
      invalid('sequence 必须是布尔值，且不能同时指定机位或单镜头')
    }
    ask.video = {
      ...(video.sequence === true ? { sequence: true } : {}),
      ...(typeof video.shotId === 'string' ? { shotId: video.shotId.trim() } : {}),
      ...(typeof video.cameraId === 'string' && video.cameraId ? { cameraId: video.cameraId } : {}),
      ...(video.fps === 24 || video.fps === 30 || video.fps === 60 ? { fps: video.fps } : {}),
    }
  }
  if (body.sheet === true) {
    ask.sheet = true
  } else if (isRecord(body.sheet)) {
    const sheet = body.sheet
    if (sheet.sequence !== undefined && (typeof sheet.sequence !== 'boolean' || (sheet.sequence && sheet.cameraIds !== undefined))) invalid('编排总览不能同时筛选机位')
    const moment = sheet.moment
    ask.sheet = {
      ...(sheet.sequence === true ? { sequence: true } : {}),
      ...(moment === 'start' || moment === 'middle' || moment === 'end' ? { moment } : {}),
      ...(Array.isArray(sheet.cameraIds) ? { cameraIds: sheet.cameraIds.filter((id): id is string => typeof id === 'string' && id.length > 0) } : {}),
    }
  }
  if (body.quality === '720p' || body.quality === '1080p') ask.quality = body.quality
  if (!ask.frames?.length && !ask.video && !ask.sheet) {
    throw new DirectorRefusal(400, 'DIRECTOR_RENDER_EMPTY', '要渲染什么:frames、sheet 或 video 至少一个')
  }
  return ask
}

/**
 * The page's output job, checked.
 * @param value - what the page reported.
 * @returns the job, or `null` when there is none.
 */
export function renderTaskOf(value: unknown): DirectorRenderTask | null {
  if (value === null) return null
  if (!isRecord(value) || typeof value.jobId !== 'string' || !value.jobId || typeof value.label !== 'string'
    || !['preparing', 'rendering', 'finalizing', 'saving', 'cancelling', 'completed', 'cancelled', 'failed'].includes(String(value.phase))
    || !['completedFrames', 'totalFrames', 'savedOutputs'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
    || Number(value.completedFrames) > Number(value.totalFrames)) {
    throw new Error('页面未返回有效输出状态，请更新画布和导演台资源')
  }
  return {
    jobId: value.jobId, label: value.label, phase: value.phase as DirectorRenderTask['phase'],
    completedFrames: Number(value.completedFrames), totalFrames: Number(value.totalFrames), savedOutputs: Number(value.savedOutputs),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  }
}

const isSequenceShot = (shot: unknown): boolean => isRecord(shot) && typeof shot.shotId === 'string' && typeof shot.cameraId === 'string'
  && ['sourceIn', 'sourceOut', 'start', 'end'].every(key => typeof shot[key] === 'number' && Number.isFinite(shot[key]))

/**
 * The files a page reports after a render, with their film-relative paths.
 * @param value - the page's `files`.
 * @returns the files and the project their urls name.
 */
export function renderedFilesOf(value: unknown): { files: DirectorRenderedFile[]; project: string | null } {
  let project: string | null = null
  const files: DirectorRenderedFile[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isRecord(entry) || typeof entry.url !== 'string') continue
    const located = projectFileOfUrl(entry.url)
    if (located && !project) project = located.project
    files.push({
      kind: entry.kind === 'video' ? 'video' : entry.kind === 'sheet' ? 'sheet' : 'frame',
      path: located?.path ?? '',
      url: entry.url,
      fileName: typeof entry.fileName === 'string' ? entry.fileName : located?.path.split('/').pop() ?? '',
      width: Number(entry.width) || 0,
      height: Number(entry.height) || 0,
      ...(typeof entry.nodeId === 'string' ? { nodeId: entry.nodeId } : {}),
      ...(typeof entry.cameraId === 'string' && entry.cameraId ? { cameraId: entry.cameraId } : {}),
      ...(typeof entry.shotId === 'string' ? { shotId: entry.shotId } : {}),
      ...(typeof entry.sourceIn === 'number' ? { sourceIn: entry.sourceIn } : {}),
      ...(typeof entry.directorFingerprint === 'string' ? { directorFingerprint: entry.directorFingerprint } : {}),
      ...(isRecord(entry.sequence) && Array.isArray(entry.sequence.shots) && entry.sequence.shots.length > 0 && entry.sequence.shots.every(isSequenceShot)
        ? { sequence: entry.sequence as NonNullable<DirectorRenderedFile['sequence']> }
        : {}),
      ...(typeof entry.sourceOut === 'number' ? { sourceOut: entry.sourceOut } : {}),
      ...(typeof entry.cameraName === 'string' && entry.cameraName ? { cameraName: entry.cameraName } : {}),
      ...(typeof entry.seconds === 'number' ? { seconds: entry.seconds } : {}),
      ...(typeof entry.durationSeconds === 'number' ? { durationSeconds: entry.durationSeconds } : {}),
      ...(Number.isSafeInteger(entry.frameCount) && Number(entry.frameCount) > 0 ? { frameCount: Number(entry.frameCount) } : {}),
      ...(Number.isSafeInteger(entry.frameRate) && Number(entry.frameRate) > 0 ? { frameRate: Number(entry.frameRate) } : {}),
    })
  }
  return { files, project }
}
