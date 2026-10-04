/**
 * The director scene's change detector, taken the way Studio takes it
 * (apps/daemon/src/routes/director.ts `fingerprintOfStoredScene`, over the
 * desk's FNV-1a `getDirectorProjectFingerprint`): on the project exactly as
 * stored, envelope unwrapped and never upgraded, so a fingerprint taken here
 * matches the one the desk and the canvas take of the same bytes.
 * @module dsh-film/director/fingerprint
 */

import { isAnyVersionDirectorProjectShape } from './vendor/director-math/schema/directorProjectMigration.js'
import { getDirectorProjectFingerprint } from './vendor/director-math/schema/projectFingerprint.js'

export { getDirectorProjectFingerprint }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * The fingerprint of a stored scene: a bare project of any version, or the
 * desk's `{ project }` envelope around one.
 * @param value - what a director node's `metadata.directorProject` (or a desk's `project.get`) holds.
 * @returns `fnv1a32-<8 hex>`, or `null` when it is not a desk project.
 */
export function fingerprintOfStoredScene(value: unknown): string | null {
  const project = isRecord(value) && !isAnyVersionDirectorProjectShape(value) && isRecord(value.project) ? value.project : value
  return isAnyVersionDirectorProjectShape(project) ? getDirectorProjectFingerprint(project as never) : null
}
