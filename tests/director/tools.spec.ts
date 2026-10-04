/** The agent's director tools, called the way the agent loop calls them, against a real workspace and fake canvas pages. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filmAgentTools } from '../../src/agent/index.js'
import type { FilmToolServices } from '../../src/agent/index.js'
import { CanvasBoardAgent } from '../../src/canvas/board-agent.js'
import { CanvasDocumentStore } from '../../src/canvas/documents.js'
import { getDirectorProjectFingerprint } from '../../src/director/vendor/director-math/schema/projectFingerprint.js'
import { createProject } from '../../src/project.js'
import { createStudioRouter } from '../../src/routes.js'
import { ProjectEvents } from '../../src/studio/events.js'
import { character, lockedCamera, project } from './fixtures.js'
import { openDeskPage } from './pages.js'

let cwd: string
let film: string
let agent: CanvasBoardAgent
let tools: Map<string, ToolDefinition>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-director-tools-'))
  film = (await createProject(cwd, { title: '雨夜来客', aspectRatio: '16:9' })).project.id
  agent = new CanvasBoardAgent()
  const events = new ProjectEvents()
  const services: FilmToolServices = { studio: createStudioRouter({ events, boardAgent: agent }), boardAgent: agent, events, projectCreated: () => {} }
  tools = new Map(filmAgentTools(services).map(tool => [tool.name, tool]))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function exec(): ToolRunContext {
  return {
    agent: { session: { header: { cwd } } },
    signal: new AbortController().signal,
    callId: 'call-1', rootCallId: 'call-1', name: 'test', arguments: {}, token: Symbol('call'),
    deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext
}

async function run(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool.execute(args, exec())
}

const scene = () => project([character('a', [0, 0, 0]), character('b', [2, 0, 0])], [lockedCamera('cam', [1, 1.5, 6], [1, 1, 0])])
const board = (nodes: unknown[]) => new CanvasDocumentStore(cwd, film).write(film, { id: film, nodes, connections: [] })
const desk = (stored?: unknown, id = 'desk') => ({ id, type: 'director', metadata: stored === undefined ? {} : { directorProject: stored } })

describe('director tools', () => {
  it('stage a never-opened node, then query it, with summaries rather than documents', async () => {
    await board([desk()])
    const plan = { ops: [{ type: 'place_character', id: 'hero', at: [0, 0] }, { type: 'shot', cameraId: 'cam_hero', shot: { subject: 'hero', size: 'close' } }] }
    const dry = await run('director_stage', { plan, dryRun: true })
    expect(dry).toMatchObject({ written: false, applied: [{ type: 'place_character' }, { type: 'shot' }], diagnostics: { kind: 'diagnostics' } })
    expect(dry.project).toBeUndefined()
    expect((await run('director_stage', { plan, dryRun: true, includeProject: true })).project.objects).toHaveLength(2)
    const applied = await run('director_stage', { plan })
    expect(applied.written).toBe(true)
    const events = await run('director_query', { kind: 'events' })
    expect(events.fingerprint).toBe(applied.fingerprint)
    const structure = await run('director_query', { kind: 'structure' })
    expect(structure.cameras.map((camera: any) => camera.id)).toContain('cam_hero')
    const sample = await run('director_query', { kind: 'sample', at: [0, { eventId: 'missing' }] }).catch((error: Error) => error)
    expect(String(sample)).toMatch(/DIRECTOR_QUERY_INVALID/u)
  })

  it('stage an inline project and return it, since nothing else holds it', async () => {
    const staged = await run('director_stage', { directorProject: scene(), plan: { ops: [{ type: 'set_scene', collision: false }] } })
    expect(staged).toMatchObject({ written: false, desk: 'none' })
    expect(staged.project.scene.pathCollisionEnabled).toBe(false)
  })

  it('name the director nodes when the board has several', async () => {
    await board([desk(scene()), desk(scene(), 'desk-2')])
    await expect(run('director_query', { kind: 'structure' })).rejects.toThrow(/DIRECTOR_NODE_AMBIGUOUS.*directorNodes: \[\{"id":"desk"/u)
    expect((await run('director_query', { kind: 'structure', nodeId: 'desk-2' })).source).toEqual({ boardId: film, nodeId: 'desk-2' })
  })

  it('render through the desk page and say where the files are in the workspace', async () => {
    await board([desk(scene())])
    await expect(run('director_render', { frames: [{ cameraId: 'cam' }] })).rejects.toThrow(/CANVAS_BOARD_NOT_OPEN/u)
    const page = openDeskPage(agent, film, {
      deskOpen: true, scene: scene(),
      answer: name => name === 'director_render'
        ? { deskOpen: true, files: [{ kind: 'sheet', url: `/api/projects/${film}/raw/canvas/uploads/sheet.png`, fileName: 'sheet.png', width: 1280, height: 720, nodeId: 'n-9' }] }
        : undefined,
    })
    const rendered = await run('director_render', { sheet: true })
    expect(rendered.files).toEqual([expect.objectContaining({ path: 'canvas/uploads/sheet.png', workspacePath: 'film/canvas/uploads/sheet.png', nodeId: 'n-9' })])
    expect(rendered.next).toContain('read_image { file_path: "film/canvas/uploads/sheet.png" }')
    expect(page.calls.at(-1)).toMatchObject({ name: 'director_render', input: { request: { sheet: true } } })
    expect(await run('director_render_status')).toMatchObject({ desk: 'open', task: null })
    await expect(run('director_inspect_model', { objectId: 'a' })).rejects.toThrow(/DIRECTOR_MODEL_INVALID/u)
  })

  it('compile a motion into the film and hand back its import plan', async () => {
    const spec = { schemaVersion: 1, name: '点头', duration: 1, fps: 24, joints: { Head: [{ at: 0, degrees: [0, 0, 0] }, { at: 0.5, degrees: [20, 0, 0] }, { at: 1, degrees: [0, 0, 0] }] } }
    const compiled = await run('director_compile_motion', { requestId: 'nod-1', spec })
    expect(compiled).toMatchObject({ status: 'done', file: { importPlan: { ops: [{ type: 'import_animation' }] } } })
    expect((await readFile(join(cwd, 'film', compiled.file.filePath))).subarray(0, 4).toString()).toBe('glTF')
  })

  it('review, and prepare modeling briefs for the film and for a director target', async () => {
    await board([desk(scene())])
    expect(await run('director_review', { action: 'list' })).toMatchObject({ versions: [], currentFingerprint: getDirectorProjectFingerprint(scene()) })
    const plain = await run('model_brief', { kind: 'prop', description: '旧木椅' })
    expect(plain).toMatchObject({ projectId: film, skillIds: ['img2threejs'], note: expect.stringContaining('film/models/') })
    const targeted = await run('director_modeling_brief', { kind: 'scene', description: '客栈大堂', context: { nodeId: 'desk', objectIds: ['a'] } })
    expect(targeted.context).toMatchObject({ projectId: film, boardId: film, view: 'director', director: { nodeId: 'desk', objectIds: ['a'] } })
    expect(targeted.skillIds).toEqual(['director', 'img2threejs'])
  })
})
