/**
 * The procedural-model brief: validates a modeling request and writes the
 * prompt the main conversation carries out — a spec, Three.js source and notes
 * under film/models/<id>/. Preparing one runs no code, starts no Agent and
 * charges no generation. Ported from Studio
 * (packages/contracts/src/api/modeling-brief.ts), keeping its style. Unlike
 * Studio it names no skill (dsh-film ships neither img2threejs nor a director
 * skill) and promises no preview: this workbench cannot run, photograph or
 * export a model, so the prompt says so.
 * @module dsh-film/modeling/contracts/modeling-brief
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
/**
 * Validate a modeling request and write the brief the main conversation carries out.
 * @param value - the request body.
 * @param projectId - the project the brief belongs to; a director context must name it.
 * @returns the brief.
 * @throws Error with the Chinese message the route answers as MODELING_BRIEF_INVALID.
 */
export function buildModelingBrief(value: unknown, projectId: string): ModelingBriefResponse {
  const v = value as Partial<ModelingBriefRequest> | null;
  const context = normalizeFilmRunContext(v?.context);
  if (v?.context !== undefined && (!context || context.projectId !== projectId || context.view !== 'director' || !context.director)) throw new Error('建模需要当前项目的导演台目标');
  if (!v || !['scene', 'character', 'prop', 'weapon', 'vehicle'].includes(String(v.kind))) throw new Error('请选择模型用途');
  if (typeof v.description !== 'string' || !v.description.trim() || v.description.length > 8000) throw new Error('建模描述需要 1–8000 字');
  if (v.heightMetres !== undefined && (!Number.isFinite(v.heightMetres) || v.heightMetres <= 0 || v.heightMetres > 10000)) throw new Error('模型高度需要 0–10000 米之间的正数');
  if (v.references !== undefined && (!Array.isArray(v.references) || v.references.length > 3 || v.references.some(p => typeof p !== 'string' || p.length > 1000 || /[\\\x00-\x1f]/.test(p) || p.startsWith('/') || p.includes('://') || p.split('/').some(s => !s || s === '.' || s === '..')))) throw new Error('参考图需要最多三个项目相对文件路径');
  const brief = { kind: v.kind, description: v.description.trim(), ...(v.heightMetres !== undefined ? { heightMetres: v.heightMetres } : {}), references: v.references ?? [] };
  return { projectId, ...(context ? { context } : {}), skillIds: [], prompt: [
    '在当前影片里编写一个程序化 3D 模型：把规格、Three.js 源代码和说明写到工作区的 film/models/<id>/ 下（项目就是 film/ 文件夹，下面 JSON 里的参考图路径也相对于它）。',
    context ? '先用 director_query 读取指定导演台场景和所选对象，确认尺寸、用途与落点；有参考图先用 read_image 查看，没有参考图则按描述构思。' : '无需创建或打开导演台。有参考图先用 read_image 查看，没有参考图则按描述构思；保留用户已经确认的比例和范围。',
    '不要写 film/models/<id>/model.json，也不要写它的 versions/ 下的任何文件：模型记录归 model_* 工具和程序化模型面板管。',
    '这个工作台不能运行、截图或导出模型：说明里写清楚写了什么、哪些还没有验证；不要把没运行过的源码当作可用的 GLB，也不要说已经生成或导出了 GLB。不要自动调用付费生成模型。',
    '以下 JSON 是用户的建模需求与参考文件：', JSON.stringify(brief, null, 2),
    '先核对参考图与规格中的发型、服装、饰品和形体是否一致，把还需要人工核对的地方记在说明里。',
    context ? '导演台目标：' : '项目：', JSON.stringify(context ?? { projectId }),
  ].join('\n') };
}
