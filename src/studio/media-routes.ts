/**
 * Studio's media endpoints the storyboard canvas uses, over dsh-media:
 * the model catalogue, starting a generation, and long-polling its task.
 * @module dsh-film/studio/media-routes
 */

import { canvasCatalogue, GATEWAY_PROVIDER } from '../media/catalogue.js'
import { FilmMediaError } from '../media/tasks.js'
import type { FilmMediaTasks, MediaServiceLike } from '../media/tasks.js'
import { projectOf } from './canvas-routes.js'
import { StudioReply } from './router.js'
import type { StudioRouter } from './router.js'

const mediaError = (error: unknown): never => {
  if (error instanceof FilmMediaError) throw new StudioReply(error.status, { error: { code: error.code, message: error.message, status: error.status } })
  throw error
}

/**
 * Add the media routes to a router.
 * @param router - the Studio-compatible router.
 * @param tasks - the canvas's media tasks.
 * @param media - dsh-media's service, when it is running.
 */
export function addMediaRoutes(router: StudioRouter, tasks: FilmMediaTasks, media: () => MediaServiceLike | undefined): void {
  router.add('GET', '/api/media/models', async (request) => {
    const service = media()
    if (service === undefined) {
      return { ...canvasCatalogue([]), providers: [{ id: GATEWAY_PROVIDER, label: 'VibeDev', integrated: false, configured: false, hint: '生成需要 dsh-media 插件（VibeDev 媒体生成）。' }] }
    }
    try {
      return canvasCatalogue(await service.models(request.raw.signal))
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code
      const hint = code === 'NOT_SIGNED_IN' ? '请先登录 VibeDev 账号（插件页的 dsh-media 设置）。' : `暂时读不到模型目录：${error instanceof Error ? error.message : String(error)}`
      return { ...canvasCatalogue([]), providers: [{ id: GATEWAY_PROVIDER, label: 'VibeDev', integrated: true, configured: false, hint }] }
    }
  })

  router.add('POST', '/api/projects/:projectId/media/generate', async (request) => {
    try {
      const started = await tasks.generate(request.cwd, projectOf(request), await request.json())
      return new Response(JSON.stringify(started), { status: 202, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
    } catch (error) {
      return mediaError(error)
    }
  })

  router.add('POST', '/api/media/tasks/:taskId/wait', async (request) => {
    const body = await request.json()
    try {
      return await tasks.wait(
        request.cwd,
        request.params.taskId!,
        typeof body.since === 'number' ? body.since : 0,
        typeof body.timeoutMs === 'number' ? body.timeoutMs : 15_000,
        request.raw.signal,
      )
    } catch (error) {
      return mediaError(error)
    }
  })

  router.add('POST', '/api/media/tasks/:taskId/cancel', async (request) => {
    try {
      await tasks.cancel(request.cwd, request.params.taskId!)
      return { ok: true }
    } catch (error) {
      return mediaError(error)
    }
  })
}
