/**
 * Checking the bytes behind a model or motion import before a scene refers to
 * them: the uploaded film file must exist inside the film, have the declared
 * format, size and SHA-256. Ported from Studio's
 * apps/daemon/src/director/asset-source.ts; Studio's project-id check is the
 * caller's here (the file's project must be the film).
 * @module dsh-film/director/asset-source
 */

import path from 'node:path';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DirectorStageError } from './staging.js';

/**
 * HTTP relinking verifies the uploaded bytes, never a caller's digest alone.
 * @param directory - the film folder (`<workspace>/film`).
 * @param relative - the file's film-relative path.
 * @param source - what the op declares about it.
 * @param op - the op's index, for the refusal.
 */
export async function verifyDirectorAssetSource(directory: string, relative: string,
  source: { contentSha256: string; byteLength: number; modelFormat: string }, op: number): Promise<void> {
  try {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..') || /[?#\0]/.test(relative)) throw new Error('素材路径无效');
    if (path.extname(relative).toLowerCase() !== `.${source.modelFormat}`) throw new Error('项目文件格式与重新关联的格式不一致');
    const root = await realpath(directory), file = await realpath(path.resolve(root, relative));
    const inside = path.relative(root, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('文件必须位于项目目录中');
    const info = await stat(file);
    if (!info.isFile() || info.size !== source.byteLength) throw new Error('文件大小与重新关联的声明不一致');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    if (digest.digest('hex') !== source.contentSha256) throw new Error('项目文件内容与 SHA256 不一致，请重新上传原文件');
  } catch (error) {
    throw new DirectorStageError(error instanceof Error ? `原文件校验失败：${error.message}` : '无法读取原文件', op);
  }
}
