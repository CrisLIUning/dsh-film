/**
 * Saved versions of the film's text files (screenplays first), ported from
 * Studio's project file versions so histories read the same: every write
 * records the full content as a numbered version, the manifest names the
 * current one, and writers of one file take turns behind an in-process lock.
 *
 * Store: `<workspace>/film/.versions/<sha256(file)[0:24]>/manifest.json`
 * (schema 2) with `NNNN-<uuid>.<ext>` content files beside it.
 * @module dsh-film/versions
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

/** The version folder, relative to the workspace. */
export const VERSIONS_DIR = 'film/.versions'
const MANIFEST = 'manifest.json'
const VERSION_ID = /^[A-Za-z0-9_-]+$/u
const DIGEST = /^[a-f0-9]{64}$/u

export type FileVersionSource = 'ai' | 'manual' | 'restore'

/** One saved version, in the shape Studio's history views read. */
export interface FileVersion {
  id: string
  fileName: string
  version: number
  label: string
  /** Milliseconds since the epoch. */
  createdAt: number
  source: FileVersionSource
  prompt: null
  size: number
  mime: string
  kind: 'text'
  current: boolean
  contentDigest?: string
  parentVersionId?: string
  restoreFromVersionId?: string
}

interface Entry {
  id: string
  fileName: string
  version: number
  label: string
  createdAt: number
  source: FileVersionSource
  size: number
  contentPath: string
  contentDigest?: string
  parentVersionId?: string
  restoreFromVersionId?: string
}

interface Manifest {
  entries: Entry[]
  currentVersionId: string | null
}

export interface CreateVersionOptions {
  source?: FileVersionSource
  label?: string
  parentVersionId?: string
  restoreFromVersionId?: string
}

/** What a writer holding a file's lock can do with its history. */
export interface VersionLock {
  createVersion(content: string, options?: CreateVersionOptions): Promise<FileVersion>
  /** The current version when it already holds this content, else a new version. */
  ensureCurrentVersion(content: string, options?: CreateVersionOptions): Promise<FileVersion>
}

/**
 * The digest that names a content version.
 * @param content - text content.
 * @returns lowercase hex SHA-256 of its UTF-8 bytes.
 */
export function contentDigest(content: string): string {
  return createHash('sha256').update(Buffer.from(String(content), 'utf8')).digest('hex')
}

const storeFor = (cwd: string, fileName: string): string =>
  join(cwd, VERSIONS_DIR, createHash('sha256').update(fileName).digest('hex').slice(0, 24))

const mimeFor = (fileName: string): string => (extname(fileName).toLowerCase() === '.md' ? 'text/markdown' : 'text/plain')

const extensionFor = (fileName: string): string => {
  const ext = extname(fileName)
  return /^\.[A-Za-z0-9]{1,12}$/u.test(ext) ? ext.toLowerCase() : '.dat'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function readEntry(raw: unknown, fileName: string, index: number): Entry | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !VERSION_ID.test(raw.id)) return null
  const version = Number.isFinite(Number(raw.version)) ? Number(raw.version) : index + 1
  const contentPath = typeof raw.contentPath === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(raw.contentPath) && !raw.contentPath.includes('..')
    ? raw.contentPath
    : `${raw.id}.dat`
  const source: FileVersionSource = raw.source === 'ai' || raw.source === 'restore' ? raw.source : 'manual'
  const entry: Entry = {
    id: raw.id,
    fileName,
    version,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : `Version ${version}`,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0,
    source,
    size: Number.isFinite(Number(raw.size)) ? Number(raw.size) : 0,
    contentPath,
  }
  if (typeof raw.contentDigest === 'string' && DIGEST.test(raw.contentDigest)) entry.contentDigest = raw.contentDigest
  if (typeof raw.parentVersionId === 'string' && VERSION_ID.test(raw.parentVersionId)) entry.parentVersionId = raw.parentVersionId
  if (typeof raw.restoreFromVersionId === 'string' && VERSION_ID.test(raw.restoreFromVersionId)) entry.restoreFromVersionId = raw.restoreFromVersionId
  return entry
}

async function readManifest(cwd: string, fileName: string): Promise<Manifest> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(storeFor(cwd, fileName), MANIFEST), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], currentVersionId: null }
    throw error
  }
  const entries = isRecord(raw) && Array.isArray(raw.entries)
    ? raw.entries.flatMap((item, index) => { const entry = readEntry(item, fileName, index); return entry === null ? [] : [entry] })
    : []
  const declared = isRecord(raw) && typeof raw.currentVersionId === 'string' ? raw.currentVersionId : null
  return { entries, currentVersionId: declared !== null && entries.some(entry => entry.id === declared) ? declared : null }
}

/** Test seam: fail a manifest write to check that callers keep their data consistent. */
export const versionTestHooks = {
  beforeWriteManifest: null as null | ((write: { fileName: string }) => Promise<void> | void),
}

async function writeManifest(cwd: string, fileName: string, manifest: Manifest): Promise<void> {
  const root = storeFor(cwd, fileName)
  await mkdir(root, { recursive: true })
  await versionTestHooks.beforeWriteManifest?.({ fileName })
  const temporary = join(root, `${MANIFEST}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 2, fileName, currentVersionId: manifest.currentVersionId, entries: manifest.entries }, null, 2))
    await rename(temporary, join(root, MANIFEST))
  } finally {
    await rm(temporary, { force: true })
  }
}

function publicVersion(entry: Entry, currentId: string | null): FileVersion {
  const version: FileVersion = {
    id: entry.id,
    fileName: entry.fileName,
    version: entry.version,
    label: entry.label,
    createdAt: entry.createdAt,
    source: entry.source,
    prompt: null,
    size: entry.size,
    mime: mimeFor(entry.fileName),
    kind: 'text',
    current: entry.id === currentId,
  }
  if (entry.contentDigest !== undefined) version.contentDigest = entry.contentDigest
  if (entry.parentVersionId !== undefined) version.parentVersionId = entry.parentVersionId
  if (entry.restoreFromVersionId !== undefined) version.restoreFromVersionId = entry.restoreFromVersionId
  return version
}

async function createVersion(cwd: string, fileName: string, content: string, options: CreateVersionOptions): Promise<FileVersion> {
  const root = storeFor(cwd, fileName)
  await mkdir(root, { recursive: true })
  const manifest = await readManifest(cwd, fileName)
  const number = manifest.entries.reduce((max, entry) => Math.max(max, entry.version), 0) + 1
  const id = randomUUID()
  const contentPath = `${String(number).padStart(4, '0')}-${id}${extensionFor(fileName)}`
  const restoredFrom = options.restoreFromVersionId === undefined
    ? undefined
    : manifest.entries.find(entry => entry.id === options.restoreFromVersionId)
  const source = options.source ?? (options.restoreFromVersionId !== undefined ? 'restore' : 'manual')
  const label = options.label?.trim()
  const entry: Entry = {
    id,
    fileName,
    version: number,
    label: label !== undefined && label !== ''
      ? label
      : restoredFrom === undefined ? `Version ${number}` : `Version ${number} · restored from v${restoredFrom.version}`,
    createdAt: Date.now(),
    source,
    size: Buffer.byteLength(content),
    contentPath,
    contentDigest: contentDigest(content),
  }
  if (options.restoreFromVersionId !== undefined && VERSION_ID.test(options.restoreFromVersionId)) entry.restoreFromVersionId = options.restoreFromVersionId
  if (source === 'restore' && restoredFrom !== undefined) entry.parentVersionId = restoredFrom.id
  else if (options.parentVersionId !== undefined && options.parentVersionId === manifest.currentVersionId) entry.parentVersionId = options.parentVersionId
  await writeFile(join(root, contentPath), content)
  await writeManifest(cwd, fileName, { entries: [...manifest.entries, entry], currentVersionId: id })
  return publicVersion(entry, id)
}

async function ensureCurrentVersion(cwd: string, fileName: string, content: string, options: CreateVersionOptions): Promise<FileVersion> {
  const manifest = await readManifest(cwd, fileName)
  const current = manifest.entries.find(entry => entry.id === manifest.currentVersionId)
  if (current !== undefined) {
    try {
      if (await readFile(join(storeFor(cwd, fileName), current.contentPath), 'utf8') === content) return publicVersion(current, current.id)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return createVersion(cwd, fileName, content, options)
}

const locks = new Map<string, Promise<void>>()

/**
 * Run `work` while holding the lock of one file of one workspace. Writers of
 * the same file wait their turn; other files proceed in parallel.
 * @param cwd - the workspace directory.
 * @param fileName - the file, relative to the workspace, with `/` separators.
 * @param work - receives what it may do with the file's history.
 * @returns what `work` returns.
 */
export async function withVersionLock<T>(cwd: string, fileName: string, work: (lock: VersionLock) => Promise<T>): Promise<T> {
  const key = `${resolve(cwd)}\0${fileName}`
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>((done) => { release = done })
  const chained = previous.then(() => held, () => held)
  locks.set(key, chained)
  await previous.catch(() => undefined)
  try {
    return await work({
      createVersion: (content, options = {}) => createVersion(cwd, fileName, content, options),
      ensureCurrentVersion: (content, options = {}) => ensureCurrentVersion(cwd, fileName, content, options),
    })
  } finally {
    release()
    if (locks.get(key) === chained) locks.delete(key)
  }
}

/**
 * List a file's saved versions, oldest first.
 * @param cwd - the workspace directory.
 * @param fileName - the file, relative to the workspace.
 * @returns the versions.
 */
export async function listVersions(cwd: string, fileName: string): Promise<FileVersion[]> {
  const manifest = await readManifest(cwd, fileName)
  return manifest.entries.map(entry => publicVersion(entry, manifest.currentVersionId))
}

/**
 * Read one saved version with its content.
 * @param cwd - the workspace directory.
 * @param fileName - the file, relative to the workspace.
 * @param versionId - the version.
 * @returns the version and its content; throws an `ENOENT`-coded error when unknown.
 */
export async function readVersion(cwd: string, fileName: string, versionId: string): Promise<{ version: FileVersion; content: string }> {
  if (!VERSION_ID.test(versionId)) throw Object.assign(new Error('version id required'), { code: 'EINVAL' })
  const manifest = await readManifest(cwd, fileName)
  const entry = manifest.entries.find(item => item.id === versionId)
  if (entry === undefined) throw Object.assign(new Error('version not found'), { code: 'ENOENT' })
  const content = await readFile(join(storeFor(cwd, fileName), entry.contentPath), 'utf8')
  return { version: publicVersion(entry, manifest.currentVersionId), content }
}
