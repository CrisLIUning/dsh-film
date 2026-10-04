/**
 * The fingerprint of a director-desk scene, exactly as Studio, the desk and
 * the canvas take it: FNV-1a (32 bit) over `JSON.stringify(project)` code
 * units, written `fnv1a32-<8 hex>` (the desk's schema/projectFingerprint.ts,
 * vendored by Studio as vendor/director-math/schema/projectFingerprint.ts),
 * taken on the project as stored — never on an upgraded copy — with the
 * envelope a desk wraps around it unwrapped (Studio routes/director.ts
 * `fingerprintOfStoredScene`). A fingerprint read in one place is carried
 * back with a write elsewhere and the write is refused when it differs, so
 * every copy of this file must stay byte-for-byte equal in behaviour.
 * @module dsh-film/director/fingerprint
 */

/** The current director project version (the desk's DIRECTOR_PROJECT_VERSION). */
export const DIRECTOR_PROJECT_VERSION = 15

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A deterministic fingerprint of a project's content: a change detector, not
 * a signature.
 * @param project - the project as stored.
 * @returns `fnv1a32-` and eight hex digits.
 */
export function getDirectorProjectFingerprint(project: unknown): string {
  const text = JSON.stringify(project)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * A project the desk can open: the current version or one it knows how to
 * bring forward (versions 1 to 15), with its scene settings and lists.
 * @param value - anything.
 * @returns whether it has a director project's shape.
 */
export function isAnyVersionDirectorProjectShape(value: unknown): value is Record<string, unknown> & { version: number; cameras: unknown[] } {
  if (!isRecord(value)) return false
  return typeof value.version === 'number' && Number.isInteger(value.version) && value.version >= 1 && value.version <= DIRECTOR_PROJECT_VERSION
    && isRecord(value.scene)
    && typeof value.scene.backgroundColor === 'string'
    && Array.isArray(value.assets)
    && Array.isArray(value.objects)
    && Array.isArray(value.cameras)
}

/**
 * The project inside what was stored or handed over: a bare project, or the
 * envelope (`{ project }`) the desk's `project.get` and its exports use.
 * @param value - a stored scene.
 * @returns the project, or `null` when there is none.
 */
export function storedDirectorProject(value: unknown): (Record<string, unknown> & { version: number; cameras: unknown[] }) | null {
  const project = isRecord(value) && !isAnyVersionDirectorProjectShape(value) && isRecord(value.project) ? value.project : value
  return isAnyVersionDirectorProjectShape(project) ? project : null
}

/**
 * The fingerprint of a stored scene, taken on the project exactly as stored —
 * the way whoever stored it took it.
 * @param value - a node's `directorProject`, or a desk's answer.
 * @returns the fingerprint, or `null` when it holds no project.
 */
export function fingerprintOfStoredScene(value: unknown): string | null {
  const project = storedDirectorProject(value)
  return project === null ? null : getDirectorProjectFingerprint(project)
}
