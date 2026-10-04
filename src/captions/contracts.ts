/**
 * The shapes of original-audio captions, as Studio's contracts define them
 * (`packages/contracts/src/api/timeline-captions.ts`), plus what dsh-film
 * adds: the recognition engine on the request and the draft, and the input
 * and output of an engine. All times are seconds; a `taskId` is a film task
 * (`film/.tasks/<id>.json`), never an agent run.
 * @module dsh-film/captions/contracts
 */

/** Who recognises the speech: the editing desk's Whisper in a hidden page, or the VibeDev gateway's ASR (paid, Mandarin). */
export type CaptionEngine = 'whisper' | 'gateway'

export const CAPTION_ENGINES: readonly CaptionEngine[] = ['whisper', 'gateway']

/** `POST /api/canvas/timelines/:boardId/transcribe`. */
export interface TimelineTranscribeRequest {
  baseRevision: number
  /** Empty only for an estimate, which needs none. */
  requestId: string
  clipIds?: string[]
  /** Timeline seconds. */
  range?: { start: number; end: number }
  language?: string
  /** The engine; the plugin setting `captionEngine` when omitted. Part of the request's identity. */
  engine?: CaptionEngine
  /** The desk showed the gateway price and the person went ahead (not part of the identity). */
  spendingConfirmed?: boolean
  /** Only answer what the recognition would send and cost: no task, nothing copied, nothing charged. */
  estimateOnly?: boolean
}

/** What an estimate answers (200). */
export interface TimelineTranscribeEstimate {
  /** Source seconds the engine would be sent, and their price (0 for Whisper). */
  estimate: Required<CaptionEstimate>
  engine: CaptionEngine
}

/** One recognised source: a clip's audible stretch inside the requested range. */
export interface TimelineCaptionSource {
  clipId: string
  track: 'visual' | 'audio'
  /** Project-relative (inside `film/`). */
  file: string
  /** Timeline seconds. */
  start: number
  end: number
  /** Original-source seconds. */
  sourceIn: number
  sourceOut: number
  assetVersionId: string
  /** The frozen inputs of the clip's time curve. */
  mapping: { clipStart: number; clip: CaptionClipTiming }
  /** Of the snapshot actually recognised. */
  sha256?: string
}

/** The timing fields of a clip the time curve reads. */
export interface CaptionClipTiming {
  duration: number
  sourceStart: number
  sourceDuration: number
  playbackRate: number
  speedCurve?: unknown
  [key: string]: unknown
}

/** One draft line. */
export interface TimelineCaptionSegment {
  id: string
  text: string
  warnings?: string[]
  /** Timeline seconds. */
  start: number
  end: number
  sourceClipId: string
  /** Original-source seconds. */
  sourceIn: number
  sourceOut: number
}

/** A recognition's unreviewed result, kept as the task's `file.documentResult`. */
export interface TimelineCaptionDraft {
  kind: 'timeline-caption-draft'
  schemaVersion: 1
  baseRevision: number
  /** `whisper-small-q8`, or `gateway:<model id>`. */
  model: string
  engine: CaptionEngine
  diagnostics?: Array<{ sourceClipId: string; evidence: Record<string, unknown> }>
  /** The full raw and mapped output, when it does not fit the task (`film/.tasks/caption-evidence/<taskId>.json`). */
  evidence?: { file: string; sha256: string; bytes: number }
  reviewStatus: 'unreviewed'
  /** The merged timeline ranges actually covered. */
  ranges: Array<{ start: number; end: number }>
  sources: TimelineCaptionSource[]
  segments: TimelineCaptionSegment[]
}

/** `POST /api/canvas/timelines/:boardId/captions/apply`. */
export interface TimelineCaptionApplyRequest {
  taskId: string
  /** The draft was checked against the original sound. */
  reviewed: boolean
  excludeSegmentIds?: string[]
  dryRun: boolean
}

/** One row of `GET /api/canvas/timelines/:boardId/captions/tasks`. */
export interface TimelineCaptionTaskSummary {
  taskId: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted'
  engine: CaptionEngine
  model: string
  startedAt: number
  endedAt: number | null
  applied: boolean
  /** Draft lines (0 until the task is done). */
  segments: number
  ranges: Array<{ start: number; end: number }>
  /** The last progress line (Studio's summary). */
  progress: string[]
  error?: { code?: string; message: string } | null
}

/** What an engine gives back for one source; segment times are seconds from the source's `sourceIn`. */
export interface CaptionRecognition {
  sourceClipId: string
  diagnostics?: Record<string, unknown>
  segments: Array<{ text: string; start: number; end: number; warnings?: string[] }>
}

/** Who asked, for the gateway's spending confirmation. */
export interface CaptionCaller {
  /** The agent whose tool call started the recognition. */
  agent?: unknown
  callId?: string
}

/** What an engine recognises from. */
export interface CaptionRecognizerInput {
  taskId: string
  cwd: string
  /** Snapshots of the plan's sources (absolute paths). */
  sources: Array<{ clipId: string; file: string; sourceIn: number; sourceOut: number }>
  /** The model files the engine prepared, by artifact id. */
  artifacts: Record<string, string>
  language: string
  signal: AbortSignal
  /** Recognition progress, 0..1. */
  onProgress(update: { progress: number; phase: string }): void
  /** Whether the person confirmed the cost, and who asked. */
  spending: { confirmed: boolean } & CaptionCaller
}

/** An estimate of a paid recognition. */
export interface CaptionEstimate {
  /** Source seconds sent at most (only speech is sent, so usually less). */
  seconds: number
  amountCny?: number
  basis: string
}
