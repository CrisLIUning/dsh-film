/**
 * The img2threejs modeling brief the desk's 建模 button and the modeling
 * tools prepare. Copied from Studio's packages/contracts/src/api/modeling-brief.ts.
 * @module dsh-film/director/contracts/modeling-brief
 */

import { normalizeFilmRunContext, type FilmRunContext } from './film-context.js';

export interface ModelingBriefRequest {
  kind: 'scene' | 'character' | 'prop' | 'weapon' | 'vehicle';
  description: string;
  heightMetres?: number;
  references?: string[];
  context?: FilmRunContext;
}
export interface ModelingBriefResponse { projectId: string; prompt: string; context?: FilmRunContext; skillIds: string[] }
export function buildModelingBrief(value: unknown, projectId: string): ModelingBriefResponse {
  const v = value as Partial<ModelingBriefRequest> | null;
  const context = normalizeFilmRunContext(v?.context);
  if (v?.context !== undefined && (!context || context.projectId !== projectId || context.view !== 'director' || !context.director)) throw new Error('建模需要当前项目的导演台目标');
  if (!v || !['scene', 'character', 'prop', 'weapon', 'vehicle'].includes(String(v.kind))) throw new Error('请选择模型用途');
  if (typeof v.description !== 'string' || !v.description.trim() || v.description.length > 8000) throw new Error('建模描述需要 1–8000 字');
  if (v.heightMetres !== undefined && (!Number.isFinite(v.heightMetres) || v.heightMetres <= 0 || v.heightMetres > 10000)) throw new Error('模型高度需要 0–10000 米之间的正数');
  if (v.references !== undefined && (!Array.isArray(v.references) || v.references.length > 3 || v.references.some(p => typeof p !== 'string' || p.length > 1000 || /[\\\x00-\x1f]/.test(p) || p.startsWith('/') || p.includes('://') || p.split('/').some(s => !s || s === '.' || s === '..')))) throw new Error('参考图需要最多三个项目相对文件路径');
  const brief = { kind: v.kind, description: v.description.trim(), ...(v.heightMetres !== undefined ? { heightMetres: v.heightMetres } : {}), references: v.references ?? [] };
  return { projectId, ...(context ? { context } : {}), skillIds: context ? ['director', 'img2threejs'] : ['img2threejs'], prompt: [
    '请使用 img2threejs 技能，在当前项目制作程序化 3D 模型，并在独立建模预览中逐层展示。',
    context ? '先读取指定导演台场景和所选对象，确认尺寸、用途与落点；有参考图先查看，没有参考图则按描述构思。' : '无需创建或打开导演台。有参考图先查看，没有参考图则按描述构思；保留用户已经确认的比例和范围。',
    '将规格、Three.js 源代码、检查结果和可用的预览保存到项目 models/ 下。遵守分阶段检查，说明已经运行与尚未验证的部分。不要把未执行代码当作可用 GLB，不要自动调用付费生成模型。',
    '以下 JSON 是用户的建模需求与参考文件：', JSON.stringify(brief, null, 2),
    '先核对参考图与规格中的发型、服装、饰品和形体是否一致；粗模、细化、视觉待验收分别报告。每轮截图对照参考、记录具体缺陷、修正源码并重跑；导出成功不代表造型完成。',
    context ? '可选导演台目标：' : '项目：', JSON.stringify(context ?? { projectId }),
  ].join('\n') };
}
