import type { StoryEntity, StoryMetadata } from './types.js';

export const STORY_PRODUCTION_PURPOSES = ['image', 'character-sheet', 'scene-sheet', 'prop-sheet', 'shot'] as const;
export type StoryProductionPurpose = typeof STORY_PRODUCTION_PURPOSES[number];

/** Shared by handoff and prompt assistance. The model supplies prose, never identities. */
export function storyProductionInstruction(purpose: StoryProductionPurpose, surface: 'image' | 'video' = 'image'): string {
  const common = '遵循所连参考的项目风格、视觉身份和本场状态；已有设定优先。未确定的细节作为本次视觉提案，不冒充剧本事实，不擅自改变人物关系或情节。';
  const task: Record<StoryProductionPurpose, string> = {
    image: '生成一张主体清晰、可作后续参考的制作图。',
    'character-sheet': '生成一张完整角色设定卡。主体为同一角色的正面、侧面、背面全身视图，辅以贴合剧情的表情、服装配件、关键细节和材质色板。所有栏目保持脸型、年龄感、发型、体型和辨识特征一致；只改变本次明确指定的状态。设定集式分栏、克制的细线和清晰视觉层级，顶部保留角色名，信息区仅写已知档案。版面清晰、留白充分，以人物可辨识和一致性优先，避免无依据的小字档案。不要拆成多次生成，也不要改成单幅人物海报。',
    'scene-sheet': '生成一张完整场景设定卡。包含建立镜头、同一空间的多个观察方向、门窗与固定陈设关系、关键道具和材质光线细节。保持出入口、空间拓扑和视觉地标一致。仅在参考明确要求时展示不同天气或时间状态。电影美术设定集式版面，主建立镜头最大、辅助机位和材质细节分区清晰，标题简洁、留白充分。不要拼成多个不同地点或单幅风景海报。',
    'prop-sheet': '生成一张道具设定卡，包含同一道具的主要视角、结构细节、材质色板和剧情所需使用状态，尺寸关系与标志细节一致。',
    shot: '生成一张分镜画面，遵循当前镜头的动作、人物位置、构图与场景关系，使用本场角色造型及相关主参考。不要把角色设定卡的多个视角复制进画面。',
  };
  const direction = surface === 'video'
    ? '生成一段分镜视频，按当前镜头组织动作、人物位置、机位运动与声音；遵循剧本中的说话人、对白原文、画内／画外关系及反应顺序。依据本次时长安排表演，不把整场剧本默认塞进一个镜头。参考中的设定卡排版要求不适用于成片。'
    : task[purpose];
  return `${direction}\n${common}`;
}

export function storyEntityProductionText(entity: StoryEntity, metadata: StoryMetadata, sceneId?: string): string {
  const states = sceneId ? metadata.appearances.filter(item => item.entityId === entity.id && item.sceneId === sceneId && typeof item.visualState === 'string').map(item => item.visualState as string) : [];
  return [
    typeof entity.visualIdentity === 'string' && entity.visualIdentity.trim() ? `基础视觉身份：${entity.visualIdentity.trim()}` : '',
    typeof entity.visualState === 'string' && entity.visualState.trim() ? `基础造型／陈设：${entity.visualState.trim()}` : '',
    ...states.filter(text => text.trim()).map(text => `本场变化（其余身份保持）：${text.trim()}`),
  ].filter(Boolean).join('\n');
}
