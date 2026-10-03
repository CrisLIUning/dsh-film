import { applyTextEdits, editJsonValue, isJsonObject, type TextEdit } from './json-cst.js';
import { createStoryMarkdown, StoryOperationError } from './operations.js';
import { parseStoryMarkdown, scanStoryTokens, StoryIdSchema } from './parser.js';
import type { StoryBinding, StoryDiagnostic, StoryImportOptions, StoryImportResult, StoryMetadata } from './types.js';

/** Reading exchange is deliberately distinct from a lossless native export (which is source itself). */
export function projectStoryBody(source: string): string {
  const scan = scanStoryTokens(source);
  // Incomplete/malformed comments are author input, never silently deleted.
  const ranges = scan.tokens.filter((token) => token.node !== null).map((token) => ({ ...token.range, text: '' }));
  return applyTextEdits(source, ranges);
}

const collections = ['entities', 'scenes', 'shots', 'bindings', 'referenceOverrides', 'speech', 'appearances', 'beats', 'relationships', 'claims', 'deletedObjects'] as const;
const references = new Set(['profileBlockId', 'headingBlockId', 'descriptionBlockId', 'blockId', 'blockIds', 'sourceBlockIds', 'evidenceBlockIds', 'entityId', 'entityIds', 'speakerId', 'placeId', 'fromEntityId', 'toEntityId', 'sceneId', 'sceneIds', 'shotId', 'shotIds', 'appearanceId', 'assetId', 'assetIds', 'orderBeforeId', 'orderAfterId']);

/** Source is retained for every failure. Copying never guesses identities from names or prose. */
export function prepareStoryImport(source: string, options: StoryImportOptions): StoryImportResult {
  const parsed = parseStoryMarkdown(source);
  const idMap: Record<string, string> = Object.create(null) as Record<string, string>;
  const result = (markdown: string, diagnostics = parsed.diagnostics): StoryImportResult => ({
    markdown, sourceFormat: parsed.format, idMap, diagnostics, semanticEditable: parseStoryMarkdown(markdown).semanticEditable,
    ...(parsed.metadata ? { originDocumentId: parsed.metadata.document.id } : {}),
  });
  if (options.mode === 'preserve') return result(source);
  if (parsed.format !== 'plain' && !parsed.semanticEditable) return result(source, [...parsed.diagnostics, {
    code: 'copy-preserved-without-remap', severity: 'warning', message: '原生稿结构或格式暂不可安全重映射；原文完整保留为待检查稿，不覆盖现有文档。',
  }]);
  if (parsed.format === 'plain' && parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return result(source);
  if (!options.idFactory) throw new StoryOperationError('missing-id-factory', '导入新副本需要稳定 ID 分配器。');
  const allocated = new Set<string>();
  const oldIds = new Set<string>();
  if (parsed.metadata) {
    oldIds.add(parsed.metadata.document.id);
    for (const name of collections) for (const item of parsed.metadata[name]) oldIds.add(item.id);
    for (const block of parsed.blocks) oldIds.add(block.id);
    for (const asset of parsed.metadata.assets) oldIds.add(asset.id);
  }
  const assign = (kind: string, previous: string) => {
    const id = kind === 'asset' && options.assetIdFactory ? options.assetIdFactory(previous) : options.idFactory!(kind, previous);
    if (!StoryIdSchema.safeParse(id).success || allocated.has(id) || oldIds.has(id)) throw new StoryOperationError('invalid-import-id', '导入 ID 必须合法且不与原稿或本次分配的身份冲突。');
    allocated.add(id);
    if (previous) idMap[previous] = id;
    return id;
  };
  if (parsed.format === 'plain') {
    const documentId = assign('document', '');
    return result(createStoryMarkdown({ documentId, title: options.title ?? '导入剧本', kind: options.kind ?? 'short', body: source }));
  }
  const metadata = parsed.metadata!;
  assign('document', metadata.document.id);
  for (const name of collections) for (const item of metadata[name]) assign(name, item.id);
  for (const block of parsed.blocks) assign('block', block.id);
  if (options.assetIdFactory) for (const id of new Set(metadata.assets.map((asset) => asset.id))) assign('asset', id);
  const remapReference = (value: unknown): unknown => {
    if (typeof value === 'string') return idMap[value] ?? value;
    if (Array.isArray(value)) return value.map(remapReference);
    return value;
  };
  const remapRecord = (value: Record<string, unknown>, declaration = false): Record<string, unknown> => {
    const next = { ...value };
    for (const [key, member] of Object.entries(value)) {
      if ((key === 'id' && declaration) || references.has(key)) next[key] = remapReference(member);
      else if (['target', 'scope', 'evidence', 'state'].includes(key) && isJsonObject(member)) next[key] = remapRecord(member, key === 'target');
    }
    return next;
  };
  const scan = scanStoryTokens(source);
  const token = scan.tokens.find((item) => item.kind === 'metadata')!;
  const original = token.node!.value as Record<string, unknown>;
  const document = remapRecord(original.document as Record<string, unknown>, true);
  if (options.title !== undefined) document.title = options.title;
  if (options.kind !== undefined) document.kind = options.kind;
  if (!Object.hasOwn(document, 'origin')) document.origin = { kind: 'import-copy', documentId: metadata.document.id };
  const next: Record<string, unknown> = { ...original, document };
  for (const name of collections) if (Array.isArray(original[name])) next[name] = (original[name] as Array<Record<string, unknown>>).map((item) => remapRecord(item, true));
  if (Array.isArray(original.deletedObjects)) next.deletedObjects = (original.deletedObjects as Array<Record<string, unknown>>).map((item) => ({ ...remapRecord(item, true), record: remapRecord(item.record as Record<string, unknown>, true) }));
  if (options.assetIdFactory && Array.isArray(original.assets)) next.assets = (original.assets as Array<Record<string, unknown>>).map((asset) => {
    const remapped = remapRecord(asset, true);
    const provenance = asset.provenance;
    if (provenance === undefined || isJsonObject(provenance)) remapped.provenance = { ...provenance,
      ...(!isJsonObject(provenance) || !Object.hasOwn(provenance, 'originAssetId') ? { originAssetId: asset.id } : {}),
      ...(!isJsonObject(provenance) || !Object.hasOwn(provenance, 'originAssetVersionId') ? { originAssetVersionId: asset.versionId } : {}),
    };
    else if (!Object.hasOwn(remapped, 'originAssetId')) remapped.originAssetId = asset.id;
    return remapped;
  });
  for (const name of ['sceneOrder', 'shotOrder']) if (Object.hasOwn(original, name)) next[name] = remapReference(original[name]);
  const edits: TextEdit[] = editJsonValue(token.node!, next);
  for (const marker of scan.tokens.filter((item) => item.kind !== 'metadata')) {
    if (!marker.node || !isJsonObject(marker.node.value)) continue;
    edits.push(...editJsonValue(marker.node, { ...marker.node.value, id: idMap[marker.node.value.id as string] }));
  }
  const markdown = applyTextEdits(source, edits);
  const after = parseStoryMarkdown(markdown);
  if (!after.semanticEditable) throw new StoryOperationError('invalid-import-result', 'ID 重映射后出现断裂关联，未产生可提交的副本。', after.diagnostics);
  const diagnostics: StoryDiagnostic[] = [...after.diagnostics];
  if (metadata.assets.length) diagnostics.push({ code: 'external-assets-require-resolution', severity: 'warning', message: 'Markdown 保留素材身份和所选版本；没有携带素材字节，目标项目须解析或入库后才能读取。' });
  return result(markdown, diagnostics);
}

export interface StoryResolvedReferences {
  purpose: string;
  source: 'document' | 'scene' | 'disabled';
  inherited: boolean;
  bindings: StoryBinding[];
}

/** A scene overrides only the same purpose; scene costume never evicts document appearance. */
export function resolveStoryReferences(metadata: StoryMetadata, options: {
  target: StoryBinding['target']; sceneId?: string; purpose?: string;
}): StoryResolvedReferences[] {
  const matches = (target: StoryBinding['target']) => target.id === options.target.id && target.kind === options.target.kind;
  const bindings = metadata.bindings.filter((binding) => matches(binding.target));
  const overrides = metadata.referenceOverrides.filter((override) => matches(override.target) && override.scope.sceneId === options.sceneId);
  const purposes = options.purpose ? [options.purpose] : [...new Set([...bindings.map((binding) => binding.purpose), ...overrides.map((override) => override.purpose)])];
  return purposes.map((purpose) => {
    const override = overrides.find((item) => item.purpose === purpose);
    if (override?.mode === 'disabled') return { purpose, source: 'disabled' as const, inherited: false, bindings: [] };
    const scene = bindings.filter((binding) => binding.purpose === purpose && binding.scope.kind === 'scene' && binding.scope.sceneId === options.sceneId);
    if (scene.length || override?.mode === 'replace') return { purpose, source: 'scene' as const, inherited: false, bindings: scene };
    return { purpose, source: 'document' as const, inherited: !!options.sceneId, bindings: bindings.filter((binding) => binding.purpose === purpose && binding.scope.kind === 'document') };
  });
}
