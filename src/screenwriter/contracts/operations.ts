import { z } from 'zod';
import { applyTextEdits, editJsonValue, isJsonObject, storyJson, type TextEdit } from './json-cst.js';
import { parseStoryMarkdown, scanStoryTokens, storyBlockTitle, StoryAssetSchema, StoryBindingSchema, StoryEntitySchema, StoryIdSchema, StoryObjectTargetSchema, StorySceneSchema, StoryShotSchema } from './parser.js';
import { STORY_FORMAT, STORY_FORMAT_VERSION, type StoryBlock, type StoryCollection, type StoryDeletedObject, type StoryDocumentKind, type StoryMetadata, type StoryNewBlock, type StoryObjectTarget, type StoryOperation, type StoryOperationResult, type StoryRecord } from './types.js';
import { StoryOperationError } from './errors.js';
import { inspectStoryObjectDeletion, STORY_OBJECT_COLLECTIONS, storyObjectBlockIds } from './lifecycle.js';
export { StoryOperationError } from './errors.js';

const newBlock = z.object({ id: StoryIdSchema, kind: z.string().min(1), markdown: z.string() });
const collection = z.enum(['entities', 'scenes', 'shots', 'assets', 'bindings', 'speech', 'appearances', 'beats', 'relationships', 'claims', 'referenceOverrides']);
export const StoryOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('replaceBlock'), blockId: StoryIdSchema, markdown: z.string(), expectedMarkdown: z.string().optional() }),
  z.object({ kind: z.literal('appendBlock'), block: newBlock, afterBlockId: StoryIdSchema.optional() }),
  z.object({ kind: z.literal('upsertEntity'), entity: StoryEntitySchema, profileMarkdown: z.string().optional() }),
  z.object({ kind: z.literal('upsertScene'), scene: StorySceneSchema, blocks: z.array(newBlock).optional(), beforeSceneId: StoryIdSchema.optional() }),
  z.object({ kind: z.literal('upsertShot'), shot: StoryShotSchema, descriptionMarkdown: z.string().optional() }),
  z.object({ kind: z.literal('upsertAsset'), asset: StoryAssetSchema }),
  z.object({ kind: z.literal('upsertBinding'), binding: StoryBindingSchema }),
  z.object({ kind: z.literal('upsertRecord'), collection, record: z.object({ id: StoryIdSchema }).passthrough() }),
  z.object({ kind: z.literal('removeRecord'), collection, id: StoryIdSchema }),
  z.object({ kind: z.literal('setObjectArchived'), target: StoryObjectTargetSchema, archived: z.boolean() }),
  z.object({ kind: z.literal('deleteObject'), target: StoryObjectTargetSchema }),
  z.object({ kind: z.literal('restoreObject'), target: StoryObjectTargetSchema }),
  z.object({ kind: z.literal('renameEntity'), entityId: StoryIdSchema, name: z.string().refine((name) => !/[\r\n]/.test(name), 'A display name cannot contain a newline.') }),
  z.object({ kind: z.literal('setSpeechSpeaker'), speechId: StoryIdSchema, speakerId: StoryIdSchema }),
  z.object({ kind: z.literal('reorderScenes'), sceneIds: z.array(StoryIdSchema) }),
  z.object({ kind: z.literal('reorderShots'), shotIds: z.array(StoryIdSchema) }),
  z.object({ kind: z.literal('updateDocument'), changes: z.record(z.unknown()).refine((changes) => !Object.hasOwn(changes, 'id'), 'Document identity is immutable.') }),
]);

function usable(source: string) {
  const parsed = parseStoryMarkdown(source);
  if (!parsed.metadata || parsed.format !== 'native') throw new StoryOperationError('story-not-editable', '原稿结构暂不可安全修改，请先查看诊断。', parsed.diagnostics);
  return { ...parsed, metadata: parsed.metadata };
}

function requiredBlock(source: string, id: string): StoryBlock {
  const matches = parseStoryMarkdown(source).blocks.filter((block) => block.id === id);
  if (matches.length !== 1) throw new StoryOperationError('ambiguous-block', `正文块 ${id} 缺失或重复；未猜测修改位置。`);
  return matches[0]!;
}

function patchMetadata(source: string, patch: Partial<StoryMetadata>): string {
  const token = scanStoryTokens(source).tokens.find((item) => item.kind === 'metadata');
  if (!token?.node || !isJsonObject(token.node.value)) throw new StoryOperationError('invalid-metadata', '元数据不可修改。');
  return applyTextEdits(source, editJsonValue(token.node, { ...token.node.value, ...patch }));
}

function records(source: string, name: StoryCollection): StoryRecord[] {
  return usable(source).metadata[name];
}

function upsert(source: string, name: StoryCollection, record: StoryRecord): string {
  if (usable(source).metadata.deletedObjects.some((item) => item.id === record.id)) throw new StoryOperationError('reserved-deleted-id', '该身份属于已删除对象；请使用恢复操作，不要由旧缓存重新创建。');
  const current = records(source, name);
  // Distinct versions of an asset share an asset identity, never an array-record identity.
  const index = current.findIndex((item) => item.id === record.id && (name !== 'assets' || item.versionId === record.versionId));
  const next = [...current];
  if (index === -1) next.push(record);
  else next[index] = { ...current[index], ...record };
  return patchMetadata(source, { [name]: next });
}

function eol(source: string): string { return source.includes('\r\n') ? '\r\n' : '\n'; }

export function serializeStoryBlock(block: StoryNewBlock, lineEnding = '\n'): string {
  const checked = newBlock.safeParse(block);
  if (!checked.success) throw new StoryOperationError('invalid-block', '正文块身份、类型或正文无效。');
  const start = `<!-- sw:block ${storyJson({ id: block.id, kind: block.kind })} -->`;
  const end = `<!-- /sw:block ${storyJson({ id: block.id })} -->`;
  const body = `${/^[\r\n]/.test(block.markdown) ? '' : lineEnding}${block.markdown}${/[\r\n]$/.test(block.markdown) ? '' : lineEnding}`;
  return `${start}${body}${end}`;
}

function insertBlock(source: string, block: StoryNewBlock, afterBlockId?: string, beforeBlockId?: string): string {
  if (parseStoryMarkdown(source).blocks.some((item) => item.id === block.id)) throw new StoryOperationError('duplicate-id', `正文块 ${block.id} 已存在。`);
  const newline = eol(source);
  const rendered = serializeStoryBlock(block, newline);
  if (afterBlockId) {
    const position = requiredBlock(source, afterBlockId).range.end;
    return applyTextEdits(source, [{ start: position, end: position, text: `${newline}${newline}${rendered}` }]);
  }
  if (beforeBlockId) {
    const position = requiredBlock(source, beforeBlockId).range.start;
    return applyTextEdits(source, [{ start: position, end: position, text: `${rendered}${newline}${newline}` }]);
  }
  return `${source}${source.endsWith(newline + newline) ? '' : source.endsWith(newline) ? newline : newline + newline}${rendered}${newline}`;
}

function replace(source: string, id: string, markdown: string, expected?: string): string {
  const block = requiredBlock(source, id);
  if (expected !== undefined && block.markdown !== expected) throw new StoryOperationError('block-conflict', `正文块 ${id} 已改变，保留当前内容。`);
  // Preserve caller text exactly, adding only marker boundary newlines when necessary.
  const newline = eol(source);
  const text = `${/^[\r\n]/.test(markdown) ? '' : newline}${markdown}${/[\r\n]$/.test(markdown) ? '' : newline}`;
  return applyTextEdits(source, [{ ...block.contentRange, text }]);
}

function writeBlock(source: string, id: string, kind: string, markdown: string | undefined): string {
  const exists = parseStoryMarkdown(source).blocks.some((item) => item.id === id);
  if (exists) return markdown === undefined ? source : replace(source, id, markdown);
  if (markdown === undefined) throw new StoryOperationError('missing-block-content', `创建 ${id} 需要提供正文；未自动编造资料。`);
  return insertBlock(source, { id, kind, markdown });
}

function escapeLabel(name: string): string { return name.replace(/[\\`*_{}[\]<>]/g, '\\$&'); }

function renameHeading(source: string, id: string, name: string): string {
  const block = requiredBlock(source, id);
  const match = /^( {0,3}#{1,6})(?:[\t ]+([^\r\n]*))?\r?$/m.exec(block.markdown);
  if (!match || match.index === undefined) throw new StoryOperationError('missing-profile-heading', '档案缺少明确标题，未猜测姓名位置。');
  const line = `${match[1]} ${escapeLabel(name)}`;
  return applyTextEdits(source, [{ start: block.contentRange.start + match.index, end: block.contentRange.start + match.index + match[0].replace(/\r$/, '').length, text: line }]);
}

function renameSpeaker(source: string, id: string, name: string): string {
  const block = requiredBlock(source, id);
  const match = /^([\t \r\n]*)(\*\*|__)([^\r\n]*?)\2[\t ]*(?=\r?\n|$)/.exec(block.markdown);
  if (!match || match.index === undefined) throw new StoryOperationError('missing-speaker-label', '对白块缺少独立署名行，未猜测替换正文。');
  const start = block.contentRange.start + match.index + match[1]!.length;
  return applyTextEdits(source, [{ start, end: block.contentRange.start + match.index + match[0].length, text: `**${escapeLabel(name)}**` }]);
}

function reorder(source: string, requested: string[], kind: 'scenes' | 'shots'): string {
  const parsed = usable(source);
  const metadata = parsed.metadata;
  const declared = metadata[kind].map((item) => item.id);
  if (new Set(requested).size !== requested.length || requested.length !== declared.length || requested.some((id) => !declared.includes(id))) {
    throw new StoryOperationError('invalid-order', '重排必须恰好包含每个现有 ID 一次。');
  }
  const groups = declared.map((id) => {
    const blockIds = kind === 'scenes' ? metadata.scenes.find((item) => item.id === id)!.blockIds : [metadata.shots.find((item) => item.id === id)!.descriptionBlockId];
    const groupBlocks = blockIds.map((blockId) => requiredBlock(source, blockId));
    if (!groupBlocks.length) throw new StoryOperationError('empty-scene', '没有确定正文范围的场次不能重排。');
    const start = groupBlocks[0]!.range.start;
    const end = groupBlocks.at(-1)!.range.end;
    if (groupBlocks.some((block, index) => index && block.range.start <= groupBlocks[index - 1]!.range.end)) throw new StoryOperationError('invalid-order', '场次块顺序不一致。');
    if (parsed.blocks.some((block) => block.range.start >= start && block.range.end <= end && !blockIds.includes(block.id))) throw new StoryOperationError('ambiguous-scene-range', '场次范围包含未归属该场的管理块；未猜测搬移范围。');
    return { id, start, end, text: source.slice(start, end) };
  }).sort((a, b) => a.start - b.start);
  const byId = new Map(groups.map((group) => [group.id, group]));
  const edits: TextEdit[] = groups.map((group, index) => ({ start: group.start, end: group.end, text: byId.get(requested[index]!)!.text }));
  const moved = applyTextEdits(source, edits);
  return patchMetadata(moved, kind === 'scenes' ? { sceneOrder: requested } : { shotOrder: requested });
}

function deleteObject(source: string, target: StoryObjectTarget): string {
  const preview = inspectStoryObjectDeletion(source, target);
  if (!preview.canDelete) throw new StoryOperationError('object-has-dependencies', '该对象仍被引用。请先归档，或明确替换/解除以下关联后再删除；正文和素材不会被自动删除，整批未写入。', preview.dependencies.filter((item) => item.blocksDeletion).map((item) => ({ code: 'object-dependency', severity: 'error', objectId: item.id, path: `${item.collection}.${item.path}`, message: `${item.collection} / ${item.id} 的 ${item.path} 仍引用 ${target.id}。` })));
  const metadata = usable(source).metadata;
  const collection = STORY_OBJECT_COLLECTIONS[target.kind];
  const record = metadata[collection].find((item) => item.id === target.id)!;
  const order = target.kind === 'scene' ? metadata.sceneOrder : target.kind === 'shot' ? metadata.shotOrder : metadata.entities.map((item) => item.id);
  const index = order.indexOf(target.id);
  const deleted: StoryDeletedObject = { id: target.id, kind: target.kind, record: structuredClone(record), title: preview.title,
    ...(index > 0 ? { orderBeforeId: order[index - 1]! } : {}), ...(index < order.length - 1 ? { orderAfterId: order[index + 1]! } : {}),
  };
  return patchMetadata(source, {
    [collection]: metadata[collection].filter((item) => item.id !== target.id),
    deletedObjects: [...metadata.deletedObjects, deleted],
    ...(target.kind === 'scene' ? { sceneOrder: metadata.sceneOrder.filter((id) => id !== target.id) } : {}),
    ...(target.kind === 'shot' ? { shotOrder: metadata.shotOrder.filter((id) => id !== target.id) } : {}),
  });
}

function restoreObject(source: string, target: StoryObjectTarget): string {
  const parsed = usable(source);
  const metadata = parsed.metadata;
  const deleted = metadata.deletedObjects.find((item) => item.id === target.id && item.kind === target.kind);
  if (!deleted) throw new StoryOperationError('missing-deleted-object', '回收站中没有该身份的可恢复对象。');
  const collection = STORY_OBJECT_COLLECTIONS[target.kind];
  const record = structuredClone(deleted.record);
  const blocks = storyObjectBlockIds(record, target.kind);
  const missing = blocks.filter((id) => !parsed.blocks.some((block) => block.id === id));
  if (missing.length) throw new StoryOperationError('restore-body-missing', '对象原有正文块已被后续修改移除；未覆盖现稿或凭空重建正文。', missing.map((id) => ({ code: 'restore-body-missing', severity: 'error', objectId: id, message: `恢复所需正文块 ${id} 不存在。` })));
  const records = [...metadata[collection]];
  const before = records.findIndex((item) => item.id === deleted.orderAfterId);
  const after = records.findIndex((item) => item.id === deleted.orderBeforeId);
  records.splice(before >= 0 ? before : after >= 0 ? after + 1 : records.length, 0, record as never);
  const patch: Partial<StoryMetadata> = { [collection]: records, deletedObjects: metadata.deletedObjects.filter((item) => item !== deleted) };
  if (target.kind === 'scene') {
    // The body stayed in place and may have been reordered or edited since
    // deletion. Rejoin its current physical position without moving any text.
    const positions = new Map(parsed.blocks.map((block) => [block.id, block.range.start]));
    patch.sceneOrder = records.slice().sort((a, b) => positions.get(a.headingBlockId as string)! - positions.get(b.headingBlockId as string)!).map((item) => item.id);
  }
  if (target.kind === 'shot') {
    const order = [...metadata.shotOrder];
    const next = deleted.orderAfterId ? order.indexOf(deleted.orderAfterId) : -1;
    const previous = deleted.orderBeforeId ? order.indexOf(deleted.orderBeforeId) : -1;
    order.splice(next >= 0 ? next : previous >= 0 ? previous + 1 : order.length, 0, target.id);
    patch.shotOrder = order;
  }
  return patchMetadata(source, patch);
}

function applyOne(source: string, operation: StoryOperation): string {
  switch (operation.kind) {
    case 'setObjectArchived': {
      const metadata = usable(source).metadata;
      const collection = STORY_OBJECT_COLLECTIONS[operation.target.kind];
      const record = metadata[collection].find((item) => item.id === operation.target.id);
      if (!record) throw new StoryOperationError('missing-object', '要归档或取消归档的对象不存在。');
      if ((record.archived === true) === operation.archived) return source;
      return upsert(source, collection, { ...record, archived: operation.archived });
    }
    case 'deleteObject': return deleteObject(source, operation.target);
    case 'restoreObject': return restoreObject(source, operation.target);
    case 'replaceBlock': return replace(source, operation.blockId, operation.markdown, operation.expectedMarkdown);
    case 'appendBlock': return insertBlock(source, operation.block, operation.afterBlockId);
    case 'upsertEntity': return upsert(writeBlock(source, operation.entity.profileBlockId, 'entity-profile', operation.profileMarkdown), 'entities', operation.entity);
    case 'upsertAsset': return upsert(source, 'assets', operation.asset);
    case 'upsertBinding': {
      let result = source;
      if (operation.binding.primary) {
        const binding = operation.binding;
        const current = usable(source).metadata.bindings;
        const bindings = current.map((item) => item.id !== binding.id && item.target.kind === binding.target.kind && item.target.id === binding.target.id && item.scope.kind === binding.scope.kind &&
          (item.scope.kind !== 'scene' || (binding.scope.kind === 'scene' && item.scope.sceneId === binding.scope.sceneId)) && item.purpose === binding.purpose ? { ...item, primary: false } : item);
        result = patchMetadata(result, { bindings });
      }
      return upsert(result, 'bindings', operation.binding);
    }
    case 'upsertRecord': return upsert(source, operation.collection, operation.record);
    case 'upsertShot': {
      const exists = usable(source).metadata.shots.some((shot) => shot.id === operation.shot.id);
      let result = writeBlock(source, operation.shot.descriptionBlockId, 'shot-plan', operation.descriptionMarkdown);
      result = upsert(result, 'shots', operation.shot);
      return exists ? result : patchMetadata(result, { shotOrder: [...usable(result).metadata.shotOrder, operation.shot.id] });
    }
    case 'upsertScene': {
      const original = usable(source).metadata;
      const exists = original.scenes.some((scene) => scene.id === operation.scene.id);
      let result = source;
      const before = operation.beforeSceneId ? original.scenes.find((scene) => scene.id === operation.beforeSceneId) : undefined;
      if (operation.beforeSceneId && !before) throw new StoryOperationError('missing-scene', '插入位置对应的场次不存在。');
      let previousBlock: string | undefined;
      for (const block of operation.blocks ?? []) {
        if (parseStoryMarkdown(result).blocks.some((item) => item.id === block.id)) result = replace(result, block.id, block.markdown);
        else result = insertBlock(result, block, previousBlock, previousBlock ? undefined : before?.headingBlockId);
        previousBlock = block.id;
      }
      result = upsert(result, 'scenes', operation.scene);
      if (!exists) {
        const order = [...original.sceneOrder];
        const position = operation.beforeSceneId ? order.indexOf(operation.beforeSceneId) : order.length;
        order.splice(position, 0, operation.scene.id);
        result = patchMetadata(result, { sceneOrder: order });
      }
      return result;
    }
    case 'removeRecord': {
      if (operation.collection === 'entities' || operation.collection === 'scenes' || operation.collection === 'shots') return deleteObject(source, { kind: operation.collection === 'entities' ? 'entity' : operation.collection === 'scenes' ? 'scene' : 'shot', id: operation.id });
      const current = records(source, operation.collection);
      if (!current.some((item) => item.id === operation.id)) throw new StoryOperationError('missing-object', '要移除的对象不存在。');
      return patchMetadata(source, { [operation.collection]: current.filter((item) => item.id !== operation.id) });
    }
    case 'renameEntity': {
      const parsed = usable(source);
      const entity = parsed.metadata.entities.find((item) => item.id === operation.entityId);
      if (!entity) throw new StoryOperationError('missing-entity', '人物、地点或道具不存在。');
      let result = renameHeading(source, entity.profileBlockId, operation.name);
      for (const speech of parsed.metadata.speech.filter((item) => item.speakerId === entity.id)) result = renameSpeaker(result, speech.blockId, operation.name);
      return result;
    }
    case 'setSpeechSpeaker': {
      const parsed = usable(source);
      const speech = parsed.metadata.speech.find((item) => item.id === operation.speechId);
      const entity = parsed.metadata.entities.find((item) => item.id === operation.speakerId && item.kind === 'person');
      if (!speech || !entity) throw new StoryOperationError('missing-speech-or-person', '署名关系或目标人物不存在。');
      const name = storyBlockTitle(parsed.blocks.find((block) => block.id === entity.profileBlockId));
      return upsert(renameSpeaker(source, speech.blockId, name), 'speech', { ...speech, speakerId: entity.id });
    }
    case 'reorderScenes': return reorder(source, operation.sceneIds, 'scenes');
    case 'reorderShots': return reorder(source, operation.shotIds, 'shots');
    case 'updateDocument': return patchMetadata(source, { document: { ...usable(source).metadata.document, ...operation.changes } });
  }
}

/** Batch is atomic: an invalid final result throws; callers never persist intermediate strings. */
export function applyStoryOperations(source: string, operations: readonly StoryOperation[]): StoryOperationResult {
  const initial = parseStoryMarkdown(source);
  if (!initial.semanticEditable) throw new StoryOperationError('story-not-editable', '当前稿件有结构诊断；仍可保存源码，语义修改暂停。', initial.diagnostics);
  let markdown = source;
  const changed = new Set<string>();
  for (const input of operations) {
    const checked = StoryOperationSchema.safeParse(input);
    if (!checked.success) throw new StoryOperationError('invalid-operation', checked.error.issues.map((issue) => issue.message).join('; '));
    const operation = checked.data as StoryOperation;
    const next = applyOne(markdown, operation);
    if (next !== markdown) {
      for (const value of [
        'blockId' in operation ? operation.blockId : undefined,
        'target' in operation ? operation.target.id : undefined,
        'entityId' in operation ? operation.entityId : undefined,
        'speechId' in operation ? operation.speechId : undefined,
        'id' in operation ? operation.id : undefined,
        'entity' in operation ? operation.entity.id : undefined,
        'scene' in operation ? operation.scene.id : undefined,
        'shot' in operation ? operation.shot.id : undefined,
        'binding' in operation ? operation.binding.id : undefined,
        'asset' in operation ? operation.asset.id : undefined,
        'record' in operation ? operation.record.id : undefined,
        'block' in operation ? operation.block.id : undefined,
      ]) if (value) changed.add(value);
      if (operation.kind === 'reorderScenes') operation.sceneIds.forEach((id) => changed.add(id));
      if (operation.kind === 'reorderShots') operation.shotIds.forEach((id) => changed.add(id));
      if (operation.kind === 'updateDocument') changed.add(initial.metadata!.document.id);
    }
    markdown = next;
  }
  const parsed = parseStoryMarkdown(markdown);
  if (!parsed.semanticEditable) throw new StoryOperationError('invalid-result', '修改会留下断裂关联或不完整结构；整批未写入。', parsed.diagnostics);
  // Receipts include every changed/deleted managed block and record, including linked
  // signatures or a previous primary reference demoted by a user action.
  const beforeBlocks = new Map(initial.blocks.map((block) => [block.id, block]));
  const afterBlocks = new Map(parsed.blocks.map((block) => [block.id, block]));
  for (const id of new Set([...beforeBlocks.keys(), ...afterBlocks.keys()])) {
    const before = beforeBlocks.get(id);
    const after = afterBlocks.get(id);
    if (before?.markdown !== after?.markdown || before?.kind !== after?.kind) changed.add(id);
  }
  for (const name of ['entities', 'scenes', 'shots', 'assets', 'bindings', 'speech', 'appearances', 'beats', 'relationships', 'claims', 'referenceOverrides'] as const) {
    const key = (record: StoryRecord) => name === 'assets' ? `${record.id}\0${String(record.versionId)}` : record.id;
    const before = new Map(initial.metadata![name].map((record) => [key(record), record]));
    const after = new Map(parsed.metadata![name].map((record) => [key(record), record]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (storyJson(before.get(id) ?? null) !== storyJson(after.get(id) ?? null)) changed.add((before.get(id) ?? after.get(id))!.id);
    }
  }
  return { markdown, changedIds: markdown === source ? [] : [...changed], diagnostics: parsed.diagnostics };
}

export function createStoryMarkdown(options: { documentId: string; title: string; kind: StoryDocumentKind; body?: string }): string {
  if (!StoryIdSchema.safeParse(options.documentId).success || !['short', 'episode'].includes(options.kind) || typeof options.title !== 'string') throw new StoryOperationError('invalid-document', '文档身份、类型或标题无效。');
  const body = options.body ?? `# ${options.title}\n\n`;
  const bom = body.startsWith('\uFEFF') ? '\uFEFF' : '';
  const newline = eol(body);
  const metadata = { format: STORY_FORMAT, formatVersion: STORY_FORMAT_VERSION, document: { id: options.documentId, kind: options.kind, title: options.title }, sceneOrder: [], shotOrder: [], entities: [], scenes: [], shots: [], bindings: [], assets: [] };
  return `${bom}<!-- vibedev:screenwriter${newline}${storyJson(metadata, 2).replace(/\n/g, newline)}${newline}-->${newline}${newline}${bom ? body.slice(1) : body}`;
}
