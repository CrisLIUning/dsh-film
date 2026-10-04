/**
 * What a saved screenplay's changes touch in production, ported from Studio's
 * StoryImpact (apps/daemon/src/screenwriter/impact.ts): every adopted field on
 * the board, every output generated from a source and every director-shot link
 * that records a screenplay snapshot is compared with the current saved
 * screenplay, field by field. It reads only; no change here adopts a new
 * reference or rewrites an output.
 *
 * The board is the film's one board (`film/canvas/document.json`). Studio also
 * compares the clips of its cut; this workbench has no cut, and an old
 * `film/canvas/timeline.json` is never read.
 * @module dsh-film/screenwriter/impact
 */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { StoryAdoption, StoryAdoptionField, StoryBindingScope, StoryFieldAdoption, StoryImpactItem, StoryImpactResponse, StorySourcePreview } from './contracts/index.js'
import { CanvasDocumentStore } from '../canvas/documents.js'
import { filmProjectOf } from './handoff.js'
import type { StoryHandoff } from './handoff.js'
import { StoryError } from './service.js'
import type { StoryService } from './service.js'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const referenceSelection = (source: StorySourcePreview) => source.references.map(reference => ({ assetId: reference.assetId, assetVersionId: reference.assetVersionId, sha256: reference.sha256 }))
type Use = Pick<StoryImpactItem, 'nodeId' | 'title' | 'sourceType' | 'outputPath' | 'directorShotId'> & { usageId: string }

export class StoryImpact {
  /**
   * @param story - the screenplay store.
   * @param handoff - source previews, to compare with.
   */
  constructor(private readonly story: StoryService, private readonly handoff: StoryHandoff) {}

  /**
   * Compare saved inputs and actual outputs independently with the current
   * saved screenplay.
   * @param cwd - the workspace directory.
   * @param documentId - the screenplay.
   * @returns one item per use and field.
   */
  async read(cwd: string, documentId: string): Promise<StoryImpactResponse> {
    const projectId = (await filmProjectOf(cwd)).id
    const document = await this.story.get(cwd, documentId)
    const board = await new CanvasDocumentStore(cwd, projectId).read(projectId)
    const result: StoryImpactResponse = { documentId, currentRevision: document.revision, items: [] }
    const previews = new Map<string, Promise<StorySourcePreview>>()
    const seen = new Set<string>()
    const append = async (use: Use, snapshot: StorySourcePreview, scope: StoryBindingScope, field: StoryAdoptionField, manualChanged = false, inputsChanged?: boolean): Promise<void> => {
      if (snapshot?.documentId !== documentId || snapshot.projectId !== projectId || !snapshot.objectId || !Array.isArray(snapshot.references)) return
      const usageId = `${use.usageId}:${snapshot.objectId}:${field}`
      if (seen.has(usageId)) return
      seen.add(usageId)
      let status: StoryImpactItem['status']
      try {
        const key = JSON.stringify([snapshot.objectId, scope])
        let pending = previews.get(key)
        if (!pending) {
          pending = this.handoff.preview(cwd, documentId, snapshot.objectId, scope)
          previews.set(key, pending)
        }
        status = compareAdoption(field, snapshot, await pending)
      } catch (error) {
        if (!(error instanceof StoryError)) throw error
        status = error.code === 'STORY_SOURCE_NOT_FOUND' ? 'source-missing' : 'unavailable'
      }
      result.items.push({
        ...use, usageId, objectId: snapshot.objectId, objectKind: snapshot.objectKind, title: use.title || snapshot.title, field, adoptedRevision: snapshot.revision, status, manualChanged,
        ...(inputsChanged !== undefined ? { inputsChanged } : {}),
      })
    }
    const adoption = async (use: Use, value: unknown, metadata?: Record<string, unknown>, inputs?: Record<string, unknown>): Promise<void> => {
      const adopted = record(value) as unknown as StoryAdoption | undefined
      if (!adopted) return
      for (const field of ['prompt', 'references'] as const) {
        const source: StoryFieldAdoption | undefined = adopted.fieldAdoptions?.[field] ?? (adopted.fields?.includes(field) ? adopted : undefined)
        if (source?.documentId !== documentId || source.projectId !== projectId || !source.snapshot) continue
        const current = field === 'prompt' ? { prompt: metadata?.prompt, composerContent: metadata?.composerContent } : { references: metadata?.references }
        await append(use, source.snapshot, source.scope, field, Boolean(metadata && adopted.fieldAdoptions?.[field] && digest(current) !== source.contentDigest),
          inputs ? generationInputsDiffer(field, source.snapshot, inputs) : undefined)
      }
    }
    const linkedSources = async (use: Use, values: unknown): Promise<void> => {
      for (const [index, value] of array(values).entries()) {
        const source = record(record(value)?.source)
        if (!record(source?.snapshot)) continue
        for (const field of ['prompt', 'references'] as const) {
          await append({ ...use, usageId: `${use.usageId}:linked:${index}` }, source!.snapshot as StorySourcePreview, (source?.scope as StoryBindingScope | undefined) ?? { kind: 'document' }, field)
        }
      }
    }
    const links = async (use: Use, values: unknown): Promise<void> => {
      for (const [index, raw] of array(values).entries()) {
        const link = record(raw)
        if (!record(link?.preview) || !record(link?.scope)) continue
        for (const field of ['prompt', 'references'] as const) await append({ ...use, usageId: `${use.usageId}:${index}` }, link!.preview as StorySourcePreview, link!.scope as StoryBindingScope, field)
      }
    }
    for (const raw of array(board?.nodes)) {
      const node = record(raw)
      const metadata = record(node?.metadata)
      if (typeof node?.id !== 'string' || !metadata) continue
      const use = { nodeId: node.id, title: typeof node.title === 'string' ? node.title : '', usageId: `input:${node.id}`, sourceType: 'input' as const }
      await adoption(use, metadata.storyAdoption, metadata)
      const outputs = [metadata, ...array(metadata.storyOutputHistory), ...array(metadata.images), ...array(metadata.texts)]
      for (const value of outputs) {
        const entry = record(value)
        const source = record(entry?.storyOutputSource)
        const content = entry?.content ?? entry?.url ?? entry?.src
        if (!source || typeof source.requestId !== 'string' || typeof content !== 'string' || !content) continue
        const output = { ...use, sourceType: 'output' as const, usageId: `output:${node.id}:${source.requestId}:${digest(content)}`, outputPath: content }
        await linkedSources(output, source.sources)
        await adoption(output, source.adoption, undefined, record(source.inputs))
      }
      for (const [shotId, values] of Object.entries(record(metadata.storyDirectorLinks) ?? {})) {
        await links({ ...use, sourceType: 'director', usageId: `director:${node.id}:${shotId}`, directorShotId: shotId }, values)
      }
      for (const rawShot of array(record(metadata.directorSequence)?.shots)) {
        const shot = record(rawShot)
        const shotId = String(shot?.shotId ?? shot?.cameraId ?? '')
        if (shotId) {
          await links({ ...use, sourceType: 'output', usageId: `director-output:${node.id}:${shotId}`, directorShotId: shotId, ...(typeof metadata.content === 'string' ? { outputPath: metadata.content } : {}) }, shot?.storySources)
        }
      }
    }
    // Findings must refer to one saved screenplay.
    const latest = await this.story.get(cwd, documentId)
    if (latest.revision !== document.revision) {
      throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay changed while checking production impact. Refresh the comparison.', latest)
    }
    return result
  }
}

/**
 * This says inputs differed, not who changed them: linked nodes, truncation
 * and a user's edit can all alter the actual request after reference adoption.
 */
function generationInputsDiffer(field: StoryAdoptionField, snapshot: StorySourcePreview, inputs: Record<string, unknown>): boolean | undefined {
  if (field === 'prompt') return typeof inputs.prompt === 'string' ? inputs.prompt !== (snapshot.productionText ?? snapshot.markdown) : undefined
  if (!Array.isArray(inputs.referenceImages)) return undefined
  const hashes = [...new Set(snapshot.references.map(reference => reference.sha256))]
  const actual = inputs.referenceImages.map((value) => {
    if (typeof value !== 'string') return null
    try {
      const url = new URL(value, 'http://local.invalid')
      const match = /^\/api\/projects\/([^/]+)\/raw\/canvas\/story-references\/([a-f0-9]{64})\.[a-z0-9]+$/u.exec(decodeURIComponent(url.pathname))
      return match?.[1] === snapshot.projectId ? match[2] : value
    } catch {
      return value
    }
  })
  return !isDeepStrictEqual(hashes, actual) || array(inputs.referenceVideos).length > 0 || array(inputs.referenceAudios).length > 0
}

function compareAdoption(field: StoryAdoptionField, adopted: StorySourcePreview, current: StorySourcePreview): StoryImpactItem['status'] {
  if (field === 'references') {
    if (current.references.some(reference => reference.status !== 'available' && reference.status !== 'relocated')) return 'unavailable'
    return isDeepStrictEqual(referenceSelection(adopted), referenceSelection(current)) ? 'unchanged' : 'changed'
  }
  return (adopted.productionText ?? adopted.markdown) === (current.productionText ?? current.markdown) && (!adopted.dependencies || isDeepStrictEqual(adopted.dependencies, current.dependencies)) ? 'unchanged' : 'changed'
}
