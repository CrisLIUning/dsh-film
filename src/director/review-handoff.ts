/**
 * Handing an approved director review on: staging a generation flow with the
 * reviewed render as its reference. Ported from Studio's
 * apps/daemon/src/director/review-handoff.ts — the same deterministic node
 * ids, request hash and metadata, sent to the open canvas page as
 * `director_stage_review`. The timeline handoff (Studio's `buildShotPlan`
 * over the cut) is not ported yet and is refused with
 * `DIRECTOR_REVIEW_TIMELINE_UNAVAILABLE`.
 * @module dsh-film/director/review-handoff
 */

import { createHash } from 'node:crypto'
import { generationFlowOps } from '../canvas/board-tools.js'
import type { BoardOp } from '../canvas/board-ops.js'
import type { DirectorReviewHandoffRequest, DirectorReviewHandoffResult, DirectorReviewOrigin, DirectorReviewVersion } from './contracts/index.js'
import { DirectorReviewError } from './reviews.js'
import type { ReviewScene } from './reviews.js'

export const DIRECTOR_STAGE_REVIEW_TOOL = 'director_stage_review'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = (message: string): never => { throw new DirectorReviewError(400, 'DIRECTOR_REVIEW_HANDOFF_INVALID', message) }

/** Sends the staged ops to the page that holds the director node; `undefined` when no page is open. */
export type StageReviewOnPage = (scene: ReviewScene, input: Record<string, unknown>) => Promise<unknown | undefined>

/**
 * A prompt node and a generation node with the given ids. dsh-film's flow
 * builder picks fresh ids; a handoff's ids are derived from its operation, so
 * a retry lands on the same nodes. The builder's ids are swapped for those.
 * @param input - the flow's mode, prompt, model, title, references and placement.
 * @param ids - the prompt (text) and generation (config) node ids.
 * @returns the ops.
 */
export function generationFlowOpsWithIds(input: Record<string, unknown>, ids: { text: string; config: string }): BoardOp[] {
  const ops = generationFlowOps(input, null)
  const textId = String(ops[0]?.id ?? '')
  const configId = String(ops[1]?.id ?? '')
  return JSON.parse(JSON.stringify(ops).replaceAll(textId, ids.text).replaceAll(configId, ids.config)) as BoardOp[]
}

/**
 * The handoff a review service runs once the version is approved and unchanged.
 * Handoffs compile into board ops; nothing runs a model.
 * @param stage - reaches the page.
 * @returns the handoff.
 */
export function createReviewHandoff(stage: StageReviewOnPage) {
  return async (scene: ReviewScene, review: DirectorReviewVersion, request: DirectorReviewHandoffRequest): Promise<DirectorReviewHandoffResult> => {
    if (request.target === 'timeline') {
      throw new DirectorReviewError(501, 'DIRECTOR_REVIEW_TIMELINE_UNAVAILABLE', '影视工作台还不能把审阅版直接交给剪辑；请用 timeline_edit 放入审阅视频')
    }
    const file = review.files.find(item => item.path === request.filePath)
    if (!file) return invalid('所选参考文件不属于这一版')
    const origin: DirectorReviewOrigin = {
      source: scene.source, versionId: review.id, number: review.number, fingerprint: review.fingerprint, projectSha256: review.projectSha256,
      file: { path: file.path, sha256: file.sha256, kind: file.kind }, shots: file.shotId ? review.shots.filter(shot => shot.shotId === file.shotId) : review.shots,
    }
    if (!['image', 'video'].includes(request.mode) || (file.kind === 'video' && request.mode !== 'video')) invalid('视频参考需要视频生成节点')
    if (typeof request.prompt !== 'string' || !request.prompt.trim()) invalid('请填写生成提示词')
    if (request.model !== undefined && (typeof request.model !== 'string' || !request.model.trim())) invalid('模型名称无效')
    const seed = digest([scene.source, request.operationId]).slice(0, 24)
    const nodeIds = { reference: `review-ref-${seed}`, prompt: `review-prompt-${seed}`, config: `review-config-${seed}` }
    const requestHash = digest([origin, request.mode, request.prompt.trim(), request.model ?? null])
    const tags = { operationId: request.operationId, requestHash, nodeIds }
    const ops: BoardOp[] = [
      {
        type: 'add_node', id: nodeIds.reference, nodeType: file.kind === 'video' ? 'video' : 'image', title: `V${review.number} · ${file.fileName}`, position: { x: 0, y: 0 },
        metadata: {
          content: file.url, status: 'success', naturalWidth: file.width, naturalHeight: file.height, mimeType: file.kind === 'video' ? 'video/mp4' : 'image/png',
          ...(file.durationSeconds ? { durationMs: Math.round(file.durationSeconds * 1000) } : {}), directorReviewSource: origin, directorHandoff: tags,
        },
      },
      ...generationFlowOpsWithIds({
        mode: request.mode, prompt: request.prompt.trim(), ...(request.model ? { model: request.model } : {}),
        title: `V${review.number} · ${request.mode === 'video' ? '视频生成' : '图像生成'}`, referenceNodeIds: [nodeIds.reference], x: 0, y: 360, autoRun: false,
      }, { text: nodeIds.prompt, config: nodeIds.config }),
    ]
    for (const op of ops) {
      if (op.type === 'add_node' && op.id !== nodeIds.reference) op.metadata = { ...op.metadata as object, directorReviewPlan: origin, directorHandoff: tags }
    }
    if (request.dryRun) return { target: 'generation', committed: false, origin, nodeIds }
    const answer = await stage(scene, { expectedFingerprint: scene.fingerprint, request: { ops, nodeIds, requestHash } })
    if (answer === undefined) throw new DirectorReviewError(409, 'CANVAS_BOARD_NOT_OPEN', '先打开这张画布，再创建生成节点')
    if (!answer || typeof answer !== 'object' || !('saved' in answer) || (answer as { saved?: unknown }).saved !== true) {
      throw new DirectorReviewError(502, 'DIRECTOR_REVIEW_HANDOFF_UNSAVED', '生成节点尚未确认保存，请保持画布打开并重试')
    }
    return { target: 'generation', committed: true, origin, nodeIds }
  }
}
