import { isJsonObject } from './json-cst.js';
import { StoryOperationError } from './errors.js';
import { parseStoryMarkdown, storyBlockTitle, STORY_REFERENCE_KINDS, StoryObjectTargetSchema } from './parser.js';
import type { StoryCollection, StoryDeletionPreview, StoryObjectTarget, StoryRecord } from './types.js';

export const STORY_OBJECT_COLLECTIONS = { entity: 'entities', scene: 'scenes', shot: 'shots' } as const;
export function storyObjectBlockIds(record: StoryRecord, kind: StoryObjectTarget['kind']): string[] {
  if (kind === 'entity') return [record.profileBlockId as string];
  if (kind === 'shot') return [record.descriptionBlockId as string];
  return [...record.blockIds as string[]];
}

/** Incoming object links block deletion. Links to the retained body are listed
 * as informational. Unknown extension values and prose are never ID guesses. */
export function inspectStoryObjectDeletion(source: string, target: StoryObjectTarget): StoryDeletionPreview {
  if (!StoryObjectTargetSchema.safeParse(target).success) throw new StoryOperationError('invalid-object-target', '请选择人物、地点、道具、场次或镜头的稳定身份。');
  const parsed = parseStoryMarkdown(source);
  if (!parsed.metadata || !parsed.semanticEditable) throw new StoryOperationError('story-not-editable', '请先解决稿件结构诊断。', parsed.diagnostics);
  const metadata = parsed.metadata;
  const object = metadata[STORY_OBJECT_COLLECTIONS[target.kind]].find((item) => item.id === target.id);
  if (!object) throw new StoryOperationError('missing-object', '要检查的对象不存在。');
  const blockIds = storyObjectBlockIds(object, target.kind);
  const dependencies: StoryDeletionPreview['dependencies'] = [];
  const collections: StoryCollection[] = ['entities', 'scenes', 'shots', 'bindings', 'referenceOverrides', 'speech', 'appearances', 'beats', 'relationships', 'claims'];
  for (const collection of collections) for (const item of metadata[collection]) {
    if (collection === STORY_OBJECT_COLLECTIONS[target.kind] && item.id === target.id) continue;
    const ownedBlocks = collection === 'entities' ? [item.profileBlockId as string] : collection === 'scenes' ? item.blockIds as string[] : collection === 'shots' ? [item.descriptionBlockId as string] : typeof item.blockId === 'string' ? [item.blockId] : [];
    const add = (path: string, blocksDeletion: boolean) => dependencies.push({ collection, id: item.id, path, blockIds: ownedBlocks, blocksDeletion });
    const inspect = (value: unknown, prefix = '') => {
      if (!isJsonObject(value)) return;
      for (const [key, member] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const values = Array.isArray(member) ? member : [member];
        if (Object.hasOwn(STORY_REFERENCE_KINDS, key)) {
          if (STORY_REFERENCE_KINDS[key] === target.kind && values.includes(target.id)) add(path, true);
          if (STORY_REFERENCE_KINDS[key] === 'block' && values.some((id) => typeof id === 'string' && blockIds.includes(id))) add(path, false);
        } else if (['evidence', 'scope', 'state'].includes(key)) inspect(member, path);
        else if (key === 'target' && isJsonObject(member) && member.kind === target.kind && member.id === target.id) add(`${path}.id`, true);
      }
    };
    inspect(item);
  }
  return { target: { ...target }, title: storyBlockTitle(parsed.blocks.find((block) => block.id === blockIds[0])), archived: object.archived === true, blockIds, dependencies, canDelete: !dependencies.some((item) => item.blocksDeletion) };
}
