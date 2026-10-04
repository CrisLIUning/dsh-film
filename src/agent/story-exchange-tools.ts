/**
 * Screenplay import and export for the agent: Studio's `story_import` and
 * `story_export` MCP tools (apps/daemon/src/screenwriter/mcp-tools.ts) over
 * the import and export routes the 剧本 tab uses. The film is the
 * conversation's workspace, so the `project` argument is gone.
 *
 * In place of Studio's CLI `--file` and `--output`, the tools read an import
 * from, and write an export to, a workspace-relative path. Both are confined
 * to the workspace (no absolute paths, no `..`, real-path containment), and an
 * export never overwrites a file or writes into the film's live stores
 * (`film/story/`, `film/canvas/`, `film/.versions/`, `film/film.json`). A
 * package's bytes never enter an answer: the export names the ZIP saved under
 * `film/story-exports/` instead.
 * @module dsh-film/agent/story-exchange-tools
 */

import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { FilmToolError, callStudio } from './studio-client.js'
import { filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices } from './context.js'
import { mutationSummary } from './story-tools.js'

/** The longest stretch of Markdown returned in one answer. */
const CONTENT_LIMIT = 48_000
/** How many manifest rows and diagnostics one answer lists. */
const ROW_LIMIT = 50
const DIAGNOSTIC_LIMIT = 20
/** The largest files read for an import: the exchange's own Markdown and archive limits. */
const MARKDOWN_FILE_LIMIT = 8 * 1024 * 1024
const PACKAGE_FILE_LIMIT = 64 * 1024 * 1024

/** The film's live stores, written only through the tools; workspace-relative, `/`-separated. */
const LIVE_STORES = ['film/story', 'film/canvas', 'film/.versions'] as const
const LIVE_FILES = ['film/film.json'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Forward slashes, and the case Windows ignores folded, for comparing workspace paths. */
const comparable = (path: string): string => {
  const slashed = path.split(sep).join('/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * The parts of a workspace-relative path, or a refusal for one that is
 * absolute, empty or climbs out with `..`.
 * @param path - the path the model gave.
 * @param name - the argument's name, for the message.
 * @returns the path's segments.
 */
function workspaceSegments(path: string, name: string): string[] {
  const slashed = path.trim().replaceAll('\\', '/')
  const parts = slashed.split('/').filter(part => part !== '' && part !== '.')
  if (slashed === '' || slashed.includes('\0') || isAbsolute(path.trim()) || slashed.startsWith('/') || /^[A-Za-z]:/u.test(slashed) || parts.length === 0 || parts.includes('..')) {
    throw new FilmToolError('STORY_TOOL_PATH', `${name} must be a path relative to the workspace, without "..".`)
  }
  return parts
}

/**
 * Whether a real path lies inside a real folder (not the folder itself).
 * @param root - the folder's real path.
 * @param target - the real path to test.
 * @returns whether it is inside.
 */
function inside(root: string, target: string): boolean {
  const offset = relative(root, target)
  return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
}

/**
 * Whether a workspace-relative path is, or is inside, one of the film's live stores.
 * @param offset - the path relative to the workspace, in either separator.
 * @returns whether writing there would bypass the tools.
 */
function inLiveStore(offset: string): boolean {
  const path = comparable(offset)
  return LIVE_STORES.some(store => path === store || path.startsWith(`${store}/`)) || LIVE_FILES.some(file => path === file)
}

/**
 * Read an import file of the workspace.
 * @param cwd - the workspace directory.
 * @param path - the workspace-relative path.
 * @param limit - the largest size read.
 * @returns the bytes.
 */
async function readWorkspaceFile(cwd: string, path: string, limit: number): Promise<Buffer> {
  const target = join(cwd, ...workspaceSegments(path, 'file'))
  const root = await realpath(cwd)
  const real = await realpath(target).catch((error: NodeJS.ErrnoException) => {
    throw new FilmToolError(error.code === 'ENOENT' ? 'STORY_TOOL_FILE_NOT_FOUND' : 'STORY_TOOL_PATH', `Cannot read ${path}: ${error.code ?? error.message}.`)
  })
  if (!inside(root, real)) throw new FilmToolError('STORY_TOOL_PATH', `${path} leaves the workspace.`)
  const info = await stat(real)
  if (!info.isFile()) throw new FilmToolError('STORY_TOOL_PATH', `${path} is not a file.`)
  if (info.size > limit) throw new FilmToolError(limit === PACKAGE_FILE_LIMIT ? 'STORY_PACKAGE_TOO_LARGE' : 'STORY_TOO_LARGE', `${path} exceeds ${limit / 1024 / 1024} MiB.`)
  return readFile(real)
}

/**
 * Check an export target before anything is exported: inside the workspace
 * (also through links in the folders that already exist), outside the live
 * stores and not an existing file.
 * @param cwd - the workspace directory.
 * @param path - the workspace-relative path.
 * @returns the absolute target.
 */
async function exportTarget(cwd: string, path: string): Promise<string> {
  const parts = workspaceSegments(path, 'outputPath')
  if (inLiveStore(parts.join('/'))) throw new FilmToolError('STORY_TOOL_PATH', `${path} is inside the film's live stores; export somewhere else (for example film/story-exports/ or media/).`)
  const target = join(cwd, ...parts)
  await confineParent(cwd, target, path)
  if (await lstat(target).catch(() => undefined) !== undefined) throw new FilmToolError('STORY_EXPORT_EXISTS', `${path} already exists; exports never overwrite. Choose a new name.`)
  return target
}

/**
 * Prove a target's folder, as far as it exists, is in the workspace and outside the live stores.
 * @param cwd - the workspace directory.
 * @param target - the absolute target.
 * @param path - the path as given, for messages.
 */
async function confineParent(cwd: string, target: string, path: string): Promise<void> {
  const root = await realpath(cwd)
  let folder = dirname(target)
  let pending: string[] = []
  // Resolve the deepest folder that exists; the rest will be created inside it.
  for (;;) {
    const real = await realpath(folder).catch(() => undefined)
    if (real !== undefined) {
      const full = join(real, ...pending, basename(target))
      if (!inside(root, full)) throw new FilmToolError('STORY_TOOL_PATH', `${path} leaves the workspace.`)
      if (inLiveStore(relative(root, full))) throw new FilmToolError('STORY_TOOL_PATH', `${path} leads into the film's live stores.`)
      return
    }
    const parent = dirname(folder)
    if (parent === folder) throw new FilmToolError('STORY_TOOL_PATH', `${path} leaves the workspace.`)
    pending = [basename(folder), ...pending]
    folder = parent
  }
}

/**
 * Write an export to its checked target, creating its folder.
 * @param cwd - the workspace directory.
 * @param target - the absolute target from {@link exportTarget}.
 * @param path - the path as given.
 * @param bytes - the content.
 */
async function writeExport(cwd: string, target: string, path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  // The folders may have changed since the check; prove the place again before writing.
  await confineParent(cwd, target, path)
  try {
    await writeFile(target, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FilmToolError('STORY_EXPORT_EXISTS', `${path} already exists; exports never overwrite.`)
    throw error
  }
}

/** A package manifest as an answer: its verdict and the first rows. */
function manifestSummary(manifest: unknown): Record<string, unknown> | undefined {
  if (!isRecord(manifest)) return undefined
  const files = Array.isArray(manifest.files) ? manifest.files : []
  const missing = Array.isArray(manifest.missing) ? manifest.missing : []
  return {
    documentId: manifest.documentId,
    revision: manifest.revision,
    complete: manifest.complete,
    fileCount: files.length,
    files: files.slice(0, ROW_LIMIT),
    missingCount: missing.length,
    missing: missing.slice(0, ROW_LIMIT),
  }
}

/** Markdown in an answer, cut at {@link CONTENT_LIMIT}. */
function contentPart(content: unknown): Record<string, unknown> {
  if (typeof content !== 'string') return {}
  return content.length > CONTENT_LIMIT
    ? { content: content.slice(0, CONTENT_LIMIT), contentTruncated: true, totalLength: content.length }
    : { content }
}

/**
 * Build the import and export tools.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function storyExchangeTools(services: FilmToolServices): ToolDefinition[] {
  return [
    defineTool({
      name: 'story_import',
      description: 'Import a screenplay into the film as a new copy, in two steps. action "preview" inspects Markdown or a ZIP reference package (exported by '
        + 'story_export or the 剧本 tab) and returns a digest; action "apply" creates the copy only from the same bytes with expectedPreviewDigest. Native '
        + 'relations are kept with remapped local identities; plain text gets no invented people, scenes or relations; damaged or newer-format Markdown is '
        + 'kept exactly as a read-only copy for review. Give either content (Markdown text, or base64 ZIP with encoding "base64") or file, a '
        + 'workspace-relative path read here (preferred for packages and long files). Never overwrites or merges into an existing document.',
      parameters: {
        action: { type: 'string', required: true, enum: ['preview', 'apply'] },
        format: { type: 'string', required: true, enum: ['markdown', 'package'] },
        content: { type: 'string', description: 'Markdown text, or a base64 ZIP package. Not with file.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'For content: utf8 for Markdown (the default), base64 for a package (the default for packages).' },
        file: { type: 'string', description: 'A workspace-relative file to import (a .md/.txt or a .zip package). Not with content.' },
        expectedPreviewDigest: { type: 'string', description: 'For apply: the digest the preview of these same bytes returned.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        const hasContent = args.content !== undefined
        const hasFile = args.file !== undefined && args.file !== ''
        if (hasContent === hasFile) throw new FilmToolError('STORY_TOOL_INPUT', 'Give exactly one of content or file.')
        if (args.action === 'apply' && (args.expectedPreviewDigest === undefined || args.expectedPreviewDigest === '')) {
          throw new FilmToolError('STORY_TOOL_INPUT', 'expectedPreviewDigest is required for apply: preview these bytes first.')
        }
        let content: string
        let encoding: string | undefined = args.encoding
        if (hasFile) {
          const bytes = await readWorkspaceFile(film.cwd, args.file!, args.format === 'package' ? PACKAGE_FILE_LIMIT : MARKDOWN_FILE_LIMIT)
          if (args.format === 'package') {
            content = bytes.toString('base64')
            encoding = 'base64'
          } else {
            try {
              // Keep a byte order mark as the 剧本 tab does; refuse bytes that are not UTF-8 instead of turning them into U+FFFD.
              content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
            } catch {
              throw new FilmToolError('STORY_PACKAGE_TEXT_ENCODING', `${args.file!} is not valid UTF-8 text; it has not been converted.`)
            }
            encoding = 'utf8'
          }
        } else {
          content = args.content!
          if (encoding === undefined && args.format === 'package') encoding = 'base64'
        }
        const base = `/api/projects/${segment(film.projectId)}/story/import`
        const body = { format: args.format, content, ...(encoding !== undefined ? { encoding } : {}) }
        if (args.action === 'preview') {
          const preview = await callStudio(services.studio, film.cwd, { method: 'POST', path: `${base}/preview`, body }, exec.signal)
          const diagnostics = Array.isArray(preview.diagnostics) ? preview.diagnostics : []
          const files = Array.isArray(preview.files) ? preview.files : []
          return plain({
            digest: preview.digest,
            format: preview.format,
            semanticEditable: preview.semanticEditable,
            entityCount: preview.entityCount,
            sceneCount: preview.sceneCount,
            fileCount: files.length,
            files: files.slice(0, ROW_LIMIT),
            ...(preview.manifest !== undefined ? { manifest: manifestSummary(preview.manifest) } : {}),
            copy: preview.copy,
            ...(diagnostics.length > 0 ? { diagnostics: diagnostics.slice(0, DIAGNOSTIC_LIMIT), diagnosticCount: diagnostics.length } : {}),
            ...contentPart(preview.content),
            note: 'Nothing was imported. Apply with action "apply", the same content or file, and this digest as expectedPreviewDigest.',
          })
        }
        const result = await callStudio(services.studio, film.cwd, { method: 'POST', path: base, body: { ...body, expectedPreviewDigest: args.expectedPreviewDigest } }, exec.signal)
        return plain(mutationSummary(result, false))
      },
    }),
    defineTool({
      name: 'story_export',
      description: 'Export the saved revision expectedRevision of a screenplay. mode "markdown" is the exact saved file, lossless with stable relations; "body" '
        + 'is the prose without the technical markers and loses relations and bindings deliberately (say so); "package" is a ZIP with the Markdown and the '
        + 'selected bytes of every bound reference image, saved under film/story-exports/ (the answer names the file, never its bytes). Missing references '
        + 'block a package unless allowMissing:true is explicitly wanted. outputPath (workspace-relative, a new file, not inside film/story, film/canvas or '
        + 'film/.versions) also writes the export there; without it Markdown comes back in the answer.',
      parameters: {
        documentId: { type: 'string', required: true, description: 'Stable screenplay document id from story_query.' },
        expectedRevision: { type: 'string', required: true, description: 'The saved revision last read. A different current revision is answered with a conflict.' },
        mode: { type: 'string', required: true, enum: ['markdown', 'body', 'package'] },
        allowMissing: { type: 'boolean', description: 'For package: accept an incomplete package that reports its missing references.' },
        outputPath: { type: 'string', description: 'A new workspace-relative file to write the export to.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        const output = args.outputPath !== undefined && args.outputPath !== '' ? args.outputPath : undefined
        const target = output !== undefined ? await exportTarget(film.cwd, output) : undefined
        const result = await callStudio(services.studio, film.cwd, {
          method: 'POST',
          path: `/api/projects/${segment(film.projectId)}/story/documents/${segment(args.documentId)}/export`,
          body: { expectedRevision: args.expectedRevision, mode: args.mode, ...(args.allowMissing !== undefined ? { allowMissing: args.allowMissing } : {}) },
        }, exec.signal)
        const content = typeof result.content === 'string' ? result.content : ''
        if (target !== undefined) await writeExport(film.cwd, target, output!, Buffer.from(content, result.encoding === 'base64' ? 'base64' : 'utf8'))
        const summary: Record<string, unknown> = {
          documentId: result.documentId,
          revision: result.revision,
          mode: args.mode,
          fileName: result.fileName,
          mimeType: result.mimeType,
          ...(result.completeRelations !== undefined ? { completeRelations: result.completeRelations } : {}),
          ...(output !== undefined ? { output: workspaceSegments(output, 'outputPath').join('/') } : {}),
        }
        if (args.mode === 'package') {
          return plain({
            ...summary,
            manifest: manifestSummary(result.manifest),
            filePath: result.workspacePath ?? (typeof result.filePath === 'string' ? `film/${result.filePath}` : undefined),
            downloadPath: result.downloadPath,
            sizeBytes: Buffer.byteLength(content, 'base64'),
          })
        }
        return plain(output !== undefined ? { ...summary, characters: content.length } : { ...summary, ...contentPart(content) })
      },
    }),
  ]
}
