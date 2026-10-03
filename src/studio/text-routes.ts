/**
 * Studio's canvas text endpoints over DSH's model service:
 *
 * - `GET /api/canvas/models` — the text models a text node can pick.
 * - `GET /api/canvas/assist` — whether the canvas can ask, and which model answers.
 * - `POST /api/canvas/chat` — a text node's answer, streamed as OpenAI-style
 *   SSE (`data: {"choices":[{"delta":{"content":…}}]}`), which the canvas reads.
 * - `POST /api/canvas/assist/prompt` — a prompt written for a node from what is
 *   wired into it.
 *
 * Errors answer `{ error: <text>, code }` like Studio's canvas routes; 401 means
 * sign in, which the canvas shows as such.
 * @module dsh-film/studio/text-routes
 */

import { AssistRequestError, assistSystemPrompt, assistUserParts, parseAssistRequest } from '../canvas/assist-prompt.js'
import { CanvasTextModels, TextModelError, parseChatMessages, sourceOf } from '../canvas/text-models.js'
import { projectPath } from './project-routes.js'
import { StudioReply } from './router.js'
import type { StudioRequest, StudioRouter } from './router.js'

/** How long a prompt may take to write before the request gives up. */
const PROMPT_TIMEOUT_MS = 60_000

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** A signal that ends with the request (and, optionally, after a time). */
function requestSignal(request: StudioRequest, timeoutMs?: number): AbortSignal {
  const signals = [request.raw.signal, ...(timeoutMs !== undefined ? [AbortSignal.timeout(timeoutMs)] : [])]
  return AbortSignal.any(signals)
}

/** A film-relative path as an absolute one, or `undefined` when it leaves the project. */
const projectFileOf = (request: StudioRequest) => (path: string): string | undefined => {
  try {
    return projectPath(request.cwd, path)
  } catch {
    return undefined
  }
}

/**
 * Add the canvas text routes to a router.
 * @param router - the Studio-compatible router.
 * @param models - the text model bridge.
 * @param nativeAudioOf - whether a video model declares native audio, when known.
 */
export function addTextRoutes(router: StudioRouter, models: CanvasTextModels, nativeAudioOf: (model: string) => Promise<boolean | undefined> = async () => undefined): void {
  router.translate((error) => {
    if (error instanceof TextModelError) return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: error.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
    if (error instanceof AssistRequestError) return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
    return undefined
  })

  router.add('GET', '/api/canvas/models', async () => models.list())

  router.add('GET', '/api/canvas/assist', async () => models.support())

  router.add('POST', '/api/canvas/chat', async (request) => {
    const body = await request.json()
    if (body.source !== undefined && body.source !== 'gateway' && body.source !== 'byok') throw new StudioReply(400, { error: 'unknown model source', code: 'CANVAS_CHAT_SOURCE_INVALID' })
    const messages = parseChatMessages(body.messages)
    const selection = models.select(text(body.providerId), text(body.model))
    const controller = new AbortController()
    const signal = AbortSignal.any([requestSignal(request), controller.signal])
    const { system, content } = await models.chatRequest(messages, selection, signal, projectFileOf(request))
    const answer = models.stream({ selection, system, content, signal })
    // The first piece decides between an error answer and a stream: a refusal
    // (not signed in, no balance) arrives before any word.
    const first = await answer.next()
    const encoder = new TextEncoder()
    const frame = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (piece: string) => frame({ choices: [{ delta: { content: piece } }] })
    const stream = new ReadableStream<Uint8Array>({
      start(sink) {
        if (first.done === true) {
          sink.enqueue(encoder.encode('data: [DONE]\n\n'))
          sink.close()
        } else {
          sink.enqueue(delta(first.value))
        }
      },
      async pull(sink) {
        try {
          const next = await answer.next()
          if (next.done === true) {
            sink.enqueue(encoder.encode('data: [DONE]\n\n'))
            sink.close()
          } else {
            sink.enqueue(delta(next.value))
          }
        } catch (error) {
          const failure = error instanceof TextModelError ? { code: error.code, message: error.message } : { code: 'CANVAS_CHAT_STREAM_FAILED', message: '文本生成中断了，请重试' }
          sink.enqueue(frame({ error: failure }))
          sink.close()
        }
      },
      cancel() {
        controller.abort()
        void answer.return(undefined)
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        // Named before the first word, so the answer can be attributed even if it breaks off.
        'X-Canvas-Chat-Model': selection.model,
        'X-Canvas-Chat-Source': sourceOf(selection.provider),
        'X-Canvas-Chat-Provider': selection.provider,
      },
    })
  })

  router.add('POST', '/api/canvas/assist/prompt', async (request) => {
    const body = await request.json()
    const assist = parseAssistRequest(body)
    const writer = record(body.writer)
    const selection = models.select(text(writer?.providerId), text(writer?.model))
    const signal = requestSignal(request, PROMPT_TIMEOUT_MS)
    const nativeAudio = assist.surface === 'video' && assist.model !== undefined ? await nativeAudioOf(assist.model).catch(() => undefined) : undefined
    const { parts, usedImages } = assistUserParts(assist)
    const content = await models.promptContent(selection, parts.map(part => part.type === 'image' ? { type: 'image' as const, dataUrl: part.dataUrl } : part), signal)
    let prompt = ''
    for await (const piece of models.stream({ selection, system: assistSystemPrompt(assist, nativeAudio), content, quick: true, maxTokens: 2048, signal })) prompt += piece
    prompt = prompt.trim()
    // An empty string pasted into the node would read as "nothing to say", a different and wrong story.
    if (prompt === '') throw new TextModelError(502, 'CANVAS_ASSIST_EMPTY', `${selection.model} 没有写出提示词，请重试。`)
    const warnings = assist.video?.generateAudio === true && nativeAudio === false ? ['当前模型未声明原生音频输出；已按画面整理，所需对白仍需另行制作。'] : []
    return {
      prompt,
      model: selection.model,
      source: sourceOf(selection.provider),
      providerId: selection.provider,
      usedReferences: usedImages,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  })
}
