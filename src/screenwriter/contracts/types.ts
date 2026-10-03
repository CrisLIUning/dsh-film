/** One Markdown file is the creative source of truth. Unknown members remain opaque. */
export const STORY_FORMAT = 'vibedev.screenwriter' as const;
export const STORY_FORMAT_VERSION = '1.0' as const;
export type StoryDocumentKind = 'short' | 'episode';
export type StoryRecord = { id: string; [key: string]: unknown };
export interface StoryDocumentInfo extends StoryRecord {
  kind: StoryDocumentKind;
  title: string;
  targetSeconds?: number | null;
  visualStyle?: string;
}
export interface StoryEntity extends StoryRecord {
  kind: 'person' | 'place' | 'prop';
  profileBlockId: string;
  /** Stable appearance/space identity, separate from dramatic biography. */
  visualIdentity?: string;
  /** Baseline wardrobe/dressing; scene appearances may override this state. */
  visualState?: string;
  status?: string;
  archived?: boolean;
}
export interface StoryScene extends StoryRecord {
  headingBlockId: string;
  blockIds: string[];
  placeId?: string | null;
  placeState?: Record<string, unknown>;
  storyTime?: unknown;
  archived?: boolean;
}
export interface StoryShot extends StoryRecord {
  descriptionBlockId: string;
  sourceBlockIds: string[];
  entityIds: string[];
  sceneId?: string | null;
  estimatedSeconds?: number | null;
  status?: string;
  archived?: boolean;
}
export interface StoryAsset extends StoryRecord {
  versionId: string;
  mediaType: string;
  projectRelativePath: string;
  sha256: string;
}
export type StoryBindingScope =
  | { kind: 'document'; [key: string]: unknown }
  | { kind: 'scene'; sceneId: string; appearanceId?: string; [key: string]: unknown };
export interface StoryBinding extends StoryRecord {
  target: { kind: 'entity' | 'shot'; id: string; [key: string]: unknown };
  scope: StoryBindingScope;
  purpose: string;
  assetId: string;
  assetVersionId: string;
  primary: boolean;
}
/** Explicit suppression distinguishes an empty scene override from inheritance. */
export interface StoryReferenceOverride extends StoryRecord {
  target: StoryBinding['target'];
  scope: Extract<StoryBindingScope, { kind: 'scene' }>;
  purpose: string;
  mode: 'disabled' | 'replace';
}
export interface StorySpeech extends StoryRecord { blockId: string; speakerId: string }
export interface StoryObjectTarget { kind: 'entity' | 'scene' | 'shot'; id: string }
export interface StoryDeletedObject extends StoryRecord {
  kind: StoryObjectTarget['kind'];
  record: StoryEntity | StoryScene | StoryShot;
  title: string;
  orderBeforeId?: string;
  orderAfterId?: string;
}
export interface StoryObjectDependency {
  collection: StoryCollection;
  id: string;
  path: string;
  blockIds: string[];
  /** Body blocks survive deletion; references to those blocks are informational. */
  blocksDeletion: boolean;
}
export interface StoryDeletionPreview {
  target: StoryObjectTarget;
  title: string;
  archived: boolean;
  blockIds: string[];
  dependencies: StoryObjectDependency[];
  canDelete: boolean;
}
export interface StoryDeletionPreviewResponse extends StoryDeletionPreview { documentId: string; revision: string }
export interface StoryMetadata {
  format: typeof STORY_FORMAT;
  formatVersion: string;
  document: StoryDocumentInfo;
  entities: StoryEntity[];
  scenes: StoryScene[];
  shots: StoryShot[];
  assets: StoryAsset[];
  bindings: StoryBinding[];
  referenceOverrides: StoryReferenceOverride[];
  speech: StorySpeech[];
  appearances: StoryRecord[];
  beats: StoryRecord[];
  relationships: StoryRecord[];
  claims: StoryRecord[];
  sceneOrder: string[];
  shotOrder: string[];
  deletedObjects: StoryDeletedObject[];
  [key: string]: unknown;
}
/** UTF-16 offsets into the unchanged source string, end exclusive. */
export interface StoryRange { start: number; end: number }
export interface StoryBlock {
  id: string;
  kind: string;
  markdown: string;
  range: StoryRange;
  contentRange: StoryRange;
  openRange: StoryRange;
  closeRange: StoryRange;
}
export interface StoryDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  range?: StoryRange;
  objectId?: string;
  path?: string;
}
export interface StoryParseResult {
  source: string;
  format: 'native' | 'plain' | 'unsupported' | 'invalid';
  metadata: StoryMetadata | null;
  metadataRange: StoryRange | null;
  blocks: StoryBlock[];
  diagnostics: StoryDiagnostic[];
  semanticEditable: boolean;
}
export interface StoryNewBlock { id: string; kind: string; markdown: string }
export type StoryCollection = 'entities' | 'scenes' | 'shots' | 'assets' | 'bindings' |
  'speech' | 'appearances' | 'beats' | 'relationships' | 'claims' | 'referenceOverrides';
export type StoryOperation =
  | { kind: 'replaceBlock'; blockId: string; markdown: string; expectedMarkdown?: string }
  | { kind: 'appendBlock'; block: StoryNewBlock; afterBlockId?: string }
  | { kind: 'upsertEntity'; entity: StoryEntity; profileMarkdown?: string }
  | { kind: 'upsertScene'; scene: StoryScene; blocks?: StoryNewBlock[]; beforeSceneId?: string }
  | { kind: 'upsertShot'; shot: StoryShot; descriptionMarkdown?: string }
  | { kind: 'upsertAsset'; asset: StoryAsset }
  | { kind: 'upsertBinding'; binding: StoryBinding }
  | { kind: 'upsertRecord'; collection: StoryCollection; record: StoryRecord }
  | { kind: 'removeRecord'; collection: StoryCollection; id: string }
  | { kind: 'setObjectArchived'; target: StoryObjectTarget; archived: boolean }
  | { kind: 'deleteObject'; target: StoryObjectTarget }
  | { kind: 'restoreObject'; target: StoryObjectTarget }
  | { kind: 'renameEntity'; entityId: string; name: string }
  | { kind: 'setSpeechSpeaker'; speechId: string; speakerId: string }
  | { kind: 'reorderScenes'; sceneIds: string[] }
  | { kind: 'reorderShots'; shotIds: string[] }
  | { kind: 'updateDocument'; changes: Partial<Omit<StoryDocumentInfo, 'id'>> };
export interface StoryOperationResult {
  markdown: string;
  changedIds: string[];
  diagnostics: StoryDiagnostic[];
}
export interface StoryDocumentSummary {
  documentId: string;
  title: string;
  kind: StoryDocumentKind;
  filePath: string;
  revision: string;
  updatedAt: string;
}
export interface StoryDocument extends StoryDocumentSummary {
  content: string;
  parsed: StoryParseResult;
  versionId: string | null;
}
export interface StoryWriteRequest {
  expectedRevision: string;
  content: string;
  label?: string;
  operationId?: string;
}
export interface StoryApplyRequest {
  expectedRevision: string;
  operations: StoryOperation[];
  dryRun?: boolean;
  operationId?: string;
  label?: string;
  /** Version attribution: Web card edits are manual; Agent operations are AI. */
  source?: 'manual' | 'ai';
}
export interface StoryMutationResult {
  document: StoryDocument;
  changed: boolean;
  operationId?: string;
  changedIds?: string[];
}
export interface StoryListResponse { documents: StoryDocumentSummary[] }
export interface StoryImportOptions {
  mode: 'preserve' | 'copy';
  /** Must return a fresh opaque ID for each declaration; external asset IDs are separate. */
  idFactory?: (kind: string, previousId: string) => string;
  /** Target-project import adapters assign a new material identity once per source asset. */
  assetIdFactory?: (previousId: string) => string;
  title?: string;
  kind?: StoryDocumentKind;
}
export interface StoryImportResult {
  markdown: string;
  sourceFormat: StoryParseResult['format'];
  idMap: Record<string, string>;
  diagnostics: StoryDiagnostic[];
  semanticEditable: boolean;
  originDocumentId?: string;
}
export interface StoryQueryRequest {
  kind: 'index' | 'content' | 'entities' | 'scenes' | 'shots' | 'bindings' | 'search';
  ids?: string[];
  query?: string;
  offset?: number;
  limit?: number;
}
export interface StoryIndexEntry { id: string; kind: string; title: string; blockIds: string[]; archived?: boolean }
export interface StorySearchHit { id: string; kind: 'search-hit'; text: string; range: StoryRange; blockId?: string }
export interface StoryQueryResponse {
  documentId: string;
  revision: string;
  kind: StoryQueryRequest['kind'];
  coverage: {
    unit: 'characters' | 'items'; total: number; offset: number; returned: number;
    complete: boolean; truncated: boolean; blockIds: string[];
    requestedIds: string[]; missingIds: string[]; fullDocument: boolean;
  };
  items?: Array<StoryBlock | StoryEntity | StoryScene | StoryShot | StoryBinding | StoryIndexEntry | StorySearchHit>;
  content?: string;
}
/** Convenience context; an explicit user target takes precedence over this selection. */
export interface StoryRunContext {
  projectId: string;
  documentId: string;
  revision: string;
  dirty: boolean;
  view: 'body' | 'structure' | 'shots' | 'person' | 'place' | 'prop';
  objectId?: string;
  selection?: { start: number; end: number; text: string };
}
