/**
 * The bounded film-surface selection a page sends with a request (which
 * board, node, objects). Copied from Studio's
 * packages/contracts/src/api/film-context.ts, without renderFilmRunContext
 * (a prompt section naming skills this workbench does not ship).
 * @module dsh-film/director/contracts/film-context
 */

/** A bounded UI selection, captured at send time. Never a scene/database snapshot. */
export interface FilmRunContext {
  projectId: string;
  boardId: string;
  view: 'canvas' | 'director' | 'timeline' | 'screenwriter';
  target?: { projectId: string; clientId: string; incarnation: string };
  selectedNodeIds?: string[];
  director?: { nodeId: string; objectIds: string[]; cameraId?: string; shotId?: string; seconds?: number };
  timeline?: { revision: number; seconds?: number; selectedClipId?: string };
}

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const id = (v: unknown): string => typeof v === 'string' ? v.trim().slice(0, 512) : '';
const ids = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.slice(0, 100).map(id).filter(Boolean))] : [];
const seconds = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
export function normalizeFilmRunContext(value: unknown): FilmRunContext | undefined {
  const v = record(value), projectId = id(v.projectId), boardId = id(v.boardId);
  if (!projectId || !boardId || !['canvas', 'director', 'timeline', 'screenwriter'].includes(String(v.view))) return undefined;
  const out: FilmRunContext = { projectId, boardId, view: v.view as FilmRunContext['view'] };
  const target = record(v.target);
  if (target.projectId === projectId && id(target.clientId) && id(target.incarnation)) out.target = { projectId, clientId: id(target.clientId), incarnation: id(target.incarnation) };
  if (Array.isArray(v.selectedNodeIds)) out.selectedNodeIds = ids(v.selectedNodeIds);
  const director = record(v.director);
  if (id(director.nodeId)) out.director = { nodeId: id(director.nodeId), objectIds: ids(director.objectIds),
    ...(id(director.cameraId) ? { cameraId: id(director.cameraId) } : {}),
    ...(id(director.shotId) ? { shotId: id(director.shotId) } : {}),
    ...(seconds(director.seconds) !== undefined ? { seconds: seconds(director.seconds)! } : {}) };
  const timeline = record(v.timeline);
  if (typeof timeline.revision === 'number' && Number.isSafeInteger(timeline.revision) && timeline.revision >= 0) out.timeline = { revision: timeline.revision,
    ...(seconds(timeline.seconds) !== undefined ? { seconds: seconds(timeline.seconds)! } : {}),
    ...(id(timeline.selectedClipId) ? { selectedClipId: id(timeline.selectedClipId) } : {}) };
  return out;
}
