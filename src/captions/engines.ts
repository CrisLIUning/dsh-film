/**
 * The recognition engine behind one seam (Studio's `recognize` dependency):
 * what it refuses before a task exists, which model files it prepares, and
 * how it recognises the snapshots. The engine is Studio's — the editing
 * desk's Whisper small q8 with Silero VAD — run in a page through the caption
 * runner; when it cannot run, a recognition fails and says why.
 * @module dsh-film/captions/engines
 */

import type { EditorModels } from '../models/service.js'
import { modelFileRoute } from '../studio/model-routes.js'
import type { CaptionEngine, CaptionRecognition, CaptionRecognizerInput, TimelineTranscribeRequest } from './contracts.js'
import { TimelineCaptionError } from './plan.js'
import type { TranscriptionPlan } from './plan.js'
import type { CaptionRunnerHub } from './runner.js'

/** The desk's recognition model, as Studio names it. */
export const WHISPER_MODEL = 'whisper-small-q8'
/** The speech detector the Whisper worker uses. */
const VAD_MODEL = 'silero-vad'

/** The recognition engine. */
export interface CaptionEngineDriver {
  readonly id: CaptionEngine
  /**
   * Refuse, before a task exists, what cannot run now (missing consent, no window).
   * @returns the model the draft will name.
   */
  preflight(input: { cwd: string; request: TimelineTranscribeRequest; plan: TranscriptionPlan }): Promise<{ model: string }>
  /**
   * Get the model files ready (verified, downloaded if needed).
   * @returns their URLs by artifact id.
   */
  prepare(context: { signal: AbortSignal; onProgress(update: { progress: number; phase: string }): void }): Promise<Record<string, string>>
  /** Recognise the snapshots; segment times are seconds from each source's `sourceIn`. */
  recognize(input: CaptionRecognizerInput & { model: string }): Promise<CaptionRecognition[]>
  /** What the engines route says about this engine. */
  describe(): Promise<Record<string, unknown>>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The models among `modelIds` the person has not agreed to download.
 * @param models - the model store.
 * @param modelIds - the models a recognition needs.
 * @returns the missing ones, in order.
 */
export async function missingConsents(models: EditorModels, modelIds: readonly string[]): Promise<string[]> {
  const missing: string[] = []
  for (const modelId of modelIds) if (!(await models.consent(modelId)).granted) missing.push(modelId)
  return missing
}

/** Refuse a recognition whose models the person has not agreed to download (the desk asks first, then retries). */
async function requireConsents(models: EditorModels, modelIds: readonly string[]): Promise<void> {
  const missing = await missingConsents(models, modelIds)
  if (missing.length === 0) return
  const labels = missing.map(modelId => models.manifest(modelId).label).join('、')
  throw new TimelineCaptionError('VIDEO_EDITOR_MODEL_CONSENT_REQUIRED', `识别前需要你同意下载 ${labels}`, 409, { modelIds: missing })
}

const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(signal.reason)
    return
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', stop)
    resolve()
  }, ms)
  const stop = (): void => {
    clearTimeout(timer)
    reject(signal.reason)
  }
  signal.addEventListener('abort', stop, { once: true })
})

/**
 * Prepare models one after another, following each preparation as Studio
 * does (a 200 ms poll), and collect their files' URLs into one map: the
 * Whisper worker and the speech detector find their files by artifact id.
 * @param models - the model store.
 * @param modelIds - the models, in order.
 * @param context - cancellation and progress (0..1 per model).
 * @param pollMs - how often a preparation is read.
 * @returns the artifact URLs.
 */
async function prepareModels(
  models: EditorModels,
  modelIds: readonly string[],
  context: { signal: AbortSignal; onProgress(update: { progress: number; phase: string }): void },
  pollMs = 200,
): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {}
  for (const modelId of modelIds) {
    const preparation = await models.startPrepare(modelId)
    try {
      for (;;) {
        context.signal.throwIfAborted()
        const task = models.task(preparation.taskId)
        context.onProgress({ progress: task.progress / 100, phase: task.phase })
        if (task.status === 'done') break
        if (task.status !== 'running') throw new TimelineCaptionError(task.error?.code ?? 'CAPTION_MODEL_FAILED', task.error?.message ?? 'model preparation failed', 503)
        await delay(pollMs, context.signal)
      }
    } finally {
      // A recognition that stops leaves no download running for nobody.
      if (models.task(preparation.taskId).status === 'running') models.cancel(preparation.taskId)
    }
    const manifest = models.manifest(modelId)
    for (const artifact of manifest.artifacts) artifacts[artifact.id] = modelFileRoute(manifest.id, manifest.revision, artifact.id)
  }
  return artifacts
}

/**
 * A page's Whisper result in the shape the mapping reads: one entry per
 * source with its lines (text, start, end, warnings) and its diagnostics.
 * Anything else is a broken result, not speech.
 * @param value - what the page posted.
 * @returns the recognitions.
 */
export function readWhisperResult(value: unknown): CaptionRecognition[] {
  if (!Array.isArray(value)) throw new TimelineCaptionError('CAPTION_RESULT_INVALID', 'the recognition page returned no source list', 422)
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.sourceClipId !== 'string' || !Array.isArray(entry.segments)) {
      throw new TimelineCaptionError('CAPTION_RESULT_INVALID', 'the recognition page returned a malformed source', 422)
    }
    return {
      sourceClipId: entry.sourceClipId,
      ...(isRecord(entry.diagnostics) ? { diagnostics: entry.diagnostics } : {}),
      segments: entry.segments.map((segment) => {
        const line = isRecord(segment) ? segment : {}
        const warnings = Array.isArray(line.warnings) ? line.warnings.filter((warning): warning is string => typeof warning === 'string') : undefined
        return {
          text: line.text as string,
          start: line.start as number,
          end: line.end as number,
          ...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
        }
      }),
    }
  })
}

/**
 * The `whisper` engine: free, local, Studio's pipeline, run in a hidden page
 * of an open DSH window.
 * @param options - the model store (absent: the engine is unavailable) and the runner.
 * @returns the engine.
 */
export function whisperEngine(options: { models?: EditorModels; runner?: CaptionRunnerHub; pollMs?: number }): CaptionEngineDriver {
  const modelIds = [WHISPER_MODEL, VAD_MODEL]
  const unavailable = (): TimelineCaptionError => new TimelineCaptionError('CAPTION_RUNTIME_UNAVAILABLE', '这个环境没有剪辑台的识别模型服务。', 503)
  return {
    id: 'whisper',
    async preflight() {
      const { models, runner } = options
      if (models === undefined || runner === undefined) throw unavailable()
      await requireConsents(models, modelIds)
      const availability = runner.availability()
      if (!availability.available) throw new TimelineCaptionError('CAPTION_RUNTIME_UNAVAILABLE', availability.reason, 503)
      return { model: WHISPER_MODEL }
    },
    async prepare(context) {
      if (options.models === undefined) throw unavailable()
      return prepareModels(options.models, modelIds, context, options.pollMs)
    },
    async recognize(input) {
      if (options.runner === undefined) throw unavailable()
      const result = await options.runner.run(
        { kind: 'whisper', language: input.language, sources: input.sources, artifacts: input.artifacts },
        { signal: input.signal, onProgress: input.onProgress },
      )
      return readWhisperResult(result)
    },
    async describe() {
      const { models, runner } = options
      const consent = Object.fromEntries(await Promise.all(modelIds.map(async modelId => [modelId, models === undefined ? false : (await models.consent(modelId)).granted] as const)))
      const downloadBytes = models === undefined ? 0 : models.list().filter(model => modelIds.includes(model.id)).reduce((total, model) => total + model.totalBytes, 0)
      const availability = runner?.availability() ?? { available: false as const, reason: '这个环境没有剪辑台的识别模型服务。' }
      const available = models !== undefined && availability.available
      return {
        id: 'whisper',
        available,
        ...(available ? {} : { reason: models === undefined ? '这个环境没有剪辑台的识别模型服务。' : (availability as { reason: string }).reason }),
        consent,
        downloadBytes,
        runner: runner !== undefined && runner.connected > 0 ? 'connected' : 'none',
      }
    },
  }
}
