/**
 * The director desk's tools (Studio's `director_*` MCP tools and
 * `model_brief`, apps/daemon/src/mcp.ts), calling the director routes
 * in-process. Querying, staging, reviews, motion compiling and modeling
 * briefs are computed here from the saved board — or from the open desk, which
 * is read first when the 导演 tab shows it. Rendering, output status and model
 * inspection need the desk open: those calls go to the canvas page that has
 * it (see src/director/live.ts for how that page is found).
 *
 * Differences from Studio's tools: the film has one board, so `boardId` and
 * `project` are not parameters; answers are summaries (a staged project comes
 * back only when asked for, long finding lists are capped, rendered files carry
 * their workspace path for read_image); `director_render_background` and
 * `director_attach_background` are absent (no headless desk here).
 * @module dsh-film/agent/director-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FILM_DIR } from '../project.js'
import { callStudio } from './studio-client.js'
import { filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices, FilmWorkspace } from './context.js'

/** Findings kept in an answer; the summary still counts all of them. */
export const FINDINGS_SHOWN = 60

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const nodeId = { type: 'string', description: 'The director node; needed only when the board has more than one (a refusal lists them).' } as const
const directorProject = { type: 'object', additionalProperties: true, description: 'A desk project handed over inline instead of the board\'s node; never written.' } as const
const shotTime = {
  oneOf: [
    { type: 'number', description: 'Scene seconds.' },
    { type: 'object', additionalProperties: false, properties: { eventId: { type: 'string', required: true }, offset: { type: 'number' } } },
  ],
} as const

/** The scene a call means: the board's director node, or a project handed over. */
function sourceOf(film: FilmWorkspace, args: { nodeId?: string; directorProject?: unknown }): Record<string, unknown> {
  if (args.directorProject !== undefined) return { directorProject: args.directorProject }
  return { boardId: film.boardId, ...(args.nodeId ? { nodeId: args.nodeId } : {}) }
}

/** Only the defined members, so the routes see exactly what the agent said. */
function defined(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]]))
}

/** Diagnostics with a bounded finding list. */
function capped(diagnostics: unknown): unknown {
  if (!isRecord(diagnostics) || !Array.isArray(diagnostics.findings) || diagnostics.findings.length <= FINDINGS_SHOWN) return diagnostics
  return { ...diagnostics, findings: diagnostics.findings.slice(0, FINDINGS_SHOWN), findingsOmitted: diagnostics.findings.length - FINDINGS_SHOWN }
}

/** A rendered or reviewed file with the workspace path read_image takes. */
function withWorkspacePath(file: unknown): unknown {
  return isRecord(file) && typeof file.path === 'string' && file.path !== '' ? { ...file, workspacePath: `${FILM_DIR}/${file.path}` } : file
}

/**
 * Build the director tools.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function directorTools(services: FilmToolServices): ToolDefinition[] {
  const post = async (exec: ToolRunContext, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const film = await filmWorkspace(exec)
    return callStudio(services.studio, film.cwd, { method: 'POST', path, body }, exec.signal)
  }
  const onBoard = async (exec: ToolRunContext, args: { nodeId?: string }, path: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const film = await filmWorkspace(exec)
    return callStudio(services.studio, film.cwd, { method: 'POST', path, body: { source: sourceOf(film, args), ...extra } }, exec.signal)
  }

  const brief = async (exec: ToolRunContext, args: Record<string, unknown>, director?: Record<string, unknown>) => {
    const film = await filmWorkspace(exec)
    const context = director === undefined ? undefined : { projectId: film.projectId, boardId: film.boardId, view: 'director', director }
    const answer = await callStudio(services.studio, film.cwd, {
      method: 'POST',
      path: `/api/projects/${segment(film.projectId)}/modeling-brief`,
      body: { ...defined(args, ['kind', 'description', 'heightMetres', 'references']), ...(context ? { context } : {}) },
    }, exec.signal)
    return plain({ ...answer, note: `Project paths in the brief are relative to ${FILM_DIR}/ (models/ is ${FILM_DIR}/models/). References are film-relative paths.` })
  }

  const briefParameters = {
    kind: { type: 'string', required: true, enum: ['scene', 'character', 'prop', 'weapon', 'vehicle'] },
    description: { type: 'string', required: true, description: '1–8000 characters.' },
    heightMetres: { type: 'number' },
    references: { type: 'array', items: { type: 'string' }, description: 'Up to 3 film-relative image paths.' },
  } as const

  return [
    defineTool({
      name: 'director_query',
      description: 'Ask a director-desk scene questions without rendering. Time is scene seconds on one clock. kind=structure: who is in it, each camera '
        + 'as a shot with its clips and what it tracks, routes as clips, takes (shots), assets and spatial profiles; includeCameraPresets adds the preset '
        + 'catalogue. kind=events: route arrivals/departures and named markers with times, unresolved sources and the scene fingerprint (the cheap way to '
        + 'get one); objectId filters, includeDerived:false lists markers only. kind=sample with at:[seconds or {eventId,offset?}] (1–200): where everyone '
        + 'is, facing, action, moving; where each camera is, what it tracks and who is in its frame (screen x -1 left..1 right); aspect overrides. '
        + 'kind=diagnostics (step 0.02–2, cameraIds): subjects leaving frame or head cut, the 180° line crossed, routes through walls, late arrivals, '
        + 'screen order. kind=actions with objectId: the character\'s actions, how each renders, compatibility and library needs, plus its action clips. '
        + 'Reads the open desk when the 导演 tab shows it, else the saved node.',
      parameters: {
        kind: { type: 'string', required: true, enum: ['structure', 'sample', 'diagnostics', 'events', 'actions'] },
        nodeId,
        directorProject,
        includeCameraPresets: { type: 'boolean' },
        objectId: { type: 'string' },
        includeDerived: { type: 'boolean' },
        at: { type: 'array', items: shotTime },
        cameraIds: { type: 'array', items: { type: 'string' } },
        step: { type: 'number' },
        aspect: { type: 'number', description: 'Frame width/height, 0–10; default 16/9.' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const query = defined(args, ['kind', 'includeCameraPresets', 'objectId', 'includeDerived', 'at', 'cameraIds', 'step', 'aspect'])
        const answer = await onBoard(exec, args, '/api/director/query', { query })
        return plain(answer.kind === 'diagnostics' ? capped(answer) : answer)
      },
    }),
    defineTool({
      name: 'director_stage',
      description: 'Stage a director-desk scene from a plan in a director\'s words, compiled, checked and written into the desk (open in the 导演 tab) or '
        + 'the board\'s node; a node never opened starts empty. plan = {ops:[...]} (1–200, metres and scene seconds, additive: only what an op names changes). '
        + 'Core ops: place_character {id?,name?,at:[x,z]|[x,y,z],facing?:degrees|{toward:id},bodyType?,action?}; place_prop {id?,name?,geometry?:box|sphere|'
        + 'cylinder|torus|cone|pyramid,at,size:[w,h,d]}; move {objectId,start,end,path:[[x,z],…] (one point walks there),holds?:[{point,seconds,action?}],'
        + 'pace?:uniform|soft|custom,facing?:path|manual,action?,arriveAction?,clipId?}; shot {cameraId?,name?,seconds?,track?,active?,shot:{subject,size:'
        + 'extreme-wide|wide|full|medium-full|medium|medium-close|close|extreme-close,side?:front|three-quarter-left|three-quarter-right|left|right|back-left|'
        + 'back-right|back,angle?:eye|high|low|top,over?:id,shoulder?:left|right,at?}}; camera_move {keyframes:[{at,shot,hold?}],seconds?,pace?}; follow '
        + '{shot,seconds?,every?}; remove {objectId|cameraId}; set_active_camera {cameraId}; set_scene {collision}; set_scene_time {duration?,loop?,'
        + 'loopRange?}; place_asset {assetId,at,id?}; transform_objects {objectIds,position?,rotation?(degrees),scale?}. Takes: set_shot {shotId?,name?,'
        + 'cameraId?,sourceIn?,sourceOut?,locked?}, remove_shot, move_shot {shotId,beforeId?}, duplicate_shot, split_shot {shotId,at}. Also, as in Studio\'s '
        + 'director vocabulary: set_scene_event/remove_scene_event, align_camera_clip, camera_composition, camera_keyframe, camera_photography, '
        + 'camera_micro_motion, camera_stroke, object_stroke, camera_preset_clip, camera_preset, edit_camera_motion_clip, edit_motion_clip, set_look_clip/'
        + 'edit_look_clip, set_action_clip/edit_action_clip/extract_hold_actions, light/lighting/lighting_preset, set_character_height, calibrate_asset, '
        + 'set_spatial_profile, import_asset/import_animation/relink_asset (source.url must be the film\'s /api/projects/<id>/raw/<path>, bytes are verified). '
        + 'dryRun:true compiles and checks without writing. Every answer carries the result\'s diagnostics: read them before calling it done. Pass the '
        + 'fingerprint you last read (director_query events/actions or a previous stage) as expectedFingerprint, for dryRun and apply alike, so a scene edited '
        + 'in between is refused, not overwritten. The staged project comes back only with includeProject:true (or for an inline directorProject).',
      parameters: {
        plan: { type: 'object', required: true, additionalProperties: true, description: '{ ops: [...] } as described.' },
        nodeId,
        directorProject,
        dryRun: { type: 'boolean' },
        expectedFingerprint: { type: 'string' },
        includeProject: { type: 'boolean' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const answer = await onBoard(exec, args, '/api/director/stage', defined(args, ['plan', 'dryRun', 'expectedFingerprint', 'includeProject']))
        const keep = args.includeProject === true || args.directorProject !== undefined
        const { project, ...rest } = answer
        return plain({ ...rest, diagnostics: capped(rest.diagnostics), ...(keep && project !== undefined ? { project } : {}) })
      },
    }),
    defineTool({
      name: 'director_render',
      description: 'Render what a director-desk scene looks like into the film, through the desk open in the 导演 tab (ask the person to open it if the '
        + 'call says it is not). frames: [{shotId?,cameraId?,at?:scene seconds,position?:first|current|last,fileName?}] — clean frames. sheet: true or '
        + '{moment?:start|middle|end,cameraIds?,sequence?} — a contact sheet of every shot\'s opening, the way to check a staging at a glance. video: true or '
        + '{sequence?,shotId?,cameraId?,fps?:24|30|60} — an MP4 reference that carries the camera move into a generation. Each file lands on the board as a '
        + 'node wired from the director node; the answer gives workspacePath (look at it with read_image) and nodeId (wire it into a generation with '
        + 'canvas_connect_nodes or referenceNodeIds). Waits until done (videos take as long as they play); no paid model is called.',
      parameters: {
        nodeId,
        frames: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              shotId: { type: 'string' }, cameraId: { type: 'string' }, at: { type: 'number' },
              position: { type: 'string', enum: ['first', 'current', 'last'] }, fileName: { type: 'string' },
            },
          },
        },
        sheet: { oneOf: [{ type: 'boolean' }, { type: 'object', additionalProperties: true }] },
        video: { oneOf: [{ type: 'boolean' }, { type: 'object', additionalProperties: true }] },
        quality: { type: 'string', enum: ['720p', '1080p'] },
        expectedFingerprint: { type: 'string' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const answer = await onBoard(exec, args, '/api/director/render', defined(args, ['frames', 'sheet', 'video', 'quality', 'expectedFingerprint']))
        const files = Array.isArray(answer.files) ? answer.files.map(withWorkspacePath) : []
        const look = files.find((file): file is Record<string, unknown> => isRecord(file) && file.kind !== 'video' && typeof file.workspacePath === 'string')
        return plain({ ...answer, files, ...(look ? { next: `read_image { file_path: "${String(look.workspacePath)}" } shows the first of these; look before calling the staging done.` } : {}) })
      },
    }),
    defineTool({
      name: 'director_render_status',
      description: 'Read the desk\'s current output job (person- or agent-started): phase, progress, saved result count, terminal error. task:null means '
        + 'none. Needs the desk open in the 导演 tab.',
      parameters: { nodeId },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => plain(await onBoard(exec, args, '/api/director/render/status', {})),
    }),
    defineTool({
      name: 'director_render_cancel',
      description: 'Cancel the exact output job director_render_status reported. Saved results stay in the film and on the board; saving cannot be '
        + 'interrupted. Poll status until cancelled before retrying.',
      parameters: {
        nodeId,
        jobId: { type: 'string', required: true, description: 'The jobId from director_render_status; never a previous job\'s.' },
      },
      output: jsonOutput,
      execute: async (args, exec) => plain(await onBoard(exec, args, '/api/director/render/cancel', { jobId: args.jobId })),
    }),
    defineTool({
      name: 'director_inspect_model',
      description: 'Extract wall/floor/ceiling candidates from a static scene or prop model placed in the scene, from the geometry the open desk has loaded '
        + '(the 导演 tab must show the desk with the model). Metadata, name guesses and bare bounds are labelled; unknown parts and single treads need '
        + 'review. Changes nothing: review the candidates and the proposed plan, then director_stage it with dryRun and the ORIGINAL returned fingerprint. '
        + 'Saved spatial profiles are readable with director_query structure even with the desk closed.',
      parameters: {
        nodeId,
        objectId: { type: 'string', required: true },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => plain(await onBoard(exec, args, '/api/director/inspect-model', { objectId: args.objectId })),
    }),
    defineTool({
      name: 'director_review',
      description: 'Versioned director review, shared with the canvas\'s review panel. list/get read records (get includeProject:true returns the frozen '
        + 'scene). create (expectedFingerprint; name?, video?, quality?, fps?) freezes the current takes and scene and renders per-shot frames, an ordered '
        + 'contact sheet and optionally a video through the open desk. comment {versionId,expectedRevision,text,shotId?,at? in SOURCE seconds}; resolve '
        + '{commentId,resolved}; confirm {expectedRevision,expectedFingerprint} needs an unchanged scene and media and no open comments — only after the '
        + 'person explicitly accepts that exact version, never on your own check; reopen. Every change to a version quotes its expectedRevision. handoff '
        + '{target:generation,filePath,mode:image|video,prompt,model?,operationId,dryRun,expectedRevision,expectedFingerprint} on an approved version stages '
        + 'a generation flow on the board (never runs it); keep operationId on retries. Nothing here pays for a generation.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'get', 'create', 'comment', 'resolve', 'confirm', 'reopen', 'handoff'] },
        nodeId,
        versionId: { type: 'string' },
        expectedRevision: { type: 'integer' },
        expectedFingerprint: { type: 'string' },
        name: { type: 'string' },
        text: { type: 'string' },
        shotId: { type: 'string' },
        at: { type: 'number' },
        commentId: { type: 'string' },
        resolved: { type: 'boolean' },
        includeProject: { type: 'boolean' },
        target: { type: 'string', enum: ['generation', 'timeline'] },
        operationId: { type: 'string' },
        dryRun: { type: 'boolean' },
        mode: { type: 'string', enum: ['image', 'video', 'append', 'replace'] },
        filePath: { type: 'string', description: 'A file of the version, as its files[].path lists it.' },
        prompt: { type: 'string' },
        model: { type: 'string' },
        baseRevision: { type: 'integer' },
        video: { type: 'boolean' },
        quality: { type: 'string', enum: ['720p', '1080p'] },
        fps: { type: 'integer', enum: [24, 30, 60] },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const command = defined(args, ['action', 'versionId', 'expectedRevision', 'expectedFingerprint', 'name', 'text', 'shotId', 'at', 'commentId', 'resolved',
          'includeProject', 'target', 'operationId', 'dryRun', 'mode', 'filePath', 'prompt', 'model', 'baseRevision', 'video', 'quality', 'fps'])
        const answer = await onBoard(exec, args, '/api/director/review', command)
        const versions = Array.isArray(answer.versions)
          ? answer.versions.map(version => isRecord(version) && Array.isArray(version.files) ? { ...version, files: version.files.map(withWorkspacePath) } : version)
          : answer.versions
        return plain({ ...answer, versions })
      },
    }),
    defineTool({
      name: 'director_compile_motion',
      description: 'Compile declarative keyframe motion into a skeletal animation (CPU, no model call): a GLB, spec and report under film/motions/, and an '
        + 'importPlan for director_stage (nothing in the scene changes by itself: query the fingerprint, dry-run the import plus set_action_clip, apply, '
        + 'preview). requestId is idempotent for the same spec; a revision needs a new id. spec: {schemaVersion:1,name,duration .1–30,fps 15–60,joints:'
        + '{Bone:[{at,degrees:[x,y,z]}]} with keys covering 0..duration (2–128 each), interpolation?:smooth|continuous, stop?, hips?, bodyOffset?, feet?, '
        + 'hands?, handPoses?}. Metres, Y-up, Z-forward; joints local XYZ degrees on Hips/Spine/Spine2/Neck/Head and Left|Right Arm/ForeArm/Hand/UpLeg/Leg/'
        + 'Foot/ToeBase. Scene travel belongs to the director route. The rig is mixamo-style: it drives imported mixamo-compatible characters, not the '
        + 'built-in mannequin. Compiling proves nothing about how it looks: review it on the actual skeleton.',
      parameters: {
        requestId: { type: 'string', required: true, description: '1–120 of A–Z a–z 0–9 _ -.' },
        spec: { type: 'object', required: true, additionalProperties: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        return plain(await post(exec, `/api/projects/${segment(film.projectId)}/director/motions`, { requestId: args.requestId, spec: args.spec }))
      },
    }),
    defineTool({
      name: 'director_modeling_brief',
      description: 'Prepare an img2threejs modeling brief for a director target (the desk\'s node and the selected objects). Runs no model and charges '
        + 'nothing: read the returned prompt and carry the task out in this conversation.',
      parameters: {
        ...briefParameters,
        context: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description: 'The director target.',
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
      isConcurrencySafe: () => true,
      execute: (args, exec) => brief(exec, args, { objectIds: [], ...args.context }),
    }),
    defineTool({
      name: 'model_brief',
      description: 'Prepare a film-owned img2threejs modeling task; no director desk is needed. Returns the brief to this conversation for staged creation, '
        + 'preview and visual review; it runs no code and starts no other agent.',
      parameters: briefParameters,
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute: (args, exec) => brief(exec, args),
    }),
  ]
}
