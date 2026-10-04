/**
 * The parts of the editing desk's bridge (vibedev-video-editor,
 * `packages/video-editor-bridge`) this plugin uses: the timeline command
 * engine and the headless render planner. `video-editor-bridge.mjs` beside
 * this file is that package's contract build, copied in by
 * `node scripts/build-apps.mjs editor`, which checks it still exports these.
 */

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[]
export interface JsonObject { [key: string]: JsonValue }

export interface VideoEditorCommandOperation extends JsonObject {
  id: string
  type: string
}

export interface VideoEditorCommandPlan {
  schemaVersion: 1
  baseRevision: number
  operations: VideoEditorCommandOperation[]
}

export type VideoEditorCommandExecutionResult =
  | {
      ok: true
      revision: number
      appliedOperationIds: string[]
      warnings: JsonValue[]
      document: JsonObject
      before: JsonObject
      after: JsonObject
      changes: JsonObject
    }
  | { ok: false; code: string; message: string; operationId?: string }

export function executeVideoEditorCommandPlan(document: JsonObject, plan: VideoEditorCommandPlan): VideoEditorCommandExecutionResult

/**
 * The pinned upstream headless planner (vendor/ai-video-editor
 * `projectRenderPlan.js`, through the bridge's `upstream-render-plan.ts`):
 * a cut and the files its clips play become one ffmpeg argument list. The
 * Host's background render runs it on the machine's ffmpeg.
 */
export interface UpstreamFfmpegRenderPlan {
  args: string[]
  duration: number
  width: number
  height: number
  frameRate: number
  hasAudio: boolean
  targetLoudnessLufs?: number
  sidecars?: Array<
    | { filename: string; content: string; sourcePath?: never }
    | { filename: string; sourcePath: string; content?: never }
  >
}

/** The segments the planner will read files for, per track. */
export interface UpstreamFfmpegRenderMediaRequirements {
  visuals: Array<Record<string, unknown>>
  overlays: Array<Record<string, unknown>>
  stickers: Array<Record<string, unknown>>
  audioSegments: Array<Record<string, unknown>>
  musicSegments: Array<Record<string, unknown>>
  /** Video clips whose own sound plays, when the host finds a sound stream in their files. */
  sourceAudio: Array<Record<string, unknown>>
  analyses: Array<Record<string, unknown>>
}

export interface NativeTimelineFfmpegPlanInput {
  project: Record<string, unknown>
  media?: Record<string, unknown>
  extractedFiles: Map<string, string>
  settings?: Record<string, unknown>
  rendererResources?: {
    captionFonts?: Record<string, { path: string }>
  }
}

/** Throws an error with a `code` (`UNSUPPORTED_RENDER_FEATURE`, `MISSING_MEDIA`...) for a cut it cannot plan. */
export function buildNativeTimelineFfmpegPlan(input: NativeTimelineFfmpegPlanInput): UpstreamFfmpegRenderPlan

export function getNativeTimelineFfmpegMediaRequirements(project: Record<string, unknown>): UpstreamFfmpegRenderMediaRequirements

/** What a cut's final mix plays, by the render's audibility rules (captions plan their sources from it). */
export type NativeTimelineMediaRequirements = UpstreamFfmpegRenderMediaRequirements

/** The timing fields of a clip that map timeline time to source time (constant speed or a speed curve). */
export interface TimelineSourceClip {
  duration: number
  sourceStart?: number
  sourceDuration?: number
  playbackRate?: number
  speedCurve?: unknown
  [key: string]: unknown
}

/** Source seconds at `t` seconds into the clip. */
export function getTimelineSourceTime(clip: TimelineSourceClip, t: number): number
/** Seconds into the clip at which source second `s` plays. */
export function getTimelineLocalTime(clip: TimelineSourceClip, s: number): number
/** Whether a value is a version 3 Timeline Studio archive. */
export function isTimelineArchive(value: unknown): boolean
