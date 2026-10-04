/**
 * Studio's modeling endpoints that need no browser, over the workspace's
 * `film/` folder (the Studio project), with the request and answer shapes and
 * error codes of Studio's routes/space-plan.ts, routes/modeling-brief.ts and
 * routes/models.ts:
 *
 * - `POST /api/projects/:id/space-plans` compiles a space plan into
 *   `film/spaces/<name>.glb` (or only reports, with `dryRun`).
 * - `POST /api/projects/:id/modeling-brief` writes a procedural-model brief (a spec
 *   and Three.js source under `film/models/<id>/`, which this workbench cannot run).
 * - The procedural-model record under `film/models/<id>/model.json`: the list,
 *   the report, the model's own source, review notes, adoption, and the
 *   recorded runs — what the canvas's 程序化模型 panel and the model_* tools read.
 *
 * Running a model (mesh dump, captures, GLB export and readback, the preview
 * page) needs a headless browser and a bundler this workbench does not drive
 * yet; those three endpoints answer with Studio's refusal codes and say so.
 * Errors answer `{ error, code }`, the shape Studio's routes and the panel use.
 * Studio's same-origin and project-lease guards are the Host channel's job here.
 * @module dsh-film/studio/modeling-routes
 */

import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { compileSpacePlan } from '../space-plan/compile.js'
import type { CompiledSpacePlan, SpacePlan } from '../space-plan/compile.js'
import { spacePlanToGlb } from '../space-plan/glb.js'
import { SpacePlanInputError } from '../space-plan/input.js'
import {
  MODELS_DIR, MODEL_REVIEW_ASPECTS, MODEL_REVIEW_STATUSES, isModelId, isProjectRelativePath, modelCapabilities,
  modelQualitySummary, modelRecordPath, modelReviewSummary,
} from '../modeling/contracts/model-project.js'
import type { ModelEnvironment, ModelProjectRecord, ModelReviewNote } from '../modeling/contracts/model-project.js'
import { buildModelingBrief } from '../modeling/contracts/modeling-brief.js'
import { modelEnvironment } from '../modeling/environment.js'
import {
  addModelReview, adoptModelVersion, collectModelInputs, createModelRecord, describeStaleness, filmFilePath, listFilmFolder,
  modelRunView, readFilmFile, readModelRecord, resolveModelReview, sha256, stalenessReason, updateModelRecord, writeFilmFile,
} from '../modeling/store.js'
import { readModelWorkflow } from '../modeling/workflow.js'
import type { ProjectEvents } from './events.js'
import { StudioReply } from './router.js'
import type { StudioHandler, StudioRequest, StudioRouter } from './router.js'
import { filmBoardOf } from './screenwriter-routes.js'

/** Where compiled buildings go, inside the project. */
export const SPACE_DIR = 'spaces'

/** The refusal of the endpoints that would run a model. */
export const MODEL_RUNTIME_MISSING = '这个工作台还不能运行模型：运行、多机位检查图、导出和回读 GLB 需要无头浏览器与打包工具，暂未接入。源码、审阅、采用和已有记录可以照常使用。'

const RUN_KINDS = new Set(['mesh-dump', 'capture', 'glb-export', 'glb-readback'])

export interface ModelingRouteDeps {
  /** The project event bus: every file written here is announced as `file-changed`. */
  events: ProjectEvents
  /** The environment probe; tests replace it. */
  environment?: () => Promise<ModelEnvironment>
}

const fail = (status: number, code: string, error: string): never => {
  throw new StudioReply(status, { error, code })
}

/**
 * A file or record failure as the flat `{ error, code }` the 程序化模型 panel
 * reads, rather than the router's generic nested answer.
 * @param error - what a handler threw.
 * @returns the error to throw on.
 */
function modelingFailure(error: unknown): unknown {
  if (error instanceof StudioReply || !(error instanceof Error)) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM') return new StudioReply(403, { error: error.message, code: 'MODEL_WRITE_FORBIDDEN' })
  if (code === 'ENOENT') return new StudioReply(404, { error: error.message, code: 'MODEL_FILE_NOT_FOUND' })
  return new StudioReply(500, { error: error.message, code: 'MODEL_WRITE_FAILED' })
}

const sourceWrites = new Map<string, Promise<unknown>>()

/** Run one source write at a time per file, so a hash check and its write cannot interleave with another save. */
async function oneWriteAtATime<T>(key: string, write: () => Promise<T>): Promise<T> {
  const task = (sourceWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(write)
  sourceWrites.set(key, task)
  try {
    return await task
  } finally {
    if (sourceWrites.get(key) === task) sourceWrites.delete(key)
  }
}

/**
 * Where a compiled building goes: a leaf under `spaces/`, whatever the caller
 * asked for, because an output path is the obvious way to write outside the
 * project. Ported from Studio's `spacePlanOutputPath`; backslashes count as
 * separators on every platform.
 * @param name - the plan's name.
 * @param requested - the caller's file name, if any.
 * @returns the project-relative path.
 */
export function spacePlanOutputPath(name: string, requested?: string): string {
  const raw = (requested ?? '').trim().replace(/\\/g, '/')
  const leaf = (raw ? posix.basename(raw) : `${name}.glb`)
    .replace(/[^A-Za-z0-9._\-一-龥]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 80)
  const safe = leaf || 'space.glb'
  return posix.join(SPACE_DIR, safe.toLowerCase().endsWith('.glb') ? safe : `${safe}.glb`)
}

function isPlan(value: unknown): value is SpacePlan {
  if (!value || typeof value !== 'object') return false
  const plan = value as Partial<SpacePlan>
  return typeof plan.name === 'string'
    && Boolean(plan.footprint)
    && typeof plan.footprint?.width === 'number'
    && typeof plan.footprint?.depth === 'number'
    && Array.isArray(plan.levels)
    && plan.levels.length > 0
}

/** A project file's raw URL, as Studio answers it. */
const rawUrl = (projectId: string, path: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/raw/${path.split('/').map(encodeURIComponent).join('/')}`

/**
 * The answer to a compile, in Studio's shape plus the file's SHA-256 (the
 * director's import_asset quotes it).
 * @param compiled - the compiled plan.
 * @param glb - the GLB bytes.
 * @param file - the project-relative path.
 * @param projectId - the project id for the URL.
 * @param written - whether the file was written.
 * @returns the answer.
 */
function compileAnswer(compiled: CompiledSpacePlan, glb: Buffer, file: string, projectId: string, written: boolean): Record<string, unknown> {
  return {
    written,
    file,
    url: rawUrl(projectId, file),
    bytes: glb.length,
    sha256: sha256(glb),
    counts: compiled.counts,
    size: {
      width: +(compiled.bounds.max[0] - compiled.bounds.min[0]).toFixed(3),
      height: +(compiled.bounds.max[1] - compiled.bounds.min[1]).toFixed(3),
      depth: +(compiled.bounds.max[2] - compiled.bounds.min[2]).toFixed(3),
    },
    levels: [...new Set(compiled.parts.map(part => part.group))],
    warnings: compiled.warnings,
    access: compiled.access,
  }
}

/** The record of a model, or one made up from its forge progress (never written). */
async function recordOrWorkflow(cwd: string, modelId: string): Promise<{ record: ModelProjectRecord | null; workflow: Awaited<ReturnType<typeof readModelWorkflow>> }> {
  const workflow = await readModelWorkflow(cwd, modelId)
  const record = await readModelRecord(cwd, modelId)
    ?? (workflow !== null ? createModelRecord({ id: modelId, kind: workflow.kind, title: modelId, now: '' }) : null)
  return { record, workflow }
}

/**
 * Add the modeling routes to a router.
 * @param router - the Studio-compatible router.
 * @param deps - the event bus and the environment probe.
 */
export function addModelingRoutes(router: StudioRouter, deps: ModelingRouteDeps): void {
  const environment = deps.environment ?? modelEnvironment
  const add = (method: Parameters<StudioRouter['add']>[0], pattern: string, handler: StudioHandler): void => {
    router.add(method, pattern, async (request) => {
      try {
        return await handler(request)
      } catch (error) {
        throw modelingFailure(error)
      }
    })
  }
  const MODEL = '/api/projects/:projectId/models/:modelId'

  const modelOf = (request: StudioRequest): string => {
    const modelId = request.params.modelId ?? ''
    if (!isModelId(modelId)) fail(400, 'MODEL_ID_INVALID', '模型 ID 不合法')
    return modelId
  }
  const announce = async (request: StudioRequest, path: string): Promise<void> => {
    deps.events.emit(request.cwd, { type: 'file-changed', projectId: await filmBoardOf(request), path })
  }

  add('POST', '/api/projects/:projectId/space-plans', async (request) => {
    const body = await request.json()
    if (!isPlan(body.plan)) fail(400, 'SPACE_PLAN_INVALID', '需要一份平面:至少有 name、footprint 和一层 levels')
    const plan = body.plan as SpacePlan
    try {
      const compiled = compileSpacePlan(plan)
      // Warnings are the point of the check, not a failure: most are worth reading
      // and building anyway. A caller that would rather not ship a contradiction asks for strict.
      if (body.strict === true && compiled.warnings.length > 0) {
        throw new StudioReply(422, { error: '平面有未解决的问题', code: 'SPACE_PLAN_NOT_CLEAN', warnings: compiled.warnings, access: compiled.access })
      }
      const glb = spacePlanToGlb(compiled, plan.name)
      const file = spacePlanOutputPath(plan.name, typeof body.output === 'string' ? body.output : undefined)
      // A dry run answers "is this the building I meant" without leaving a file for every draft.
      const written = body.dryRun !== true
      if (written) {
        await writeFilmFile(request.cwd, file, glb)
        await announce(request, file)
      }
      return compileAnswer(compiled, glb, file, await filmBoardOf(request), written)
    } catch (error) {
      if (error instanceof StudioReply) throw error
      return fail(error instanceof SpacePlanInputError ? 400 : 500, error instanceof SpacePlanInputError ? 'SPACE_PLAN_INVALID' : 'SPACE_PLAN_COMPILE_FAILED',
        error instanceof Error ? error.message : String(error))
    }
  })

  add('POST', '/api/projects/:projectId/modeling-brief', async (request) => {
    const body = await request.json()
    const projectId = await filmBoardOf(request)
    try {
      return buildModelingBrief(body, projectId)
    } catch (error) {
      return fail(400, 'MODELING_BRIEF_INVALID', error instanceof Error ? error.message : String(error))
    }
  })

  add('GET', '/api/projects/:projectId/models', async (request) => {
    const children = await listFilmFolder(request.cwd, MODELS_DIR)
    const models = []
    for (const id of children?.dirs ?? []) {
      if (!isModelId(id)) continue
      const { record } = await recordOrWorkflow(request.cwd, id)
      if (record === null) continue
      const newest = record.versions[0]
      models.push({
        id: record.id, kind: record.kind, title: record.title, updatedAt: record.updatedAt,
        versionId: newest?.versionId ?? null,
        capabilities: newest !== undefined ? modelCapabilities(record, newest.versionId) : [],
      })
    }
    return { models, environment: await environment() }
  })

  // The record, plus how it stands against what is on disk right now.
  add('GET', MODEL, async (request) => {
    const modelId = modelOf(request)
    const { record, workflow } = await recordOrWorkflow(request.cwd, modelId)
    if (record === null) return fail(404, 'MODEL_NOT_FOUND', '没有这个模型记录')
    const newest = record.versions[0]
    let staleness = null
    if (newest !== undefined) {
      // Re-hash the inputs as they are now, so "needs update" reflects the disk
      // rather than what the last run happened to see.
      const current = await collectModelInputs(request.cwd, {
        entry: newest.inputs.entry,
        sources: newest.inputs.sources.map(ref => ref.path),
        resources: newest.inputs.resources.map(ref => ref.path),
        parameters: newest.inputs.parameters,
        toolchain: newest.inputs.toolchain,
      }).catch(() => null)
      if (current !== null) {
        const described = describeStaleness(record, current)
        staleness = { ...described, reasonText: stalenessReason(described.reason) }
      }
    }
    return {
      workflow,
      environment: await environment(),
      record,
      staleness,
      // What to look at follows what the model is for: a crate is not put through a character review.
      reviewAspects: MODEL_REVIEW_ASPECTS[record.kind] ?? [],
      versions: record.versions.map(version => ({
        versionId: version.versionId,
        createdAt: version.createdAt,
        capabilities: modelCapabilities(record, version.versionId),
        quality: modelQualitySummary(record.checks, version.versionId),
        review: modelReviewSummary(record.reviews, version.versionId),
      })),
    }
  })

  // The model's own source, scoped to models/<id>/: the model's workbench, not a general file editor.
  const sourcePathOf = (modelId: string, raw: unknown): string | null => {
    if (typeof raw !== 'string' || !isProjectRelativePath(raw)) return null
    return raw.startsWith(`${MODELS_DIR}/${modelId}/`) ? raw : null
  }

  add('GET', `${MODEL}/source`, async (request) => {
    const modelId = modelOf(request)
    const name = sourcePathOf(modelId, request.query.get('path') ?? undefined)
    if (name === null) return fail(400, 'MODEL_SOURCE_PATH_INVALID', `只能读取 ${MODELS_DIR}/${modelId}/ 下的文件`)
    const file = await readFilmFile(request.cwd, name).catch(() => null)
    if (file === null) return fail(404, 'MODEL_SOURCE_NOT_FOUND', `找不到 ${name}`)
    return { path: file.path, text: file.buffer.toString('utf8'), sha256: sha256(file.buffer), bytes: file.size }
  })

  add('PUT', `${MODEL}/source`, async (request) => {
    const modelId = modelOf(request)
    const body = await request.json()
    const name = sourcePathOf(modelId, body.path)
    if (name === null) return fail(400, 'MODEL_SOURCE_PATH_INVALID', `只能写入 ${MODELS_DIR}/${modelId}/ 下的文件`)
    if (typeof body.text !== 'string' || body.text.length > 4_000_000) return fail(400, 'MODEL_SOURCE_INVALID', '源码内容不合法')
    const text = body.text
    await oneWriteAtATime(filmFilePath(request.cwd, name), async () => {
      if (typeof body.expectedSha256 === 'string') {
        // Someone else's edit is not something to overwrite silently.
        const current = await readFilmFile(request.cwd, name).catch(() => null)
        if ((current !== null ? sha256(current.buffer) : '') !== body.expectedSha256) {
          return fail(409, 'MODEL_SOURCE_CONFLICT', '这个文件在你编辑期间已经变化，请先重新读取')
        }
      }
      await writeFilmFile(request.cwd, name, text)
    })
    await announce(request, name)
    return { path: name, sha256: sha256(text), bytes: Buffer.byteLength(text) }
  })

  // Visual review: what a person or the agent saw, against one version — kept
  // apart from the gate verdict, because a model with every gate green and
  // three open notes is not done.
  add('POST', `${MODEL}/reviews`, async (request) => {
    const modelId = modelOf(request)
    const body = await request.json()
    const answer = await updateModelRecord(request.cwd, modelId, (record) => {
      if (record === null) return fail(404, 'MODEL_NOT_FOUND', '没有这个模型记录')
      const versionId = typeof body.versionId === 'string' && body.versionId ? body.versionId : record.versions[0]?.versionId
      if (!versionId || !record.versions.some(version => version.versionId === versionId)) {
        return fail(400, 'MODEL_VERSION_UNKNOWN', '这条审阅要挂在一个已知版本上')
      }
      if (typeof body.concern !== 'string' || !body.concern.trim()) return fail(400, 'MODEL_REVIEW_EMPTY', '审阅要写清楚具体问题')
      const aspects = MODEL_REVIEW_ASPECTS[record.kind] ?? []
      const aspect = typeof body.aspect === 'string' && aspects.includes(body.aspect) ? body.aspect : aspects[0] ?? 'general'
      const now = new Date().toISOString()
      const note: ModelReviewNote = {
        id: `rev_${randomUUID()}`,
        versionId,
        raisedBy: body.raisedBy === 'agent' ? 'agent' : 'user',
        aspect,
        concern: body.concern.trim().slice(0, 4000),
        createdAt: now,
        status: 'open',
      }
      return { record: addModelReview(record, note, now), value: { note, aspects } }
    })
    await announce(request, modelRecordPath(modelId))
    return new Response(JSON.stringify(answer), { status: 201, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
  })

  add('POST', `${MODEL}/reviews/:noteId`, async (request) => {
    const modelId = modelOf(request)
    const body = await request.json()
    const status = String(body.status ?? '')
    if (!(MODEL_REVIEW_STATUSES as readonly string[]).includes(status)) {
      return fail(400, 'MODEL_REVIEW_STATUS_INVALID', 'status 只能是 open / addressed / accepted / dismissed')
    }
    const noteId = request.params.noteId ?? ''
    const note = await updateModelRecord(request.cwd, modelId, (record) => {
      if (record === null || !record.reviews.some(entry => entry.id === noteId)) return fail(404, 'MODEL_REVIEW_NOT_FOUND', '没有这条审阅')
      const next = resolveModelReview(record, noteId, {
        status: status as ModelReviewNote['status'],
        ...(typeof body.resolution === 'string' ? { resolution: body.resolution.slice(0, 4000) } : {}),
        // `addressed` names the version meant to answer it, which makes "fixed later" checkable.
        ...(typeof body.addressedInVersionId === 'string' ? { addressedInVersionId: body.addressedInVersionId } : {}),
      }, new Date().toISOString())
      return { record: next, value: next.reviews.find(entry => entry.id === noteId) }
    })
    await announce(request, modelRecordPath(modelId))
    return { note }
  })

  // The user confirming a version for use. Older ones stay adoptable.
  add('POST', `${MODEL}/adopt`, async (request) => {
    const modelId = modelOf(request)
    const versionId = String((await request.json()).versionId ?? '')
    const answer = await updateModelRecord(request.cwd, modelId, (record) => {
      if (record === null) return fail(404, 'MODEL_NOT_FOUND', '没有这个模型记录')
      let next: ModelProjectRecord
      try {
        next = adoptModelVersion(record, versionId, new Date().toISOString())
      } catch (error) {
        return fail(400, 'MODEL_ADOPT_REJECTED', error instanceof Error ? error.message : String(error))
      }
      return { record: next, value: { adoptedVersionId: next.adoptedVersionId, review: modelReviewSummary(next.reviews, versionId) } }
    })
    await announce(request, modelRecordPath(modelId))
    return answer
  })

  add('GET', `${MODEL}/runs`, async (request) => {
    const modelId = modelOf(request)
    const projectId = await filmBoardOf(request)
    const record = await readModelRecord(request.cwd, modelId)
    return { runs: (record?.runs ?? []).map(run => modelRunView(projectId, modelId, run)) }
  })

  const recordedRun = async (request: StudioRequest): Promise<Record<string, unknown>> => {
    const modelId = modelOf(request)
    const record = await readModelRecord(request.cwd, modelId)
    const run = record?.runs.find(entry => entry.runId === request.params.runId)
    if (run === undefined) return fail(404, 'MODEL_RUN_NOT_FOUND', '没有这个任务')
    return { run: modelRunView(await filmBoardOf(request), modelId, run) }
  }
  add('GET', `${MODEL}/runs/:runId`, recordedRun)
  // Nothing runs here, so there is nothing to abort: the answer is the run as recorded, as Studio answers a run it is not running.
  add('POST', `${MODEL}/runs/:runId/cancel`, recordedRun)

  add('POST', `${MODEL}/runs`, async (request) => {
    modelOf(request)
    const body = await request.json()
    const kind = String(body.kind ?? 'mesh-dump')
    if (!RUN_KINDS.has(kind)) return fail(400, 'MODEL_RUN_KIND_INVALID', `暂不支持的任务类型：${kind}`)
    if (typeof body.entry !== 'string' || !body.entry) return fail(400, 'MODEL_ENTRY_REQUIRED', '需要模型入口文件 entry')
    return fail(400, 'MODEL_RUN_REJECTED', MODEL_RUNTIME_MISSING)
  })
  add('POST', `${MODEL}/runs/:runId/retry`, async (request) => {
    modelOf(request)
    return fail(400, 'MODEL_RUN_REJECTED', MODEL_RUNTIME_MISSING)
  })
  add('POST', `${MODEL}/preview`, async (request) => {
    modelOf(request)
    const body = await request.json()
    if (typeof body.entry !== 'string' || !body.entry) return fail(400, 'MODEL_ENTRY_REQUIRED', '需要模型入口文件 entry')
    return fail(400, 'MODEL_PREVIEW_REJECTED', MODEL_RUNTIME_MISSING)
  })
}
