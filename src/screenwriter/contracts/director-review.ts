/**
 * Where a reviewed director-desk render came from, as recorded on media that
 * used it. Mirrors Studio's `DirectorReviewOrigin` with the shot and file
 * details left open: the screenwriter only stores and compares these records.
 */
export interface DirectorReviewOrigin {
  source: { boardId: string; nodeId: string; project: string };
  versionId: string; number: number; fingerprint: string; projectSha256: string;
  file: { path: string; sha256: string; kind: string };
  shots: Record<string, unknown>[];
}
