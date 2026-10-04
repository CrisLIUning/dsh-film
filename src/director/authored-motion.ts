/**
 * Compiling declarative keyframe motion into a skeletal animation (GLB plus
 * its spec and report) under `film/motions/<taskId>/`, and the staging plan
 * that imports it. Ported from Studio's
 * apps/daemon/src/director/authored-motion.ts: the same request checks, task
 * id, receipt, import plan and error codes. Studio runs it as a media task the
 * agent polls; the compiler is pure CPU and finishes in well under a second,
 * so here the call compiles at once and answers with the finished task, and
 * the receipt on disk is what makes a repeated requestId idempotent.
 * @module dsh-film/director/authored-motion
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type { DirectorCompileMotionRequest } from './contracts/index.js'
import { compileAuthoredMotion, validateAuthoredMotion } from './vendor/director-math/schema/authoredMotion.js'

export class MotionCompileError extends Error {
  override name = 'MotionCompileError'

  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/** The finished compile, in the shape of Studio's media-task snapshot. */
export interface MotionTaskSnapshot {
  taskId: string
  projectId: string
  status: 'done'
  progress: string[]
  file: Record<string, unknown>
  reused: boolean
}

/**
 * The request as the wire allows it.
 * @param raw - the body.
 * @returns the request.
 */
export function parseCompileMotionRequest(raw: unknown): DirectorCompileMotionRequest {
  const value = raw as DirectorCompileMotionRequest
  if (!value || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value.requestId)) {
    throw new MotionCompileError(400, 'MOTION_REQUEST_INVALID', 'requestId must be a stable 1–120 character identifier; reuse it only for the same request')
  }
  if (Buffer.byteLength(JSON.stringify(value.spec) ?? '', 'utf8') > 256 * 1024) throw new MotionCompileError(413, 'MOTION_SPEC_TOO_LARGE', 'motion specification exceeds 256 KiB')
  try {
    validateAuthoredMotion(value.spec)
  } catch (error) {
    throw new MotionCompileError(400, 'MOTION_SPEC_INVALID', error instanceof Error ? error.message : String(error))
  }
  return { requestId: value.requestId, spec: value.spec }
}

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** Compiles in flight, by output folder: a concurrent repeat shares the first one's outcome. */
const active = new Map<string, Promise<MotionTaskSnapshot>>()

/**
 * Compile a motion into the film, or answer the receipt a previous identical
 * request left.
 * @param filmRoot - the film folder (`<workspace>/film`).
 * @param projectId - the film's project id (in the import url).
 * @param raw - `{ requestId, spec }`.
 * @returns the finished task.
 */
export async function compileMotionIntoFilm(filmRoot: string, projectId: string, raw: unknown): Promise<MotionTaskSnapshot> {
  const input = parseCompileMotionRequest(raw)
  const taskId = `motion-${sha256(`${projectId}\0${input.requestId}`)}`
  const specDigest = sha256(JSON.stringify(input.spec))
  const key = `${path.resolve(filmRoot)}\0${taskId}`
  const running = active.get(key)
  if (running !== undefined) {
    const first = await running
    if (sha256(JSON.stringify(JSON.parse(await readFile(path.join(filmRoot, 'motions', taskId, 'spec.json'), 'utf8')))) !== specDigest) throw conflict()
    return { ...first, reused: true }
  }
  const work = compile(filmRoot, projectId, taskId, specDigest, input)
  active.set(key, work)
  try {
    return await work
  } finally {
    active.delete(key)
  }
}

const conflict = (): MotionCompileError => new MotionCompileError(409, 'MOTION_REQUEST_CONFLICT', 'requestId already belongs to another specification; use a new requestId for a revision')

async function compile(filmRoot: string, projectId: string, taskId: string, specDigest: string, input: DirectorCompileMotionRequest): Promise<MotionTaskSnapshot> {
  await mkdir(filmRoot, { recursive: true })
  const root = await realpath(filmRoot)
  const motions = path.join(root, 'motions')
  const folder = path.join(motions, taskId)
  // A receipt already on disk answers a repeat: the same spec is reused, another one is refused.
  const prior = await readFile(path.join(folder, 'report.json'), 'utf8').catch(() => undefined)
  if (prior !== undefined) {
    const spec = await readFile(path.join(folder, 'spec.json'), 'utf8')
    if (sha256(JSON.stringify(JSON.parse(spec))) !== specDigest) throw conflict()
    return { taskId, projectId, status: 'done', progress: ['saved; preview required'], file: JSON.parse(prior) as Record<string, unknown>, reused: true }
  }
  // Let the request's other work run before the CPU-bound compile.
  await nextTurn()
  let compiled: ReturnType<typeof compileAuthoredMotion>
  try {
    compiled = compileAuthoredMotion(input.spec)
  } catch (error) {
    throw new MotionCompileError(422, 'MOTION_COMPILE_FAILED', error instanceof Error ? error.message : String(error))
  }
  const hash = sha256(compiled.bytes)
  await mkdir(motions, { recursive: true })
  const owned = await realpath(motions)
  if (owned !== motions) throw new MotionCompileError(400, 'MOTION_PATH_OUTSIDE_PROJECT', 'motion output directory must not be a symlink')
  const relative = `motions/${taskId}/motion.glb`
  const importOp = {
    type: 'import_animation', animationAssetId: `motion-${hash.slice(0, 32)}`, name: compiled.report.name,
    rigProfile: compiled.report.rigProfile,
    source: { url: `/api/projects/${encodeURIComponent(projectId)}/raw/${relative}`, fileName: 'motion.glb', modelFormat: 'glb', byteLength: compiled.bytes.length, contentSha256: hash },
    clips: [{ id: 'clip_1', name: compiled.report.name, duration: compiled.report.duration, trackCount: compiled.report.trackCount }],
  }
  const result = {
    kind: 'authored-motion', projectId, taskId, filePath: relative, contentSha256: hash,
    specPath: `motions/${taskId}/spec.json`, reportPath: `motions/${taskId}/report.json`,
    report: { ...compiled.report, qualityAccepted: false }, importPlan: { ops: [importOp] },
    actionId: `imported-action:${importOp.animationAssetId}:clip_1`,
    next: 'Read director_query actions/structure; dry-run importPlan with director_stage, then apply using the same fingerprint. Preview on the target skeleton before adding or finalizing action clips.',
  }
  const temporary = await mkdtemp(path.join(owned, '.compile-'))
  try {
    // Every write settles before the folder is renamed or removed, so cleanup never races an open handle.
    const writes = await Promise.allSettled([
      writeFile(path.join(temporary, 'motion.glb'), compiled.bytes, { flag: 'wx' }),
      writeFile(path.join(temporary, 'spec.json'), JSON.stringify(input.spec, null, 2), { flag: 'wx' }),
      writeFile(path.join(temporary, 'report.json'), JSON.stringify(result, null, 2), { flag: 'wx' }),
    ])
    const failed = writes.find((write): write is PromiseRejectedResult => write.status === 'rejected')
    if (failed !== undefined) throw failed.reason
    // Published whole or not at all: a reader never sees a GLB without its receipt.
    await rename(temporary, folder)
  } catch (error) {
    throw new MotionCompileError(500, 'MOTION_RECEIPT_SAVE_FAILED', error instanceof Error ? error.message : String(error))
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
  return { taskId, projectId, status: 'done', progress: ['compiling', 'saved; preview required'], file: result, reused: false }
}
