/**
 * The editing desk's material: the film's media as the editor's authorized
 * assets, and the workspace's own media as files it may import. The import
 * itself is the canvas's (src/canvas/workspace-import.ts).
 * @module dsh-film/studio/material
 */

import { basename, extname } from 'node:path'
import { listFilmMedia, listWorkspaceMedia, mediaTypeOf, workspaceMediaUrl } from '../media.js'
import type { MediaKind } from '../media.js'
import { withoutImported } from '../media-imports.js'
import { CANVAS_FILE_VERSION_PREFIX, projectRawUrl } from '../timeline/commands.js'

/** Media the editor can place: Studio's list for a board. */
const EDITOR_MEDIA = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'm4a', 'mp4', 'webm', 'mov'])

/** An asset the editor may play and place (the bridge's `VideoEditorAuthorizedAsset`). */
export interface AuthorizedAsset {
  assetId: string
  versionId: string
  kind: MediaKind
  name: string
  url: string
  mimeType: string
  sizeBytes?: number
}

/** A workspace file the editor lists for import (the bridge's `VideoEditorProjectFile`). */
export interface WorkspaceMediaFile {
  id: string
  path: string
  name: string
  kind: MediaKind
  url: string
  mimeType: string
  sizeBytes?: number
  mtime?: number
}

export const editorMedia = (path: string): boolean => EDITOR_MEDIA.has(extname(path).slice(1).toLowerCase())

// ---------------------------------------------------------------------------
// The material listing.

/**
 * The film's media as the editor's authorization list, and the workspace's
 * own media as files it may import. Every editor-playable file under `film/`
 * is in the list — one left out is a clip the editor drops on its next save —
 * so the film has a full scan of its own, apart from the workspace's capped one.
 * A workspace file imported before and unchanged since is not offered again.
 * @param cwd - the workspace directory.
 * @param projectId - the film project's id.
 * @returns the assets and the importable files, newest first, and whether the workspace scan stopped early.
 */
export async function timelineMaterial(cwd: string, projectId: string): Promise<{ assets: AuthorizedAsset[]; projectFiles: WorkspaceMediaFile[]; truncated: boolean }> {
  const [film, workspace] = await Promise.all([listFilmMedia(cwd), listWorkspaceMedia(cwd)])
  const assets: AuthorizedAsset[] = []
  for (const file of film) {
    const type = mediaTypeOf(file.path)
    if (!editorMedia(file.path) || type === undefined) continue
    const identity = `${CANVAS_FILE_VERSION_PREFIX}${file.path}`
    assets.push({ assetId: identity, versionId: identity, kind: file.kind, name: basename(file.path), url: projectRawUrl(projectId, file.path), mimeType: type.type, sizeBytes: file.bytes })
  }
  const projectFiles: WorkspaceMediaFile[] = []
  for (const file of await withoutImported(cwd, workspace.files, new Set(film.map(entry => entry.path)))) {
    const type = mediaTypeOf(file.path)
    if (!editorMedia(file.path) || type === undefined) continue
    projectFiles.push({
      id: `workspace:${file.path}`,
      path: file.path,
      name: basename(file.path),
      kind: file.kind,
      url: workspaceMediaUrl(cwd, file.path),
      mimeType: type.type,
      sizeBytes: file.bytes,
      mtime: Date.parse(file.modifiedAt),
    })
  }
  return { assets, projectFiles, truncated: workspace.truncated }
}
