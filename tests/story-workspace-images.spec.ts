/**
 * story_asset_bindings list hashes the workspace's images: only the new or
 * changed ones on each call, not up to a hundred images of any size every time.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({ paths: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const createReadStream = ((path: Parameters<typeof actual.createReadStream>[0], options?: Parameters<typeof actual.createReadStream>[1]) => {
    reads.paths.push(String(path))
    return actual.createReadStream(path, options)
  }) as typeof actual.createReadStream
  return { ...actual, createReadStream, default: { ...actual, createReadStream } }
})

const { filmAgentTools } = await import('../src/agent/index.js')
const { filmProjectTool } = await import('../src/agent/project-tool.js')
const { CanvasBoardAgent } = await import('../src/canvas/board-agent.js')
const { invalidateWorkspaceMedia } = await import('../src/media.js')
const { createStudioRouter } = await import('../src/routes.js')
const { ProjectEvents } = await import('../src/studio/events.js')

let cwd: string
let tools: Map<string, ToolDefinition>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-story-images-'))
  const events = new ProjectEvents()
  const boardAgent = new CanvasBoardAgent()
  const services = { studio: createStudioRouter({ events, boardAgent }), boardAgent, events, projectCreated: () => {} }
  tools = new Map([filmProjectTool(services), ...filmAgentTools(services)].map(tool => [tool.name, tool]))
  invalidateWorkspaceMedia()
  reads.paths.length = 0
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function run(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const context = {
    agent: { session: { header: { cwd } } },
    signal: new AbortController().signal,
    callId: 'call-1', rootCallId: 'call-1', name: 'test', arguments: {}, token: Symbol('call'),
    deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext
  return tools.get(name)!.execute(args, context)
}

describe('story_asset_bindings list', () => {
  it('hashes a workspace image again only when it changed', async () => {
    await run('film_project', { action: 'create', title: '雨夜来客' })
    await mkdir(join(cwd, 'media'), { recursive: true })
    await writeFile(join(cwd, 'media', 'a.png'), 'first image')
    await writeFile(join(cwd, 'media', 'b.png'), 'second image')
    const workspaceReads = (): number => reads.paths.filter(path => path.startsWith(join(cwd, 'media') + sep)).length

    const first = await run('story_asset_bindings', { action: 'list' })
    expect(first.workspaceImages.map((image: { path: string }) => image.path).sort()).toEqual(['media/a.png', 'media/b.png'])
    expect(workspaceReads()).toBe(2)
    const again = await run('story_asset_bindings', { action: 'list' })
    expect(again.workspaceImages).toEqual(first.workspaceImages)
    expect(workspaceReads()).toBe(2)

    await writeFile(join(cwd, 'media', 'a.png'), 'first image, retouched')
    const changed = await run('story_asset_bindings', { action: 'list' })
    expect(workspaceReads()).toBe(3)
    const digestOf = (list: Array<{ path: string; sha256: string }>, path: string): string | undefined => list.find(image => image.path === path)?.sha256
    expect(digestOf(changed.workspaceImages, 'media/a.png')).not.toBe(digestOf(first.workspaceImages, 'media/a.png'))
    expect(digestOf(changed.workspaceImages, 'media/b.png')).toBe(digestOf(first.workspaceImages, 'media/b.png'))
    expect(changed.workspaceImages.find((image: { path: string }) => image.path === 'media/a.png').sizeBytes).toBe('first image, retouched'.length)
  })
})
