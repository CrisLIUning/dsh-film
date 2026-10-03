import { describe, expect, it } from 'vitest';
import { applyStoryOperations, createStoryMarkdown, parseStoryMarkdown, type StoryDocument, type StoryQueryRequest, type StorySearchHit } from '../../src/screenwriter/contracts/index.js';
import { queryStoryDocument } from '../../src/screenwriter/query.js';

function fixture(): StoryDocument {
  const initial = createStoryMarkdown({ documentId: 'doc-1', title: '钟楼', kind: 'short', body: '未经处理的作者备注。\n' });
  const content = applyStoryOperations(initial, [
    { kind: 'upsertScene', scene: { id: 'scene-1', headingBlockId: 'heading-1', blockIds: ['heading-1', 'action-1'] }, blocks: [{ id: 'heading-1', kind: 'scene-heading', markdown: '## 第十天\n' }, { id: 'action-1', kind: 'action', markdown: '甲说：“我从没去过钟楼。”\n' }] },
    { kind: 'upsertScene', scene: { id: 'scene-2', headingBlockId: 'heading-2', blockIds: ['heading-2', 'action-2'] }, blocks: [{ id: 'heading-2', kind: 'scene-heading', markdown: '## 第三天（闪回）\n' }, { id: 'action-2', kind: 'action', markdown: '甲独自在钟楼藏信。乙说不知道信在哪里。\n' }] },
  ]).markdown;
  return { documentId: 'doc-1', title: '钟楼', kind: 'short', filePath: 'screenwriter/doc-1.md', revision: 'r-1', updatedAt: '2026-09-07T00:00:00Z', versionId: 'v-1', content, parsed: parseStoryMarkdown(content) };
}

describe('saved screenplay queries', () => {
  it('reports partial source coverage without implying the whole script was read', () => {
    const doc = fixture();
    const answer = queryStoryDocument(doc, { kind: 'content', ids: ['scene-2'] });
    expect(answer.revision).toBe('r-1');
    expect(answer.coverage.fullDocument).toBe(false);
    expect(answer.coverage.blockIds).toEqual(['heading-2', 'action-2']);
    expect(answer.items?.some(item => 'markdown' in item && String(item.markdown).includes('甲说'))).toBe(false);
    expect(answer.items?.find(item => item.id === 'action-2')).toMatchObject({ markdown: '\n甲独自在钟楼藏信。乙说不知道信在哪里。\n' });
  });

  it('keeps original quotes and UTF-16 search offsets, including speech acts', () => {
    const doc = fixture();
    const answer = queryStoryDocument(doc, { kind: 'search', query: '说不知道', ids: ['scene-2'] });
    expect(answer.items).toHaveLength(1);
    const hit = answer.items![0]!;
    expect(hit).toMatchObject({ text: '说不知道', blockId: 'action-2' });
    const range = (hit as StorySearchHit).range;
    expect(doc.content.slice(range.start, range.end)).toBe('说不知道');
    expect(answer.coverage.fullDocument).toBe(false);
  });

  it('returns an honest paginated full-document window and keeps unknown author text', () => {
    const doc = fixture();
    const answer = queryStoryDocument(doc, { kind: 'content', limit: 80 });
    expect(answer.content).toBe(doc.content.slice(0, 80));
    expect(answer.coverage).toMatchObject({ unit: 'characters', total: doc.content.length, returned: 80, truncated: true, complete: false, fullDocument: false });
    const full = queryStoryDocument(doc, { kind: 'content', limit: 48_000 });
    expect(full.content).toContain('未经处理的作者备注。');
    expect(full.coverage.fullDocument).toBe(true);
  });

  it('reports missing targets and never treats an index as read prose', () => {
    const doc = fixture();
    const answer = queryStoryDocument(doc, { kind: 'content', ids: ['deleted-scene'] });
    expect(answer.coverage).toMatchObject({ missingIds: ['deleted-scene'], complete: false, fullDocument: false });
    expect(answer.items).toEqual([]);
    const index = queryStoryDocument(doc, { kind: 'index', limit: 1 });
    expect(index.coverage).toMatchObject({ returned: 1, truncated: true, fullDocument: false, blockIds: [] });
  });

  it('rejects unknown queries and malformed limits instead of silently widening the read', () => {
    const doc = fixture();
    for (const query of [{ kind: 'everything' }, { kind: 'content', offset: -1 }, { kind: 'content', limit: 0 }, { kind: 'search' }, { kind: 'content', ids: 'scene-1' }]) {
      expect(() => queryStoryDocument(doc, query as StoryQueryRequest)).toThrow();
    }
  });
});
