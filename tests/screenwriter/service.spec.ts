import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoryService } from '../../src/screenwriter/service.js';
import { contentDigest as projectFileVersionContentDigest, listVersions, versionTestHooks as projectFileVersionTestHooks, withVersionLock } from '../../src/versions.js';
const writeProjectFile = (rootDir: string, project: string, filePath: string, bytes: Buffer) => writeFile(path.join(rootDir, project, filePath), bytes);

describe('screenwriter persistence and version boundary', () => {
  let root: string;
  let service: StoryService;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'story-service-'));
    service = new StoryService();
    await mkdir(path.join(root, 'film'), { recursive: true });
  });
  afterEach(async () => { vi.restoreAllMocks(); projectFileVersionTestHooks.beforeWriteManifest = null; await rm(root, { recursive: true, force: true }); });

  it('reloads the same Markdown with anonymous, silent, incomplete prose and unknown comments', async () => {
    const body = '# 未完成\n\n一只手，放下钥匙。\n<!-- 作者的话：别添对白 -->\n';
    const created = await service.create(path.join(root, 'film'), { title: '无对白', content: body });
    const id = created.document.documentId;
    expect(created.document.content).toContain(body);
    const fresh = new StoryService();
    expect((await fresh.get(path.join(root, 'film'), id)).content).toBe(created.document.content);
    expect((await readFile(path.join(root, 'film', created.document.filePath), 'utf8'))).toBe(created.document.content);
    expect((await fresh.list(path.join(root, 'film'))).documents).toHaveLength(1);
  });

  it('serializes competing human/agent writes; loser receives the current document', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '同一稿' });
    const results = await Promise.allSettled(['人工修改', 'Agent修改'].map((text) => service.save(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, content: `${document.content}\n${text}` })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((result) => result.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason.code).toBe('STORY_CONFLICT');
    const current = await service.get(path.join(root, 'film'), document.documentId);
    expect(loser?.status === 'rejected' && loser.reason.current.revision).toBe(current.revision);
  });

  it('honors explicit title and kind for native copies while preserving source defaults and prose', async () => {
    const original = (await service.create(path.join(root, 'film'), { title: '源标题', kind: 'episode', content: '# 正文标题保留\n\n未完——' })).document;
    const unchanged = (await service.create(path.join(root, 'film'), { content: original.content })).document;
    expect(unchanged.title).toBe('源标题');
    expect(unchanged.kind).toBe('episode');
    const overridden = (await service.create(path.join(root, 'film'), { content: original.content, title: '明确的新标题', kind: 'short' })).document;
    expect(overridden.title).toBe('明确的新标题');
    expect(overridden.kind).toBe('short');
    expect(overridden.content).toContain('# 正文标题保留\n\n未完——');
    expect((await service.get(path.join(root, 'film'), original.documentId)).content).toBe(original.content);
    expect((await service.create(path.join(root, 'film'), { content: original.content, title: '' })).document.title).toBe('');
  });

  it('restores text and relationship metadata together without touching media', async () => {
    const { document: initial } = await service.create(path.join(root, 'film'), { title: '原稿' });
    const media = path.join(root, 'film', 'reference.svg');
    await writeFile(media, '<svg>original</svg>');
    const changed = await service.apply(path.join(root, 'film'), initial.documentId, { expectedRevision: initial.revision, operations: [
      { kind: 'upsertEntity', entity: { id: 'person_a', kind: 'person', profileBlockId: 'profile_a' }, profileMarkdown: '### 同名\n\n身份未定。' },
      { kind: 'upsertEntity', entity: { id: 'person_b', kind: 'person', profileBlockId: 'profile_b' }, profileMarkdown: '### 同名\n\n另一个人。' },
    ] });
    expect(changed.document.parsed.metadata?.entities).toHaveLength(2);
    const restored = await service.restore(path.join(root, 'film'), initial.documentId, { expectedRevision: changed.document.revision, versionId: initial.versionId! });
    expect(restored.document.content).toBe(initial.content);
    expect(restored.document.parsed.metadata?.entities).toHaveLength(0);
    expect(await readFile(media, 'utf8')).toBe('<svg>original</svg>');
  });

  it('does not repeat a committed operation even after a later human edit and restart', async () => {
    const { document: initial } = await service.create(path.join(root, 'film'), { title: '重试' });
    const request = { expectedRevision: initial.revision, operationId: 'op-once', content: `${initial.content}\n结尾一次。` };
    const first = await service.save(path.join(root, 'film'), initial.documentId, request);
    const later = await service.save(path.join(root, 'film'), initial.documentId, { expectedRevision: first.document.revision, content: `${first.document.content}\n人工继续。` });
    const fresh = new StoryService();
    const retried = await fresh.save(path.join(root, 'film'), initial.documentId, request);
    expect(retried.changed).toBe(false);
    expect(retried.document.content).toBe(later.document.content);
    await expect(fresh.save(path.join(root, 'film'), initial.documentId, { ...request, content: `${initial.content}\n另一件事` })).rejects.toMatchObject({ code: 'STORY_OPERATION_REUSED' });
  });

  it('persists no-op receipts so an operation identity cannot later perform a different mutation', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '无变化' });
    const request = { expectedRevision: document.revision, operationId: 'no-op-once', content: document.content };
    expect((await service.save(path.join(root, 'film'), document.documentId, request)).changed).toBe(false);
    const fresh = new StoryService();
    await expect(fresh.save(path.join(root, 'film'), document.documentId, { ...request, content: `${document.content}\n变了` })).rejects.toMatchObject({ code: 'STORY_OPERATION_REUSED' });
  });

  it('dry-run never captures versions even when a direct external editor changed the file', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '外部改稿' });
    const external = `${document.content}\n人工用文本编辑器补的内容。`;
    await writeFile(path.join(root, 'film', document.filePath), external);
    const before = await listVersions(path.join(root, 'film'), document.filePath);
    const preview = await service.apply(path.join(root, 'film'), document.documentId, { expectedRevision: projectFileVersionContentDigest(external), dryRun: true, operations: [{ kind: 'updateDocument', changes: { title: '未保存的标题' } }] });
    expect(preview.document.title).toBe('未保存的标题');
    expect(preview.document.versionId).toBeNull();
    expect(await readFile(path.join(root, 'film', document.filePath), 'utf8')).toBe(external);
    expect(await listVersions(path.join(root, 'film'), document.filePath)).toEqual(before);
  });

  it('marks externally replaced identities uneditable while preserving damaged native imports exactly', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '身份' });
    const foreign = document.content.replace(document.documentId, 'foreign_document');
    await writeFile(path.join(root, 'film', document.filePath), foreign);
    const observed = await service.get(path.join(root, 'film'), document.documentId);
    expect(observed.content).toBe(foreign);
    expect(observed.parsed.semanticEditable).toBe(false);
    expect(observed.parsed.diagnostics.map((item) => item.code)).toContain('document-identity-mismatch');
    const broken = document.content.replace('"formatVersion": "1.0"', '"formatVersion": "99.0"') + '\n<!-- unfinished';
    const imported = await service.create(path.join(root, 'film'), { content: broken });
    expect(imported.document.content).toBe(broken);
    expect(imported.document.parsed.semanticEditable).toBe(false);
  });

  it('checks CAS and stable receipts before an async resolver allocates new reference identities', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '异步引用' });
    let calls = 0;
    const transform = async (current: typeof document) => { calls++; return { content: `${current.content}\n只绑定一次。` }; };
    const first = await service.mutate(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, operationId: 'bind-once', request: { assetId: 'a', target: { kind: 'entity', id: 'p' } } }, transform);
    const retry = await service.mutate(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, operationId: 'bind-once', request: { target: { id: 'p', kind: 'entity' }, assetId: 'a' } }, transform);
    expect(calls).toBe(1);
    expect(retry.changed).toBe(false);
    expect(retry.document.revision).toBe(first.document.revision);
  });

  it('retains direct external edits that arrive during an asynchronous semantic transform', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '并发引用' });
    const external = `${document.content}\n外部人工修改。`;
    await expect(service.mutate(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, request: { kind: 'async-test' } }, async () => {
      await writeFile(path.join(root, 'film', document.filePath), external);
      return { content: `${document.content}\n不应覆盖人工稿。` };
    })).rejects.toMatchObject({ code: 'STORY_CONFLICT', current: { content: external } });
    expect(await readFile(path.join(root, 'film', document.filePath), 'utf8')).toBe(external);
  });

  it('uses the same lock as generic project-file version-aware edits', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '共用保存锁' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const external = `${document.content}\n现有文件编辑器写入。`;
    const generic = withVersionLock(path.join(root, 'film'), document.filePath, async (lock) => {
      entered(); await gate;
      await writeProjectFile(root, 'film', document.filePath, Buffer.from(external));
      await lock.ensureCurrentVersion(external, { source: 'manual' });
    });
    await started;
    const conflicting = service.save(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, content: `${document.content}\n旧编剧稿` });
    const rejected = expect(conflicting).rejects.toMatchObject({ code: 'STORY_CONFLICT', current: { content: external } });
    release(); await generic; await rejected;
    expect((await service.get(path.join(root, 'film'), document.documentId)).content).toBe(external);
  });

  it('recovers a saved operation after receipt finalization failed and never repeats its write', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '中断' });
    const writer = service as unknown as { atomicWrite(target: string, content: string): Promise<void> };
    const write = writer.atomicWrite.bind(service);
    const spy = vi.spyOn(writer, 'atomicWrite').mockImplementation(async (target, content) => {
      if (target.endsWith('crash-once.json') && JSON.parse(content).committed === true) throw new Error('receipt disk failure');
      await write(target, content);
    });
    const request = { expectedRevision: document.revision, operationId: 'crash-once', content: `${document.content}\n已真正写入。` };
    await expect(service.save(path.join(root, 'film'), document.documentId, request)).rejects.toThrow('receipt disk failure');
    spy.mockRestore();
    expect(await readFile(path.join(root, 'film', document.filePath), 'utf8')).toBe(request.content);
    const fresh = new StoryService();
    const retried = await fresh.save(path.join(root, 'film'), document.documentId, request);
    expect(retried.changed).toBe(false);
    expect(retried.document.content).toBe(request.content);
    const receiptPath = path.join(root, 'film', 'film', '.versions', 'story-operations', document.documentId, 'crash-once.json');
    expect(JSON.parse(await readFile(receiptPath, 'utf8')).committed).toBe(true);
  });

  it('does not report a document write failure as committed and a later retry can apply it once', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '目标写失败' });
    const writer = service as unknown as { atomicWrite(target: string, content: string): Promise<void> };
    const write = writer.atomicWrite.bind(service);
    const spy = vi.spyOn(writer, 'atomicWrite').mockImplementation(async (target, content) => {
      if (target.endsWith(`${document.documentId}.md`)) throw new Error('document disk failure');
      await write(target, content);
    });
    const request = { expectedRevision: document.revision, operationId: 'retry-file', content: `${document.content}\n需要重试的稿。` };
    await expect(service.save(path.join(root, 'film'), document.documentId, request)).rejects.toThrow('document disk failure');
    spy.mockRestore();
    expect(await readFile(path.join(root, 'film', document.filePath), 'utf8')).toBe(document.content);
    const receiptPath = path.join(root, 'film', 'film', '.versions', 'story-operations', document.documentId, 'retry-file.json');
    expect(JSON.parse(await readFile(receiptPath, 'utf8')).committed).toBe(false);
    await expect(service.revert(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, operationId: 'retry-file' })).rejects.toMatchObject({ code: 'STORY_OPERATION_NOT_COMMITTED' });
    const applied = await service.save(path.join(root, 'film'), document.documentId, request);
    expect(applied.changed).toBe(true);
    expect(applied.document.content).toBe(request.content);
  });

  it('reverts an operation once and retains later independent human text across replay', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '撤回', content: '# 原稿\n\n第一处。\n\n第二处。\n' });
    const after = await service.save(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, operationId: 'original-ai', content: document.content.replace('第一处。', '第一处 AI。') });
    const manual = await service.save(path.join(root, 'film'), document.documentId, { expectedRevision: after.document.revision, content: `${after.document.content}\n人工附记。` });
    const reverted = await service.revert(path.join(root, 'film'), document.documentId, { expectedRevision: manual.document.revision, operationId: 'original-ai' });
    expect(reverted.document.content).toBe(`${document.content}\n人工附记。`);
    const retry = await service.revert(path.join(root, 'film'), document.documentId, { expectedRevision: manual.document.revision, operationId: 'original-ai' });
    expect(retry.changed).toBe(false);
    expect(retry.document.content).toBe(reverted.document.content);
  });

  it('retains working content on failed version capture and rejects a stale restore', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '写入失败' });
    projectFileVersionTestHooks.beforeWriteManifest = () => { throw new Error('disk full'); };
    await expect(service.save(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, content: `${document.content}\n新句` })).rejects.toThrow('disk full');
    projectFileVersionTestHooks.beforeWriteManifest = null;
    expect((await service.get(path.join(root, 'film'), document.documentId)).content).toBe(document.content);
    const changed = await service.save(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, content: `${document.content}\n已保存` });
    await expect(service.restore(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, versionId: document.versionId! })).rejects.toMatchObject({ code: 'STORY_CONFLICT', current: { revision: changed.document.revision } });
  });

  it('dry-run changes neither file nor versions; named versions use the existing history', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '预检' });
    const before = await service.history(path.join(root, 'film'), document.documentId);
    const preview = await service.apply(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, dryRun: true, operations: [{ kind: 'updateDocument', changes: { title: '预览标题' } }] });
    expect(preview.changed).toBe(true);
    expect((await service.get(path.join(root, 'film'), document.documentId)).content).toBe(document.content);
    expect((await service.history(path.join(root, 'film'), document.documentId)).versions.length).toBe(before.versions.length);
    const { version } = await service.checkpoint(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, label: '一稿' });
    expect(version.label).toBe('一稿');
    expect((await service.version(path.join(root, 'film'), document.documentId, version.id)).content).toBe(document.content);
  });

  it('attributes human card edits separately from Agent operations in the existing version history', async () => {
    const { document } = await service.create(path.join(root, 'film'), { title: '来源归因' });
    const manual = await service.apply(path.join(root, 'film'), document.documentId, { expectedRevision: document.revision, source: 'manual', operations: [{ kind: 'updateDocument', changes: { title: '人工标题' } }] });
    const ai = await service.apply(path.join(root, 'film'), document.documentId, { expectedRevision: manual.document.revision, operations: [{ kind: 'updateDocument', changes: { title: 'Agent标题' } }] });
    const { versions } = await service.history(path.join(root, 'film'), document.documentId);
    expect(versions.find(version => version.id === manual.document.versionId)?.source).toBe('manual');
    expect(versions.find(version => version.id === ai.document.versionId)?.source).toBe('ai');
  });

  // The workspace itself is checked by the route (workspaceDirectory); the service guards its own paths.
  it('rejects path escapes, including a symlinked story directory', async () => {
    await expect(service.get(path.join(root, 'film'), '../escape')).rejects.toMatchObject({ code: 'STORY_INVALID_ID' });
    await mkdir(path.join(root, 'film', 'film'), { recursive: true });
    await mkdir(path.join(root, 'outside'));
    await symlink(path.join(root, 'outside'), path.join(root, 'film', 'film', 'story'), 'junction');
    await expect(service.create(path.join(root, 'film'), {})).rejects.toMatchObject({ code: 'STORY_PATH_ESCAPE' });
  });
});
