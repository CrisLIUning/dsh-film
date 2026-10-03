import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoryDocument, StoryOperation } from '../../src/screenwriter/contracts/index.js';
import { projectStoryBody } from '../../src/screenwriter/contracts/index.js';
import { StoryService } from '../../src/screenwriter/service.js';

describe('screenwriter lifecycle shares durable CAS operations and version history', () => {
  let root: string;
  let service: StoryService;
  let document: StoryDocument;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'story-lifecycle-'));
    service = new StoryService();
    await mkdir(path.join(root, 'film'), { recursive: true });
    const created = await service.create(path.join(root, 'film'), { title: '原稿', content: '# 保留的正文\n\n未知注释后——' });
    document = (await service.apply(path.join(root, 'film'), created.document.documentId, { expectedRevision: created.document.revision, operations: [
      { kind: 'upsertEntity', entity: { id: 'person', kind: 'person', profileBlockId: 'profile', custom: { keep: true } }, profileMarkdown: '### 同名的人' },
      { kind: 'upsertScene', scene: { id: 'scene', headingBlockId: 'heading', blockIds: ['heading', 'action'] }, blocks: [{ id: 'heading', kind: 'scene-heading', markdown: '### 门口' }, { id: 'action', kind: 'action', markdown: '尚未完成的动作——' }] },
      { kind: 'upsertShot', shot: { id: 'shot', descriptionBlockId: 'description', sceneId: 'scene', sourceBlockIds: ['action'], entityIds: ['person'] }, descriptionMarkdown: '### 手' },
    ] })).document;
    await writeFile(path.join(root, 'film', 'original.png'), 'original media bytes');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  async function apply(operations: StoryOperation[], operationId?: string) {
    const result = await service.apply(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, operations, ...(operationId ? { operationId } : {}) });
    document = result.document;
    return result;
  }

  it('returns saved-revision dependencies and atomically rejects deletion while allowing archival', async () => {
    const preview = await service.deletionPreview(path.join(root, 'film'), document.documentId, { kind: 'entity', id: 'person' });
    expect(preview).toMatchObject({ revision: document.revision, canDelete: false, dependencies: [{ id: 'shot', path: 'entityIds', blocksDeletion: true }] });
    const before = document.content;
    await expect(apply([{ kind: 'renameEntity', entityId: 'person', name: '不会部分保存' }, { kind: 'deleteObject', target: { kind: 'entity', id: 'person' } }])).rejects.toMatchObject({ code: 'object-has-dependencies', diagnostics: [expect.objectContaining({ code: 'object-dependency', objectId: 'shot' })] });
    expect((await service.get(path.join(root, 'film'), document.documentId)).content).toBe(before);
    await apply([{ kind: 'setObjectArchived', target: { kind: 'entity', id: 'person' }, archived: true }]);
    expect(document.parsed.metadata?.entities[0]?.archived).toBe(true);
    expect(document.parsed.metadata?.shots[0]?.entityIds).toEqual(['person']);
    expect((await service.deletionPreview(path.join(root, 'film'), document.documentId, { kind: 'entity', id: 'person' })).canDelete).toBe(false);
  });

  it('persists a recoverable deletion across restart, preserves later changes and original files, and records history', async () => {
    const original = document;
    await apply([{ kind: 'deleteObject', target: { kind: 'shot', id: 'shot' } }], 'delete-shot');
    expect(document.parsed.metadata?.deletedObjects[0]).toMatchObject({ id: 'shot', kind: 'shot' });
    const deletedRevision = document.revision;
    service = new StoryService();
    const retry = await service.apply(path.join(root, 'film'), document.documentId, { expectedRevision: original.revision, operationId: 'delete-shot', operations: [{ kind: 'deleteObject', target: { kind: 'shot', id: 'shot' } }] });
    expect(retry.changed).toBe(false);
    await apply([{ kind: 'replaceBlock', blockId: 'description', markdown: '### 手\n后续人工补充。' }, { kind: 'updateDocument', changes: { title: '后续标题' } }]);
    const laterBody = projectStoryBody(document.content);
    const afterHuman = document;
    const restoreOps: StoryOperation[] = [{ kind: 'restoreObject', target: { kind: 'shot', id: 'shot' } }];
    const restored = await apply(restoreOps, 'restore-shot');
    expect(restored.changedIds).toContain('shot');
    expect(document.title).toBe('后续标题');
    expect(projectStoryBody(document.content)).toBe(laterBody);
    expect(document.parsed.metadata?.shots[0]?.id).toBe('shot');
    expect(document.parsed.metadata?.deletedObjects).toEqual([]);
    expect((await service.apply(path.join(root, 'film'), document.documentId, { expectedRevision: afterHuman.revision, operationId: 'restore-shot', operations: restoreOps })).changed).toBe(false);
    expect(document.revision).not.toBe(deletedRevision);
    expect((await service.history(path.join(root, 'film'), document.documentId)).versions.length).toBeGreaterThan(3);
    expect(await readFile(path.join(root, 'film', 'original.png'), 'utf8')).toBe('original media bytes');
  });

  it('keeps deleted IDs out of stale caches, refuses a raced deletion and does not save dry-run lifecycle plans', async () => {
    const baseline = document;
    const dryRun = await service.apply(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, dryRun: true, operations: [{ kind: 'deleteObject', target: { kind: 'shot', id: 'shot' } }] });
    expect(dryRun.document.parsed.metadata?.deletedObjects[0]?.id).toBe('shot');
    expect((await service.get(path.join(root, 'film'), document.documentId)).revision).toBe(baseline.revision);
    await apply([{ kind: 'deleteObject', target: { kind: 'shot', id: 'shot' } }]);
    await expect(service.save(path.join(root, 'film'), document.documentId, { expectedRevision: baseline.revision, content: baseline.content })).rejects.toMatchObject({ code: 'STORY_CONFLICT' });
    await expect(apply([{ kind: 'upsertShot', shot: baseline.parsed.metadata!.shots[0]! }])).rejects.toMatchObject({ code: 'reserved-deleted-id' });
    expect((await service.get(path.join(root, 'film'), document.documentId)).parsed.metadata?.deletedObjects[0]?.id).toBe('shot');
  });
});
