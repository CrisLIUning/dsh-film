import { z } from 'zod';
import { isJsonObject } from './json-cst.js';
import { pairStoryBlocks, scanStoryTokens, STORY_ID } from './tokens.js';
import { STORY_FORMAT, STORY_FORMAT_VERSION, type StoryBlock, type StoryDiagnostic, type StoryMetadata, type StoryParseResult } from './types.js';

export { pairStoryBlocks, scanStoryTokens, storyBlockTitle, isStoryId, STORY_ID } from './tokens.js';
export type { StoryScanResult, StoryToken } from './tokens.js';

export const StoryIdSchema = z.string().regex(STORY_ID, 'Invalid stable story ID');
const record = z.object({ id: StoryIdSchema }).passthrough();
const ids = z.array(StoryIdSchema);
const target = z.object({ kind: z.enum(['entity', 'shot']), id: StoryIdSchema }).passthrough();
const sceneScope = z.object({ kind: z.literal('scene'), sceneId: StoryIdSchema, appearanceId: StoryIdSchema.optional() }).passthrough();
const scope = z.union([z.object({ kind: z.literal('document') }).passthrough(), sceneScope]);
export const StoryEntitySchema = record.extend({ kind: z.enum(['person', 'place', 'prop']), profileBlockId: StoryIdSchema, visualIdentity: z.string().optional(), visualState: z.string().optional(), status: z.string().optional(), archived: z.boolean().optional() });
export const StorySceneSchema = record.extend({ headingBlockId: StoryIdSchema, blockIds: ids, placeId: StoryIdSchema.nullable().optional(), placeState: z.record(z.unknown()).optional(), archived: z.boolean().optional() });
export const StoryShotSchema = record.extend({ descriptionBlockId: StoryIdSchema, sourceBlockIds: ids, entityIds: ids,
  sceneId: StoryIdSchema.nullable().optional(), estimatedSeconds: z.number().nonnegative().finite().nullable().optional(), status: z.string().optional(), archived: z.boolean().optional() });
export const StoryAssetSchema = record.extend({ versionId: StoryIdSchema, mediaType: z.string().min(1), projectRelativePath: z.string().min(1), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) });
export const StoryBindingSchema = record.extend({ target, scope, purpose: z.string().min(1), assetId: StoryIdSchema, assetVersionId: StoryIdSchema, primary: z.boolean() });
export const StoryObjectTargetSchema = z.object({ kind: z.enum(['entity', 'scene', 'shot']), id: StoryIdSchema });
const deletedObject = z.discriminatedUnion('kind', [
  record.extend({ kind: z.literal('entity'), record: StoryEntitySchema, title: z.string(), orderBeforeId: StoryIdSchema.optional(), orderAfterId: StoryIdSchema.optional() }),
  record.extend({ kind: z.literal('scene'), record: StorySceneSchema, title: z.string(), orderBeforeId: StoryIdSchema.optional(), orderAfterId: StoryIdSchema.optional() }),
  record.extend({ kind: z.literal('shot'), record: StoryShotSchema, title: z.string(), orderBeforeId: StoryIdSchema.optional(), orderAfterId: StoryIdSchema.optional() }),
]).refine((item) => item.id === item.record.id, 'Deleted object identity must match its saved record.');
export const StoryMetadataSchema = z.object({
  format: z.literal(STORY_FORMAT), formatVersion: z.string(),
  document: record.extend({ kind: z.enum(['short', 'episode']), title: z.string(), visualStyle: z.string().optional(), targetSeconds: z.number().finite().nonnegative().nullable().optional() }),
  entities: z.array(StoryEntitySchema).default([]), scenes: z.array(StorySceneSchema).default([]), shots: z.array(StoryShotSchema).default([]),
  assets: z.array(StoryAssetSchema).default([]), bindings: z.array(StoryBindingSchema).default([]),
  referenceOverrides: z.array(record.extend({ target, scope: sceneScope, purpose: z.string().min(1), mode: z.enum(['disabled', 'replace']) })).default([]),
  speech: z.array(record.extend({ blockId: StoryIdSchema, speakerId: StoryIdSchema })).default([]),
  appearances: z.array(record.extend({ visualState: z.string().optional() })).default([]), beats: z.array(record).default([]), relationships: z.array(record).default([]), claims: z.array(record).default([]),
  sceneOrder: ids.default([]), shotOrder: ids.default([]),
  deletedObjects: z.array(deletedObject).default([]),
}).passthrough();

/** Known identity-bearing fields; opaque extensions are never guessed by value. */
export const STORY_REFERENCE_KINDS: Readonly<Record<string, string>> = {
  profileBlockId: 'block', headingBlockId: 'block', descriptionBlockId: 'block', blockId: 'block', blockIds: 'block', sourceBlockIds: 'block', evidenceBlockIds: 'block',
  entityId: 'entity', entityIds: 'entity', speakerId: 'entity', placeId: 'entity', fromEntityId: 'entity', toEntityId: 'entity',
  sceneId: 'scene', sceneIds: 'scene', shotId: 'shot', shotIds: 'shot', appearanceId: 'appearance',
};

export function isSafeStoryAssetPath(path: string): boolean {
  if (!path || /[\u0000-\u001f\u007f\\]/.test(path) || path.startsWith('/') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)) return false;
  // Percent-encoded traversal is never a project filesystem path in this contract.
  if (/%(?:2e|2f|5c|00)/i.test(path)) return false;
  return path.split('/').every((part) => part !== '..' && part !== '.' && part !== '');
}

function validateRelations(metadata: StoryMetadata, blocks: StoryBlock[]): StoryDiagnostic[] {
  const diagnostics: StoryDiagnostic[] = [];
  const error = (code: string, message: string, objectId: string, path?: string) => diagnostics.push({ code, severity: 'error', message, objectId, ...(path ? { path } : {}) });
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const idsByKind: Record<string, Set<string>> = {
    block: new Set(blocksById.keys()), entity: new Set(metadata.entities.map((item) => item.id)),
    scene: new Set(metadata.scenes.map((item) => item.id)), shot: new Set(metadata.shots.map((item) => item.id)),
    appearance: new Set(metadata.appearances.map((item) => item.id)), asset: new Set(metadata.assets.map((item) => item.id)),
  };
  const declarations = new Set<string>([metadata.document.id]);
  for (const collection of ['entities', 'scenes', 'shots', 'bindings', 'referenceOverrides', 'speech', 'appearances', 'beats', 'relationships', 'claims'] as const) {
    for (const item of metadata[collection]) {
      if (declarations.has(item.id)) error('duplicate-id', `稳定 ID 重复：${item.id}`, item.id, collection);
      declarations.add(item.id);
    }
  }
  for (const block of blocks) {
    if (declarations.has(block.id)) error('duplicate-id', `稳定 ID 重复：${block.id}`, block.id);
    declarations.add(block.id);
  }
  const reference = (value: unknown, kind: string, owner: string, path: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) { for (const id of value) reference(id, kind, owner, path); return; }
    if (typeof value !== 'string' || !idsByKind[kind]?.has(value)) error('missing-reference', `关联 ${path} 指向不存在的 ${typeof value === 'string' ? value : JSON.stringify(value)}。`, owner, path);
  };
  const referenceKeys = STORY_REFERENCE_KINDS;
  const inspect = (value: unknown, owner: string, prefix = '') => {
    if (!isJsonObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (Object.hasOwn(referenceKeys, key)) reference(item, referenceKeys[key]!, owner, path);
      else if (['evidence', 'scope', 'state'].includes(key)) inspect(item, owner, path);
    }
  };
  for (const collection of ['entities', 'scenes', 'shots', 'speech', 'appearances', 'beats', 'relationships', 'claims', 'bindings', 'referenceOverrides'] as const) {
    for (const item of metadata[collection]) inspect(item, item.id);
  }
  const verifyOrder = (order: string[], declared: string[], name: string) => {
    if (new Set(order).size !== order.length || order.length !== declared.length || order.some((id) => !declared.includes(id))) error('invalid-order', `${name}顺序必须恰好包含每个稳定 ID 一次。`, metadata.document.id, name);
  };
  verifyOrder(metadata.sceneOrder, metadata.scenes.map((scene) => scene.id), 'sceneOrder');
  verifyOrder(metadata.shotOrder, metadata.shots.map((shot) => shot.id), 'shotOrder');
  const sceneOwnership = new Map<string, string>();
  for (const scene of metadata.scenes) {
    const place = metadata.entities.find((entity) => entity.id === scene.placeId);
    if (place && place.kind !== 'place') error('invalid-place', '场次地点关联必须指向地点卡片。', scene.id, 'placeId');
    if (scene.blockIds[0] !== scene.headingBlockId) error('scene-heading-order', '场标题必须是场次的第一个正文块。', scene.id);
    let last = -1;
    for (const id of scene.blockIds) {
      if (sceneOwnership.has(id)) error('shared-scene-block', '同一正文块不能同时归属两个场次。', scene.id, id);
      sceneOwnership.set(id, scene.id);
      const block = blocksById.get(id);
      if (block && block.range.start <= last) error('scene-block-order', '场次正文块顺序与源稿不一致。', scene.id);
      if (block) last = block.range.start;
    }
  }
  let lastScenePosition = -1;
  for (const id of metadata.sceneOrder) {
    const scene = metadata.scenes.find((item) => item.id === id);
    const block = blocksById.get(scene?.headingBlockId ?? '');
    if (block && block.range.start <= lastScenePosition) error('scene-order-mismatch', '场次顺序与原文位置不一致，请明确选择修复方式。', id);
    if (block) lastScenePosition = block.range.start;
  }
  for (const speech of metadata.speech) {
    const entity = metadata.entities.find((item) => item.id === speech.speakerId);
    if (entity && entity.kind !== 'person') error('invalid-speaker', '署名只能绑定人物。', speech.id);
  }
  const assets = new Set<string>();
  for (const asset of metadata.assets) {
    const key = `${asset.id}\0${asset.versionId}`;
    if (assets.has(key)) error('duplicate-asset-version', '素材身份与版本重复。', asset.id);
    assets.add(key);
    if (declarations.has(asset.id)) error('duplicate-id', '素材身份与创作对象 ID 冲突。', asset.id);
    if (!isSafeStoryAssetPath(asset.projectRelativePath)) diagnostics.push({ code: 'unsafe-asset-path', severity: 'warning', message: '参考路径不属于可读取的项目相对路径；文字引用保留，禁止读取该文件。', objectId: asset.id });
  }
  const deletedIds = new Set<string>();
  for (const deleted of metadata.deletedObjects) {
    if (deletedIds.has(deleted.id) || declarations.has(deleted.id) || idsByKind.asset!.has(deleted.id)) error('reserved-deleted-id', '已删除对象的稳定 ID 仍被保留；请恢复原对象，不能作为新对象复用。', deleted.id);
    deletedIds.add(deleted.id);
  }
  const primary = new Set<string>();
  for (const binding of metadata.bindings) {
    reference(binding.target.id, binding.target.kind, binding.id, 'target');
    if (!assets.has(`${binding.assetId}\0${binding.assetVersionId}`)) error('missing-asset-version', '绑定所选素材版本不存在。', binding.id);
    if (binding.scope.kind === 'scene' && binding.scope.appearanceId) {
      const appearance = metadata.appearances.find((item) => item.id === binding.scope.appearanceId);
      if (appearance && (appearance.sceneId !== binding.scope.sceneId || (binding.target.kind === 'entity' && appearance.entityId !== binding.target.id))) {
        error('binding-appearance-mismatch', '参考绑定的出场记录与目标或场次不一致。', binding.id, 'scope.appearanceId');
      }
    }
    const key = `${binding.target.kind}\0${binding.target.id}\0${binding.scope.kind}\0${binding.scope.kind === 'scene' ? binding.scope.sceneId : ''}\0${binding.purpose}`;
    if (binding.primary && primary.has(key)) error('multiple-primary-references', '同一目标、范围、用途只能有一张主参考。', binding.id);
    if (binding.primary) primary.add(key);
  }
  const overrides = new Set<string>();
  for (const override of metadata.referenceOverrides) {
    reference(override.target.id, override.target.kind, override.id, 'target');
    const key = `${override.target.kind}\0${override.target.id}\0${override.scope.sceneId}\0${override.purpose}`;
    if (overrides.has(key)) error('duplicate-reference-override', '本场参考覆盖设置重复。', override.id);
    overrides.add(key);
  }
  return diagnostics;
}

export function parseStoryMarkdown(source: string): StoryParseResult {
  const scan = scanStoryTokens(source);
  const diagnostics = [...scan.diagnostics];
  const blocks: StoryBlock[] = [];
  const metadataTokens = scan.tokens.filter((token) => token.kind === 'metadata');
  let metadata: StoryMetadata | null = null;
  let format: StoryParseResult['format'] = metadataTokens.length ? 'invalid' : 'plain';
  if (metadataTokens.length > 1) diagnostics.push({ code: 'multiple-metadata', severity: 'error', message: '一份 Markdown 只能声明一个编剧文档。', range: metadataTokens[1]!.range });
  const metadataToken = metadataTokens[0];
  if (metadataToken?.node) {
    const parsed = StoryMetadataSchema.safeParse(metadataToken.node.value);
    if (parsed.success) {
      // Validation supplies defaults only. Keep original object members (including
      // opaque prototype-named JSON keys) instead of a validator's cleaned copy.
      metadata = { ...parsed.data, ...(metadataToken.node.value as Record<string, unknown>) } as StoryMetadata;
      format = metadata.formatVersion === STORY_FORMAT_VERSION || metadata.formatVersion === '0.1-draft' ? 'native' : 'unsupported';
      if (format === 'unsupported') diagnostics.push({ code: 'unsupported-format', severity: 'error', message: `尚不支持 ${metadata.formatVersion} 格式的语义修改；原文完整保留。`, range: metadataToken.range });
    } else for (const issue of parsed.error.issues) diagnostics.push({ code: 'invalid-metadata', severity: 'error', message: issue.message, path: issue.path.join('.'), range: metadataToken.range });
  }
  const paired = pairStoryBlocks(source, scan.tokens);
  blocks.push(...paired.blocks);
  diagnostics.push(...paired.diagnostics);
  if (!metadataTokens.length && scan.tokens.length) diagnostics.push({ code: 'missing-metadata', severity: 'error', message: '原文包含稳定块锚点但缺少文档声明。' });
  if (metadata) diagnostics.push(...validateRelations(metadata, blocks));
  else {
    const seen = new Set<string>();
    for (const block of blocks) {
      if (seen.has(block.id)) diagnostics.push({ code: 'duplicate-id', severity: 'error', message: '正文块 ID 重复。', objectId: block.id });
      seen.add(block.id);
    }
  }
  return { source, format, metadata, metadataRange: metadataToken?.range ?? null, blocks, diagnostics,
    semanticEditable: format === 'native' && !diagnostics.some((diagnostic) => diagnostic.severity === 'error') };
}
