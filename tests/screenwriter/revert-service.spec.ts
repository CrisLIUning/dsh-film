import { describe, expect, it } from 'vitest';
import { revertStoryText } from '../../src/screenwriter/revert.js';
import { createStoryMarkdown, serializeStoryBlock } from '../../src/screenwriter/contracts/index.js';

describe('scope-preserving screenplay operation revert', () => {
  const before = '# 短片\n\n第一场。\n\n结尾：门没关。\n\n<!-- 保留 -->\n';
  const after = before.replace('门没关', '门轻轻关上');
  it('undoes the operation and keeps independent later human text', () => {
    expect(revertStoryText(before, after, `${after}\n人工附记。`)).toBe(`${before}\n人工附记。`);
  });
  it('refuses overlap instead of restoring the whole version', () => {
    expect(() => revertStoryText(before, after, after.replace('门轻轻关上', '门被她推开'))).toThrow();
  });
  it('does not redirect an inverse to an unrelated matching fragment', () => {
    expect(() => revertStoryText(before, after, `${before}\n某人读了一句：门轻轻关上。`)).toThrow();
  });
  it('handles multiple changes while retaining independent text between distant ranges', () => {
    const base = '开场A\n1\n2\n3\n4\n中段\n5\n6\n7\n8\n结尾A\n';
    const updated = base.replace('开场A', '开场B').replace('结尾A', '结尾B');
    expect(revertStoryText(base, updated, updated.replace('中段', '人工中段'))).toBe(base.replace('中段', '人工中段'));
  });
  it('never redirects to identical surrounding text in a different stable block', () => {
    const repeated = (middle: string) => `${'相同的前文。'.repeat(40)}\n${middle}\n${'相同的后文。'.repeat(40)}`;
    const body = serializeStoryBlock({ id: 'original', kind: 'action', markdown: repeated('原稿') }) + '\n\n' + serializeStoryBlock({ id: 'unrelated', kind: 'action', markdown: repeated('AI版本') });
    const initial = createStoryMarkdown({ documentId: 'doc_revert', title: '重复', kind: 'short', body });
    const updated = initial.replace('原稿\n', 'AI版本\n');
    const manual = updated.replace('AI版本\n', '人工版本\n');
    expect(() => revertStoryText(initial, updated, manual)).toThrow();
  });
  it('retains later edits to a separate part of the same stable block', () => {
    const body = serializeStoryBlock({ id: 'action', kind: 'action', markdown: '第一句保留。\n\n门没关。\n\n后面的句子。' });
    const initial = createStoryMarkdown({ documentId: 'doc_revert', title: '同块', kind: 'short', body });
    const updated = initial.replace('门没关', '门轻轻关上');
    const manual = updated.replace('第一句保留', '人工重新写的开头');
    expect(revertStoryText(initial, updated, manual)).toBe(initial.replace('第一句保留', '人工重新写的开头'));
  });
});
