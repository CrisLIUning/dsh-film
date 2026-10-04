// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorMotionClipSource, DirectorObjectMotionClip } from './directorProject.js';

export type MotionClipTiming = Pick<DirectorObjectMotionClip, 'start' | 'end' | 'source'>;

/** A clip is a window into its original route, played over a scene span. */
export function motionClipSource(clip: MotionClipTiming): DirectorMotionClipSource {
  if (clip.source) return clip.source;
  const duration = clip.end - clip.start;
  return { duration, in: 0, out: duration, origin: clip.start };
}

export function validateMotionClipSource(source: DirectorMotionClipSource) {
  if (!source || ![source.duration, source.in, source.out, source.origin].every(Number.isFinite)
    || source.duration <= 0 || source.in < 0 || source.out <= source.in || source.out > source.duration || source.origin < 0) {
    throw new Error('移动片段源范围无效，不能丢弃源信息后打开');
  }
}
export function motionClipRate(clip: MotionClipTiming) {
  const source = motionClipSource(clip);
  return (source.out - source.in) / (clip.end - clip.start);
}
export function motionClipSourceSeconds(clip: MotionClipTiming, seconds: number, clamp = true) {
  const source = motionClipSource(clip);
  const at = source.in + (seconds - clip.start) * motionClipRate(clip);
  return clamp ? Math.min(source.out, Math.max(source.in, at)) : at;
}
export function motionClipSceneSeconds(clip: MotionClipTiming, sourceSeconds: number) {
  return clip.start + (sourceSeconds - motionClipSource(clip).in) / motionClipRate(clip);
}

/** Pointer/arrow bounds shared by camera and full-body action clips. Numeric commands remain strict. */
export function clampTimelineClipBounds(clips: Array<{id:string;start:number;end:number;source:{duration:number;in:number;out:number}}>, clipId: string,
  patch: {start?:number;end?:number}, mode: 'move' | 'trim' | 'stretch'): {start:number;end:number} {
  const index = clips.findIndex(clip => clip.id === clipId);
  const clip = clips[index];
  if (!clip) throw new Error(`运动片段不存在：${clipId}`);
  const lower = clips[index - 1]?.end ?? 0;
  const upper = clips[index + 1]?.start ?? Infinity;
  const rate = (clip.source.out - clip.source.in) / (clip.end - clip.start);
  if (mode === 'move') {
    const start = Math.max(lower, Math.min(upper - (clip.end - clip.start), patch.start ?? clip.start));
    return { start, end: start + clip.end - clip.start };
  }
  const sourceStart = mode === 'trim' ? clip.start - clip.source.in / rate : 0;
  const sourceEnd = mode === 'trim' ? clip.start + (clip.source.duration - clip.source.in) / rate : Infinity;
  const start = patch.start === undefined ? clip.start : Math.max(lower, sourceStart, Math.min(clip.end - .01, patch.start));
  const end = patch.end === undefined ? clip.end : Math.min(upper, sourceEnd, Math.max(start + .01, patch.end));
  return { start, end };
}
