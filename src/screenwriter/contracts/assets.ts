import type { StoryAsset, StoryBinding, StoryBindingScope, StoryDiagnostic, StoryParseResult } from './types.js';

export interface StoryAssetCandidate {
  id: string;
  title: string;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  canvasNodeIds: string[];
}
export interface StoryAssetResolution {
  asset: StoryAsset;
  status: 'available' | 'relocated' | 'missing' | 'version-mismatch' | 'ambiguous';
  resolvedPath?: string;
  candidatePaths?: string[];
}
export interface StoryBindRequest {
  expectedRevision: string;
  filePath: string;
  expectedSha256: string;
  target: StoryBinding['target'];
  scope: StoryBindingScope;
  purpose: string;
  primary: boolean;
  replaceBindingId?: string;
  operationId?: string;
}
export interface StoryReferencePackageManifest {
  format: 'vibedev.screenwriter.package';
  formatVersion: '1.0';
  documentId: string;
  revision: string;
  markdownPath: string;
  /** Digest of the packaged Markdown after reference paths were rewritten. */
  markdownSha256: string;
  complete: boolean;
  files: Array<{ assetId: string; assetVersionId: string; path: string; sha256: string; sizeBytes: number }>;
  missing: Array<{ assetId: string; assetVersionId: string; status: StoryAssetResolution['status'] }>;
}

export interface StoryImportRequest {
  content: string;
  format: 'markdown' | 'package';
  encoding?: 'utf8' | 'base64';
  expectedPreviewDigest?: string;
}
export interface StoryImportPreview {
  digest: string;
  format: StoryParseResult['format'];
  content: string;
  diagnostics: StoryDiagnostic[];
  semanticEditable: boolean;
  entityCount: number;
  sceneCount: number;
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  manifest?: StoryReferencePackageManifest;
  copy: boolean;
}
export interface StoryExportRequest {
  expectedRevision: string;
  mode: 'markdown' | 'body' | 'package';
  allowMissing?: boolean;
}
export interface StoryExportResult {
  documentId: string;
  revision: string;
  fileName: string;
  mimeType: string;
  encoding: 'utf8' | 'base64';
  content: string;
  completeRelations?: boolean;
  manifest?: StoryReferencePackageManifest;
  filePath?: string;
  downloadPath?: string;
}
export type StoryImportPreviewResponse = StoryImportPreview;
export type StoryExportResponse = StoryExportResult;

export interface StorySourcePreview {
  projectId: string;
  documentId: string;
  objectId: string;
  objectKind: 'entity' | 'scene' | 'shot';
  entityKind?: 'person' | 'place' | 'prop';
  /** Readable production brief including style, visual identity and scene state. */
  productionText?: string;
  title: string;
  markdown: string;
  revision: string;
  /** Explicit script evidence, retained even when the production description differs. */
  dependencies?: Array<{ blockId: string; markdown: string }>;
  relatedEntityIds?: string[];
  references: Array<{ assetId: string; assetVersionId: string; url?: string; status: string; primary: boolean; title?: string; sha256?: string }>;
}
export interface StoryHandoffRequest {
  expectedRevision: string;
  objectId: string;
  boardId: string;
  scope?: StoryBindingScope;
  duplicate?: boolean;
  /** Creates a wired, editable image request only; never starts generation. */
  production?: { purpose: import('./production.js').StoryProductionPurpose; requestId: string };
}
export interface StoryHandoffResponse {
  created: boolean;
  node: { id: string; [key: string]: unknown };
  preview: StorySourcePreview;
  boardId: string;
  productionNode?: { id: string; [key: string]: unknown };
  connection?: { id: string; fromNodeId: string; toNodeId: string };
}

export type StoryAdoptionField = 'prompt' | 'references';
export interface StoryAdoptRequest extends Omit<StoryHandoffRequest, 'duplicate' | 'production'> {
  targetNodeId: string;
  fields: StoryAdoptionField[];
  expectedTarget: { prompt?: string; composerContent?: string; references?: string[] };
}
export interface StoryFieldAdoption {
  projectId: string;
  documentId: string;
  objectId: string;
  objectKind: StorySourcePreview['objectKind'];
  revision: string;
  scope: StoryBindingScope;
  snapshot: StorySourcePreview;
  adoptedAt: string;
  contentDigest: string;
}
export interface StoryAdoption extends StoryFieldAdoption {
  /** Fields changed by the latest explicit adoption. */
  fields: StoryAdoptionField[];
  /** Actual source of each field, retained across partial adoption. */
  fieldAdoptions: Partial<Record<StoryAdoptionField, StoryFieldAdoption>>;
}
export interface StoryAdoptResponse {
  node: { id: string; [key: string]: unknown };
  adoption: StoryAdoption;
  preview: StorySourcePreview;
}

export interface StoryImpactResponse {
  documentId: string;
  currentRevision: string;
  items: Array<{
    /** Stable identity of this use, including separate outputs and cut slots. */
    usageId?: string;
    sourceType?: 'input' | 'output' | 'director' | 'timeline-media' | 'timeline-slot';
    nodeId: string;
    clipId?: string;
    directorShotId?: string;
    outputPath?: string;
    objectId: string;
    objectKind: StorySourcePreview['objectKind'];
    title: string;
    field: StoryAdoptionField;
    adoptedRevision: string;
    status: 'unchanged' | 'changed' | 'source-missing' | 'unavailable';
    manualChanged: boolean;
    /** Literal generation inputs differed from the selected adoption snapshot. */
    inputsChanged?: boolean;
  }>;
}
export type StoryImpactItem = StoryImpactResponse['items'][number];

/** The script snapshot and literal inputs used for one generated output. */
export interface StoryOutputSource {
  requestId: string;
  requestedAt: string;
  sourceNodeId: string;
  adoption: StoryAdoption;
  sources?: Array<{ nodeId: string; source: { projectId: string; documentId: string; objectId: string; objectKind: StorySourcePreview['objectKind']; scope?: StoryBindingScope; snapshot?: StorySourcePreview } }>;
  inputs: { prompt: string; referenceImages: string[]; referenceVideos: string[]; referenceAudios: string[] };
  model: string;
  mode: string;
  [key: string]: unknown;
}

/** Actual file provenance on a saved timeline clip. A replacement with an
 * untracked file writes null instead of inheriting the former output's source. */
export interface StoryMediaSource {
  projectId: string;
  boardId: string;
  path: string;
  sha256: string;
  outputs: StoryOutputSource[];
  /** Director renders have camera/link snapshots, not a generation adoption. */
  directorOutputs?: StoryDirectorOutputSource[];
  directorReviews?: import("./director-review.js").DirectorReviewOrigin[];
}

export interface StoryDirectorLink {
  preview: StorySourcePreview;
  scope: StoryBindingScope;
  linkedAt: string;
}

/** The cameras and story links captured for an actual director frame, contact
 * sheet or video. A frame may have zero-length ranges; those are not cut slots. */
export interface StoryDirectorOutputSource {
  sourceNodeId: string;
  directorNodeId?: string;
  renderId?: string;
  renderedAt?: string;
  directorFingerprint?: string;
  shots: Array<{
    shotId: string;
    cameraId: string;
    sourceIn?: number;
    sourceOut?: number;
    start?: number;
    end?: number;
    name?: string;
    storySources: StoryDirectorLink[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}
