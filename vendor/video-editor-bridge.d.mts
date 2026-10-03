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
