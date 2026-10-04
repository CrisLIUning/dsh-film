/**
 * The storyboard canvas's model catalogue (`GET /api/media/models`), built
 * from the media models dsh-media reads off the VibeDev gateway. The canvas
 * renders node options and limits from it, so every video limit the gateway
 * declares is carried over in the canvas's own vocabulary.
 *
 * Video modes are the ones dsh-media will accept ({@link effectiveVideoModes},
 * the same rule dsh-media checks a request against): a mode the canvas offers
 * but dsh-media refuses would only fail after the click.
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

/** How many of one input a mode accepts, and whether it must be a gateway-hosted asset (dsh-media's `VideoInputLimit`). */
export interface HostVideoInputLimit {
  readonly min: number
  readonly max: number
  readonly hosted: boolean
}

/** One mode's declaration; absent lists inherit the model-level lists (dsh-media's `VideoModeConstraint`). */
export interface HostVideoModeConstraint {
  readonly inputs: Partial<Record<VideoInput, HostVideoInputLimit>>
  readonly requiredAnyOf: readonly (readonly VideoInput[])[]
  readonly ratios?: readonly string[]
  readonly resolutions?: readonly string[]
  readonly durations?: readonly number[]
}

/** A video model's declared capabilities (dsh-media's `VideoCapabilities`). */
export interface HostVideoCapabilities {
  /** Per-mode declarations; undefined for a legacy entry, whose modes follow from the model-level fields. */
  readonly modes?: Partial<Record<GatewayVideoMode, HostVideoModeConstraint>>
  /** A modes block was present in a schema version dsh-media does not read: the model serves no mode. */
  readonly unreadableModesVersion?: number
  readonly ratios?: readonly string[]
  readonly resolutions?: readonly string[]
  readonly durations?: readonly number[]
  readonly combinations?: readonly { readonly duration?: number; readonly ratio?: string; readonly resolution?: string }[]
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
  readonly maxAssetBytes?: number
  readonly minReferenceVideoSeconds?: number
  readonly maxReferenceVideoSeconds?: number
  readonly maxTotalReferenceVideoSeconds?: number
  /** References must be relayed through the gateway media library. */
  readonly gatewayRelayRequired?: boolean
}

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
  readonly video?: HostVideoCapabilities
}

export const GATEWAY_PROVIDER = 'vibedev-gateway'

/** Why a video model whose modes dsh-media cannot read is listed but not offered. */
export const UNREADABLE_VIDEO_MODES_REASON = '网关为这个模型声明的视频模式无法识别，暂时不能生成'

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

/**
 * The modes a model can serve: its declared v1 modes, or for a legacy entry the
 * conservative set its model-level fields imply. An unreadable modes block serves none.
 *
 * Ported verbatim from dsh-media src/gateway/catalog.ts:263-302 (effectiveVideoModes,
 * dsh-media 0.1.3, 1d45ce5) — the rule dsh-media validates a video request with — with
 * the types renamed to this module's. Keep the two in step.
 * @param video - the model's capabilities.
 * @returns the usable modes and their constraints.
 */
export function effectiveVideoModes(video: HostVideoCapabilities): Partial<Record<GatewayVideoMode, HostVideoModeConstraint>> {
  if (video.unreadableModesVersion !== undefined) return {}
  if (video.modes !== undefined) return video.modes
  const modes: Partial<Record<GatewayVideoMode, HostVideoModeConstraint>> = {}
  if (video.textToVideo !== false) modes.text_to_video = { inputs: {}, requiredAnyOf: [] }
  // `image_to_video` alone is not a first frame: a lane that takes reference images
  // declares it too. Only an explicit `first_frame`, or image-to-video on a lane with
  // no other way to take an image, opens the first-frame mode.
  const images = video.maxReferenceImages ?? 0
  if (video.firstFrame === true || (video.imageToVideo === true && video.firstFrame === undefined && images === 0)) {
    modes.first_frame = { inputs: { firstFrame: { min: 1, max: 1, hosted: false } }, requiredAnyOf: [['firstFrame']] }
  }
  if (video.firstFrame === true && video.lastFrame === true) {
    modes.first_last_frame = {
      inputs: { firstFrame: { min: 1, max: 1, hosted: false }, lastFrame: { min: 1, max: 1, hosted: false } },
      requiredAnyOf: [['firstFrame', 'lastFrame']],
    }
  }
  const videos = video.maxReferenceVideos ?? 0
  const audios = video.maxReferenceAudios ?? 0
  if (images > 0 || videos > 0) {
    const inputs: Partial<Record<VideoInput, HostVideoInputLimit>> = {}
    const requiredAnyOf: VideoInput[][] = []
    if (images > 0) { inputs.referenceImages = { min: 0, max: images, hosted: false }; requiredAnyOf.push(['referenceImages']) }
    if (videos > 0) {
      inputs.referenceVideos = { min: 0, max: videos, hosted: video.gatewayRelayRequired === true }
      requiredAnyOf.push(['referenceVideos'])
    }
    // Audio is never a reference on its own: it rides an image or a video.
    if (audios > 0) inputs.referenceAudios = { min: 0, max: audios, hosted: false }
    modes.omni_reference = { inputs, requiredAnyOf }
  }
  return modes
}

/**
 * A video model's capabilities in the canvas's vocabulary. The modes and their
 * constraints are always given in mode schema 1, from {@link effectiveVideoModes}.
 * @param video - the capabilities dsh-media read.
 * @returns the canvas's `videoCapabilities`.
 */
export function videoCapabilities(video: HostVideoCapabilities): Json {
  const caps: Json = {}
  const constraints: Json = {}
  const modes: CanvasVideoMode[] = []
  for (const [wire, constraint] of Object.entries(effectiveVideoModes(video)) as [GatewayVideoMode, HostVideoModeConstraint | undefined][]) {
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
  if (video.ratios !== undefined) caps.supportedAspects = [...video.ratios]
  if (video.resolutions !== undefined) caps.supportedResolutions = [...video.resolutions]
  if (video.durations !== undefined) caps.supportedDurationsSeconds = [...video.durations]
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
  const video = model.kind === 'video' && model.video !== undefined ? videoCapabilities(model.video) : undefined
  const unavailable = video !== undefined && (video.videoModes as CanvasVideoMode[]).length === 0
  return {
    id: model.id,
    label: model.name || model.id,
    ...model.description === undefined ? {} : { hint: model.description },
    provider: GATEWAY_PROVIDER,
    available: !unavailable,
    ...unavailable ? { unavailableReason: UNREADABLE_VIDEO_MODES_REASON } : {},
    ...video === undefined ? {} : { videoCapabilities: video },
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
