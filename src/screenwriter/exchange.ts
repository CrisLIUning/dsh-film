/**
 * Screenplay import and export, ported from Studio's StoryExchange
 * (apps/daemon/src/screenwriter/exchange.ts) with the workspace in place of a
 * Studio project: paths are relative to `film/`, screenplays live in
 * `film/story/`.
 *
 * Export snapshots one saved revision: the exact Markdown (lossless), its
 * body without the technical markers (relations deliberately lost), or a ZIP
 * reference package carrying the Markdown, a manifest and the selected byte
 * version of every bound reference. A package is written to
 * `film/story-exports/` and never changes the source screenplay.
 *
 * Import is two-step and stateless: a preview inspects the bytes and returns
 * a digest of them; the import re-inspects the bytes it is sent and creates a
 * new copy only when they are the previewed ones. It never overwrites, never
 * merges into an existing document, and never fetches remote URLs named in
 * the Markdown. A package's references land in a fresh
 * `film/story-references/import_<uuid>/` directory, removed again if the copy
 * cannot be saved.
 * @module dsh-film/screenwriter/exchange
 */

import { createHash, randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import JSZip from 'jszip'
import { applyStoryOperations, parseStoryMarkdown, projectStoryBody, StoryIdSchema } from './contracts/index.js'
import type {
  StoryExportRequest, StoryExportResult, StoryImportPreview, StoryImportRequest, StoryMutationResult, StoryOperation, StoryReferencePackageManifest,
} from './contracts/index.js'
import { filmWriteTarget } from '../film-files.js'
import { FILM_DIR } from '../project.js'
import type { StoryAssets } from './assets.js'
import { StoryError } from './service.js'
import type { StoryService } from './service.js'

interface InspectedImport {
  content: string
  digest: string
  files: Array<{ path: string; bytes: Buffer; sha256: string }>
  manifest?: StoryReferencePackageManifest
}

/** A package export also names where it was saved, relative to the workspace. */
export type StoryExchangeExport = StoryExportResult & { workspacePath?: string }

const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex')

/** The largest compressed package accepted or produced. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
/** The largest total of Markdown, manifest and references a package expands to. */
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024
const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_PACKAGE_ENTRIES = 2048
/** Where package exports are saved, relative to `film/`. */
export const STORY_EXPORT_DIRECTORY = 'story-exports'
/** Where imported reference files are saved, relative to `film/`. */
export const STORY_IMPORT_DIRECTORY = 'story-references'

export class StoryExchange {
  constructor(private readonly story: StoryService, private readonly assets: StoryAssets) {}

  /**
   * Export one saved revision of a screenplay.
   * @param cwd - the workspace directory.
   * @param projectId - the film's project id (also its board id), for the
   *   reference library and the package's download path.
   * @param documentId - the screenplay.
   * @param input - the revision read, the mode and whether an incomplete package is acceptable.
   * @returns the export; a package's bytes are also saved under `film/story-exports/`.
   */
  async export(cwd: string, projectId: string, documentId: string, input: StoryExportRequest): Promise<StoryExchangeExport> {
    const document = await this.story.get(cwd, documentId)
    if (document.revision !== input?.expectedRevision) throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay changed before export. Review the saved revision.', document)
    const fileStem = document.title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-').slice(0, 100) || 'screenplay'
    if (input.mode === 'markdown' || input.mode === 'body') {
      return {
        documentId, revision: document.revision, fileName: `${fileStem}${input.mode === 'body' ? '-body' : ''}.md`, mimeType: 'text/markdown', encoding: 'utf8',
        content: input.mode === 'body' ? projectStoryBody(document.content) : document.content,
        completeRelations: input.mode === 'markdown',
      }
    }
    if (input.mode !== 'package') throw new StoryError(400, 'STORY_EXPORT_MODE', 'Choose markdown, body or package.')
    const metadata = document.parsed.metadata
    if (!document.parsed.semanticEditable || metadata === null || metadata === undefined) {
      throw new StoryError(422, 'STORY_UNRESOLVED_REFERENCES', 'Repair screenplay metadata before packaging references. You can still export the original Markdown.')
    }
    const archive = new JSZip()
    const manifest: StoryReferencePackageManifest = {
      format: 'vibedev.screenwriter.package', formatVersion: '1.0', documentId, revision: document.revision, markdownPath: 'screenplay.md',
      markdownSha256: sha256(document.content), complete: true, files: [], missing: [],
    }
    // Only bound versions travel; asset records nothing binds stay as they are.
    const bound = new Set(metadata.bindings.map(binding => `${binding.assetId}\0${binding.assetVersionId}`))
    const resolutions = await this.assets.resolve(cwd, document, projectId)
    const operations: StoryOperation[] = []
    const packedByDigest = new Map<string, string>()
    let packedBytes = 0
    for (const reference of resolutions.references) {
      const asset = reference.asset
      if (!bound.has(`${asset.id}\0${asset.versionId}`)) continue
      if (reference.resolvedPath === undefined) {
        manifest.missing.push({ assetId: asset.id, assetVersionId: asset.versionId, status: reference.status })
        continue
      }
      let file: Awaited<ReturnType<StoryAssets['readReference']>>
      try {
        file = await this.assets.readReference(cwd, document, asset.id, asset.versionId, projectId)
      } catch (error) {
        // The bytes can change or vanish between resolving and reading: report them as missing, never pack other bytes.
        if ((error instanceof StoryError && ['STORY_ASSET_CHANGED', 'STORY_ASSET_UNAVAILABLE'].includes(error.code)) || (error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          manifest.missing.push({ assetId: asset.id, assetVersionId: asset.versionId, status: error instanceof StoryError && error.code === 'STORY_ASSET_CHANGED' ? 'version-mismatch' : 'missing' })
          continue
        }
        throw error
      }
      const extension = extname(reference.resolvedPath).toLowerCase().replace(/[^.a-z0-9]/gu, '')
      const selectedHash = asset.sha256.toLowerCase()
      // Identical bytes are packed once; every (asset, version) still gets its own manifest row.
      const packagePath = packedByDigest.get(selectedHash) ?? `references/${selectedHash}${extension}`
      if (!packedByDigest.has(selectedHash)) {
        packedBytes += file.buffer.length
        if (packedBytes > MAX_EXPANDED_BYTES) throw new StoryError(413, 'STORY_PACKAGE_TOO_LARGE', 'Bound reference files exceed the 256 MiB package limit.')
        archive.file(packagePath, file.buffer)
        packedByDigest.set(selectedHash, packagePath)
      }
      manifest.files.push({ assetId: asset.id, assetVersionId: asset.versionId, path: packagePath, sha256: selectedHash, sizeBytes: file.buffer.length })
      const provenance = asset.provenance
      operations.push({
        kind: 'upsertAsset',
        asset: {
          ...asset,
          projectRelativePath: packagePath,
          // Opaque (non-object) author provenance is kept as written.
          ...(provenance === undefined || (typeof provenance === 'object' && provenance !== null && !Array.isArray(provenance))
            ? { provenance: { ...(provenance as Record<string, unknown> | undefined), originalProjectPath: asset.projectRelativePath } }
            : { originalProjectPath: asset.projectRelativePath }),
        },
      })
    }
    manifest.complete = manifest.missing.length === 0
    if (!manifest.complete && input.allowMissing !== true) {
      throw new StoryError(409, 'STORY_PACKAGE_INCOMPLETE', `Cannot create a complete package: ${manifest.missing.length} reference versions are unavailable. Export Markdown or explicitly allow an incomplete package.`, document)
    }
    // The packaged Markdown points at the package's own files; the saved screenplay is not touched.
    const markdown = operations.length > 0 ? applyStoryOperations(document.content, operations).markdown : document.content
    manifest.markdownSha256 = sha256(markdown)
    const manifestText = JSON.stringify(manifest, null, 2)
    if (Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES || packedBytes + Buffer.byteLength(markdown) + Buffer.byteLength(manifestText) > MAX_EXPANDED_BYTES) {
      throw new StoryError(413, 'STORY_PACKAGE_TOO_LARGE', 'The screenplay, manifest and selected references exceed the supported package limits.')
    }
    archive.file(manifest.markdownPath, markdown)
    archive.file('manifest.json', manifestText)
    const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new StoryError(413, 'STORY_PACKAGE_TOO_LARGE', 'The compressed reference package exceeds 64 MiB.')
    const filePath = `${STORY_EXPORT_DIRECTORY}/${documentId}-${randomUUID()}.zip`
    await writeNewFilmFile(cwd, filePath, bytes)
    const downloadPath = `/api/projects/${encodeURIComponent(projectId)}/raw/${filePath.split('/').map(encodeURIComponent).join('/')}`
    return {
      documentId, revision: document.revision, fileName: `${fileStem}.zip`, mimeType: 'application/zip', encoding: 'base64', content: bytes.toString('base64'),
      manifest, filePath, downloadPath, workspacePath: `${FILM_DIR}/${filePath}`,
    }
  }

  /**
   * Inspect an import without storing anything. The digest pins these exact
   * bytes for {@link StoryExchange.import}.
   * @param input - Markdown text, or a base64 ZIP package.
   * @returns what the copy would contain (identities are remapped only on import).
   */
  async preview(input: StoryImportRequest): Promise<StoryImportPreview> {
    const inspected = await this.inspect(input)
    const parsed = parseStoryMarkdown(inspected.content)
    return {
      digest: inspected.digest, format: parsed.format, content: inspected.content, diagnostics: parsed.diagnostics,
      semanticEditable: parsed.semanticEditable, entityCount: parsed.metadata?.entities.length ?? 0, sceneCount: parsed.metadata?.scenes.length ?? 0,
      files: inspected.files.map(({ path, sha256: digest, bytes }) => ({ path, sha256: digest, sizeBytes: bytes.length })),
      ...(inspected.manifest !== undefined ? { manifest: inspected.manifest } : {}), copy: true,
    }
  }

  /**
   * Create a new screenplay copy from previewed bytes.
   * @param cwd - the workspace directory.
   * @param input - the same content as previewed, with the preview's digest.
   * @returns the created copy.
   */
  async import(cwd: string, input: StoryImportRequest): Promise<StoryMutationResult> {
    const inspected = await this.inspect(input)
    if (input.expectedPreviewDigest !== inspected.digest) throw new StoryError(409, 'STORY_IMPORT_PREVIEW_REQUIRED', 'Preview this exact import before creating its copy.')
    if (inspected.files.length === 0) return this.story.create(cwd, { content: inspected.content })
    const parsed = parseStoryMarkdown(inspected.content)
    if (!parsed.semanticEditable || parsed.metadata === null || parsed.metadata === undefined) {
      throw new StoryError(422, 'STORY_PACKAGE_METADATA_INVALID', 'This package has unresolved metadata. Import the original Markdown to preserve and repair it first.')
    }
    const importDirectory = `${STORY_IMPORT_DIRECTORY}/import_${randomUUID()}`
    const operations: StoryOperation[] = []
    try {
      for (const file of inspected.files) {
        const destination = `${importDirectory}/${basename(file.path)}`
        await writeNewFilmFile(cwd, destination, file.bytes)
        for (const asset of parsed.metadata.assets.filter(item => item.projectRelativePath === file.path && item.sha256.toLowerCase() === file.sha256)) {
          operations.push({ kind: 'upsertAsset', asset: { ...asset, projectRelativePath: destination } })
        }
      }
      const content = applyStoryOperations(inspected.content, operations).markdown
      return await this.story.create(cwd, { content })
    } catch (error) {
      // Only this import's fresh directory is eligible for rollback.
      await rm(join(cwd, FILM_DIR, ...importDirectory.split('/')), { recursive: true, force: true })
      throw error
    }
  }

  private async inspect(input: StoryImportRequest): Promise<InspectedImport> {
    if (input === null || typeof input !== 'object' || typeof input.content !== 'string') throw new StoryError(400, 'STORY_IMPORT_CONTENT_REQUIRED', 'Import content is required.')
    if (input.format === 'markdown') {
      if (input.encoding !== undefined && input.encoding !== 'utf8') throw new StoryError(400, 'STORY_IMPORT_FORMAT', 'Markdown imports use literal UTF-8 text.')
      if (Buffer.byteLength(input.content, 'utf8') > MAX_MARKDOWN_BYTES) throw new StoryError(413, 'STORY_TOO_LARGE', 'Markdown exceeds 8 MiB.')
      // A lone surrogate cannot be stored as UTF-8; refuse it instead of saving U+FFFD.
      if (Buffer.from(input.content, 'utf8').toString('utf8') !== input.content) throw new StoryError(400, 'STORY_PACKAGE_TEXT_ENCODING', 'Markdown must be valid UTF-8 text.')
      return { content: input.content, digest: sha256(input.content), files: [] }
    }
    if (input.format !== 'package' || input.encoding !== 'base64') throw new StoryError(400, 'STORY_IMPORT_FORMAT', 'Packages require base64 ZIP content.')
    if (input.content.length > Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4 + 4) throw new StoryError(413, 'STORY_PACKAGE_TOO_LARGE', 'Compressed package exceeds 64 MiB.')
    // Repeated-group regexes overflow V8's regexp stack on ordinary media-sized
    // payloads. Validate the alphabet and terminal padding with linear scans.
    const padding = input.content.endsWith('==') ? 2 : input.content.endsWith('=') ? 1 : 0
    if (input.content.length % 4 !== 0 || /[^A-Za-z0-9+/]/u.test(input.content.slice(0, input.content.length - padding))) {
      throw new StoryError(400, 'STORY_IMPORT_FORMAT', 'Package base64 data is malformed.')
    }
    const bytes = Buffer.from(input.content, 'base64')
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new StoryError(413, 'STORY_PACKAGE_TOO_LARGE', 'Compressed package exceeds 64 MiB.')
    // Do not ask JSZip to eagerly CRC/decompress every entry. Unknown files
    // are ignored, and each consumed stream has a byte bound before buffering.
    let archive: JSZip
    try {
      archive = await JSZip.loadAsync(bytes)
    } catch {
      throw new StoryError(400, 'STORY_PACKAGE_INVALID', 'Package content is not a readable ZIP archive.')
    }
    const entries = Object.values(archive.files)
    if (entries.length > MAX_PACKAGE_ENTRIES) throw new StoryError(413, 'STORY_PACKAGE_TOO_MANY_FILES', 'Package has too many files.')
    for (const entry of entries) {
      // JSZip sanitizes `..` in `name`; the original name is what an unpacker would write.
      const original = entry.unsafeOriginalName ?? entry.name
      const segments = original.replace(/\/$/u, '').split('/')
      if (original.startsWith('/') || original.includes('\\') || /[\u0000-\u001f\u007f]/u.test(original) || segments.some(part => part === '' || part === '.' || part === '..') || /^[A-Za-z]:/u.test(original)) {
        throw new StoryError(400, 'STORY_PACKAGE_UNSAFE_PATH', 'Package contains an unsafe path.')
      }
    }
    const manifestFile = archive.file('manifest.json')
    if (manifestFile === null) throw new StoryError(400, 'STORY_PACKAGE_MANIFEST_MISSING', 'Package manifest is missing.')
    const manifestBytes = await readZipEntry(manifestFile, MAX_MANIFEST_BYTES)
    let manifest: StoryReferencePackageManifest
    const manifestText = decodeUtf8(manifestBytes)
    try {
      manifest = JSON.parse(manifestText) as StoryReferencePackageManifest
    } catch {
      throw new StoryError(400, 'STORY_PACKAGE_FORMAT', 'Package manifest is not valid JSON.')
    }
    if (manifest === null || typeof manifest !== 'object' || manifest.format !== 'vibedev.screenwriter.package' || manifest.formatVersion !== '1.0' || !Array.isArray(manifest.files)
      || !Array.isArray(manifest.missing) || manifest.markdownPath !== 'screenplay.md' || typeof manifest.complete !== 'boolean'
      || !StoryIdSchema.safeParse(manifest.documentId).success || !isDigest(manifest.revision) || !isDigest(manifest.markdownSha256)) {
      throw new StoryError(400, 'STORY_PACKAGE_FORMAT', 'Unsupported or incomplete reference package manifest.')
    }
    const markdown = archive.file(manifest.markdownPath)
    if (markdown === null) throw new StoryError(400, 'STORY_PACKAGE_MARKDOWN_MISSING', 'Package screenplay is missing.')
    const markdownBytes = await readZipEntry(markdown, MAX_MARKDOWN_BYTES)
    if (sha256(markdownBytes) !== manifest.markdownSha256) throw new StoryError(400, 'STORY_PACKAGE_MARKDOWN_CHECKSUM', 'Packaged Markdown differs from its manifest digest.')
    const content = decodeUtf8(markdownBytes)
    const parsed = parseStoryMarkdown(content)
    if (!parsed.semanticEditable || parsed.metadata === null || parsed.metadata === undefined) {
      throw new StoryError(422, 'STORY_PACKAGE_METADATA_INVALID', 'Reference packages require consistent supported metadata; the original Markdown can be imported separately without changes.')
    }
    if (parsed.metadata.document.id !== manifest.documentId) throw new StoryError(400, 'STORY_PACKAGE_REFERENCE_MISMATCH', 'Package document identity differs from its Markdown.')
    // The manifest must describe exactly the Markdown's bound versions: each one packed or reported missing, once.
    const key = (assetId: string, versionId: string): string => `${assetId}\0${versionId}`
    const assets = new Map(parsed.metadata.assets.map(asset => [key(asset.id, asset.versionId), asset]))
    const bound = new Set(parsed.metadata.bindings.map(binding => key(binding.assetId, binding.assetVersionId)))
    const represented = new Set<string>()
    const paths = new Map<string, { sha256: string; sizeBytes: number }>()
    for (const entry of manifest.files) {
      if (entry === null || typeof entry !== 'object' || !StoryIdSchema.safeParse(entry.assetId).success || !StoryIdSchema.safeParse(entry.assetVersionId).success || typeof entry.path !== 'string'
        || !/^references\/[a-f0-9]{64}(?:\.[a-z0-9]+)?$/u.test(entry.path) || !isDigest(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
        throw new StoryError(400, 'STORY_PACKAGE_FILE_INVALID', 'Reference manifest contains an invalid file.')
      }
      const referenceKey = key(entry.assetId, entry.assetVersionId)
      const asset = assets.get(referenceKey)
      const previous = paths.get(entry.path)
      if (asset === undefined || !bound.has(referenceKey) || represented.has(referenceKey) || asset.projectRelativePath !== entry.path || asset.sha256.toLowerCase() !== entry.sha256
        || entry.path.slice('references/'.length, 'references/'.length + 64) !== entry.sha256 || (previous !== undefined && (previous.sha256 !== entry.sha256 || previous.sizeBytes !== entry.sizeBytes))) {
        throw new StoryError(400, 'STORY_PACKAGE_REFERENCE_MISMATCH', 'Manifest reference identity, path or selected byte version does not match the Markdown.')
      }
      represented.add(referenceKey)
      paths.set(entry.path, { sha256: entry.sha256, sizeBytes: entry.sizeBytes })
    }
    for (const entry of manifest.missing) {
      if (entry === null || typeof entry !== 'object' || !StoryIdSchema.safeParse(entry.assetId).success || !StoryIdSchema.safeParse(entry.assetVersionId).success
        || !['missing', 'version-mismatch', 'ambiguous'].includes(entry.status)) {
        throw new StoryError(400, 'STORY_PACKAGE_REFERENCE_MISMATCH', 'Missing-reference report is invalid.')
      }
      const referenceKey = key(entry.assetId, entry.assetVersionId)
      if (!bound.has(referenceKey) || !assets.has(referenceKey) || represented.has(referenceKey)) {
        throw new StoryError(400, 'STORY_PACKAGE_REFERENCE_MISMATCH', 'Missing-reference report contradicts the Markdown or file manifest.')
      }
      represented.add(referenceKey)
    }
    if (represented.size !== bound.size || manifest.complete !== (manifest.missing.length === 0)) {
      throw new StoryError(400, 'STORY_PACKAGE_REFERENCE_MISMATCH', 'Package completeness or reference coverage contradicts its saved screenplay.')
    }
    let expanded = markdownBytes.length + manifestBytes.length
    const files: InspectedImport['files'] = []
    const uniquePaths = new Set<string>()
    for (const entry of manifest.files) {
      if (uniquePaths.has(entry.path)) continue
      const file = archive.file(entry.path)
      if (file === null) {
        // A reference left out of the archive degrades the copy to an incomplete one; it is not an error.
        manifest.complete = false
        manifest.missing.push({ assetId: entry.assetId, assetVersionId: entry.assetVersionId, status: 'missing' })
        continue
      }
      expanded += entry.sizeBytes
      if (expanded > MAX_EXPANDED_BYTES) throw new StoryError(413, 'STORY_PACKAGE_TOO_LARGE', 'Expanded references exceed 256 MiB.')
      const data = await readZipEntry(file, Math.min(entry.sizeBytes, MAX_EXPANDED_BYTES))
      if (data.length !== entry.sizeBytes || sha256(data) !== entry.sha256) throw new StoryError(400, 'STORY_PACKAGE_CHECKSUM', 'A reference differs from the selected version in the manifest.')
      files.push({ path: entry.path, bytes: data, sha256: entry.sha256 })
      uniquePaths.add(entry.path)
    }
    // A package's digest is over the ZIP bytes as decoded; Markdown's over its text.
    return { content, digest: sha256(bytes), files, manifest }
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function decodeUtf8(bytes: Buffer): string {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new StoryError(400, 'STORY_PACKAGE_TEXT_ENCODING', 'Package text is not valid UTF-8; it has not been converted or truncated.')
  return text
}

/**
 * Write bytes to a new file of the film, refusing an existing file and a
 * folder that leaves the film through a link.
 * @param cwd - the workspace directory.
 * @param path - the path relative to `film/`, `/`-separated.
 * @param bytes - the content.
 */
async function writeNewFilmFile(cwd: string, path: string, bytes: Uint8Array): Promise<void> {
  const target = await filmWriteTarget(cwd, path).catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'EPATHESCAPE' ? new StoryError(400, 'STORY_PATH_ESCAPE', `${path} leaves the film.`) : error
  })
  await writeFile(target, bytes, { flag: 'wx' })
}

async function readZipEntry(entry: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  // JSZip exposes readable-stream's legacy Node stream, not an async iterator.
  // Bound decompressed chunks before buffering, and stop the producer on error.
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const stream = entry.nodeStream() as NodeJS.ReadableStream & { destroy?: () => void }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      chunks.length = 0
      stream.pause()
      stream.destroy?.()
      reject(error)
    }
    stream.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.length
      if (total > limit) {
        fail(new StoryError(413, 'STORY_PACKAGE_TOO_LARGE', 'Package entry exceeds its declared or supported size.'))
        return
      }
      chunks.push(bytes)
    })
    stream.once('error', fail)
    stream.once('end', () => {
      if (!settled) {
        settled = true
        resolve(Buffer.concat(chunks))
      }
    })
  })
}
