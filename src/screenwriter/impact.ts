/**
 * What a saved screenplay's changes touch in production, ported from Studio's
 * StoryImpact (apps/daemon/src/screenwriter/impact.ts): every adopted field on
 * the board, every output generated from a source, every director-shot link
 * and every timeline clip that records a screenplay snapshot is compared with
 * the current saved screenplay, field by field. It reads only; no change here
 * adopts a new reference, rewrites an output or changes a timeline.
 *
 * The board is the film's one board (`film/canvas/document.json`) and the cut
 * its one timeline (`film/canvas/timeline.json`). Timeline items appear only
 * where clips carry `director.storySources` or `storyMediaSource`.
 * @module dsh-film/screenwriter/impact
 */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { StoryAdoption, StoryAdoptionField, StoryBindingScope, StoryFieldAdoption, StoryImpactItem, StoryImpactResponse, StorySourcePreview } from './contracts/index.js'
import { CanvasDocumentStore } from '../canvas/documents.js'
import { TimelineStore } from '../timeline/store.js'
import { filmProjectOf } from './handoff.js'
import type { StoryHandoff } from './handoff.js'
import { StoryError } from './service.js'
import type { StoryService } from './service.js'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const referenceSelection = (source: StorySourcePreview) => source.references.map(reference => ({ assetId: reference.assetId, assetVersionId: reference.assetVersionId, sha256: reference.sha256 }))
type Use = Pick<StoryImpactItem, 'nodeId' | 'title' | 'sourceType' | 'clipId' | 'outputPath' | 'directorShotId'> & { usageId: string }

export class StoryImpact {
  /**
   * @param story - the screenplay store.
   * @param handoff - source previews, to compare with.
   */
  constructor(private readonly story: StoryService, private readonly handoff: StoryHandoff) {}

  /**
   * Compare saved inputs, actual outputs and cut slots independently with the
   * current saved screenplay.
   * @param cwd - the workspace directory.
   * @param documentId - the screenplay.
   * @returns one item per use and field.
   */
  async read(cwd: string, documentId: string): Promise<StoryImpactResponse> {
    const projectId = (await filmProjectOf(cwd)).id
    const document = await this.story.get(cwd, documentId)
    const board = await new CanvasDocumentStore(cwd, projectId).read(projectId)
    const timelineStore = new TimelineStore(cwd)
    const timeline = await timelineStore.read()
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
    const project = record(record(timeline.document)?.project)
    for (const track of ['visualSegments', 'visualOverlaySegments', 'audioSegments', 'musicSegments']) {
      for (const raw of array(project?.[track])) {
        const clip = record(raw)
        if (typeof clip?.id !== 'string') continue
        const director = record(clip.director)
        const media = record(clip.storyMediaSource)
        const use = { nodeId: typeof director?.nodeId === 'string' ? director.nodeId : '', title: typeof clip.name === 'string' ? clip.name : clip.id, clipId: clip.id, usageId: `clip:${track}:${clip.id}` }
        await links({ ...use, sourceType: 'timeline-slot', ...(typeof director?.shotId === 'string' ? { directorShotId: director.shotId } : {}) }, director?.storySources)
        if (media?.projectId !== projectId) continue
        for (const [index, rawOutput] of array(media.outputs).entries()) {
          const output = record(rawOutput)
          if (!output) continue
          await linkedSources({ ...use, sourceType: 'timeline-media', usageId: `${use.usageId}:media:${index}` }, output.sources)
          await adoption({
            ...use, sourceType: 'timeline-media', usageId: `${use.usageId}:media:${index}`, nodeId: typeof output.sourceNodeId === 'string' ? output.sourceNodeId : '',
            ...(typeof media.path === 'string' ? { outputPath: media.path } : {}),
          }, output.adoption, undefined, record(output.inputs))
        }
        for (const rawOutput of array(media.directorOutputs)) {
          const output = record(rawOutput)
          if (!output) continue
          for (const rawShot of array(output.shots)) {
            const shot = record(rawShot)
            const shotId = typeof shot?.shotId === 'string' ? shot.shotId : ''
            if (!shotId || !directorShotOverlapsClip(shot!, clip)) continue
            await links({
              ...use, sourceType: 'timeline-media', usageId: `${use.usageId}:director-media:${digest(output)}:${shotId}`, nodeId: typeof output.sourceNodeId === 'string' ? output.sourceNodeId : '',
              directorShotId: shotId, ...(typeof media.path === 'string' ? { outputPath: media.path } : {}),
            }, shot?.storySources)
          }
        }
      }
    }
    // Findings must refer to one saved screenplay and one saved cut.
    const latest = await this.story.get(cwd, documentId)
    if (latest.revision !== document.revision || (await timelineStore.read()).revision !== timeline.revision) {
      throw new StoryError(409, 'STORY_CONFLICT', 'The screenplay or timeline changed while checking production impact. Refresh the comparison.', latest)
    }
    return result
  }
}

/**
 * Renders retain the full file's camera manifest. A trimmed video clip uses
 * only intersecting file ranges; sourceIn/sourceOut refer to director scene
 * time and must not be confused with the rendered file's start/end. Images
 * (including contact sheets) retain all represented cameras, even at t=0.
 */
function directorShotOverlapsClip(shot: Record<string, unknown>, clip: Record<string, unknown>): boolean {
  if (clip.type !== 'video' && clip.sourceKind !== 'video') return true
  const start = typeof clip.sourceStart === 'number' ? clip.sourceStart : 0
  const duration = clip.duration
  const rate = typeof clip.playbackRate === 'number' ? clip.playbackRate : 1
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(start) || !Number.isFinite(rate) || rate <= 0
    || typeof shot.start !== 'number' || typeof shot.end !== 'number' || shot.end <= shot.start) return true
  return shot.start < start + duration * rate - 1e-6 && shot.end > start + 1e-6
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
