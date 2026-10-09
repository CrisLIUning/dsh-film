/** Computer-wide, local-only film assets. Nothing here scans a workspace or calls a model. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import type { Stats } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { serveFile } from '../files.js'
import { mediaTypeOf, resolveWorkspaceMedia } from '../media.js'
import { FILM_DIR, requireFilmWorkspace } from '../project.js'
import { RAW_UPLOAD_LIMIT } from '../studio/project-routes.js'

export type SharedAssetKind = 'text' | 'image' | 'video' | 'audio'

export interface SharedLibraryFolder {
  id: string
  parentId?: string
  title: string
  icon?: string
  createdAt: string
  updatedAt: string
}

export interface SharedLibraryAsset {
  id: string
  kind: SharedAssetKind
  title: string
  folderId: string
  tags: string[]
  note?: string
  source?: string
  createdAt: string
  updatedAt: string
  sizeBytes: number
  mimeType: string
  width?: number
  height?: number
  durationMs?: number
  text?: string
}

export interface SharedLibrarySnapshot {
  revision: string
  folders: SharedLibraryFolder[]
  assets: SharedLibraryAsset[]
  deletedAssets: SharedLibraryAsset[]
  /** Present only after POST /assets or /assets/upload. */
  createdAssetId?: string
}

export interface SharedLibraryImport {
  assets: (SharedLibraryAsset & { file?: { name: string; mime: string; size: number } })[]
}

export class SharedLibraryError extends Error {
  override name = 'SharedLibraryError'
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function fail(status: number, code: string, message: string): never { throw new SharedLibraryError(status, code, message) }
function invalid(message: string): never { return fail(400, 'SHARED_LIBRARY_INVALID', message) }
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const titleSchema = z.string().trim().min(1).max(512)
const kindSchema = z.enum(['text', 'image', 'video', 'audio'])
const tagsSchema = z.array(z.string().max(256)).max(64)
const optionalRevision = { expectedRevision: z.string().min(1).max(128).optional() }
const metadata = {
  width: z.number().finite().positive().optional(),
  height: z.number().finite().positive().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
}
const createSchema = z.object({
  kind: kindSchema, title: titleSchema, folderId: idSchema,
  tags: tagsSchema.optional(), note: z.string().max(65536).optional(), source: z.string().max(8192).optional(),
  text: z.string().max(8 * 1024 * 1024).optional(),
  projectPath: z.string().min(1).optional(), workspacePath: z.string().min(1).optional(),
  ...metadata, ...optionalRevision,
}).strict()
const uploadSchema = createSchema.omit({ text: true, projectPath: true, workspacePath: true }).extend({ name: z.string().min(1).max(512) })
const assetPatchSchema = createSchema.pick({ title: true, folderId: true, tags: true, note: true, source: true, width: true, height: true, durationMs: true }).partial().extend(optionalRevision).strict()
const folderSchema = z.object({ title: titleSchema, parentId: idSchema.optional(), icon: z.string().max(128).optional(), ...optionalRevision }).strict()
const folderPatchSchema = folderSchema.partial().extend({ parentId: idSchema.nullable().optional(), icon: z.string().max(128).nullable().optional() }).strict()
const revisionSchema = z.object(optionalRevision).strict()
const importSchema = z.object({ assetIds: z.array(idSchema).min(1).max(256), ...optionalRevision }).strict()

const folderRecord = folderSchema.omit({ expectedRevision: true }).extend({ id: idSchema, createdAt: z.string(), updatedAt: z.string() }).passthrough()
const assetRecord = z.object({
  id: idSchema, kind: kindSchema, title: titleSchema, folderId: idSchema, tags: tagsSchema,
  note: z.string().optional(), source: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
  sizeBytes: z.number().int().nonnegative().max(RAW_UPLOAD_LIMIT), mimeType: z.string(),
  text: z.string().optional(), ...metadata,
  fileName: z.string().regex(/^[A-Za-z0-9_-]+\.[a-z0-9]+$/).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), deletedAt: z.string().optional(),
}).passthrough()
const manifestSchema = z.object({
  format: z.literal('vibedev.film.shared-assets'), version: z.literal(1), revision: z.string().min(1),
  folders: z.array(folderRecord), assets: z.array(assetRecord),
}).passthrough()
type Manifest = z.infer<typeof manifestSchema>
type StoredAsset = z.infer<typeof assetRecord>
type NewAsset = z.infer<typeof createSchema>

export const SHARED_LIBRARY_DEFAULT_FOLDERS = [
  { id: 'characters', title: '角色' }, { id: 'scenes', title: '场景' },
  { id: 'props', title: '物品' }, { id: 'styles', title: '风格' },
  { id: 'sounds', title: '音效' }, { id: 'uncategorized', title: '未分类' },
] as const
const defaultIds = new Set<string>(SHARED_LIBRARY_DEFAULT_FOLDERS.map(folder => folder.id))
const MANIFEST_LIMIT = 32 * 1024 * 1024
/** Includes the running action. Excess requests fail promptly instead of retaining unbounded streams. */
export const SHARED_LIBRARY_QUEUE_LIMIT = 64
const queues = new Map<string, { count: number; tail: Promise<void> }>()
const keyOf = (path: string): string => process.platform === 'win32' || process.platform === 'darwin' ? path.normalize('NFC').toLowerCase() : path.normalize('NFC')
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

/** Empty overrides keep the default; relative overrides are refused so cwd never changes the library. */
export function sharedAssetsDirectory(override?: string): string {
  const directory = override?.trim() || join(homedir(), '.vibedev', 'film', 'assets')
  if (!isAbsolute(directory) || directory.includes('\0')) invalid('sharedAssetsDir must be an absolute directory.')
  return resolve(directory)
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) invalid(result.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '))
  return result.data
}

function inside(root: string, path: string): boolean {
  const offset = relative(root, path)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

async function info(path: string): Promise<Stats | undefined> {
  try { return await lstat(path) } catch (error) { if (codeOf(error) === 'ENOENT') return undefined; throw error }
}

/** Check every component before creating it. Neither a dangling nor an inward-pointing symlink is accepted. */
async function checkedPath(root: string, parts: readonly string[], createParents = false): Promise<string> {
  const rootInfo = await info(root)
  if (rootInfo?.isDirectory() !== true || rootInfo.isSymbolicLink() || keyOf(await realpath(root)) !== keyOf(root)) invalid('The storage root must be a real directory without links.')
  let path = root
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (!part || part === '.' || part === '..' || /[\\/\0:]/u.test(part)) invalid('A confined file path is required.')
    path = join(path, part)
    if (!inside(root, path)) invalid('The file must stay inside its storage root.')
    let stat = await info(path)
    if (stat?.isSymbolicLink()) invalid('Links are not allowed in asset storage or import paths.')
    if (i < parts.length - 1) {
      if (!stat && createParents) {
        await mkdir(path).catch(error => { if (codeOf(error) !== 'EEXIST') throw error })
        stat = await info(path)
      }
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) invalid('A real directory is required for every parent.')
    }
    if (stat && keyOf(await realpath(path)) !== keyOf(path)) invalid('The file path goes through a link.')
  }
  return path
}

async function directoryRoot(path: string): Promise<string> {
  const stat = await info(path)
  if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) invalid('sharedAssetsDir must be a real directory.')
  await mkdir(path, { recursive: true })
  const after = await info(path)
  if (after?.isSymbolicLink() || after?.isDirectory() !== true) invalid('sharedAssetsDir must be a real directory.')
  return realpath(path)
}

async function queued<T>(key: string, action: () => Promise<T>): Promise<T> {
  const state = queues.get(key) ?? { count: 0, tail: Promise.resolve() }
  if (state.count >= SHARED_LIBRARY_QUEUE_LIMIT) fail(503, 'SHARED_LIBRARY_BUSY', 'The asset library queue is full. Retry shortly.')
  state.count++
  const previous = state.tail
  let release!: () => void
  state.tail = new Promise<void>(done => { release = done })
  queues.set(key, state)
  await previous
  try { return await action() } finally {
    state.count--
    release()
    if (state.count === 0) queues.delete(key)
  }
}

/** A disk lock serializes Host processes as well as router instances. A crashed owner's lock is never stolen. */
async function locked<T>(root: string, action: () => Promise<T>): Promise<T> {
  const path = await checkedPath(root, ['.manifest.lock'])
  const deadline = Date.now() + 15000
  for (;;) {
    try { await mkdir(path); break } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
      await checkedPath(root, ['.manifest.lock'])
      if (Date.now() >= deadline) fail(503, 'SHARED_LIBRARY_BUSY', 'The asset library is locked by another Host. Retry after it finishes.')
      await delay(25)
    }
  }
  try { return await action() } finally { await rmdir(path) }
}

function assetDto(asset: StoredAsset): SharedLibraryAsset {
  const { id, kind, title, folderId, tags, note, source, createdAt, updatedAt, sizeBytes, mimeType, width, height, durationMs, text } = asset
  return { id, kind, title, folderId, tags: [...tags], createdAt, updatedAt, sizeBytes, mimeType,
    ...(note !== undefined ? { note } : {}), ...(source !== undefined ? { source } : {}),
    ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}), ...(text !== undefined ? { text } : {}),
  }
}

function snapshot(state: Manifest): SharedLibrarySnapshot {
  return {
    revision: state.revision,
    folders: state.folders.map(({ id, title, parentId, icon, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt,
      ...(parentId !== undefined ? { parentId } : {}), ...(icon !== undefined ? { icon } : {}),
    })),
    assets: state.assets.filter(asset => asset.deletedAt === undefined).map(assetDto),
    deletedAssets: state.assets.filter(asset => asset.deletedAt !== undefined).map(assetDto),
  }
}

function folderOf(state: Manifest, id: string) {
  return state.folders.find(folder => folder.id === id) ?? fail(404, 'SHARED_LIBRARY_FOLDER_NOT_FOUND', `Folder ${id} does not exist.`)
}

function assetOf(state: Manifest, id: string, deleted: boolean | 'all' = false): StoredAsset {
  parse(idSchema, id)
  return state.assets.find(asset => asset.id === id && (deleted === 'all' || (asset.deletedAt !== undefined) === deleted))
    ?? fail(404, 'SHARED_LIBRARY_ASSET_NOT_FOUND', `Asset ${id} does not exist${deleted === true ? ' in the recycle bin' : ''}.`)
}

function checkRevision(state: Manifest, expected?: string): void {
  if (expected !== undefined && expected !== state.revision) fail(409, 'SHARED_LIBRARY_REVISION_CONFLICT', 'The shared library changed. Reload it before retrying.')
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function verifyManifest(state: Manifest): Promise<void> {
  const ids = new Set(state.folders.map(folder => folder.id))
  const corrupt = (): never => fail(422, 'SHARED_LIBRARY_CORRUPT', 'The shared asset manifest is inconsistent; it has not been overwritten.')
  if (ids.size !== state.folders.length || [...defaultIds].some(id => !ids.has(id))) corrupt()
  for (const folder of state.folders) {
    const seen = new Set([folder.id])
    let parent = folder.parentId
    while (parent !== undefined) {
      if (seen.has(parent) || !ids.has(parent)) corrupt()
      seen.add(parent)
      parent = state.folders.find(entry => entry.id === parent)!.parentId
    }
  }
  if (new Set(state.assets.map(asset => asset.id)).size !== state.assets.length) corrupt()
  for (const asset of state.assets) {
    if (!ids.has(asset.folderId)) corrupt()
    if (asset.kind === 'text') {
      if (typeof asset.text !== 'string' || asset.sizeBytes !== Buffer.byteLength(asset.text, 'utf8') || asset.fileName !== undefined) corrupt()
    } else {
      const media = asset.fileName ? mediaTypeOf(asset.fileName) : undefined
      if (!asset.fileName || !asset.sha256 || media?.kind !== asset.kind || media.type !== asset.mimeType) corrupt()
    }
  }
}

/** A library root has no relationship to a project's cwd. Writes reload the manifest under both locks. */
export class SharedAssetLibrary {
  readonly directory: string
  constructor(override?: string) { this.directory = sharedAssetsDirectory(override) }

  private async run<T>(action: (root: string, state: Manifest) => Promise<T>): Promise<T> {
    const root = await directoryRoot(this.directory)
    return queued(keyOf(root), () => locked(root, async () => action(root, await this.load(root))))
  }

  private async load(root: string): Promise<Manifest> {
    const path = await checkedPath(root, ['manifest.json'])
    const stat = await info(path)
    if (!stat) {
      const now = new Date().toISOString()
      const state: Manifest = { format: 'vibedev.film.shared-assets', version: 1, revision: '0', assets: [],
        folders: SHARED_LIBRARY_DEFAULT_FOLDERS.map(folder => ({ ...folder, createdAt: now, updatedAt: now })),
      }
      await this.save(root, state, false)
      return state
    }
    if (!stat.isFile() || stat.size > MANIFEST_LIMIT) fail(422, 'SHARED_LIBRARY_CORRUPT', 'The asset manifest is not a supported JSON file.')
    let value: unknown
    try { value = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
      if (error instanceof SyntaxError) fail(422, 'SHARED_LIBRARY_CORRUPT', 'The asset manifest is not valid JSON; it has not been overwritten.')
      throw error
    }
    const parsed = manifestSchema.safeParse(value)
    if (!parsed.success) fail(422, 'SHARED_LIBRARY_CORRUPT', 'The asset manifest has an unsupported or invalid format; it has not been overwritten.')
    await verifyManifest(parsed.data)
    return parsed.data
  }

  private async save(root: string, state: Manifest, increment = true): Promise<void> {
    if (increment) state.revision = randomUUID()
    const data = `${JSON.stringify(state, null, 2)}\n`
    if (Buffer.byteLength(data) > MANIFEST_LIMIT) fail(413, 'SHARED_LIBRARY_TOO_LARGE', 'The shared library manifest exceeds 32 MiB.')
    const temporary = await checkedPath(root, [`manifest-${randomUUID()}.tmp`])
    const target = await checkedPath(root, ['manifest.json'])
    let owned = false
    try {
      const handle = await open(temporary, 'wx', 0o600)
      owned = true
      try { await handle.writeFile(data, 'utf8'); await handle.sync() } finally { await handle.close() }
      await checkedPath(root, ['manifest.json'])
      await rename(temporary, target)
    } finally { if (owned) await rm(temporary, { force: true }) }
  }

  async read(): Promise<SharedLibrarySnapshot> { return this.run(async (_root, state) => snapshot(state)) }

  async createFolder(input: unknown): Promise<SharedLibrarySnapshot> {
    const body = parse(folderSchema, input)
    return this.run(async (root, state) => {
      checkRevision(state, body.expectedRevision)
      if (body.parentId !== undefined) folderOf(state, body.parentId)
      const now = new Date().toISOString()
      const { expectedRevision: _revision, ...fields } = body
      state.folders.push({ id: `folder_${randomUUID()}`, ...fields, createdAt: now, updatedAt: now })
      await this.save(root, state)
      return snapshot(state)
    })
  }

  async patchFolder(id: string, input: unknown): Promise<SharedLibrarySnapshot> {
    parse(idSchema, id)
    const body = parse(folderPatchSchema, input)
    return this.run(async (root, state) => {
      checkRevision(state, body.expectedRevision)
      const folder = folderOf(state, id)
      if (body.parentId !== undefined && body.parentId !== null) {
        let parent: string | undefined = body.parentId
        while (parent !== undefined) {
          if (parent === id) invalid('A folder cannot be moved into itself or its descendant.')
          parent = folderOf(state, parent).parentId
        }
      }
      if (body.title !== undefined) folder.title = body.title
      if (body.parentId === null) delete folder.parentId
      else if (body.parentId !== undefined) folder.parentId = body.parentId
      if (body.icon === null) delete folder.icon
      else if (body.icon !== undefined) folder.icon = body.icon
      folder.updatedAt = new Date().toISOString()
      await this.save(root, state)
      return snapshot(state)
    })
  }

  async deleteFolder(id: string, input: unknown = {}): Promise<SharedLibrarySnapshot> {
    parse(idSchema, id)
    const body = parse(revisionSchema, input)
    return this.run(async (root, state) => {
      checkRevision(state, body.expectedRevision)
      folderOf(state, id)
      const subtree = new Set([id])
      for (let changed = true; changed;) {
        changed = false
        for (const folder of state.folders) if (folder.parentId && subtree.has(folder.parentId) && !subtree.has(folder.id)) { subtree.add(folder.id); changed = true }
      }
      if ([...subtree].some(folder => defaultIds.has(folder))) fail(409, 'SHARED_LIBRARY_DEFAULT_FOLDER', 'Default folders can be renamed, but cannot be deleted.')
      if (state.assets.some(asset => subtree.has(asset.folderId))) fail(409, 'SHARED_LIBRARY_FOLDER_NOT_EMPTY', 'The folder or a descendant still contains assets, including deleted assets.')
      state.folders = state.folders.filter(folder => !subtree.has(folder.id))
      await this.save(root, state)
      return snapshot(state)
    })
  }

  private newAsset(body: NewAsset, sizeBytes: number, mimeType: string): StoredAsset {
    const { expectedRevision: _revision, projectPath: _project, workspacePath: _workspace, ...metadata } = body
    const now = new Date().toISOString()
    return { ...metadata, id: `asset_${randomUUID()}`, tags: body.tags ?? [], createdAt: now, updatedAt: now, sizeBytes, mimeType }
  }

  async createAsset(cwd: string, input: unknown): Promise<SharedLibrarySnapshot> {
    const body = parse(createSchema, input)
    if (body.kind === 'text') {
      if (body.text === undefined || body.projectPath !== undefined || body.workspacePath !== undefined) invalid('A text asset needs text and cannot name a media source.')
      return this.run(async (root, state) => {
        checkRevision(state, body.expectedRevision)
        folderOf(state, body.folderId)
        const asset = this.newAsset(body, Buffer.byteLength(body.text!, 'utf8'), 'text/plain; charset=utf-8')
        state.assets.push(asset)
        await this.save(root, state)
        return { ...snapshot(state), createdAssetId: asset.id }
      })
    }
    if (body.text !== undefined || (body.projectPath === undefined) === (body.workspacePath === undefined)) invalid('A media asset needs exactly one projectPath or workspacePath.')
    await requireFilmWorkspace(cwd)
    let sourcePath = body.workspacePath
    if (body.projectPath !== undefined) {
      const path = body.projectPath.replaceAll('\\', '/')
      if (isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/u.test(path) || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) invalid('projectPath must be relative to film/.')
      sourcePath = `${FILM_DIR}/${path}`
    }
    const source = await resolveWorkspaceMedia(cwd, sourcePath!)
    if (source.kind !== body.kind) invalid('The media source extension does not match kind.')
    if (source.stats.size > RAW_UPLOAD_LIMIT) fail(413, 'SHARED_LIBRARY_TOO_LARGE', 'The media file exceeds the 2 GB limit.')
    return this.run(async (root, state) => {
      checkRevision(state, body.expectedRevision)
      folderOf(state, body.folderId)
      // Repeat resolution inside the lock in case a queued request's source changed.
      const current = await resolveWorkspaceMedia(cwd, sourcePath!)
      const asset = this.newAsset(body, current.stats.size, source.type)
      if (current.stats.size > RAW_UPLOAD_LIMIT) fail(413, 'SHARED_LIBRARY_TOO_LARGE', 'The media file exceeds the 2 GB limit.')
      const fileName = `${asset.id}${extname(source.path).toLowerCase()}`
      const path = await checkedPath(root, ['files', fileName], true)
      try {
        await copyFile(current.absolute, path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
        const copied = await lstat(path)
        if (!copied.isFile() || copied.size > RAW_UPLOAD_LIMIT) fail(413, 'SHARED_LIBRARY_TOO_LARGE', 'The media file exceeds the 2 GB limit.')
        asset.sizeBytes = copied.size
        asset.fileName = fileName
        asset.sha256 = await hashFile(path)
        // Record the original workspace-relative source even without an explicit provenance label.
        asset.source ??= source.path
        state.assets.push(asset)
        await this.save(root, state)
        return { ...snapshot(state), createdAssetId: asset.id }
      } catch (error) {
        if (codeOf(error) !== 'EEXIST') await rm(path, { force: true })
        throw error
      }
    })
  }

  async upload(request: Request, input: unknown): Promise<SharedLibrarySnapshot> {
    const body = parse(uploadSchema, input)
    if (body.kind === 'text' || /[\\/\0:]/u.test(body.name) || body.name.startsWith('.')) invalid('Upload a media filename without directories.')
    const media = mediaTypeOf(body.name)
    if (media === undefined || media.kind !== body.kind) invalid('The upload extension must be supported and match kind.')
    const declared = request.headers.get('content-length')
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > RAW_UPLOAD_LIMIT)) fail(413, 'SHARED_LIBRARY_TOO_LARGE', 'The file exceeds the 2 GB upload limit.')
    return this.run(async (root, state) => {
      checkRevision(state, body.expectedRevision)
      folderOf(state, body.folderId)
      const { name, ...fields } = body
      const asset = this.newAsset(fields, 0, media.type)
      asset.source ??= name
      const fileName = `${asset.id}${extname(name).toLowerCase()}`
      const path = await checkedPath(root, ['files', fileName], true)
      const hash = createHash('sha256')
      const reader = request.body?.getReader()
      if (!reader) invalid('An upload body is required.')
      const handle = await open(path, 'wx', 0o600)
      const cancelOnAbort = (): void => { void reader.cancel(request.signal.reason).catch(() => {}) }
      request.signal.addEventListener('abort', cancelOnAbort, { once: true })
      let size = 0
      try {
        try {
          for (;;) {
            if (request.signal.aborted) throw request.signal.reason ?? new Error('Upload aborted.')
            const { done, value } = await reader.read()
            if (request.signal.aborted) throw request.signal.reason ?? new Error('Upload aborted.')
            if (done) break
            size += value.byteLength
            if (size > RAW_UPLOAD_LIMIT) fail(413, 'SHARED_LIBRARY_TOO_LARGE', 'The file exceeds the 2 GB upload limit.')
            hash.update(value)
            // FileHandle.write can write fewer bytes than requested.
            for (let offset = 0; offset < value.byteLength;) {
              const result = await handle.write(value, offset, value.byteLength - offset)
              if (result.bytesWritten === 0) throw new Error('The upload write made no progress.')
              offset += result.bytesWritten
            }
          }
          await handle.sync()
        } finally { await handle.close() }
        asset.sizeBytes = size
        asset.fileName = fileName
        asset.sha256 = hash.digest('hex')
        state.assets.push(asset)
        await this.save(root, state)
        return { ...snapshot(state), createdAssetId: asset.id }
      } catch (error) {
        await reader.cancel().catch(() => {})
        await rm(path, { force: true })
        throw error
      } finally {
        request.signal.removeEventListener('abort', cancelOnAbort)
        reader.releaseLock()
      }
    })
  }

  async patchAsset(id: string, input: unknown): Promise<SharedLibrarySnapshot> {
    const body = parse(assetPatchSchema, input)
    return this.run(async (root, state) => {
      checkRevision(state, body.expectedRevision)
      const asset = assetOf(state, id)
      if (body.folderId !== undefined) folderOf(state, body.folderId)
      const { expectedRevision: _revision, ...fields } = body
      Object.assign(asset, fields, { updatedAt: new Date().toISOString() })
      await this.save(root, state)
      return snapshot(state)
    })
  }

  async deleteAsset(id: string, input: unknown = {}): Promise<SharedLibrarySnapshot> {
    const body = parse(revisionSchema, input)
    return this.run(async (root, state) => {
      checkRevision(state, body.expectedRevision)
      const asset = assetOf(state, id)
      // Preserve the DTO exactly so restoring retains every metadata field, including updatedAt.
      asset.deletedAt = new Date().toISOString()
      await this.save(root, state)
      return snapshot(state)
    })
  }

  async restoreAsset(id: string, input: unknown = {}): Promise<SharedLibrarySnapshot> {
    const body = parse(revisionSchema, input)
    return this.run(async (root, state) => {
      checkRevision(state, body.expectedRevision)
      const asset = assetOf(state, id, true)
      if (asset.kind !== 'text') await this.ownedFile(root, asset)
      delete asset.deletedAt
      await this.save(root, state)
      return snapshot(state)
    })
  }

  private async ownedFile(root: string, asset: StoredAsset): Promise<{ path: string; stats: Stats }> {
    if (!asset.fileName) fail(404, 'SHARED_LIBRARY_FILE_NOT_FOUND', 'A text asset has no media file.')
    const path = await checkedPath(root, ['files', asset.fileName])
    const stats = await info(path)
    if (stats?.isFile() !== true) fail(404, 'SHARED_LIBRARY_FILE_NOT_FOUND', `The library-owned file for ${asset.id} is missing.`)
    if (stats.size !== asset.sizeBytes) fail(422, 'SHARED_LIBRARY_FILE_CHANGED', 'The library-owned file size changed.')
    return { path, stats }
  }

  async raw(id: string, request: Request): Promise<Response> {
    return this.run(async (root, state) => {
      // Trash keeps its bytes available for preview/download; importing still requires an active asset.
      const asset = assetOf(state, id, 'all')
      const { path, stats } = await this.ownedFile(root, asset)
      return serveFile(request, { path, size: stats.size, modified: stats.mtime, type: asset.mimeType, headers: {
        'Cache-Control': 'private, no-cache',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cross-Origin-Resource-Policy': 'same-origin',
      } })
    })
  }

  async importAssets(cwd: string, input: unknown): Promise<SharedLibraryImport> {
    const body = parse(importSchema, input)
    if (new Set(body.assetIds).size !== body.assetIds.length) invalid('assetIds must be unique.')
    await requireFilmWorkspace(cwd)
    const workspaceRoot = await realpath(cwd)
    return this.run(async (root, state) => {
      checkRevision(state, body.expectedRevision)
      // Preflight the full batch, including hashes, before creating any destination directories or files.
      const sources: { asset: StoredAsset; path?: string }[] = []
      for (const id of body.assetIds) {
        const asset = assetOf(state, id)
        if (asset.kind === 'text') sources.push({ asset })
        else {
          const { path } = await this.ownedFile(root, asset)
          if (await hashFile(path) !== asset.sha256) fail(422, 'SHARED_LIBRARY_FILE_CHANGED', `The library-owned file for ${id} changed.`)
          sources.push({ asset, path })
        }
      }
      if (sources.every(source => source.path === undefined)) return { assets: sources.map(({ asset }) => assetDto(asset)) }
      await checkedPath(workspaceRoot, [FILM_DIR, 'canvas', 'media', 'placeholder'])
      // Import destination writes are serialized across other library instances and Host processes too.
      return queued(`import:${keyOf(workspaceRoot)}`, async () => {
        const film = await checkedPath(workspaceRoot, [FILM_DIR])
        return locked(film, async () => {
          const assets: SharedLibraryImport['assets'] = []
          const created: string[] = []
          try {
            for (const source of sources) {
              const dto = assetDto(source.asset)
              if (!source.path) { assets.push(dto); continue }
              const name = await this.copyIntoFilm(workspaceRoot, source.asset, source.path, created)
              assets.push({ ...dto, file: { name, mime: dto.mimeType, size: dto.sizeBytes } })
            }
            return { assets }
          } catch (error) {
            for (const path of created) await rm(path, { force: true }).catch(() => {})
            throw error
          }
        })
      })
    })
  }

  private async copyIntoFilm(workspace: string, asset: StoredAsset, source: string, created: string[]): Promise<string> {
    const stem = `shared-${asset.id}-${asset.sha256!}`
    const extension = extname(asset.fileName!)
    for (let index = 1; index <= 1000; index++) {
      const filename = `${stem}${index === 1 ? '' : `-${index}`}${extension}`
      const parts = [FILM_DIR, 'canvas', 'media', filename]
      const destination = await checkedPath(workspace, parts, true)
      const stat = await info(destination)
      if (stat) {
        if (stat.isFile() && stat.size === asset.sizeBytes && await hashFile(destination) === asset.sha256) return `canvas/media/${filename}`
        continue
      }
      try {
        await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
        created.push(destination)
        if (await hashFile(destination) !== asset.sha256) fail(422, 'SHARED_LIBRARY_FILE_CHANGED', 'The library file changed during import.')
        return `canvas/media/${filename}`
      } catch (error) {
        if (codeOf(error) === 'EEXIST') continue
        throw error
      }
    }
    return fail(409, 'SHARED_LIBRARY_IMPORT_COLLISION', 'No free destination name for this asset.')
  }
}
