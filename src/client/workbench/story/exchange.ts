/**
 * Import and export in the 剧本 tab, apart from React: reading a picked file
 * into an import request, the requests the dialogs send, what a preview and
 * an export result say, and handing an export to the browser as a download.
 *
 * Ported from Studio `apps/web/src/components/production/screenwriter/
 * StoryExchange.tsx` (`readFile`, `downloadStoryExport` and the request
 * shapes). The plugin does the parsing, remapping and packaging; the page only
 * reads bytes, previews, and saves what comes back.
 * @module dsh-film/client/workbench/story/exchange
 */

import type { StoryExportRequest, StoryExportResult, StoryImportPreview, StoryImportRequest } from '../../../screenwriter/contracts/assets.js'

/** The largest file the page sends (Studio's limit; the plugin refuses larger packages too). */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024

/** What the file picker accepts. */
export const IMPORT_ACCEPT = '.md,.markdown,.txt,.zip,text/markdown,application/zip'

/** A picked file was refused before anything was sent. */
export class ImportFileError extends Error {
  override name = 'ImportFileError'

  constructor(readonly reason: 'too-large' | 'not-utf8') {
    super(reason === 'too-large' ? 'The file is larger than 64 MiB.' : 'The file is not UTF-8 text.')
  }
}

/** Base64 without one giant string argument (a 64 MiB package would overflow `String.fromCharCode`). */
function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

/**
 * The import request for a picked file (Studio `StoryExchange.tsx:27-37`): a
 * `.zip` name is a reference package sent as base64; anything else is
 * Markdown decoded strictly as UTF-8, with a byte-order mark kept as content.
 * @param name - the file name.
 * @param bytes - its bytes.
 * @returns the request, without a preview digest.
 * @throws {ImportFileError} over 64 MiB, or text that is not UTF-8.
 */
export function importRequestFromFile(name: string, bytes: Uint8Array): StoryImportRequest {
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new ImportFileError('too-large')
  if (/\.zip$/iu.test(name)) return { format: 'package', encoding: 'base64', content: base64(bytes) }
  try {
    return { format: 'markdown', encoding: 'utf8', content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  } catch {
    throw new ImportFileError('not-utf8')
  }
}

/**
 * The request that creates the copy: exactly the previewed bytes, pinned by
 * the preview's digest (the plugin re-inspects them and refuses a mismatch).
 * @param input - the request that was previewed.
 * @param preview - its preview.
 * @returns the import request.
 */
export function importApplyRequest(input: StoryImportRequest, preview: Pick<StoryImportPreview, 'digest'>): StoryImportRequest & { expectedPreviewDigest: string } {
  return { ...input, expectedPreviewDigest: preview.digest }
}

/** The figures a preview's summary line shows. */
export interface ImportPreviewSummary {
  format: StoryImportPreview['format']
  entities: number
  scenes: number
  references: number
  /** A package that carries a manifest: whether every reference made it in, and which did not. */
  complete: boolean | undefined
  missing: NonNullable<StoryImportPreview['manifest']>['missing']
}

/**
 * Summarise a preview.
 * @param preview - the plugin's preview.
 * @returns the figures.
 */
export function importPreviewSummary(preview: StoryImportPreview): ImportPreviewSummary {
  return {
    format: preview.format,
    entities: preview.entityCount,
    scenes: preview.sceneCount,
    references: preview.files.length,
    complete: preview.manifest?.complete,
    missing: preview.manifest?.missing ?? [],
  }
}

/**
 * The export request: always the saved revision the person sees, so an edit
 * landing in between is a conflict rather than a silent different file.
 * @param revision - the saved revision.
 * @param mode - complete Markdown, body only, or a reference package.
 * @param allowMissing - accept a package with missing references (packages only).
 * @returns the request.
 */
export function exportRequest(revision: string, mode: StoryExportRequest['mode'], allowMissing: boolean): StoryExportRequest {
  return { expectedRevision: revision, mode, ...(mode === 'package' && allowMissing ? { allowMissing: true } : {}) }
}

/** What an export result block shows. */
export interface ExportSummary {
  fileName: string
  revision: string
  /** Packages only: whether every bound reference is inside. */
  complete: boolean | undefined
  /** Packages only: distinct files inside (identical bytes are packed once). */
  paths: string[]
  missing: NonNullable<StoryExportResult['manifest']>['missing']
  /** Packages only: where the plugin also saved the archive, relative to the workspace. */
  savedPath: string | undefined
}

/**
 * Summarise an export result.
 * @param result - the plugin's answer.
 * @returns the figures.
 */
export function exportSummary(result: StoryExportResult & { workspacePath?: string }): ExportSummary {
  return {
    fileName: result.fileName,
    revision: result.revision,
    complete: result.manifest?.complete,
    paths: [...new Set((result.manifest?.files ?? []).map(item => item.path))],
    missing: result.manifest?.missing ?? [],
    savedPath: result.workspacePath ?? (result.filePath !== undefined ? `film/${result.filePath}` : undefined),
  }
}

/**
 * The bytes of an export.
 * @param result - the plugin's answer.
 * @returns text as is, a package decoded from base64.
 */
export function exportBytes(result: Pick<StoryExportResult, 'encoding' | 'content'>): Uint8Array | string {
  return result.encoding === 'base64' ? Uint8Array.from(atob(result.content), character => character.charCodeAt(0)) : result.content
}

/**
 * Hand an export to the browser as a download (Studio `downloadStoryExport`).
 * @param result - the plugin's answer.
 */
export function downloadStoryExport(result: StoryExportResult): void {
  const bytes = exportBytes(result)
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: result.mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
}
