/**
 * Reference images of the screenplays, ported from Studio's StoryAssets
 * (apps/daemon/src/screenwriter/assets.ts): the film's image library, what a
 * bound reference resolves to, binding a chosen image version to a card and
 * removing that binding.
 *
 * Material stays where it is in the film. The screenplay's metadata owns the
 * stable asset identity and the selected byte version (`sha256`); canvas node
 * ids are navigation hints, never the existence of the reference. Paths are
 * relative to `film/`, so a screenplay reads the same in Studio and here.
 *
 * Deliberate differences from Studio: the library listing reuses digests by
 * path, size and modification time (the exact bytes being bound or read are
 * always hashed afresh), and a board node references a file only when a URL
 * names that path exactly (Studio matches substrings, so `a.png` also matched
 * `a.png.bak`).
 * @module dsh-film/screenwriter/assets
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { applyStoryOperations, isSafeStoryAssetPath } from './contracts/index.js'
import type {
  StoryAsset, StoryAssetCandidate, StoryAssetResolution, StoryBindRequest, StoryDocument, StoryMutationResult, StoryOperation,
} from './contracts/index.js'
import { CanvasAssetStore } from '../canvas/assets.js'
import { CanvasDocumentStore } from '../canvas/documents.js'
import { DigestCache, digestFile, resolveFilmFile } from '../film-files.js'
import { StoryError } from './service.js'
import type { StoryService } from './service.js'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

export class StoryAssets {
  constructor(private readonly story: StoryService, private readonly digests = new DigestCache()) {}

  /**
   * The film's images a card can take as a reference, newest first, with the
   * board nodes that show each one.
   * @param cwd - the workspace directory.
   * @param boardId - the film's board (its project id).
   * @returns the candidates.
   */
  async candidates(cwd: string, boardId: string): Promise<{ assets: StoryAssetCandidate[] }> {
    const library = await new CanvasAssetStore(cwd).read(boardId, boardId)
    const board = await new CanvasDocumentStore(cwd, boardId).read(boardId)
    const nodes = Array.isArray(board?.nodes) ? board.nodes as Array<{ id?: unknown; metadata?: Record<string, unknown> }> : []
    const assets: StoryAssetCandidate[] = []
    for (const asset of library.assets) {
      if (asset.storage !== 'file' || asset.filePath === undefined || asset.filePath === '' || asset.kind !== 'image') continue
      const filePath = asset.filePath
      try {
        const file = await resolveFilmFile(cwd, filePath)
        const sha256 = await this.digests.digest(file)
        assets.push({
          id: asset.id, title: asset.title ?? filePath.split('/').pop() ?? filePath, filePath, mimeType: asset.mimeType ?? file.mime, sizeBytes: file.size, sha256,
          canvasNodeIds: nodes.filter(node => referencesFilmFile(node.metadata, filePath)).flatMap(node => typeof node.id === 'string' ? [node.id] : []),
        })
      } catch {
        // A disappearing file is not a selectable reference.
      }
    }
    return { assets }
  }

  /**
   * Resolve every asset version the screenplay records.
   * @param cwd - the workspace directory.
   * @param document - the saved screenplay.
   * @param boardId - the film's board.
   * @returns one resolution per asset record.
   */
  async resolve(cwd: string, document: StoryDocument, boardId: string): Promise<{ references: StoryAssetResolution[] }> {
    return this.resolveAssets(cwd, document.parsed.metadata?.assets ?? [], boardId)
  }

  private async resolveAssets(cwd: string, assets: readonly StoryAsset[], boardId: string): Promise<{ references: StoryAssetResolution[] }> {
    const references: StoryAssetResolution[] = []
    let candidates: StoryAssetCandidate[] | undefined
    for (const asset of assets) {
      if (!isSafeStoryAssetPath(asset.projectRelativePath)) {
        references.push({ asset, status: 'missing' })
        continue
      }
      let absentStatus: StoryAssetResolution['status'] = 'missing'
      try {
        const file = await resolveFilmFile(cwd, asset.projectRelativePath)
        if (await digestFile(file.absolute) === asset.sha256.toLowerCase()) {
          references.push({ asset, status: 'available', resolvedPath: asset.projectRelativePath })
          continue
        }
        absentStatus = 'version-mismatch'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          references.push({ asset, status: 'missing' })
          continue
        }
      }
      // A file can be renamed while a newer version takes its former path.
      // Resolve only the exact selected bytes; never substitute current bytes.
      candidates ??= (await this.candidates(cwd, boardId)).assets
      const matches = candidates.filter(candidate => candidate.sha256 === asset.sha256.toLowerCase())
      if (matches.length === 1) references.push({ asset, status: 'relocated', resolvedPath: matches[0]!.filePath })
      else {
        references.push({
          asset,
          status: matches.length > 0 ? 'ambiguous' : absentStatus,
          ...(matches.length > 0 ? { candidatePaths: matches.map(candidate => candidate.filePath) } : {}),
        })
      }
    }
    return { references }
  }

  /**
   * The bytes of one bound version, checked against its recorded digest.
   * @param cwd - the workspace directory.
   * @param document - the saved screenplay.
   * @param assetId - the asset.
   * @param versionId - its version.
   * @param boardId - the film's board.
   * @returns the bytes, their type and the file they came from.
   */
  async readReference(cwd: string, document: StoryDocument, assetId: string, versionId: string, boardId: string): Promise<{ buffer: Buffer; mime: string; resolvedPath: string }> {
    const asset = document.parsed.metadata?.assets.find(item => item.id === assetId && item.versionId === versionId)
    if (asset === undefined) throw new StoryError(404, 'STORY_ASSET_NOT_FOUND', 'The reference is not part of this saved screenplay.')
    const reference = (await this.resolveAssets(cwd, [asset], boardId)).references[0]
    if (reference?.resolvedPath === undefined) throw new StoryError(409, 'STORY_ASSET_UNAVAILABLE', `Selected reference version is ${reference?.status ?? 'missing'}.`)
    const file = await resolveFilmFile(cwd, reference.resolvedPath)
    const buffer = await readFile(file.absolute)
    if (createHash('sha256').update(buffer).digest('hex') !== asset.sha256.toLowerCase()) throw new StoryError(409, 'STORY_ASSET_CHANGED', 'The material changed while being read.')
    return { buffer, mime: file.mime, resolvedPath: reference.resolvedPath }
  }

  /**
   * Bind a chosen image version to a card, in one saved screenplay version.
   * @param cwd - the workspace directory.
   * @param documentId - the screenplay.
   * @param request - the image, its digest, the card, scope, purpose and baseline.
   * @param boardId - the film's board.
   * @param source - who made the change, for the version record.
   * @returns the mutation result.
   */
  async bind(cwd: string, documentId: string, request: StoryBindRequest, boardId: string, source: 'manual' | 'ai' = 'manual'): Promise<StoryMutationResult> {
    const { expectedRevision, operationId, ...selection } = request
    return this.story.mutate(cwd, documentId, {
      expectedRevision, ...(operationId !== undefined && operationId !== '' ? { operationId } : {}), label: 'Reference binding', source, request: { kind: 'bind', selection },
    }, async (current) => {
      const metadata = current.parsed.metadata
      if (!current.parsed.semanticEditable || metadata === null || metadata === undefined) {
        throw new StoryError(409, 'STORY_NOT_EDITABLE', 'Resolve screenplay identity and relation diagnostics before binding material.', current)
      }
      if (request.target === undefined || request.target === null || !['entity', 'shot'].includes(request.target.kind) || typeof request.target.id !== 'string'
        || request.scope === undefined || request.scope === null || !['document', 'scene'].includes(request.scope.kind)
        || typeof request.purpose !== 'string' || request.purpose === '' || typeof request.primary !== 'boolean') {
        throw new StoryError(400, 'STORY_BINDING_INVALID', 'Choose a target, scope and purpose for this reference.')
      }
      if (!/^[a-f0-9]{64}$/u.test(request.expectedSha256 ?? '')) throw new StoryError(400, 'STORY_ASSET_VERSION_REQUIRED', 'Choose a material version before binding.')
      const candidate = (await this.candidates(cwd, boardId)).assets.find(item => item.filePath === request.filePath)
      if (candidate === undefined) throw new StoryError(404, 'STORY_ASSET_NOT_FOUND', 'The image is not in the project library.')
      // The listing may answer from its cache; the bytes being bound are hashed now.
      candidate.sha256 = await digestFile((await resolveFilmFile(cwd, candidate.filePath)).absolute)
      if (candidate.sha256 !== request.expectedSha256) throw new StoryError(409, 'STORY_ASSET_CHANGED', 'The selected image changed. Choose its current version explicitly.')
      const replaced = request.replaceBindingId !== undefined ? metadata.bindings.find(binding => binding.id === request.replaceBindingId) : undefined
      if (request.replaceBindingId !== undefined
        && (replaced === undefined || replaced.target.kind !== request.target.kind || replaced.target.id !== request.target.id || !sameScope(replaced.scope, request.scope))) {
        throw new StoryError(400, 'STORY_BINDING_TARGET_MISMATCH', 'Replacement must target the selected card and scope.')
      }
      const samePath = metadata.assets.filter(item => item.projectRelativePath === candidate.filePath)
      const sameVersion = samePath.filter(item => item.sha256.toLowerCase() === candidate.sha256)
      const selectPrevious = (matches: StoryAsset[]): StoryAsset | undefined => matches.find(item => item.id === replaced?.assetId)
        ?? (new Set(matches.map(item => item.id)).size === 1 ? matches[0] : undefined)
      let previous = selectPrevious(sameVersion) ?? selectPrevious(samePath)
      if (previous === undefined) {
        const relocated = (await this.resolve(cwd, current, boardId)).references
          .filter(item => item.status === 'relocated' && item.resolvedPath === candidate.filePath && item.asset.sha256.toLowerCase() === candidate.sha256)
        previous = selectPrevious(relocated.map(item => item.asset))
      }
      const provenance = previous?.provenance
      const canvasOrigin = { canvasAssetId: candidate.id, canvasNodeIds: candidate.canvasNodeIds }
      const asset: StoryAsset = {
        ...previous,
        id: previous?.id ?? `asset_${sha256Hex(`${documentId}\0${candidate.filePath}`).slice(0, 32)}`,
        versionId: previous !== undefined && previous.sha256.toLowerCase() === candidate.sha256 ? previous.versionId : `sha256_${candidate.sha256}`,
        mediaType: candidate.mimeType,
        projectRelativePath: candidate.filePath,
        sha256: candidate.sha256,
        ...(provenance === undefined || (provenance !== null && typeof provenance === 'object' && !Array.isArray(provenance))
          ? { provenance: { ...(provenance as Record<string, unknown> | undefined), ...canvasOrigin } }
          : canvasOrigin),
      }
      const operations: StoryOperation[] = [{ kind: 'upsertAsset', asset }]
      if (request.primary) {
        for (const binding of metadata.bindings) {
          if (binding.id !== request.replaceBindingId && binding.target.kind === request.target.kind && binding.target.id === request.target.id
            && sameScope(binding.scope, request.scope) && binding.purpose === request.purpose && binding.primary) {
            operations.push({ kind: 'upsertBinding', binding: { ...binding, primary: false } })
          }
        }
      }
      operations.push({
        kind: 'upsertBinding',
        binding: {
          id: request.replaceBindingId ?? `binding_${request.operationId !== undefined && request.operationId !== '' ? sha256Hex(request.operationId).slice(0, 32) : randomUUID()}`,
          target: request.target, scope: request.scope, purpose: request.purpose, primary: request.primary, assetId: asset.id, assetVersionId: asset.versionId,
        },
      })
      const result = applyStoryOperations(current.content, operations)
      return { content: result.markdown, changedIds: result.changedIds }
    })
  }

  /**
   * Remove one binding; the material stays. A retry on the same baseline is
   * the same intention: it never removes a binding made again since.
   * @param cwd - the workspace directory.
   * @param documentId - the screenplay.
   * @param bindingId - the binding.
   * @param expectedRevision - the revision read.
   * @param source - who made the change, for the version record.
   * @returns the mutation result.
   */
  async unbind(cwd: string, documentId: string, bindingId: string, expectedRevision: string, source: 'manual' | 'ai' = 'manual'): Promise<StoryMutationResult> {
    const operationId = `unbind_${sha256Hex(`${bindingId}\0${expectedRevision}`).slice(0, 48)}`
    return this.story.mutate(cwd, documentId, { expectedRevision, operationId, source, request: { kind: 'unbind', bindingId }, label: 'Remove reference binding' }, (current) => {
      if (!current.parsed.semanticEditable) throw new StoryError(409, 'STORY_NOT_EDITABLE', 'Resolve screenplay identity and relation diagnostics before removing a reference.', current)
      const bindings = current.parsed.metadata?.bindings ?? []
      const removed = bindings.find(binding => binding.id === bindingId)
      if (removed === undefined) return { content: current.content, changedIds: [] }
      const operations: StoryOperation[] = [{ kind: 'removeRecord', collection: 'bindings', id: bindingId }]
      if (removed.primary) {
        const remaining = bindings.find(binding => binding.id !== bindingId && binding.target.kind === removed.target.kind && binding.target.id === removed.target.id
          && sameScope(binding.scope, removed.scope) && binding.purpose === removed.purpose)
        if (remaining !== undefined) operations.push({ kind: 'upsertBinding', binding: { ...remaining, primary: true } })
      }
      const result = applyStoryOperations(current.content, operations)
      return { content: result.markdown, changedIds: result.changedIds }
    })
  }
}

function sameScope(left: { kind: string; sceneId?: unknown }, right: { kind: string; sceneId?: unknown }): boolean {
  return left.kind === right.kind && left.sceneId === right.sceneId
}

/**
 * Whether node metadata names a film file: the path itself, or a Studio raw or
 * files URL ending at that path (a query or fragment may follow).
 * @param data - a node's metadata.
 * @param filePath - the file, relative to `film/`.
 * @returns whether any value names it.
 */
export function referencesFilmFile(data: Record<string, unknown> | undefined, filePath: string): boolean {
  if (data === undefined) return false
  const encoded = filePath.split('/').map(encodeURIComponent).join('/')
  const endsAt = (value: string, suffix: string): boolean => {
    const at = value.indexOf(suffix)
    if (at < 0) return false
    const next = value.charAt(at + suffix.length)
    return next === '' || next === '?' || next === '#' || endsAt(value.slice(at + 1), suffix)
  }
  const matches = (value: unknown): boolean => typeof value === 'string'
    ? value === filePath || endsAt(value, `/raw/${encoded}`) || endsAt(value, `/files/${encodeURIComponent(filePath)}`)
    : Array.isArray(value) ? value.some(matches) : value !== null && typeof value === 'object' && Object.values(value).some(matches)
  return Object.values(data).some(matches)
}
