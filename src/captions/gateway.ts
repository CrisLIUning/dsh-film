/**
 * The `gateway` recognition engine: the VibeDev gateway's ASR through
 * dsh-media's `vibedevMedia.transcribe` — paid (about ¥0.05 a minute),
 * Mandarin only, and the audio leaves the machine.
 *
 * The gateway answers with text but, today, no timings, and a caption without
 * a real time is worse than none. So the engine works by speech regions: a
 * caption runner page decodes each source and cuts it where Silero VAD hears
 * speech (the same detector the Whisper worker uses), the Host sends each
 * region as its own WAV, and each region becomes one line timed by the
 * region's bounds (`warnings: ['region-timing']`). When the gateway does
 * return segment timings for a region, they are used instead, offset by the
 * region's start. Timings are never invented; without a window to cut the
 * regions the engine refuses rather than guessing.
 *
 * Each region carries an idempotency key made from its audio
 * (`dsh-film-asr:<sha256 of the WAV>`) and a stable file name, so neither
 * dsh-media's own retries nor a later recognition of the same audio (after a
 * failure, a cancel or a restart) charges twice; the same audio twice in one
 * recognition is sent once.
 *
 * The cost is confirmed as dsh-media's spending setting says: the desk shows
 * the price first (`spendingConfirmed`); an agent's recognition is confirmed
 * once for the whole estimate while its tool call still waits, through
 * dsh-media's `confirmSpending` (an older dsh-media asks per region instead).
 * @module dsh-film/captions/gateway
 */

import { createHash } from 'node:crypto'
import type { HostMediaModel } from '../media/catalogue.js'
import type { MediaServiceLike, TranscribeServiceResult, TranscribeSpending } from '../media/tasks.js'
import type { EditorModels } from '../models/service.js'
import type { CaptionEstimate, CaptionRecognition, CaptionRecognizerInput } from './contracts.js'
import { VAD_MODEL, prepareModels, requireConsents } from './engines.js'
import type { CaptionEngineDriver } from './engines.js'
import { TimelineCaptionError } from './plan.js'
import type { CaptionRunnerHub } from './runner.js'

/** What one gateway transcription may send (dsh-media's `TRANSCRIBE_LIMITS`). */
export const GATEWAY_LIMITS = { maxSeconds: 600, maxBytes: 20_000_000 } as const
/** The languages the gateway transcribes. */
export const GATEWAY_LANGUAGES: readonly string[] = ['zh']
/** The gateway's retail price when the catalogue gives none per second. */
const RETAIL_CNY_PER_MINUTE = 0.05

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** dsh-media failures the person can act on, in their words, with the status the task records. */
const MEDIA_FAILURES: Readonly<Record<string, { status: number; message: string }>> = {
  NOT_SIGNED_IN: { status: 401, message: '网关转写需要登录 VibeDev 账号：在插件页打开 dsh-media 的设置登录。' },
  INSUFFICIENT_BALANCE: { status: 402, message: 'VibeDev 余额不足，充值后再试。' },
  SPENDING_DECLINED: { status: 403, message: '已拒绝网关转写的费用，没有继续。' },
  SPENDING_CONFIRMATION_UNAVAILABLE: { status: 409, message: '网关转写需要确认费用，但当前无法弹出确认；请在剪辑台里识别，或在 dsh-media 设置里调整费用确认。' },
  AUDIO_IDEMPOTENCY_CONFLICT: { status: 409, message: '同一段音频的转写请求与之前的不一致，请重新识别。' },
  TRANSCRIPTION_TIMEOUT: { status: 504, message: '网关转写超时没有完成，请稍后重新识别。' },
  TRANSCRIPTION_FAILED: { status: 502, message: '网关转写失败（失败的转写不计费），请稍后重试。' },
  MEDIA_TOO_LARGE: { status: 413, message: '一段语音超过了网关转写的大小上限。' },
  AUDIO_TOO_LONG: { status: 413, message: '一段语音超过了网关转写的时长上限。' },
  AUDIO_FORMAT_UNSUPPORTED: { status: 415, message: '网关不接受这段音频的格式。' },
  AUDIO_INPUT_INVALID: { status: 422, message: '网关不接受这段音频。' },
  ABORTED: { status: 499, message: '网关转写已取消。' },
}

function mediaFailure(error: unknown): TimelineCaptionError {
  const code = (error as { code?: unknown } | undefined)?.code
  const known = typeof code === 'string' ? MEDIA_FAILURES[code] : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (typeof code === 'string' && known !== undefined) return new TimelineCaptionError(code, known.message, known.status, { detail: message })
  return new TimelineCaptionError(typeof code === 'string' ? code : 'CAPTION_RECOGNITION_FAILED', `网关转写失败：${message}`, 502)
}

/** The transcription model dsh-media would use first, or why there is none. */
async function transcriptionModel(media: MediaServiceLike, signal?: AbortSignal): Promise<HostMediaModel> {
  let models: readonly HostMediaModel[]
  try {
    models = await media.models(signal)
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code
    const cause = typeof code === 'string' ? code : 'MEDIA_CATALOG_UNAVAILABLE'
    const message = cause === 'NOT_SIGNED_IN' ? '网关转写需要登录 VibeDev 账号：在插件页打开 dsh-media 的设置登录。' : `暂时读不到网关的模型目录：${error instanceof Error ? error.message : String(error)}`
    throw new TimelineCaptionError('CAPTION_ENGINE_UNAVAILABLE', message, 503, { cause })
  }
  const model = models.find(entry => entry.kind === 'transcription')
  if (model === undefined) throw new TimelineCaptionError('CAPTION_ENGINE_UNAVAILABLE', '这个 VibeDev 账号没有可用的转写模型。', 503, { cause: 'NO_MODEL_AVAILABLE' })
  return model
}

/**
 * What a recognition of `seconds` source seconds costs at most: only speech
 * regions are sent, so the bill is usually lower.
 * @param model - the transcription model.
 * @param seconds - the planned source seconds.
 * @returns the estimate.
 */
export function gatewayEstimate(model: HostMediaModel | undefined, seconds: number): CaptionEstimate {
  const rate = model?.pricing?.default ?? model?.pricing?.tiers[0]
  const perSecond = rate?.unit === 'second' && model?.pricing?.currency.toUpperCase() === 'CNY' ? rate.amount : undefined
  const amount = (perSecond ?? RETAIL_CNY_PER_MINUTE / 60) * seconds
  return {
    seconds: Math.round(seconds * 10) / 10,
    amountCny: Math.max(0.01, Math.round(amount * 100) / 100),
    basis: perSecond !== undefined
      ? 'catalogue price per second × source seconds; an upper bound, only speech is sent'
      : 'retail ¥0.05 per minute × source seconds; an upper bound, only speech is sent',
  }
}

/**
 * A region's idempotency key: its WAV bytes' SHA-256, so the same audio sent
 * again — by a new task after a failure, a cancel or a restart — is answered
 * from the gateway's idempotency store instead of being charged again.
 * @param wav - the region's WAV bytes.
 * @returns `dsh-film-asr:<hex digest>`.
 */
export function regionKey(wav: Uint8Array): string {
  return `dsh-film-asr:${createHash('sha256').update(wav).digest('hex')}`
}

/** One speech region a runner page cut, in source-file seconds, with its 16 kHz mono WAV. */
interface Region {
  start: number
  end: number
  wav: Uint8Array
}

/**
 * Read an `extract` job's result: per source, its speech regions (seconds of
 * the source file, VAD padding included) and their WAV bytes.
 * @param value - what the page posted.
 * @param sources - the job's sources.
 * @returns the regions by clip id.
 */
export function readRegions(value: unknown, sources: CaptionRecognizerInput['sources']): Map<string, Region[]> {
  const invalid = (detail: string): TimelineCaptionError => new TimelineCaptionError('CAPTION_RESULT_INVALID', `the region page returned ${detail}`, 422)
  if (!Array.isArray(value)) throw invalid('no source list')
  const regions = new Map<string, Region[]>()
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.sourceClipId !== 'string' || !Array.isArray(entry.regions)) throw invalid('a malformed source')
    if (!sources.some(source => source.clipId === entry.sourceClipId) || regions.has(entry.sourceClipId)) throw invalid('an unknown or repeated source')
    regions.set(entry.sourceClipId, entry.regions.map((raw) => {
      const region = isRecord(raw) ? raw : {}
      const { start, end, wav } = region
      if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || typeof wav !== 'string') {
        throw invalid('a malformed region')
      }
      const bytes = Buffer.from(wav, 'base64')
      if (bytes.byteLength < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') throw invalid('a region that is not a WAV file')
      if (bytes.byteLength > GATEWAY_LIMITS.maxBytes) throw invalid('a region over the gateway\'s size limit')
      return { start, end, wav: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
    }))
  }
  if (regions.size !== sources.length) throw invalid('fewer sources than it was given')
  return regions
}

/** A region's lines, seconds from the source's `sourceIn`: the gateway's timings when it gave usable ones, else the region itself. */
function regionLines(answer: TranscribeServiceResult, from: number, to: number): CaptionRecognition['segments'] {
  const timed = (answer.segments ?? []).flatMap((segment) => {
    const text = typeof segment.text === 'string' ? segment.text.trim() : ''
    if (text === '' || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start || segment.start < 0) return []
    const start = from + segment.start
    const end = Math.min(to, from + segment.end)
    return end > start ? [{ text, start, end }] : []
  })
  if (timed.length > 0) return timed
  const text = answer.text.trim()
  return text === '' ? [] : [{ text, start: from, end: to, warnings: ['region-timing'] }]
}

export interface GatewayEngineOptions {
  /** dsh-media's service, read at each call: it can come and go. */
  media: () => MediaServiceLike | undefined
  /** The model store, for the speech detector the region cutter runs. */
  models?: EditorModels
  runner?: CaptionRunnerHub
  pollMs?: number
}

/**
 * The `gateway` engine.
 * @param options - dsh-media, the model store and the runner.
 * @returns the engine.
 */
export function gatewayEngine(options: GatewayEngineOptions): CaptionEngineDriver {
  const service = (): MediaServiceLike & Required<Pick<MediaServiceLike, 'transcribe'>> => {
    const media = options.media()
    if (media === undefined) throw new TimelineCaptionError('CAPTION_ENGINE_UNAVAILABLE', '网关转写需要 dsh-media 插件（VibeDev 媒体生成）。请在插件页安装并启用它。', 503, { cause: 'MEDIA_SERVICE_UNAVAILABLE' })
    if (typeof media.transcribe !== 'function') throw new TimelineCaptionError('CAPTION_ENGINE_UNAVAILABLE', '这个版本的 dsh-media 还不能转写，请把它更新到 0.1.3 或更新的版本。', 503, { cause: 'MEDIA_TRANSCRIBE_UNSUPPORTED' })
    return media as MediaServiceLike & Required<Pick<MediaServiceLike, 'transcribe'>>
  }
  const runnerOrFail = (): CaptionRunnerHub => {
    const availability = options.runner?.availability() ?? { available: false as const, reason: '这个环境没有识别页面。' }
    if (!availability.available || options.runner === undefined) {
      throw new TimelineCaptionError('CAPTION_RUNTIME_UNAVAILABLE', `网关没有返回时间，需要在窗口里按语音分段后再转写：${(availability as { reason: string }).reason}`, 503)
    }
    return options.runner
  }
  const modelsOrFail = (): EditorModels => {
    if (options.models === undefined) throw new TimelineCaptionError('CAPTION_RUNTIME_UNAVAILABLE', '这个环境没有语音分段需要的模型服务。', 503)
    return options.models
  }
  return {
    id: 'gateway',
    async preflight({ request, plan, caller, signal }) {
      const language = request.language ?? 'zh'
      if (!/^zh(?:-|$)/.test(language)) throw new TimelineCaptionError('CAPTION_ENGINE_LANGUAGE_UNSUPPORTED', '网关转写只支持普通话（zh）；其他语言请用 engine:\'whisper\'。', 400)
      const media = service()
      const model = await transcriptionModel(media, signal)
      await requireConsents(modelsOrFail(), [VAD_MODEL])
      runnerOrFail()
      const seconds = plan.sources.reduce((total, source) => total + source.sourceOut - source.sourceIn, 0)
      const estimate = gatewayEstimate(model, seconds)
      // An agent's recognition: dsh-media's setting asks once for the whole estimate, while the tool call
      // still waits, rather than per region from the background task. An older dsh-media asks per region.
      const confirm = media.confirmSpending
      if (request.estimateOnly === true || request.spendingConfirmed === true || caller?.agent === undefined || caller.callId === undefined || typeof confirm !== 'function') {
        return { model: `gateway:${model.id}`, estimate }
      }
      try {
        await confirm.call(media, { seconds: estimate.seconds, amountCny: estimate.amountCny }, { confirmed: false, agent: caller.agent, callId: caller.callId }, signal)
      } catch (error) {
        throw mediaFailure(error)
      }
      return { model: `gateway:${model.id}`, estimate, spendingConfirmed: true }
    },
    async prepare(context) {
      return prepareModels(modelsOrFail(), [VAD_MODEL], context, options.pollMs)
    },
    async recognize(input) {
      const media = service()
      const extracted = await runnerOrFail().run(
        { kind: 'extract', language: input.language, sources: input.sources, artifacts: input.artifacts },
        { signal: input.signal, onProgress: (update) => { input.onProgress({ progress: update.progress * 0.3, phase: update.phase }) } },
      )
      const regions = readRegions(extracted, input.sources)
      const total = [...regions.values()].reduce((count, list) => count + list.length, 0)
      let done = 0
      let model: string | undefined
      const recognitions: CaptionRecognition[] = []
      // Confirmed (by the desk, or once by preflight for an agent): every region goes as confirmed. Otherwise
      // dsh-media's setting asks per region through the agent's tool call, as an older dsh-media does.
      const spending: TranscribeSpending = input.spending.confirmed
        ? { confirmed: true }
        : {
          confirmed: false,
          ...(input.spending.agent !== undefined ? { agent: input.spending.agent } : {}),
          ...(input.spending.callId !== undefined ? { callId: input.spending.callId } : {}),
        }
      // The same audio twice in one recognition (a take used twice) is transcribed once: it has one key.
      const answers = new Map<string, Promise<TranscribeServiceResult>>()
      for (const [sourceIndex, source] of input.sources.entries()) {
        const length = source.sourceOut - source.sourceIn
        const segments: CaptionRecognition['segments'] = []
        const evidence: Array<Record<string, unknown>> = []
        for (const [regionIndex, region] of (regions.get(source.clipId) ?? []).entries()) {
          input.signal.throwIfAborted()
          // Region bounds are source-file seconds; the mapping reads seconds from sourceIn.
          const from = Math.min(length, Math.max(0, region.start - source.sourceIn))
          const to = Math.min(length, Math.max(0, region.end - source.sourceIn))
          if (to > from) {
            let answer: TranscribeServiceResult
            let reused = false
            try {
              const key = regionKey(region.wav)
              let pending = answers.get(key)
              reused = pending !== undefined
              if (pending === undefined) {
                pending = media.transcribe({
                  data: region.wav,
                  mimeType: 'audio/wav',
                  name: `region-${sourceIndex}-${regionIndex}.wav`,
                  language: 'zh',
                  idempotencyKey: key,
                  timestamps: true,
                  background: true,
                }, { cwd: input.cwd }, input.signal, spending)
                answers.set(key, pending)
              }
              answer = await pending
            } catch (error) {
              if (input.signal.aborted) throw error
              throw mediaFailure(error)
            }
            model = answer.model
            const lines = regionLines(answer, from, to)
            segments.push(...lines)
            evidence.push({
              start: region.start, end: region.end,
              ...(answer.taskId !== undefined ? { gatewayTaskId: answer.taskId } : {}),
              // A repeat of audio already sent in this recognition was not charged again.
              ...(reused ? { reused: true } : answer.chargedCny !== undefined ? { chargedCny: answer.chargedCny } : {}),
              timing: lines.some(line => line.warnings?.includes('region-timing') === true) ? 'region' : lines.length > 0 ? 'gateway' : 'empty',
              text: answer.text,
            })
          }
          done++
          input.onProgress({ progress: 0.3 + 0.7 * (done / Math.max(1, total)), phase: `网关转写 ${done}/${total} 段` })
        }
        recognitions.push({ sourceClipId: source.clipId, segments, diagnostics: { engine: 'gateway', mode: 'region', regions: evidence } })
      }
      // The draft names the model that actually transcribed (dsh-media may have one pinned).
      return model === undefined ? recognitions : recognitions.map(recognition => ({ ...recognition, diagnostics: { ...recognition.diagnostics, model } }))
    },
    async describe(signal) {
      const runner = options.runner
      const base = {
        id: 'gateway',
        languages: [...GATEWAY_LANGUAGES],
        limits: { ...GATEWAY_LIMITS },
        consent: { [VAD_MODEL]: options.models === undefined ? false : (await options.models.consent(VAD_MODEL)).granted },
        runner: runner !== undefined && runner.connected > 0 ? 'connected' : 'none',
      }
      let model: HostMediaModel | undefined
      try {
        model = await transcriptionModel(service(), signal)
        runnerOrFail()
        return { ...base, available: true, model: model.id, pricePerMinuteCny: gatewayEstimate(model, 60).amountCny }
      } catch (error) {
        const known = error instanceof TimelineCaptionError ? error : undefined
        return {
          ...base,
          available: false,
          reason: known?.message.replace(/^[A-Z_]+: /, '') ?? String(error),
          ...(known?.extra.cause !== undefined ? { cause: known.extra.cause } : {}),
          ...(model !== undefined ? { model: model.id, pricePerMinuteCny: gatewayEstimate(model, 60).amountCny } : {}),
        }
      }
    },
  }
}
