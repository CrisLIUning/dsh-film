// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorProject } from "./directorProject.js";

/**
 * A deterministic fingerprint of a project's content.
 *
 * Whoever reads a project carries this back with their write, and the write
 * is refused if the project has changed in between — the host, the daemon and
 * the desk all use the same function, so a fingerprint taken in one place
 * means the same thing in another. It is a change detector, not a signature.
 */
export function getDirectorProjectFingerprint(project: DirectorProject) {
  const text = JSON.stringify(project);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
