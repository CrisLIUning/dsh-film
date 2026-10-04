/**
 * Versioned director reviews: frozen scene versions, comments, approval and
 * handoff. Copied from Studio's packages/contracts/src/api/director-review.ts
 * (the timeline receipt type is left open: that handoff is not ported).
 * @module dsh-film/director/contracts/director-review
 */

import type { DirectorRenderRequest, DirectorRenderedFile } from './director-render.js';
/** The cut's command receipt; the timeline handoff is not ported, so its shape stays open here. */
type ProductionTimelineCommandResult = Record<string, unknown>;

export type DirectorReviewSource = DirectorRenderRequest['source'];
export interface DirectorReviewShot {
  shotId: string; cameraId: string; name: string;
  sourceIn: number; sourceOut: number; start: number; end: number;
}
export interface DirectorReviewComment {
  id: string; text: string; createdAt: string;
  shotId?: string; at?: number;
  resolvedAt?: string;
}
export interface DirectorReviewFile extends DirectorRenderedFile { sha256: string; bytes: number }
/** An immutable reference identity; approval remains on the review record. */
export interface DirectorReviewOrigin {
  source: { boardId: string; nodeId: string; project: string };
  versionId: string; number: number; fingerprint: string; projectSha256: string;
  file: { path: string; sha256: string; kind: DirectorRenderedFile['kind'] };
  shots: DirectorReviewShot[];
}
export type DirectorReviewHandoffRequest = {
  action: 'handoff'; versionId: string; expectedRevision: number; expectedFingerprint: string;
  operationId: string; dryRun: boolean;
} & (
  | { target: 'generation'; filePath: string; mode: 'image' | 'video'; prompt: string; model?: string }
  | { target: 'timeline'; baseRevision?: number; mode: 'append' | 'replace' }
);
export interface DirectorReviewHandoffResult {
  target: 'generation' | 'timeline'; committed: boolean; origin: DirectorReviewOrigin;
  nodeIds?: { reference: string; prompt: string; config: string };
  timeline?: ProductionTimelineCommandResult;
}
export interface DirectorReviewVersion {
  id: string; number: number; name: string; createdAt: string;
  fingerprint: string; projectSha256: string;
  shots: DirectorReviewShot[]; files: DirectorReviewFile[];
  revision: number; comments: DirectorReviewComment[];
  decision: 'unreviewed' | 'changes_requested' | 'approved';
  approvedAt?: string;
}
export type DirectorReviewRequest = { source: DirectorReviewSource } & (
  | { action: 'list' }
  | { action: 'get'; versionId: string; includeProject?: boolean }
  | { action: 'create'; name?: string; expectedFingerprint: string; video?: boolean; quality?: '720p' | '1080p'; fps?: 24 | 30 | 60 }
  | { action: 'comment'; versionId: string; expectedRevision: number; text: string; shotId?: string; at?: number }
  | { action: 'resolve'; versionId: string; expectedRevision: number; commentId: string; resolved: boolean }
  | { action: 'confirm'; versionId: string; expectedRevision: number; expectedFingerprint: string }
  | { action: 'reopen'; versionId: string; expectedRevision: number }
  | DirectorReviewHandoffRequest
);
export interface DirectorReviewResponse {
  source: {boardId: string; nodeId: string; project: string};
  currentFingerprint: string;
  versions: DirectorReviewVersion[];
  /** Full frozen scene is only returned for an explicit get(includeProject:true). */
  project?: unknown;
  handoff?: DirectorReviewHandoffResult;
}
