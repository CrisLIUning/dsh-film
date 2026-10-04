/**
 * Studio's director endpoints (apps/daemon/src/routes/director.ts,
 * director-motion.ts, modeling-brief.ts) over the film's board: asking a
 * director-desk scene questions, reading and writing it, staging it from a
 * plan, rendering and inspecting through the open desk, versioned reviews,
 * compiled motion and modeling briefs. The canvas's review panel and the
 * desk's 建模 button call these as they call Studio, and the agent's
 * director tools call them in-process. The stage route also takes the agent's
 * place_model ops (src/director/model-placement.ts), which it expands into the
 * desk's own import, calibrate, place and transform ops. Errors answer in Studio's director
 * shape, `{ error: <text>, code, ...details }`.
 *
 * Not offered: headless background rendering (`/api/projects/:id/director/renders`),
 * which in Studio runs the desk in an embedded Chromium no DSH plugin has.
 * Without it every render, model inspection and review version needs the
 * desk open in the 导演 tab, exactly as Studio's foreground path does.
 * @module dsh-film/studio/director-routes
 */

import { join } from 'node:path'
import { BoardAgentError } from '../canvas/board-agent.js'
import type { CanvasBoardAgent } from '../canvas/board-agent.js'
import { CanvasDocumentStore, CanvasDocumentUpdateError } from '../canvas/documents.js'
import { FilmError } from '../errors.js'
import { FILM_DIR } from '../project.js'
import { MotionCompileError, compileMotionIntoFilm } from '../director/authored-motion.js'
import { verifyDirectorAssetSource } from '../director/asset-source.js'
import { expandModelPlacements, isPlaceModel, prepareModelPlacements, withAgentOps } from '../director/model-placement.js'
import type { PlacedModel } from '../director/model-placement.js'
import type {
  DirectorInspectModelResponse, DirectorRenderResponse, DirectorRenderStatusResponse, DirectorReviewRequest, DirectorReviewSource,
  DirectorSceneResponse, DirectorSceneWriteResponse, DirectorStageResponse,
} from '../director/contracts/index.js'
import { DirectorDesks } from '../director/live.js'
import type { DeskAddress } from '../director/live.js'
import { DirectorRefusal, locateDirectorScene, projectFileOfUrl } from '../director/locate.js'
import type { LocatedScene } from '../director/locate.js'
import { DirectorQueryError, directorDiagnostics, parseDirectorQuery, resolveDirectorProject, runDirectorQuery } from '../director/query.js'
import {
  DIRECTOR_RENDER_STATUS_TIMEOUT_MS, DIRECTOR_RENDER_TIMEOUT_MS, DIRECTOR_RENDER_TOOL, DIRECTOR_RENDER_WITH_VIDEO_TIMEOUT_MS,
  renderAskOf, renderedFilesOf, renderTaskOf,
} from '../director/render.js'
import type { RenderAsk } from '../director/render.js'
import { DIRECTOR_STAGE_REVIEW_TOOL, createReviewHandoff } from '../director/review-handoff.js'
import { DirectorReviewError, createDirectorReviewService } from '../director/reviews.js'
import { DirectorStageError, parseDirectorStagePlan, stageDirectorScene } from '../director/staging.js'
import { canCalibrateModel } from '../director/vendor/director-math/schema/modelCalibration.js'
import { appendSpatialCandidates, spatialStructureCandidates, validateModelStructure } from '../director/vendor/director-math/schema/modelStructure.js'
import { getDirectorProjectFingerprint } from '../director/vendor/director-math/schema/projectFingerprint.js'
import { createEmptyDirectorProject } from '../director/vendor/director-math/schema/sceneDefaults.js'
import type { DirectorProject } from '../director/vendor/director-math/schema/directorProject.js'
import { upgradeDirectorProject } from '../director/vendor/director-math/schema/directorProjectMigration.js'
import type { ProjectEvents } from './events.js'
import { StudioApiError, StudioReply } from './router.js'
import type { StudioRequest, StudioRouter } from './router.js'
import { filmBoardOf } from './screenwriter-routes.js'

export interface DirectorRouteDeps {
  /** Board changes written here are announced on it. */
  events: ProjectEvents
  /** The open canvas pages (the same instance the canvas routes register pages with). */
  boardAgent: CanvasBoardAgent
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Answer a director failure in Studio's director shape.
 * @param error - what a handler threw.
 * @returns never; throws the reply.
 */
function reply(error: unknown): never {
  if (error instanceof StudioReply || error instanceof StudioApiError) throw error
  if (error instanceof DirectorRefusal || error instanceof DirectorReviewError) {
    throw new StudioReply(error.status, { ...error.details, error: error.message, code: error.code })
  }
  if (error instanceof DirectorStageError) throw new StudioReply(400, { error: error.message, code: error.code, ...(error.op != null ? { op: error.op } : {}) })
  if (error instanceof DirectorQueryError) throw new StudioReply(400, { error: error.message, code: error.code })
  if (error instanceof BoardAgentError || error instanceof MotionCompileError) throw new StudioReply(error.status, { error: error.message, code: error.code })
  if (error instanceof CanvasDocumentUpdateError) throw new StudioReply(409, { error: error.message, code: error.code })
  // A damaged or unsupported film.json is the film's problem, answered as the other routes answer it.
  if (error instanceof FilmError) throw new StudioReply(error.status, { error: error.message, code: error.code })
  throw new StudioReply(500, { error: error instanceof Error ? error.message : String(error), code: 'DIRECTOR_FAILED' })
}

/**
 * Add the director routes to a router.
 * @param router - the Studio-compatible router.
 * @param deps - the event bus and the open pages.
 */
export function addDirectorRoutes(router: StudioRouter, deps: DirectorRouteDeps): void {
  const desks = new DirectorDesks(deps.boardAgent)
  const handle = (method: 'GET' | 'POST' | 'PUT', path: string, run: (request: StudioRequest, film: Film) => Promise<unknown>) => {
    router.add(method, path, async (request) => {
      try {
        const projectId = await filmBoardOf(request)
        return await run(request, {
          projectId,
          root: join(request.cwd, FILM_DIR),
          documents: new CanvasDocumentStore(request.cwd, projectId),
          announce: (boardId: string) => { deps.events.emit(request.cwd, { type: 'story-canvas-changed', projectId, boardId }) },
        })
      } catch (error) {
        return reply(error)
      }
    })
  }

  const addressOf = (film: Film, located: LocatedScene): DeskAddress | null =>
    located.boardId && located.nodeId ? { boardId: located.boardId, nodeId: located.nodeId, project: film.projectId } : null

  const requireBoard = async (film: Film, source: unknown): Promise<{ located: LocatedScene; address: DeskAddress }> => {
    if (!isRecord(source) || 'directorProject' in source) throw new DirectorReviewError(400, 'DIRECTOR_REVIEW_NEEDS_BOARD', '审阅需要指定画布和导演台节点')
    const located = await locateDirectorScene(film.documents, source)
    return { located, address: addressOf(film, located)! }
  }

  const renderFromBoard = async (film: Film, source: unknown, ask: RenderAsk): Promise<DirectorRenderResponse> => {
    const { located, address } = await requireBoard(film, source)
    const answer = await desks.callDesk(address, DIRECTOR_RENDER_TOOL, { request: ask }, ask.video ? DIRECTOR_RENDER_WITH_VIDEO_TIMEOUT_MS : DIRECTOR_RENDER_TIMEOUT_MS)
    if (answer === undefined) throw new DirectorReviewError(409, 'CANVAS_BOARD_NOT_OPEN', '没有打开的画布页面:渲染要导演台开着,在画布里打开这个导演台节点')
    if (answer.deskOpen !== true) throw new DirectorReviewError(409, 'DIRECTOR_DESK_NOT_OPEN', `导演台没开着:在画布里打开导演台节点 ${located.nodeId},渲染需要它`, { nodeId: located.nodeId })
    const { files, project } = renderedFilesOf(answer.files)
    if (typeof ask.video === 'object' && ask.video.sequence && !files.some(file => file.kind === 'video' && file.sequence)) {
      throw new DirectorReviewError(502, 'DIRECTOR_SEQUENCE_RENDER_MISSING', '页面未返回编排视频，请更新画布及导演台资源')
    }
    return { source: located.echo, project: project ?? film.projectId, desk: 'open', files }
  }

  handle('POST', '/api/director/review', async (request, film) => {
    const reviews = createDirectorReviewService({
      projectRoot: film.root,
      readScene: async (source: DirectorReviewSource) => {
        const { located, address } = await requireBoard(film, source)
        const current = await desks.currentScene(located, address)
        if (!current.project || !current.fingerprint) throw new DirectorReviewError(422, 'DIRECTOR_PROJECT_EMPTY', '导演台还没有工程')
        // Freeze the actual document, before migration changes its identity.
        const raw = current.live.desk !== 'none' ? current.live.scene : located.stored
        const stored = isRecord(raw) && isRecord(raw.project) ? raw.project : raw
        return { source: { boardId: address.boardId, nodeId: address.nodeId, project: film.projectId }, project: JSON.parse(JSON.stringify(stored)) as DirectorProject, fingerprint: current.fingerprint }
      },
      render: (source, ask) => renderFromBoard(film, source, ask),
      handoff: createReviewHandoff(async (scene, input) => {
        const { located, address } = await requireBoard(film, scene.source)
        return desks.callScenePage(located, address, DIRECTOR_STAGE_REVIEW_TOOL, input)
      }),
    })
    return reviews.execute(await request.json() as unknown as DirectorReviewRequest)
  })

  handle('POST', '/api/director/query', async (request, film) => {
    const body = await request.json()
    const query = parseDirectorQuery(body.query)
    const located = await locateDirectorScene(film.documents, body.source)
    const current = await desks.currentScene(located, addressOf(film, located), request.raw.signal)
    if (!current.project) {
      throw new DirectorRefusal(422, 'DIRECTOR_PROJECT_EMPTY', `导演台节点 ${located.nodeId} 还没有工程:在画布里打开它一次,或通过 stage 创建场景`, { nodeId: located.nodeId })
    }
    const answer = await runDirectorQuery(current.project, query, located.echo)
    // Queries sample an upgraded document; optimistic writes guard the actual saved/live bytes.
    // Return that same revision token, otherwise reading an older document cannot authorize a write.
    return 'fingerprint' in answer && current.fingerprint ? { ...answer, fingerprint: current.fingerprint } : answer
  })

  const sceneSource = (request: StudioRequest) => ({ boardId: request.params.boardId, nodeId: request.params.nodeId })

  handle('GET', '/api/director/scenes/:boardId/:nodeId', async (request, film) => {
    const located = await locateDirectorScene(film.documents, sceneSource(request))
    const current = await desks.currentScene(located, addressOf(film, located), request.raw.signal)
    if (!current.project) {
      throw new DirectorRefusal(422, 'DIRECTOR_PROJECT_EMPTY', `导演台节点 ${located.nodeId} 还没有工程:在画布里打开它一次,或用 stage 给它一份`, { nodeId: located.nodeId })
    }
    const answer: DirectorSceneResponse = {
      source: located.echo,
      version: current.project.version,
      fingerprint: current.fingerprint ?? getDirectorProjectFingerprint(current.project),
      desk: current.desk,
      project: current.project,
    }
    return answer
  })

  handle('PUT', '/api/director/scenes/:boardId/:nodeId', async (request, film) => {
    const body = await request.json()
    const project = resolveDirectorProject(body.project)
    if (!project) throw new DirectorRefusal(400, 'DIRECTOR_PROJECT_INVALID', 'project 不是导演台工程:需要 version、scene、objects、cameras')
    const located = await locateDirectorScene(film.documents, sceneSource(request))
    const address = addressOf(film, located)!
    const current = await desks.currentScene(located, address, request.raw.signal)
    if (typeof body.expectedFingerprint === 'string' && current.fingerprint && body.expectedFingerprint !== current.fingerprint) {
      throw new DirectorRefusal(409, 'DIRECTOR_SCENE_CONFLICT', '场景在你读它之后变了;重新读一次再写', { fingerprint: current.fingerprint, desk: current.desk })
    }
    const outcome = await desks.writeScene(film.documents, located, address, current.live, upgradeDirectorProject(project), () => film.announce(address.boardId))
    const answer: DirectorSceneWriteResponse = { source: located.echo, fingerprint: outcome.fingerprint, desk: outcome.desk }
    return answer
  })

  handle('POST', '/api/director/inspect-model', async (request, film) => {
    const body = await request.json()
    if (typeof body.objectId !== 'string' || !body.objectId.trim()) throw new DirectorRefusal(400, 'DIRECTOR_MODEL_OBJECT_REQUIRED', '提取结构需要 objectId')
    const located = await locateDirectorScene(film.documents, body.source)
    const address = addressOf(film, located)
    if (address === null || desks.pages(address).pages.length === 0) throw new DirectorRefusal(409, 'DIRECTOR_DESK_NOT_OPEN', '首次提取需要在画布打开导演台并加载模型')
    const current = await desks.currentScene(located, address, request.raw.signal)
    const object = current.project?.objects.find(item => item.id === body.objectId)
    const asset = current.project?.assets.find(item => item.id === object?.assetRefId)
    if (!object || !asset || !canCalibrateModel(asset) || !['scene', 'prop'].includes(object.kind)) {
      throw new DirectorRefusal(400, 'DIRECTOR_MODEL_INVALID', '请选择已放入场景的静态场景或道具模型')
    }
    // The structure comes from the desk that loaded the model: the page whose desk the read found open.
    const result = current.live.desk === 'open' && current.live.page !== undefined
      ? await deps.boardAgent.call(current.live.page, 'director_inspect_model', { ...address, assetId: asset.id })
      : undefined
    if (!isRecord(result) || result.deskOpen !== true || !isRecord(result.structure)) throw new DirectorRefusal(409, 'DIRECTOR_DESK_NOT_OPEN', '请在画布打开该导演台并加载模型')
    const raw = result.structure as { assetId?: unknown; fingerprint?: unknown; inspection?: { parts: unknown[]; sourceChecks?: DirectorInspectModelResponse['sourceChecks'] } }
    if (raw.assetId !== asset.id || raw.fingerprint !== current.fingerprint) throw new DirectorRefusal(409, 'DIRECTOR_SCENE_CONFLICT', '工程或模型在提取期间变化，请重新读取')
    try {
      validateModelStructure(raw.inspection)
    } catch (error) {
      throw new DirectorRefusal(502, 'DIRECTOR_MODEL_STRUCTURE_INVALID', (error as Error).message)
    }
    const inspection = raw.inspection!
    const candidates = spatialStructureCandidates(inspection, asset) as DirectorInspectModelResponse['candidates']
    const existing = new Set([...(object.spatial?.volumes ?? []), ...(object.spatial?.anchors ?? [])].map(item => item.id))
    const selected = candidates.filter(candidate => candidate.recommended && !existing.has(candidate.volume.id)).map(candidate => candidate.volume.id)
    const answer: DirectorInspectModelResponse = {
      source: located.echo,
      fingerprint: current.fingerprint!,
      objectId: object.id,
      assetId: asset.id,
      partCount: inspection.parts.length,
      ignoredSurfaceCount: inspection.parts.length - new Set(candidates.flatMap(candidate => candidate.sourcePartIds)).size,
      candidates,
      sourceChecks: inspection.sourceChecks ?? [],
      plan: { ops: selected.length ? [{ type: 'set_spatial_profile', objectId: object.id, profile: appendSpatialCandidates(object.spatial ?? null, candidates, selected) }] : [] },
    }
    return answer
  })

  for (const action of ['status', 'cancel'] as const) {
    handle('POST', `/api/director/render/${action}`, async (request, film) => {
      const body = await request.json()
      if (action === 'cancel' && (typeof body.jobId !== 'string' || !body.jobId.trim() || body.jobId.length > 128)) {
        throw new DirectorRefusal(400, 'DIRECTOR_RENDER_JOB_REQUIRED', '取消输出需要当前任务编号 jobId，请先查看输出状态')
      }
      const located = await locateDirectorScene(film.documents, body.source)
      const address = addressOf(film, located)
      const answer = address === null ? undefined : await desks.callDesk(address, `director_render_${action}`, action === 'cancel' ? { jobId: body.jobId } : {}, DIRECTOR_RENDER_STATUS_TIMEOUT_MS)
      if (answer === undefined) throw new DirectorRefusal(409, 'CANVAS_BOARD_NOT_OPEN', '请先打开画布和导演台')
      if (answer.deskOpen !== true) throw new DirectorRefusal(409, 'DIRECTOR_DESK_NOT_OPEN', '请在画布中打开对应导演台')
      const response: DirectorRenderStatusResponse = { source: located.echo, desk: 'open', task: renderTaskOf(answer.task) }
      return response
    })
  }

  handle('POST', '/api/director/render', async (request, film) => {
    const body = await request.json()
    if (isRecord(body.source) && 'directorProject' in body.source) {
      throw new DirectorRefusal(400, 'DIRECTOR_RENDER_NEEDS_BOARD', '渲染要一块开着导演台的板子:传 boardId,而不是 directorProject')
    }
    return renderFromBoard(film, body.source, renderAskOf(body))
  })

  handle('POST', '/api/director/stage', async (request, film) => {
    const body = await request.json()
    const dryRun = body.dryRun === true
    // place_model ops (the agent's, C10) are expanded into the desk's own ops once the scene is read;
    // until then the agent's other ops are checked on their own, under their own numbers.
    const rawOps = isRecord(body.plan) && Array.isArray(body.plan.ops) ? body.plan.ops as unknown[] : undefined
    const placing = rawOps !== undefined && rawOps.some(isPlaceModel)
    const own = placing ? rawOps.flatMap((op, index) => isPlaceModel(op) ? [] : [{ op, index }]) : undefined
    const ownIndex = (index: number): number => own?.[index]?.index ?? index
    const plan = own === undefined
      ? parseDirectorStagePlan(body.plan)
      : own.length === 0 ? { ops: [] } : withAgentOps(() => parseDirectorStagePlan({ ops: own.map(entry => entry.op) }), own.map(entry => entry.index))
    const located = await locateDirectorScene(film.documents, body.source)
    if (placing || plan.ops.some(op => op.type === 'relink_asset' || op.type === 'import_asset' || op.type === 'import_animation')) {
      if (located.boardId && !dryRun && !body.expectedFingerprint) throw new DirectorStageError('导入或重新关联前请读取场景并提供 expectedFingerprint')
      for (const [index, op] of plan.ops.entries()) {
        if (op.type !== 'relink_asset' && op.type !== 'import_asset' && op.type !== 'import_animation') continue
        const file = projectFileOfUrl(op.source.url)
        if (!file || op.source.storageKey) throw new DirectorStageError('先上传模型或动作文件到影片项目，再使用项目 raw URL 导入或重新关联', ownIndex(index))
        if (file.project !== film.projectId) throw new DirectorStageError('文件必须属于当前导演台所在项目', ownIndex(index))
        await verifyDirectorAssetSource(film.root, file.path, op.source, ownIndex(index))
      }
    }
    // The placements' files are found, measured, hashed and (on apply) copied in before the scene is read.
    const placements = placing ? await prepareModelPlacements(rawOps, { cwd: request.cwd, projectId: film.projectId }, { dryRun }) : undefined
    const address = addressOf(film, located)
    const current = await desks.currentScene(located, address, request.raw.signal)
    if (typeof body.expectedFingerprint === 'string' && current.fingerprint && body.expectedFingerprint !== current.fingerprint) {
      throw new DirectorRefusal(409, 'DIRECTOR_SCENE_CONFLICT', '场景在你读它之后变了;重新读一次(query structure 或 scene get)再写', { fingerprint: current.fingerprint, desk: current.desk })
    }
    // A node never opened as a desk starts as an empty scene — the same one
    // the desk itself would start, so nothing about it says "the agent's".
    const base = current.project ?? createEmptyDirectorProject()
    let staged: ReturnType<typeof stageDirectorScene>
    let origin: number[] | undefined
    let placed: PlacedModel[] | undefined
    if (placements === undefined) {
      staged = stageDirectorScene(base, plan)
    } else {
      // Synchronous from here to the write. The expanded imports were just hashed, so they skip verification.
      const expanded = expandModelPlacements(rawOps!, placements, base, film.projectId)
      origin = expanded.origin
      staged = withAgentOps(() => stageDirectorScene(base, parseDirectorStagePlan({ ops: expanded.ops })), expanded.origin)
      placed = expanded.placed
    }
    const inline = address === null
    let fingerprint = getDirectorProjectFingerprint(staged.project)
    let desk = current.desk
    // Nothing may wait between reading the live scene and writing it (a desk opened in the gap would be written around), so diagnostics come after.
    if (!dryRun && !inline) {
      const outcome = await desks.writeScene(film.documents, located, address, current.live, staged.project, () => film.announce(address.boardId))
      fingerprint = outcome.fingerprint
      desk = outcome.desk
    }
    const diagnostics = await directorDiagnostics(staged.project, { kind: 'diagnostics' }, located.echo)
    const answer: DirectorStageResponse & { placed?: PlacedModel[] } = {
      written: !dryRun && !inline,
      source: located.echo,
      fingerprint,
      // The agent's own op numbers, whatever its placements expanded into.
      applied: origin === undefined ? staged.applied : staged.applied.map(entry => ({ ...entry, op: origin[entry.op] ?? entry.op })),
      warnings: staged.warnings,
      diagnostics,
      desk,
      ...(dryRun || inline || body.includeProject === true ? { project: staged.project } : {}),
      ...(placed !== undefined ? { placed } : {}),
    }
    return answer
  })

  handle('POST', '/api/projects/:projectId/director/motions', async (request, film) => compileMotionIntoFilm(film.root, film.projectId, await request.json()))
}

/** What a director request works in: the film's id, folder and board store. */
interface Film {
  projectId: string
  /** `<workspace>/film`. */
  root: string
  documents: CanvasDocumentStore
  announce(boardId: string): void
}

