/** The director staging compiler and shot vocabulary. Ported from Studio's apps/daemon/tests/director-staging.test.ts (paths only; async diagnostics awaited). */
import { cameraPath } from './fixtures.js';
import { CAMERA_PATH_TEMPLATES } from '../../src/director/vendor/director-math/schema/cameraPathTemplates.js';
import { compileCameraPreset } from '../../src/director/vendor/director-math/schema/cameraPreset.js';
import { directorStructure, runDirectorQuery, parseDirectorQuery } from '../../src/director/query.js';
import { describe, expect, it } from 'vitest';

import { directorDiagnostics, directorSample } from '../../src/director/query.js';
import { DirectorStageError, parseDirectorStagePlan, stageDirectorScene } from '../../src/director/staging.js';
import { distanceForSpan, resolveOverShoulder, resolveShot, SHOT_SIZE_IDS, SHOT_SIZES } from '../../src/director/vocabulary.js';
import { BODY_PART_HEIGHT, frameObject } from '../../src/director/framing.js';
import { getCameraViewSnapshotFromShot } from '../../src/director/vendor/director-math/schema/cameraGeometry.js';
import { createEmptyDirectorProject } from '../../src/director/vendor/director-math/schema/sceneDefaults.js';
import type { DirectorStagePlan } from '../../src/director/contracts/index.js';
import { character, lockedCamera, project, prop, transform, walk } from './fixtures.js';

/**
 * agent 写:调度词汇 + 编译器。
 *
 * agent 不写坐标,写「谁从哪走到哪、几号机什么景别看谁」;确定性代码负责几何。
 * 词汇可测:一个中景要让腰到头顶正好填满画幅,一个过肩镜头要让前景的肩在
 * 画左、主体在画右 —— 这些都能用画幅几何验。
 */

const plan = (ops: DirectorStagePlan['ops']): DirectorStagePlan => ({ ops });

describe('景别词汇', () => {
  const a = character('甲', [0, 0, 0]);

  it('每个景别让它的身体区间正好填满画幅高度(锁定机位)', () => {
    for (const [size, span] of Object.entries(SHOT_SIZES)) {
      const resolved = resolveShot(a, a.transform, { size: size as never, fov: 40, tracked: false });
      const height = 1.82;
      const expected = distanceForSpan((span.high - span.low) * height, 40);
      expect(resolved.distance, size).toBeCloseTo(expected, 3);
      // 画幅几何反过来验:区间的上下两端都在画里,再高一点就出画。
      const top = [0, span.high * height, 0] as [number, number, number];
      const bottom = [0, span.low * height, 0] as [number, number, number];
      const inside = (point: [number, number, number]) => {
        const result = frameObject(resolved.view, 16 / 9, prop('p', point, [0.01, 0.01, 0.01]), transform(point, [0, 0, 0], [0.01, 0.01, 0.01]));
        return result.framing;
      };
      // The edges themselves sit on the frame line; a hair inside is in, a hair further is out.
      const centre = ((span.high + span.low) / 2) * height;
      const halfSpan = ((span.high - span.low) / 2) * height;
      const nudge = (fraction: number): [number, number, number] => [0, centre + halfSpan * fraction, 0];
      expect(inside(nudge(0.9)), `${size} top`).toBe('full');
      expect(inside(nudge(-0.9)), `${size} bottom`).toBe('full');
      expect(inside(nudge(1.15)), `${size} above`).toBe('out');
      void top; void bottom;
    }
  });

  it('全景把整个人放进画里,特写只剩脸', () => {
    const full = resolveShot(a, a.transform, { size: 'full' });
    expect(frameObject(full.view, 16 / 9, a, a.transform).framing).toBe('full');
    const close = resolveShot(a, a.transform, { size: 'extreme-close' });
    expect(frameObject(close.view, 16 / 9, a, a.transform).framing).toBe('partial');
    expect(close.distance).toBeLessThan(full.distance / 3);
    expect(close.bodyPart).toBe('head');
    expect(full.bodyPart).toBe('center');
  });

  it('side 是相对人物朝向的:正面机位站在她面前,右侧机位站在她右手边', () => {
    // 甲朝 +X(90°)。正面 → 机位在 +X 方向;右侧 → 转 -90° 到 -Z... 按导演台 yaw 的旋转方向。
    const facingX = character('甲', [0, 0, 0], { transform: transform([0, 0, 0], [0, Math.PI / 2, 0]) });
    const front = resolveShot(facingX, facingX.transform, { size: 'medium' });
    expect(front.view.position[0]).toBeGreaterThan(0.5);
    expect(Math.abs(front.view.position[2])).toBeLessThan(0.01);
    const back = resolveShot(facingX, facingX.transform, { size: 'medium', side: 'back' });
    expect(back.view.position[0]).toBeLessThan(-0.5);
    const left = resolveShot(facingX, facingX.transform, { size: 'medium', side: 'left' });
    const right = resolveShot(facingX, facingX.transform, { size: 'medium', side: 'right' });
    expect(Math.sign(left.view.position[2])).toBe(-Math.sign(right.view.position[2]));
    expect(Math.abs(left.view.position[0])).toBeLessThan(0.01);
  });

  it('俯拍从上往下看,仰拍从下往上看,按透视调整距离并保留俯仰角', () => {
    const eye = resolveShot(a, a.transform, { size: 'medium' });
    const high = resolveShot(a, a.transform, { size: 'medium', angle: 'high' });
    const low = resolveShot(a, a.transform, { size: 'medium', angle: 'low' });
    expect(high.view.position[1]).toBeGreaterThan(eye.view.position[1]);
    expect(low.view.position[1]).toBeLessThan(eye.view.position[1]);
    for (const [shot, pitch] of [[high, -22], [low, 16]] as const) {
      const delta = shot.view.target.map((v, i) => v - shot.view.position[i]!);
      expect(Math.atan2(delta[1]!, Math.hypot(delta[0]!, delta[2]!)) * 180 / Math.PI).toBeCloseTo(pitch, 2);
    }
    expect(frameObject(high.view, 16 / 9, a, a.transform).framing).not.toBe('out');
  });

  it('机位存的是 rig,rig 在镜头后面 1.82 单位;导演台从 rig 算回来的视点就是我们要的', () => {
    const resolved = resolveShot(a, a.transform, { size: 'close', side: 'three-quarter-left' });
    const camera = lockedCamera('c', resolved.view.position, resolved.view.target, resolved.view.fov);
    // The same function the desk draws with, on what the compiler would store.
    const view = getCameraViewSnapshotFromShot({ ...camera, transform: transform(resolved.rig) });
    view.position.forEach((value, axis) => expect(value).toBeCloseTo(resolved.view.position[axis]!, 5));
    const rigToLens = Math.hypot(...resolved.rig.map((value, axis) => value - resolved.view.position[axis]!) as [number, number, number]);
    expect(rigToLens).toBeCloseTo(1.82, 2);
  });

  it('过肩:肩在画左时镜头在前景的右肩后,主体在画右并且完整', () => {
    const foreground = character('乙', [0, 0, -1.6], { transform: transform([0, 0, -1.6], [0, 0, 0]) });
    const subject = character('甲', [0, 0, 0], { transform: transform([0, 0, 0], [0, Math.PI, 0]) });
    const shot = resolveOverShoulder(subject, subject.transform, foreground, foreground.transform, { size: 'medium-close' });
    // 乙 faces +Z toward 甲; 乙's right is -X. Camera sits at negative X, behind 乙.
    expect(shot.view.position[0]).toBeLessThan(0);
    expect(shot.view.position[2]).toBeLessThan(-1.6);
    const subjectFraming = frameObject(shot.view, 16 / 9, subject, subject.transform);
    const foregroundFraming = frameObject(shot.view, 16 / 9, foreground, foreground.transform);
    // Subject on the right third, shoulder on the left; both in the frame.
    expect(subjectFraming.screen![0]).toBeGreaterThan(0.15);
    expect(subjectFraming.screen![0]).toBeLessThan(0.6);
    expect(subjectFraming.framing).not.toBe('out');
    expect(foregroundFraming.screen![0]).toBeLessThan(0);
    const mirrored = resolveOverShoulder(subject, subject.transform, foreground, foreground.transform, { size: 'medium-close', shoulder: 'right' });
    expect(frameObject(mirrored.view, 16 / 9, foreground, foreground.transform).screen![0]).toBeGreaterThan(0);
    expect(frameObject(mirrored.view, 16 / 9, subject, subject.transform).screen![0]).toBeLessThan(-0.15);
  });
});

describe('调度计划', () => {
  it('放人、放道具、走路线、摆机位,一份空场景就此有了戏', () => {
    const result = stageDirectorScene(createEmptyDirectorProject(), plan([
      { type: 'place_character', name: '甲', at: [-2, 0], facing: 90 },
      { type: 'place_character', id: '乙', at: [2, 0], facing: { toward: 'char_1' } },
      { type: 'place_prop', name: '桌', at: [0, 0], size: [1.2, 0.8, 0.8] },
      { type: 'move', objectId: 'char_1', start: 0, end: 4, path: [[-2, 0], [-2, 3], [1, 3]], holds: [{ point: 1, seconds: 1, action: 'wave-cycle' }] },
      { type: 'shot', shot: { subject: 'char_1', size: 'medium', side: 'three-quarter-left' }, seconds: 5 },
    ]));

    expect(result.applied.map((item) => [item.type, item.id])).toEqual([
      ['place_character', 'char_1'],
      ['place_character', '乙'],
      ['place_prop', 'prop_1'],
      ['move', 'char_1_clip_1'],
      ['shot', 'cam_1'],
    ]);
    const objects = result.project.objects;
    expect(objects.find((o) => o.id === 'char_1')).toMatchObject({ name: '甲', kind: 'character', bodyType: 'mannequin', characterRig: { rigType: 'ue4-mannequin' } });
    expect(objects.find((o) => o.id === 'char_1')!.transform.rotation[1]).toBeCloseTo(Math.PI / 2, 6);
    // 乙 faces toward 甲 at (-2, 0): that is -X, yaw -90°.
    expect(objects.find((o) => o.id === '乙')!.transform.rotation[1]).toBeCloseTo(-Math.PI / 2, 6);
    expect(objects.find((o) => o.id === 'prop_1')).toMatchObject({ geometryType: 'box', transform: { scale: [1.2, 0.8, 0.8], position: [0, 0, 0] } });
    const clip = objects.find((o) => o.id === 'char_1')!.motionClips![0]!;
    expect(clip).toMatchObject({ id: 'char_1_clip_1', start: 0, end: 4, speedMode: 'uniform', interpolation: 'smooth' });
    expect(clip.keyframes.map((k) => k.time)).toEqual([0, 2, 4]);
    expect(clip.keyframes[1]).toMatchObject({ pointBehavior: 'hold', holdSeconds: 1, holdAction: 'custom', holdActionPresetId: 'wave-cycle' });
    expect(clip.keyframes[0]).toMatchObject({ actionPresetId: 'walk-cycle', facingMode: 'path' });
    expect(clip.keyframes[2]).toMatchObject({ actionPresetId: null });
    const camera = result.project.cameras[0]!;
    expect(camera).toMatchObject({ id: 'cam_1', name: '机位 1', targetMode: 'object', targetObjectId: 'char_1' });
    expect(cameraPath(camera).duration).toBe(5);
    // A medium shot tracks the chest, which a static camera cannot: two identical keyframes carry the body part.
    expect(cameraPath(camera).keyframes.map((k) => [k.time, k.targetBodyPart])).toEqual([[0, 'head'], [1, 'head']]);
    expect(objects.find((o) => o.id === 'cam_1_object')).toMatchObject({ kind: 'camera', linkedCameraId: 'cam_1' });
    expect(result.project.activeCameraId).toBe('cam_1');
    expect(result.cameraIds).toEqual(['cam_1']);
    expect(result.warnings).toEqual([]);
  });

  it('追加,不替换:计划只碰它点名的东西', () => {
    const existing = project(
      [character('老甲', [5, 0, 5], { motionClips: [walk('w', 0, 3, [5, 0, 5], [6, 0, 5])] })],
      [lockedCamera('old', [0, 1.5, 8], [0, 1, 0])],
    );
    const before = JSON.stringify(existing);
    const result = stageDirectorScene(existing, plan([
      { type: 'place_character', name: '新', at: [0, 0] },
      { type: 'shot', shot: { subject: 'char_1', size: 'full' } },
    ]));
    expect(JSON.stringify(existing)).toBe(before);
    expect(result.project.objects.map((o) => o.id)).toEqual(['老甲', 'char_1', 'cam_1_object']);
    expect(result.project.cameras.map((c) => c.id)).toEqual(['old', 'cam_1']);
    expect(result.project.objects[0]!.motionClips).toHaveLength(1);
    expect(result.project.activeCameraId).toBe('old');
  });

  it('同一个 id 再放一次是挪动;同一个 clipId 再走一次是改路线', () => {
    const first = stageDirectorScene(createEmptyDirectorProject(), plan([
      { type: 'place_character', id: 'a', at: [0, 0] },
      { type: 'move', objectId: 'a', clipId: 'walk', start: 0, end: 2, path: [[0, 0], [2, 0]] },
    ]));
    const second = stageDirectorScene(first.project, plan([
      { type: 'place_character', id: 'a', at: [1, 1], facing: 45 },
      { type: 'move', objectId: 'a', clipId: 'walk', start: 0, end: 3, path: [[1, 1], [4, 1]] },
    ]));
    expect(second.project.objects.filter((o) => o.id === 'a')).toHaveLength(1);
    expect(second.project.objects[0]!.transform.position).toEqual([1, 0, 1]);
    expect(second.project.objects[0]!.motionClips).toHaveLength(1);
    expect(second.project.objects[0]!.motionClips![0]).toMatchObject({ id: 'walk', end: 3 });
    expect(second.applied[0]!.summary).toContain('挪动');
    expect(second.applied[1]!.summary).toContain('改走');
  });

  it('一个点的 move 是从对象当时的位置走过去,接在上一段后面', () => {
    const result = stageDirectorScene(createEmptyDirectorProject(), plan([
      { type: 'place_character', id: 'a', at: [0, 0] },
      { type: 'move', objectId: 'a', start: 0, end: 2, path: [[4, 0]] },
      { type: 'move', objectId: 'a', start: 3, end: 5, path: [[4, 4]] },
    ]));
    const clips = result.project.objects[0]!.motionClips!;
    expect(clips[0]!.keyframes.map((k) => k.transform.position)).toEqual([[0, 0, 0], [4, 0, 0]]);
    expect(clips[1]!.keyframes.map((k) => k.transform.position)).toEqual([[4, 0, 0], [4, 0, 4]]);
    expect(result.warnings).toEqual([]);
    // Continuity checks against the whole route: the second clip picks up at (4,0,0).
    const jump = stageDirectorScene(result.project, plan([{ type: 'move', objectId: 'a', start: 6, end: 7, path: [[9, 9], [9, 10]] }]));
    expect(jump.warnings[0]).toContain('跳过去');
  });

  it('警告说清停留太长、片段重叠和最后一点的停留', () => {
    const result = stageDirectorScene(createEmptyDirectorProject(), plan([
      { type: 'place_character', id: 'a', at: [0, 0] },
      { type: 'move', objectId: 'a', start: 0, end: 2, path: [[0, 0], [2, 0], [4, 0]], holds: [{ point: 1, seconds: 3 }, { point: 2, seconds: 1 }] },
      { type: 'move', objectId: 'a', start: 1, end: 3, path: [[4, 0], [6, 0]] },
    ]));
    expect(result.warnings.some((w) => w.includes('最后一点的停留'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('按比例压短'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('重叠'))).toBe(true);
  });

  it('运镜:每个关键帧是那一刻的一个景别,时间按镜头长度归一', () => {
    const result = stageDirectorScene(createEmptyDirectorProject(), plan([
      { type: 'place_character', id: 'a', at: [0, 0] },
      { type: 'move', objectId: 'a', start: 0, end: 4, path: [[0, 0], [0, 6]] },
      { type: 'camera_move', name: '推', seconds: 4, keyframes: [
        { at: 0, shot: { subject: 'a', size: 'full', side: 'front' } },
        { at: 4, shot: { subject: 'a', size: 'close', side: 'front' }, hold: 0.5 },
      ] },
    ]));
    const camera = result.project.cameras[0]!;
    expect(cameraPath(camera)).toMatchObject({ duration: 4, speedMode: 'custom' });
    const [start, end] = cameraPath(camera).keyframes;
    expect([start!.time, end!.time]).toEqual([0, 1]);
    // 甲 walks to (0, 6) by 4s; the close-up at 4s sits in front of her there, nearer than the full shot at 0s.
    expect(end!.position[2]).toBeGreaterThan(6);
    expect(Math.hypot(end!.position[0], end!.position[2] - 6)).toBeLessThan(Math.hypot(start!.position[0], start!.position[2]));
    expect(end).toMatchObject({ targetMode: 'object', targetObjectId: 'a', targetBodyPart: 'head', pointBehavior: 'hold', holdSeconds: 0.5 });
  });

  it('跟随:机位沿主体的路线保持同一种取景', () => {
    const result = stageDirectorScene(createEmptyDirectorProject(), plan([
      { type: 'place_character', id: 'a', at: [0, 0], facing: 0 },
      { type: 'move', objectId: 'a', start: 0, end: 4, path: [[0, 0], [0, 8]] },
      { type: 'follow', shot: { subject: 'a', size: 'medium', side: 'front' }, every: 1 },
    ]));
    const camera = result.project.cameras[0]!;
    expect(cameraPath(camera).duration).toBe(6);
    const keyframes = cameraPath(camera).keyframes;
    expect(keyframes.length).toBeGreaterThanOrEqual(7);
    // Front of a character walking +Z: the lens stays ahead of her, at a constant distance, all the way.
    const distances = keyframes.map((k) => Math.hypot(k.position[0] - k.target[0], k.position[2] - k.target[2]));
    for (const d of distances) expect(d).toBeCloseTo(distances[0]!, 3);
    expect(keyframes[keyframes.length - 1]!.position[2]).toBeGreaterThan(8);
    // 4 秒后主体停在 (0, 8);跟随机位在那之后也停在同一个相对位置,人在画面正中。
    const frame = directorSample(result.project, { kind: 'sample', at: [5] }).frames[0]!;
    const framed = frame.cameras[0]!.framing.find((f) => f.objectId === 'a')!;
    expect(framed.framing).not.toBe('out');
    expect(Math.abs(framed.screen![0])).toBeLessThan(0.05);
  });

  it('remove 拿走对象和机位,并提醒还在跟拍它的机位', () => {
    const staged = stageDirectorScene(createEmptyDirectorProject(), plan([
      { type: 'place_character', id: 'a', at: [0, 0] },
      { type: 'place_character', id: 'b', at: [2, 0] },
      { type: 'shot', cameraId: 'c1', shot: { subject: 'a', size: 'full' } },
      { type: 'shot', cameraId: 'c2', shot: { subject: 'b', size: 'full' }, active: true },
    ]));
    const result = stageDirectorScene(staged.project, plan([
      { type: 'remove', objectId: 'a' },
      { type: 'remove', cameraId: 'c2' },
    ]));
    expect(result.project.objects.map((o) => o.id)).toEqual(['b', 'c1_object']);
    expect(result.project.cameras.map((c) => c.id)).toEqual(['c1']);
    expect(result.project.activeCameraId).toBe('c1');
    expect(result.warnings[0]).toContain('在跟拍');
  });

  it('拒绝说不通的计划,并说是第几步、哪里不对', () => {
    const bad: Array<[unknown, string]> = [
      [{ ops: [] }, '空的'],
      [{ ops: [{ type: 'teleport' }] }, '第 1 步'],
      [{ ops: [{ type: 'place_character', at: [1] }] }, 'at'],
      [{ ops: [{ type: 'move', objectId: 'a', start: 2, end: 1, path: [[0, 0]] }] }, 'end'],
      [{ ops: [{ type: 'shot', shot: { subject: 'a', size: 'huge' } }] }, 'size'],
      [{ ops: [{ type: 'shot', shot: { subject: 'a', size: 'full', side: 'above' } }] }, 'side'],
      [{ ops: [{ type: 'camera_move', keyframes: [{ at: 0, shot: { subject: 'a', size: 'full' } }] }] }, '两个'],
    ];
    for (const [value, fragment] of bad) {
      expect(() => parseDirectorStagePlan(value), JSON.stringify(value)).toThrow(fragment);
    }
    expect(() => stageDirectorScene(createEmptyDirectorProject(), plan([{ type: 'shot', shot: { subject: 'ghost', size: 'full' } }])))
      .toThrow(DirectorStageError);
    expect(() => stageDirectorScene(createEmptyDirectorProject(), plan([{ type: 'move', objectId: 'ghost', start: 0, end: 1, path: [[1, 1]] }])))
      .toThrow('第 1 步');
  });
});

describe('验收:一个过肩镜头', () => {
  it('两人先到位,再过肩;查询层确认主体从头到尾在画里', async () => {
    const result = stageDirectorScene(createEmptyDirectorProject(), plan([
      { type: 'place_character', id: '甲', at: [0, 0], facing: 0 },
      { type: 'place_character', id: '乙', at: [0, 1.8], facing: 180 },
      { type: 'shot', name: '过肩', shot: { subject: '甲', size: 'medium-close', over: '乙' }, seconds: 4 },
    ]));
    const camera = result.project.cameras[0]!;
    const diagnostics = (await directorDiagnostics(result.project, { kind: 'diagnostics', cameraIds: [camera.id] }));
    expect(diagnostics.findings.filter((f) => f.code === 'subject-out-of-frame' && f.objectId === '甲')).toEqual([]);
    const opening = directorSample(result.project, { kind: 'sample', at: [0, 2, 4] });
    for (const frame of opening.frames) {
      const view = frame.cameras[0]!;
      const subject = view.framing.find((f) => f.objectId === '甲')!;
      expect(subject.framing).not.toBe('out');
      expect(subject.screen![0]).toBeGreaterThan(0.15);
      expect(view.framing.find((f) => f.objectId === '乙')!.screen![0]).toBeLessThan(0);
    }
    // Composed off-centre on purpose, so it is locked off: tracking would re-centre 甲.
    expect(camera.targetMode).toBe('manual');
    // What the desk draws for this camera is what the compiler meant: same function, same rig.
    const desk = getCameraViewSnapshotFromShot(camera);
    expect(desk.target).toEqual(camera.target);
    expect(desk.fov).toBe(camera.fov);
    expect(diagnostics.findings.find((f) => f.code === 'screen-order')?.objectIds).toEqual(['乙', '甲']);
  });
});

describe('跟拍时的构图', () => {
  // 导演台跟拍是把镜头对准骨骼的一个关节,关节就成了画面中心,不管景别想把
  // 什么放在中心。所以关节要选,画幅要放宽到整个区间都装得下。中近景对准胸口
  // 关节时,头在画外 —— 这是在导演台里看到的,不是推出来的。
  const a = character('a', [0, 0, 0]);

  it('每个景别都跟最省画幅的那个关节:紧的跟头,中全景跟胸,宽的跟身体中心', () => {
    const parts = Object.fromEntries(SHOT_SIZE_IDS.map((size) => [size, resolveShot(a, a.transform, { size, fov: 40 }).bodyPart]));
    expect(parts).toEqual({
      'extreme-close': 'head',
      close: 'head',
      'medium-close': 'head',
      medium: 'head',
      'medium-full': 'chest',
      full: 'center',
      wide: 'center',
      'extreme-wide': 'center',
    });
  });

  it('跟拍的画幅装得下景别的整个区间,头一定在画里', () => {
    for (const size of SHOT_SIZE_IDS) {
      const span = SHOT_SIZES[size];
      const resolved = resolveShot(a, a.transform, { size, fov: 40 });
      const height = 1.82;
      // 镜头对准的是关节的高度。
      const joint = resolved.bodyPart === 'center' ? null : BODY_PART_HEIGHT[resolved.bodyPart as 'head' | 'chest' | 'waist'];
      if (joint !== null) expect(resolved.view.target[1], size).toBeCloseTo(joint * height, 6);
      const inside = (y: number) => frameObject(resolved.view, 16 / 9, prop('p', [0, y, 0], [0.01, 0.01, 0.01]), transform([0, y, 0], [0, 0, 0], [0.01, 0.01, 0.01])).framing;
      // The size's own span, probed just inside its two ends, as the locked-off spec does.
      const nominalCentre = ((span.high + span.low) / 2) * height;
      const nominalHalf = ((span.high - span.low) / 2) * height;
      expect(inside(nominalCentre + nominalHalf * 0.9), `${size} top`).toBe('full');
      expect(inside(nominalCentre - nominalHalf * 0.9), `${size} bottom`).toBe('full');
      // 比锁定时远一点是代价;但不会远过区间自己的两倍。
      const locked = resolveShot(a, a.transform, { size, fov: 40, tracked: false });
      expect(resolved.distance, size).toBeGreaterThanOrEqual(locked.distance - 1e-9);
      // Widest for the extreme close-up, whose whole span sits above the head joint: exactly twice.
      expect(resolved.distance, size).toBeLessThanOrEqual(locked.distance * 2 + 1e-3);
      expect(frameObject(resolved.view, 16 / 9, a, a.transform).head, size).toBe('in');
    }
  });
});

describe('batch base transforms', () => {
  it('shares the desk edit semantics and leaves routes unchanged', () => {
    const a = character('a', [1,2,3]);
    const b = prop('b', [4,5,6], [1,2,3]);
    const scene = project([a,b], []);
    const parsed = parseDirectorStagePlan({ ops: [{ type: 'transform_objects', objectIds: ['a','b'], position: { y: 0 }, scale: { z: 2 } }] });
    const result = stageDirectorScene(scene, parsed);
    expect(result.project.objects.map(o => o.transform.position)).toEqual([[1,0,3],[4,0,6]]);
    expect(result.project.objects[1]!.transform.scale).toEqual([1,2,2]);
    expect(scene.objects[0]!.transform.position).toEqual([1,2,3]);
    expect(result.applied.map(o => o.id)).toEqual(['a','b']);
  });
  it.each([
    { objectIds: [], position: { x: 1 } },
    { objectIds: ['a'], position: { x: '1' } },
    { objectIds: ['a'], position: { q: 1 } },
    { objectIds: ['a'], scale: { x: 0 } },
    { objectIds: ['a'] },
  ])('rejects an invalid batch %j', input => {
    expect(() => parseDirectorStagePlan({ ops: [{ type: 'transform_objects', ...input }] })).toThrow(DirectorStageError);
  });
});

describe('project asset placement', () => {
  const asset = { id:'asset_1', name:'Actor', fileName:'actor.glb', kind:'character' as const, sourceType:'model' as const, url:'/actor.glb', characterRigProfile:'mixamo' as const };
  it('reuses an asset, initializes the character rig, and places in scene metres without moving old objects', () => {
    const base = { ...project([character('old',[1,0,0])],[],{groundHeight:2}), assets:[asset] };
    const result = stageDirectorScene(base,parseDirectorStagePlan({ops:[{type:'place_asset',assetId:asset.id,at:[3,-2],id:'new_actor'}]}));
    expect(result.project.assets).toBe(base.assets);
    expect(result.project.objects[0]).toBe(base.objects[0]);
    expect(result.project.objects[1]).toMatchObject({id:'new_actor',assetRefId:asset.id,characterRig:{rigType:'mixamo'},transform:{position:[3,2,-2]}});
    expect(base.objects).toHaveLength(1);
    expect(result.applied).toMatchObject([{id:'new_actor',type:'place_asset'}]);
  });
  it('refuses missing assets, an existing object ID, panorama and malformed coordinates', () => {
    const base={...project([character('old',[0,0,0])],[]),assets:[asset]};
    for(const op of [{type:'place_asset',assetId:'missing',at:[0,0]},{type:'place_asset',assetId:asset.id,id:'old',at:[0,0]}]){
      expect(()=>stageDirectorScene(base,parseDirectorStagePlan({ops:[op]}))).toThrow(DirectorStageError);
    }
    expect(()=>parseDirectorStagePlan({ops:[{type:'place_asset',assetId:asset.id,at:[NaN,0]}]})).toThrow(DirectorStageError);
    expect(()=>stageDirectorScene({...base,assets:[{...asset,kind:'panorama'}]},parseDirectorStagePlan({ops:[{type:'place_asset',assetId:asset.id,at:[0,0]}]}))).toThrow(DirectorStageError);
    expect(base.objects).toHaveLength(1);
  });
});


it('scene rehearsal ranges validate and clear through the same staging plan without retiming paths', () => {
  const before = project([character('actor',[0,0,0])], [lockedCamera('cam',[0,2,8],[0,1,0])]);
  const result = stageDirectorScene(before, parseDirectorStagePlan({ ops: [{ type: 'set_scene_time', duration: 20, loop: true, loopRange: { start: 8, end: 12 } }] }));
  expect(result.project.timeline).toEqual({ duration: 20, loop: true, loopRange: { start: 8, end: 12 } });
  expect(result.project.cameras).toEqual(before.cameras);
  expect(result.project.objects).toEqual(before.objects);
  const cleared = stageDirectorScene(result.project, parseDirectorStagePlan({ ops: [{ type: 'set_scene_time', loopRange: null, duration: 10 }] }));
  expect(cleared.project.timeline).toEqual({ duration: 10, loop: true });
  for (const loopRange of [true, [], {start:2}, {start:4,end:3}, {start:-1,end:2}, {start:1,end:'2'}]) {
    expect(() => parseDirectorStagePlan({ ops: [{ type:'set_scene_time', loopRange }] })).toThrow();
  }
  expect(() => stageDirectorScene(before, parseDirectorStagePlan({ops:[{type:'set_scene_time',loopRange:{start:8,end:99}}]}))).toThrow('循环区间');
});

it('edits existing motion clips without rebuilding their curves or changing action phase', () => {
  const actor = character('actor',[0,0,0],{motionClips:[walk('walk',2,10,[0,0,0],[8,0,0])]});
  const original=project([actor],[]);
  const output=stageDirectorScene(original,parseDirectorStagePlan({ops:[
    {type:'edit_motion_clip',objectId:'actor',clipId:'walk',action:'trim',start:4,end:8},
    {type:'edit_motion_clip',objectId:'actor',clipId:'walk',action:'split',at:6,id:'tail'},
    {type:'edit_motion_clip',objectId:'actor',clipId:'tail',action:'duplicate',start:14,id:'copy'},
  ]})).project;
  const sampled=directorSample(output,{kind:'sample',at:[5,7,15]});
  const baseline=directorSample(original,{kind:'sample',at:[5,7,7]});
  expect(sampled.frames.map(frame=>frame.objects[0]!.position)).toEqual(baseline.frames.map(frame=>frame.objects[0]!.position));
  const object=output.objects[0]!;
  expect(object.motionClips).toHaveLength(3);
  expect(object.motionClips![2]).toMatchObject({id:'copy',start:14,end:16,source:{duration:8,in:4,out:6,origin:2}});
  const unchanged=JSON.stringify(output);
  expect(()=>stageDirectorScene(output,parseDirectorStagePlan({ops:[{type:'edit_motion_clip',objectId:'actor',clipId:'copy',action:'trim',end:30}]}))).toThrow();
  expect(JSON.stringify(output)).toBe(unchanged);
});


describe('shared camera presets', () => {
  it('compiles exactly the desk recipe, preserves unrelated scene content and lists credits', async () => {
    const scene = project([character('actor', [0, 0, 0], { motionClips: [walk('w', 0, 10, [0,0,0], [10,0,0])] })], [lockedCamera('cam', [0,2,8], [0,1,0])]);
    const before = JSON.stringify(scene);
    const parsed = parseDirectorStagePlan({ops:[{type:'camera_preset',cameraId:'cam',presetId:'follow',duration:4,targetObjectId:'actor'}]});
    const result = stageDirectorScene(scene, parsed);
    const expected = compileCameraPreset(scene, {cameraId:'cam',presetId:'follow',duration:4,targetObjectId:'actor'});
    expect(cameraPath(result.project.cameras[0]!)).toEqual(expected);
    expect(expected.keyframes.at(-1)!.target[0]).toBeCloseTo(4, 4);
    expect(JSON.stringify(scene)).toBe(before);
    expect(result.project.objects).toEqual(scene.objects);
    expect(result.cameraIds).toEqual(['cam']);
    expect(directorStructure(result.project).cameraPresets).toBeUndefined();
    expect((await runDirectorQuery(result.project, parseDirectorQuery({kind:'structure',includeCameraPresets:true})))).toHaveProperty('cameraPresets',CAMERA_PATH_TEMPLATES);
    expect(() => stageDirectorScene(result.project, parsed)).toThrow(/replaceExisting/);
    const replace = parseDirectorStagePlan({ops:[{type:'camera_preset',cameraId:'cam',presetId:'pan-in-place-left',replaceExisting:true}]});
    const keys = cameraPath(stageDirectorScene(result.project, replace).project.cameras[0]!).keyframes;
    expect(new Set(keys.map(key=>key.position.join(','))).size).toBe(1);
    expect(keys[0]!.target).not.toEqual(keys.at(-1)!.target);
  });
});


describe('ranged camera preset staging',()=>{
  it('creates a named visible camera atomically, returns addressable ids and reserves them for later operations',()=>{
    const scene=createEmptyDirectorProject();
    const before=JSON.stringify(scene);
    const op={type:'camera_preset_clip',cameraName:'门口镜头',presetId:'push-in',start:6,end:10};
    const result=stageDirectorScene(scene,parseDirectorStagePlan({ops:[op]}));
    const camera=result.project.cameras[0]!;
    expect(result.applied[0]).toMatchObject({type:'camera_preset_clip',cameraId:camera.id,clipId:camera.motionClips[0]!.id});
    expect(result.project.objects[0]).toMatchObject({linkedCameraId:camera.id,visible:true});
    expect(result.project.timeline.duration).toBe(10);
    expect(()=>stageDirectorScene(scene,parseDirectorStagePlan({ops:[op,{type:'place_character',id:camera.id,at:[0,0]}]}))).toThrow(/已存在|重复|id/i);
    expect(()=>stageDirectorScene(scene,parseDirectorStagePlan({ops:[op,{type:'place_prop',id:camera.id,at:[0,0]}]}))).toThrow(/ID 已存在/);
    const continued=stageDirectorScene(result.project,parseDirectorStagePlan({ops:[{type:'place_character',id:'actor',at:[0,0]},{type:'shot',cameraId:camera.id,shot:{subject:'actor',size:'medium'}}]}));
    expect(continued.project.objects.filter(object=>object.linkedCameraId===camera.id)).toHaveLength(1);
    expect(continued.project.objects.find(object=>object.linkedCameraId===camera.id)!.id).toBe(result.project.objects[0]!.id);
    expect(JSON.stringify(scene)).toBe(before);
  });
  it('keeps other curves through replacement, rejects locks and never returns partially applied plans',()=>{
    const initial=project([], [lockedCamera('cam',[0,2,8],[0,1,0])]);
    const scene=stageDirectorScene(initial,parseDirectorStagePlan({ops:[
      {type:'camera_preset_clip',cameraId:'cam',clipId:'first',presetId:'push-in',start:0,end:4},
      {type:'camera_preset_clip',cameraId:'cam',clipId:'second',presetId:'pull-out',start:10,end:14},
    ]})).project;
    const before=JSON.stringify(scene);
    const op={type:'camera_preset_clip',cameraId:'cam',replaceClipId:'second',presetId:'truck-left',start:10,end:16};
    const result=stageDirectorScene(scene,parseDirectorStagePlan({ops:[op]}));
    expect(result.project.cameras[0]!.motionClips[0]).toEqual(scene.cameras[0]!.motionClips[0]);
    expect(result.project.cameras[0]!.motionClips[1]).toMatchObject({id:'second',start:10,end:16});
    expect(()=>stageDirectorScene(scene,parseDirectorStagePlan({ops:[op,{...op,replaceClipId:undefined,start:3,end:8}]}))).toThrow(/重叠/);
    expect(JSON.stringify(scene)).toBe(before);
    scene.objects.push({id:'cam_obj',kind:'camera',name:'locked',visible:true,locked:true,linkedCameraId:'cam',transform:transform([0,0,0])});
    expect(()=>stageDirectorScene(scene,parseDirectorStagePlan({ops:[op]}))).toThrow(/锁定/);
  });
});


it('stages a camera ground stroke with height and scene timing, preserving neighbours',()=>{
  const original=project([], [lockedCamera('cam',[0,2,8],[0,1,0])]);
  const scene=stageDirectorScene(original,parseDirectorStagePlan({ops:[{type:'camera_preset_clip',cameraId:'cam',clipId:'first',presetId:'push-in',start:0,end:4}]})).project;
  const command={type:'camera_stroke',cameraId:'cam',start:6,end:10,height:1.7,aim:'direction',samples:[{point:[0,0],time:0},{point:[2,0],time:1},{point:[2,3],time:2}]};
  const before=JSON.stringify(scene),result=stageDirectorScene(scene,parseDirectorStagePlan({ops:[command]}));
  expect(result.project.cameras[0]!.motionClips[0]).toEqual(scene.cameras[0]!.motionClips[0]);
  expect(result.project.cameras[0]!.motionClips[1]!.path.keyframes.map(key=>key.position)).toEqual(expect.arrayContaining([[0,1.7,0],[2,1.7,0],[2,1.7,3]]));
  expect(result.applied[0]).toMatchObject({type:'camera_stroke',cameraId:'cam'});expect(JSON.stringify(scene)).toBe(before);
  expect(()=>stageDirectorScene(scene,parseDirectorStagePlan({ops:[{...command,start:2}]}))).toThrow(/重叠/);
});

it('preserves imported rigs and heights during placement, and honours locks',()=>{
  const actor=character('actor',[0,0,0]);actor.assetRefId='soldier';actor.characterRig!.rigType='mixamo';actor.heightMetres=1.64;
  const scene=project([actor],[]),op=parseDirectorStagePlan({ops:[{type:'place_character',id:'actor',at:[2,3]}]});
  const moved=stageDirectorScene(scene,op).project.objects[0]!;
  expect(moved.characterRig).toEqual(actor.characterRig);expect(moved.heightMetres).toBe(1.64);expect(moved.assetRefId).toBe('soldier');
  expect(moved.transform.position).toEqual([2,0,3]);
  actor.locked=true;expect(()=>stageDirectorScene(scene,op)).toThrow(/锁定/);
});


it('object_stroke uses shared uniform sampling through the public plan compiler',()=>{
  const scene=project([character('actor',[0,0,0])],[]);
  const op={type:'object_stroke',objectId:'actor',start:2,end:8,samples:[{position:[0,0,0],time:0},{position:[.1,0,0],time:2},{position:[6,0,0],time:3}]};
  const before=JSON.stringify(scene);
  const compiled=stageDirectorScene(scene,parseDirectorStagePlan({ops:[op]}));
  const clip=compiled.project.objects[0]!.motionClips![0]!;
  expect(clip.keyframes).toHaveLength(13);expect(clip).toMatchObject({start:2,end:8,speedMode:'uniform',interpolation:'linear'});
  expect(clip.keyframes[6]!.time).toBe(3);expect(clip.keyframes[6]!.transform.position).toEqual([3,0,0]);
  expect(compiled.applied[0]).toMatchObject({type:'object_stroke',objectId:'actor',clipId:clip.id});
  expect(JSON.stringify(scene)).toBe(before);
  expect(()=>parseDirectorStagePlan({ops:[{...op,pace:'invalid'}]})).toThrow(/pace/);
});
