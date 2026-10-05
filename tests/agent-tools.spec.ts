/** The agent's film tools, called the way the agent loop calls them, against a real workspace. */

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filmAgentTools, filmCoreTools, filmToolGroups, filmToolsTool } from '../src/agent/index.js'
import type { FilmToolServices } from '../src/agent/index.js'
import { FILM_GUIDANCE } from '../src/agent/guidance.js'
import { GUIDANCE_SECTION, installFilmAgentTools } from '../src/agent/install.js'
import { buildModelingBrief } from '../src/modeling/contracts/modeling-brief.js'
import { filmProjectTool } from '../src/agent/project-tool.js'
import { compactTask } from '../src/agent/media-task-tools.js'
import { CanvasBoardAgent } from '../src/canvas/board-agent.js'
import type { BoardLease, BoardTarget } from '../src/canvas/board-agent.js'
import { applyBoardOps } from '../src/canvas/board-ops.js'
import type { BoardOp, BoardSnapshot } from '../src/canvas/board-ops.js'
import { FilmMediaTasks } from '../src/media/tasks.js'
import { createStudioRouter } from '../src/routes.js'
import { ProjectEvents } from '../src/studio/events.js'
import type { ProjectEvent } from '../src/studio/events.js'
import type { EventStream } from '../src/studio/sse.js'

let cwd: string
let events: ProjectEvents
let boardAgent: CanvasBoardAgent
let tasks: FilmMediaTasks
let services: FilmToolServices
let created: string[]
let tools: Map<string, ToolDefinition>

/** The canvas build's catalogues (copies of canvas web/src/lib/canvas/catalog/*.json; the local apps/ is older). */
const catalogRoot = join(import.meta.dirname, 'fixtures', 'catalog')

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-agent-'))
  events = new ProjectEvents()
  boardAgent = new CanvasBoardAgent()
  tasks = new FilmMediaTasks(() => undefined)
  created = []
  services = { studio: createStudioRouter({ events, boardAgent, tasks }), boardAgent, events, projectCreated: (dir) => { created.push(dir) }, catalogRoot }
  tools = new Map([filmProjectTool(services), ...filmAgentTools(services)].map(tool => [tool.name, tool]))
})

afterEach(async () => {
  // Task records are saved in the background (reading an old running task saves it as interrupted): let them land
  // before the folder goes, and give Windows a moment when something still holds a file in film/.tasks (EBUSY).
  tasks.dispose()
  await tasks.settled()
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function exec(folder: string | undefined = cwd): ToolRunContext {
  return {
    agent: { session: { header: { cwd: folder } } },
    signal: new AbortController().signal,
    callId: 'call-1', rootCallId: 'call-1', name: 'test', arguments: {}, token: Symbol('call'),
    deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext
}

const execFor = (folder: string): ToolRunContext => exec(folder)
const modelingToolCount = 7

async function run(name: string, args: Record<string, unknown> = {}, folder?: string): Promise<any> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool.execute(args, exec(folder ?? cwd))
}

async function startFilm(): Promise<{ id: string; title: string }> {
  return (await run('film_project', { action: 'create', title: '雨夜来客' })).project
}

const savedBoard = async (): Promise<any> => JSON.parse(await readFile(join(cwd, 'film', 'canvas', 'document.json'), 'utf8'))

describe('the tool set', () => {
  it('defines every tool once, with schemas the registry accepts', () => {
    expect([...tools.keys()]).toEqual([
      'film_project',
      'story_query', 'story_asset_bindings', 'story_create', 'story_apply_ops', 'story_history', 'story_checkpoint', 'story_restore', 'story_revert',
      'story_import', 'story_export',
      'story_source', 'story_handoff', 'story_adopt', 'story_impact', 'story_director_links',
      'canvas_list_clients', 'canvas_get_state', 'canvas_get_selection', 'canvas_read_node', 'canvas_get_generation_status', 'canvas_get_document',
      'canvas_create_text_nodes', 'canvas_create_generation_flow', 'canvas_generation_options', 'canvas_set_generation_options',
      'canvas_run_generation', 'canvas_connect_nodes', 'canvas_delete_nodes', 'canvas_apply_ops', 'canvas_attach_media',
      'media_get_task', 'media_cancel_task',
      'director_query', 'director_models', 'director_stage', 'director_render', 'director_render_status', 'director_render_cancel', 'director_inspect_model', 'director_review', 'director_compile_motion', 'director_modeling_brief',
      'space_plan_compile', 'model_brief', 'model_review', 'model_adopt', 'model_status', 'model_report', 'model_cancel',
      'video_clip', 'video_split', 'video_render_clip', 'video_join', 'video_extract_audio',
    ])
    for (const tool of tools.values()) {
      expect(tool.parameters).toMatchObject({ type: 'object' })
      expect(tool.description.length).toBeGreaterThan(40)
    }
  })

  it('carries 32 core tools and none of the cut tools 0.2.0 removed', () => {
    const core = filmCoreTools(services).map(tool => tool.name)
    expect(core).toHaveLength(32)
    expect(core).toEqual(expect.arrayContaining(['media_get_task', 'media_cancel_task', 'canvas_generation_options', 'canvas_set_generation_options']))
    // Narrowed in 0.3 to the removed tools: the video_* cutting tools are new, and their texts
    // still never name the removed desk, recognition or render engine.
    const removed = ['timeline_query', 'timeline_edit', 'timeline_transcribe', 'timeline_apply_captions', 'timeline_render']
    for (const name of removed) expect(tools.has(name), name).toBe(false)
    const texts = [...[...tools.values()].map(tool => `${tool.name}: ${tool.description}`), `FILM_GUIDANCE: ${FILM_GUIDANCE}`]
    for (const text of texts) {
      for (const name of removed) expect(text, text.slice(0, 60)).not.toContain(name)
      expect(text, text.slice(0, 60)).not.toMatch(/剪辑台|editing desk|caption|ffmpeg|timeline_/iu)
    }
    // A review is handed on to generation only.
    const review = tools.get('director_review')!.parameters as { properties: Record<string, { enum?: unknown[] }> }
    expect(review.properties.target?.enum).toEqual(['generation'])
    expect(review.properties.mode?.enum).toEqual(['image', 'video'])
    expect(review.properties.baseRevision).toBeUndefined()
  })

  it('declares the generation-option schemas of C11 and teaches them as node settings, never prompt text', () => {
    const schema = (name: string): any => tools.get(name)!.parameters
    const set = schema('canvas_set_generation_options')
    expect(Object.keys(set.properties)).toEqual(['target', 'nodeIds', 'cameraMove', 'cameraControl', 'preset', 'clear'])
    expect(set.required).toEqual(['nodeIds'])
    expect(set.properties.cameraMove.required).toEqual(['moves'])
    expect(set.properties.cameraMove.properties.moves.items.properties.speed.enum).toEqual(['slow', 'steady', 'fast'])
    expect(set.properties.cameraMove.properties.combine.enum).toEqual(['sequence', 'together'])
    expect(Object.keys(set.properties.cameraControl.properties)).toEqual(['enabled', 'look', 'lens', 'focalLength', 'aperture', 'shotSize', 'angle'])
    expect(set.properties.cameraControl.properties.shotSize.oneOf.map((branch: any) => branch.type)).toEqual(['string', 'null'])
    expect(set.properties.clear.items.enum).toEqual(['cameraMove', 'cameraControl'])
    expect(Object.keys(schema('canvas_create_generation_flow').properties)).toEqual(expect.arrayContaining(['cameraMove', 'cameraControl', 'preset']))
    expect(schema('canvas_generation_options').properties.kind.enum).toEqual(['camera_moves', 'camera', 'presets'])
    for (const text of ['canvas_generation_options', 'canvas_set_generation_options', 'never write them into prompt text', 'CANVAS_PROMPT_OVER_LIMIT']) expect(FILM_GUIDANCE).toContain(text)
    expect(tools.get('canvas_set_generation_options')!.description).toContain('never write them into prompt text')
  })

  it('puts director_models in the director group and teaches director_stage place_model', () => {
    const director = filmToolGroups(services).director!.tools().map(tool => tool.name)
    expect(director).toContain('director_models')
    expect(filmCoreTools(services).map(tool => tool.name)).not.toContain('director_models')
    expect(tools.get('director_models')!.isConcurrencySafe?.({} as never)).toBe(true)
    const stage = tools.get('director_stage')!.description
    expect(stage).toContain('place_model')
    expect(stage).toContain('director_models')
    expect(FILM_GUIDANCE).toContain('director_models')
  })

  it('keeps the video_* cutting tools in the editing group, and says the film task tools follow them', () => {
    const groups = filmToolGroups(services)
    expect(groups.editing!.tools().map(tool => tool.name)).toEqual(['video_clip', 'video_split', 'video_render_clip', 'video_join', 'video_extract_audio'])
    expect(groups.editing!.description).toMatch(/^Cut, split, render, join and extract the sound of video nodes \(video_\*\)\. Only cutting and joining: no transitions, music or effects\.$/u)
    expect(filmCoreTools(services).map(tool => tool.name).filter(name => name.startsWith('video_'))).toEqual([])
    expect(FILM_GUIDANCE).toContain('### Cutting and joining')
    expect(FILM_GUIDANCE).toContain('VIDEO_JOIN_NEEDS_PAGE')
    expect(FILM_GUIDANCE).toContain('reference limits')
    expect(tools.get('media_get_task')!.description).toContain('video_*')
    expect(tools.get('media_get_task')!.description).toContain('landedNodeId')
    expect(tools.get('media_cancel_task')!.description).toContain('video_*')
    // No subtitle tools yet: the group promises none.
    expect(groups.editing!.description).not.toMatch(/subtitle/u)
  })

  it('promises no skill, preview or desk this workbench does not have', () => {
    const forbidden = ['img2threejs', 'edit-vibedev-timeline', '独立建模预览', '「3D 建模」']
    const texts = [
      ...[...tools.values()].map(tool => `${tool.name}: ${tool.description}`),
      `FILM_GUIDANCE: ${FILM_GUIDANCE}`,
      `brief: ${buildModelingBrief({ kind: 'prop', description: '铜壶' }, 'p1').prompt}`,
      `director brief: ${buildModelingBrief({ kind: 'prop', description: '铜壶', context: { projectId: 'p1', boardId: 'p1', view: 'director', director: { nodeId: 'd', objectIds: [] } } }, 'p1').prompt}`,
    ]
    for (const text of texts) {
      for (const word of forbidden) expect(text, text.slice(0, 60)).not.toContain(word)
    }
    expect(buildModelingBrief({ kind: 'prop', description: '铜壶' }, 'p1').skillIds).toEqual([])
  })

  it('refuses arguments that do not match the schema before running', async () => {
    await startFilm()
    await expect(run('story_apply_ops', { documentId: 'doc_1', operations: [] })).rejects.toThrow(/expectedRevision/)
  })
})

describe('film_project', () => {
  it('reads the workspace\'s film and starts one once, offering the film tools whenever a film is there', async () => {
    expect(await run('film_project', { action: 'status' })).toEqual({ project: null, note: 'This workspace has no film project.' })
    expect(created).toEqual([])
    const made = await run('film_project', { action: 'create', title: '雨夜来客', aspectRatio: '9:16' })
    expect(made).toMatchObject({ created: true, project: { title: '雨夜来客', aspectRatio: '9:16' } })
    expect(created).toEqual([cwd])
    // A conversation that missed the creation still gets its tools from create or status.
    expect(await run('film_project', { action: 'create', title: '别的' })).toMatchObject({ created: false, project: { title: '雨夜来客' } })
    expect(created).toEqual([cwd, cwd])
    expect((await run('film_project', { action: 'status' })).project.id).toBe(made.project.id)
    expect(created).toEqual([cwd, cwd, cwd])
  })

  it('names a new film after its folder when no title is given', async () => {
    const folder = join(cwd, '短片计划')
    await mkdir(folder)
    expect((await run('film_project', { action: 'create' }, folder)).project.title).toBe('短片计划')
  })

  it('leaves the other tools to a workspace with a film', async () => {
    await expect(run('story_query')).rejects.toThrow(/FILM_NO_PROJECT/)
    await expect(run('canvas_get_state')).rejects.toThrow(/FILM_NO_PROJECT/)
  })

  it('creates the film with its empty board', async () => {
    const made = await run('film_project', { action: 'create' })
    expect(await savedBoard()).toMatchObject({ id: made.project.id, nodes: [], connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 } })
  })

  it('renames the film and changes its frame, announcing the change', async () => {
    await expect(run('film_project', { action: 'update', title: '新名字' })).rejects.toThrow(/^PROJECT_NOT_FOUND: /u)
    const made = (await run('film_project', { action: 'create', title: '雨夜来客' })).project
    const seen: ProjectEvent[] = []
    events.subscribe(cwd, (event) => { seen.push(event) })
    created.length = 0
    const renamed = await run('film_project', { action: 'update', title: '修表铺', aspectRatio: '21:9' })
    expect(renamed).toMatchObject({ changed: true, project: { id: made.id, title: '修表铺', aspectRatio: '21:9' } })
    expect(seen).toEqual([{ type: 'project-changed', projectId: made.id, project: renamed.project }])
    expect(created).toEqual([cwd])
    expect(await run('film_project', { action: 'update', title: '修表铺' })).toMatchObject({ changed: false })
    expect(seen).toHaveLength(1)
    await expect(run('film_project', { action: 'update' })).rejects.toThrow(/^BAD_REQUEST: Give a title/u)
    await expect(run('film_project', { action: 'update', title: '   ' })).rejects.toThrow(/BAD_REQUEST/)
  })
})

describe('screenplay tools', () => {
  it('create, read, preview, apply, name, revert — through the screenwriter\'s revisions', async () => {
    await startFilm()
    const seen: ProjectEvent[] = []
    events.subscribe(cwd, (event) => { seen.push(event) })
    const made = await run('story_create', { title: '第一集' })
    expect(made).toMatchObject({ changed: true, document: { title: '第一集', kind: 'short', filePath: expect.stringMatching(/^film\/story\/doc_.+\.md$/u) } })
    const { documentId, revision } = made.document as { documentId: string; revision: string }
    expect(revision).toMatch(/^[a-f0-9]{64}$/u)
    expect((await run('story_query')).documents).toEqual([expect.objectContaining({ documentId, title: '第一集' })])
    expect(await run('story_query', { documentId })).toMatchObject({ documentId, revision, kind: 'index' })

    const operations = [{ kind: 'appendBlock', block: { id: 'block_open', kind: 'action', markdown: '雨夜，客栈的门被推开。\n' } }]
    const preview = await run('story_apply_ops', { documentId, expectedRevision: revision, operations, dryRun: true, operationId: 'op_open' })
    expect(preview).toMatchObject({ changed: true, dryRun: true, changedIds: ['block_open'], preview: [{ id: 'block_open', kind: 'action', markdown: expect.stringContaining('客栈') }] })
    expect((await run('story_query', { documentId })).revision).toBe(revision)

    const applied = await run('story_apply_ops', { documentId, expectedRevision: revision, operations, operationId: 'op_open' })
    expect(applied).toMatchObject({ changed: true, operationId: 'op_open', changedIds: ['block_open'] })
    const next = applied.document.revision as string
    expect(next).not.toBe(revision)
    expect(seen).toContainEqual({ type: 'story-changed', documentId, revision: next })
    // The same request again is answered, not applied twice.
    expect(await run('story_apply_ops', { documentId, expectedRevision: revision, operations, operationId: 'op_open' })).toMatchObject({ changed: false })
    await expect(run('story_apply_ops', { documentId, expectedRevision: revision, operations: [{ kind: 'appendBlock', block: { id: 'block_two', kind: 'action', markdown: '又一段。\n' } }] }))
      .rejects.toThrow(/STORY_CONFLICT.*current revision: [a-f0-9]{64}/u)
    expect((await run('story_query', { documentId, kind: 'content' })).content).toContain('客栈的门被推开')

    expect((await run('story_history', { documentId })).versions.length).toBeGreaterThan(1)
    expect((await run('story_checkpoint', { documentId, expectedRevision: next, label: '初稿' })).version).toMatchObject({ label: '初稿' })
    expect(await run('story_revert', { documentId, expectedRevision: next, operationId: 'op_open' })).toMatchObject({ changed: true })
    expect((await run('story_query', { documentId, kind: 'content' })).content).not.toContain('客栈的门被推开')
  })
})

describe('story_asset_bindings', () => {
  it('lists the film and workspace images, binds by path and digest, resolves and unbinds', async () => {
    await startFilm()
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'face.png'), 'face bytes')
    await mkdir(join(cwd, 'media'), { recursive: true })
    await writeFile(join(cwd, 'media', 'gen.png'), 'generated bytes')
    const made = await run('story_create', { title: '第一集' })
    const { documentId } = made.document as { documentId: string }
    const withPerson = await run('story_apply_ops', {
      documentId, expectedRevision: made.document.revision,
      operations: [{ kind: 'upsertEntity', entity: { id: 'person_lin', kind: 'person', profileBlockId: 'block_lin' }, profileMarkdown: '### 林\n' }],
    })
    const listed = await run('story_asset_bindings', { action: 'list' })
    expect(listed.assets).toEqual([expect.objectContaining({ filePath: 'canvas/media/face.png' })])
    expect(listed.workspaceImages).toEqual([expect.objectContaining({ path: 'media/gen.png' })])
    const face = listed.assets[0] as { filePath: string; sha256: string }
    const bound = await run('story_asset_bindings', {
      action: 'bind', documentId, expectedRevision: withPerson.document.revision,
      binding: { target: { kind: 'entity', id: 'person_lin' }, scope: { kind: 'document' }, purpose: 'appearance', primary: true, filePath: face.filePath, expectedSha256: face.sha256 },
    })
    expect(bound).toMatchObject({ changed: true, bindings: [{ target: { id: 'person_lin' }, primary: true }], assets: [{ projectRelativePath: 'canvas/media/face.png' }] })
    expect(JSON.stringify(bound)).not.toContain('"content"')
    expect((await run('story_asset_bindings', { action: 'references', documentId })).references).toEqual([expect.objectContaining({ status: 'available' })])
    const generated = listed.workspaceImages[0] as { path: string; sha256: string }
    const second = await run('story_asset_bindings', {
      action: 'bind', documentId, expectedRevision: bound.document.revision,
      binding: { target: { kind: 'entity', id: 'person_lin' }, scope: { kind: 'document' }, purpose: 'costume', primary: true, filePath: generated.path, expectedSha256: generated.sha256 },
    })
    expect(second.assets).toEqual([expect.objectContaining({ projectRelativePath: 'canvas/media/gen.png' })])
    const bindingId = (second.bindings as Array<{ id: string }>)[0]!.id
    const removed = await run('story_asset_bindings', { action: 'unbind', documentId, expectedRevision: second.document.revision, bindingId })
    expect(removed.changed).toBe(true)
    await expect(run('story_asset_bindings', { action: 'bind', documentId })).rejects.toThrow(/expectedRevision is required/u)
  })

  it('copies a workspace image once however often a bind is retried, refuses changed bytes before copying, and binds film/media/ in place', async () => {
    await startFilm()
    await mkdir(join(cwd, 'media'), { recursive: true })
    await writeFile(join(cwd, 'media', 'gen.png'), 'generated bytes')
    await writeFile(join(cwd, 'media', 'odd.avif'), 'avif bytes')
    await writeFile(join(cwd, 'media', 'gone.png'), 'gone bytes')
    await mkdir(join(cwd, 'film', 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'media', 'own.png'), 'film-owned bytes')
    const made = await run('story_create', { title: '第一集' })
    const { documentId } = made.document as { documentId: string }
    const withPerson = await run('story_apply_ops', {
      documentId, expectedRevision: made.document.revision,
      operations: [{ kind: 'upsertEntity', entity: { id: 'person_lin', kind: 'person', profileBlockId: 'block_lin' }, profileMarkdown: '### 林\n' }],
    })
    const listed = await run('story_asset_bindings', { action: 'list' })
    // .avif cannot be imported or listed by the canvas, so it is not offered.
    expect((listed.workspaceImages as Array<{ path: string }>).map(image => image.path).sort()).toEqual(['media/gen.png', 'media/gone.png'])
    const generated = (listed.workspaceImages as Array<{ path: string; sha256: string }>).find(image => image.path === 'media/gen.png')!
    const binding = { target: { kind: 'entity', id: 'person_lin' }, scope: { kind: 'document' }, purpose: 'appearance', primary: true, filePath: generated.path, expectedSha256: generated.sha256 }
    // A stale revision fails after the copy; the retry reuses that copy instead of making gen-2.png.
    await expect(run('story_asset_bindings', { action: 'bind', documentId, expectedRevision: 'stale', binding })).rejects.toThrow()
    const bound = await run('story_asset_bindings', { action: 'bind', documentId, expectedRevision: withPerson.document.revision, binding })
    expect(bound.assets).toEqual([expect.objectContaining({ projectRelativePath: 'canvas/media/gen.png' })])
    expect(await readdir(join(cwd, 'film', 'canvas', 'media'))).toEqual(['gen.png'])
    await writeFile(join(cwd, 'media', 'gen.png'), 'edited since the listing')
    await expect(run('story_asset_bindings', { action: 'bind', documentId, expectedRevision: bound.document.revision, binding: { ...binding, purpose: 'costume' } }))
      .rejects.toThrow(/STORY_ASSET_VERSION_MISMATCH/u)
    await expect(run('story_asset_bindings', { action: 'bind', documentId, expectedRevision: bound.document.revision, binding: { ...binding, expectedSha256: 'abc' } }))
      .rejects.toThrow(/64-hex/u)
    expect(await readdir(join(cwd, 'film', 'canvas', 'media'))).toEqual(['gen.png'])
    // A library file under film/media/ is the film's own: bound where it is, not looked for in the workspace.
    const own = (listed.assets as Array<{ filePath: string; sha256: string }>).find(asset => asset.filePath === 'media/own.png')!
    const inPlace = await run('story_asset_bindings', {
      action: 'bind', documentId, expectedRevision: bound.document.revision, binding: { ...binding, purpose: 'identity', filePath: own.filePath, expectedSha256: own.sha256 },
    })
    expect(inPlace.assets).toEqual([expect.objectContaining({ projectRelativePath: 'media/own.png' })])
  })

  it('lists and binds images kept anywhere in the workspace outside film/', async () => {
    await startFilm()
    await mkdir(join(cwd, 'refs', 'cast'), { recursive: true })
    await writeFile(join(cwd, 'refs', 'cast', 'lin.png'), 'lin bytes')
    await mkdir(join(cwd, '.cache'), { recursive: true })
    await writeFile(join(cwd, '.cache', 'thumb.png'), 'thumb')
    const made = await run('story_create', { title: '第一集' })
    const { documentId } = made.document as { documentId: string }
    const withPerson = await run('story_apply_ops', {
      documentId, expectedRevision: made.document.revision,
      operations: [{ kind: 'upsertEntity', entity: { id: 'person_lin', kind: 'person', profileBlockId: 'block_lin' }, profileMarkdown: '### 林\n' }],
    })
    const listed = await run('story_asset_bindings', { action: 'list' })
    expect(listed.workspaceImages).toEqual([expect.objectContaining({ path: 'refs/cast/lin.png', sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) })])
    const image = listed.workspaceImages[0] as { path: string; sha256: string }
    const bound = await run('story_asset_bindings', {
      action: 'bind', documentId, expectedRevision: withPerson.document.revision,
      binding: { target: { kind: 'entity', id: 'person_lin' }, scope: { kind: 'document' }, purpose: 'appearance', primary: true, filePath: image.path, expectedSha256: image.sha256 },
    })
    expect(bound.assets).toEqual([expect.objectContaining({ projectRelativePath: 'canvas/media/lin.png' })])
  })
})

describe('story_import and story_export', () => {
  it('preview, then apply a copy from content or a workspace file; a changed file needs a new preview', async () => {
    await startFilm()
    const made = await run('story_create', { title: '原稿' })
    const { documentId, revision } = made.document as { documentId: string; revision: string }
    const exported = await run('story_export', { documentId, expectedRevision: revision, mode: 'markdown' })
    expect(exported).toMatchObject({ documentId, revision, mode: 'markdown', fileName: '原稿.md', completeRelations: true })
    expect(exported.content).toBe(await readFile(join(cwd, ...String(made.document.filePath).split('/')), 'utf8'))

    const preview = await run('story_import', { action: 'preview', format: 'markdown', content: exported.content })
    expect(preview).toMatchObject({ format: 'native', semanticEditable: true, copy: true, fileCount: 0, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    await expect(run('story_import', { action: 'apply', format: 'markdown', content: exported.content })).rejects.toThrow(/expectedPreviewDigest is required/u)
    const copy = await run('story_import', { action: 'apply', format: 'markdown', content: exported.content, expectedPreviewDigest: preview.digest })
    expect(copy).toMatchObject({ changed: true, document: { title: '原稿', filePath: expect.stringMatching(/^film\/story\/document_.+\.md$/u) } })
    expect(copy.document.documentId).not.toBe(documentId)

    await mkdir(join(cwd, 'notes'))
    await writeFile(join(cwd, 'notes', 'idea.md'), '﻿# 点子\r\n\r\n雨夜，一个人在等车。')
    const filePreview = await run('story_import', { action: 'preview', format: 'markdown', file: 'notes/idea.md' })
    expect(filePreview).toMatchObject({ format: 'plain', content: '﻿# 点子\r\n\r\n雨夜，一个人在等车。' })
    const fromFile = await run('story_import', { action: 'apply', format: 'markdown', file: 'notes\\idea.md', expectedPreviewDigest: filePreview.digest })
    expect(fromFile.changed).toBe(true)
    await writeFile(join(cwd, 'notes', 'idea.md'), '# 改过了')
    await expect(run('story_import', { action: 'apply', format: 'markdown', file: 'notes/idea.md', expectedPreviewDigest: filePreview.digest })).rejects.toThrow(/STORY_IMPORT_PREVIEW_REQUIRED/u)
    expect((await run('story_query')).documents).toHaveLength(3)

    await writeFile(join(cwd, 'notes', 'gbk.md'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
    await expect(run('story_import', { action: 'preview', format: 'markdown', file: 'notes/gbk.md' })).rejects.toThrow(/STORY_PACKAGE_TEXT_ENCODING/u)
    await expect(run('story_import', { action: 'preview', format: 'markdown', file: 'notes/idea.md', content: '# x' })).rejects.toThrow(/STORY_TOOL_INPUT/u)
    await expect(run('story_import', { action: 'preview', format: 'markdown' })).rejects.toThrow(/STORY_TOOL_INPUT/u)
    await expect(run('story_import', { action: 'preview', format: 'markdown', file: '../outside.md' })).rejects.toThrow(/STORY_TOOL_PATH/u)
    await expect(run('story_import', { action: 'preview', format: 'markdown', file: join(cwd, 'notes', 'idea.md') })).rejects.toThrow(/STORY_TOOL_PATH/u)
    await expect(run('story_import', { action: 'preview', format: 'markdown', file: 'notes/absent.md' })).rejects.toThrow(/STORY_TOOL_FILE_NOT_FOUND/u)
  })

  it('never reads or writes through a link that leaves the workspace', async () => {
    await startFilm()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-film-outside-'))
    try {
      await writeFile(join(outside, 'secret.md'), '# 外面的稿')
      await symlink(outside, join(cwd, 'link'), 'junction')
      await expect(run('story_import', { action: 'preview', format: 'markdown', file: 'link/secret.md' })).rejects.toThrow(/STORY_TOOL_PATH.*leaves the workspace/u)
      const made = await run('story_create', { title: '原稿' })
      await expect(run('story_export', { documentId: made.document.documentId, expectedRevision: made.document.revision, mode: 'markdown', outputPath: 'link/out.md' }))
        .rejects.toThrow(/STORY_TOOL_PATH/u)
      await expect(run('story_export', { documentId: made.document.documentId, expectedRevision: made.document.revision, mode: 'markdown', outputPath: 'link/new/out.md' }))
        .rejects.toThrow(/STORY_TOOL_PATH/u)
      expect(await readdir(outside)).toEqual(['secret.md'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('exports text and packages to files, keeps package bytes out of answers, and imports the package elsewhere', async () => {
    await startFilm()
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'face.png'), 'face bytes')
    const made = await run('story_create', { title: '第一集' })
    const { documentId } = made.document as { documentId: string }
    const withPerson = await run('story_apply_ops', {
      documentId, expectedRevision: made.document.revision,
      operations: [{ kind: 'upsertEntity', entity: { id: 'person_lin', kind: 'person', profileBlockId: 'block_lin' }, profileMarkdown: '### 林\n' }],
    })
    const face = (await run('story_asset_bindings', { action: 'list' })).assets[0] as { filePath: string; sha256: string }
    const bound = await run('story_asset_bindings', {
      action: 'bind', documentId, expectedRevision: withPerson.document.revision,
      binding: { target: { kind: 'entity', id: 'person_lin' }, scope: { kind: 'document' }, purpose: 'appearance', primary: true, filePath: face.filePath, expectedSha256: face.sha256 },
    })
    const revision = bound.document.revision as string
    const saved = await readFile(join(cwd, 'film', 'story', `${documentId}.md`), 'utf8')

    const markdown = await run('story_export', { documentId, expectedRevision: revision, mode: 'markdown', outputPath: 'exports/第一集.md' })
    expect(markdown).toMatchObject({ output: 'exports/第一集.md', characters: saved.length, completeRelations: true })
    expect(markdown).not.toHaveProperty('content')
    expect(await readFile(join(cwd, 'exports', '第一集.md'), 'utf8')).toBe(saved)
    await expect(run('story_export', { documentId, expectedRevision: revision, mode: 'markdown', outputPath: 'exports/第一集.md' })).rejects.toThrow(/STORY_EXPORT_EXISTS/u)
    for (const live of ['film/story/copy.md', 'film/canvas/x.zip', process.platform === 'win32' ? 'FILM/.versions/x.md' : 'film/.versions/x.md', 'film/film.json', 'film/story', '../out.md', '/tmp/out.md']) {
      await expect(run('story_export', { documentId, expectedRevision: revision, mode: 'package', outputPath: live }), live).rejects.toThrow(/STORY_TOOL_PATH/u)
    }
    // A refused target is refused before anything is exported.
    await expect(readdir(join(cwd, 'film', 'story-exports'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(run('story_export', { documentId, expectedRevision: 'stale', mode: 'markdown' })).rejects.toThrow(/STORY_CONFLICT.*current revision/u)

    const packaged = await run('story_export', { documentId, expectedRevision: revision, mode: 'package', outputPath: 'exports/第一集.zip' })
    expect(JSON.stringify(packaged)).not.toContain('"content"')
    expect(packaged).toMatchObject({
      mode: 'package', fileName: '第一集.zip', mimeType: 'application/zip', output: 'exports/第一集.zip',
      filePath: expect.stringMatching(new RegExp(`^film/story-exports/${documentId}-.+\\.zip$`, 'u')),
      downloadPath: expect.stringMatching(/^\/api\/projects\/.+\/raw\/story-exports\//u),
      manifest: { complete: true, fileCount: 1, missingCount: 0, files: [{ sha256: face.sha256 }] },
    })
    const zip = await readFile(join(cwd, 'exports', '第一集.zip'))
    expect(zip.subarray(0, 2).toString()).toBe('PK')
    expect(packaged.sizeBytes).toBe(zip.length)
    expect(await readFile(join(cwd, ...String(packaged.filePath).split('/')))).toEqual(zip)

    const preview = await run('story_import', { action: 'preview', format: 'package', file: 'exports/第一集.zip' })
    expect(preview).toMatchObject({ format: 'native', fileCount: 1, manifest: { complete: true } })
    const copy = await run('story_import', { action: 'apply', format: 'package', file: 'exports/第一集.zip', expectedPreviewDigest: preview.digest })
    expect(copy.changed).toBe(true)
    const references = await run('story_asset_bindings', { action: 'references', documentId: copy.document.documentId })
    expect(references.references).toEqual([expect.objectContaining({ status: 'available', resolvedPath: expect.stringMatching(/^story-references\/import_/u) })])
  })

  it('cuts long Markdown in answers and says so', async () => {
    await startFilm()
    const made = await run('story_create', { title: '长稿', content: `# 长稿\n\n${'雨'.repeat(60_000)}` })
    const body = await run('story_export', { documentId: made.document.documentId, expectedRevision: made.document.revision, mode: 'body' })
    expect(body).toMatchObject({ completeRelations: false, contentTruncated: true })
    expect(body.content).toHaveLength(48_000)
    expect(body.totalLength).toBeGreaterThan(60_000)
    const preview = await run('story_import', { action: 'preview', format: 'markdown', content: '雨'.repeat(50_000) })
    expect(preview).toMatchObject({ contentTruncated: true, totalLength: 50_000 })
  })
})

describe('screenplay-to-production tools', () => {
  it('read a source, hand it to the board, adopt into the node with its saved values, read the impact and link a director shot', async () => {
    const project = await startFilm()
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'face.png'), 'face bytes')
    const made = await run('story_create', { title: '第一集' })
    const { documentId } = made.document as { documentId: string }
    const withPerson = await run('story_apply_ops', {
      documentId, expectedRevision: made.document.revision,
      operations: [{ kind: 'upsertEntity', entity: { id: 'person_lin', kind: 'person', profileBlockId: 'block_lin', visualIdentity: '短发' }, profileMarkdown: '### 林\n\n守着灯。' }],
    })
    const face = (await run('story_asset_bindings', { action: 'list' })).assets[0] as { filePath: string; sha256: string }
    const bound = await run('story_asset_bindings', {
      action: 'bind', documentId, expectedRevision: withPerson.document.revision,
      binding: { target: { kind: 'entity', id: 'person_lin' }, scope: { kind: 'document' }, purpose: 'identity', primary: true, filePath: face.filePath, expectedSha256: face.sha256 },
    })
    const revision = bound.document.revision as string

    const source = await run('story_source', { documentId, objectId: 'person_lin' })
    expect(source).toMatchObject({ objectKind: 'entity', revision, productionText: expect.stringContaining('短发'), references: [{ status: 'available', sha256: face.sha256 }] })
    await expect(run('story_source', { documentId, objectId: 'person_lin', scope: { kind: 'scene' } })).rejects.toThrow(/sceneId/u)

    const seen: ProjectEvent[] = []
    events.subscribe(cwd, (event) => { seen.push(event) })
    const handed = await run('story_handoff', { documentId, expectedRevision: revision, objectId: 'person_lin', production: { purpose: 'character-sheet', requestId: 'sheet-lin' } })
    expect(handed).toMatchObject({
      created: true, boardId: project.id, node: { type: 'story-source' },
      productionNode: { type: 'image', metadata: { status: 'idle', promptPurpose: 'character-sheet', count: 1 } },
      preview: { objectId: 'person_lin', revision }, note: expect.stringContaining('Nothing was generated'),
    })
    expect(JSON.stringify(handed)).not.toContain('"markdown"')
    expect(seen.map(event => event.type)).toEqual(['story-canvas-changed', 'story-changed'])
    expect((await savedBoard()).nodes).toHaveLength(2)

    // canvas_get_document gives the exact saved values story_adopt compares.
    const target = (await run('canvas_get_document', { nodeId: handed.productionNode.id })).node
    expect(target.adoptionTarget).toEqual({ prompt: expect.stringContaining('同一角色'), composerContent: expect.stringContaining('同一角色') })
    expect(target.story).toMatchObject({ production: { objectId: 'person_lin', purpose: 'character-sheet', revision }, promptPurpose: 'character-sheet' })
    expect((await run('canvas_get_document', { nodeId: handed.node.id })).node.story).toMatchObject({ source: { documentId, objectId: 'person_lin', revision } })
    await expect(run('story_adopt', { documentId, expectedRevision: revision, objectId: 'person_lin', targetNodeId: handed.productionNode.id, fields: ['prompt'], expectedTarget: { prompt: 'stale' } }))
      .rejects.toThrow(/STORY_TARGET_CONFLICT/u)
    const adopted = await run('story_adopt', { documentId, expectedRevision: revision, objectId: 'person_lin', targetNodeId: handed.productionNode.id, fields: ['prompt', 'references'], expectedTarget: target.adoptionTarget })
    expect(adopted).toMatchObject({
      node: { id: handed.productionNode.id, metadata: { prompt: expect.stringContaining('守着灯'), references: [expect.stringMatching(/\/raw\/canvas\/story-references\/[a-f0-9]{64}\.png$/u)] } },
      adoption: { fields: ['prompt', 'references'], prompt: { revision }, references: { revision } },
    })
    const after = (await run('canvas_get_document', { nodeId: handed.productionNode.id })).node
    expect(after.adoptionTarget.references).toEqual(adopted.node.metadata.references)
    expect(after.story.adoption).toMatchObject({ fields: ['prompt', 'references'], prompt: { revision } })

    const changed = await run('story_apply_ops', { documentId, expectedRevision: revision, operations: [{ kind: 'replaceBlock', blockId: 'block_lin', markdown: '### 林\n\n熄了灯。' }] })
    const impact = await run('story_impact', { documentId })
    expect(impact).toMatchObject({ currentRevision: changed.document.revision, total: 2, truncated: false, counts: { changed: 1, unchanged: 1 } })

    await run('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'desk', nodeType: 'director', title: '导演台', metadata: { directorProject: { version: 15, scene: { backgroundColor: '#000' }, assets: [], objects: [], cameras: [{ id: 'cam', name: '近景' }] } } }] })
    const listed = await run('story_director_links', { action: 'list' })
    expect(listed).toMatchObject({ boardId: project.id, directors: [{ nodeId: 'desk', savedScene: true, shots: [{ directorShotId: 'cam', name: '近景' }], links: {} }] })
    const director = listed.directors[0]
    const link = { objectId: 'person_lin', directorNodeId: 'desk', directorShotId: 'cam', expectedDirectorFingerprint: director.directorFingerprint, expectedLinksFingerprint: director.linksFingerprint }
    await expect(run('story_director_links', { action: 'link', documentId, expectedRevision: changed.document.revision })).rejects.toThrow(/director link object/u)
    const linked = await run('story_director_links', { action: 'link', documentId, expectedRevision: changed.document.revision, link })
    expect(linked).toMatchObject({ changed: true, directorNodeId: 'desk', links: { cam: [{ objectId: 'person_lin', revision: changed.document.revision }] } })
    const unlinked = await run('story_director_links', { action: 'unlink', documentId, expectedRevision: changed.document.revision, link: { ...link, expectedLinksFingerprint: linked.linksFingerprint } })
    expect(unlinked).toMatchObject({ changed: true, links: {} })
  })
})

describe('storyboard tools with no page open', () => {
  it('build, read and change the saved board, and announce each change', async () => {
    const film = await startFilm()
    const seen: ProjectEvent[] = []
    events.subscribe(cwd, (event) => { seen.push(event) })
    // The film came with its empty board.
    expect(await run('canvas_get_state')).toMatchObject({ source: 'persisted', nodes: [], connections: [] })
    expect(await savedBoard()).toMatchObject({ id: film.id, title: '雨夜来客', nodes: [], connections: [], backgroundMode: 'lines', showImageInfo: false })
    expect(await run('canvas_list_clients')).toMatchObject({ boardId: film.id, clients: [], note: 'No storyboard page is open.' })

    const made = await run('canvas_create_text_nodes', { items: [{ text: '第一镜：雨夜门口', title: '镜 1' }, { text: '第二镜：来客进门' }] })
    expect(made).toMatchObject({ source: 'persisted', resultView: 'changes', totalNodeCount: 2, removedNodeIds: [] })
    expect(made.nodes).toHaveLength(2)
    const board = await savedBoard()
    expect(board).toMatchObject({ id: film.id, title: '雨夜来客' })
    expect(board.nodes.map((node: any) => [node.type, node.title, node.metadata.content, node.position])).toEqual([
      ['text', '镜 1', '第一镜：雨夜门口', { x: 0, y: 0 }],
      ['text', '文本', '第二镜：来客进门', { x: 380, y: 0 }],
    ])
    expect(seen).toContainEqual({ type: 'story-canvas-changed', projectId: film.id, boardId: film.id })

    const [first, second] = board.nodes as Array<{ id: string }>
    expect((await run('canvas_get_state')).nodes).toHaveLength(2)
    expect((await run('canvas_connect_nodes', { connections: [{ fromNodeId: first!.id, toNodeId: second!.id }] })).connections).toHaveLength(1)
    const renamed = await run('canvas_apply_ops', { ops: [{ type: 'update_node', id: first!.id, patch: { title: '开场' } }] })
    expect(renamed.nodes).toEqual([expect.objectContaining({ id: first!.id, title: '开场' })])
    await expect(run('canvas_apply_ops', { ops: [{ type: 'update_node', id: 'nope' }] })).rejects.toThrow(/CANVAS_OP_INVALID.*does not exist/u)
    await expect(run('canvas_apply_ops', { ops: [{ type: 'add_node', nodeType: 'pack:custom' }] })).rejects.toThrow(/only be added while the storyboard is open/u)
    await expect(run('canvas_run_generation', { nodeId: first!.id })).rejects.toThrow(/CANVAS_BOARD_NOT_OPEN/)
    await expect(run('canvas_create_generation_flow', { prompt: '雨夜', autoRun: true })).rejects.toThrow(/CANVAS_BOARD_NOT_OPEN/)

    const flow = await run('canvas_create_generation_flow', { prompt: '雨夜客栈门口，电影感', referenceNodeIds: [first!.id], mode: 'video' })
    const flowNodes = flow.nodes as Array<{ id: string; type: string; metadata: Record<string, unknown> }>
    expect(flowNodes.map(node => node.type)).toEqual(['text', 'config'])
    const config = flowNodes[1]!
    expect(config.metadata).toMatchObject({ generationMode: 'video', status: 'idle', prompt: `@[node:${flowNodes[0]!.id}]\n@[node:${first!.id}]` })
    expect(flow.connections).toHaveLength(2)
    expect(await run('canvas_get_generation_status', { nodeIds: [config.id, 'missing'] })).toMatchObject({
      source: 'persisted', missingNodeIds: ['missing'], nodes: [{ id: config.id, type: 'config', outputNodeIds: [] }],
    })

    expect(await run('canvas_read_node', { nodeId: first!.id, field: 'content' })).toMatchObject({ content: '第一镜：雨夜门口', nextOffset: null })
    expect(await run('canvas_get_document', { limit: 2 })).toMatchObject({ source: 'persisted', totalNodes: 4, nextOffset: 2 })
    expect((await run('canvas_delete_nodes', { ids: [second!.id] })).removedNodeIds).toEqual([second!.id])
    expect((await savedBoard()).nodes).toHaveLength(3)
  })

  it('starts the shared empty board for a film that has none (made by 0.1.0)', async () => {
    const film = await startFilm()
    await rm(join(cwd, 'film', 'canvas', 'document.json'))
    expect(await run('canvas_get_state')).toMatchObject({ source: 'persisted', empty: true, nodes: [] })
    await run('canvas_create_text_nodes', { items: [{ text: '镜 1' }] })
    expect(await savedBoard()).toMatchObject({
      id: film.id, title: '雨夜来客', chatSessions: [], activeChatId: null, backgroundMode: 'lines', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
    })
  })

  it('shortens long text and leaves out bulky metadata in what the model reads', async () => {
    await startFilm()
    const long = '长'.repeat(500)
    await run('canvas_apply_ops', { ops: [
      { type: 'add_node', id: 'note', nodeType: 'text', metadata: { content: long } },
      { type: 'add_node', id: 'desk', nodeType: 'director', metadata: { directorProject: { shots: Array.from({ length: 200 }, (_, index) => ({ id: `shot-${index}` })) } } },
    ] })
    const state = await run('canvas_get_state')
    const note = state.nodes.find((node: any) => node.id === 'note')
    expect(note.metadata.content).toHaveLength(121)
    expect(note.truncatedFields).toEqual([{ field: 'content', totalLength: 500, previewLength: 120 }])
    const desk = state.nodes.find((node: any) => node.id === 'desk')
    expect(desk.metadata.directorProject).toBe('[object omitted]')
    expect(desk.omittedFields).toEqual(['directorProject'])
    const pages = [await run('canvas_read_node', { nodeId: 'note', field: 'content', limit: 300 })]
    pages.push(await run('canvas_read_node', { nodeId: 'note', field: 'content', offset: pages[0].nextOffset, contentDigest: pages[0].contentDigest }))
    expect(pages.map(page => page.content).join('')).toBe(long)
  })

  it('reports the reason the page recorded on a node whose run stopped or failed, and the saved board\'s summary does too', async () => {
    await startFilm()
    // What the page leaves when a batch or an agent's run is refused before its request: status error and the reason
    // on the source node that has no content yet — a generation node, or a video waiting for its first output.
    const overLimit = '加上运镜等设置后提示词超过 4000 字，请精简提示词或去掉部分设置'
    const reference = '参考视频 1 长 20 秒，超过这个模型单段 15 秒的上限'
    await run('canvas_apply_ops', { ops: [
      { type: 'add_node', id: 'gen', nodeType: 'config', metadata: { generationMode: 'video', status: 'error', errorDetails: overLimit } },
      { type: 'add_node', id: 'batch', nodeType: 'config', metadata: { generationMode: 'image', status: 'error', errorDetails: '全部图片生成失败' } },
      // Its last attempt failed earlier; the refusal of the new run came after it.
      { type: 'add_node', id: 'shot', nodeType: 'video', metadata: { status: 'error', errorDetails: reference, videoAttempt: { attemptId: 'a1', status: 'failed', errorDetails: '上游超时' } } },
      { type: 'add_node', id: 'still', nodeType: 'image', metadata: { status: 'error', errorDetails: reference } },
      { type: 'add_node', id: 'idle', nodeType: 'config', metadata: { generationMode: 'image', status: 'idle' } },
      { type: 'add_node', id: 'long', nodeType: 'config', metadata: { generationMode: 'video', status: 'error', errorDetails: '长'.repeat(400) } },
    ] })
    const status = await run('canvas_get_generation_status', { nodeIds: ['gen', 'batch', 'shot', 'still', 'idle', 'long'] })
    expect(status).toMatchObject({ source: 'persisted', missingNodeIds: [], allSucceeded: false })
    const [gen, batch, shot, still, idle, long] = status.nodes
    expect(gen).toEqual({
      id: 'gen', type: 'config', title: '生成配置', status: 'unknown', nodeStatus: 'error', error: overLimit,
      outputs: [], outputCount: 0, outputsTruncated: false, outputNodeIds: [], outputNodeIdsTruncated: false,
    })
    expect(batch).toMatchObject({ nodeStatus: 'error', error: '全部图片生成失败' })
    // The video's attempt still says the older failure; the node's own reason is the newer one.
    expect(shot).toMatchObject({ status: 'failed', nodeStatus: 'error', error: reference, outputs: [{ status: 'failed', error: '上游超时' }] })
    // An output that already says it is not repeated; a node that is not in error has none.
    expect(still).toMatchObject({ status: 'failed', outputs: [{ status: 'failed', error: reference }] })
    expect(still).not.toHaveProperty('error')
    expect(idle).toMatchObject({ nodeStatus: 'idle' })
    expect(idle).not.toHaveProperty('error')
    expect(long.error).toBe('长'.repeat(320))
    // canvas_get_document's summary of a node carries the same status.
    expect((await run('canvas_get_document', { nodeId: 'gen' })).node.generation).toMatchObject({ nodeStatus: 'error', error: overLimit })
    expect((await run('canvas_get_document', {})).nodes.find((node: any) => node.id === 'batch').generation).toMatchObject({ error: '全部图片生成失败' })
    expect(tools.get('canvas_get_generation_status')!.description).toContain('A node\'s error is the reason the page recorded on it')
  })
})

describe('generation options (C11)', () => {
  /** The refusal a call ends with. */
  const refused = (name: string, args: Record<string, unknown>): Promise<any> => run(name, args).then(() => { throw new Error(`${name} was not refused`) }, (error: unknown) => error)
  const savedNode = async (id: string): Promise<any> => (await savedBoard()).nodes.find((node: { id: string }) => node.id === id)

  it('canvas_generation_options lists the camera moves, camera settings and presets of the canvas build', async () => {
    const moves = await run('canvas_generation_options', { kind: 'camera_moves' })
    expect(moves).toMatchObject({ catalogVersion: '2026-10-05.1', kind: 'camera_moves', speeds: { slow: { zh: '缓慢地', en: 'slowly' } } })
    expect(moves.items).toHaveLength(42)
    expect(moves.categories).toHaveLength(12)
    expect(moves.items[0]).toEqual({ id: 'static', category: 'fixed', name: { zh: '固定镜头', en: 'Locked-off' }, summary: { zh: '机位焦距不变，只拍动作', en: 'Nothing moves but the scene' }, speedable: false, exclusive: true })
    expect(moves.items.find((move: any) => move.id === 'dolly-zoom')).toMatchObject({ bestEffort: true })
    expect(moves.note).toContain('1–3 moves')
    expect((await run('canvas_generation_options', { kind: 'camera_moves', category: 'push' })).items.map((move: any) => move.id)).toEqual(['push-in', 'push-in-face', 'push-in-detail', 'snap-push'])
    // Only video takes camera moves.
    expect(await run('canvas_generation_options', { kind: 'camera_moves', mode: 'image' })).toMatchObject({ items: [], note: 'Camera moves are for video generation only.' })
    await expect(run('canvas_generation_options', { kind: 'camera_moves', category: 'dolly' })).rejects.toThrow(/^CANVAS_OPTION_UNKNOWN: Unknown category "dolly"\. The categories: fixed \(固定\), push \(推\)/u)
    await expect(run('canvas_generation_options', { kind: 'camera', category: 'push' })).rejects.toThrow(/CANVAS_OPTION_UNKNOWN: category filters camera_moves only/u)

    const camera = await run('canvas_generation_options', { kind: 'camera' })
    expect(camera.items.looks.map((entry: any) => entry.id)).toEqual(['digital-cinema', 'film-35mm', 'film-16mm', 'phone-documentary', 'vintage-ccd'])
    expect(camera.items.focalLengths.map((stop: any) => stop.mm)).toEqual([14, 18, 24, 35, 50, 85, 105, 135, 200])
    expect(camera.items.apertures.map((stop: any) => stop.f)).toEqual([1.4, 2, 2.8, 4, 5.6, 8, 11, 16])
    expect(camera.items.shotSizes).toHaveLength(8)
    expect(camera.defaults).toEqual({ look: 'digital-cinema', lens: 'spherical-prime', focalLength: 50, aperture: 2.8 })
    expect((await run('canvas_generation_options', { kind: 'camera', mode: 'text' })).items).toEqual({})

    expect((await run('canvas_generation_options', { kind: 'presets', mode: 'video' })).items.map((preset: any) => preset.id)).toEqual(['p.vertical-drama', 'p.landscape-trailer', 'p.cheap-preview'])
    expect((await run('canvas_generation_options', { kind: 'presets' })).items).toHaveLength(6)
    await expect(run('canvas_generation_options', { kind: 'skills' })).rejects.toThrow(/kind/u)
    expect(tools.get('canvas_generation_options')!.isConcurrencySafe?.({ kind: 'camera' } as never)).toBe(true)
  })

  it('answers CANVAS_CATALOG_MISSING when the build has no catalogue, and clears without one', async () => {
    await startFilm()
    await run('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'shot', nodeType: 'video', metadata: { cameraMove: { v: 1, moves: [{ id: 'push-in' }] } } }] })
    services.catalogRoot = join(cwd, 'no-catalog')
    await expect(run('canvas_generation_options', { kind: 'camera_moves' })).rejects.toThrow(/^CANVAS_CATALOG_MISSING: .*apps\/canvas\/catalog\/camera-moves\.json/u)
    await expect(run('canvas_set_generation_options', { nodeIds: ['shot'], cameraMove: { moves: [{ id: 'push-in' }] } })).rejects.toThrow(/CANVAS_CATALOG_MISSING/u)
    expect((await run('canvas_set_generation_options', { nodeIds: ['shot'], clear: ['cameraMove'] })).applied).toEqual([{ nodeId: 'shot', set: [], cleared: ['cameraMove'], skipped: [], changed: true }])
    expect((await savedNode('shot')).metadata.cameraMove).toBeNull()
  })

  it('stores a camera move and camera settings on a closed board as the page reads them, and announces the change', async () => {
    const film = await startFilm()
    await run('canvas_apply_ops', { ops: [
      { type: 'add_node', id: 'shot', nodeType: 'video' },
      { type: 'add_node', id: 'gen', nodeType: 'config', metadata: { generationMode: 'video' } },
    ] })
    const seen: ProjectEvent[] = []
    events.subscribe(cwd, (event) => { seen.push(event) })
    const result = await run('canvas_set_generation_options', {
      nodeIds: ['shot', 'gen'], cameraMove: { moves: [{ id: 'push-in', speed: 'slow' }, { id: 'orbit-left' }] }, cameraControl: { focalLength: 40, aperture: 3 },
    })
    expect(result).toMatchObject({
      source: 'persisted', resultView: 'changes', totalNodeCount: 2,
      applied: [
        { nodeId: 'shot', set: ['cameraMove', 'cameraControl'], cleared: [], skipped: [], changed: true },
        { nodeId: 'gen', set: ['cameraMove', 'cameraControl'], cleared: [], skipped: [], changed: true },
      ],
      adjusted: [expect.stringMatching(/^focalLength 40 became 35mm/u), expect.stringMatching(/^aperture 3 became f\/2\.8/u)],
    })
    expect(result.nodes.map((node: any) => node.id)).toEqual(['shot', 'gen'])
    expect(seen).toContainEqual({ type: 'story-canvas-changed', projectId: film.id, boardId: film.id })
    const shot = await savedNode('shot')
    expect(shot.metadata.cameraMove).toEqual({ v: 1, moves: [{ id: 'push-in', speed: 'slow' }, { id: 'orbit-left' }], combine: 'sequence' })
    expect(shot.metadata.cameraControl).toEqual({ v: 1, enabled: true, look: 'digital-cinema', lens: 'spherical-prime', focalLength: 35, aperture: 2.8 })
    // canvas_get_state reads a node's settings, and so does canvas_get_document's summary (without the schema version).
    expect((await run('canvas_get_state')).nodes.find((node: any) => node.id === 'gen').metadata).toMatchObject({ cameraMove: shot.metadata.cameraMove, cameraControl: shot.metadata.cameraControl })
    const { v: _move, ...move } = shot.metadata.cameraMove
    const { v: _camera, ...camera } = shot.metadata.cameraControl
    expect((await run('canvas_get_document', { nodeId: 'gen' })).node.metadata).toMatchObject({ cameraMove: move, cameraControl: camera })
    expect((await run('canvas_get_document', {})).nodes.find((node: any) => node.id === 'shot').metadata).toMatchObject({ cameraMove: move, cameraControl: camera })

    // Fields left out keep the node's; enabled defaults to true; a null shot size removes it.
    await run('canvas_set_generation_options', { nodeIds: ['shot'], cameraControl: { enabled: false } })
    expect((await savedNode('shot')).metadata.cameraControl).toMatchObject({ enabled: false, focalLength: 35 })
    await run('canvas_set_generation_options', { nodeIds: ['shot'], cameraControl: { look: 'film-35mm', shotSize: 'close', angle: 'low' } })
    expect((await savedNode('shot')).metadata.cameraControl).toEqual({ v: 1, enabled: true, look: 'film-35mm', lens: 'spherical-prime', focalLength: 35, aperture: 2.8, shotSize: 'close', angle: 'low' })
    await run('canvas_set_generation_options', { nodeIds: ['shot'], cameraControl: { shotSize: null } })
    expect((await savedNode('shot')).metadata.cameraControl).toEqual({ v: 1, enabled: true, look: 'film-35mm', lens: 'spherical-prime', focalLength: 35, aperture: 2.8, angle: 'low' })

    // The same move again saves nothing.
    const before = (await savedBoard()).updatedAt
    seen.length = 0
    expect(await run('canvas_set_generation_options', { nodeIds: ['shot'], cameraMove: { moves: [{ id: 'push-in', speed: 'slow' }, { id: 'orbit-left' }] } }))
      .toMatchObject({ source: 'persisted', changed: false, applied: [{ nodeId: 'shot', set: ['cameraMove'], changed: false }] })
    expect((await savedBoard()).updatedAt).toBe(before)
    expect(seen).toEqual([])
  })

  it('canvas_get_document shows the settings compactly, as stored, and a cleared one not at all', async () => {
    await startFilm()
    await run('canvas_apply_ops', { ops: [
      // As a hand edit or an older page may leave them: extra members, a move without an id, a fourth move, a speed that is not one, numbers as text.
      { type: 'add_node', id: 'shot', nodeType: 'video', metadata: {
        cameraMove: { v: 1, moves: [{ id: 'push-in', speed: 'slow', note: 'x' }, { id: 'orbit-left', speed: 'brisk' }, { speed: 'fast' }, { id: 'crane-up' }, { id: 'tilt-up' }], combine: 'together', extra: true },
        cameraControl: { v: 1, enabled: false, look: 'film-35mm', lens: 'anamorphic', focalLength: '85mm', aperture: 2.8, shotSize: 'close', angle: 'sideways', extra: { deep: true } },
      } },
      { type: 'add_node', id: 'cleared', nodeType: 'video', metadata: { cameraMove: null, cameraControl: null } },
      { type: 'add_node', id: 'other', nodeType: 'config', metadata: { generationMode: 'video', cameraMove: { v: 2, moves: [{ id: 'push-in' }] }, cameraControl: { v: 2, look: 'film-35mm' } } },
      { type: 'add_node', id: 'bare', nodeType: 'image', metadata: { cameraControl: {} } },
    ] })
    const summary = async (id: string): Promise<any> => (await run('canvas_get_document', { nodeId: id })).node.metadata
    const shot = await summary('shot')
    expect(shot.cameraMove).toEqual({ moves: [{ id: 'push-in', speed: 'slow' }, { id: 'orbit-left' }, { id: 'crane-up' }], combine: 'together' })
    expect(shot.cameraControl).toEqual({ enabled: false, look: 'film-35mm', lens: 'anamorphic', focalLength: '85mm', aperture: 2.8, shotSize: 'close' })
    // Cleared (null) and another schema version are no setting; a setting without members applies with the page's defaults.
    for (const id of ['cleared', 'other']) {
      const metadata = await summary(id)
      expect(metadata, id).not.toHaveProperty('cameraMove')
      expect(metadata, id).not.toHaveProperty('cameraControl')
    }
    expect((await summary('bare')).cameraControl).toEqual({ enabled: true })
    expect(tools.get('canvas_get_document')!.description).toContain('metadata.cameraMove, metadata.cameraControl')
  })

  it('clears with null, which every reader takes as no setting (update_node cannot delete a key)', async () => {
    await startFilm()
    await run('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'shot', nodeType: 'video' }] })
    await run('canvas_set_generation_options', { nodeIds: ['shot'], cameraMove: { moves: [{ id: 'handheld' }] }, cameraControl: {} })
    const cleared = await run('canvas_set_generation_options', { nodeIds: ['shot'], clear: ['cameraMove', 'cameraControl'] })
    expect(cleared.applied).toEqual([{ nodeId: 'shot', set: [], cleared: ['cameraMove', 'cameraControl'], skipped: [], changed: true }])
    const metadata = (await savedNode('shot')).metadata
    expect(metadata).toHaveProperty('cameraMove', null)
    expect(metadata).toHaveProperty('cameraControl', null)
    expect((await run('canvas_set_generation_options', { nodeIds: ['shot'], clear: ['cameraMove'] })).changed).toBe(false)
    // A cleared camera starts again from the defaults.
    await run('canvas_set_generation_options', { nodeIds: ['shot'], cameraControl: { aperture: 8 } })
    expect((await savedNode('shot')).metadata.cameraControl).toEqual({ v: 1, enabled: true, look: 'digital-cinema', lens: 'spherical-prime', focalLength: 50, aperture: 8 })
  })

  it('warns when the new settings push a node\'s prompt past the 4000 characters the storyboard sends', async () => {
    await startFilm()
    await run('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'shot', nodeType: 'video', metadata: { prompt: '雨'.repeat(3985) } }] })
    const set = await run('canvas_set_generation_options', { nodeIds: ['shot'], cameraMove: { moves: [{ id: 'push-in' }] } })
    // 3985 + a blank line + '运镜：镜头平稳地向前推进，逐渐靠近主体。' (20).
    expect(set.warnings).toEqual([{ code: 'CANVAS_PROMPT_OVER_LIMIT', nodeId: 'shot', length: 4007, limit: 4000, certain: true, note: expect.stringContaining('generating it is refused') }])
    expect((await savedNode('shot')).metadata.cameraMove).toEqual({ v: 1, moves: [{ id: 'push-in' }], combine: 'sequence' })
    expect(await run('canvas_set_generation_options', { nodeIds: ['shot'], clear: ['cameraMove'] })).not.toHaveProperty('warnings')
  })

  it('skips what a node does not take, and refuses unknown ids, wrong targets and settings no node takes before writing', async () => {
    await startFilm()
    await run('canvas_apply_ops', { ops: [
      { type: 'add_node', id: 'still', nodeType: 'image' },
      { type: 'add_node', id: 'shot', nodeType: 'video' },
      { type: 'add_node', id: 'pano', nodeType: 'image', metadata: { panoramaProjection: 'equirectangular' } },
      { type: 'add_node', id: 'edit', nodeType: 'video', metadata: { videoMode: 'video-edit' } },
      { type: 'add_node', id: 'note', nodeType: 'text', metadata: { content: '镜 1' } },
    ] })
    const mixed = await run('canvas_set_generation_options', { nodeIds: ['still', 'shot', 'pano', 'edit'], cameraMove: { moves: [{ id: 'whip-pan', speed: 'fast' }] }, cameraControl: { lens: 'anamorphic' } })
    expect(mixed.applied).toEqual([
      { nodeId: 'still', set: ['cameraControl'], cleared: [], skipped: [{ field: 'cameraMove', reason: 'camera moves are for video; this is an image node' }], changed: true },
      { nodeId: 'shot', set: ['cameraMove', 'cameraControl'], cleared: [], skipped: [], changed: true },
      {
        nodeId: 'pano', set: [], cleared: [], changed: false,
        skipped: [{ field: 'cameraMove', reason: 'camera moves are for video; this is an image node' }, { field: 'cameraControl', reason: 'a panorama shows a whole environment and takes no camera settings' }],
      },
      {
        nodeId: 'edit', set: [], cleared: [], changed: false,
        skipped: [{ field: 'cameraMove', reason: expect.stringContaining('video-edit') }, { field: 'cameraControl', reason: expect.stringContaining('video-edit') }],
      },
    ])
    expect(mixed.adjusted).toEqual(['whip-pan has no speed; the speed was left out'])
    expect((await savedNode('shot')).metadata.cameraMove).toEqual({ v: 1, moves: [{ id: 'whip-pan' }], combine: 'sequence' })

    const board = JSON.stringify(await savedBoard())
    const unknown = await refused('canvas_set_generation_options', { nodeIds: ['shot'], cameraMove: { moves: [{ id: 'dolly-in' }] } })
    expect(unknown.code).toBe('CANVAS_OPTION_UNKNOWN')
    expect(unknown.message).toMatch(/Unknown camera move id: dolly-in\. The valid ids: static, static-breathing, push-in, .*pov/u)
    expect((await refused('canvas_set_generation_options', { nodeIds: ['shot'], cameraControl: { look: 'imax' } })).message).toMatch(/CANVAS_OPTION_UNKNOWN: .*digital-cinema \(数字电影机\)/u)
    expect((await refused('canvas_set_generation_options', { nodeIds: ['shot'], preset: 'p.nope' })).message).toMatch(/CANVAS_OPTION_UNKNOWN: .*p\.vertical-drama/u)
    expect((await refused('canvas_set_generation_options', { nodeIds: ['still'], cameraMove: { moves: [{ id: 'push-in' }] } })).code).toBe('CANVAS_OPTION_MODE')
    expect((await refused('canvas_set_generation_options', { nodeIds: ['still', 'note'], cameraControl: {} })).message).toMatch(/^CANVAS_OPTION_TARGET: note is a text node/u)
    expect((await refused('canvas_set_generation_options', { nodeIds: ['gone'], cameraControl: {} })).code).toBe('CANVAS_NODE_NOT_FOUND')
    expect((await refused('canvas_set_generation_options', { nodeIds: ['shot'], cameraMove: { moves: [{ id: 'static' }, { id: 'push-in' }] } })).message).toMatch(/CANVAS_OPTION_INVALID: static \(固定镜头\) stands alone/u)
    expect((await refused('canvas_set_generation_options', { nodeIds: ['shot'], cameraMove: { moves: [{ id: 'push-in' }] }, clear: ['cameraMove'] })).message).toMatch(/both set and cleared/u)
    expect((await refused('canvas_set_generation_options', { nodeIds: ['shot'] })).message).toMatch(/Pass cameraMove, cameraControl, preset or clear/u)
    expect((await refused('canvas_set_generation_options', { nodeIds: [] })).code).toBe('CANVAS_OPTION_INVALID')
    expect((await refused('canvas_set_generation_options', { nodeIds: ['shot', 'shot'], clear: ['cameraMove'] })).code).toBe('CANVAS_OPTION_INVALID')
    await expect(run('canvas_set_generation_options', { nodeIds: ['shot'], cameraControl: { shotSize: 'cowboy' } })).rejects.toThrow(/shotSize/u)
    expect(JSON.stringify(await savedBoard())).toBe(board)
  })

  it('applies a preset to the nodes of its mode and says what it skipped', async () => {
    await startFilm()
    await run('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'shot', nodeType: 'video' }, { type: 'add_node', id: 'still', nodeType: 'image' }] })
    const drama = await run('canvas_set_generation_options', { nodeIds: ['shot', 'still'], preset: 'p.vertical-drama' })
    expect(drama.applied).toEqual([
      { nodeId: 'shot', set: ['size', 'vquality', 'seconds', 'generateAudio'], cleared: [], skipped: [], changed: true },
      { nodeId: 'still', set: [], cleared: [], skipped: [{ field: 'preset', reason: 'p.vertical-drama is a video preset; this is an image node' }], changed: false },
    ])
    expect(drama.note).toContain('fits a preset')
    expect((await savedNode('shot')).metadata).toMatchObject({ size: '9:16', vquality: '720', seconds: '5', generateAudio: 'true' })
    const card = await run('canvas_set_generation_options', { nodeIds: ['still'], preset: 'p.character-card', cameraControl: { focalLength: 85 } })
    expect(card.applied).toEqual([{ nodeId: 'still', set: ['size', 'count', 'cameraControl'], cleared: [], skipped: [{ field: 'skills', reason: expect.stringContaining('vd.character-sheet') }], changed: true }])
    expect((await savedNode('still')).metadata).toMatchObject({ size: '1536x1024', count: 1, cameraControl: { focalLength: 85 } })
  })

  it('canvas_create_generation_flow stores the settings on the closed board\'s generation node', async () => {
    await startFilm()
    const flow = await run('canvas_create_generation_flow', {
      prompt: '雨夜，客栈门口', mode: 'video', cameraMove: { moves: [{ id: 'lead-front' }] }, cameraControl: { look: 'film-35mm', focalLength: 85 },
    })
    const [text, config] = flow.nodes as Array<{ type: string; metadata: Record<string, unknown> }>
    expect(text!.metadata).not.toHaveProperty('cameraMove')
    expect(config!.metadata).toMatchObject({
      generationMode: 'video',
      cameraMove: { v: 1, moves: [{ id: 'lead-front' }], combine: 'sequence' },
      cameraControl: { v: 1, enabled: true, look: 'film-35mm', lens: 'spherical-prime', focalLength: 85, aperture: 2.8 },
    })
    // A preset fills the mode and the settings the call leaves out.
    const preset = await run('canvas_create_generation_flow', { prompt: '回眸', preset: 'p.vertical-drama', seconds: '8' })
    expect(preset.preset).toBe('p.vertical-drama')
    expect(preset.nodes[1].metadata).toMatchObject({ generationMode: 'video', size: '9:16', vquality: '720', seconds: '8', generateAudio: true })
    const before = (await savedBoard()).nodes.length
    expect((await refused('canvas_create_generation_flow', { prompt: '雨夜', cameraMove: { moves: [{ id: 'push-in' }] } })).message).toMatch(/^CANVAS_OPTION_MODE: Camera moves are for video; this flow's mode is image/u)
    expect((await refused('canvas_create_generation_flow', { prompt: '雨夜', mode: 'text', cameraControl: {} })).code).toBe('CANVAS_OPTION_MODE')
    expect((await refused('canvas_create_generation_flow', { prompt: '雨夜', mode: 'image', preset: 'p.vertical-drama' })).code).toBe('CANVAS_OPTION_MODE')
    expect((await refused('canvas_create_generation_flow', { prompt: '雨夜', mode: 'video', cameraMove: { moves: [{ id: 'fly-through' }] } })).code).toBe('CANVAS_OPTION_UNKNOWN')
    expect((await savedBoard()).nodes).toHaveLength(before)
  })
})

describe('storyboard tools with a page open', () => {
  /**
   * A canvas page: it takes its lease, reports its board and answers calls with the board's executor; the runs a
   * batch starts are recorded, as the page starts them after answering.
   */
  function openPage(projectId: string, behaviour: { refuse?: string; silent?: boolean } = {}) {
    const sent: Array<{ event: string; data: any }> = []
    const runs: BoardOp[] = []
    let board: BoardSnapshot = { projectId, title: '雨夜来客', nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }
    let lease!: BoardLease
    let sequence = 1
    let closed = false
    let reached!: () => void
    /** Settles when the first tool call reaches the page. */
    const called = new Promise<void>((resolve) => { reached = resolve })
    const stream: EventStream = {
      send(event, data) {
        if (closed) return false
        sent.push({ event, data })
        if (event === 'tool_call') reached()
        if (event === 'tool_call' && behaviour.silent !== true) {
          const call = data as { requestId: string; input: { ops: BoardOp[] } }
          queueMicrotask(() => {
            if (behaviour.refuse !== undefined) {
              boardAgent.resolve(lease, { requestId: call.requestId, error: behaviour.refuse })
              return
            }
            board = applyBoardOps(board, call.input.ops.filter(op => op.type !== 'run_generation'))
            runs.push(...call.input.ops.filter(op => op.type === 'run_generation'))
            boardAgent.resolve(lease, { requestId: call.requestId, result: board, sequence: ++sequence })
          })
        }
        return true
      },
      close() { closed = true },
      get closed() { return closed },
    }
    const target: BoardTarget = { projectId, clientId: 'page-1', incarnation: 'load-1' }
    const release = boardAgent.connect(target, stream)
    const hello = sent[0]!.data as { generation: string; writeToken: string }
    lease = { target, generation: hello.generation, writeToken: hello.writeToken }
    boardAgent.setSnapshot(lease, board, sequence)
    return { sent, runs, target, lease, release, called, board: () => board, calls: () => sent.filter(item => item.event === 'tool_call').map(item => item.data) }
  }

  it('sends writes to the page and reads the board it reports', async () => {
    const film = await startFilm()
    const page = openPage(film.id)
    expect((await run('canvas_list_clients')).clients).toEqual([{ target: page.target, boardId: film.id, ready: true, selectedNodeIds: [] }])
    const made = await run('canvas_create_text_nodes', { items: [{ text: '镜 1' }] })
    expect(made).toMatchObject({ source: 'live', target: page.target, totalNodeCount: 1 })
    expect(page.sent.find(item => item.event === 'tool_call')!.data).toMatchObject({
      target: page.target, name: 'canvas_apply_ops', input: { boardId: film.id, project: film.id, ops: [{ type: 'add_node', nodeType: 'text' }] },
    })
    // The page saves its own board; the tool wrote nothing behind it (the saved board is still the empty one the film came with).
    expect((await savedBoard()).nodes).toEqual([])
    // The answer is the page's new board: reads see it straight away.
    expect(await run('canvas_get_state')).toMatchObject({ source: 'live', nodes: [{ metadata: { content: '镜 1' } }] })
    expect((await run('canvas_get_selection')).nodes).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ content: '镜 1' }) })])
  })

  it('reports a page\'s refusal, and a page that closes before it answers', async () => {
    const film = await startFilm()
    const refusing = openPage(film.id, { refuse: '没有这个节点' })
    await expect(run('canvas_run_generation', { nodeId: 'n1' })).rejects.toThrow(/CANVAS_BOARD_REFUSED: 没有这个节点/u)
    refusing.release()
    const silent = openPage(film.id, { silent: true })
    const pending = run('canvas_create_text_nodes', { items: [{ text: '镜 1' }] })
    // The page closes once the call has reached it. (A fixed 10 ms wait raced the tool's reads of the film under load:
    // closed too early, the call found the page gone, CANVAS_BOARD_NOT_OPEN, or the tool saved the board instead.)
    // A call that ends without reaching the page fails here.
    await Promise.race([silent.called, pending.catch(() => undefined)])
    expect(silent.calls()).toHaveLength(1)
    silent.release()
    await expect(pending).rejects.toThrow(/CANVAS_BOARD_GONE/)
  })

  it('refuses to write around a page that is still loading its board', async () => {
    const film = await startFilm()
    const sent: unknown[] = []
    boardAgent.connect({ projectId: film.id, clientId: 'page-2', incarnation: 'load-2' }, { send: (_event, data) => { sent.push(data); return true }, close() {}, closed: false })
    await expect(run('canvas_create_text_nodes', { items: [{ text: '镜 1' }] })).rejects.toThrow(/CANVAS_BOARD_NOT_READY/)
  })

  it('sets generation options on the open page as update_node ops, and writes nothing behind it', async () => {
    const film = await startFilm()
    const page = openPage(film.id)
    await run('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'shot', nodeType: 'video' }, { type: 'add_node', id: 'still', nodeType: 'image' }] })
    const result = await run('canvas_set_generation_options', { nodeIds: ['shot', 'still'], cameraMove: { moves: [{ id: 'crane-up' }] }, cameraControl: { aperture: 1.4 } })
    expect(result).toMatchObject({ source: 'live', target: page.target, applied: [{ nodeId: 'shot', changed: true }, { nodeId: 'still', set: ['cameraControl'], skipped: [{ field: 'cameraMove' }] }] })
    const camera = { v: 1, enabled: true, look: 'digital-cinema', lens: 'spherical-prime', focalLength: 50, aperture: 1.4 }
    expect(page.calls().at(-1)).toMatchObject({ name: 'canvas_apply_ops', input: { boardId: film.id, ops: [
      { type: 'update_node', id: 'shot', metadata: { cameraMove: { v: 1, moves: [{ id: 'crane-up' }], combine: 'sequence' }, cameraControl: camera } },
      { type: 'update_node', id: 'still', metadata: { cameraControl: camera } },
    ] } })
    expect(page.board().nodes!.find(node => node.id === 'shot')!.metadata).toMatchObject({ cameraControl: camera })
    expect((await savedBoard()).nodes).toEqual([])
    // Clearing on the page sends null; nothing to change sends nothing.
    await run('canvas_set_generation_options', { nodeIds: ['shot'], clear: ['cameraMove'] })
    expect(page.calls().at(-1).input.ops).toEqual([{ type: 'update_node', id: 'shot', metadata: { cameraMove: null } }])
    const calls = page.calls().length
    expect(await run('canvas_set_generation_options', { nodeIds: ['shot'], clear: ['cameraMove'] })).toMatchObject({ source: 'live', changed: false })
    expect(page.calls()).toHaveLength(calls)
  })

  it('refuses a run whose camera lines would push the prompt past 4000 characters, before the page gets it (C2)', async () => {
    const film = await startFilm()
    const page = openPage(film.id)
    // A generation node whose prompt mentions a wired text: the page sends 【文本1】 and the text as its block.
    const flow = await run('canvas_create_generation_flow', { prompt: '雨'.repeat(3975), mode: 'video', cameraMove: { moves: [{ id: 'push-in' }] } })
    const config = flow.nodes.find((node: any) => node.type === 'config').id as string
    const calls = page.calls().length
    const over = await run('canvas_run_generation', { nodeId: config }).then(() => undefined, (error: unknown) => error as Error & { code: string })
    expect(over?.code).toBe('CANVAS_PROMPT_OVER_LIMIT')
    expect(over?.message).toMatch(new RegExp(`^CANVAS_PROMPT_OVER_LIMIT: With its camera move and camera lines, the prompt of ${config} would be 40\\d\\d characters, over the 4000`, 'u'))
    expect(page.calls()).toHaveLength(calls)
    expect(page.runs).toEqual([])
    // The same flow started at once is refused whole: nothing is built.
    const nodes = page.board().nodes!.length
    await expect(run('canvas_create_generation_flow', { prompt: '雨'.repeat(3975), mode: 'video', cameraMove: { moves: [{ id: 'push-in' }] }, autoRun: true })).rejects.toThrow(/CANVAS_PROMPT_OVER_LIMIT/u)
    expect(page.board().nodes).toHaveLength(nodes)
    // Without the camera move it goes; so does a prompt the person made longer than the limit by itself.
    await run('canvas_set_generation_options', { nodeIds: [config], clear: ['cameraMove'] })
    // A raw batch that sets the move again and runs is judged on the board it leaves.
    await expect(run('canvas_apply_ops', { ops: [
      { type: 'update_node', id: config, metadata: { cameraMove: { v: 1, moves: [{ id: 'push-in' }] } } }, { type: 'run_generation', nodeId: config },
    ] })).rejects.toThrow(/CANVAS_PROMPT_OVER_LIMIT/u)
    expect(page.board().nodes!.find(node => node.id === config)!.metadata!.cameraMove).toBeNull()
    await run('canvas_run_generation', { nodeId: config })
    const long = await run('canvas_create_generation_flow', { prompt: '雨'.repeat(4100), mode: 'video', cameraMove: { moves: [{ id: 'push-in' }] }, autoRun: true })
    expect(long).not.toHaveProperty('warnings')
    expect(page.runs.map(op => op.type)).toEqual(['run_generation', 'run_generation'])
  })

  it('lets a run go with a warning when only some page setups would refuse it', async () => {
    const film = await startFilm()
    const page = openPage(film.id)
    // 3985 characters: within the limit with the Chinese labels the page shows by default, over it with the English ones.
    const flow = await run('canvas_create_generation_flow', { prompt: '雨'.repeat(3985), mode: 'video', cameraMove: { moves: [{ id: 'push-in' }] }, autoRun: true })
    expect(flow.warnings).toEqual([expect.objectContaining({ code: 'CANVAS_PROMPT_OVER_LIMIT', limit: 4000, note: expect.stringContaining('canvas_get_generation_status') })])
    expect(page.runs).toHaveLength(1)
  })

  it('reads the reason the open page recorded on a generation node it did not start', async () => {
    const film = await startFilm()
    const page = openPage(film.id)
    const flow = await run('canvas_create_generation_flow', { prompt: '雨夜，客栈门口', mode: 'video', autoRun: true })
    const config = flow.nodes.find((node: any) => node.type === 'config').id as string
    expect(page.runs).toHaveLength(1)
    // The page refused the run before its request and wrote why on the generation node (the board it reports next).
    const reason = '参考视频 1 长 20 秒，超过这个模型单段 15 秒的上限'
    await run('canvas_apply_ops', { ops: [{ type: 'update_node', id: config, metadata: { status: 'error', errorDetails: reason } }] })
    expect(await run('canvas_get_generation_status', { nodeIds: [config] })).toMatchObject({
      source: 'live', nodes: [{ id: config, type: 'config', nodeStatus: 'error', error: reason, outputNodeIds: [] }],
    })
    // Nothing was saved behind the page.
    expect((await savedBoard()).nodes).toEqual([])
  })
})

describe('canvas_attach_media', () => {
  it('fills a reviewed node in place, once, and refuses a node that changed', async () => {
    const film = await startFilm()
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'still.png'), 'png one')
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'other.png'), 'png two')
    await run('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'img-1', nodeType: 'image', position: { x: 10, y: 20 } }] })
    const attached = await run('canvas_attach_media', { targetNodeId: 'img-1', path: 'canvas/media/still.png', expectedContent: '' })
    expect(attached.landed).toMatchObject({ landedNodeId: 'img-1', kind: 'image', path: 'canvas/media/still.png' })
    const url = `/api/projects/${film.id}/raw/canvas/media/still.png`
    const node = (await savedBoard()).nodes.find((item: any) => item.id === 'img-1')
    expect(node).toMatchObject({ position: { x: 10, y: 20 }, metadata: { content: url, status: 'success', mimeType: 'image/png', attachedMedia: { path: 'canvas/media/still.png' } } })
    // The same file again changes nothing; another file against the old content is refused.
    await run('canvas_attach_media', { targetNodeId: 'img-1', path: 'film/canvas/media/still.png', expectedContent: '' })
    await expect(run('canvas_attach_media', { targetNodeId: 'img-1', path: 'canvas/media/other.png', expectedContent: '' })).rejects.toThrow(/CANVAS_MEDIA_TARGET_CHANGED/)
    await expect(run('canvas_attach_media', { targetNodeId: 'missing', path: 'canvas/media/other.png', expectedContent: '' })).rejects.toThrow(/CANVAS_MEDIA_TARGET_NOT_FOUND/)
  })

  it('copies a file the media tools saved in the workspace into the film first', async () => {
    await startFilm()
    await mkdir(join(cwd, 'media'), { recursive: true })
    await writeFile(join(cwd, 'media', 'gen.png'), 'generated')
    await run('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'img-2', nodeType: 'image' }] })
    const attached = await run('canvas_attach_media', { targetNodeId: 'img-2', path: join(cwd, 'media', 'gen.png'), expectedContent: '' })
    expect(attached.landed.path).toBe('canvas/media/gen.png')
    expect(await readFile(join(cwd, 'film', 'canvas', 'media', 'gen.png'), 'utf8')).toBe('generated')
    await expect(run('canvas_attach_media', { targetNodeId: 'img-2', path: join(tmpdir(), 'elsewhere.png'), expectedContent: '' })).rejects.toThrow(/outside this workspace/u)
  })

  it('takes a media file from anywhere in the workspace, not only media/', async () => {
    await startFilm()
    await mkdir(join(cwd, 'footage', 'stills'), { recursive: true })
    await writeFile(join(cwd, 'footage', 'stills', 'inn.png'), 'inn')
    await run('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'img-3', nodeType: 'image' }, { type: 'add_node', id: 'img-4', nodeType: 'image' }] })
    expect((await run('canvas_attach_media', { targetNodeId: 'img-3', path: 'footage/stills/inn.png', expectedContent: '' })).landed.path).toBe('canvas/media/inn.png')
    // The same file for another node: the film's copy again, not inn-2.png.
    expect((await run('canvas_attach_media', { targetNodeId: 'img-4', path: 'footage\\stills\\inn.png', expectedContent: '' })).landed.path).toBe('canvas/media/inn.png')
    expect(await readdir(join(cwd, 'film', 'canvas', 'media'))).toEqual(['inn.png'])
    await mkdir(join(cwd, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(cwd, 'node_modules', 'pkg', 'logo.png'), 'logo')
    await expect(run('canvas_attach_media', { targetNodeId: 'img-4', path: 'node_modules/pkg/logo.png', expectedContent: '' })).rejects.toThrow(/CANVAS_IMPORT_INVALID/u)
  })
})

describe('film task tools', () => {
  it('reads and cancels a film task, and an old local task from 0.1 reads as interrupted', async () => {
    await startFilm()
    await mkdir(join(cwd, 'film', '.tasks'), { recursive: true })
    // A caption recognition 0.1 left running when the Host stopped.
    const old = {
      taskId: 'old-caption-task', projectId: 'p', surface: 'video-editor', model: 'whisper', status: 'running', startedAt: 1, endedAt: null,
      progress: ['已开始'], error: null, kind: 'local', request: { capability: 'timeline-captions' },
      interruption: { message: '识别中断', code: 'CAPTION_INTERRUPTED', status: 503 },
    }
    await writeFile(join(cwd, 'film', '.tasks', 'old-caption-task.json'), JSON.stringify(old))
    const read = await run('media_get_task', { taskId: 'old-caption-task' })
    expect(read).toMatchObject({ taskId: 'old-caption-task', status: 'interrupted', error: { code: 'CAPTION_INTERRUPTED' } })
    // A finished one keeps its file, without bulky members.
    await writeFile(join(cwd, 'film', '.tasks', 'old-render.json'), JSON.stringify({
      ...old, taskId: 'old-render', status: 'done', endedAt: 2, file: { name: 'canvas/renders/cut.mp4', size: 3, kind: 'video', mime: 'video/mp4', loudness: { lufs: -14 } },
    }))
    expect(await run('media_get_task', { taskId: 'old-render' })).toMatchObject({ status: 'done', file: { name: 'canvas/renders/cut.mp4', size: 3, kind: 'video', mime: 'video/mp4' } })
    expect((await run('media_get_task', { taskId: 'old-render' })).file.loudness).toBeUndefined()
    expect(await run('media_cancel_task', { taskId: 'old-render' })).toMatchObject({ taskId: 'old-render', status: 'done' })
    await expect(run('media_get_task', { taskId: 'missing-task' })).rejects.toThrow(/MEDIA_TASK_NOT_FOUND/)
  })

  it('summarises a task without bulky members', () => {
    expect(compactTask({ taskId: 't', status: 'done', progress: ['a', 'b'], startedAt: 1, endedAt: 2, error: null, file: { name: 'canvas/media/x.png', size: 3, kind: 'image', mime: 'image/png', documentResult: { kind: 'draft' } } }))
      .toEqual({ taskId: 't', status: 'done', progress: 'b', startedAt: 1, endedAt: 2, file: { name: 'canvas/media/x.png', size: 3, kind: 'image', mime: 'image/png' } })
  })

  it('keeps an edit\'s derivedFrom in the task view, compactly: the operation and each source\'s range', () => {
    const source = (index: number) => ({ nodeId: `clip-${index}`, path: `canvas/media/${index}.mp4`, inMs: 0, outMs: 1000, atMs: index * 1000 })
    const file = {
      name: 'canvas/media/join-0123456789.mp4', size: 9, kind: 'video', mime: 'video/mp4', durationMs: 2000, landedNodeId: 'video-1',
      derivedFrom: {
        v: 1, op: 'join', requestId: 'join-0000-0001', engine: 'host-copy', createdAt: '2026-10-05T00:00:00.000Z',
        sources: [{ ...source(0), probe: { codec: 'avc1' } }, { ...source(1), path: 'x'.repeat(2000) }, 'not a source'],
      },
    }
    expect(compactTask({ taskId: 't', status: 'done', progress: ['完成'], startedAt: 1, endedAt: 2, error: null, file }).file).toEqual({
      name: 'canvas/media/join-0123456789.mp4', size: 9, kind: 'video', mime: 'video/mp4', durationMs: 2000, landedNodeId: 'video-1',
      derivedFrom: { op: 'join', sources: [source(0), { nodeId: 'clip-1', inMs: 0, outMs: 1000, atMs: 1000 }] },
    })
    // At most a join's 20 sources, with the count when a record holds more.
    const many: any = compactTask({ taskId: 't', status: 'done', file: { ...file, derivedFrom: { op: 'join', sources: Array.from({ length: 25 }, (_, index) => source(index)) } } })
    expect(many.file.derivedFrom.sources).toEqual(Array.from({ length: 20 }, (_, index) => source(index)))
    expect(many.file.derivedFrom.sourceCount).toBe(25)
    // A file without one, or with something else under the name, has none.
    expect(compactTask({ taskId: 't', status: 'done', file: { ...file, derivedFrom: 'cut' } }).file).not.toHaveProperty('derivedFrom')
    expect(tools.get('media_get_task')!.description).toContain('file.derivedFrom')
  })
})

describe('installing the tools into film conversations', () => {
  type FakeAgent = { id: string; session: { header: { cwd?: string } }; tools: Set<string>; sections: Set<string>; ctx: unknown }

  function fakeHost() {
    const listeners = new Map<string, Array<(payload: { agent: FakeAgent }) => unknown>>()
    const disposers: Array<() => unknown> = []
    const live: FakeAgent[] = []
    const ctx = {
      agents: { list: () => [...live] },
      on: (name: string, listener: (payload: { agent: FakeAgent }) => unknown) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]) },
      effect: (start: () => () => unknown) => { disposers.push(start()) },
      logger: { warn: () => {} },
    }
    const agent = (id: string, folder: string | undefined): FakeAgent => {
      const fake: FakeAgent = {
        id, session: { header: { cwd: folder } }, tools: new Set(), sections: new Set(),
        ctx: {
          tools: { register: (tool: ToolDefinition) => { fake.tools.add(tool.name); return () => { fake.tools.delete(tool.name) } } },
          get: (name: string) => name !== 'systemPrompt' ? undefined : {
            getSectionOrder: () => 3000,
            section: (section: { name: string }) => { fake.sections.add(section.name); return () => { fake.sections.delete(section.name) } },
          },
        },
      }
      return fake
    }
    const emit = async (name: string, target: FakeAgent): Promise<void> => {
      if (name === 'agent/created') live.push(target)
      if (name === 'agent/disposed') live.splice(live.indexOf(target), 1)
      for (const listener of listeners.get(name) ?? []) await listener({ agent: target })
    }
    return { ctx, agent, live, emit, dispose: () => { for (const dispose of disposers) dispose() } }
  }

  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

  it('gives the tools to agents in a film workspace, and to others when their workspace gets a film', async () => {
    await startFilm()
    const plainFolder = join(cwd, 'notes')
    await mkdir(plainFolder)
    const host = fakeHost()
    const early = host.agent('early', cwd)
    host.live.push(early)
    const core = filmCoreTools(services)
    const installer = installFilmAgentTools(host.ctx as never, { tools: () => core, groups: filmToolGroups(services), guidance: 'film guidance' })
    await settle()
    expect(early.tools.size).toBe(core.length)
    expect(early.tools.has('director_query')).toBe(false)
    expect(early.sections).toEqual(new Set([GUIDANCE_SECTION]))

    const other = host.agent('other', plainFolder)
    const homeless = host.agent('homeless', undefined)
    await host.emit('agent/created', other)
    await host.emit('agent/created', homeless)
    expect(other.tools.size).toBe(0)
    expect(homeless.tools.size).toBe(0)
    expect(installer.enable(other as never, ['director'])).toBeUndefined()

    await run('film_project', { action: 'create', title: '笔记' }, plainFolder)
    // At once: the agent that made the film has the tools on its very next step.
    installer.projectCreated(plainFolder)
    expect(other.tools.has('story_apply_ops')).toBe(true)
    // Again installs nothing twice.
    installer.projectCreated(plainFolder)
    await settle()
    expect(other.tools.size).toBe(core.length)

    // Groups come when asked for, once.
    expect(installer.enable(early as never, ['modeling', 'modeling'])).toEqual(['modeling'])
    expect(early.tools.has('space_plan_compile')).toBe(true)
    expect(early.tools.size).toBe(core.length + modelingToolCount)

    await host.emit('agent/disposed', early)
    expect(early.tools.size).toBe(0)
    expect(early.sections.size).toBe(0)
    host.dispose()
    expect(other.tools.size).toBe(0)
  })

  it('starts a conversation with the director group when the board has a director node', async () => {
    await startFilm()
    await run('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'desk', nodeType: 'director' }] })
    const host = fakeHost()
    installFilmAgentTools(host.ctx as never, { tools: () => filmCoreTools(services), groups: filmToolGroups(services), guidance: 'film guidance' })
    const agent = host.agent('desk-chat', cwd)
    await host.emit('agent/created', agent)
    expect(agent.tools.has('director_query')).toBe(true)
    expect(agent.tools.has('space_plan_compile')).toBe(false)
    host.dispose()
  })

  it('starts a conversation with the editing group when the board has a video with a file', async () => {
    await startFilm()
    const host = fakeHost()
    installFilmAgentTools(host.ctx as never, { tools: () => filmCoreTools(services), groups: filmToolGroups(services), guidance: 'film guidance' })
    // An empty video node is not enough.
    await run('canvas_apply_ops', { ops: [{ type: 'add_node', id: 'shot', nodeType: 'video' }] })
    const early = host.agent('early', cwd)
    await host.emit('agent/created', early)
    expect(early.tools.has('director_query')).toBe(false)
    expect(early.tools.has('video_clip')).toBe(false)
    await run('canvas_apply_ops', { ops: [{ type: 'update_node', id: 'shot', metadata: { content: '/api/projects/p/raw/canvas/media/shot.mp4' } }] })
    const later = host.agent('later', cwd)
    await host.emit('agent/created', later)
    expect(later.tools.has('video_clip')).toBe(true)
    expect(later.tools.has('video_join')).toBe(true)
    expect(later.tools.has('director_query')).toBe(false)
    host.dispose()
  })

  it('film_tools lists the groups and enables them for the calling conversation', async () => {
    await startFilm()
    const host = fakeHost()
    const groups = filmToolGroups(services)
    let installer: ReturnType<typeof installFilmAgentTools> | undefined
    installer = installFilmAgentTools(host.ctx as never, { tools: () => filmCoreTools(services), groups, guidance: 'film guidance' })
    const agent = host.agent('chat', cwd)
    await host.emit('agent/created', agent)
    const tool = filmToolsTool(groups, () => installer)
    const exec = { ...execFor(cwd), agent } as never
    const listed = await tool.execute({}, exec) as { groups: Array<{ name: string; enabled: boolean; tools: string[] }> }
    expect(listed.groups.map(group => [group.name, group.enabled])).toEqual([['director', false], ['modeling', false], ['editing', false]])
    const enabled = await tool.execute({ enable: ['director'] }, exec) as { groups: Array<{ name: string; enabled: boolean }>; note: string }
    expect(enabled.groups.find(group => group.name === 'director')?.enabled).toBe(true)
    expect(agent.tools.has('director_stage')).toBe(true)
    await expect(tool.execute({ enable: ['nope'] }, exec)).rejects.toThrow(/enable/u)
    host.dispose()
  })
})
