/**
 * The bounded film-surface selection a page sends with a request (which
 * board, node, objects). Copied from Studio's
 * packages/contracts/src/api/film-context.ts.
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

export function renderFilmRunContext(value: unknown): string {
  const context = normalizeFilmRunContext(value);
  if (!context) return '';
  return ['### Current film surface', JSON.stringify(context),
    'These are UI target hints captured when this message was submitted, not proof of current scene state or a screenshot. Use the mounted canvas/director/timeline tools to read before editing. Preserve these exact project, board, node and live-page identities. Re-query revisions/fingerprints before writes. If the live page has closed, report that explicitly; saved scene/timeline queries remain available.',
    'Use director_query for scene structure/sample/diagnostics; canvas_get_state for the live board; timeline tools for the saved cut. Do not substitute a folder listing for these queries. Discover director, edit-vibedev-timeline, space-plan and img2threejs skills as relevant.'].join('\n');
}
