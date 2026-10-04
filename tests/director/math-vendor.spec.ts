/** The vendored director math: pinned by hash, recomputing the desk's golden samples. Ported from Studio's apps/daemon/tests/director-math-vendor.test.ts (paths only; async diagnostics awaited). */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { getCameraMotionPath } from '../../src/director/vendor/director-math/schema/cameraMotion.js';
import { getCameraPlaybackSnapshot, getCameraPlaybackAtSeconds } from '../../src/director/vendor/director-math/schema/cameraPlayback.js';
import { getAnimatedCameraFocusSample, getDirectorObjectFocusTarget } from '../../src/director/vendor/director-math/schema/cameraTarget.js';
import { upgradeDirectorProject } from '../../src/director/vendor/director-math/schema/directorProjectMigration.js';
import {
  getObjectMotionActionSample,
  getObjectMotionClipSpans,
  getObjectMotionClipTimingPlan,
  getObjectMotionSnapshot,
} from '../../src/director/vendor/director-math/schema/objectMotion.js';

/**
 * daemon 手里那份导演台运动数学,必须和导演台算出同样的数。
 *
 * agent 要在导演台没开着的时候回答「t 秒时人物在哪、机位看着谁」。答案来自
 * 一份从导演台仓 vendor 过来的拷贝;拷贝一旦悄悄漂移,两边就会各说各话,而且
 * 谁也说不清哪边错了。所以两道锁:manifest 钉住每个文件的哈希,golden 钉住
 * 计算结果 —— golden 是在导演台里跑出来的,这里只负责复算。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = path.resolve(here, '../../src/director/vendor/director-math');
const manifest = JSON.parse(readFileSync(path.resolve(here, '../../src/director/vendor/director-math.manifest.json'), 'utf8')) as {
  sourceCommit: string | null;
  files: Record<string, { source: string; vendored: string }>;
};

interface Clip { id: string; start: number; end: number; speedMode?: string; keyframes: Array<Record<string, unknown>> }
interface FixtureObject { id: string; motionClips?: Clip[]; [key: string]: unknown }

const golden = JSON.parse(readFileSync(path.join(here, 'fixtures/golden.json'), 'utf8')) as {
  project: { scene: unknown; objects: FixtureObject[]; cameras: Array<Record<string, unknown>> };
  duration: number;
  focusTargets: Record<string, [number, number, number]>;
  samples: Array<{
    t: number;
    objects: Record<string, unknown>;
    actions: Record<string, unknown>;
    cameras: Record<string, unknown>;
    focus: unknown;
  }>;
};

/** 导演台在片段模型落地之前,用旧采样器录下的一份版本 1 工程和它的每一帧。 */
const v1 = JSON.parse(readFileSync(path.join(here, 'fixtures/v1-golden.json'), 'utf8')) as {
  duration: number;
  project: { version: 1; objects: Array<Record<string, unknown>>; cameras: Array<Record<string, unknown>>; scene: unknown; activeCameraId: string };
  plans: Record<string, { arrivals: number[]; departures: number[] } | null>;
  samples: Array<{
    t: number;
    objects: Record<string, {
      transform: { position: number[]; rotation: number[]; scale: number[] };
      action: { actionPresetId: string | null; animationTimeSeconds: number; holdingPointIndex: number | null };
    }>;
    cameraA: { fov: number; position: number[]; target: number[] };
  }>;
};

const sha256 = (text: string) => createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');

function expectClose(actual: number[], expected: number[], digits = 9) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, digits));
}

describe('vendored 拷贝钉在 manifest 上', () => {
  it('记录了来源提交', () => {
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('每个文件的哈希与 manifest 一致 —— 手改拷贝会在这里被抓住', () => {
    const targets = Object.keys(manifest.files);
    expect(targets.length).toBeGreaterThan(10);
    expect(targets).toContain('schema/directorProjectMigration.ts');
    for (const target of targets) {
      const onDisk = sha256(readFileSync(path.join(vendorRoot, target), 'utf8'));
      expect(`${target}: ${onDisk}`).toBe(`${target}: ${manifest.files[target]!.vendored}`);
    }
  });

  it('拷贝里没有 Vite 或浏览器才有的东西', () => {
    for (const target of Object.keys(manifest.files)) {
      const source = ts.createSourceFile(target, readFileSync(path.join(vendorRoot, target), 'utf8'), ts.ScriptTarget.Latest, true);
      const forbidden: string[] = [];
      const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
          && ts.isStringLiteral(node.moduleSpecifier) && /^(three|react(?:-dom)?)(\/|$)/.test(node.moduleSpecifier.text)) {
          forbidden.push(node.moduleSpecifier.text);
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          const base = node.expression;
          if (ts.isIdentifier(base) && (base.text === 'window' || base.text === 'document')) forbidden.push(node.getText(source));
          const key = ts.isPropertyAccessExpression(node) ? node.name.text
            : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
          if (ts.isMetaProperty(base) && base.keywordToken === ts.SyntaxKind.ImportKeyword && key === 'env') forbidden.push(node.getText(source));
        }
        ts.forEachChild(node, visit);
      };
      // Parse actual code: prose such as "source window." is not a browser access.
      visit(source);
      expect(forbidden, target).toEqual([]);
    }
  });
});

describe('复算导演台的 golden', () => {
  const { objects, cameras, scene } = golden.project;
  const trackPath = getCameraMotionPath(cameras[0] as never);

  it('fixture 覆盖了要紧的分支,不是一个空场景', () => {
    // 一份被掏空的 fixture 让下面的比对全部空转。这里钉住它必须练到的路径。
    const [char1, char2] = objects;
    const route = char1!.motionClips![0]!;
    expect(route.keyframes.some((k) => k.pointBehavior === 'hold')).toBe(true);
    expect(route.keyframes.some((k) => k.facingMode === 'path')).toBe(true);
    // 第二个人物的路线是两段,中间有空档:片段之间「停在上一段终点」这条规则要练到。
    expect(char2!.motionClips).toHaveLength(2);
    expect(char2!.motionClips![1]!.start).toBeGreaterThan(char2!.motionClips![0]!.end);
    expect(char2!.motionClips!.map((clip) => clip.speedMode)).toEqual(['uniform', 'custom']);
    const cam = cameras[0] as { motionPath: { keyframes: Array<Record<string, unknown>> } };
    expect(cam.motionPath.keyframes.some((k) => k.targetFollowMode === 'smooth')).toBe(true);
    expect((scene as { pathCollisionEnabled: boolean }).pathCollisionEnabled).toBe(true);
    expect(trackPath.duration).toBe(golden.duration);
    expect(golden.samples.length).toBeGreaterThanOrEqual(9);
    // 采样点里必须有落在空档里的、落在第二段里的,否则那两条规则没被复算到。
    const gapStart = char2!.motionClips![0]!.end;
    const secondStart = char2!.motionClips![1]!.start;
    expect(golden.samples.some((s) => s.t * golden.duration > gapStart && s.t * golden.duration < secondStart)).toBe(true);
    expect(golden.samples.some((s) => s.t * golden.duration > secondStart)).toBe(true);
  });

  it('对象的聚焦点逐个相同', () => {
    for (const object of objects) {
      expect(getDirectorObjectFocusTarget(object as never)).toEqual(golden.focusTargets[object.id]);
    }
  });

  it('每个采样时刻,每个对象的位置、朝向与动作相同 —— 按场景秒数问,不带镜头', () => {
    for (const sample of golden.samples) {
      const seconds = sample.t * golden.duration;
      for (const object of objects) {
        const ours = getObjectMotionSnapshot(object as never, seconds);
        expect({ t: sample.t, id: object.id, ours }).toEqual({ t: sample.t, id: object.id, ours: sample.objects[object.id] });
        const action = getObjectMotionActionSample(object as never, seconds);
        expect({ t: sample.t, id: object.id, action }).toEqual({ t: sample.t, id: object.id, action: sample.actions[object.id] });
      }
    }
  });

  it('每个采样时刻,每个机位的位置、看向与焦段相同(含跟拍与碰撞约束)', () => {
    for (const sample of golden.samples) {
      for (const camera of cameras) {
        const ours = getCameraPlaybackSnapshot(camera as never, objects as never, sample.t, scene as never);
        expect({ t: sample.t, id: camera.id, ours }).toEqual({ t: sample.t, id: camera.id, ours: sample.cameras[camera.id as string] });
      }
    }
  });

  it('跟拍焦点的混合结果相同', () => {
    for (const sample of golden.samples) {
      const ours = getAnimatedCameraFocusSample(cameras[0] as never, objects as never, sample.t);
      expect({ t: sample.t, ours }).toEqual({ t: sample.t, ours: sample.focus });
    }
  });
});

describe('daemon 打开导演台升级前存下的工程', () => {
  // 板子节点的 metadata 里躺着的是版本 1 的工程。daemon 用同一份迁移把它带到
  // 现在的形状,再用现在的采样器算,得到的必须是导演台当年播出来的那些帧。
  const upgraded = upgradeDirectorProject(v1.project as never) as unknown as { objects: FixtureObject[]; cameras: unknown[]; scene: unknown; version: number };
  const byId = new Map(upgraded.objects.map((object) => [object.id, object]));

  it('版本变成 2,每条路线变成一个铺满当时活动镜头时长的片段', () => {
    expect(upgraded.version).toBe(15);
    for (const object of v1.project.objects) {
      const clips = byId.get(object.id as string)!.motionClips;
      if (!object.motionPath) {
        expect(clips).toBeUndefined();
        continue;
      }
      expect(clips).toHaveLength(1);
      expect(clips![0]).toMatchObject({ start: 0, end: v1.duration });
    }
  });

  it('逐帧一致:位置、朝向、动作、活动机位所见', () => {
    for (const sample of v1.samples) {
      const seconds = sample.t * v1.duration;
      for (const [id, recorded] of Object.entries(sample.objects)) {
        const object = byId.get(id)!;
        const transform = getObjectMotionSnapshot(object as never, seconds);
        expectClose(transform.position, recorded.transform.position);
        expectClose(transform.rotation, recorded.transform.rotation);
        expectClose(transform.scale, recorded.transform.scale);
        const action = getObjectMotionActionSample(object as never, seconds);
        expect({ t: sample.t, id, action: action.actionPresetId, holding: action.holdingPointIndex })
          .toEqual({ t: sample.t, id, action: recorded.action.actionPresetId, holding: recorded.action.holdingPointIndex });
        expect(action.animationTimeSeconds).toBeCloseTo(recorded.action.animationTimeSeconds, 9);
      }
      const cameraA = getCameraPlaybackAtSeconds(upgraded.cameras[0] as never, upgraded.objects as never, seconds, upgraded.scene as never);
      expect(cameraA.fov).toBeCloseTo(sample.cameraA.fov, 9);
      expectClose(cameraA.position, sample.cameraA.position);
      expectClose(cameraA.target, sample.cameraA.target);
    }
  });

  it('到点与离点的时刻不变', () => {
    for (const [id, plan] of Object.entries(v1.plans)) {
      const clip = byId.get(id)!.motionClips?.[0];
      if (!plan) {
        expect(clip ? getObjectMotionClipTimingPlan(clip as never) : null).toBeNull();
        continue;
      }
      const spans = getObjectMotionClipSpans(clip as never);
      expectClose(spans.arrivals.map((seconds) => seconds / v1.duration), plan.arrivals);
      expectClose(spans.departures.map((seconds) => seconds / v1.duration), plan.departures);
    }
  });
});
