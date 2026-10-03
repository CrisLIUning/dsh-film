import { describe, expect, it } from 'vitest';
import { applyStoryOperations, createStoryMarkdown, inspectStoryObjectDeletion, parseStoryMarkdown, prepareStoryImport, projectStoryBody, type StoryObjectTarget, type StoryOperation } from '../../src/screenwriter/contracts/index.js';

const apply = (source: string, ...operations: StoryOperation[]) => applyStoryOperations(source, operations).markdown;
function fixture() {
  return apply(createStoryMarkdown({ documentId: 'doc', title: '生命周期', kind: 'short', body: '# 原文\n<!-- 作者：保留  空格 -->\n没有写完——' }),
    ...(['person', 'place', 'prop'] as const).map((kind): StoryOperation => ({ kind: 'upsertEntity', entity: { id: kind, kind, profileBlockId: `${kind}_body`, status: '作者自定状态', unknown: { text: '保留' } }, profileMarkdown: `### ${kind}` })),
    { kind: 'upsertScene', scene: { id: 'scene', headingBlockId: 'heading', blockIds: ['heading', 'action'], placeId: 'place' }, blocks: [{ id: 'heading', kind: 'scene-heading', markdown: '### 门口' }, { id: 'action', kind: 'action', markdown: '一只手。' }] },
    { kind: 'upsertShot', shot: { id: 'shot', descriptionBlockId: 'shot_body', sceneId: 'scene', sourceBlockIds: ['action'], entityIds: ['person', 'prop'] }, descriptionMarkdown: '### 手\n未知时长。' },
  );
}
const target = (kind: StoryObjectTarget['kind'], id: string = kind): StoryObjectTarget => ({ kind, id });

describe('screenwriter object lifecycle in the same Markdown', () => {
  it('archives and unarchives referenced entities, scenes and shots without changing their creative status or body', () => {
    for (const object of [target('entity', 'person'), target('entity', 'place'), target('entity', 'prop'), target('scene'), target('shot')]) {
      const source = fixture();
      const archived = apply(source, { kind: 'setObjectArchived', target: object, archived: true });
      expect(inspectStoryObjectDeletion(archived, object).archived).toBe(true);
      expect(projectStoryBody(archived)).toBe(projectStoryBody(source));
      expect(apply(archived, { kind: 'setObjectArchived', target: object, archived: true })).toBe(archived);
      const active = apply(archived, { kind: 'setObjectArchived', target: object, archived: false });
      expect(inspectStoryObjectDeletion(active, object).archived).toBe(false);
      expect(parseStoryMarkdown(active).metadata?.entities[0]?.status).toBe('作者自定状态');
    }
  });

  it('lists blocking identity relations and retained-body references before deleting, without guessing author extensions', () => {
    const source = fixture();
    expect(inspectStoryObjectDeletion(source, target('entity', 'place'))).toMatchObject({ canDelete: false, dependencies: [{ collection: 'scenes', id: 'scene', path: 'placeId', blocksDeletion: true }] });
    const scene = inspectStoryObjectDeletion(source, target('scene'));
    expect(scene.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'shot', path: 'sceneId', blocksDeletion: true }),
      expect.objectContaining({ id: 'shot', path: 'sourceBlockIds', blocksDeletion: false }),
    ]));
    expect(() => apply(source, { kind: 'deleteObject', target: target('entity', 'person') })).toThrow(/仍被引用/);
    const independent = apply(source, { kind: 'upsertEntity', entity: { id: 'independent', kind: 'person', profileBlockId: 'independent_body', author: { entityId: 'person' } }, profileMarkdown: '### 同名' });
    expect(inspectStoryObjectDeletion(independent, target('entity', 'person')).dependencies.filter((item) => item.id === 'independent')).toEqual([]);
  });

  it('makes legacy removeRecord recoverable and restores stable identity without overwriting later prose or unrelated edits', () => {
    const source = fixture();
    const deleted = apply(source, { kind: 'removeRecord', collection: 'shots', id: 'shot' });
    expect(projectStoryBody(deleted)).toBe(projectStoryBody(source));
    expect(parseStoryMarkdown(deleted).metadata?.deletedObjects[0]).toMatchObject({ id: 'shot', kind: 'shot', title: '手', record: { descriptionBlockId: 'shot_body' } });
    const edited = apply(deleted, { kind: 'replaceBlock', blockId: 'shot_body', markdown: '### 手\n人工补写，只恢复身份。' }, { kind: 'renameEntity', entityId: 'person', name: '新的姓名' });
    const restored = apply(edited, { kind: 'restoreObject', target: target('shot') });
    expect(parseStoryMarkdown(restored).metadata?.shots[0]?.id).toBe('shot');
    expect(parseStoryMarkdown(restored).metadata?.deletedObjects).toEqual([]);
    expect(projectStoryBody(restored)).toBe(projectStoryBody(edited));
    expect(restored).toContain('人工补写，只恢复身份。');
    expect(restored).toContain('新的姓名');
  });

  it('includes binding targets and scene scopes, and permits body-only links to keep working after scene removal', () => {
    const bound = apply(fixture(),
      { kind: 'upsertAsset', asset: { id: 'asset', versionId: 'v1', mediaType: 'image/png', projectRelativePath: 'photo.png', sha256: 'a'.repeat(64) } },
      { kind: 'upsertBinding', binding: { id: 'binding', target: { kind: 'entity', id: 'person' }, scope: { kind: 'scene', sceneId: 'scene' }, purpose: 'costume', primary: true, assetId: 'asset', assetVersionId: 'v1' } },
    );
    expect(inspectStoryObjectDeletion(bound, target('entity', 'person')).dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'binding', path: 'target.id', blocksDeletion: true })]));
    expect(inspectStoryObjectDeletion(bound, target('scene')).dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'binding', path: 'scope.sceneId', blocksDeletion: true })]));
    const shot = parseStoryMarkdown(bound).metadata!.shots[0]!;
    const detached = apply(bound, { kind: 'removeRecord', collection: 'bindings', id: 'binding' }, { kind: 'upsertShot', shot: { ...shot, sceneId: null } });
    expect(inspectStoryObjectDeletion(detached, target('scene'))).toMatchObject({ canDelete: true, dependencies: [{ id: 'shot', path: 'sourceBlockIds', blocksDeletion: false }] });
    const deleted = apply(detached, { kind: 'deleteObject', target: target('scene') });
    expect(parseStoryMarkdown(deleted).metadata?.shots[0]?.sourceBlockIds).toEqual(['action']);
    expect(parseStoryMarkdown(deleted).metadata?.assets).toHaveLength(1);
  });

  it('restores a removed scene at its current body position while keeping later scene edits and order', () => {
    let source = apply(fixture(), { kind: 'deleteObject', target: target('shot') }, { kind: 'deleteObject', target: target('scene') });
    source = apply(source, { kind: 'upsertScene', scene: { id: 'later_scene', headingBlockId: 'later_heading', blockIds: ['later_heading'] }, blocks: [{ id: 'later_heading', kind: 'scene-heading', markdown: '### 后来另加一场' }] }, { kind: 'replaceBlock', blockId: 'action', markdown: '人工改过的动作。' });
    const restored = apply(source, { kind: 'restoreObject', target: target('scene') });
    expect(parseStoryMarkdown(restored).metadata?.sceneOrder).toEqual(['scene', 'later_scene']);
    expect(projectStoryBody(restored)).toBe(projectStoryBody(source));
    expect(parseStoryMarkdown(restored).metadata?.deletedObjects.map((item) => item.id)).toEqual(['shot']);
  });

  it('reserves deleted IDs and refuses restoration when retained body or outbound dependencies are gone', () => {
    const deleted = apply(fixture(), { kind: 'deleteObject', target: target('shot') });
    expect(() => apply(deleted, { kind: 'upsertShot', shot: { id: 'shot', descriptionBlockId: 'newbody', sourceBlockIds: [], entityIds: [] }, descriptionMarkdown: '偷换身份' })).toThrow(/请使用恢复/);
    const withoutScene = apply(deleted, { kind: 'deleteObject', target: target('scene') });
    expect(() => apply(withoutScene, { kind: 'restoreObject', target: target('shot') })).toThrow(/断裂关联/);
    const block = parseStoryMarkdown(deleted).blocks.find((item) => item.id === 'shot_body')!;
    const missingBody = deleted.slice(0, block.range.start) + deleted.slice(block.range.end);
    expect(parseStoryMarkdown(missingBody).semanticEditable).toBe(true);
    expect(() => apply(missingBody, { kind: 'restoreObject', target: target('shot') })).toThrow(/正文块已被后续修改移除/);
  });

  it('copies recoverable objects and their references with new IDs without losing archived state or unknown members', () => {
    const source = apply(fixture(), { kind: 'setObjectArchived', target: target('entity', 'person'), archived: true }, { kind: 'deleteObject', target: target('shot') });
    let id = 0;
    const imported = prepareStoryImport(source, { mode: 'copy', idFactory: (kind) => `${kind}_${++id}` });
    const copied = parseStoryMarkdown(imported.markdown).metadata!;
    expect(copied.entities[0]).toMatchObject({ archived: true, unknown: { text: '保留' } });
    expect(copied.deletedObjects[0]).toMatchObject({ id: imported.idMap.shot, record: { id: imported.idMap.shot, sceneId: imported.idMap.scene, entityIds: [imported.idMap.person, imported.idMap.prop] } });
    const restored = apply(imported.markdown, { kind: 'restoreObject', target: target('shot', imported.idMap.shot!) });
    expect(parseStoryMarkdown(restored).semanticEditable).toBe(true);
    expect(projectStoryBody(restored)).toBe(projectStoryBody(source));
  });
});
