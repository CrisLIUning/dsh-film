/**
 * The img2threejs forge's progress for one model, read from
 * `film/models/<id>/.img2threejs/state.json` and the model's top-level source
 * entries. Ported from Studio's apps/daemon/src/services/models/model-workflow.ts.
 *
 * It is reported, never treated as a quality verdict: a ticked checklist says
 * the forge moved on, not that the model is right. It also lets the panel and
 * model_report show a model that has source but no record yet.
 * @module dsh-film/modeling/workflow
 */

import { createHash } from 'node:crypto'
import type { ModelKind, ModelWorkflow } from './contracts/model-project.js'
import { listFilmFolder, readFilmFile } from './store.js'

const LIMIT = 2_000_000

/**
 * Read a model's forge progress.
 * @param cwd - the workspace directory.
 * @param id - the model id.
 * @returns the progress, or `null` when the model has neither forge state nor entries.
 */
export async function readModelWorkflow(cwd: string, id: string): Promise<ModelWorkflow | null> {
  const root = `models/${id}`
  const readJson = async (name: string): Promise<Record<string, unknown> | null> => {
    try {
      const file = await readFilmFile(cwd, `${root}/${name}`)
      if (file.size > LIMIT) return null
      const value: unknown = JSON.parse(file.buffer.toString('utf8'))
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    } catch {
      return null
    }
  }
  const state = await readJson('.img2threejs/state.json')
  const children = await listFilmFolder(cwd, root)
  const entries = (children?.files ?? [])
    .filter(name => /\.(?:ts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')).sort().map(name => `${root}/${name}`)
  if (state === null && entries.length === 0) return null
  const steps = (Array.isArray(state?.checklist) ? state.checklist : []).slice(0, 100)
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map(item => ({ id: String(item.id ?? '').slice(0, 100), status: String(item.status ?? 'pending').slice(0, 40) }))
  // The revision moves with any entry's content, so a reader can tell the source changed.
  const hash = createHash('sha256')
  for (const entry of entries) {
    const file = await readFilmFile(cwd, entry).catch(() => null)
    hash.update(entry)
    if (file !== null && file.size <= LIMIT) hash.update(file.buffer)
  }
  const warnings: string[] = []
  const admission = await readJson('evidence/reference-admission.json')
  if (admission?.admitted === false) warnings.push('参考图准入报告未通过；流程勾选完成不代表这个问题已解决。')
  const kind: ModelKind = state?.profile === 'character' ? 'character' : 'prop'
  return {
    kind,
    entries,
    sourceRevision: hash.digest('hex'),
    currentStep: typeof state?.currentStep === 'string' ? state.currentStep.slice(0, 100) : null,
    currentPass: typeof state?.currentPass === 'string' ? state.currentPass.slice(0, 100) : null,
    status: typeof state?.status === 'string' ? state.status.slice(0, 40) : 'source-ready',
    steps,
    warnings,
  }
}
