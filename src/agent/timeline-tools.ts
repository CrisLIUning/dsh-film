/**
 * The editing desk's tools (Studio's `timeline_query` and `timeline_edit`,
 * apps/daemon/src/mcp.ts) over the film's cut in `film/canvas/timeline.json`.
 * Both call the timeline API the editing desk uses, so every write quotes the
 * revision it was built on and an open desk sees the new cut.
 * @module dsh-film/agent/timeline-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { FilmToolError, callStudio } from './studio-client.js'
import { filmPathFor, filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices } from './context.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * A cut as the agent reads it: the revision every write quotes, the frame,
 * and each track's clips with real ids — not the document, whose keyframes,
 * caption styles and integrity records nothing here decides from.
 * @param state - the stored cut.
 * @returns the summary.
 */
export function summariseCut(state: Record<string, unknown>): Record<string, unknown> {
  const root = isRecord(state.document) ? state.document : null
  const project = root !== null && isRecord(root.project) ? root.project : null
  const revision = typeof state.revision === 'number' ? state.revision : 0
  if (project === null) return { revision, empty: true, note: 'This film has no cut yet.' }
  const clips = (key: string, extra?: (clip: Record<string, unknown>) => Record<string, unknown>): Array<Record<string, unknown>> => {
    const list = project[key]
    if (!Array.isArray(list)) return []
    let visualStart = 0
    return list.flatMap((raw) => {
      if (!isRecord(raw)) return []
      const clip = raw
      const duration = key === 'captionSegments'
        ? Math.max(0, Number(clip.end) - Number(clip.start)) || 0
        : typeof clip.duration === 'number' ? clip.duration : 0
      // Visual clips play one after another and carry no start of their own.
      const start = key === 'visualSegments' ? visualStart : typeof clip.start === 'number' ? clip.start : 0
      if (key === 'visualSegments') visualStart += duration
      const integrity = isRecord(clip.integrity) ? clip.integrity : null
      const path = typeof integrity?.archivePath === 'string' ? integrity.archivePath : null
      return [{
        id: clip.id,
        ...(clip.name !== undefined && clip.name !== '' ? { name: clip.name } : {}),
        start,
        ...(key === 'captionSegments' ? { end: start + duration } : {}),
        duration,
        ...(path !== null ? { path } : {}),
        ...(extra !== undefined ? extra(clip) : {}),
      }]
    })
  }
  return {
    revision,
    canUndo: state.canUndo === true,
    canRedo: state.canRedo === true,
    ratioId: project.ratioId ?? '16:9',
    ...(project.selectedFilterId !== undefined && project.selectedFilterId !== null ? { filterId: project.selectedFilterId } : {}),
    ...(typeof project.targetLoudnessLufs === 'number' ? { targetLoudnessLufs: project.targetLoudnessLufs } : {}),
    visuals: clips('visualSegments', clip => ({
      ...(clip.type !== undefined ? { type: clip.type } : {}),
      ...(clip.director !== undefined ? { director: clip.director } : {}),
      ...(clip.colorGrade !== undefined && clip.colorGrade !== null ? { graded: true } : {}),
      ...(clip.filterId !== undefined && clip.filterId !== null ? { filterId: clip.filterId } : {}),
    })),
    captions: clips('captionSegments', clip => ({
      ...(typeof clip.text === 'string' ? { text: clip.text } : {}),
      ...(clip.audioSegmentId !== undefined ? { audioSegmentId: clip.audioSegmentId } : {}),
    })),
    audio: clips('audioSegments'),
    music: clips('musicSegments'),
    overlays: clips('visualOverlaySegments'),
  }
}

/** How many film files and workspace files `timeline_query` kind=material lists. */
const MATERIAL_ITEMS = 200

/**
 * The film's media and the workspace's media not in the film yet, from the
 * editing desk's material listing, each list cut to {@link MATERIAL_ITEMS}.
 * @param material - the material route's answer.
 * @returns the summary.
 */
export function summariseMaterial(material: Record<string, unknown>): Record<string, unknown> {
  const list = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value.filter(isRecord) : []
  const film = list(material.assets).map(asset => ({
    path: typeof asset.assetId === 'string' ? asset.assetId.replace(/^canvas-file:/u, '') : asset.name,
    kind: asset.kind,
    ...(typeof asset.sizeBytes === 'number' ? { sizeBytes: asset.sizeBytes } : {}),
  }))
  const workspace = list(material.projectFiles).map(file => ({
    path: file.path,
    kind: file.kind,
    ...(typeof file.sizeBytes === 'number' ? { sizeBytes: file.sizeBytes } : {}),
  }))
  return {
    film: film.slice(0, MATERIAL_ITEMS),
    workspace: workspace.slice(0, MATERIAL_ITEMS),
    truncated: material.truncated === true || film.length > MATERIAL_ITEMS || workspace.length > MATERIAL_ITEMS,
  }
}

/** An edit's answer without the two whole cuts (`before`, `after`) it carries; `changes` is the diff. */
function withoutFullDocuments(answer: Record<string, unknown>): Record<string, unknown> {
  const result = isRecord(answer.result) ? answer.result : null
  if (result === null) return answer
  const { before: _before, after: _after, ...kept } = result
  return { ...answer, result: kept }
}

const EDITS = ['place', 'sound', 'version', 'operations'] as const

/**
 * Build the timeline tools.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function timelineTools(services: FilmToolServices): ToolDefinition[] {
  return [
    defineTool({
      name: 'timeline_query',
      description: 'Read the film\'s cut — what the editing desk (剪辑 tab) is editing it into. kind=cut (default): the revision every write must quote, the frame, '
        + 'the loudness target, and each track\'s clips with their id, name, start, seconds and the file each plays. kind=board: what the board offers the cut '
        + 'but has not given it yet — its media nodes and the scripts (the 剧本 tab\'s screenplays with dialogue, and text nodes that read as scripts). Read '
        + 'before writing: clip ids are real ids, never names invented from a file. kind=material: the film\'s media files (path relative to film/) and '
        + 'the workspace\'s own media not in the film yet (path relative to the workspace, outside film/), newest first, at most 200 of each — either path '
        + 'goes into place/version (or a sound item\'s file) as is. kind=caption-tasks: the cut\'s latest original-audio recognitions (timeline_transcribe) with '
        + 'status, engine and '
        + 'whether each draft is applied; read a draft with media_get_task.',
      parameters: {
        kind: { type: 'string', enum: ['cut', 'board', 'material', 'caption-tasks'] },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        const base = `/api/canvas/timelines/${segment(film.boardId)}`
        const query = `?project=${segment(film.projectId)}`
        if (args.kind === 'caption-tasks') return plain(await callStudio(services.studio, film.cwd, { method: 'GET', path: `${base}/captions/tasks${query}` }, exec.signal))
        if (args.kind === 'material') return plain(summariseMaterial(await callStudio(services.studio, film.cwd, { method: 'GET', path: `${base}/material${query}` }, exec.signal)))
        if (args.kind === 'board') {
          const [media, scripts] = await Promise.all([
            callStudio(services.studio, film.cwd, { method: 'GET', path: `${base}/media${query}` }, exec.signal).catch((error: unknown) => {
              // A board that was never opened has no document yet: it offers nothing.
              if (error instanceof FilmToolError && error.code === 'CANVAS_DOCUMENT_NOT_FOUND') return { media: [] }
              throw error
            }),
            callStudio(services.studio, film.cwd, { method: 'GET', path: `${base}/scripts${query}` }, exec.signal),
          ])
          return plain({ media: media.media, scripts: scripts.scripts })
        }
        return plain(summariseCut(await callStudio(services.studio, film.cwd, { method: 'GET', path: `${base}${query}` }, exec.signal)))
      },
    }),
    defineTool({
      name: 'timeline_edit',
      description: 'Change the film\'s cut. Every write quotes baseRevision from timeline_query and is refused if the cut moved on; dryRun:true reports the same '
        + 'diff and leaves the cut unchanged (a workspace file it names is still copied into the film, once — see below). Give exactly one of: place '
        + '{nodeId|path, track?: visuals|audio|music, at?: seconds (audio lanes only — the visual track plays '
        + 'its clips one after another), durationSeconds?, name?} puts one piece of the board\'s material on the cut — or a file: relative to film/, or any '
        + 'media file of the workspace relative to it (copied into the film first, once, on a dryRun too; the apply reuses that copy); sound {script?: '
        + '{storyDocumentId|nodeId|text}, items?: [{kind: speech|sfx|music, text?, speaker?, file?, shotId?, at?, volume?}], loudness?} puts lines, effects and '
        + 'one music bed on the shots — a screenplay or script becomes one caption per line, a line with a file lands on the voice track under its caption; '
        + 'a file is named like place\'s path; '
        + 'version {clipId, nodeId|path, name?} gives one slot a different take, keeping its id, place, length and grade; operations is the raw command plan '
        + '(asset.place_version, visual.trim, color.set, filter.set, caption.add, clip.delete, project.set_ratio, audio.set_loudness …) for anything else. Each '
        + 'operation id applies once ever, so a new intent needs new ids.',
      parameters: {
        baseRevision: { type: 'integer', description: 'The revision you read. Required unless dryRun.' },
        dryRun: { type: 'boolean' },
        operationId: { type: 'string', description: 'Names this edit; reusing one makes the write a no-op.' },
        place: { type: 'object', additionalProperties: true, description: 'One piece of board material onto the cut.' },
        sound: { type: 'object', additionalProperties: true, description: 'Lines, effects and music on the shots.' },
        version: { type: 'object', additionalProperties: true, description: 'A different take for one slot, keeping the slot.' },
        operations: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'A raw command plan of 1–64 operations.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const chosen = EDITS.filter(key => args[key] !== undefined)
        if (chosen.length !== 1) throw new FilmToolError('TIMELINE_EDIT_INVALID', 'Give exactly one of place, sound, version or operations.')
        const dryRun = args.dryRun === true
        if (!dryRun && args.baseRevision === undefined) throw new FilmToolError('TIMELINE_EDIT_INVALID', 'A write quotes the baseRevision you read (timeline_query); a dryRun does not need one.')
        const film = await filmWorkspace(exec)
        const kind = chosen[0]!
        const operationId = args.operationId !== undefined && args.operationId !== '' ? args.operationId : `agent-${kind}-${Date.now().toString(36)}`
        const common = { dryRun, operationId, ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}) }
        let planBase = args.baseRevision
        if (kind === 'operations' && planBase === undefined) {
          // A dry run of a raw plan still names a base: the current one.
          const current = await callStudio(services.studio, film.cwd, { method: 'GET', path: `/api/canvas/timelines/${segment(film.boardId)}?project=${segment(film.projectId)}` }, exec.signal)
          planBase = typeof current.revision === 'number' ? current.revision : 0
        }
        /** A file the agent named, as the film-relative path the routes take (a workspace file is copied into the film first). */
        const filmPath = (path: string): Promise<string> =>
          filmPathFor(film, path, { studio: services.studio, signal: exec.signal, failureCode: 'TIMELINE_MEDIA_IMPORT_FAILED' })
        /** A placement's source from the tool's shape: a board node, or a file. */
        const sourceOf = async (input: unknown): Promise<Record<string, unknown>> => {
          const value = isRecord(input) ? input : {}
          if (typeof value.nodeId === 'string' && value.nodeId !== '') return { nodeId: value.nodeId }
          if (typeof value.path !== 'string') return { path: value.path }
          return { path: await filmPath(value.path) }
        }
        /** Sound items with each file named the same ways as place's path; anything else goes to the route as it is, to be refused there. */
        const soundOf = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
          if (!Array.isArray(input.items)) return input
          const items = await Promise.all(input.items.map(async (item: unknown) =>
            isRecord(item) && typeof item.file === 'string' && item.file.trim() !== '' ? { ...item, file: await filmPath(item.file) } : item))
          return { ...input, items }
        }
        const body = kind === 'operations'
          ? { schemaVersion: 1, operationId, dryRun, plan: { schemaVersion: 1, baseRevision: planBase, operations: args.operations } }
          : kind === 'place'
            ? { ...common, ...args.place, source: await sourceOf(args.place) }
            : kind === 'version'
              ? { ...common, ...args.version, source: await sourceOf(args.version) }
              : { ...common, ...await soundOf(args.sound ?? {}) }
        const path = `/api/canvas/timelines/${segment(film.boardId)}/${kind === 'operations' ? 'commands' : kind}?project=${segment(film.projectId)}`
        return plain(withoutFullDocuments(await callStudio(services.studio, film.cwd, { method: 'POST', path, body }, exec.signal)))
      },
    }),
  ]
}
