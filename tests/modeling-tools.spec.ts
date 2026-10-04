/** The agent's modeling tools, called the way the agent loop calls them, against a real workspace. */

import { mkdir, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filmAgentTools } from '../src/agent/index.js'
import type { FilmToolServices } from '../src/agent/index.js'
import { filmProjectTool } from '../src/agent/project-tool.js'
import { CanvasBoardAgent } from '../src/canvas/board-agent.js'
import { createModelRecord, readModelRecord, upsertModelVersion, writeModelRecord } from '../src/modeling/store.js'
import { createStudioRouter } from '../src/routes.js'
import { ProjectEvents } from '../src/studio/events.js'

let cwd: string
let tools: Map<string, ToolDefinition>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-modeling-tools-'))
  const events = new ProjectEvents()
  const boardAgent = new CanvasBoardAgent()
  const studio = createStudioRouter({ events, boardAgent, modelEnvironment: async () => ({ browser: { found: false }, python: { found: false } }) })
  const services: FilmToolServices = { studio, boardAgent, events, projectCreated: () => {} }
  tools = new Map([filmProjectTool(services), ...filmAgentTools(services)].map(tool => [tool.name, tool]))
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

async function startFilm(): Promise<string> {
  return (await run('film_project', { action: 'create', title: '古堡' })).project.id
}

const PLAN = {
  name: '门厅',
  footprint: { width: 12000, depth: 8000 },
  levels: [{ id: 'f1', name: '一层', elevation: 0, height: 3000 }, { id: 'f2', name: '二层', elevation: 3000, height: 3000 }],
  stairs: [{ id: 's1', from: 'f1', to: 'f2', at: [-2380, 0], width: 1200, direction: 'east' }],
}

describe('space_plan_compile', () => {
  it('previews with dryRun, then writes the building into film/spaces/ and answers a summary, not the bytes', async () => {
    const projectId = await startFilm()
    const draft = await run('space_plan_compile', { plan: PLAN, dryRun: true })
    expect(draft).toMatchObject({ written: false, file: 'spaces/门厅.glb', warnings: [], levels: ['f1-一层', 'f2-二层', 's1'] })
    const written = await run('space_plan_compile', { plan: PLAN, output: 'hall' })
    expect(written).toMatchObject({ written: true, file: 'spaces/hall.glb', url: `/api/projects/${projectId}/raw/spaces/hall.glb` })
    const glb = await readFile(join(cwd, 'film', 'spaces', 'hall.glb'))
    expect(written.bytes).toBe(glb.length)
    expect(written.sha256).toBe(draft.sha256)
    expect(JSON.stringify(written).length).toBeLessThan(4000)
  })

  it('reports a strict refusal and a malformed plan with their codes', async () => {
    await startFilm()
    await expect(run('space_plan_compile', { plan: { ...PLAN, stairs: [] }, strict: true })).rejects.toThrow(/^SPACE_PLAN_NOT_CLEAN: 平面有未解决的问题/)
    await expect(run('space_plan_compile', { plan: { ...PLAN, footprint: { width: -1, depth: 8000 } } })).rejects.toThrow(/^SPACE_PLAN_INVALID: 平面字段无效：footprint\.width/)
  })

  it('needs a film', async () => {
    await expect(run('space_plan_compile', { plan: PLAN })).rejects.toThrow(/FILM_NO_PROJECT/)
  })
})

describe('model_brief', () => {
  it('prepares the brief, folding film/ off reference paths and filling a director target with the film\'s ids', async () => {
    const projectId = await startFilm()
    const brief = await run('model_brief', { kind: 'prop', description: '一只铜壶', references: ['film/models/pot/ref.png'] })
    expect(brief.skillIds).toEqual(['img2threejs'])
    expect(brief.prompt).toContain('"models/pot/ref.png"')
    const staged = await run('model_brief', { kind: 'scene', description: '地下酒窖', context: { nodeId: 'desk-1', objectIds: ['o1'] } })
    expect(staged.context).toMatchObject({ projectId, boardId: projectId, view: 'director', director: { nodeId: 'desk-1', objectIds: ['o1'] } })
    // A target without objects still names the desk's node: the brief is not refused.
    expect((await run('model_brief', { kind: 'prop', description: '铜壶', context: { nodeId: 'desk-1' } })).context).toMatchObject({ view: 'director', director: { nodeId: 'desk-1', objectIds: [] } })
    await expect(run('model_brief', { kind: 'prop', description: '' })).rejects.toThrow(/^MODELING_BRIEF_INVALID: 建模描述需要 1–8000 字/)
  })
})

describe('the model record tools', () => {
  const V1 = 'c'.repeat(64)
  const V2 = 'd'.repeat(64)
  const inputs = (seed: string) => ({
    entry: 'models/crate/crate.ts', sources: [{ path: 'models/crate/crate.ts', sha256: seed, bytes: 1 }], resources: [], parameters: { size: 1 },
    toolchain: { three: '0.184.0', bundler: 'esbuild', bundlerVersion: '0.28.0', runtime: 'model-runtime@x' },
  })

  beforeEach(async () => {
    await startFilm()
    await mkdir(join(cwd, 'film', 'models', 'crate'), { recursive: true })
    await writeFile(join(cwd, 'film', 'models', 'crate', 'crate.ts'), 'export function createCrateModel(){}')
    let record = createModelRecord({ id: 'crate', kind: 'prop', title: '木箱', now: '2026-09-08T00:00:00.000Z' })
    record = upsertModelVersion(record, V1, inputs(V1), '2026-09-08T00:00:00.000Z')
    record = upsertModelVersion(record, V2, inputs(V2), '2026-09-08T01:00:00.000Z')
    record = {
      ...record,
      runs: [
        { runId: 'r2', kind: 'glb-export', versionId: V2, status: 'running', requestedBy: 'mcp', startedAt: '2026-09-08T01:00:00.000Z', artifacts: [], checkIds: [] },
        {
          runId: 'r1', kind: 'mesh-dump', versionId: V1, status: 'succeeded', requestedBy: 'mcp', startedAt: '2026-09-08T00:00:00.000Z', endedAt: '2026-09-08T00:01:00.000Z',
          input: { entry: 'models/crate/crate.ts', parameters: {}, resources: [] },
          artifacts: [{ path: 'models/crate/versions/cccc/meshes.json', sha256: 'e'.repeat(64), bytes: 9, versionId: V1, runId: 'r1', producedAt: '2026-09-08T00:01:00.000Z' }],
          checkIds: ['k1'],
        },
      ],
      checks: [
        { id: 'k1', gate: 'executed-geometry', versionId: V2, runId: 'r1', applicability: 'applicable', verdict: 'pass', reason: '3 个网格' },
        { id: 'k2', gate: 'turntable_gate', versionId: V2, runId: 'r1', applicability: 'not-run', reason: '截图链未接' },
      ],
    }
    await writeModelRecord(cwd, record)
  })

  it('model_report summarises the record: versions with inputs by path, staleness, checks, notes and runs', async () => {
    const report = await run('model_report', { model: 'crate' })
    expect(report.model).toMatchObject({ id: 'crate', kind: 'prop', title: '木箱' })
    expect(report.versionCount).toBe(2)
    expect(report.versions[0]).toMatchObject({ versionId: V2, quality: { verdict: 'incomplete', notRunGates: ['turntable_gate'] }, inputs: { entry: 'models/crate/crate.ts', sources: ['models/crate/crate.ts'], parameters: { size: 1 } } })
    expect(report.reviewAspects).toEqual(['form', 'material', 'size'])
    expect(report.staleness).toMatchObject({ known: false, artifactsNeedingUpdate: 1 })
    expect(report.newestVersionChecks).toEqual([
      { gate: 'executed-geometry', applicability: 'applicable', verdict: 'pass', reason: '3 个网格' },
      { gate: 'turntable_gate', applicability: 'not-run', reason: '截图链未接' },
    ])
    expect(report.recentRuns).toEqual([
      expect.objectContaining({ runId: 'r2', status: 'interrupted' }),
      expect.objectContaining({ runId: 'r1', status: 'succeeded', artifacts: ['models/crate/versions/cccc/meshes.json'], checks: 1 }),
    ])
    expect(report).not.toHaveProperty('record')
  })

  it('model_status lists runs or reads one, newest first, a stalled one as interrupted', async () => {
    const listed = await run('model_status', { model: 'crate' })
    expect(listed.total).toBe(2)
    expect(listed.runs.map((entry: { runId: string; status: string }) => [entry.runId, entry.status])).toEqual([['r2', 'interrupted'], ['r1', 'succeeded']])
    expect(listed.runs[1]).not.toHaveProperty('input')
    expect((await run('model_status', { model: 'crate', run: 'r1' })).run).toMatchObject({ runId: 'r1', kind: 'mesh-dump', versionId: V1 })
    await expect(run('model_status', { model: 'crate', run: 'nope' })).rejects.toThrow(/^MODEL_RUN_NOT_FOUND/)
    await expect(run('model_status', { model: '../x' })).rejects.toThrow(/^MODEL_ID_INVALID/)
  })

  it('model_review adds a note against the newest version and resolves it; model_adopt records the choice', async () => {
    const added = await run('model_review', { model: 'crate', action: 'add', aspect: 'material', concern: '木纹太亮' })
    expect(added.note).toMatchObject({ versionId: V2, aspect: 'material', raisedBy: 'agent', status: 'open' })
    await expect(run('model_review', { model: 'crate', action: 'add', concern: ' ' })).rejects.toThrow(/^MODEL_REVIEW_EMPTY: 审阅要写清楚具体问题/)
    await expect(run('model_review', { model: 'crate', action: 'resolve', noteId: added.note.id })).rejects.toThrow(/resolve 需要 noteId 和 status/)
    const resolved = await run('model_review', { model: 'crate', action: 'resolve', noteId: added.note.id, status: 'dismissed', resolution: '用户喜欢' })
    expect(resolved.note).toMatchObject({ status: 'dismissed', resolution: '用户喜欢' })
    const adopted = await run('model_adopt', { model: 'crate', versionId: V1 })
    expect(adopted).toMatchObject({ adoptedVersionId: V1 })
    expect((await readModelRecord(cwd, 'crate'))?.adoptedVersionId).toBe(V1)
    await expect(run('model_adopt', { model: 'crate', versionId: 'f'.repeat(64) })).rejects.toThrow(/^MODEL_ADOPT_REJECTED/)
  })

  it('model_cancel answers the run as recorded', async () => {
    expect((await run('model_cancel', { model: 'crate', run: 'r2' })).run).toMatchObject({ runId: 'r2', status: 'interrupted' })
    await expect(run('model_cancel', { model: 'ghost', run: 'r2' })).rejects.toThrow(/^MODEL_RUN_NOT_FOUND/)
  })
})
