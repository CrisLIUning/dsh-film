import { sequenceContent, SequenceError, SequenceStore } from '../canvas/sequences.js'
import { readProject } from '../project.js'
import { StudioReply } from './router.js'
import type { StudioRouter, StudioRequest } from './router.js'

export function addSequenceRoutes(router: StudioRouter): void {
  router.translate(error => error instanceof SequenceError ? new Response(JSON.stringify({ error: error.message, code: error.code }), { status: error.status, headers: { 'content-type': 'application/json' } }) : undefined)
  const store = async (request: StudioRequest) => {
    const project = await readProject(request.cwd)
    if (!project || request.params.boardId !== project.id) throw new StudioReply(404, { error: 'This edit plan belongs to another film.', code: 'SEQUENCE_WRONG_FILM' })
    return new SequenceStore(request.cwd, project.id)
  }
  const route = '/api/canvas/video/:boardId/sequences'
  router.add('GET', route, async request => ({ drafts: await (await store(request)).list() }))
  router.add('GET', `${route}/:id`, async request => (await store(request)).get(request.params.id!))
  router.add('POST', `${route}/verify`, async request => ({ sources: await (await store(request)).verify(sequenceContent((await request.json()).draft)) }))
  router.add('PUT', route, async request => {
    const body = await request.json()
    return { draft: await (await store(request)).save(body.draft, body.expectedRevision, body.operationId) }
  })
  router.add('DELETE', `${route}/:id`, async request => {
    const body = await request.json()
    await (await store(request)).remove(request.params.id!, body.expectedRevision)
    return { removed: true }
  })
}
