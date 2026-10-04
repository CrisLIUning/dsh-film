/**
 * Folder names no film path may pass through, shared by the workspace scan
 * (which never lists them), the media and import routes (which never serve
 * or take from them) and the film's own location (a workspace inside one is
 * never a film workspace).
 * @module dsh-film/path-rules
 */

import { resolve } from 'node:path'

/** Credential stores: never listed, served or used as a workspace, whatever else allows it. */
export const CREDENTIAL_DIR_NAMES: ReadonlySet<string> = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube'])

/** A name as the file system compares it: Windows drops trailing dots and spaces, and case never matters to these lists. */
export const foldedName = (name: string): string => name.replace(/[. ]+$/u, '').toLowerCase()

/**
 * Whether a folder of this name is a credential store.
 * @param name - the folder's name.
 * @returns true for `.ssh`, `.aws`, `.gnupg`, `.azure` and `.kube`, in any case.
 */
export function isCredentialDirName(name: string): boolean {
  return CREDENTIAL_DIR_NAMES.has(foldedName(name))
}

/**
 * The folder of an absolute path that puts it out of a film's reach: a hidden
 * folder (a name starting with a dot) or a credential store, anywhere on the
 * way from the root. The path is resolved first, so `.` and `..` parts do not count.
 * @param path - an absolute path.
 * @returns the first such folder's name, or `undefined` when there is none.
 */
export function refusedFolderOf(path: string): string | undefined {
  return resolve(path).split(/[\\/]+/u).find(part => part.startsWith('.') || isCredentialDirName(part))
}
