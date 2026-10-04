/**
 * The film's cut, rendered by the Host into the project: a port of Studio's
 * apps/daemon/src/canvas-timeline-render.ts.
 *
 * The editing desk's browser export composites in the page. This runs no
 * page: the pinned upstream headless planner (vendored in
 * `vendor/video-editor-bridge.mjs`) takes the archive's `project`, a `media`
 * block naming a project file for every clip, and the files themselves, and
 * hands back an ffmpeg argument list, which runs on the machine's ffmpeg.
 * The clips are files under `film/` — what placements record on a segment —
 * so the media block is built from those paths, proven inside the project.
 *
 * Nothing here knows about tasks or routes: it takes a document and the
 * project folder and gives back a file, or a {@link TimelineRenderError}
 * whose code the route passes on unchanged. Differences from Studio: the
 * partial is a hidden file beside the target (listings skip dot files), a
 * clip's sound is probed in-process with mediabunny rather than ffprobe, a
 * plan can be handed in so the route plans once, cancellation stops the
 * ffmpeg tree, the time limits grow with the cut's frames and pixels, and a
 * finished file never replaces one that took its name.
 * @module dsh-film/render/timeline-render
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { buildNativeTimelineFfmpegPlan, getNativeTimelineFfmpegMediaRequirements, isTimelineArchive } from '../../vendor/video-editor-bridge.mjs'
import type { UpstreamFfmpegRenderPlan } from '../../vendor/video-editor-bridge.mjs'
import { probeMedia } from '../media/probe.js'
import { canvasFilePathFromVersionId } from '../timeline/commands.js'
import { FfmpegCanceledError, runFfmpeg } from './ffmpeg.js'
import type { FfmpegRun, FfmpegRunResult } from './ffmpeg.js'

/** Where rendered cuts are kept, relative to `film/`. */
export const RENDER_DIR = 'canvas/renders'
export const RENDER_FRAME_RATES = [24, 30, 60] as const
export const RENDER_RESOLUTIONS = ['720', '1080', '1440', '2160'] as const
export type RenderFrameRate = typeof RENDER_FRAME_RATES[number]
/** The short side, in pixels. */
export type RenderResolution = typeof RENDER_RESOLUTIONS[number]
export const DEFAULT_RENDER_FRAME_RATE: RenderFrameRate = 30
export const DEFAULT_RENDER_RESOLUTION: RenderResolution = '720'

/**
 * Long side over short side for every aspect the editor cuts in — its own
 * ratio table, pair for pair. The cinema frames are the table's integer base
 * sizes rather than the pure ratio: the browser export scales those same
 * integers (2.39 × 1080 rounds to 2582 where 1720 × 1.5 is 2580).
 */
const ASPECTS: Readonly<Record<string, { w: number; h: number }>> = {
  '16:9': { w: 16, h: 9 },
  '9:16': { w: 9, h: 16 },
  '1:1': { w: 1, h: 1 },
  '4:5': { w: 4, h: 5 },
  '21:9': { w: 1680, h: 720 },
  '2.39:1': { w: 1720, h: 720 },
}

/**
 * A refusal or failure with the HTTP status and code the route passes on.
 * The planner's own codes (`UNSUPPORTED_RENDER_FEATURE`, `MISSING_MEDIA`,
 * `EMPTY_TIMELINE`...) are kept: the desk and the agent already know them.
 */
export class TimelineRenderError extends Error {
  override name = 'TimelineRenderError'

  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: unknown) {
    super(message)
  }

  /** What a task reports: only ffmpeg itself might not fail the same way twice. */
  get details(): { retryable: boolean } {
    return { retryable: this.code === 'FFMPEG_FAILED' }
  }
}

export interface RenderSettings {
  frameRate: RenderFrameRate
  resolution: RenderResolution
  fileName?: string
  baseRevision?: number
  /** Answer what the render would be, with every refusal a render has, and start nothing. */
  check?: boolean
}

/**
 * What a render request may say, in the shapes the renderer takes; anything
 * else is a 400. `check` is the contract's name for Studio's `dryRun`; both are read.
 * @param body - the request body.
 * @returns the settings.
 */
export function normalizeRenderRequest(body: unknown): RenderSettings {
  const raw = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const invalid = (message: string): TimelineRenderError => new TimelineRenderError(400, 'CANVAS_TIMELINE_RENDER_INVALID', message)
  const frameRate = raw.frameRate === undefined ? DEFAULT_RENDER_FRAME_RATE : Number(raw.frameRate)
  if (!(RENDER_FRAME_RATES as readonly number[]).includes(frameRate)) throw invalid(`frameRate must be one of ${RENDER_FRAME_RATES.join(', ')}`)
  const resolution = raw.resolution === undefined ? DEFAULT_RENDER_RESOLUTION : String(raw.resolution).replace(/p$/i, '')
  if (!(RENDER_RESOLUTIONS as readonly string[]).includes(resolution)) throw invalid(`resolution must be one of ${RENDER_RESOLUTIONS.map(value => `${value}p`).join(', ')}`)
  const settings: RenderSettings = { frameRate: frameRate as RenderFrameRate, resolution: resolution as RenderResolution }
  if (raw.baseRevision !== undefined) {
    if (typeof raw.baseRevision !== 'number' || !Number.isInteger(raw.baseRevision) || raw.baseRevision < 0) throw invalid('baseRevision must be a non-negative integer')
    settings.baseRevision = raw.baseRevision
  }
  if (raw.fileName !== undefined) {
    if (typeof raw.fileName !== 'string' || raw.fileName.trim() === '') throw invalid('fileName must be a non-empty string')
    settings.fileName = raw.fileName.trim()
  }
  for (const key of ['check', 'dryRun'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') throw invalid(`${key} must be a boolean`)
    if (raw[key] === true) settings.check = true
  }
  return settings
}

/**
 * Output size for an aspect at a resolution: the short side is the
 * resolution, both sides even.
 * @param ratioId - the cut's aspect (`16:9` when unknown).
 * @param resolution - the short side.
 * @returns the size.
 */
export function renderSizeFor(ratioId: unknown, resolution: RenderResolution): { width: number; height: number } {
  const aspect = ASPECTS[typeof ratioId === 'string' ? ratioId : ''] ?? ASPECTS['16:9']!
  const short = Number(resolution)
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2)
  if (aspect.w >= aspect.h) return { width: even((short * aspect.w) / aspect.h), height: short }
  return { width: short, height: even((short * aspect.h) / aspect.w) }
}

/** A name a person typed or a film title, as a file stem: no path, nothing a file system refuses. */
const fileStem = (value: string): string => value.replace(/\.mp4$/i, '').replaceAll('\\', '/').split('/').pop()!
  .replace(/[^\p{L}\p{N}._ -]+/gu, '-').replace(/^\.+/, '').trim()

/**
 * `canvas/renders/<name>.mp4`: the caller's name losing anything that is a
 * path; otherwise the film's title (Studio names it after the board, which
 * here is the project's UUID), the revision and the moment.
 * @param input - the board, revision, the caller's name and the film's title.
 * @returns the project-relative path.
 */
export function renderOutputPath(input: { boardId: string; revision: number; fileName?: string | undefined; title?: string | undefined; now?: Date }): string {
  const stem = input.fileName !== undefined ? fileStem(input.fileName) : ''
  if (stem !== '') return `${RENDER_DIR}/${stem}.mp4`
  const now = input.now ?? new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const named = input.title !== undefined ? fileStem(input.title).slice(0, 48).trim() : ''
  const board = named !== '' ? named : input.boardId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'board'
  return `${RENDER_DIR}/${board}-r${input.revision}-${stamp}.mp4`
}

type Segment = Record<string, unknown>

function segmentsOf(project: Record<string, unknown>, key: string): Segment[] {
  const value = project[key]
  return Array.isArray(value) ? value.filter((item): item is Segment => item !== null && typeof item === 'object') : []
}

/**
 * The project file a segment plays. Three places can say it and placements
 * write them together: the integrity record's `archivePath`, the version id
 * (`canvas-file:<path>`), and the source URL the editor streams from
 * (`/api/projects/<id>/raw/<path>`). The first that resolves wins; a segment
 * naming none of them is not a project file and cannot be rendered here.
 * @param segment - a clip.
 * @returns the project-relative path, or `null`.
 */
export function segmentProjectPath(segment: Segment): string | null {
  const integrity = segment.integrity
  if (integrity !== null && typeof integrity === 'object') {
    const archivePath = (integrity as Record<string, unknown>).archivePath
    if (typeof archivePath === 'string' && archivePath.trim() !== '') return archivePath.replaceAll('\\', '/')
  }
  for (const key of ['assetVersionId', 'assetId']) {
    const value = segment[key]
    if (typeof value === 'string') {
      const path = canvasFilePathFromVersionId(value)
      if (path !== null) return path
    }
  }
  for (const key of ['sourceUrl', 'src']) {
    const value = segment[key]
    if (typeof value !== 'string') continue
    const match = /^(?:https?:\/\/[^/]+)?\/api\/projects\/[^/]+\/raw\/(.+?)(?:[?#].*)?$/.exec(value)
    if (match?.[1] !== undefined) {
      try {
        return match[1].split('/').map(part => decodeURIComponent(part)).join('/')
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * The file behind a project-relative path, proven inside the project on real
 * paths on both sides: a symbolic link under the project can point anywhere.
 */
async function ownedFile(projectDir: string, path: string): Promise<string | null> {
  if (posix.isAbsolute(path) || isAbsolute(path) || path.split('/').some(part => part === '..' || part === '.' || part === '')) return null
  try {
    const root = await realpath(resolve(projectDir))
    const file = await realpath(resolve(root, ...path.split('/')))
    const inside = relative(root, file)
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null
    return (await stat(file)).isFile() ? file : null
  } catch {
    return null
  }
}

export interface RenderMedia {
  media: Record<string, unknown>
  extractedFiles: Map<string, string>
  /** Clips whose file could not be found inside the project, by track. */
  missing: Array<{ track: string; clipId: string; path: string | null }>
}

/** Whether a file carries a sound stream; `undefined` when that cannot be said. */
export type ProbeHasAudio = (absolutePath: string) => Promise<boolean | undefined>

/**
 * The `media` block and file map the planner wants, from the cut's own
 * segments. Only what the planner will read is resolved — its own
 * requirement lists — so a clip on a muted lane or a hidden track neither
 * needs a file nor can refuse the render. Entries are keyed by segment id.
 * @param project - the archive's project.
 * @param projectDir - the workspace's `film/`.
 * @param options - how to tell whether a video clip's file has sound; without it no clip's own sound is rendered.
 * @returns the block, the files and what is missing.
 */
export async function collectRenderMedia(project: Record<string, unknown>, projectDir: string, options: { probeHasAudio?: ProbeHasAudio | undefined } = {}): Promise<RenderMedia> {
  const required = getNativeTimelineFfmpegMediaRequirements(project)
  const extractedFiles = new Map<string, string>()
  const missing: RenderMedia['missing'] = []
  const entriesFor = async (track: string, segments: Segment[]): Promise<Array<{ id: string; path: string }>> => {
    const entries: Array<{ id: string; path: string }> = []
    for (const segment of segments) {
      const clipId = String(segment.id ?? '')
      const path = segmentProjectPath(segment)
      const absolute = path !== null ? await ownedFile(projectDir, path) : null
      if (path === null || absolute === null) {
        missing.push({ track, clipId, path })
        continue
      }
      extractedFiles.set(path, absolute)
      entries.push({ id: clipId, path })
    }
    return entries
  }
  const visuals = await entriesFor('visuals', required.visuals)
  const overlays = await entriesFor('overlays', required.overlays)
  const stickers = await entriesFor('stickers', required.stickers)
  const audioSegments = await entriesFor('audio', required.audioSegments)
  const musicEntries = await entriesFor('music', required.musicSegments)
  // A video clip's own sound joins the mix only when its file really carries
  // a sound stream; otherwise the lane stays silent rather than handing
  // ffmpeg an input with no audio to map.
  const sourceAudioSegments: Array<{ id: string; path: string }> = []
  if (options.probeHasAudio !== undefined) {
    const sourceEntries = await entriesFor('source', required.sourceAudio)
    for (const segment of required.sourceAudio) {
      const entry = sourceEntries.find(item => item.id === String(segment.id ?? ''))
      const absolute = entry !== undefined ? extractedFiles.get(entry.path) : undefined
      if (entry === undefined || absolute === undefined) continue
      if (await options.probeHasAudio(absolute) === true) sourceAudioSegments.push(entry)
      else if (project.sourceAudioSource !== undefined && project.sourceAudioSource !== null && project.sourceAudioSource !== false) missing.push({ track: 'source', clipId: String(segment.id ?? ''), path: entry.path })
    }
  }
  return {
    media: {
      visuals,
      overlays,
      stickers,
      audioSegments,
      audio: audioSegments[0] ?? null,
      music: musicEntries[0] ?? null,
      sourceAudio: null,
      sourceAudioSegments,
      analyses: [],
    },
    extractedFiles,
    missing,
  }
}

/**
 * Caption fonts the cut uses beyond the default, which must be on disk.
 * @param project - the archive's project.
 * @returns the font ids.
 */
export function captionFontIdsOf(project: Record<string, unknown>): string[] {
  const style = project.captionStyle !== null && typeof project.captionStyle === 'object' ? project.captionStyle as Record<string, unknown> : {}
  const ids = new Set<string>()
  for (const caption of segmentsOf(project, 'captionSegments')) {
    if (caption.hidden === true) continue
    const fontId = typeof caption.fontId === 'string' && caption.fontId !== '' ? caption.fontId : typeof style.fontId === 'string' ? style.fontId : 'default'
    if (fontId !== '' && fontId !== 'default') ids.add(fontId)
  }
  return [...ids]
}

export interface TimelinePlanInput {
  document: unknown
  /** The workspace's `film/`. */
  projectDir: string
  frameRate: RenderFrameRate
  resolution: RenderResolution
  /** Where a downloaded caption font is, or `null` when it is not cached. */
  resolveCaptionFont?: ((fontId: string) => Promise<string | null>) | undefined
  probeHasAudio?: ProbeHasAudio | undefined
}

export interface TimelinePlan {
  plan: UpstreamFfmpegRenderPlan
  project: Record<string, unknown>
  width: number
  height: number
  /** Caption fonts beyond the default the plan burns in, each found on disk. */
  captionFonts: string[]
  /** The loudness the mix is normalised to. */
  targetLoudnessLufs: number
  /** Video clips whose own sound joins the mix. */
  sourceAudioClips: string[]
}

const PLANNER_STATUS: Readonly<Record<string, number>> = {
  UNSUPPORTED_RENDER_FEATURE: 422,
  MISSING_MEDIA: 422,
  EMPTY_TIMELINE: 422,
  MISSING_RENDER_RESOURCE: 422,
  INVALID_PROJECT: 422,
  INVALID_RENDER_SETTINGS: 400,
}

/**
 * The ffmpeg plan for a cut, or the reason there is none. Runs before any
 * task exists, so an unsupported cut is refused on the request rather than
 * found as a failed task a minute later.
 * @param input - the cut, the project folder and the settings.
 * @returns the plan.
 * @throws {@link TimelineRenderError} for a cut that cannot be rendered.
 */
export async function buildTimelinePlan(input: TimelinePlanInput): Promise<TimelinePlan> {
  if (!isTimelineArchive(input.document)) throw new TimelineRenderError(422, 'EMPTY_TIMELINE', '这部片子还没有剪辑，没有可渲染的内容。')
  const project = (input.document as Record<string, unknown>).project as Record<string, unknown>
  if (segmentsOf(project, 'visualSegments').length === 0) throw new TimelineRenderError(422, 'EMPTY_TIMELINE', '剪辑里还没有画面片段：先往时间线上放点东西。')
  const collected = await collectRenderMedia(project, input.projectDir, { probeHasAudio: input.probeHasAudio })
  if (collected.missing.length > 0) {
    const named = collected.missing.map(item => `${item.track}/${item.clipId}${item.path !== null ? ` (${item.path})` : ''}`).join(', ')
    throw new TimelineRenderError(422, 'MISSING_MEDIA', `这些片段播放的不是本项目里的文件，宿主无法渲染：${named}`, { missing: collected.missing })
  }
  const captionFonts: Record<string, { path: string }> = {}
  for (const fontId of captionFontIdsOf(project)) {
    const fontPath = input.resolveCaptionFont !== undefined ? await input.resolveCaptionFont(fontId) : null
    if (fontPath !== null) captionFonts[fontId] = { path: fontPath }
  }
  const size = renderSizeFor(project.ratioId, input.resolution)
  try {
    const plan = buildNativeTimelineFfmpegPlan({
      project,
      media: collected.media,
      extractedFiles: collected.extractedFiles,
      settings: { frameRate: input.frameRate, width: size.width, height: size.height, preset: 'medium', crf: 18 },
      rendererResources: { captionFonts },
    })
    return {
      plan,
      project,
      width: plan.width,
      height: plan.height,
      captionFonts: Object.keys(captionFonts),
      targetLoudnessLufs: plan.targetLoudnessLufs ?? -14,
      sourceAudioClips: (collected.media.sourceAudioSegments as Array<{ id: string }>).map(entry => entry.id),
    }
  } catch (error) {
    const code = error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'RENDER_PLAN_FAILED'
    const message = error instanceof Error ? error.message : String(error)
    const hint = code === 'MISSING_RENDER_RESOURCE' ? '（剪辑用到的字幕字体还没下载：在剪辑台里选一次这款字体让它下载好，再渲染）' : ''
    throw new TimelineRenderError(PLANNER_STATUS[code] ?? 500, code, `${message}${hint}`)
  }
}

/**
 * How long the output may stand still before the render is declared stuck.
 * ffmpeg does not fail on a source it cannot decode — a corrupt still under
 * `-loop 1` is retried forever — and output time is the one signal that
 * cannot lie: a heavy transition encodes slower than real time, but never two
 * minutes without a frame.
 */
export const RENDER_STALL_TIMEOUT_MS = 120_000
/** Studio's whole-run limit, kept as the floor. */
export const RENDER_MAX_DURATION_MS = 30 * 60_000
const RENDER_TIME_CEILING_MS = 6 * 60 * 60_000

/** 720p at 30 fps, in pixels a second: the frame the allowances below are measured at. */
const BASE_PIXEL_RATE = 1280 * 720 * 30
/**
 * The slowest pace a render is expected to keep, in pixels a second, with
 * room to spare: a plain cut at a sixth of 720p30 real time, a graded one
 * (per-pixel `geq`, about 20× slower than real time at 720p) at a fortieth.
 */
const PLAIN_PIXEL_RATE = BASE_PIXEL_RATE / 6
const GRADED_PIXEL_RATE = BASE_PIXEL_RATE / 40
/**
 * Frames the encoder holds before its first packet: libx264 `medium`'s
 * 40-frame rate-control lookahead plus B-frames and frame threads, rounded up.
 */
const ENCODER_DELAY_FRAMES = 60

type TimedPlan = Pick<UpstreamFfmpegRenderPlan, 'args' | 'duration' | 'width' | 'height' | 'frameRate'>

/** Milliseconds one output frame of the plan may take at the slowest expected pace. */
function frameAllowanceMs(plan: TimedPlan): number {
  const graded = plan.args.some(arg => arg.includes('geq='))
  return (plan.width * plan.height * 1000) / (graded ? GRADED_PIXEL_RATE : PLAIN_PIXEL_RATE)
}

/**
 * The whole-run limit for a plan: its frames × pixels at the slowest
 * expected pace, at least Studio's 30 minutes and at most six hours. A
 * three-minute graded film, or a 4K one at 60 fps, would hit a fixed limit
 * while still working; at 720p30 this is 6× the cut's length, 40× graded.
 * @param plan - the plan.
 * @returns milliseconds.
 */
export function renderTimeLimitMs(plan: TimedPlan): number {
  const allowance = plan.duration * plan.frameRate * frameAllowanceMs(plan)
  return Math.min(RENDER_TIME_CEILING_MS, Math.max(RENDER_MAX_DURATION_MS, Math.round(allowance)))
}

/**
 * How long ffmpeg may run before its first output time: the encoder's
 * lookahead filled at the slowest expected pace, at least the stall timeout.
 * A large graded frame takes seconds, so the first packet can be minutes in
 * coming while every frame is being worked on.
 * @param plan - the plan.
 * @returns milliseconds.
 */
export function renderFirstOutputMs(plan: TimedPlan): number {
  const allowance = ENCODER_DELAY_FRAMES * frameAllowanceMs(plan)
  return Math.min(RENDER_TIME_CEILING_MS, Math.max(RENDER_STALL_TIMEOUT_MS, Math.round(allowance)))
}

/** Runs ffmpeg; the default spawns it, tests stand a script in. */
export type FfmpegRunner = (run: FfmpegRun) => Promise<FfmpegRunResult>

/**
 * The integrated loudness of a finished file by ffmpeg's EBU R128 meter —
 * the number the mix was normalised toward, read back from the file.
 * @param runner - how ffmpeg is run.
 * @param binary - the ffmpeg binary.
 * @param file - the file.
 * @param cwd - a working folder.
 * @param signal - stops the measurement.
 * @returns LUFS, or `undefined` when ffmpeg could not say.
 */
export async function measureLoudnessLufs(runner: FfmpegRunner, binary: string, file: string, cwd: string, signal?: AbortSignal): Promise<number | undefined> {
  try {
    const result = await runner({
      binary,
      argv: ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=none', '-f', 'null', '-'],
      cwd,
      ...(signal !== undefined ? { signal } : {}),
      stallTimeoutMs: 10 * 60_000,
      maxDurationMs: 10 * 60_000,
    })
    const match = /Integrated loudness:\s*I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/.exec(result.stderr)
    const value = match !== null ? Number(match[1]) : Number.NaN
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * A file's SHA-256.
 * @param file - the file.
 * @returns the hex digest.
 */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => { resolveDigest(hash.digest('hex')) })
  })
}

/**
 * The hidden file a render writes before it is put in place: beside the
 * target, so the link stays on one volume, and a dot file, so neither the
 * desk's material list nor the renders list shows a half-written cut.
 * @param target - the final absolute path.
 * @returns the partial's absolute path.
 */
export function partialPathFor(target: string): string {
  const name = target.slice(dirname(target).length + 1).replace(/\.mp4$/i, '')
  return join(dirname(target), `.${name}.partial.mp4`)
}

/**
 * Remove the partials an interrupted render left in a renders folder (the
 * Host stopped mid-render). Only safe while no render of this film runs.
 * @param folder - the absolute renders folder.
 */
export async function removeStalePartials(folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[])
  await Promise.all(names.filter(name => /^\..+\.partial\.mp4$/i.test(name)).map(name => rm(join(folder, name), { force: true }).catch(() => {})))
}

/**
 * Put a finished partial in place under the name reserved for it, or under
 * the next free one (`<stem>-2.mp4`, `-3`..., as `freeProjectPath` names
 * them) when another file took that name while the render ran. A hard link
 * never replaces a file, where a rename would; on a file system without hard
 * links the name is claimed by creating it exclusively, and the partial is
 * then renamed over that empty claim.
 * @param partial - the finished partial.
 * @param target - the reserved absolute path.
 * @param fs - the hard link call (tests stand in one that fails).
 * @returns the absolute path kept.
 */
export async function keepRender(partial: string, target: string, fs: { link?: (existing: string, path: string) => Promise<void> } = {}): Promise<string> {
  const linkFile = fs.link ?? link
  const folder = dirname(target)
  const name = basename(target)
  const match = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(name)
  const stem = match?.[1] ?? name
  const extension = match?.[2] ?? ''
  let linkless = false
  for (let index = 1; index < 10_000; index++) {
    const candidate = join(folder, index === 1 ? name : `${stem}-${index}${extension}`)
    try {
      if (linkless) {
        await (await open(candidate, 'wx')).close()
        await rename(partial, candidate).catch(async (error: unknown) => {
          await rm(candidate, { force: true }).catch(() => {})
          throw error
        })
        return candidate
      }
      await linkFile(partial, candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      if (linkless || code === 'ENOENT') throw error
      // No hard links here (FAT, exFAT, some shares): claim this same name the other way.
      linkless = true
      index--
      continue
    }
    await rm(partial, { force: true })
    return candidate
  }
  throw new TimelineRenderError(409, 'RENDER_NAME_TAKEN', `渲染完成了，但 ${name} 和它的编号名都被占用，没能保存。`)
}

export interface TimelineRenderInput extends TimelinePlanInput {
  /** Project-relative output path, `canvas/renders/….mp4`. */
  outputPath: string
  ffmpegBinary: string
  /** The plan the route already made for this input; planned again when absent. */
  planned?: TimelinePlan | undefined
  onProgress?: ((progress: { percent: number; seconds: number; duration: number }) => void) | undefined
  signal?: AbortSignal | undefined
  stallTimeoutMs?: number | undefined
  /** The allowance before ffmpeg's first output time; {@link renderFirstOutputMs} when absent. */
  firstOutputTimeoutMs?: number | undefined
  maxDurationMs?: number | undefined
  runner?: FfmpegRunner | undefined
}

export interface TimelineRenderOutput {
  path: string
  absolutePath: string
  size: number
  mtime: number
  sha256: string
  width: number
  height: number
  frameRate: number
  durationSeconds: number
  hasAudio: boolean
  /** Integrated loudness measured after the render; absent when silent or unmeasured. */
  loudnessLufs?: number
  targetLoudnessLufs: number
}

const canceled = (): TimelineRenderError => new TimelineRenderError(499, 'RENDER_CANCELED', '渲染已取消。')

/**
 * Run the plan. ffmpeg runs in a scratch folder holding the sidecars (the
 * planner names `captions.ass` and the font files relative to the working
 * folder) and writes the hidden partial, put in place ({@link keepRender}) only
 * when ffmpeg exits clean: a failed or cancelled render leaves no file that
 * looks finished, and a finished one never replaces a file that took its name.
 * @param input - the cut, the output path, ffmpeg and the controls.
 * @returns the file.
 * @throws {@link TimelineRenderError} — a refusal, `FFMPEG_STALLED`, `FFMPEG_TIMEOUT`, `FFMPEG_FAILED` or `RENDER_CANCELED`.
 */
export async function renderTimeline(input: TimelineRenderInput): Promise<TimelineRenderOutput> {
  // Read afresh each time: the signal changes while the render awaits.
  const aborted = (): boolean => input.signal?.aborted === true
  if (aborted()) throw canceled()
  const planned = input.planned ?? await buildTimelinePlan(input)
  const { plan } = planned
  const runner = input.runner ?? runFfmpeg
  const target = resolve(input.projectDir, ...input.outputPath.split('/'))
  await mkdir(dirname(target), { recursive: true })
  const partial = partialPathFor(target)
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-film-render-'))
  let kept: string | undefined
  try {
    for (const sidecar of plan.sidecars ?? []) {
      const file = join(workDir, sidecar.filename)
      if (typeof sidecar.content === 'string') await writeFile(file, sidecar.content, 'utf8')
      else if (typeof sidecar.sourcePath === 'string') await copyFile(sidecar.sourcePath, file)
    }
    // `-progress pipe:1` makes a long render observable: an `out_time_us`
    // line per second on stdout, against the plan's duration.
    const argv = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...plan.args.slice(2), partial]
    const stallTimeoutMs = input.stallTimeoutMs ?? RENDER_STALL_TIMEOUT_MS
    const firstOutputTimeoutMs = Math.max(stallTimeoutMs, input.firstOutputTimeoutMs ?? renderFirstOutputMs(plan))
    const maxDurationMs = input.maxDurationMs ?? renderTimeLimitMs(plan)
    let result: FfmpegRunResult
    try {
      result = await runner({
        binary: input.ffmpegBinary,
        argv,
        cwd: workDir,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        stallTimeoutMs,
        firstOutputTimeoutMs,
        maxDurationMs,
        onOutTime: (seconds) => {
          const duration = plan.duration
          const percent = duration > 0 ? Math.max(0, Math.min(99, Math.floor((seconds / duration) * 100))) : 0
          input.onProgress?.({ percent, seconds, duration })
        },
      })
    } catch (error) {
      if (error instanceof FfmpegCanceledError || aborted()) throw canceled()
      throw new TimelineRenderError(500, 'FFMPEG_FAILED', `ffmpeg 没能启动：${error instanceof Error ? error.message : String(error)}`)
    }
    // The last lines ffmpeg said before it ended or was stopped.
    const tail = (): string => {
      const lines = result.stderr.trim().split('\n').slice(-6).join('\n')
      return lines !== '' ? `: ${lines}` : ''
    }
    const seconds = (ms: number): string => `${ms >= 10_000 ? Math.round(ms / 1000) : (ms / 1000).toFixed(1)}s`
    if (result.stalled) {
      // Which clock ran out: the first frame's allowance, or the one between frames.
      const before = result.produced === false
      throw new TimelineRenderError(500, 'FFMPEG_STALLED', `ffmpeg ${before ? `开始后 ${seconds(firstOutputTimeoutMs)} 仍没有产出第一帧` : `连续 ${seconds(stallTimeoutMs)} 没有产出新画面`}，已停止——通常是它解不开某个素材${tail()}`)
    }
    if (result.timedOut) throw new TimelineRenderError(500, 'FFMPEG_TIMEOUT', `ffmpeg 运行超过 ${seconds(maxDurationMs)} 仍未结束，已停止${tail()}`)
    if (result.code !== 0) throw new TimelineRenderError(500, 'FFMPEG_FAILED', `ffmpeg 渲染失败（退出码 ${result.code}）${tail()}`)
    if (aborted()) throw canceled()
    kept = await keepRender(partial, target)
    const info = await stat(kept)
    const durationSeconds = (await probeMedia(kept)).durationSeconds ?? plan.duration
    const loudnessLufs = plan.hasAudio ? await measureLoudnessLufs(runner, input.ffmpegBinary, kept, workDir, input.signal) : undefined
    const sha256 = await sha256File(kept)
    // Cancelled while the file was being measured: it was never announced, so it goes.
    if (aborted()) throw canceled()
    return {
      // The name actually kept: another file may have taken the reserved one meanwhile.
      path: `${input.outputPath.slice(0, input.outputPath.lastIndexOf('/') + 1)}${basename(kept)}`,
      absolutePath: kept,
      size: info.size,
      mtime: info.mtimeMs,
      sha256,
      width: plan.width,
      height: plan.height,
      frameRate: plan.frameRate,
      durationSeconds,
      hasAudio: plan.hasAudio,
      ...(loudnessLufs !== undefined ? { loudnessLufs } : {}),
      targetLoudnessLufs: planned.targetLoudnessLufs,
    }
  } catch (error) {
    if (kept !== undefined) await rm(kept, { force: true }).catch(() => {})
    throw error
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    await rm(partial, { force: true }).catch(() => {})
  }
}
