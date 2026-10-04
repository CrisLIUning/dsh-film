/** The agent's film tools, called the way the agent loop calls them, against a real workspace. */

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filmAgentTools, filmCoreTools, filmToolGroups, filmToolsTool } from '../src/agent/index.js'
import type { FilmToolServices } from '../src/agent/index.js'
import { GUIDANCE_SECTION, installFilmAgentTools } from '../src/agent/install.js'
import { filmProjectTool } from '../src/agent/project-tool.js'
import { CanvasBoardAgent } from '../src/canvas/board-agent.js'
import type { BoardLease, BoardTarget } from '../src/canvas/board-agent.js'
import { applyBoardOps } from '../src/canvas/board-ops.js'
import type { BoardOp, BoardSnapshot } from '../src/canvas/board-ops.js'
import { createStudioRouter } from '../src/routes.js'
import { ProjectEvents } from '../src/studio/events.js'
import type { ProjectEvent } from '../src/studio/events.js'
import type { EventStream } from '../src/studio/sse.js'

let cwd: string
let events: ProjectEvents
let boardAgent: CanvasBoardAgent
let services: FilmToolServices
let created: string[]
let tools: Map<string, ToolDefinition>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-agent-'))
  events = new ProjectEvents()
  boardAgent = new CanvasBoardAgent()
  created = []
  services = { studio: createStudioRouter({ events, boardAgent }), boardAgent, events, projectCreated: (dir) => { created.push(dir) } }
  tools = new Map([filmProjectTool(services), ...filmAgentTools(services)].map(tool => [tool.name, tool]))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
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
      'canvas_create_text_nodes', 'canvas_create_generation_flow', 'canvas_run_generation', 'canvas_connect_nodes', 'canvas_delete_nodes',
      'canvas_apply_ops', 'canvas_attach_media',
      'timeline_query', 'timeline_edit',
      'timeline_transcribe', 'timeline_apply_captions', 'media_get_task', 'media_cancel_task',
      'timeline_render',
      'director_query', 'director_stage', 'director_render', 'director_render_status', 'director_render_cancel', 'director_inspect_model', 'director_review', 'director_compile_motion', 'director_modeling_brief',
      'space_plan_compile', 'model_brief', 'model_review', 'model_adopt', 'model_status', 'model_report', 'model_cancel',
    ])
    for (const tool of tools.values()) {
      expect(tool.parameters).toMatchObject({ type: 'object' })
      expect(tool.description.length).toBeGreaterThan(40)
    }
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
})

describe('storyboard tools with a page open', () => {
  /** A canvas page: it takes its lease, reports its board and answers calls with the board's executor. */
  function openPage(projectId: string, behaviour: { refuse?: string; silent?: boolean } = {}) {
    const sent: Array<{ event: string; data: any }> = []
    let board: BoardSnapshot = { projectId, title: '雨夜来客', nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }
    let lease!: BoardLease
    let sequence = 1
    let closed = false
    const stream: EventStream = {
      send(event, data) {
        if (closed) return false
        sent.push({ event, data })
        if (event === 'tool_call' && behaviour.silent !== true) {
          const call = data as { requestId: string; input: { ops: BoardOp[] } }
          queueMicrotask(() => {
            if (behaviour.refuse !== undefined) {
              boardAgent.resolve(lease, { requestId: call.requestId, error: behaviour.refuse })
              return
            }
            board = applyBoardOps(board, call.input.ops)
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
    return { sent, target, lease, release, board: () => board }
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
    await new Promise(resolve => setTimeout(resolve, 10))
    silent.release()
    await expect(pending).rejects.toThrow(/CANVAS_BOARD_GONE/)
  })

  it('refuses to write around a page that is still loading its board', async () => {
    const film = await startFilm()
    const sent: unknown[] = []
    boardAgent.connect({ projectId: film.id, clientId: 'page-2', incarnation: 'load-2' }, { send: (_event, data) => { sent.push(data); return true }, close() {}, closed: false })
    await expect(run('canvas_create_text_nodes', { items: [{ text: '镜 1' }] })).rejects.toThrow(/CANVAS_BOARD_NOT_READY/)
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
})

describe('timeline tools', () => {
  it('reads the cut and the board\'s material, previews and applies a placement on the revision', async () => {
    const film = await startFilm()
    expect(await run('timeline_query')).toEqual({ revision: 0, empty: true, note: 'This film has no cut yet.' })
    expect(await run('timeline_query', { kind: 'board' })).toEqual({ media: [], scripts: [] })
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'still.png'), 'png')
    await run('canvas_apply_ops', { ops: [
      { type: 'add_node', id: 'img-1', nodeType: 'image', title: '客栈外景', metadata: { content: `/api/projects/${film.id}/raw/canvas/media/still.png` } },
      { type: 'add_node', id: 'script', nodeType: 'text', metadata: { content: '老板：客官里面请。\n来客：一碗热汤。' } },
    ] })
    const offered = await run('timeline_query', { kind: 'board' })
    expect(offered.media).toEqual([expect.objectContaining({ nodeId: 'img-1', kind: 'image', path: 'canvas/media/still.png' })])
    expect(offered.scripts).toEqual([expect.objectContaining({ id: 'script', source: 'board', lineCount: 2 })])

    await expect(run('timeline_edit', { place: { nodeId: 'img-1' } })).rejects.toThrow(/baseRevision/)
    await expect(run('timeline_edit', { baseRevision: 0, place: { nodeId: 'img-1' }, sound: { loudness: -14 } })).rejects.toThrow(/exactly one/)
    const preview = await run('timeline_edit', { dryRun: true, place: { nodeId: 'img-1', durationSeconds: 3 } })
    expect(preview.result).toMatchObject({ committed: false, revision: 0 })
    expect(preview.result.before).toBeUndefined()
    expect(preview.result.after).toBeUndefined()
    const placed = await run('timeline_edit', { baseRevision: 0, place: { nodeId: 'img-1', durationSeconds: 3 }, operationId: 'op-place' })
    expect(placed).toMatchObject({ result: { committed: true, revision: 1 }, placed: { clipId: 'op-place-visuals', track: 'visuals', durationSeconds: 3 } })
    expect(await run('timeline_query')).toMatchObject({ revision: 1, visuals: [{ id: 'op-place-visuals', start: 0, duration: 3 }] })
    await expect(run('timeline_edit', { baseRevision: 0, place: { nodeId: 'img-1' } })).rejects.toThrow(/CANVAS_TIMELINE_CONFLICT.*current revision: 1/u)
  })

  it('previews a raw command plan against the current cut', async () => {
    await startFilm()
    const preview = await run('timeline_edit', { dryRun: true, operations: [{ id: 'ratio-1', type: 'project.set_ratio', ratio: '9:16' }] })
    expect(preview.result).toMatchObject({ committed: false, revision: 0 })
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
    expect(listed.groups.map(group => [group.name, group.enabled])).toEqual([['director', false], ['modeling', false]])
    const enabled = await tool.execute({ enable: ['director'] }, exec) as { groups: Array<{ name: string; enabled: boolean }>; note: string }
    expect(enabled.groups.find(group => group.name === 'director')?.enabled).toBe(true)
    expect(agent.tools.has('director_stage')).toBe(true)
    await expect(tool.execute({ enable: ['nope'] }, exec)).rejects.toThrow(/enable/u)
    host.dispose()
  })
})
