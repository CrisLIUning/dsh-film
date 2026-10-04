/**
 * The part of the editing desk's bridge (vibedev-video-editor,
 * `packages/video-editor-bridge`) this plugin uses: the timeline command
 * engine. `video-editor-bridge.mjs` beside this file is that package's
 * contract build, copied in by `node scripts/build-apps.mjs editor`.
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

/** What a cut's final mix plays, by the render's audibility rules (captions plan their sources from it). */
export interface NativeTimelineMediaRequirements {
  visuals: Record<string, unknown>[]
  overlays: Record<string, unknown>[]
  stickers: Record<string, unknown>[]
  audioSegments: Record<string, unknown>[]
  musicSegments: Record<string, unknown>[]
  /** Clips whose own sound plays: the processed source-audio lane's segments, then visuals with embedded sound. */
  sourceAudio: Record<string, unknown>[]
  analyses: Record<string, unknown>[]
}

export function getNativeTimelineFfmpegMediaRequirements(project: Record<string, unknown>): NativeTimelineMediaRequirements

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
