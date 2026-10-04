/** The skills provider: what the skill registry is given, and the plugin with and without a registry. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Film from '../src/index.js'
import { FILM_SKILL_PROVIDER, FILM_SKILL_RANK, SKILLS_ROOT, filmSkillCandidates, filmSkillProvider, parseSkillFile, registerFilmSkills } from '../src/skills.js'
import type { FilmSkillProvider, SkillsServiceLike } from '../src/skills.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-skills-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

/** A stand-in for DSH's skill registry that keeps what it is given. */
function fakeSkills(): SkillsServiceLike & { providers: FilmSkillProvider[]; removed: number } {
  const fake = {
    providers: [] as FilmSkillProvider[],
    removed: 0,
    registerProvider(create: Parameters<SkillsServiceLike['registerProvider']>[0]) {
      const provider = create({ signal: new AbortController().signal, invalidate: () => {} })
      fake.providers.push(provider)
      return () => { fake.removed += 1 }
    },
  }
  return fake
}

describe('parseSkillFile', () => {
  it('reads name, description and metadata, and returns the body without frontmatter', () => {
    const parsed = parseSkillFile('---\nname: a-skill\ndescription: "Does a thing."\nmetadata:\n  zh_name: 甲\n---\n\n# Body\n', 'x')
    expect(parsed).toEqual({ name: 'a-skill', description: 'Does a thing.', metadata: { zh_name: '甲' }, content: '# Body' })
    expect(parseSkillFile('﻿---\r\nname: b\r\ndescription: d\r\n---\r\nbody\r\n', 'x')).toEqual({ name: 'b', description: 'd', content: 'body' })
  })

  it('refuses what it cannot read faithfully', () => {
    expect(() => parseSkillFile('# no frontmatter', 'x')).toThrow(/no frontmatter/)
    expect(() => parseSkillFile('---\nname: a\ndescription: d\n', 'x')).toThrow(/unclosed/)
    expect(() => parseSkillFile('---\nname: Not Kebab\ndescription: d\n---\n', 'x')).toThrow(/kebab-case/)
    expect(() => parseSkillFile('---\nname: a\n---\n', 'x')).toThrow(/description/)
    expect(() => parseSkillFile('---\nname: a\ndescription: >\n  folded\n---\n', 'x')).toThrow(/unsupported/)
  })
})

describe('the skills provider', () => {
  it('lists the packaged skills as bundled skills with their folder as the resource base', async () => {
    const provider = filmSkillProvider(filmSkillCandidates())
    const [candidate, ...rest] = await provider.list({ cwd })
    expect(rest).toEqual([])
    expect(candidate).toMatchObject({
      name: 'film-screenwriting', provider: FILM_SKILL_PROVIDER, source: 'bundled', rank: 600,
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: join(SKILLS_ROOT, 'film-screenwriting') },
      metadata: { zh_name: '编剧' },
    })
    expect(FILM_SKILL_RANK).toBe(600)
    const loaded = await provider.get(candidate!, { cwd })
    const raw = readFileSync(join(SKILLS_ROOT, 'film-screenwriting', 'SKILL.md'), 'utf8')
    expect(loaded?.content).toBe(parseSkillFile(raw, 'SKILL.md').content)
    expect(loaded?.content.startsWith('# Film screenwriting')).toBe(true)
    expect(loaded).not.toHaveProperty('rank')
    expect(loaded).not.toHaveProperty('locator')
  })

  it('re-reads a body on every load, and answers nothing for a file that is gone', async () => {
    const root = join(cwd, 'skills')
    await mkdir(join(root, 'film-screenwriting'), { recursive: true })
    const path = join(root, 'film-screenwriting', 'SKILL.md')
    await writeFile(path, '---\nname: film-screenwriting\ndescription: d\n---\nfirst\n')
    const provider = filmSkillProvider(filmSkillCandidates(root))
    const [candidate] = await provider.list({})
    await writeFile(path, '---\nname: film-screenwriting\ndescription: d\n---\nsecond\n')
    expect((await provider.get(candidate!, {}))?.content).toBe('second')
    await rm(path)
    expect(await provider.get(candidate!, {})).toBeUndefined()
  })

  it('refuses a skill whose folder and name disagree', async () => {
    const root = join(cwd, 'skills')
    await mkdir(join(root, 'film-screenwriting'), { recursive: true })
    await writeFile(join(root, 'film-screenwriting', 'SKILL.md'), '---\nname: other-name\ndescription: d\n---\nbody\n')
    expect(() => filmSkillCandidates(root)).toThrow(/is named other-name/)
  })

  it('registers one provider with the registry', () => {
    const skills = fakeSkills()
    registerFilmSkills({ get: (name: string) => name === 'skills' ? skills : undefined } as unknown as Context)
    expect(skills.providers.map(provider => provider.name)).toEqual([FILM_SKILL_PROVIDER])
    expect(() => registerFilmSkills({ get: () => undefined } as unknown as Context)).toThrow(/skills service/)
  })
})

describe('the plugin and the skill registry', () => {
  it('registers the skills while a skill registry runs', async () => {
    const skills = fakeSkills()
    const ctx = new Context()
    ctx.provide('skills')
    ctx.set('skills', skills)
    const fiber = await ctx.plugin(Film, { appsDir: cwd, modelsDir: join(cwd, 'models') })
    expect(skills.providers).toHaveLength(1)
    expect((await skills.providers[0]!.list({ cwd })).map(skill => skill.name)).toEqual(['film-screenwriting'])
    await fiber.dispose()
  })

  it('loads without a skill registry', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(Film, { appsDir: cwd, modelsDir: join(cwd, 'models') })
    await fiber.dispose()
  })
})
