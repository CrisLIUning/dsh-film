/**
 * The modeling tools that need no browser: Studio's `space_plan_compile`,
 * `model_brief` and the procedural-model record tools (`model_review`,
 * `model_adopt`, `model_status`, `model_report`, `model_cancel`) from
 * apps/daemon/src/mcp.ts. Like Studio's, they are thin clients over the
 * modeling routes (src/studio/modeling-routes.ts), called in-process; the
 * workspace is the project, so none takes a `project`.
 *
 * Answers are summaries: the compiled GLB stays on disk (the answer names its
 * file, URL and SHA-256), and model_report / model_status trim the record to
 * what a decision needs instead of returning every run and check.
 * model_run, model_capture, model_export_glb and model_verify_glb are not here:
 * they drive a headless browser this workbench does not have yet.
 * @module dsh-film/agent/modeling-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MODEL_KINDS, MODEL_REVIEW_STATUSES } from '../modeling/contracts/model-project.js'
import { FilmToolError, callStudio } from './studio-client.js'
import { filmRelative, filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices, FilmWorkspace } from './context.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const records = (value: unknown): Array<Record<string, unknown>> => list(value).filter(isRecord)

/** How many versions, runs, notes and checks a summary carries. */
const SUMMARY_LIMITS = { versions: 20, runs: 10, statusRuns: 20, reviews: 30, checks: 50, paths: 20 } as const

/**
 * A recorded run as the agent reads it: its id, kind, status and outcome, and
 * the files it filed by path — not its stored input or check ids.
 * @param run - the run view.
 * @returns the summary.
 */
export function summariseRun(run: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: run.runId,
    kind: run.kind,
    status: run.status,
    versionId: run.versionId || null,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    artifacts: records(run.artifacts).map(artifact => artifact.path),
    checks: list(run.checkIds).length,
  }
}

/** A run whose recorded status no process is finishing reads as interrupted, as in the run routes. */
const settledRun = (run: Record<string, unknown>): Record<string, unknown> =>
  run.status === 'queued' || run.status === 'running' ? { ...run, status: 'interrupted', error: run.error ?? 'daemon 重启，任务中断' } : run

/**
 * The model report as the agent reads it: every version's capabilities,
 * quality and review standing with its inputs by path, the staleness against
 * the disk, the open notes, the newest version's checks and the latest runs.
 * @param report - the report route's answer.
 * @returns the summary.
 */
export function summariseModelReport(report: Record<string, unknown>): Record<string, unknown> {
  const record = isRecord(report.record) ? report.record : {}
  const inputsOf = new Map(records(record.versions).map(version => [version.versionId, isRecord(version.inputs) ? version.inputs : {}]))
  const paths = (refs: unknown): unknown[] => records(refs).slice(0, SUMMARY_LIMITS.paths).map(ref => ref.path)
  const versions = records(report.versions)
  const newest = versions[0]?.versionId
  const staleness = isRecord(report.staleness) ? report.staleness : null
  const artifacts = staleness !== null ? records(staleness.artifacts) : []
  return {
    model: {
      id: record.id, kind: record.kind, title: record.title,
      ...(record.adoptedVersionId !== undefined ? { adoptedVersionId: record.adoptedVersionId } : {}),
      orientation: record.orientation,
      parameterSchema: record.parameterSchema,
      updatedAt: record.updatedAt,
    },
    workflow: report.workflow ?? null,
    environment: report.environment,
    reviewAspects: report.reviewAspects,
    staleness: staleness === null ? null : {
      currentVersionId: staleness.currentVersionId,
      known: staleness.known,
      reasonText: staleness.reasonText,
      artifactsNeedingUpdate: artifacts.filter(artifact => artifact.freshness === 'needs-update').length,
      artifactsCurrent: artifacts.filter(artifact => artifact.freshness === 'current').length,
    },
    versionCount: versions.length,
    versions: versions.slice(0, SUMMARY_LIMITS.versions).map((version) => {
      const inputs = inputsOf.get(version.versionId) ?? {}
      return {
        ...version,
        inputs: {
          entry: inputs.entry,
          sources: paths(inputs.sources),
          resources: paths(inputs.resources),
          parameters: inputs.parameters,
          toolchain: inputs.toolchain,
        },
      }
    }),
    openReviews: records(record.reviews).filter(note => note.status === 'open' || note.status === 'addressed').slice(0, SUMMARY_LIMITS.reviews).map(note => ({
      id: note.id, versionId: note.versionId, aspect: note.aspect, concern: note.concern, status: note.status, raisedBy: note.raisedBy,
      ...(note.addressedInVersionId !== undefined ? { addressedInVersionId: note.addressedInVersionId } : {}),
    })),
    newestVersionChecks: records(record.checks).filter(check => check.versionId === newest).slice(0, SUMMARY_LIMITS.checks).map(check => ({
      gate: check.gate, applicability: check.applicability,
      ...(check.verdict !== undefined ? { verdict: check.verdict } : {}),
      ...(check.reason !== undefined ? { reason: check.reason } : {}),
    })),
    runCount: list(record.runs).length,
    recentRuns: records(record.runs).slice(0, SUMMARY_LIMITS.runs).map(run => summariseRun(settledRun(run))),
  }
}

const KIND = { type: 'string', enum: MODEL_KINDS } as const
const MODEL_ID = { type: 'string', required: true, description: 'Stable model id, e.g. knight (its record is film/models/<id>/model.json).' } as const

/**
 * Build the modeling tools.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function modelingTools(services: FilmToolServices): ToolDefinition[] {
  const call = (film: FilmWorkspace, method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> =>
    callStudio(services.studio, film.cwd, { method, path: `/api/projects/${segment(film.projectId)}${path}`, ...(method === 'POST' ? { body } : {}) }, signal)
  const modelPath = (model: string): string => `/models/${segment(model)}`

  return [
    defineTool({
      name: 'space_plan_compile',
      description: 'Build a place for a scene to happen — a room, a corridor, a castle — from a plan you write, and put it in the project as a glb the director '
        + 'desk can open (film/spaces/<name>.glb; the answer gives its file relative to film/, url, bytes and sha256). You author the plan; a reference image '
        + 'only ever contributes the room programme, the topology and the style, never the dimensions (drawings contradict themselves; measure nothing off '
        + 'one). With no reference at all, write it from the script. Every length is millimetres. Use dryRun to see the counts, the size and the warnings '
        + 'before committing a draft to a file.',
      parameters: {
        plan: {
          type: 'object',
          required: true,
          additionalProperties: true,
          description: 'name, footprint {width,depth}, levels[{id,name,elevation,height,rooms}], and optionally towers, wings, stairs[{from,to,at,width,direction}], '
            + 'interior {spineX,spineZ,hall}, openings {exteriorWindowPitch}, entrance. Anchors when inventing: storey 2700-3200 (a hall 6000-12000), corridor '
            + '1500-2400 wide, door 900x2100, window sill 900 height 1500, stair going 280, wall 200-400 inside and 600-900 outside. The desk\'s character is '
            + '1820 tall and 1310 wide with arms out, so build to clear that.',
        },
        output: { type: 'string', description: 'File name; it lands under the project\'s spaces/.' },
        dryRun: { type: 'boolean', description: 'Report and write nothing.' },
        strict: { type: 'boolean', description: 'Refuse to write if the plan produced any warning.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        return plain(await call(film, 'POST', '/space-plans', {
          plan: args.plan,
          ...(args.output !== undefined ? { output: args.output } : {}),
          ...(args.dryRun === true ? { dryRun: true } : {}),
          ...(args.strict === true ? { strict: true } : {}),
        }, exec.signal))
      },
    }),
    defineTool({
      name: 'model_brief',
      description: 'Prepare a project-owned procedural-model task: a spec plus Three.js source and notes under film/models/<id>/, written in this '
        + 'conversation. No director desk is required. The workbench cannot run, photograph or export models, so the result is source, not a GLB. This call '
        + 'runs no code and starts no other agent.',
      parameters: {
        kind: { ...KIND, required: true },
        description: { type: 'string', required: true },
        heightMetres: { type: 'number' },
        references: { type: 'array', items: { type: 'string' }, description: 'Up to three reference images, relative to film/.' },
        context: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional director target in this film: the desk\'s node and the selected objects, as director_query names them.',
          properties: {
            nodeId: { type: 'string', required: true },
            objectIds: { type: 'array', items: { type: 'string' } },
            cameraId: { type: 'string' },
            shotId: { type: 'string' },
            seconds: { type: 'number' },
          },
        },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        const context = args.context !== undefined
          ? { projectId: film.projectId, boardId: film.boardId, view: 'director', director: { objectIds: [], ...args.context } }
          : undefined
        return plain(await call(film, 'POST', '/modeling-brief', {
          kind: args.kind,
          description: args.description,
          ...(args.heightMetres !== undefined ? { heightMetres: args.heightMetres } : {}),
          ...(args.references !== undefined ? { references: args.references.map(filmRelative) } : {}),
          ...(context !== undefined ? { context } : {}),
        }, exec.signal))
      },
    }),
    defineTool({
      name: 'model_review',
      description: 'Visual review of a model version — the judgement script gates cannot make. Look at the SAME version\'s preview and capture images, then '
        + 'file concrete concerns: `action:add` with an `aspect` and a `concern` in your own words (not a gate name). What to look at follows the model\'s '
        + 'purpose, and model_report returns the list: a scene is judged on proportion, space and walkability, a character on silhouette, rig and motion, a '
        + 'prop on form, material and size — a crate is not put through a character review. `action:resolve` marks one note addressed / accepted / '
        + 'dismissed; `addressed` names the version meant to answer it, so "fixed later" is checkable. A note belongs to the version it was raised against '
        + 'and is never rewritten to point at a newer one: editing the source does not answer a criticism, it only changes which version the note is '
        + 'waiting on. Reviews are reported apart from gate verdicts, because a model with every gate green and three open notes is not finished.',
      parameters: {
        model: MODEL_ID,
        action: { type: 'string', required: true, enum: ['add', 'resolve'] },
        versionId: { type: 'string', description: 'add: defaults to the newest version' },
        aspect: { type: 'string' },
        concern: { type: 'string' },
        noteId: { type: 'string', description: 'resolve: which note' },
        status: { type: 'string', enum: MODEL_REVIEW_STATUSES },
        resolution: { type: 'string' },
        addressedInVersionId: { type: 'string' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const base = `${modelPath(args.model)}/reviews`
        if (args.action === 'add') {
          if (args.concern === undefined || args.concern.trim() === '') throw new FilmToolError('MODEL_REVIEW_EMPTY', '审阅要写清楚具体问题')
          const film = await filmWorkspace(exec)
          return plain(await call(film, 'POST', base, {
            concern: args.concern, raisedBy: 'agent',
            ...(args.aspect !== undefined ? { aspect: args.aspect } : {}),
            ...(args.versionId !== undefined ? { versionId: args.versionId } : {}),
          }, exec.signal))
        }
        if (args.noteId === undefined || args.status === undefined) throw new FilmToolError('MODEL_REVIEW_INVALID', 'resolve 需要 noteId 和 status')
        const film = await filmWorkspace(exec)
        return plain(await call(film, 'POST', `${base}/${segment(args.noteId)}`, {
          status: args.status,
          ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
          ...(args.addressedInVersionId !== undefined ? { addressedInVersionId: args.addressedInVersionId } : {}),
        }, exec.signal))
      },
    }),
    defineTool({
      name: 'model_adopt',
      description: 'Record the version the user confirmed for use. Older versions stay adoptable, so this is a choice and not an overwrite — placing a model '
        + 'in the desk adds an asset and never rewrites a scene instance somebody already positioned.',
      parameters: {
        model: MODEL_ID,
        versionId: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        return plain(await call(film, 'POST', `${modelPath(args.model)}/adopt`, { versionId: args.versionId }, exec.signal))
      },
    }),
    defineTool({
      name: 'model_status',
      description: 'Progress and outcome of model runs, as the record holds them (newest first; this workbench cannot start runs yet). Omit run to list them. '
        + 'A run left queued or running reads as `interrupted`, never `failed` — nobody observed that outcome. Status is the TASK; the quality verdict is in '
        + 'model_report.',
      parameters: {
        model: MODEL_ID,
        run: { type: 'string', description: 'A model task\'s run.runId from this model\'s record. Not a media taskId, versionId or clientRequestId. Omit to list model tasks.' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        const base = `${modelPath(args.model)}/runs`
        if (args.run !== undefined && args.run !== '') {
          const answer = await call(film, 'GET', `${base}/${segment(args.run)}`, undefined, exec.signal)
          return plain({ run: isRecord(answer.run) ? summariseRun(answer.run) : null })
        }
        const runs = records((await call(film, 'GET', base, undefined, exec.signal)).runs)
        return plain({ total: runs.length, runs: runs.slice(0, SUMMARY_LIMITS.statusRuns).map(summariseRun) })
      },
    }),
    defineTool({
      name: 'model_report',
      description: 'The model record: every version with its inputs, what each version can be used for, and what the checks said. `verdict` is `incomplete` '
        + '— not `pass` — while an applicable gate has not run. Capabilities are earned separately: an unverified GLB is `glb-exported`, not `desk-placeable`, '
        + 'and `desk-placeable` never implies `desk-performable`. `staleness` compares the record against the source on disk right now and names what '
        + 'moved. Summarised: the newest versions, open review notes, the newest version\'s checks and the latest runs.',
      parameters: {
        model: MODEL_ID,
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        return plain(summariseModelReport(await call(film, 'GET', modelPath(args.model), undefined, exec.signal)))
      },
    }),
    defineTool({
      name: 'model_cancel',
      description: 'Stop a running model task. Its record and any artefacts it already filed are kept. This workbench runs no model tasks itself, so the '
        + 'answer is the run as recorded.',
      parameters: {
        model: MODEL_ID,
        run: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        const answer = await call(film, 'POST', `${modelPath(args.model)}/runs/${segment(args.run)}/cancel`, { requestedBy: 'mcp' }, exec.signal)
        return plain({ run: isRecord(answer.run) ? summariseRun(answer.run) : null })
      },
    }),
  ]
}
