/**
 * The storyboard canvas's model catalogue (`GET /api/media/models`), built
 * from the media models dsh-media reads off the VibeDev gateway. The canvas
 * renders node options and limits from it, so every video limit the gateway
 * declares is carried over in the canvas's own vocabulary.
 * @module dsh-film/media/catalogue
 */

/** The gateway's video modes (catalog schema v1) and the canvas's names for them. */
export const CANVAS_VIDEO_MODES = {
  text_to_video: 'text-to-video',
  first_frame: 'image-to-video',
  first_last_frame: 'first-last-frame',
  omni_reference: 'reference',
} as const

export type GatewayVideoMode = keyof typeof CANVAS_VIDEO_MODES
export type CanvasVideoMode = typeof CANVAS_VIDEO_MODES[GatewayVideoMode]

const VIDEO_INPUTS = ['firstFrame', 'lastFrame', 'referenceImages', 'referenceVideos', 'referenceAudios'] as const
type VideoInput = typeof VIDEO_INPUTS[number]

/** The parts of a dsh-media model this module reads (dsh-media's `MediaModel`). */
export interface HostMediaModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly kind: 'image' | 'video' | 'audio' | 'transcription'
  readonly audioKind?: 'music' | 'podcast'
  readonly inputModalities: readonly string[]
  readonly pricing?: {
    readonly currency: string
    readonly tiers: readonly { readonly tier: string; readonly unit: 'generation' | 'second'; readonly amount: number }[]
    readonly default?: { readonly unit: 'generation' | 'second'; readonly amount: number }
  }
  readonly video?: {
    readonly modes?: Partial<Record<GatewayVideoMode, {
      readonly inputs: Partial<Record<VideoInput, { readonly min: number; readonly max: number; readonly hosted: boolean }>>
      readonly requiredAnyOf: readonly (readonly VideoInput[])[]
      readonly ratios?: readonly string[]
      readonly resolutions?: readonly string[]
      readonly durations?: readonly number[]
    }>>
    readonly ratios?: readonly string[]
    readonly resolutions?: readonly string[]
    readonly durations?: readonly number[]
    readonly nativeAudio?: boolean
    readonly textToVideo?: boolean
    readonly imageToVideo?: boolean
    readonly firstFrame?: boolean
    readonly lastFrame?: boolean
    readonly maxReferenceImages?: number
    readonly maxReferenceVideos?: number
    readonly maxReferenceAudios?: number
    readonly allowedImageMimes?: readonly string[]
    readonly allowedVideoMimes?: readonly string[]
    readonly allowedAudioMimes?: readonly string[]
    readonly maxReferenceImageBytes?: number
    readonly maxReferenceVideoBytes?: number
    readonly maxReferenceAudioBytes?: number
  }
}

export const GATEWAY_PROVIDER = 'vibedev-gateway'

type Json = Record<string, unknown>

/** A model's price as the canvas shows it: the default rate, else the first tier. */
function pricingOf(model: HostMediaModel): Json {
  const pricing = model.pricing
  if (pricing === undefined) return {}
  const rate = pricing.default ?? pricing.tiers[0]
  return {
    mediaPricing: { currency: pricing.currency, tiers: pricing.tiers.map(tier => ({ ...tier })), ...pricing.default === undefined ? {} : { default: { ...pricing.default } } },
    ...rate === undefined || pricing.currency.toUpperCase() !== 'CNY' ? {} : { pricing: { amountCny: rate.amount, unit: rate.unit, exact: true, source: 'gateway' } },
  }
}

/** Modes a legacy entry (no per-mode block) can serve, from its model-level flags. */
function legacyModes(video: NonNullable<HostMediaModel['video']>): CanvasVideoMode[] {
  const modes: CanvasVideoMode[] = []
  if (video.textToVideo !== false) modes.push('text-to-video')
  if (video.imageToVideo === true || video.firstFrame === true) modes.push('image-to-video')
  if (video.lastFrame === true) modes.push('first-last-frame')
  if ((video.maxReferenceImages ?? 0) > 0 || (video.maxReferenceVideos ?? 0) > 0 || (video.maxReferenceAudios ?? 0) > 0) modes.push('reference')
  return modes
}

/**
 * A video model's capabilities in the canvas's vocabulary.
 * @param video - the capabilities dsh-media read.
 * @returns the canvas's `videoCapabilities`.
 */
export function videoCapabilities(video: NonNullable<HostMediaModel['video']>): Json {
  const caps: Json = {}
  if (video.modes !== undefined) {
    const constraints: Json = {}
    const modes: CanvasVideoMode[] = []
    for (const [wire, constraint] of Object.entries(video.modes) as [GatewayVideoMode, NonNullable<NonNullable<HostMediaModel['video']>['modes']>[GatewayVideoMode]][]) {
      const mode = CANVAS_VIDEO_MODES[wire]
      if (mode === undefined || constraint === undefined) continue
      modes.push(mode)
      const inputs: Json = {}
      for (const input of VIDEO_INPUTS) {
        const limit = constraint.inputs[input]
        if (limit !== undefined) inputs[input] = { min: limit.min, max: limit.max, ...limit.hosted ? { source: 'gateway_media_asset' } : {} }
      }
      constraints[mode] = {
        inputs,
        requiredAnyOf: constraint.requiredAnyOf.map(group => [...group]),
        ...(constraint.ratios ?? video.ratios) === undefined ? {} : { supportedAspects: [...(constraint.ratios ?? video.ratios)!] },
        ...(constraint.resolutions ?? video.resolutions) === undefined ? {} : { supportedResolutions: [...(constraint.resolutions ?? video.resolutions)!] },
        ...(constraint.durations ?? video.durations) === undefined ? {} : { supportedDurationsSeconds: [...(constraint.durations ?? video.durations)!] },
      }
    }
    caps.videoModeSchemaVersion = 1
    caps.videoModeConstraints = constraints
    caps.videoModes = modes
  } else {
    caps.videoModes = legacyModes(video)
  }
  if (video.ratios !== undefined) caps.supportedAspects = [...video.ratios]
  if (video.resolutions !== undefined) caps.supportedResolutions = [...video.resolutions]
  if (video.durations !== undefined) caps.supportedDurationsSeconds = [...video.durations]
  const modes = caps.videoModes as CanvasVideoMode[]
  caps.textToVideo = modes.includes('text-to-video')
  caps.imageToVideo = modes.includes('image-to-video')
  caps.referenceImageInput = (video.maxReferenceImages ?? 0) > 0
  caps.referenceVideoInput = (video.maxReferenceVideos ?? 0) > 0
  caps.referenceAudioInput = (video.maxReferenceAudios ?? 0) > 0
  if (video.nativeAudio !== undefined) caps.nativeAudioOutput = video.nativeAudio
  for (const field of ['maxReferenceImages', 'maxReferenceVideos', 'maxReferenceAudios', 'maxReferenceImageBytes', 'maxReferenceVideoBytes', 'maxReferenceAudioBytes'] as const) {
    if (video[field] !== undefined) caps[field] = video[field]
  }
  for (const field of ['allowedImageMimes', 'allowedVideoMimes', 'allowedAudioMimes'] as const) {
    if (video[field] !== undefined) caps[field] = [...video[field]!]
  }
  return caps
}

function canvasModel(model: HostMediaModel): Json {
  return {
    id: model.id,
    label: model.name || model.id,
    ...model.description === undefined ? {} : { hint: model.description },
    provider: GATEWAY_PROVIDER,
    available: true,
    ...model.kind === 'video' && model.video !== undefined ? { videoCapabilities: videoCapabilities(model.video) } : {},
    ...pricingOf(model),
  }
}

const DEFAULT_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9']

/**
 * The catalogue the canvas reads.
 * @param models - dsh-media's models; empty when generation is not available.
 * @returns the catalogue.
 */
export function canvasCatalogue(models: readonly HostMediaModel[]): Json {
  const image = models.filter(model => model.kind === 'image').map(canvasModel)
  const video = models.filter(model => model.kind === 'video').map(canvasModel)
  const audio: Record<string, Json[]> = {}
  for (const model of models.filter(item => item.kind === 'audio')) (audio[model.audioKind ?? 'music'] ??= []).push(canvasModel(model))
  const aspects = new Set<string>(DEFAULT_ASPECTS)
  const lengths = new Set<number>()
  for (const model of models) {
    for (const ratio of model.video?.ratios ?? []) aspects.add(ratio)
    for (const duration of model.video?.durations ?? []) lengths.add(duration)
  }
  return {
    providers: models.length === 0 ? [] : [{ id: GATEWAY_PROVIDER, label: 'VibeDev', integrated: true, configured: true, configurationSource: GATEWAY_PROVIDER }],
    image,
    video,
    audio,
    aspects: [...aspects],
    videoLengthsSec: lengths.size === 0 ? [5, 10] : [...lengths].sort((left, right) => left - right),
    audioDurationsSec: [],
  }
}
