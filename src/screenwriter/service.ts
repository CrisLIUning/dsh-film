/**
 * The screenwriter's saved documents, ported from Studio's StoryService with
 * the workspace in place of a Studio project: screenplays are
 * `film/story/<documentId>.md` in the `vibedev.screenwriter` Markdown format.
 *
 * Every write is a compare-and-swap on the document's content digest
 * (`expectedRevision`), records a version, and leaves an operation receipt so
 * a retried request is answered instead of applied twice. Writers of one
 * document take turns behind the file's version lock.
 * @module dsh-film/screenwriter/service
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import {
  applyStoryOperations, createStoryMarkdown, inspectStoryObjectDeletion, parseStoryMarkdown, prepareStoryImport,
} from './contracts/index.js'
import type {
  StoryApplyRequest, StoryDocument, StoryDocumentKind, StoryDocumentSummary, StoryMutationResult, StoryObjectTarget, StoryWriteRequest,
} from './contracts/index.js'
import { contentDigest, listVersions, readVersion, withVersionLock } from '../versions.js'
import type { FileVersion, VersionLock } from '../versions.js'
import { revertStoryText } from './revert.js'

export class StoryError extends Error {
  override name = 'StoryError'

  constructor(readonly status: number, readonly code: string, message: string, readonly current?: StoryDocument) {
    super(message)
  }
}

interface OperationReceipt {
  operationId: string
  requestDigest: string
  beforeRevision: string
  afterRevision: string
  beforeVersionId: string
  afterVersionId: string
  createdAt: string
  committed: boolean
  changedIds?: string[]
}

export interface StoryMutationOptions {
  expectedRevision: string
  operationId?: string
  label?: string
  source?: 'manual' | 'ai' | 'restore'
  restoreFromVersionId?: string
  request: unknown
  dryRun?: boolean
}

export interface StoryTransformResult { content: string; changedIds?: string[] }

/** The screenplay folder, relative to the workspace. */
export const STORY_DIRECTORY = 'film/story'
const RECEIPTS_DIRECTORY = 'film/.versions/story-operations'
const MAX_CONTENT_BYTES = 8 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const hash = contentDigest
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

/** Stable request identity; excludes generated IDs produced inside a semantic transaction. */
function requestDigest(request: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
        .filter(([, member]) => member !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, member]) => [key, canonical(member)]))
    }
    return value
  }
  const text = JSON.stringify(canonical(request))
  if (text === undefined) throw new StoryError(400, 'STORY_INVALID_REQUEST', 'A stable mutation request is required.')
  return hash(text)
}

export class StoryService {
  private filePath(documentId: string): string {
    if (!SAFE_ID.test(documentId)) throw new StoryError(400, 'STORY_INVALID_ID', 'Invalid document ID.')
    return `${STORY_DIRECTORY}/${documentId}.md`
  }

  private receiptPath(cwd: string, documentId: string, operationId: string): string {
    this.filePath(documentId)
    if (!SAFE_ID.test(operationId)) throw new StoryError(400, 'STORY_INVALID_OPERATION_ID', 'Invalid operation ID.')
    return join(cwd, ...RECEIPTS_DIRECTORY.split('/'), documentId, `${operationId}.json`)
  }

  private validateContent(content: string, documentId: string): void {
    if (typeof content !== 'string') throw new StoryError(400, 'STORY_INVALID_CONTENT', 'Markdown content must be a string.')
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new StoryError(413, 'STORY_TOO_LARGE', 'This document exceeds the 8 MiB editing limit; split the work into episode documents.')
    }
    const parsed = parseStoryMarkdown(content)
    if (parsed.format === 'native' && parsed.semanticEditable && parsed.metadata && parsed.metadata.document.id !== documentId) {
      throw new StoryError(409, 'STORY_IDENTITY_CHANGED', 'Document identity cannot be changed by editing its content. Import a copy instead.')
    }
  }

  private parse(content: string, documentId: string) {
    const parsed = parseStoryMarkdown(content)
    if (parsed.metadata && parsed.metadata.document.id !== documentId) {
      parsed.semanticEditable = false
      parsed.diagnostics.push({
        code: 'document-identity-mismatch',
        severity: 'error',
        message: '源稿的文档身份与当前文件不同；原稿保留为待检查内容，禁止语义修改及制作交接。',
        objectId: parsed.metadata.document.id,
      })
    }
    return parsed
  }

  private async readFile(cwd: string, documentId: string): Promise<{ content: string; mtime: Date }> {
    const path = join(cwd, ...this.filePath(documentId).split('/'))
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (codeOf(error) === 'ENOENT') throw new StoryError(404, 'STORY_NOT_FOUND', 'Screenplay not found.')
      throw error
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new StoryError(400, 'STORY_PATH_ESCAPE', 'Story files cannot be symbolic links.')
    return { content: await readFile(path, 'utf8'), mtime: info.mtime }
  }

  private async snapshot(cwd: string, documentId: string, lock?: VersionLock, captureVersion = true): Promise<StoryDocument> {
    const filePath = this.filePath(documentId)
    const file = await this.readFile(cwd, documentId)
    const parsed = this.parse(file.content, documentId)
    let version: FileVersion | undefined
    if (lock !== undefined && captureVersion) {
      // Edits made outside the service (an editor, the agent's file tools) become a manual version.
      version = await lock.ensureCurrentVersion(file.content, { source: 'manual' })
    } else {
      const digest = hash(file.content)
      version = (await listVersions(cwd, filePath)).find(item => item.current && item.contentDigest === digest)
    }
    return {
      documentId,
      title: parsed.metadata?.document.title ?? documentId,
      kind: parsed.metadata?.document.kind ?? 'short',
      filePath,
      revision: hash(file.content),
      updatedAt: file.mtime.toISOString(),
      content: file.content,
      parsed,
      versionId: version?.id ?? null,
    }
  }

  async list(cwd: string): Promise<{ documents: StoryDocumentSummary[] }> {
    let entries
    try {
      entries = await readdir(join(cwd, ...STORY_DIRECTORY.split('/')), { withFileTypes: true })
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return { documents: [] }
      throw error
    }
    const documents: StoryDocumentSummary[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.md$/u.test(entry.name)) continue
      const { content: _content, parsed: _parsed, versionId: _version, ...summary } = await this.snapshot(cwd, entry.name.slice(0, -3))
      documents.push(summary)
    }
    return {
      documents: documents.sort((left, right) =>
        left.title.localeCompare(right.title, undefined, { numeric: true }) || left.documentId.localeCompare(right.documentId)),
    }
  }

  async get(cwd: string, documentId: string): Promise<StoryDocument> {
    return withVersionLock(cwd, this.filePath(documentId), lock => this.snapshot(cwd, documentId, lock))
  }

  async create(cwd: string, input: { title?: string; kind?: StoryDocumentKind; content?: string }): Promise<StoryMutationResult> {
    let documentId = `doc_${randomUUID()}`
    const kind = input.kind === 'episode' ? 'episode' : 'short'
    const title = typeof input.title === 'string' ? input.title : ''
    let content: string
    if (input.content !== undefined) {
      if (typeof input.content !== 'string') throw new StoryError(400, 'STORY_INVALID_CONTENT', 'Markdown content must be a string.')
      const parsed = parseStoryMarkdown(input.content)
      if (parsed.format === 'native' && parsed.semanticEditable && parsed.metadata) {
        const imported = prepareStoryImport(input.content, {
          mode: 'copy',
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          idFactory: type => `${type}_${randomUUID()}`,
          assetIdFactory: () => `asset_${randomUUID()}`,
        })
        content = imported.markdown
        documentId = parseStoryMarkdown(content).metadata!.document.id
      } else if (parsed.format === 'plain') {
        content = createStoryMarkdown({ documentId, title, kind, body: input.content })
      } else {
        content = input.content
      }
    } else {
      content = createStoryMarkdown({ documentId, title, kind })
    }
    this.validateContent(content, documentId)
    return withVersionLock(cwd, this.filePath(documentId), async (lock) => {
      const target = await this.writeTarget(cwd, documentId)
      try {
        await lstat(target)
        throw new StoryError(409, 'STORY_EXISTS', 'Document already exists.')
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error
      }
      await lock.createVersion(content, { source: 'manual', label: title || 'Screenplay' })
      await this.atomicWrite(target, content)
      return { document: await this.snapshot(cwd, documentId, lock), changed: true }
    })
  }

  async save(cwd: string, documentId: string, input: StoryWriteRequest): Promise<StoryMutationResult> {
    this.validateContent(input.content, documentId)
    return this.mutate(cwd, documentId, { ...input, request: { kind: 'save', content: input.content } }, () => ({ content: input.content }))
  }

  async apply(cwd: string, documentId: string, input: StoryApplyRequest): Promise<StoryMutationResult> {
    if (!Array.isArray(input.operations) || input.operations.length > 500) {
      throw new StoryError(400, 'STORY_INVALID_OPERATIONS', 'An array of at most 500 semantic operations is required.')
    }
    if (input.source !== undefined && input.source !== 'manual' && input.source !== 'ai') {
      throw new StoryError(400, 'STORY_INVALID_SOURCE', 'The version source must be manual or ai.')
    }
    return this.mutate(cwd, documentId, { ...input, source: input.source ?? 'ai', request: { kind: 'apply', operations: input.operations } }, (current) => {
      if (!current.parsed.semanticEditable) {
        throw new StoryError(409, 'STORY_NOT_EDITABLE', 'Resolve the current identity or structure diagnostics before applying semantic operations.', current)
      }
      const result = applyStoryOperations(current.content, input.operations)
      return { content: result.markdown, changedIds: result.changedIds }
    })
  }

  async deletionPreview(cwd: string, documentId: string, target: StoryObjectTarget) {
    const document = await this.get(cwd, documentId)
    return { documentId, revision: document.revision, ...inspectStoryObjectDeletion(document.content, target) }
  }

  async history(cwd: string, documentId: string): Promise<{ versions: FileVersion[] }> {
    await this.get(cwd, documentId)
    return { versions: await listVersions(cwd, this.filePath(documentId)) }
  }

  async version(cwd: string, documentId: string, versionId: string): Promise<{ version: FileVersion; content: string }> {
    try {
      return await readVersion(cwd, this.filePath(documentId), versionId)
    } catch (error) {
      if (codeOf(error) === 'ENOENT') throw new StoryError(404, 'STORY_VERSION_NOT_FOUND', 'Version not found.')
      if (codeOf(error) === 'EINVAL') throw new StoryError(400, 'STORY_INVALID_ID', 'Invalid version ID.')
      throw error
    }
  }

  async checkpoint(cwd: string, documentId: string, input: { expectedRevision: string; label: string }): Promise<{ version: FileVersion }> {
    if (typeof input.label !== 'string' || input.label.trim() === '') throw new StoryError(400, 'STORY_LABEL_REQUIRED', 'A version name is required.')
    return withVersionLock(cwd, this.filePath(documentId), async (lock) => {
      const current = await this.snapshot(cwd, documentId, lock)
      if (current.revision !== input.expectedRevision) {
        throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay changed before the named version was saved.', current)
      }
      return { version: await lock.createVersion(current.content, { source: 'manual', label: input.label }) }
    })
  }

  async restore(cwd: string, documentId: string, input: { expectedRevision: string; versionId: string; operationId?: string }): Promise<StoryMutationResult> {
    const historic = await this.version(cwd, documentId, input.versionId)
    return this.mutate(cwd, documentId, {
      ...input, source: 'restore', restoreFromVersionId: input.versionId, request: { kind: 'restore', versionId: input.versionId },
    }, () => ({ content: historic.content }))
  }

  async revert(cwd: string, documentId: string, input: { expectedRevision: string; operationId: string }): Promise<StoryMutationResult> {
    const receipt = await this.readReceipt(cwd, documentId, input.operationId)
    if (!receipt) throw new StoryError(404, 'STORY_OPERATION_NOT_FOUND', 'Operation receipt not found.')
    const before = await this.version(cwd, documentId, receipt.beforeVersionId)
    const after = await this.version(cwd, documentId, receipt.afterVersionId)
    return this.mutate(cwd, documentId, {
      expectedRevision: input.expectedRevision,
      operationId: `revert_${hash(input.operationId).slice(0, 48)}`,
      source: 'manual',
      request: { kind: 'revert', operationId: input.operationId },
    }, (current) => {
      if (!receipt.committed && current.revision !== receipt.afterRevision) {
        throw new StoryError(409, 'STORY_OPERATION_NOT_COMMITTED', 'The original operation has no verified saved result to revert.', current)
      }
      try {
        const content = revertStoryText(before.content, after.content, current.content)
        if (parseStoryMarkdown(before.content).semanticEditable && parseStoryMarkdown(after.content).semanticEditable && !this.parse(content, documentId).semanticEditable) {
          throw new Error('Revert would invalidate current relations.')
        }
        return { content }
      } catch {
        throw new StoryError(409, 'STORY_REVERT_CONFLICT', 'Later edits overlap this operation. Your current draft has been retained.', current)
      }
    })
  }

  private async readReceipt(cwd: string, documentId: string, operationId: string): Promise<OperationReceipt | null> {
    try {
      const receipt = JSON.parse(await readFile(this.receiptPath(cwd, documentId, operationId), 'utf8')) as OperationReceipt
      if (receipt.operationId !== operationId
        || ![receipt.requestDigest, receipt.beforeRevision, receipt.afterRevision].every(digest => typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest))
        || ![receipt.beforeVersionId, receipt.afterVersionId].every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/u.test(id))
        || typeof receipt.committed !== 'boolean') {
        throw new StoryError(409, 'STORY_INVALID_RECEIPT', 'Operation receipt is incomplete or corrupt; no mutation has been retried.')
      }
      return receipt
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return null
      throw error
    }
  }

  /**
   * The one write path: compare-and-swap on `expectedRevision`, receipt lookup
   * for retries, a version for the new content, a write-ahead receipt, the
   * atomic file write, then the receipt marked committed.
   * @param cwd - the workspace directory.
   * @param documentId - the screenplay.
   * @param options - the baseline, identity and description of the change.
   * @param transform - computes the new content from the current document.
   * @returns the mutation result.
   */
  async mutate(
    cwd: string,
    documentId: string,
    options: StoryMutationOptions,
    transform: (current: StoryDocument) => StoryTransformResult | Promise<StoryTransformResult>,
  ): Promise<StoryMutationResult> {
    if (!/^[a-f0-9]{64}$/u.test(options.expectedRevision ?? '')) {
      throw new StoryError(400, 'STORY_BASELINE_REQUIRED', 'Read the document and provide its expectedRevision before writing.')
    }
    const operationId = options.operationId ?? `op_${randomUUID()}`
    const receiptPath = this.receiptPath(cwd, documentId, operationId)
    const digest = requestDigest(options.request)
    return withVersionLock(cwd, this.filePath(documentId), async (lock) => {
      const current = await this.snapshot(cwd, documentId, lock, options.dryRun !== true)
      const receipt = await this.readReceipt(cwd, documentId, operationId)
      if (receipt) {
        if (receipt.requestDigest !== digest) throw new StoryError(409, 'STORY_OPERATION_REUSED', 'Operation ID already belongs to a different request.', current)
        // The write-ahead receipt is durable before the atomic rename: the
        // file digest tells whether a retried request was applied.
        if (receipt.committed || current.revision === receipt.afterRevision) {
          if (!receipt.committed && options.dryRun !== true) await this.atomicWrite(receiptPath, JSON.stringify({ ...receipt, committed: true }))
          return { document: current, changed: false, operationId }
        }
      }
      if (current.revision !== options.expectedRevision) {
        throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay changed since it was read. Your draft has not been overwritten.', current)
      }
      const next = await transform(current)
      this.validateContent(next.content, documentId)
      // Outside editors do not take the lock: check the saved baseline again after the awaited transform.
      const rechecked = await this.snapshot(cwd, documentId, lock, false)
      if (rechecked.revision !== current.revision) throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay changed while preparing this operation.', rechecked)
      if (options.dryRun === true) {
        if (next.content === current.content) return { document: current, changed: false, changedIds: [] }
        const parsed = this.parse(next.content, documentId)
        return {
          document: {
            ...current,
            title: parsed.metadata?.document.title ?? current.title,
            kind: parsed.metadata?.document.kind ?? current.kind,
            content: next.content,
            revision: hash(next.content),
            parsed,
            versionId: null,
          },
          changed: true,
          ...(next.changedIds ? { changedIds: next.changedIds } : {}),
        }
      }
      if (next.content === current.content) {
        const noOp: OperationReceipt = {
          operationId, requestDigest: digest, beforeRevision: current.revision, afterRevision: current.revision,
          beforeVersionId: current.versionId!, afterVersionId: current.versionId!, createdAt: new Date().toISOString(), committed: true, changedIds: [],
        }
        await mkdir(dirname(receiptPath), { recursive: true })
        await this.atomicWrite(receiptPath, JSON.stringify(noOp))
        return { document: current, changed: false, operationId, changedIds: [] }
      }
      const target = await this.writeTarget(cwd, documentId)
      const version = await lock.createVersion(next.content, {
        source: options.source ?? 'manual',
        ...(options.label ? { label: options.label } : {}),
        ...(current.versionId ? { parentVersionId: current.versionId } : {}),
        ...(options.restoreFromVersionId ? { restoreFromVersionId: options.restoreFromVersionId } : {}),
      })
      const nextReceipt: OperationReceipt = {
        operationId, requestDigest: digest, beforeRevision: current.revision, afterRevision: hash(next.content),
        beforeVersionId: current.versionId!, afterVersionId: version.id, createdAt: new Date().toISOString(), committed: false,
        ...(next.changedIds ? { changedIds: next.changedIds } : {}),
      }
      await mkdir(dirname(receiptPath), { recursive: true })
      await this.atomicWrite(receiptPath, JSON.stringify(nextReceipt))
      const finalBaseline = await this.snapshot(cwd, documentId, lock, false)
      if (finalBaseline.revision !== current.revision) {
        throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay changed before committing this operation.', finalBaseline)
      }
      // Failures propagate: no saved response when the document write failed.
      await this.atomicWrite(target, next.content)
      await this.atomicWrite(receiptPath, JSON.stringify({ ...nextReceipt, committed: true }))
      return { document: await this.snapshot(cwd, documentId, lock), changed: true, operationId, ...(next.changedIds ? { changedIds: next.changedIds } : {}) }
    })
  }

  private async writeTarget(cwd: string, documentId: string): Promise<string> {
    const realRoot = await realpath(cwd)
    const directory = join(cwd, ...STORY_DIRECTORY.split('/'))
    await mkdir(directory, { recursive: true })
    const realDirectory = await realpath(directory)
    if (!realDirectory.startsWith(realRoot + sep)) throw new StoryError(400, 'STORY_PATH_ESCAPE', 'Story directory escapes the workspace.')
    const target = join(realDirectory, basename(this.filePath(documentId)))
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new StoryError(400, 'STORY_PATH_ESCAPE', 'Story files cannot be symbolic links.')
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
    }
    return target
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, content, { flag: 'wx' })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
