/**
 * The editing desk's AI models over Studio's model endpoints:
 *
 * - `GET  /api/media/video-editor-models` — the models it may download.
 * - `GET  /api/media/video-editor-models/:id/consent` — whether the person agreed.
 * - `POST /api/media/video-editor-models/:id/consent` — `{ granted, group? }`
 *   records the answer, for the model's whole group with `group: true`.
 * - `POST /api/media/video-editor-models/:id/prepare` — 202 with a task; 409
 *   `VIDEO_EDITOR_MODEL_CONSENT_REQUIRED` before the person agreed.
 * - `GET  /api/media/video-editor-model-tasks/:id`, `POST .../:id/cancel`.
 * - `GET  /api/media/video-editor-models/:id/artifacts/:artifactId` — a file.
 *
 * Model files are also served at their own Host routes,
 * `/api/dsh-film/models/<model>/<revision>/<file id>`, which is what the
 * editor is given: some models name their other files relative to one of
 * them (TensorFlow.js weight shards beside `model.json`), and the editor's
 * workers fetch directly, without the page's address translation.
 * Errors answer `{ error: <text>, code }` like Studio's model routes.
 * @module dsh-film/studio/model-routes
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { appFileType } from '../apps.js'
import { serveFile } from '../files.js'
import { EditorModelError } from '../models/service.js'
import type { EditorModels } from '../models/service.js'
import { StudioReply } from './router.js'
import type { StudioRouter } from './router.js'

/** Where model files are served. */
export const MODELS_PREFIX = '/api/dsh-film/models'

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
})

/** A model file at a versioned address never changes. */
const FILE_HEADERS = { 'Cache-Control': 'private, max-age=31536000, immutable' }

/**
 * Add the model routes to a router.
 * @param router - the Studio-compatible router.
 * @param models - the model store.
 */
export function addModelRoutes(router: StudioRouter, models: EditorModels): void {
  router.translate(error => error instanceof EditorModelError ? json(error.status, { error: error.message, code: error.code }) : undefined)

  router.add('GET', '/api/media/video-editor-models', async () => ({ models: models.list() }))

  router.add('GET', '/api/media/video-editor-models/:id/consent', async request => models.consent(request.params.id!))

  router.add('POST', '/api/media/video-editor-models/:id/consent', async (request) => {
    const body = await request.json()
    if (typeof body.granted !== 'boolean') throw new StudioReply(400, { error: 'granted must be true or false', code: 'VIDEO_EDITOR_MODEL_CONSENT_INVALID' })
    return models.setConsent(request.params.id!, body.granted, body.group === true)
  })

  router.add('POST', '/api/media/video-editor-models/:id/prepare', async request => json(202, await models.startPrepare(request.params.id!)))

  router.add('GET', '/api/media/video-editor-model-tasks/:id', async request => models.task(request.params.id!))

  router.add('POST', '/api/media/video-editor-model-tasks/:id/cancel', async (request) => {
    models.cancel(request.params.id!)
    return { ok: true }
  })

  router.add('GET', '/api/media/video-editor-models/:id/artifacts/:artifactId', async (request) => {
    const file = await models.artifactFile(request.params.id!, request.params.artifactId!)
    return serveFile(request.raw, { path: file.path, size: file.size, modified: file.modified, type: appFileType(file.fileName), headers: FILE_HEADERS })
  })
}

/**
 * The address of a model file.
 * @param modelId - the model.
 * @param revision - its revision.
 * @param artifactId - the file's id.
 */
export const modelFileRoute = (modelId: string, revision: string, artifactId: string): string => `${MODELS_PREFIX}/${modelId}/${revision}/${artifactId}`

/**
 * One GET/HEAD route per model file, answering 404 until the file is present
 * and verified.
 * @param models - the model store.
 * @returns the routes.
 */
export function modelFileRoutes(models: EditorModels): ConnectionFetchRoute[] {
  return models.list().flatMap(model => model.artifacts.map((artifact): ConnectionFetchRoute => ({
    path: modelFileRoute(model.id, model.revision, artifact.id),
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      try {
        const file = await models.artifactFile(model.id, artifact.id)
        return serveFile(request, { path: file.path, size: file.size, modified: file.modified, type: appFileType(file.fileName), headers: FILE_HEADERS })
      } catch (error) {
        const status = error instanceof EditorModelError ? (error.status === 409 ? 404 : error.status) : 500
        if (request.method === 'HEAD') return new Response(null, { status })
        return json(status, { error: error instanceof Error ? error.message : String(error), code: error instanceof EditorModelError ? error.code : 'INTERNAL' })
      }
    },
  })))
}
