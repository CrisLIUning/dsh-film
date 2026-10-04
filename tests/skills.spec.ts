/**
 * The shipped skills as files: sizes the model receives intact, frontmatter
 * the provider accepts, links that resolve one level deep, tool names that
 * exist, and example batches that really apply — against the contracts and
 * through the agent's own tools. Ported from Studio's
 * e2e/tests/screenwriter/film-skills.test.ts and DSH's
 * packages/preset/agent-preset/tests/skills.spec.ts.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { filmAgentTools } from '../src/agent/index.js'
import type { FilmToolServices } from '../src/agent/index.js'
import { filmProjectTool } from '../src/agent/project-tool.js'
import { CanvasBoardAgent } from '../src/canvas/board-agent.js'
import { createStudioRouter } from '../src/routes.js'
import { applyStoryOperations, createStoryMarkdown, parseStoryMarkdown, StoryOperationSchema } from '../src/screenwriter/contracts/index.js'
import type { StoryOperation, StoryParseResult } from '../src/screenwriter/contracts/index.js'
import { ProjectEvents } from '../src/studio/events.js'
import { FILM_SKILL_NAMES, SKILLS_ROOT, parseSkillFile } from '../src/skills.js'

/** DSH prunes a tool result above 8,192 code points to its head and tail once compaction runs. */
const PRUNER_THRESHOLD = 8192
/** The skill catalog shows at most this many characters of a description. */
const CATALOG_DESCRIPTION_LIMIT = 500

/**
 * Tools the skill may name before they exist: being added on other branches.
 * When one lands, drop it here — the test then checks it against the real tool list.
 */
const PLANNED_TOOLS = ['story_import', 'story_export', 'story_source', 'story_handoff', 'story_adopt', 'story_impact', 'story_director_links']

const codePoints = (text: string): number => [...text].length
const dir = (name: string): string => join(SKILLS_ROOT, name)
const read = (path: string): string => readFileSync(path, 'utf8')
const references = (name: string): string[] => existsSync(join(dir(name), 'references'))
  ? readdirSync(join(dir(name), 'references')).filter(file => file.endsWith('.md')).sort()
  : []
const skillFiles = (name: string): string[] => [join(dir(name), 'SKILL.md'), ...references(name).map(file => join(dir(name), 'references', file))]

/** The `skill` tool's answer (dsh-skill's renderSkillContent), with a long installed base path. */
function rendered(name: string, content: string): string {
  const base = join('C:\\Users\\someone\\AppData\\Local\\Programs\\VibeDev\\resources\\plugins\\node_modules\\dsh-film\\skills', name)
  return [
    `<skill_content name="${name}">`, '<skill_resources>',
    `Base directory for this skill: ${base}`,
    'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    '</skill_resources>', '', '<skill_instructions>', content, '</skill_instructions>', '</skill_content>',
  ].join('\n')
}

/** The `read` tool's answer: each line as `N: text`. */
const numbered = (text: string): string => text.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n')

/** Every `<!-- batch:X -->` JSON example in a skill file. */
function batches(path: string): Map<string, StoryOperation[]> {
  const found = new Map<string, StoryOperation[]>()
  for (const match of read(path).matchAll(/<!-- batch:([A-Z]) -->\r?\n```json\r?\n([\s\S]*?)\r?\n```/gu)) {
    found.set(match[1]!, JSON.parse(match[2]!) as StoryOperation[])
  }
  return found
}

const fresh = (): string => createStoryMarkdown({ documentId: 'doc_skill', title: '示例', kind: 'short' })

function apply(source: string, operations: StoryOperation[]): { markdown: string; parsed: StoryParseResult } {
  const result = applyStoryOperations(source, operations)
  const parsed = parseStoryMarkdown(result.markdown)
  expect(parsed.semanticEditable).toBe(true)
  expect(parsed.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  return { markdown: result.markdown, parsed }
}

describe('the shipped skills', () => {
  it('ship every skill folder the provider lists, and nothing else', () => {
    expect(readdirSync(SKILLS_ROOT).sort()).toEqual([...FILM_SKILL_NAMES].sort())
    const manifest = JSON.parse(read(join(SKILLS_ROOT, '..', 'package.json'))) as { files: string[] }
    expect(manifest.files).toContain('skills')
  })

  it.each([...FILM_SKILL_NAMES])('%s: frontmatter the provider and the catalog accept', (name) => {
    const raw = read(join(dir(name), 'SKILL.md'))
    const parsed = parseSkillFile(raw, name)
    expect(parsed.name).toBe(name)
    const keys = raw.split('\n---')[0]!.split('\n').slice(1).filter(line => /^\S/u.test(line)).map(line => line.split(':')[0])
    expect(keys.every(key => ['name', 'description', 'metadata'].includes(key!))).toBe(true)
    expect(parsed.description.replace(/\s+/gu, ' ').length).toBeLessThanOrEqual(CATALOG_DESCRIPTION_LIMIT)
    expect(parsed.description).not.toMatch(/[<>]/u)
    expect(parsed.metadata).toMatchObject({ zh_name: expect.any(String), en_name: expect.any(String) })
  })

  it.each([...FILM_SKILL_NAMES])('%s: every file reaches the model intact', (name) => {
    for (const path of skillFiles(name)) {
      const text = read(path)
      expect(codePoints(text), path).toBeLessThan(PRUNER_THRESHOLD)
      if (text.split('\n').length > 100) expect(text, `${path} needs a table of contents`).toMatch(/^## Contents$/mu)
    }
    expect(codePoints(rendered(name, parseSkillFile(read(join(dir(name), 'SKILL.md')), name).content))).toBeLessThan(PRUNER_THRESHOLD)
    for (const file of references(name)) {
      const text = read(join(dir(name), 'references', file))
      expect(codePoints(numbered(text)), file).toBeLessThan(PRUNER_THRESHOLD)
      expect(text, `${file} needs a table of contents`).toMatch(/^## Contents$/mu)
    }
  })

  it.each([...FILM_SKILL_NAMES])('%s: links resolve, one level deep, and every reference is linked', (name) => {
    const body = read(join(dir(name), 'SKILL.md'))
    const linked = [...body.matchAll(/\]\(([^)]+)\)/gu)].map(match => match[1]!)
    for (const target of linked) {
      expect(target, `${name} links ${target}`).toMatch(/^references\/[a-z0-9-]+\.md$/u)
      expect(statSync(join(dir(name), target)).isFile()).toBe(true)
    }
    expect([...new Set(linked)].sort()).toEqual(references(name).map(file => `references/${file}`))
    for (const file of references(name)) {
      const text = read(join(dir(name), 'references', file))
      // References name their siblings by bare file name: the model reads them from the same folder.
      expect(text, `${file} links further down`).not.toMatch(/\]\(|references\//u)
      for (const match of text.matchAll(/\b([a-z0-9-]+\.md)\b/gu)) {
        expect(references(name), `${file} mentions ${match[1]}`).toContain(match[1])
      }
    }
  })

  it.each([...FILM_SKILL_NAMES])('%s: names only tools that exist, or planned ones marked as such', (name) => {
    const services = { studio: createStudioRouter({}), boardAgent: new CanvasBoardAgent(), events: new ProjectEvents(), projectCreated: () => {} }
    const existing = new Set([filmProjectTool(services), ...filmAgentTools(services)].map(tool => tool.name))
    for (const planned of PLANNED_TOOLS) expect(existing.has(planned), `${planned} has landed: drop it from PLANNED_TOOLS`).toBe(false)
    for (const path of skillFiles(name)) {
      const text = read(path)
      for (const match of text.matchAll(/\b(?:film|story|canvas|timeline)_[a-z_]+\b/gu)) {
        const tool = match[0]
        expect(existing.has(tool) || PLANNED_TOOLS.includes(tool), `${path} names ${tool}`).toBe(true)
      }
      // A planned tool is only ever offered conditionally.
      for (const paragraph of text.split(/\r?\n\s*\r?\n/u)) {
        for (const planned of PLANNED_TOOLS.filter(tool => paragraph.includes(tool))) {
          expect(paragraph, `${path}: ${planned} without "available"`).toMatch(/\bavailable\b/u)
        }
      }
    }
  })
})

describe('film-screenwriting operations', () => {
  const skill = dir('film-screenwriting')
  const shipped = new Map([...batches(join(skill, 'references', 'operations.md')), ...batches(join(skill, 'references', 'handoff.md'))])

  it('ships batches A–E', () => {
    expect([...shipped.keys()].sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('documents every operation the contracts accept, except the ones story_asset_bindings owns', () => {
    const table = read(join(skill, 'references', 'operations.md')).split('## Operation shapes')[1]!.split('\n## ')[0]!
    const documented = new Set([...table.matchAll(/^\| ([a-zA-Z /]+) \|/gmu)].flatMap(match => match[1]!.split('/').map(kind => kind.trim())).filter(kind => kind !== 'Kind'))
    const contract = StoryOperationSchema.options.map(option => option.shape.kind.value).filter(kind => kind !== 'upsertAsset' && kind !== 'upsertBinding')
    expect([...documented].sort()).toEqual([...contract].sort())
    // The tool's own description lists the same operations, so it stays usable without the skill.
    const services = { studio: createStudioRouter({}), boardAgent: new CanvasBoardAgent(), events: new ProjectEvents(), projectCreated: () => {} }
    const description = filmAgentTools(services).find(tool => tool.name === 'story_apply_ops')!.description
    for (const kind of contract) expect(description, kind).toContain(`"${kind}"`)
  })

  it('apply cleanly to the contracts, in the order the files give', () => {
    const a = apply(fresh(), shipped.get('A')!)
    expect(a.parsed.metadata!.scenes).toHaveLength(1)
    expect(a.parsed.metadata!.entities).toEqual([])

    const b = apply(fresh(), shipped.get('B')!)
    expect(b.parsed.metadata!.speech).toEqual([{ id: 'speech_guest_line', blockId: 'blk_guest_line', speakerId: 'person_guest' }])

    const c = apply(b.markdown, shipped.get('C')!)
    const scene = c.parsed.metadata!.scenes.find(item => item.id === 'scene_shop_night')!
    const order = c.parsed.blocks.map(block => block.id).filter(id => scene.blockIds.includes(id))
    expect(order).toEqual(scene.blockIds)
    expect(scene.blockIds).toEqual(['blk_shop_heading', 'blk_shop_action', 'blk_guest_line', 'blk_owner_action', 'blk_owner_line'])
    expect(c.parsed.metadata!.speech.map(item => item.speakerId)).toEqual(['person_guest', 'person_owner'])

    const d = apply(c.markdown, shipped.get('D')!)
    const before = new Map(c.parsed.blocks.map(block => [block.id, block.markdown]))
    for (const block of d.parsed.blocks) {
      if (block.id === 'blk_shop_action') expect(block.markdown).toContain('门留了一道缝')
      else if (block.id === 'blk_guest_line') expect(block.markdown).toContain('**小舟**')
      else if (block.id === 'blk_guest_profile') expect(block.markdown).toContain('### 小舟')
      else expect(block.markdown, block.id).toBe(before.get(block.id))
    }

    const e = apply(d.markdown, shipped.get('E')!)
    const metadata = e.parsed.metadata!
    expect(metadata.document).toMatchObject({ visualStyle: expect.stringContaining('台灯') })
    expect(metadata.entities.find(item => item.id === 'person_guest')).toMatchObject({ visualIdentity: expect.any(String), visualState: expect.any(String) })
    expect(metadata.appearances).toHaveLength(1)
    expect(metadata.shots.map(item => item.id)).toEqual(['shot_shop_01'])
  })

  it('apply through the agent\'s tools, with expectedMarkdown as story_query returns it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-film-skill-'))
    try {
      const events = new ProjectEvents()
      const boardAgent = new CanvasBoardAgent()
      const services: FilmToolServices = { studio: createStudioRouter({ events, boardAgent }), boardAgent, events, projectCreated: () => {} }
      const tools = new Map<string, ToolDefinition>([filmProjectTool(services), ...filmAgentTools(services)].map(tool => [tool.name, tool]))
      const exec = { agent: { session: { header: { cwd } } }, signal: new AbortController().signal, callId: 'c', rootCallId: 'c', name: 't', arguments: {},
        token: Symbol('call'), deferContext() {}, concludeTurn() {} } as unknown as ToolRunContext
      const run = async (name: string, args: Record<string, unknown>): Promise<any> => tools.get(name)!.execute(args, exec)

      await run('film_project', { action: 'create', title: '修表铺' })
      let { documentId, revision } = (await run('story_create', { title: '修表铺' })).document as { documentId: string; revision: string }
      for (const key of ['B', 'C', 'D', 'E']) {
        if (key === 'D') {
          // The batch's expectedMarkdown must be exactly what a read returns.
          const replace = shipped.get('D')!.find(operation => operation.kind === 'replaceBlock') as { blockId: string; expectedMarkdown: string }
          const content = await run('story_query', { documentId, kind: 'content', ids: [replace.blockId] })
          expect(content.items).toEqual([expect.objectContaining({ id: replace.blockId, markdown: replace.expectedMarkdown })])
        }
        const args = { documentId, expectedRevision: revision, operations: shipped.get(key), operationId: `op_skill_${key}` }
        const preview = await run('story_apply_ops', { ...args, dryRun: true })
        expect(preview).toMatchObject({ dryRun: true, changed: true })
        const saved = await run('story_apply_ops', args)
        expect(saved).toMatchObject({ changed: true, document: { semanticEditable: true } })
        revision = saved.document.revision as string
      }
      const index = await run('story_query', { documentId })
      expect(JSON.stringify(index)).toContain('小舟')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
