import type {
  StoryBlock, StoryDocument, StoryIndexEntry, StoryQueryRequest, StoryQueryResponse, StorySearchHit,
} from './contracts/index.js';

const QUERY_KINDS = new Set(['index', 'content', 'entities', 'scenes', 'shots', 'bindings', 'search']);

/** Query one already-authorized saved document; it never reads other projects or the filesystem. */
export function queryStoryDocument(document: StoryDocument, request: StoryQueryRequest): StoryQueryResponse {
  if (!request || typeof request !== 'object' || !QUERY_KINDS.has(request.kind)) throw new Error('Unknown story query kind.');
  if (request.ids !== undefined && (!Array.isArray(request.ids) || request.ids.some(id => typeof id !== 'string' || !id))) throw new Error('ids must be nonempty stable-id strings.');
  const offset = integer(request.offset, 0, 'offset');
  const fullContent = request.kind === 'content' && !request.ids?.length;
  const limit = integer(request.limit, fullContent ? 12_000 : 50, 'limit');
  if (limit < 1) throw new Error('limit must be positive.');
  const boundedLimit = Math.min(limit, fullContent ? 48_000 : 200);
  const metadata = document.parsed.metadata;
  const requestedIds = [...new Set(request.ids ?? [])];
  const knownIds = new Set([
    ...document.parsed.blocks.map(block => block.id),
    ...(metadata?.entities ?? []).map(item => item.id),
    ...(metadata?.scenes ?? []).map(item => item.id),
    ...(metadata?.shots ?? []).map(item => item.id),
    ...(metadata?.bindings ?? []).map(item => item.id),
  ]);
  const missingIds = requestedIds.filter(id => !knownIds.has(id));
  const blockIds = new Set<string>();
  for (const id of requestedIds) {
    if (document.parsed.blocks.some(block => block.id === id)) blockIds.add(id);
    const entity = metadata?.entities.find(item => item.id === id);
    if (entity) blockIds.add(entity.profileBlockId);
    const scene = metadata?.scenes.find(item => item.id === id);
    if (scene) { blockIds.add(scene.headingBlockId); scene.blockIds.forEach(blockId => blockIds.add(blockId)); }
    const shot = metadata?.shots.find(item => item.id === id);
    if (shot) { blockIds.add(shot.descriptionBlockId); shot.sourceBlockIds.forEach(blockId => blockIds.add(blockId)); }
  }
  const select = <T extends { id: string }>(items: T[]) => requestedIds.length ? items.filter(item => requestedIds.includes(item.id)) : items;
  const title = (id: string) => document.parsed.blocks.find(block => block.id === id)?.markdown.replace(/^\s*#{1,6}\s+/u, '').split('\n')[0]?.trim() ?? '';
  const base = { documentId: document.documentId, revision: document.revision, kind: request.kind };
  if (fullContent) {
    const content = document.content.slice(offset, offset + boundedLimit);
    const returnedBlockIds = document.parsed.blocks.filter(block => block.range.start >= offset && block.range.end <= offset + content.length).map(block => block.id);
    const complete = offset === 0 && content.length === document.content.length;
    return { ...base, content, coverage: { unit: 'characters', total: document.content.length, offset, returned: content.length, complete, truncated: offset + content.length < document.content.length, blockIds: returnedBlockIds, requestedIds, missingIds, fullDocument: complete } };
  }
  let items: NonNullable<StoryQueryResponse['items']>;
  switch (request.kind) {
    case 'content': items = document.parsed.blocks.filter(block => blockIds.has(block.id)); break;
    case 'entities': items = select(metadata?.entities ?? []); break;
    case 'scenes': items = select(metadata?.scenes ?? []); break;
    case 'shots': items = select(metadata?.shots ?? []); break;
    case 'bindings': items = select(metadata?.bindings ?? []); break;
    case 'search': {
      if (typeof request.query !== 'string' || !request.query.length) throw new Error('search requires nonempty literal query text.');
      const regions = requestedIds.length ? document.parsed.blocks.filter(block => blockIds.has(block.id)).map(block => ({ content: block.markdown, start: block.contentRange.start, blockId: block.id })) : [{ content: document.content, start: 0, blockId: undefined }];
      const hits: StorySearchHit[] = [];
      for (const region of regions) {
        let at = region.content.indexOf(request.query);
        while (at >= 0) {
          const start = region.start + at;
          const end = start + request.query.length;
          const blockId = region.blockId ?? document.parsed.blocks.find(block => block.contentRange.start <= start && block.contentRange.end >= end)?.id;
          hits.push({ id: `match-${start}`, kind: 'search-hit', text: request.query, range: { start, end }, ...(blockId ? { blockId } : {}) });
          at = region.content.indexOf(request.query, at + Math.max(1, request.query.length));
        }
      }
      items = hits;
      break;
    }
    case 'index': {
      const index: StoryIndexEntry[] = [
        ...(metadata?.scenes ?? []).map(scene => ({ id: scene.id, kind: 'scene', title: title(scene.headingBlockId), archived: scene.archived === true, blockIds: [...new Set([scene.headingBlockId, ...scene.blockIds])] })),
        ...(metadata?.entities ?? []).map(entity => ({ id: entity.id, kind: entity.kind, title: title(entity.profileBlockId), archived: entity.archived === true, blockIds: [entity.profileBlockId] })),
        ...(metadata?.shots ?? []).map(shot => ({ id: shot.id, kind: 'shot', title: title(shot.descriptionBlockId), archived: shot.archived === true, blockIds: [shot.descriptionBlockId, ...shot.sourceBlockIds] })),
        ...(!metadata ? document.parsed.blocks.map(block => ({ id: block.id, kind: block.kind, title: title(block.id), blockIds: [block.id] })) : []),
      ];
      items = select(index);
      break;
    }
    default: throw new Error('Unknown story query kind.');
  }
  const page = items.slice(offset, offset + boundedLimit);
  const readBlockIds = request.kind === 'content' ? (page as StoryBlock[]).map(block => block.id) : request.kind === 'search' ? (page as StorySearchHit[]).flatMap(hit => hit.blockId ? [hit.blockId] : []) : [];
  return { ...base, items: page, coverage: { unit: 'items', total: items.length, offset, returned: page.length, complete: offset === 0 && page.length === items.length && missingIds.length === 0, truncated: offset + page.length < items.length, blockIds: [...new Set(readBlockIds)], requestedIds, missingIds, fullDocument: false } };
}

function integer(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer.`);
  return value;
}
