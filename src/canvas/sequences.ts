/** Saved edit plans belong to the film; they never change the board or legacy timeline stores. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { withFileLock } from '../file-writes.js'

export interface SequenceClip {
  id: string
  nodeId: string
  path: string
  title: string
  inMs: number
  outMs: number
  durationMs?: number
  sourceBytes?: number
  sourceSha256?: string
}
export interface SequenceSound extends SequenceClip { atMs: number; volume: number; fadeInMs: number; fadeOutMs: number }
export interface SequenceCue { id: string; startMs: number; endMs: number; text: string; highlight?: { start: number; end: number } }
export interface SequenceMix {
  sourceVolume: number
  sounds: SequenceSound[]
  cues: SequenceCue[]
  subtitleStyle: { v: 1; fontScale: number; color: string; position: 'top' | 'center' | 'bottom'; backdrop: 'none' | 'shadow' | 'box'; maxCharsPerEntry: number; autoResegment: boolean }
  burnSubtitles: boolean
}
export interface SequenceContent {
  id: string
  title: string
  clips: SequenceClip[]
  mix?: SequenceMix
}
export interface SequenceDraft extends SequenceContent {
  revision: string
  updatedAt: string
  operationId: string
  requestHash: string
}
interface SequenceFile {
  format: 'vibedev.edit-sequences'
  version: 1
  projectId: string
  drafts: SequenceDraft[]
}
export class SequenceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value)
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const path = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.includes('\\') && !/^(?:\/|[A-Za-z]+:)/.test(value) && value.split('/').every(part => part !== '..' && part !== '.' && part !== '')

/** Validate the edit's shape without reading or changing any source media. */
export function sequenceContent(value: unknown): SequenceContent {
  if (!object(value) || !id(value.id) || typeof value.title !== 'string' || !value.title.trim() || !Array.isArray(value.clips) || value.clips.length > 20) {
    throw new SequenceError(400, 'SEQUENCE_INVALID', 'A named edit plan with at most 20 clips is required.')
  }
  const seen = new Set<string>()
  const parseClip = (entry: unknown): SequenceClip => {
    if (!object(entry) || !id(entry.id) || seen.has(entry.id) || !id(entry.nodeId) || !path(entry.path) || typeof entry.title !== 'string'
      || !time(entry.inMs) || !time(entry.outMs) || entry.outMs - entry.inMs < 100
      || (entry.durationMs !== undefined && (!time(entry.durationMs) || entry.outMs > entry.durationMs))
      || (entry.sourceBytes !== undefined && !time(entry.sourceBytes))
      || (entry.sourceSha256 !== undefined && (typeof entry.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sourceSha256)))) {
      throw new SequenceError(400, 'SEQUENCE_INVALID', 'Clip ids must be unique, paths film-relative and each range at least 0.1 seconds inside its source.')
    }
    seen.add(entry.id)
    return { id: entry.id, nodeId: entry.nodeId, path: entry.path, title: entry.title, inMs: entry.inMs, outMs: entry.outMs,
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs as number }), ...(entry.sourceBytes === undefined ? {} : { sourceBytes: entry.sourceBytes as number }),
      ...(entry.sourceSha256 === undefined ? {} : { sourceSha256: entry.sourceSha256 as string }) }
  }
  const clips = value.clips.map(parseClip)
  let mix: SequenceMix | undefined
  if (value.mix !== undefined) {
    const raw = value.mix
    if (!object(raw) || typeof raw.sourceVolume !== 'number' || !Number.isFinite(raw.sourceVolume) || raw.sourceVolume < 0 || !Array.isArray(raw.sounds) || !Array.isArray(raw.cues) || raw.cues.length > 5000 || typeof raw.burnSubtitles !== 'boolean') throw new SequenceError(400, 'SEQUENCE_INVALID', 'The audio and subtitle edit is invalid.')
    const sounds = raw.sounds.map(entry => {
      const clip = parseClip(entry)
      if (!object(entry) || !time(entry.atMs) || typeof entry.volume !== 'number' || !Number.isFinite(entry.volume) || entry.volume < 0 || !time(entry.fadeInMs) || !time(entry.fadeOutMs) || entry.fadeInMs + entry.fadeOutMs > clip.outMs - clip.inMs) throw new SequenceError(400, 'SEQUENCE_INVALID', 'Soundtrack positions and fades must fit their source range.')
      return { ...clip, atMs: entry.atMs, volume: entry.volume, fadeInMs: entry.fadeInMs, fadeOutMs: entry.fadeOutMs }
    })
    const cueIds = new Set<string>()
    const cues = raw.cues.map((entry): SequenceCue => {
      if (!object(entry) || !id(entry.id) || cueIds.has(entry.id) || !time(entry.startMs) || !time(entry.endMs) || entry.endMs <= entry.startMs || typeof entry.text !== 'string' || entry.text.length > 2000) throw new SequenceError(400, 'SEQUENCE_INVALID', 'Subtitle ids and intervals must be valid.')
      cueIds.add(entry.id)
      if (entry.highlight !== undefined && (!object(entry.highlight) || !time(entry.highlight.start) || !time(entry.highlight.end) || entry.highlight.end <= entry.highlight.start || entry.highlight.end > entry.text.length)) throw new SequenceError(400, 'SEQUENCE_INVALID', 'Subtitle highlight is outside its text.')
      return { id: entry.id, startMs: entry.startMs, endMs: entry.endMs, text: entry.text, ...(entry.highlight === undefined ? {} : { highlight: entry.highlight as { start: number; end: number } }) }
    })
    const style = raw.subtitleStyle
    if (!object(style) || style.v !== 1 || typeof style.fontScale !== 'number' || !Number.isFinite(style.fontScale) || style.fontScale < 2 || style.fontScale > 12 || typeof style.color !== 'string' || !/^#[A-Fa-f0-9]{6}$/.test(style.color) || !['top', 'center', 'bottom'].includes(String(style.position)) || !['none', 'shadow', 'box'].includes(String(style.backdrop)) || !time(style.maxCharsPerEntry) || style.maxCharsPerEntry < 20 || style.maxCharsPerEntry > 60 || typeof style.autoResegment !== 'boolean') throw new SequenceError(400, 'SEQUENCE_INVALID', 'Subtitle style must follow the film subtitle settings.')
    mix = { sourceVolume: raw.sourceVolume, sounds, cues, subtitleStyle: style as unknown as SequenceMix['subtitleStyle'], burnSubtitles: raw.burnSubtitles }
  }
  return { id: value.id, title: value.title.trim(), clips, ...(mix ? { mix } : {}) }
}

/** Atomic writes, and a revision per plan: two windows cannot overwrite each other's edit. */
export class SequenceStore {
  private readonly file: string
  constructor(private readonly cwd: string, private readonly projectId: string) { this.file = join(cwd, 'film', 'edits', 'sequences.json') }
  private async read(): Promise<SequenceFile> {
    let raw: string
    try { raw = await readFile(this.file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { format: 'vibedev.edit-sequences', version: 1, projectId: this.projectId, drafts: [] }
      throw error
    }
    try {
      const value: unknown = JSON.parse(raw)
      if (!object(value) || value.format !== 'vibedev.edit-sequences' || value.version !== 1 || value.projectId !== this.projectId || !Array.isArray(value.drafts)) throw Error()
      const ids = new Set<string>()
      for (const draft of value.drafts) {
        const content = sequenceContent(draft)
        if (!object(draft) || !id(draft.revision) || !id(draft.operationId) || typeof draft.updatedAt !== 'string' || ids.has(content.id)) throw Error()
        ids.add(content.id)
      }
      return value as unknown as SequenceFile
    } catch { throw new SequenceError(409, 'SEQUENCES_UNREADABLE', 'The saved edit plans cannot be read. The file has been retained; no plan will be overwritten.') }
  }
  private async write(value: SequenceFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp-${randomUUID()}`
    try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(temp, this.file) }
    finally { await rm(temp, { force: true }) }
  }
  async list(): Promise<SequenceDraft[]> { return (await this.read()).drafts }
  private async sourceVersion(path: string): Promise<{ bytes: number; sha256: string } | null> {
    const root = await realpath(join(this.cwd, 'film')).catch(() => null)
    const file = root ? await realpath(join(root, path)).catch(() => null) : null
    if (!root || !file) return null
    const offset = relative(root, file)
    if (!offset || offset.startsWith('..') || isAbsolute(offset)) throw new SequenceError(400, 'SEQUENCE_SOURCE_OUTSIDE_FILM', 'The saved source resolves outside this film.')
    const before = await stat(file)
    if (!before.isFile()) return null
    const digest = createHash('sha256')
    for await (const bytes of createReadStream(file)) digest.update(bytes)
    const after = await stat(file)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new SequenceError(409, 'SEQUENCE_SOURCE_CHANGED', 'A source changed while its version was read. Retry after the file is stable.')
    return { bytes: after.size, sha256: digest.digest('hex') }
  }
  async verify(content: SequenceContent): Promise<Array<{ clipId: string; status: 'available' | 'missing' | 'changed' }>> {
    const versions = new Map<string, Awaited<ReturnType<SequenceStore['sourceVersion']>>>()
    const sources: Array<{ clipId: string; status: 'available' | 'missing' | 'changed' }> = []
    for (const clip of [...content.clips, ...(content.mix?.sounds ?? [])]) {
      if (!versions.has(clip.path)) versions.set(clip.path, await this.sourceVersion(clip.path))
      const version = versions.get(clip.path)
      sources.push({ clipId: clip.id, status: !version ? 'missing' : clip.sourceSha256 && clip.sourceSha256 !== version.sha256 || clip.sourceBytes !== undefined && clip.sourceBytes !== version.bytes ? 'changed' : 'available' })
    }
    return sources
  }
  async get(draftId: string): Promise<{ draft: SequenceDraft; sources: Awaited<ReturnType<SequenceStore['verify']>> }> {
    const draft = (await this.read()).drafts.find(value => value.id === draftId)
    if (!draft) throw new SequenceError(404, 'SEQUENCE_NOT_FOUND', 'This edit plan no longer exists.')
    return { draft, sources: await this.verify(draft) }
  }
  async save(input: unknown, expectedRevision: unknown, operationId: unknown): Promise<SequenceDraft> {
    const content = sequenceContent(input)
    const requestHash = createHash('sha256').update(JSON.stringify(content)).digest('hex')
    if ((expectedRevision !== null && !id(expectedRevision)) || !id(operationId)) throw new SequenceError(400, 'SEQUENCE_INVALID', 'The saved revision and an operation id are required.')
    return withFileLock(this.file, async () => {
      const file = await this.read()
      const index = file.drafts.findIndex(draft => draft.id === content.id)
      const saved = file.drafts[index]
      if (saved?.operationId === operationId) {
        if (saved.requestHash !== requestHash) throw new SequenceError(409, 'SEQUENCE_OPERATION_CONFLICT', 'This save request id was already used for a different edit.')
        return saved
      }
      if ((saved?.revision ?? null) !== expectedRevision) throw new SequenceError(409, 'SEQUENCE_CONFLICT', 'Another window changed this edit plan. Keep this draft or save it as a new plan.')
      const versions = new Map<string, Awaited<ReturnType<SequenceStore['sourceVersion']>>>()
      const clips: SequenceClip[] = []
      const originals = [...content.clips, ...(content.mix?.sounds ?? [])];
      for (const clip of originals) {
        if (!versions.has(clip.path)) versions.set(clip.path, await this.sourceVersion(clip.path))
        const version = versions.get(clip.path)
        if (version && (clip.sourceSha256 && clip.sourceSha256 !== version.sha256 || clip.sourceBytes !== undefined && clip.sourceBytes !== version.bytes)) throw new SequenceError(409, 'SEQUENCE_SOURCE_CHANGED', 'A source file no longer matches the draft. Remove that clip or explicitly add its current version.')
        clips.push(version ? { ...clip, sourceBytes: version.bytes, sourceSha256: version.sha256 } : clip)
      }
      const sources = new Map(clips.map(clip => [clip.id, clip]));
      const stamped = { ...content, clips: content.clips.map(clip => sources.get(clip.id)!), ...(content.mix ? { mix: { ...content.mix, sounds: content.mix.sounds.map(sound => ({ ...sound, ...sources.get(sound.id)! })) } } : {}) };
      const draft: SequenceDraft = { ...stamped, revision: randomUUID(), operationId, requestHash, updatedAt: new Date().toISOString() }
      if (index < 0) file.drafts.push(draft); else file.drafts[index] = draft
      await this.write(file)
      return draft
    })
  }
  async remove(draftId: string, expectedRevision: unknown): Promise<void> {
    return withFileLock(this.file, async () => {
      const file = await this.read()
      const saved = file.drafts.find(draft => draft.id === draftId)
      if (!saved || saved.revision !== expectedRevision) throw new SequenceError(409, 'SEQUENCE_CONFLICT', 'The edit plan changed. Read its current revision before deleting it.')
      file.drafts = file.drafts.filter(draft => draft.id !== draftId)
      await this.write(file)
    })
  }
}
