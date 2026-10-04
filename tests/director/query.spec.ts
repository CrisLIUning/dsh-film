/** Director scene queries against the desk's golden samples. Ported from Studio's apps/daemon/tests/director-query.test.ts (paths only; async diagnostics awaited). */
import { readFileSync } from 'node:fs';
import { BODY_PART_HEIGHT, characterHeight, approximateBodyPartFocus } from '../../src/director/framing.js';
import { getCameraTemporalPlaybackAtSeconds } from '../../src/director/vendor/director-math/schema/cameraTemporalPlayback.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DIRECTOR_QUERY_MAX_SAMPLES,
  DirectorQueryError,
  directorSample,
  directorStructure,
  parseDirectorQuery,
  resolveDirectorProject,
  runDirectorQuery,
} from '../../src/director/query.js';
import { frameObject, projectToScreen } from '../../src/director/framing.js';
import { constrainObjectMotionTransform } from '../../src/director/vendor/director-math/schema/pathCollision.js';
import { shotSeconds } from '../../src/director/scene.js';
import { character, lockedCamera, project, transform, walk } from './fixtures.js';

/**
 * 导演要的是可查询的状态,不是一张图。
 *
 * 这一层在 daemon 里回答「场景里有谁、t 秒时每个人在哪、哪台机位看着谁」,
 * 导演台不用开着。数字来自导演台 vendor 过来的同一份数学,所以采样必须和
 * 导演台播放到同一时刻的结果相同 —— golden 就是导演台自己算出来的。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.join(here, 'fixtures/golden.json'), 'utf8')) as {
  project: Record<string, unknown>;
  duration: number;
  samples: Array<{
    t: number;
    objects: Record<string, { position: number[]; rotation: number[]; scale: number[] }>;
    cameras: Record<string, { position: number[]; target: number[]; fov: number }>;
  }>;
};
const v1 = JSON.parse(readFileSync(path.join(here, 'fixtures/v1-golden.json'), 'utf8')) as {
  project: Record<string, unknown>;
};

const goldenProject = resolveDirectorProject(golden.project)!;

describe('读:结构', () => {
  const structure = directorStructure(goldenProject);

  it('报对象、机位和路线片段,不倾倒整份工程', () => {
    // 对象只有三个:机位的辅助对象不算场景里的东西。
    expect(structure.objects.map((object) => object.id)).toEqual(['char_1', 'char_2', 'wall']);
    expect(structure.objects[0]).toMatchObject({ kind: 'character', bodyType: 'mannequin', height: 1.82, yaw: 0 });
    expect(structure.objects[0]!.clips).toEqual([
      { id: 'char_1_clip_1', start: 0, end: 8, points: 3, holds: 1, source: {duration:8,in:0,out:8,origin:0},rate:1,visiblePoints:3, arrivals: [0, 3.012, 8] },
    ]);
    expect(structure.objects[1]!.clips.map((clip) => [clip.start, clip.end])).toEqual([[1, 3], [5, 7.5]]);
    expect(structure.objects[2]!.clips).toEqual([]);
    // 紧凑:一份结构里没有关键帧的变换,也没有工程里的资产细节。
    const text = JSON.stringify(structure);
    expect(text).not.toContain('"keyframes"');
    // Height provenance is useful query data, not a raw project dump.
    expect(text.length).toBeLessThan(JSON.stringify(golden.project).length * .6);
  });

  it('把每台机位当一条镜头:多长、几帧、开场看哪、跟过谁', () => {
    expect(structure.timeline).toEqual({ seconds: 8, activeCameraId: 'cam_track', loop: false });
    const [track, still] = structure.cameras;
    expect(track).toMatchObject({ id: 'cam_track', seconds: 8, keyframeCount: 3, active: true, fov: 35 });
    expect(track!.subject).toEqual({ objectId: 'char_1', bodyPart: 'head' });
    expect(track!.subjects).toEqual([
      { objectId: 'char_1', bodyPart: 'head' },
      { objectId: 'char_2', bodyPart: 'chest' },
    ]);
    expect(track!.view.position).toEqual([-2, 1.6, 12]);
    // 静止机位:默认镜头长度,没有关键帧,跟拍来自它的 target。
    expect(still).toMatchObject({ id: 'cam_static', seconds: 6, keyframeCount: 0, active: false });
    expect(still!.subject).toEqual({ objectId: 'char_2', bodyPart: 'center' });
    expect(structure.scene).toEqual({ collision: true, groundHeight: 0 });
  });
});

describe('读:时刻采样', () => {
  it('每个对象的位置与导演台播放到同一时刻的结果相同', () => {
    // golden 记的是原始运动采样;导演台画出来的是过了碰撞的位置,查询层报的也是。
    for (const sample of golden.samples) {
      const seconds = sample.t * golden.duration;
      const frame = directorSample(goldenProject, { kind: 'sample', at: [seconds] }).frames[0]!;
      for (const object of goldenProject.objects) {
        const recorded = sample.objects[object.id]!;
        const expected = constrainObjectMotionTransform(
          object,
          { position: recorded.position as never, rotation: recorded.rotation as never, scale: recorded.scale as never },
          goldenProject.scene,
          goldenProject.objects,
        );
        const ours = frame.objects.find((item) => item.id === object.id)!;
        expect({ t: sample.t, id: object.id, position: ours.position }).toEqual({ t: sample.t, id: object.id, position: expected.position });
      }
    }
  });

  it('镜头曲线保留黄金结果，按同源时间公式查询近似人物目标', () => {
    // golden 里每台机位记的是导演台把它播到进度 t 的样子;在查询层那是这台机位
    // 自己镜头上的 t × 时长那一秒。跟拍机位 8 秒,换算精确;静止机位走默认 6 秒,
    // 换算会差在最后几位,所以按 12 位小数比。
    for (const sample of golden.samples) {
      for (const camera of goldenProject.cameras) {
        const seconds = sample.t * shotSeconds(camera);
        const frame = directorSample(goldenProject, { kind: 'sample', at: [seconds] }).frames[0]!;
        const recorded = sample.cameras[camera.id]!;
        const ours = frame.cameras.find((item) => item.id === camera.id)!;
        expect(ours.fov).toBe(recorded.fov);
        ours.position.forEach((value, axis) => expect(value).toBeCloseTo(recorded.position[axis]!, 12));
        // The original golden is raw authoring math, before render-time damping.
        // Keep its route/projection checks, and compare damped targets to the
        // desk's time sampler. director-temporal-query checks the analytic result.
        if (camera.motionClips.some(clip => clip.path.keyframes.some(key => key.targetFollowMode === 'smooth' || key.targetStabilizationEnabled))) {
          const expected = getCameraTemporalPlaybackAtSeconds(camera, goldenProject.objects, seconds, goldenProject.scene, approximateBodyPartFocus);
          expect(ours.target).toEqual(expected.target);
          continue;
        }
        // The golden was recorded by the desk's math without a rig, which aims
        // every tracked part at the body's centre. Query uses an explicit
        // standing-body approximation, not the rig's animated joints: a tracked
        // head or chest has an estimated height above the feet and centre x/z.
        const part = ours.subject?.bodyPart;
        const joint = part === 'head' || part === 'chest' || part === 'waist' ? BODY_PART_HEIGHT[part] : null;
        if (joint === null) {
          ours.target.forEach((value, axis) => expect(value).toBeCloseTo(recorded.target[axis]!, 12));
        } else {
          // Between two keyframes that track different parts the aim is on its
          // way from one joint to the other, so what holds is the band: above
          // the centre the golden recorded, no higher than the head joint.
          const subject = frame.objects.find((item) => item.id === ours.subject!.objectId)!;
          const standing = characterHeight(goldenProject.objects.find((item) => item.id === subject.id)!);
          expect(ours.target[0]).toBeCloseTo(recorded.target[0]!, 12);
          expect(ours.target[2]).toBeCloseTo(recorded.target[2]!, 12);
          expect(ours.target[1]).toBeGreaterThan(recorded.target[1]!);
          expect(ours.target[1]).toBeLessThanOrEqual(subject.position[1] + BODY_PART_HEIGHT.head * standing + 1e-6);
          void joint;
        }
      }
    }
  });

  it('说清每个人在做什么、在走还是停、在哪一段里', () => {
    const at4 = directorSample(goldenProject, { kind: 'sample', at: [4] }).frames[0]!;
    const char1 = at4.objects.find((item) => item.id === 'char_1')!;
    // 3.012 秒到第二点后停 1.2 秒:4 秒时正停在那里,站着。
    expect(char1).toMatchObject({ moving: false, holding: 1, action: null, clipId: 'char_1_clip_1' });
    const char2 = at4.objects.find((item) => item.id === 'char_2')!;
    // 两段之间的空档:站在第一段的终点,做自己的动作,不属于任何片段。
    expect(char2).toMatchObject({ position: [3, 0, 2], moving: false, action: 'idle', clipId: null });
    const at6 = directorSample(goldenProject, { kind: 'sample', at: [6] }).frames[0]!;
    expect(at6.objects.find((item) => item.id === 'char_2')).toMatchObject({ moving: true, action: 'walk-cycle', clipId: 'char_2_out' });
  });

  it('机位报它在自己镜头里走到哪、跟着谁、谁在画里', () => {
    const at4 = directorSample(goldenProject, { kind: 'sample', at: [4] }).frames[0]!;
    const track = at4.cameras.find((item) => item.id === 'cam_track')!;
    expect(track).toMatchObject({ progress: 0.5, ended: false, subject: { objectId: 'char_2', bodyPart: 'chest' } });
    const framing = Object.fromEntries(track.framing.map((item) => [item.objectId, item.framing]));
    expect(framing).toMatchObject({ char_1: 'full', char_2: 'full' });
    // 画里从左到右排好,x 在 -1..1 之间。
    const xs = track.framing.map((item) => item.screen![0]);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(xs.every((x) => Math.abs(x) <= 1)).toBe(true);
    // 过了镜头长度:进度停在 1,并说明已结束。
    const at7 = directorSample(goldenProject, { kind: 'sample', at: [7] }).frames[0]!;
    expect(at7.cameras.find((item) => item.id === 'cam_static')).toMatchObject({ progress: 1, ended: true });
    expect(at7.cameras.find((item) => item.id === 'cam_track')).toMatchObject({ ended: false });
  });
});

describe('画幅几何', () => {
  const view = { position: [0, 1.5, 5] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 50 };
  const aspect = 16 / 9;

  it('镜头正前方站着的人完整在画里,画面中央', () => {
    const result = frameObject(view, aspect, character('a', [0, 0, 0]), transform([0, 0, 0]));
    expect(result.framing).toBe('full');
    expect(Math.abs(result.screen![0])).toBeLessThan(0.01);
    expect(result.distance).toBeCloseTo(5, 1);
  });

  it('左边的人在画面左边,右边的在右边', () => {
    const left = frameObject(view, aspect, character('a', [-1, 0, 0]), transform([-1, 0, 0]));
    const right = frameObject(view, aspect, character('b', [1, 0, 0]), transform([1, 0, 0]));
    expect(left.screen![0]).toBeLessThan(0);
    expect(right.screen![0]).toBeGreaterThan(0);
  });

  it('远在画外的人不在画里;身后的人也不在,而且没有画面坐标', () => {
    expect(frameObject(view, aspect, character('a', [20, 0, 0]), transform([20, 0, 0])).framing).toBe('out');
    const behind = frameObject(view, aspect, character('a', [0, 0, 10]), transform([0, 0, 10]));
    expect(behind).toEqual({ framing: 'out', screen: null, distance: null, head: 'out' });
    expect(projectToScreen(view, aspect, [0, 1, 10])).toBeNull();
  });

  it('贴得太近,脚出了画,是半身', () => {
    const close = { ...view, position: [0, 1.5, 1] as [number, number, number] };
    expect(frameObject(close, aspect, character('a', [0, 0, 0]), transform([0, 0, 0])).framing).toBe('partial');
  });

  it('画幅越宽,画边上的人越容易进画', () => {
    const edge = character('a', [3.2, 0, 0]);
    expect(frameObject(view, 1, edge, edge.transform).framing).toBe('out');
    expect(frameObject(view, 2.4, edge, edge.transform).framing).toBe('full');
  });
});

describe('问题本身', () => {
  it('接受三种问法,at 可以是一个数', () => {
    expect(parseDirectorQuery({ kind: 'structure' })).toEqual({ kind: 'structure' });
    expect(parseDirectorQuery({ kind: 'sample', at: 2 })).toEqual({ kind: 'sample', at: [2] });
    expect(parseDirectorQuery({ kind: 'sample', at: [0, 1.5], aspect: 1 })).toEqual({ kind: 'sample', at: [0, 1.5], aspect: 1 });
    expect(parseDirectorQuery({ kind: 'diagnostics', cameraIds: ['a'], step: 0.5 })).toEqual({ kind: 'diagnostics', cameraIds: ['a'], step: 0.5 });
  });

  it('拒绝说不通的问题,并说明原因', () => {
    for (const bad of [
      null,
      { kind: 'render' },
      { kind: 'sample' },
      { kind: 'sample', at: [-1] },
      { kind: 'sample', at: ['1'] },
      { kind: 'sample', at: Array.from({ length: DIRECTOR_QUERY_MAX_SAMPLES + 1 }, () => 0) },
      { kind: 'diagnostics', step: 0 },
      { kind: 'diagnostics', cameraIds: 'a' },
      { kind: 'structure', aspect: -1 },
    ]) {
      expect(() => parseDirectorQuery(bad), JSON.stringify(bad)).toThrow(DirectorQueryError);
    }
  });

  it('认得裸工程、旧版本工程和两种信封;认不得的给 null', () => {
    expect(resolveDirectorProject(golden.project)?.version).toBe(15);
    const upgraded = resolveDirectorProject(v1.project)!;
    expect(upgraded.version).toBe(15);
    expect(upgraded.objects.find((object) => object.id === 'char_1')?.motionClips).toHaveLength(1);
    expect(resolveDirectorProject({ format: '3d-director-desk-project', schemaVersion: 1, project: v1.project })?.version).toBe(15);
    expect(resolveDirectorProject({ projectSchemaVersion: 2, project: golden.project })?.version).toBe(15);
    expect(resolveDirectorProject({ hello: 'world' })).toBeNull();
    expect(resolveDirectorProject(null)).toBeNull();
  });

  it('一个没有 groundHeight 的旧场景也能采样,人物不会掉到 NaN', async () => {
    const legacy = project([character('a', [0, 0, 0], { motionClips: [walk('w', 0, 4, [0, 0, 0], [4, 0, 0])] })], [lockedCamera('c', [0, 1.5, 6], [0, 1, 0])]);
    delete (legacy.scene as { groundHeight?: number }).groundHeight;
    const frame = ((await runDirectorQuery(legacy, { kind: 'sample', at: [2] })) as { frames: Array<{ objects: Array<{ position: number[] }> }> }).frames[0]!;
    expect(frame.objects[0]!.position).toEqual([2, 0, 0]);
  });
});

it('lists reusable assets including unused models, and relates placed instances without exposing URLs', () => {
  const placed={...character('actor',[0,0,0]),assetRefId:'asset_1'};
  const base={...project([placed],[]),assets:[
    {id:'asset_1',name:'Actor',fileName:'actor.glb',url:'https://private.invalid/actor.glb',kind:'character' as const,sourceType:'model' as const},
    {id:'asset_2',fileName:'table.glb',url:'/table.glb',kind:'prop' as const,sourceType:'model' as const},
  ]};
  const result=directorStructure(base);
  expect(result.assets).toEqual([{id:'asset_1',name:'Actor',fileName:'actor.glb',kind:'character',scaleMode:'character',instances:['actor']},{id:'asset_2',name:'table.glb',fileName:'table.glb',kind:'prop',scaleMode:'legacy-fit',instances:[]}]);
  expect(JSON.stringify(result.assets)).not.toContain('private.invalid');
});


it('samples independent full-body actions while keeping world travel and source phase separate', () => {
  const actor = character('actor', [0, 0, 0], {
    motionClips: [walk('walk', 0, 6, [0, 0, 0], [6, 0, 0])],
    actionClips: [
      { id: 'greet', start: 1, end: 3, actionId: 'wave-cycle', loop: false,
        source: { duration: 4, in: 1, out: 3 } },
      { id: 'pose', start: 3, end: 4, actionId: null, source: { duration: 1, in: 0, out: 1 } },
    ],
  });
  const scene = project([actor], []);
  const samples = directorSample(scene, { kind: 'sample', at: [2, 3.5, 5, 2] }).frames;
  expect(samples[0]!.objects[0]).toMatchObject({ action: 'wave-cycle', moving: true, clipId: 'walk',
    performance: { actionClipId: 'greet', source: 'clip', animationTimeSeconds: 2, loop: false } });
  expect(samples[1]!.objects[0]).toMatchObject({ action: null, moving: true,
    performance: { actionClipId: 'pose', source: 'clip', animationTimeSeconds: 0.5 } });
  expect(samples[2]!.objects[0]).toMatchObject({ action: 'walk-cycle', performance: { actionClipId: null } });
  expect(samples[3]).toEqual(samples[0]);
  const legacy = project([{ ...actor, actionClips: [] }], []);
  const before = directorSample(legacy, { kind: 'sample', at: [2, 3.5, 5, 2] }).frames;
  samples.forEach((frame, i) => expect(frame.objects[0]!.position).toEqual(before[i]!.objects[0]!.position));
});
