import { describe, expect, it } from 'vitest';
import { applyStoryOperations, createStoryMarkdown, isSafeStoryAssetPath, parseStoryMarkdown, prepareStoryImport, projectStoryBody, resolveStoryReferences, serializeStoryBlock, StoryOperationError, type StoryOperation } from '../../src/screenwriter/contracts/index.js';

const fixture = `<!-- vibedev:screenwriter
{
  "format" : "vibedev.screenwriter", "formatVersion":"1.0",
  "document":{"id":"doc_film","kind":"short","title":"两个人"},
  "sceneOrder":["scene_first", "scene_second"],
  "shotOrder":["shot_hand"],
  "entities":[
    {"id":"person_a","kind":"person","profileBlockId":"profile_a","future": { "odd" : "\\u6797" }},
    {"id":"person_b","kind":"person","profileBlockId":"profile_b"}
  ],
  "scenes":[
    {"id":"scene_first","headingBlockId":"heading_first","blockIds":["heading_first","speech_a","speech_b"]},
    {"id":"scene_second","headingBlockId":"heading_second","blockIds":["heading_second","action_second"]}
  ],
  "speech":[{"id":"speech_rel_a","blockId":"speech_a","speakerId":"person_a"},{"id":"speech_rel_b","blockId":"speech_b","speakerId":"person_b"}],
  "shots":[{"id":"shot_hand","descriptionBlockId":"shot_description","sceneId":"scene_second","sourceBlockIds":["action_second"],"entityIds":["person_a","person_b"]}],
  "assets":[{"id":"asset_a","versionId":"v1","mediaType":"image/png","projectRelativePath":"images/a.png","sha256":"${'a'.repeat(64)}"}],
  "bindings":[{"id":"binding_a","target":{"kind":"entity","id":"person_a"},"scope":{"kind":"document"},"purpose":"appearance","assetId":"asset_a","assetVersionId":"v1","primary":true}],
  "unknown" : { "sentence" : "不要改写", "spaces": "  " }
}
-->

# 两个人

${serializeStoryBlock({ id: 'profile_a', kind: 'entity-profile', markdown: '### 林岚\n\n年龄未定。' })}

${serializeStoryBlock({ id: 'profile_b', kind: 'entity-profile', markdown: '### 林岚\n\n另一个同名的人。' })}

## 正文

${serializeStoryBlock({ id: 'heading_first', kind: 'scene-heading', markdown: '### 内景 · 店铺 · 夜' })}

${serializeStoryBlock({ id: 'speech_a', kind: 'speech', markdown: '**林岚**\n\n我先试试。' })}

${serializeStoryBlock({ id: 'speech_b', kind: 'speech', markdown: '**林岚**\n\n我等你。' })}

<!-- author:between  保留这段未知注释。 -->

${serializeStoryBlock({ id: 'heading_second', kind: 'scene-heading', markdown: '### 外景 · 店门口 · 清晨' })}

${serializeStoryBlock({ id: 'action_second', kind: 'action', markdown: '她从伞后伸手，停住。\n\n<!-- author:voice 不要补动作 -->' })}

## 镜头

${serializeStoryBlock({ id: 'shot_description', kind: 'shot-plan', markdown: '### 手\n\n12 秒为估计。' })}

## 自由便签

林岚也是一家店的名字；未确认身份。  
那天其实——
`;

function run(source: string, ...operations: StoryOperation[]) { return applyStoryOperations(source, operations).markdown; }
function block(source: string, id: string) { return parseStoryMarkdown(source).blocks.find((item) => item.id === id)!; }

describe('screenwriter lossless source parser', () => {
  it('reads a real document with same-name identities without changing any source bytes', () => {
    const source = '\uFEFF' + fixture.replace(/\n/g, '\r\n');
    const parsed = parseStoryMarkdown(source);
    expect(parsed.source).toBe(source);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.semanticEditable).toBe(true);
    expect(parsed.blocks).toHaveLength(8);
    expect(parsed.metadata?.entities.map((entity) => entity.id)).toEqual(['person_a', 'person_b']);
    expect(applyStoryOperations(source, []).markdown).toBe(source);
    expect(prepareStoryImport(source, { mode: 'preserve' }).markdown).toBe(source);
  });

  it('treats fenced, indented, inline and raw-HTML marker examples as prose', () => {
    const marker = '<!-- sw:block {"id":"example","kind":"action"} -->';
    const source = [
      '````md', marker, '```', marker, '````',
      '~~~', marker, '~~~',
      `    ${marker}`, `Look at ${marker}`, '<pre>', marker, '</pre>',
      '<!-- author:example', marker, 'outside -->',
    ].join('\n');
    const parsed = parseStoryMarkdown(source);
    expect(parsed.format).toBe('plain');
    expect(parsed.blocks).toEqual([]);
    expect(parsed.diagnostics).toEqual([]);
    expect(projectStoryBody(source)).toBe(source);
  });

  it('never upgrades broken, duplicate or future metadata into editable structure', () => {
    for (const source of [
      fixture.replace('"title":"两个人"', '"title":"两个人","title":"后来"'),
      fixture.replace('"formatVersion":"1.0"', '"formatVersion":"99.0"'),
      fixture.replace('<!-- /sw:block {"id":"speech_a"} -->', ''),
      fixture.replace('"profileBlockId":"profile_a"', '"profileBlockId":"missing"'),
      fixture + '\n<!-- vibedev:screenwriter\n{',
      fixture + '\n' + serializeStoryBlock({ id: 'speech_a', kind: 'speech', markdown: '**另一个**' }),
    ]) {
      const parsed = parseStoryMarkdown(source);
      expect(parsed.source).toBe(source);
      expect(parsed.semanticEditable).toBe(false);
      expect(parsed.diagnostics.some((item) => item.severity === 'error')).toBe(true);
      expect(() => run(source, { kind: 'renameEntity', entityId: 'person_a', name: '林宁' })).toThrow(StoryOperationError);
      const imported = prepareStoryImport(source, { mode: 'copy' });
      expect(imported.markdown).toBe(source);
      expect(imported.semanticEditable).toBe(false);
    }
  });

  it('accepts silence, unnamed people, zero scenes and unfinished free prose', () => {
    const source = createStoryMarkdown({ documentId: 'doc_empty', title: '', kind: 'short', body: '# 雨\n\nA抬起手，又——' });
    const next = run(source, { kind: 'upsertEntity', entity: { id: 'person_unknown', kind: 'person', profileBlockId: 'profile_unknown' }, profileMarkdown: '### \n\n只出现手。' });
    expect(parseStoryMarkdown(next).semanticEditable).toBe(true);
    expect(next).toContain('A抬起手，又——');
    expect(parseStoryMarkdown(next).metadata?.scenes).toEqual([]);
  });

  it('rejects nested anchors, kind-mismatched references, invalid orders and multiple mains', () => {
    const variants = [
      fixture.replace('我先试试。', '<!-- sw:block {"id":"nested","kind":"action"} -->\n内层\n<!-- /sw:block {"id":"nested"} -->'),
      fixture.replace('"id":"person_a","kind":"person"', '"id":"person_a","kind":"place"'),
      fixture.replace('["scene_first", "scene_second"]', '["scene_second", "scene_first"]'),
      fixture.replace('"sceneOrder":["scene_first", "scene_second"]', '"sceneOrder":["scene_first", "scene_first"]'),
    ];
    for (const source of variants) expect(parseStoryMarkdown(source).semanticEditable).toBe(false);
  });
});

describe('screenwriter localized semantic edits', () => {
  it('changes only the selected original content range, preserving arbitrary comments and metadata formatting', () => {
    const original = block(fixture, 'action_second');
    const markdown = '\n她把伞递出去。\n';
    const next = run(fixture, { kind: 'replaceBlock', blockId: original.id, expectedMarkdown: original.markdown, markdown });
    expect(next).toBe(fixture.slice(0, original.contentRange.start) + markdown + fixture.slice(original.contentRange.end));
    expect(next).toContain('"future": { "odd" : "\\u6797" }');
    expect(() => run(next, { kind: 'replaceBlock', blockId: original.id, expectedMarkdown: original.markdown, markdown: '另一稿' })).toThrow(/已改变/);
  });

  it('renames linked signature only, retaining a same-name person and ordinary mentions', () => {
    const next = run(fixture, { kind: 'renameEntity', entityId: 'person_a', name: '林宁' });
    expect(block(next, 'profile_a').markdown).toContain('### 林宁');
    expect(block(next, 'speech_a').markdown).toContain('**林宁**');
    expect(block(next, 'speech_b').markdown).toBe(block(fixture, 'speech_b').markdown);
    expect(block(next, 'profile_b').markdown).toBe(block(fixture, 'profile_b').markdown);
    expect(next).toContain('林岚也是一家店的名字');
    const switched = run(next, { kind: 'setSpeechSpeaker', speechId: 'speech_rel_b', speakerId: 'person_a' });
    expect(block(switched, 'speech_b').markdown).toContain('**林宁**');
    expect(parseStoryMarkdown(switched).metadata?.speech[1]?.speakerId).toBe('person_a');
    const receipt = applyStoryOperations(fixture, [{ kind: 'renameEntity', entityId: 'person_a', name: '林宁' }]);
    expect(receipt.changedIds).toEqual(expect.arrayContaining(['person_a', 'profile_a', 'speech_a']));
  });

  it('does not mistake emphasized dialogue for a missing signature or double-escape a literal name', () => {
    const signatureRemoved = run(fixture, { kind: 'replaceBlock', blockId: 'speech_a', markdown: '开口之前。\n\n**这是对白强调**' });
    expect(() => run(signatureRemoved, { kind: 'renameEntity', entityId: 'person_a', name: '林宁' })).toThrow(/署名行/);
    const renamed = run(fixture, { kind: 'renameEntity', entityId: 'person_a', name: '甲*' });
    const switched = run(renamed, { kind: 'setSpeechSpeaker', speechId: 'speech_rel_b', speakerId: 'person_a' });
    expect(block(switched, 'speech_a').markdown).toContain('**甲\\***');
    expect(block(switched, 'speech_b').markdown).toContain('**甲\\***');
  });

  it('preserves unknown JSON members and escaping during record updates', () => {
    const entity = parseStoryMarkdown(fixture).metadata!.entities[0]!;
    const next = run(fixture, { kind: 'upsertEntity', entity: { ...entity, status: 'archived' } });
    expect(next).toContain('"future": { "odd" : "\\u6797" }');
    expect(next).toContain('"unknown" : { "sentence" : "不要改写", "spaces": "  " }');
    expect(next.slice(next.indexOf('-->'))).toBe(fixture.slice(fixture.indexOf('-->')));
    const withPrototypeKey = fixture.replace('"future": { "odd" : "\\u6797" }', '"__proto__": { "authorOwned" : true }');
    const guarded = run(withPrototypeKey, { kind: 'upsertEntity', entity: { id: 'person_a', kind: 'person', profileBlockId: 'profile_a', status: 'draft' } });
    expect(guarded).toContain('"__proto__": { "authorOwned" : true }');
    expect(({} as Record<string, unknown>).authorOwned).toBeUndefined();
  });

  it('inserts and reorders scenes while stable block, person, shot and binding identities survive', () => {
    const inserted = run(fixture, {
      kind: 'upsertScene', beforeSceneId: 'scene_second',
      scene: { id: 'scene_inserted', headingBlockId: 'heading_inserted', blockIds: ['heading_inserted', 'action_inserted'] },
      blocks: [{ id: 'heading_inserted', kind: 'scene-heading', markdown: '### 候车亭 · 雨' }, { id: 'action_inserted', kind: 'action', markdown: '匿名两人隔着一把伞。' }],
    });
    expect(parseStoryMarkdown(inserted).metadata?.sceneOrder).toEqual(['scene_first', 'scene_inserted', 'scene_second']);
    const next = run(inserted, { kind: 'reorderScenes', sceneIds: ['scene_second', 'scene_first', 'scene_inserted'] });
    const parsed = parseStoryMarkdown(next);
    expect(parsed.semanticEditable).toBe(true);
    expect(parsed.metadata?.sceneOrder).toEqual(['scene_second', 'scene_first', 'scene_inserted']);
    expect(next.indexOf('她从伞后伸手')).toBeLessThan(next.indexOf('我先试试。'));
    expect(parsed.metadata?.shots[0]?.sourceBlockIds).toEqual(['action_second']);
    expect(parsed.metadata?.bindings[0]?.target.id).toBe('person_a');
    expect(next).toContain('<!-- author:between  保留这段未知注释。 -->');
  });

  it('requires explicit relationship removal and never deletes original prose or assets', () => {
    expect(() => run(fixture, { kind: 'removeRecord', collection: 'entities', id: 'person_a' })).toThrow(/整批未写入/);
    const next = run(fixture,
      { kind: 'removeRecord', collection: 'bindings', id: 'binding_a' },
      { kind: 'removeRecord', collection: 'speech', id: 'speech_rel_a' },
      { kind: 'removeRecord', collection: 'shots', id: 'shot_hand' },
      { kind: 'removeRecord', collection: 'entities', id: 'person_a' },
    );
    expect(parseStoryMarkdown(next).metadata?.entities).toHaveLength(1);
    expect(block(next, 'profile_a').markdown).toBe(block(fixture, 'profile_a').markdown);
    expect(block(next, 'shot_description').markdown).toBe(block(fixture, 'shot_description').markdown);
    expect(parseStoryMarkdown(next).metadata?.assets).toHaveLength(1);
  });

  it('rejects dangerous marker injection and a partially valid batch atomically', () => {
    expect(() => run(fixture,
      { kind: 'replaceBlock', blockId: 'action_second', markdown: '新动作' },
      { kind: 'upsertBinding', binding: { ...parseStoryMarkdown(fixture).metadata!.bindings[0]!, assetVersionId: 'missing' } },
    )).toThrow(/整批未写入/);
    expect(() => run(fixture, { kind: 'replaceBlock', blockId: 'action_second', markdown: '<!-- /sw:block {"id":"action_second"} -->\n另写' })).toThrow();
    expect(block(fixture, 'action_second').markdown).toContain('她从伞后伸手');
  });

  it('protects HTML comment delimiters in JSON values and keeps safe metadata editable', () => {
    const next = run(fixture, { kind: 'updateDocument', changes: { title: '结束 --> 开始 <!-- 作者' } });
    expect(next).toContain('"title":"结束 --\\u003e 开始 \\u003c!-- 作者"');
    expect(parseStoryMarkdown(next).metadata?.document.title).toBe('结束 --> 开始 <!-- 作者');
    expect(parseStoryMarkdown(next).semanticEditable).toBe(true);
  });
});

describe('screenwriter exchange and reference scopes', () => {
  it('native no-op export is byte-identical; copying remaps only declared internal identities', () => {
    let nextId = 0;
    const imported = prepareStoryImport(fixture, { mode: 'copy', idFactory: (kind) => `${kind}_${++nextId}` });
    const parsed = parseStoryMarkdown(imported.markdown);
    expect(parsed.semanticEditable).toBe(true);
    expect(parsed.metadata?.document.id).toBe(imported.idMap.doc_film);
    expect(parsed.metadata?.speech[0]?.speakerId).toBe(imported.idMap.person_a);
    expect(parsed.metadata?.shots[0]?.sourceBlockIds).toEqual([imported.idMap.action_second]);
    expect(parsed.metadata?.bindings[0]?.target.id).toBe(imported.idMap.person_a);
    expect(parsed.metadata?.bindings[0]?.assetId).toBe('asset_a');
    expect(parsed.metadata?.assets[0]?.versionId).toBe('v1');
    expect(parsed.blocks[0]?.id).toBe(imported.idMap.profile_a);
    expect(projectStoryBody(imported.markdown)).toBe(projectStoryBody(fixture));
    expect(imported.markdown).toContain('"future": { "odd" : "\\u6797" }');
    expect(imported.markdown).toContain('"unknown" : { "sentence" : "不要改写", "spaces": "  " }');
    expect(imported.diagnostics.map((item) => item.code)).toContain('external-assets-require-resolution');
    expect(() => prepareStoryImport(fixture, { mode: 'copy', idFactory: () => 'same_id' })).toThrow(/不与/);
  });

  it('ordinary Markdown retains exact text, BOM, comments, CRLF and unfinished input without invented people', () => {
    const original = '\uFEFF# 第24集\r\n\r\n林岚：等等\r\n林岚：\r\n<!-- author:keep  -->\r\n';
    const imported = prepareStoryImport(original, { mode: 'copy', title: '24', kind: 'episode', idFactory: () => 'doc_24' });
    expect(imported.markdown.startsWith('\uFEFF<!-- vibedev:screenwriter\r\n')).toBe(true);
    expect(imported.markdown.endsWith(original.slice(1))).toBe(true);
    expect(parseStoryMarkdown(imported.markdown).metadata?.entities).toEqual([]);
    expect(parseStoryMarkdown(imported.markdown).blocks).toEqual([]);
    expect(prepareStoryImport(original, { mode: 'preserve' }).markdown).toBe(original);
  });

  it('allocates one new identity for all selected versions of an imported asset and keeps provenance', () => {
    const original = parseStoryMarkdown(fixture).metadata!.assets[0]!;
    const source = run(fixture,
      { kind: 'upsertAsset', asset: { ...original, provenance: { source: '手绘', unknown: { text: '保留' } } } },
      { kind: 'upsertAsset', asset: { ...original, versionId: 'v2', sha256: 'b'.repeat(64), provenance: '作者自定出处' } },
      { kind: 'upsertBinding', binding: { ...parseStoryMarkdown(fixture).metadata!.bindings[0]!, id: 'binding_v2', assetVersionId: 'v2', primary: false } },
    );
    const calls: string[] = [];
    let sequence = 0;
    const imported = prepareStoryImport(source, { mode: 'copy', idFactory: (kind) => `${kind}_${++sequence}`, assetIdFactory: (oldId) => { calls.push(oldId); return 'copied_asset'; } });
    const metadata = parseStoryMarkdown(imported.markdown).metadata!;
    expect(calls).toEqual(['asset_a']);
    expect(imported.idMap.asset_a).toBe('copied_asset');
    expect(metadata.assets.map((asset) => [asset.id, asset.versionId, asset.sha256])).toEqual([['copied_asset', 'v1', original.sha256], ['copied_asset', 'v2', 'b'.repeat(64)]]);
    expect(metadata.bindings.map((binding) => [binding.assetId, binding.assetVersionId])).toEqual([['copied_asset', 'v1'], ['copied_asset', 'v2']]);
    expect(metadata.assets[0]?.provenance).toEqual({ source: '手绘', unknown: { text: '保留' }, originAssetId: 'asset_a', originAssetVersionId: 'v1' });
    expect(metadata.assets[1]).toMatchObject({ provenance: '作者自定出处', originAssetId: 'asset_a' });
    expect(projectStoryBody(imported.markdown)).toBe(projectStoryBody(source));
    expect(imported.markdown).toContain('"unknown" : { "sentence" : "不要改写", "spaces": "  " }');
    expect(() => prepareStoryImport(source, { mode: 'copy', idFactory: (kind) => `${kind}_${++sequence}`, assetIdFactory: () => 'person_a' })).toThrow(/不与/);
  });

  it('reading projection removes only semantic comments and cannot be mistaken for full native export', () => {
    const body = projectStoryBody(fixture);
    expect(body).not.toContain('vibedev:screenwriter');
    expect(body).not.toContain('<!-- sw:block');
    expect(body).toContain('<!-- author:voice 不要补动作 -->');
    expect(body).toContain('林岚也是一家店的名字');
    expect(parseStoryMarkdown(body).format).toBe('plain');
    const broken = '正文\n<!-- vibedev:screenwriter\n{"unfinished":';
    expect(projectStoryBody(broken)).toBe(broken);
  });

  it('separates document appearance, scene costume, inherited reference and disabled overrides', () => {
    const source = run(fixture,
      { kind: 'upsertBinding', binding: { ...parseStoryMarkdown(fixture).metadata!.bindings[0]!, id: 'scene_costume', purpose: 'costume', scope: { kind: 'scene', sceneId: 'scene_second' } } },
      { kind: 'upsertRecord', collection: 'referenceOverrides', record: { id: 'no_appearance', target: { kind: 'entity', id: 'person_a' }, scope: { kind: 'scene', sceneId: 'scene_first' }, purpose: 'appearance', mode: 'disabled' } },
    );
    const metadata = parseStoryMarkdown(source).metadata!;
    const references = resolveStoryReferences(metadata, { target: { kind: 'entity', id: 'person_a' }, sceneId: 'scene_second' });
    expect(references.find((item) => item.purpose === 'appearance')).toMatchObject({ source: 'document', inherited: true });
    expect(references.find((item) => item.purpose === 'costume')).toMatchObject({ source: 'scene', inherited: false });
    expect(resolveStoryReferences(metadata, { target: { kind: 'entity', id: 'person_a' }, sceneId: 'scene_first', purpose: 'appearance' })).toEqual([{ purpose: 'appearance', source: 'disabled', inherited: false, bindings: [] }]);
    const changed = run(source, { kind: 'upsertBinding', binding: { ...metadata.bindings[0]!, id: 'second_primary' } });
    const bindings = parseStoryMarkdown(changed).metadata!.bindings;
    expect(bindings.find((binding) => binding.id === 'binding_a')?.primary).toBe(false);
    expect(bindings.find((binding) => binding.id === 'scene_costume')?.primary).toBe(true);
    expect(bindings.find((binding) => binding.id === 'second_primary')?.primary).toBe(true);
  });

  it('treats same asset different versions as distinct selected bytes; rejects unsafe relative paths for I/O', () => {
    const first = parseStoryMarkdown(fixture).metadata!.assets[0]!;
    const next = run(fixture, { kind: 'upsertAsset', asset: { ...first, versionId: 'v2', sha256: 'b'.repeat(64) } });
    expect(parseStoryMarkdown(next).metadata?.assets).toHaveLength(2);
    expect(parseStoryMarkdown(next).metadata?.bindings[0]?.assetVersionId).toBe('v1');
    for (const path of ['../secret', '/absolute', 'C:/private', 'https://remote/image', 'images\\..\\secret', 'a/%2e%2e/b', 'a//b', './image.png', 'a\0.png']) expect(isSafeStoryAssetPath(path)).toBe(false);
    expect(isSafeStoryAssetPath('素材/林岚.png')).toBe(true);
    const unsafe = run(fixture, { kind: 'upsertAsset', asset: { ...first, projectRelativePath: '../private' } });
    expect(parseStoryMarkdown(unsafe).diagnostics.map((item) => item.code)).toContain('unsafe-asset-path');
    expect(unsafe).toContain('../private');
  });
});
