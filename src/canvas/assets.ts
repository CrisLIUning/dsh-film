/**
 * The canvas asset library, ported from Studio (apps/daemon/src/canvas-assets.ts)
 * with the workspace's `film/` folder as the project.
 *
 * Two sources, one answer: the project folder says what exists (every media
 * file under it, whoever wrote it), and `film/canvas/assets.json` says what is
 * known about it (title, tags, note...), keyed by the file's project-relative
 * path. A stored entry whose file is gone is dropped; text and browser-local
 * entries have no file to lose and survive every scan.
 * @module dsh-film/canvas/assets
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { entryKind, listWorkspaceMedia, workspaceMediaUrl } from '../media.js'
import { withoutImported } from '../media-imports.js'

export interface CanvasAsset {
  id: string
  kind: 'image' | 'video' | 'audio' | 'model' | 'text' | string
  title?: string
  storage?: 'file' | string
  filePath?: string
  sizeBytes?: number
  mimeType?: string
  createdAt?: string
  updatedAt?: string
  tags?: unknown
  note?: unknown
  data?: unknown
  [key: string]: unknown
}

export interface CanvasAssetLibrary {
  boardId: string
  projectId: string
  assets: CanvasAsset[]
  scannedAt: string
}

export const CANVAS_ASSETS_FILE = 'film/canvas/assets.json'
const PROJECT_DIR = 'film'

const KIND_BY_EXTENSION = new Map<string, string>([
  ['png', 'image'], ['jpg', 'image'], ['jpeg', 'image'], ['webp', 'image'], ['gif', 'image'],
  ['mp4', 'video'], ['webm', 'video'], ['mov', 'video'],
  ['mp3', 'audio'], ['wav', 'audio'], ['m4a', 'audio'],
  ['glb', 'model'], ['gltf', 'model'], ['fbx', 'model'], ['obj', 'model'],
])

const MIME_BY_EXTENSION = new Map<string, string>([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'],
  ['mp4', 'video/mp4'], ['webm', 'video/webm'], ['mov', 'video/quicktime'],
  ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['m4a', 'audio/mp4'],
  ['glb', 'model/gltf-binary'], ['gltf', 'model/gltf+json'], ['fbx', 'application/vnd.autodesk.fbx'], ['obj', 'model/obj'],
])

/** Folders a scan never enters: none hold a person's material. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.od', 'dist', 'build', '.next', '.cache'])

/**
 * A procedural model's per-version outputs (`models/<id>/versions/`): every
 * version files its own GLB, capture passes and readback images, dozens per
 * run, which would bury the library. The adopted model reaches the desk
 * through the model panel instead.
 */
const MODEL_VERSIONS = /^models\/[^/]+\/versions$/

/**
 * Compiled skeletal motion clips (`motions/<task>/motion.glb`, director_compile_motion):
 * GLBs, but animation for a character, not a space or a prop, so the library
 * (and the desk's 空间库 built from it) never offers them.
 */
const MOTIONS_DIR = 'motions'

const extensionOf = (path: string): string => path.split('.').pop()?.toLowerCase() ?? ''

/** A file under a model's `versions/` folder, which the scan leaves out. */
const isModelVersionOutput = (filePath: string | undefined): boolean => {
  const parts = filePath?.split('/') ?? []
  return parts.length > 3 && MODEL_VERSIONS.test(parts.slice(0, 3).join('/'))
}

/** A file under the film's `motions/` folder, which the scan leaves out. */
const isMotionOutput = (filePath: string | undefined): boolean => filePath?.startsWith(`${MOTIONS_DIR}/`) === true

/**
 * The asset kind of a media file.
 * @param filePath - a file path.
 * @returns the kind, or `null` for files that are not material.
 */
export function mediaKindFor(filePath: string): string | null {
  return KIND_BY_EXTENSION.get(extensionOf(filePath)) ?? null
}

/** The identity a file has as an asset, shared with the editing desk's cut segments. */
export const canvasAssetIdFor = (filePath: string): string => `canvas-file:${filePath}`

interface ScannedFile { filePath: string; sizeBytes: number; mtimeMs: number }

/**
 * Every media file under a folder, relative to it, newest first.
 * @param directory - the folder.
 * @returns the files.
 */
export async function scanMedia(directory: string): Promise<ScannedFile[]> {
  const found: ScannedFile[] = []
  const walk = async (folder: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      // A reparse point is asked again (a cloud placeholder is a file); links are never followed.
      const { kind, stats } = await entryKind(entry, join(folder, entry.name))
      if (kind === 'dir') {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !MODEL_VERSIONS.test(relative) && relative !== MOTIONS_DIR) await walk(join(folder, entry.name), relative)
        continue
      }
      if (kind !== 'file' || mediaKindFor(entry.name) === null) continue
      try {
        const info = stats ?? await stat(join(folder, entry.name))
        found.push({ filePath: relative, sizeBytes: info.size, mtimeMs: info.mtimeMs })
      } catch {
        // Gone between readdir and stat.
      }
    }
  }
  await walk(directory, '')
  return found.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

function assetFromFile(file: ScannedFile): CanvasAsset {
  const time = new Date(file.mtimeMs).toISOString()
  return {
    id: canvasAssetIdFor(file.filePath),
    kind: mediaKindFor(file.filePath) ?? 'image',
    title: file.filePath.split('/').pop() || file.filePath,
    storage: 'file',
    filePath: file.filePath,
    sizeBytes: file.sizeBytes,
    mimeType: MIME_BY_EXTENSION.get(extensionOf(file.filePath)) ?? 'application/octet-stream',
    createdAt: time,
    updatedAt: time,
  }
}

/**
 * Fold the stored overlay over the scan: the scan's order (newest first) and
 * bytes, the overlay's titles, tags, notes and data; fileless entries after.
 * @param stored - the overlay.
 * @param scanned - the scan.
 * @returns the library entries.
 */
export function mergeAssetLibrary(stored: readonly CanvasAsset[], scanned: readonly ScannedFile[]): CanvasAsset[] {
  const byPath = new Map<string, CanvasAsset>()
  const fileless: CanvasAsset[] = []
  for (const asset of stored) {
    if (asset.storage === 'file' && typeof asset.filePath === 'string' && asset.filePath !== '') byPath.set(asset.filePath, asset)
    else fileless.push(asset)
  }
  const merged = scanned.map((file) => {
    const known = byPath.get(file.filePath)
    const fresh = assetFromFile(file)
    if (known === undefined) return fresh
    return {
      ...known,
      ...fresh,
      title: known.title || fresh.title,
      ...(known.tags !== undefined ? { tags: known.tags } : {}),
      ...(known.note !== undefined ? { note: known.note } : {}),
      ...(known.data !== undefined ? { data: known.data } : {}),
      ...(known.createdAt ? { createdAt: known.createdAt } : {}),
    }
  })
  return [...merged, ...fileless]
}

interface StoredLibrary {
  assets: CanvasAsset[]
  /** Gateway asset identities of uploaded references, by content SHA-256; kept as they are. */
  publishedReferences: Record<string, unknown>
}

async function readLibrary(file: string): Promise<StoredLibrary> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<StoredLibrary>
    return {
      assets: Array.isArray(value.assets) ? value.assets : [],
      publishedReferences: typeof value.publishedReferences === 'object' && value.publishedReferences !== null ? value.publishedReferences : {},
    }
  } catch (error) {
    // Never overwrite an unreadable ledger with an empty one.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { assets: [], publishedReferences: {} }
  }
}

const writes = new Map<string, Promise<unknown>>()

async function updateLibrary(file: string, update: (state: StoredLibrary) => void): Promise<void> {
  const previous = writes.get(file) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    const state = await readLibrary(file)
    update(state)
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
  })
  writes.set(file, next)
  try {
    await next
  } finally {
    if (writes.get(file) === next) writes.delete(file)
  }
}

/** A media file of the workspace outside `film/`, offered beside the library (not part of it until imported). */
export interface CanvasWorkspaceFile {
  /** `workspace-file:<path>`. */
  id: string
  /** Relative to the workspace, with `/` separators. */
  path: string
  kind: 'image' | 'video' | 'audio'
  title: string
  /** Where a page plays it: `/api/dsh-film/media?cwd=…&path=…`. */
  url: string
  sizeBytes: number
  mimeType: string
  /** ISO 8601. */
  modifiedAt: string
}

/**
 * The workspace's own media the board can show (the canvas's image, video
 * and audio types), newest first, from the shared workspace scan. A file the
 * film already imported and that has not changed since is left out, as the
 * editing desk's material leaves it out: the library shows the film's copy.
 * @param cwd - the workspace directory.
 * @returns the files.
 */
export async function workspaceAssetFiles(cwd: string): Promise<CanvasWorkspaceFile[]> {
  const { files } = await listWorkspaceMedia(cwd)
  return (await withoutImported(cwd, files)).flatMap((file) => {
    const kind = mediaKindFor(file.path)
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return []
    return [{
      id: `workspace-file:${file.path}`,
      path: file.path,
      kind,
      title: file.path.split('/').pop() || file.path,
      url: workspaceMediaUrl(cwd, file.path),
      sizeBytes: file.bytes,
      mimeType: MIME_BY_EXTENSION.get(extensionOf(file.path)) ?? 'application/octet-stream',
      modifiedAt: file.modifiedAt,
    }]
  })
}

/** The asset library of one workspace's board. */
export class CanvasAssetStore {
  private readonly file: string
  private readonly projectDir: string

  constructor(cwd: string) {
    this.file = join(cwd, ...CANVAS_ASSETS_FILE.split('/'))
    this.projectDir = join(cwd, PROJECT_DIR)
  }

  async read(boardId: string, projectId: string): Promise<CanvasAssetLibrary> {
    const [stored, scanned] = await Promise.all([readLibrary(this.file), scanMedia(this.projectDir)])
    return { boardId, projectId, assets: mergeAssetLibrary(stored.assets, scanned), scannedAt: new Date().toISOString() }
  }

  /**
   * Save the overlay: only what a scan cannot rediscover (a file asset keeps
   * its path and edited fields, not its size or type).
   * @param boardId - the board.
   * @param projectId - the project id echoed back.
   * @param assets - the library as the canvas holds it.
   * @returns the library after saving.
   */
  async write(boardId: string, projectId: string, assets: readonly CanvasAsset[]): Promise<CanvasAssetLibrary> {
    const overlay = assets.map((asset) => {
      if (asset.storage !== 'file') return asset
      const { sizeBytes: _size, mimeType: _mime, ...rest } = asset
      return rest as CanvasAsset
    })
    await updateLibrary(this.file, (state) => {
      const known = new Map(state.assets.map(asset => [asset.filePath, asset]))
      const incoming = new Set(overlay.map(asset => asset.filePath))
      // Kept though the canvas never sees them: published references, and model version outputs and motion clips the scan hides (their titles, tags and notes stay).
      const published = state.assets.filter(asset => !incoming.has(asset.filePath)
        && (asset.gatewayReference !== undefined || isModelVersionOutput(asset.filePath) || isMotionOutput(asset.filePath)))
      state.assets = [...overlay.map((asset) => {
        const { gatewayReference: _reference, referenceSha256: _hash, ...editable } = asset
        const prior = known.get(asset.filePath)
        return {
          ...editable,
          ...(prior?.gatewayReference !== undefined ? { gatewayReference: prior.gatewayReference } : {}),
          ...(prior?.referenceSha256 !== undefined ? { referenceSha256: prior.referenceSha256 } : {}),
        }
      }), ...published]
    })
    return this.read(boardId, projectId)
  }
}
