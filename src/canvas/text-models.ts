/**
 * The canvas's text models under DeepSeek Harness: text-node answers and the
 * prompt writer, answered by the model the person uses in DSH (Studio's
 * `canvas-chat.ts`, `canvas-assist.ts` and `services/canvas-models.ts`).
 *
 * Studio signs requests to the VibeDev gateway itself. Under DSH the Host's
 * `llm` service owns every provider route and credential — in VibeDev Next its
 * default route is the VibeDev gateway (`deepseek-account`) — so the plugin
 * asks that service, with the person's default model unless the canvas names
 * one. Images travel through the Host's `attachments` store, as session
 * messages do. One call per question, no session.
 * @module dsh-film/canvas/text-models
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** The Host's `llm` service, as far as this module uses it (dsh-llm `LlmRuntime`). */
export interface LlmLike {
  listProviders(): readonly { id: string; name: string }[]
  listModels(provider: string): Promise<readonly { id: string; name: string; inputModalities?: readonly string[] }[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[]; reasoning?: { efforts: readonly { id: string }[] } }>
  stream(options: Record<string, unknown>): AsyncIterable<LlmChunk>
}

/** One streaming chunk (dsh-llm `StreamChunk`); only text deltas and the finish matter here. */
export type LlmChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'finish'; reason: { kind: 'stop' | 'max-tokens' | 'tool-calls' } | { kind: 'error' | 'aborted'; failure: { code: string; message: string } } }
  | { type: string; [key: string]: unknown }

/** The Host's `agentDefaultModel` service: the model the person uses. */
export interface DefaultModelLike {
  currentSelection(): { provider: string; model: string }
}

/** The Host's `attachments` store: where an image becomes something a request can carry. */
export interface AttachmentsLike {
  saveImage(input: { data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; name?: string }): Promise<unknown>
}

export interface TextServices {
  llm?: LlmLike
  defaults?: DefaultModelLike
  attachments?: AttachmentsLike
}

/** A text model as the canvas lists it (Studio's `CanvasTextModel`). */
export interface CanvasTextModel {
  id: string
  modelId: string
  label: string
  providerId: string
  providerName: string
  source: 'gateway' | 'byok'
  capability: 'text'
  protocol: string
  available: boolean
}

export interface ModelSelection {
  provider: string
  model: string
}

/** The VibeDev gateway's provider route in DSH. */
export const GATEWAY_PROVIDER = 'deepseek-account'

export const sourceOf = (provider: string): 'gateway' | 'byok' => provider === GATEWAY_PROVIDER ? 'gateway' : 'byok'

/** A refusal with the status the canvas reads (401: sign in; 402: balance). */
export class TextModelError extends Error {
  override name = 'TextModelError'

  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

const FAILURES: Readonly<Record<string, { status: number; message: string }>> = {
  ACCOUNT_SIGN_IN_REQUIRED: { status: 401, message: '请先登录 VibeDev 账号，再让画布里的文字节点回答。' },
  ACCOUNT_TOKEN_INVALID: { status: 401, message: 'VibeDev 登录已失效，请重新登录。' },
  ACCOUNT_QUOTA_EXCEEDED: { status: 402, message: 'VibeDev 账号余额不足，请充值后重试。' },
}

/**
 * A finish failure as the canvas should read it.
 * @param failure - the Host's failure.
 * @returns the error.
 */
export function failureError(failure: { code: string; message: string }): TextModelError {
  const known = FAILURES[failure.code]
  return known !== undefined
    ? new TextModelError(known.status, failure.code, known.message)
    : new TextModelError(502, failure.code, `模型没有完成回答：${failure.message}`)
}

/** One content part of a request message (dsh-llm `UserMessage['content']`). */
type Part = { type: 'text'; text: string } | { type: 'image'; attachment: unknown }

/** An image for the model: the bytes and their type. */
export interface ImageBytes {
  data: Uint8Array
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

const IMAGE_TYPES: Readonly<Record<string, ImageBytes['mediaType']>> = {
  'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/webp': 'image/webp', 'image/gif': 'image/gif',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
}

/**
 * The bytes of an image the canvas sent: a data URL, or a project file by
 * Studio's raw URL (read from the workspace's film folder).
 * @param url - the image URL.
 * @param projectFile - resolves a film-relative path to an absolute one, or `undefined`.
 * @returns the image, or `undefined` when it cannot be read here.
 */
export async function imageBytes(url: string, projectFile: (path: string) => string | undefined): Promise<ImageBytes | undefined> {
  const data = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url)
  if (data !== null) {
    const mediaType = IMAGE_TYPES[data[1]!.toLowerCase()]
    return mediaType === undefined ? undefined : { data: new Uint8Array(Buffer.from(data[2]!, 'base64')), mediaType }
  }
  const raw = /^(?:https?:\/\/[^/]+)?\/api\/projects\/[^/]+\/raw\/([^?#]+)/.exec(url)
  if (raw === null) return undefined
  let path: string
  try {
    path = raw[1]!.split('/').map(part => decodeURIComponent(part)).join('/')
  } catch {
    return undefined
  }
  const mediaType = IMAGE_TYPES[extname(path).toLowerCase()]
  const absolute = projectFile(path)
  if (mediaType === undefined || absolute === undefined) return undefined
  try {
    return { data: new Uint8Array(await readFile(absolute)), mediaType }
  } catch {
    return undefined
  }
}

/** A canvas chat message (the canvas's `AiTextMessage`, OpenAI-shaped). */
export interface CanvasChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
}

/**
 * Read the canvas's chat messages.
 * @param value - the request's `messages`.
 * @returns the messages.
 */
export function parseChatMessages(value: unknown): CanvasChatMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new TextModelError(400, 'CANVAS_CHAT_MESSAGES_INVALID', 'messages must be a list of 1–64 chat messages')
  return value.map((raw): CanvasChatMessage => {
    const message = raw as { role?: unknown; content?: unknown }
    if (message?.role !== 'system' && message?.role !== 'user' && message?.role !== 'assistant') throw new TextModelError(400, 'CANVAS_CHAT_MESSAGES_INVALID', 'each message needs a role of system, user or assistant')
    if (typeof message.content === 'string') return { role: message.role, content: message.content }
    if (!Array.isArray(message.content)) throw new TextModelError(400, 'CANVAS_CHAT_MESSAGES_INVALID', 'message content must be text or a list of parts')
    const parts = message.content.flatMap((part: unknown): Exclude<CanvasChatMessage['content'], string> => {
      const item = part as { type?: unknown; text?: unknown; image_url?: { url?: unknown } }
      if (item?.type === 'text' && typeof item.text === 'string') return [{ type: 'text' as const, text: item.text }]
      if (item?.type === 'image_url' && typeof item.image_url?.url === 'string') return [{ type: 'image_url' as const, image_url: { url: item.image_url.url } }]
      return []
    })
    return { role: message.role, content: parts }
  })
}

const textOf = (content: CanvasChatMessage['content']): string =>
  typeof content === 'string' ? content : content.flatMap(part => part.type === 'text' ? [part.text] : ['[图片]']).join('\n')

export class CanvasTextModels {
  constructor(private readonly services: () => TextServices) {}

  /** The model a request uses: the one it names, else the person's default. */
  select(provider?: string, model?: string): ModelSelection {
    const { llm, defaults } = this.services()
    if (llm === undefined || defaults === undefined) throw new TextModelError(503, 'CANVAS_TEXT_UNAVAILABLE', '这里没有可用的文本模型。')
    if (provider !== undefined && provider !== '' && model !== undefined && model !== '') return { provider, model }
    const selection = defaults.currentSelection()
    if (model !== undefined && model !== '') return { provider: selection.provider, model }
    return { provider: selection.provider, model: selection.model }
  }

  /** Whether the canvas can ask at all, and which model would answer. */
  support(): { available: boolean; model?: string } {
    try {
      const { model } = this.select()
      return { available: true, model }
    } catch {
      return { available: false }
    }
  }

  /** Every model of every provider route, as the canvas lists text models. */
  async list(): Promise<{ models: CanvasTextModel[]; complete: boolean; warnings: { source: 'gateway' | 'byok'; providerId: string; message: string }[] }> {
    const { llm } = this.services()
    if (llm === undefined) return { models: [], complete: true, warnings: [] }
    const models: CanvasTextModel[] = []
    const warnings: { source: 'gateway' | 'byok'; providerId: string; message: string }[] = []
    await Promise.all(llm.listProviders().map(async (provider) => {
      try {
        for (const model of await llm.listModels(provider.id)) {
          models.push({
            id: `${provider.id}/${model.id}`,
            modelId: model.id,
            label: model.name || model.id,
            providerId: provider.id,
            providerName: provider.name || provider.id,
            source: sourceOf(provider.id),
            capability: 'text',
            protocol: 'dsh',
            available: true,
          })
        }
      } catch (error) {
        warnings.push({ source: sourceOf(provider.id), providerId: provider.id, message: error instanceof Error ? error.message : String(error) })
      }
    }))
    models.sort((left, right) => left.providerName.localeCompare(right.providerName) || left.label.localeCompare(right.label))
    return { models, complete: warnings.length === 0, warnings }
  }

  /** Turn image URLs into attachments the model takes, or a note when it takes none. */
  private async content(selection: ModelSelection, parts: ReadonlyArray<{ type: 'text'; text: string } | { type: 'image'; image: ImageBytes | undefined }>, signal: AbortSignal): Promise<Part[]> {
    const { llm, attachments } = this.services()
    const wantsImages = parts.some(part => part.type === 'image')
    const seesImages = wantsImages && attachments !== undefined && llm !== undefined
      && (await llm.resolveModelInfo(selection.provider, selection.model, signal).catch(() => ({ inputModalities: undefined }))).inputModalities?.includes('image') === true
    const content: Part[] = []
    for (const part of parts) {
      if (part.type === 'text') {
        content.push(part)
      } else if (seesImages && part.image !== undefined) {
        content.push({ type: 'image', attachment: await attachments!.saveImage({ ...part.image, name: 'canvas-reference' }) })
      } else {
        content.push({ type: 'text', text: seesImages ? '[一张图片，这里读不到]' : '[一张图片；当前模型不看图片]' })
      }
    }
    return content
  }

  /**
   * Stream an answer: text deltas, ending when the model finishes. A failure
   * before the first word throws a {@link TextModelError}; one after it ends
   * the stream with that error.
   */
  async *stream(input: { selection: ModelSelection; system?: string; content: Part[]; maxTokens?: number; quick?: boolean; signal: AbortSignal }): AsyncGenerator<string> {
    const { llm } = this.services()
    if (llm === undefined) throw new TextModelError(503, 'CANVAS_TEXT_UNAVAILABLE', '这里没有可用的文本模型。')
    let reasoningEffort: string | undefined
    if (input.quick === true) {
      // A prompt is wanted in seconds; reasoning only when the model cannot switch it off.
      const info = await llm.resolveModelInfo(input.selection.provider, input.selection.model, input.signal).catch(() => undefined)
      if (info?.reasoning?.efforts.some(effort => effort.id === 'off') === true) reasoningEffort = 'off'
    }
    const options: Record<string, unknown> = {
      provider: input.selection.provider,
      model: input.selection.model,
      messages: [{ role: 'user', content: input.content }],
      ...(input.system !== undefined && input.system !== '' ? { system: input.system } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      signal: input.signal,
    }
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        yield chunk.text
      } else if (chunk.type === 'finish') {
        const reason = (chunk as Extract<LlmChunk, { type: 'finish' }>).reason
        if (reason.kind === 'error' || reason.kind === 'aborted') throw failureError(reason.failure)
        return
      }
    }
  }

  /**
   * A text node's chat as one request: system messages as the system prompt,
   * earlier turns folded into the user turn, the last turn's images attached.
   */
  async chatRequest(messages: CanvasChatMessage[], selection: ModelSelection, signal: AbortSignal, projectFile: (path: string) => string | undefined): Promise<{ system: string; content: Part[] }> {
    const system = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n\n')
    const turns = messages.filter(message => message.role !== 'system')
    const last = turns.at(-1)
    const earlier = turns.slice(0, -1)
    const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: ImageBytes | undefined }> = []
    if (earlier.length > 0) {
      parts.push({ type: 'text', text: `先前的对话：\n${earlier.map(turn => `${turn.role === 'user' ? '用户' : '助手'}：${textOf(turn.content)}`).join('\n')}\n\n现在：` })
    }
    if (last !== undefined) {
      if (typeof last.content === 'string') parts.push({ type: 'text', text: last.content })
      else {
        for (const part of last.content) {
          if (part.type === 'text') parts.push(part)
          else parts.push({ type: 'image', image: await imageBytes(part.image_url.url, projectFile) })
        }
      }
    }
    return { system, content: await this.content(selection, parts, signal) }
  }

  /** The prompt writer's request content, images attached when the model sees them. */
  async promptContent(selection: ModelSelection, parts: ReadonlyArray<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }>, signal: AbortSignal): Promise<Part[]> {
    const resolved = await Promise.all(parts.map(async part => part.type === 'text' ? part : { type: 'image' as const, image: await imageBytes(part.dataUrl, () => undefined) }))
    return this.content(selection, resolved, signal)
  }
}
