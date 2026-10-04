/**
 * The skills dsh-film ships: Markdown instructions under the package's
 * `skills/` folder, offered to the agent through DSH's skill registry
 * (`ctx.skills`, @deepseek-ai/dsh-skill) the way DSH's own bundled Office
 * skills are (packages/skill/skill-office). The model sees each skill's name
 * and description in its catalog, loads the body with the `skill` tool and
 * reads the references beside it with `read`.
 *
 * Studio staged its film skills (skills/write-vibedev-screenplay and its
 * siblings) into every film project; here the provider lists them in every
 * workspace instead, so a request like “帮我写个短片剧本” in a fresh chat finds
 * the skill, which then starts the film with `film_project`.
 *
 * The registry's types are mirrored structurally below rather than imported:
 * the plugin has no dependency on @deepseek-ai/dsh-skill, and a profile
 * without the registry simply never calls this module.
 * @module dsh-film/skills
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** The provider name the registry files these skills under. */
export const FILM_SKILL_PROVIDER = 'dsh-film'

/** The registry's rank for packaged skills (BUNDLED_SKILL_RANK): a user's own same-named skill shadows ours. */
export const FILM_SKILL_RANK = 600

/** The skills in the package, by folder name; each folder holds a SKILL.md named the same. */
export const FILM_SKILL_NAMES: readonly string[] = ['film-screenwriting']

/** The package's skills folder: `<package>/skills/`, from both `src/` and the built `lib/`. */
export const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url))

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** What a skill catalog entry carries (dsh-skill's SkillCandidate). */
export interface FilmSkillCandidate {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: string
  readonly provider: string
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
  readonly rank: number
  readonly locator: unknown
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** A loaded skill (dsh-skill's SkillDefinition): the catalog entry without rank and locator, plus the body. */
export type FilmSkillDefinition = Omit<FilmSkillCandidate, 'rank' | 'locator'> & { readonly content: string }

/** The provider contract (dsh-skill's SkillProvider). */
export interface FilmSkillProvider {
  readonly name: string
  list(options: { cwd?: string | undefined; signal?: AbortSignal | undefined }): Promise<readonly FilmSkillCandidate[]>
  get(candidate: FilmSkillCandidate, options: { cwd?: string | undefined; signal?: AbortSignal | undefined }): Promise<FilmSkillDefinition | undefined>
}

/** The part of the skill registry this plugin uses. */
export interface SkillsServiceLike {
  registerProvider(create: (control: { signal: AbortSignal; invalidate: () => void }) => FilmSkillProvider): () => void
}

/** A SKILL.md split into its frontmatter fields and its body. */
export interface ParsedSkillFile {
  name: string
  description: string
  metadata?: Record<string, string>
  content: string
}

const unquote = (value: string): string => /^(["']).*\1$/u.test(value) ? value.slice(1, -1) : value

/**
 * Parse a packaged SKILL.md. Only the frontmatter subset the shipped files use
 * is accepted — single-line `name` and `description`, and a `metadata:` block
 * of `  key: value` lines — so the plugin needs no YAML parser; anything else
 * is a packaging mistake and throws, as skill-office does.
 * @param raw - the file's text.
 * @param path - the file's path, for messages.
 * @returns the fields and the body without frontmatter.
 */
export function parseSkillFile(raw: string, path: string): ParsedSkillFile {
  const lines = raw.replace(/^﻿/u, '').split(/\r?\n/u)
  if (lines[0] !== '---') throw new Error(`dsh-film: ${path} has no frontmatter`)
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new Error(`dsh-film: ${path} has unclosed frontmatter`)
  const fields: Record<string, string> = {}
  const metadata: Record<string, string> = {}
  let inMetadata = false
  for (const line of lines.slice(1, end)) {
    const nested = /^ {2}([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line)
    if (inMetadata && nested !== null) {
      metadata[nested[1]!] = unquote(nested[2]!.trim())
      continue
    }
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line)
    if (top === null) throw new Error(`dsh-film: ${path} has an unsupported frontmatter line: ${line}`)
    inMetadata = top[1] === 'metadata' && top[2]!.trim() === ''
    if (!inMetadata) fields[top[1]!] = unquote(top[2]!.trim())
  }
  const name = fields.name ?? ''
  const description = fields.description ?? ''
  if (!SKILL_NAME.test(name)) throw new Error(`dsh-film: ${path} needs a kebab-case name`)
  if (description === '') throw new Error(`dsh-film: ${path} needs a description`)
  return {
    name,
    description,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    content: lines.slice(end + 1).join('\n').trim(),
  }
}

/**
 * The catalog entries of the packaged skills, read once: a skill whose folder
 * and name disagree would be listed under one name and never found under it.
 * @param root - the skills folder.
 * @param names - the skill folders to list.
 * @returns one candidate per skill.
 */
export function filmSkillCandidates(root: string = SKILLS_ROOT, names: readonly string[] = FILM_SKILL_NAMES): FilmSkillCandidate[] {
  return names.map((skill) => {
    const directory = join(root, skill)
    const path = join(directory, 'SKILL.md')
    const parsed = parseSkillFile(readFileSync(path, 'utf8'), path)
    if (parsed.name !== skill) throw new Error(`dsh-film: ${path} is named ${parsed.name}, not ${skill}`)
    return {
      name: parsed.name,
      description: parsed.description,
      path,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      provider: FILM_SKILL_PROVIDER,
      resourceBase: { kind: 'directory', path: directory },
      rank: FILM_SKILL_RANK,
      locator: path,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    }
  })
}

/**
 * The provider over the packaged skills. Bodies are read again on every load
 * (the registry never caches them), so an updated package is picked up
 * without a restart.
 * @param candidates - the catalog entries.
 * @returns the provider.
 */
export function filmSkillProvider(candidates: readonly FilmSkillCandidate[]): FilmSkillProvider {
  return {
    name: FILM_SKILL_PROVIDER,
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(String(locator), { encoding: 'utf8', signal: options.signal }).catch(() => undefined)
      if (raw === undefined) return undefined
      return { ...summary, content: parseSkillFile(raw, String(locator)).content }
    },
  }
}

/**
 * Register the packaged skills with the skill registry. Call it synchronously
 * from a context that injects `skills`; the registration lives as long as
 * that context.
 * @param ctx - a context with the `skills` service.
 * @param root - the skills folder.
 * @returns the registry's disposer for the registration.
 */
export function registerFilmSkills(ctx: Context, root: string = SKILLS_ROOT): () => void {
  const skills = ctx.get('skills') as SkillsServiceLike | undefined
  if (skills === undefined) throw new Error('dsh-film: the skills service is not available')
  const provider = filmSkillProvider(filmSkillCandidates(root))
  return skills.registerProvider(() => provider)
}
