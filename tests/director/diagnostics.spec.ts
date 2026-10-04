/** Director diagnostics: each check fires on the fault and stays quiet without it. Ported from Studio's apps/daemon/tests/director-diagnostics.test.ts (paths only; async diagnostics awaited). */
import { describe, expect, it } from 'vitest';

import { directorDiagnostics } from '../../src/director/query.js';
import {
  arrivalFindings,
  axisFindings,
  intervals,
  routeBlockedFindings,
  screenOrderFindings,
  subjectFramingFindings,
  timeGrid,
} from '../../src/director/diagnostics.js';
import { openQueryScene } from '../../src/director/scene.js';
import { character, lockedCamera, project, prop, walk } from './fixtures.js';

/**
 * 派生诊断:导演知识,不是存在场景里的字段。
 *
 * 每一条都要有一个正例和一个反例。会误报的诊断是噪音,agent 学会忽略它之后
 * 就等于没有;从不触发的诊断是注释。
 */

const options = { step: 0.1, aspect: 16 / 9 };

describe('谁出画', () => {
  it('人物走出锁定机位的画面时报出区间,回到画里就停', async () => {
    // 6 秒镜头,fov 40 在 6 米外半宽约 3.9 米;人物 0–4 秒从 0 走到 8,越过画边后再也没回来。
    const walker = character('甲', [0, 0, 0], { motionClips: [walk('w', 0, 4, [0, 0, 0], [8, 0, 0])] });
    const scene = openQueryScene(project([walker], [lockedCamera('wide', [0, 1.5, 6], [0, 1, 0], 40)]));

    const findings = (await subjectFramingFindings(scene, scene.cameras[0]!, options));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'subject-out-of-frame', severity: 'warning', cameraId: 'wide', objectId: '甲', to: 6 });
    expect(findings[0]!.from).toBeGreaterThan(1.5);
    expect(findings[0]!.from).toBeLessThan(2.5);
    expect(findings[0]!.message).toContain('看不到「甲」');
  });

  it('一直在画里的人物不报', async () => {
    const walker = character('甲', [-2, 0, 0], { motionClips: [walk('w', 0, 4, [-2, 0, 0], [2, 0, 0])] });
    const scene = openQueryScene(project([walker], [lockedCamera('wide', [0, 1.5, 6], [0, 1, 0], 40)]));
    expect((await subjectFramingFindings(scene, scene.cameras[0]!, options))).toEqual([]);
  });

  it('从头到尾都不在这台机位里的人不报:他本来就不在这个镜头里', async () => {
    const elsewhere = character('乙', [40, 0, 0]);
    const scene = openQueryScene(project([elsewhere], [lockedCamera('wide', [0, 1.5, 6], [0, 1, 0], 40)]));
    expect((await subjectFramingFindings(scene, scene.cameras[0]!, options))).toEqual([]);
  });

  it('机位在跟别人时,旁人出画只是提示;跟拍对象本人出画才是警告', async () => {
    const walker = character('甲', [0, 0, 0], { motionClips: [walk('w', 0, 4, [0, 0, 0], [8, 0, 0])] });
    const lead = character('乙', [-1, 0, 0]);
    const tracking = lockedCamera('close', [0, 1.5, 6], [-1, 1, 0], 40, { targetMode: 'object', targetObjectId: '乙' });
    const scene = openQueryScene(project([walker, lead], [tracking]));

    const findings = (await subjectFramingFindings(scene, scene.cameras[0]!, options));

    expect(findings.map((finding) => [finding.objectId, finding.severity])).toEqual([['甲', 'info']]);
  });
});

describe('越轴', () => {
  const left = character('甲', [-1, 0, 0]);
  const right = character('乙', [1, 0, 0]);

  it('两台机位在两人连线两侧:警告,并说清各自谁左谁右', () => {
    const front = lockedCamera('front', [0, 1.5, 5], [0, 1, 0]);
    const back = lockedCamera('back', [0, 1.5, -5], [0, 1, 0]);
    const scene = openQueryScene(project([left, right], [front, back]));

    const findings = axisFindings(scene, scene.cameras, options);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'axis-crossed', severity: 'warning', cameraIds: ['front', 'back'], objectIds: ['甲', '乙'] });
    expect(findings[0]!.message).toContain('前者「甲」在左');
    expect(findings[0]!.message).toContain('后者「甲」在右');
  });

  it('同一侧的两台机位不报,哪怕角度差很多', () => {
    const front = lockedCamera('front', [0, 1.5, 5], [0, 1, 0]);
    const side = lockedCamera('side', [4, 1.5, 3], [0, 1, 0]);
    const scene = openQueryScene(project([left, right], [front, side]));
    expect(axisFindings(scene, scene.cameras, options)).toEqual([]);
  });

  it('另一侧的机位根本没拍到这两个人时不报:没有那条轴可越', () => {
    const front = lockedCamera('front', [0, 1.5, 5], [0, 1, 0]);
    const away = lockedCamera('away', [0, 1.5, -5], [30, 1, -5]);
    const scene = openQueryScene(project([left, right], [front, away]));
    expect(axisFindings(scene, scene.cameras, options)).toEqual([]);
  });

  it('一个人的走位也是轴:两台机位里走向相反', () => {
    const walker = character('甲', [-2, 0, 0], { motionClips: [walk('w', 0, 4, [-2, 0, 0], [2, 0, 0])] });
    const front = lockedCamera('front', [0, 1.5, 5], [0, 1, 0]);
    const back = lockedCamera('back', [0, 1.5, -5], [0, 1, 0]);
    const scene = openQueryScene(project([walker], [front, back]));

    const findings = axisFindings(scene, scene.cameras, options);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'axis-crossed', objectIds: ['甲'], cameraIds: ['front', 'back'] });
    expect(findings[0]!.message).toContain('走位');
  });

  it('原地挪半步不算走位', () => {
    const shuffle = character('甲', [0, 0, 0], { motionClips: [walk('w', 0, 4, [0, 0, 0], [0.3, 0, 0])] });
    const scene = openQueryScene(project([shuffle], [lockedCamera('front', [0, 1.5, 5], [0, 1, 0]), lockedCamera('back', [0, 1.5, -5], [0, 1, 0])]));
    expect(axisFindings(scene, scene.cameras, options)).toEqual([]);
  });
});

describe('路线穿墙', () => {
  const wall = prop('墙', [2, 1, 0], [0.4, 2, 4]);

  it('路线穿过一堵墙:报区间、报是哪堵墙、报碰撞开着会怎样', async () => {
    const walker = character('甲', [0, 0, 0], { motionClips: [walk('w', 0, 4, [0, 0, 0], [4, 0, 0])] });
    const scene = openQueryScene(project([walker, wall], [lockedCamera('c', [0, 1.5, 6], [0, 1, 0])]));

    const findings = (await routeBlockedFindings(scene, options));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'route-blocked', severity: 'warning', objectId: '甲', objectIds: ['墙'] });
    expect(findings[0]!.from).toBeGreaterThan(1);
    expect(findings[0]!.to).toBeLessThan(3);
    expect(findings[0]!.message).toContain('穿过「墙」');
    expect(findings[0]!.message).toContain('碰撞开着');
  });

  it('碰撞关着时照样报,只是后果不同:人物会直接穿过去', async () => {
    const walker = character('甲', [0, 0, 0], { motionClips: [walk('w', 0, 4, [0, 0, 0], [4, 0, 0])] });
    const scene = openQueryScene(project([walker, wall], [lockedCamera('c', [0, 1.5, 6], [0, 1, 0])], { pathCollisionEnabled: false }));
    const findings = (await routeBlockedFindings(scene, options));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('碰撞关着');
  });

  it('绕开墙的路线不报', async () => {
    const walker = character('甲', [0, 0, 6], { motionClips: [walk('w', 0, 4, [0, 0, 6], [4, 0, 6])] });
    const scene = openQueryScene(project([walker, wall], [lockedCamera('c', [0, 1.5, 12], [0, 1, 0])]));
    expect((await routeBlockedFindings(scene, options))).toEqual([]);
  });

  it('会动的道具不是墙:两条路线互相穿过不算', async () => {
    const a = character('甲', [0, 0, 0], { motionClips: [walk('a', 0, 4, [0, 0, 0], [4, 0, 0])] });
    const cart = prop('车', [4, 0.5, 0], [1, 1, 1], { motionClips: [walk('b', 0, 4, [4, 0.5, 0], [0, 0.5, 0])] });
    const scene = openQueryScene(project([a, cart], [lockedCamera('c', [0, 1.5, 6], [0, 1, 0])]));
    expect((await routeBlockedFindings(scene, options))).toEqual([]);
  });
});

describe('镜头结束前走到位没有', () => {
  it('路线结束前场景会自动延长，机位路径结束不误报到位超时', () => {
    const walker = character('甲', [0, 0, 0], { motionClips: [walk('w', 0, 8, [0, 0, 0], [4, 0, 0])] });
    const scene = openQueryScene(project([walker], [lockedCamera('six', [0, 1.5, 6], [0, 1, 0])]));

    const findings = arrivalFindings(scene, scene.cameras);

    expect(scene.project.timeline.duration).toBe(8);
    expect(findings).toEqual([]);
  });

  it('路线晚于机位路径开始也仍在同一个场景内', () => {
    const early = character('甲', [0, 0, 0], { motionClips: [walk('w', 0, 5, [0, 0, 0], [4, 0, 0])] });
    const late = character('乙', [0, 0, 2], { motionClips: [walk('w', 7, 9, [0, 0, 2], [4, 0, 2])] });
    const scene = openQueryScene(project([early, late], [lockedCamera('six', [0, 1.5, 6], [0, 1, 0])]));

    const findings = arrivalFindings(scene, scene.cameras);

    expect(scene.project.timeline.duration).toBe(9);
    expect(findings).toEqual([]);
  });

  it('does not report cropped source points as late arrivals', () => {
    const route=walk('w',0,5,[0,0,0],[4,0,0]);
    route.source={duration:20,in:0,out:5,origin:0};
    route.keyframes[1]!.time=20;
    const walker=character('甲',[0,0,0],{motionClips:[route]});
    const scene=openQueryScene(project([walker],[lockedCamera('six',[0,1.5,6],[0,1,0])]));
    expect(scene.project.timeline.duration).toBe(6);
    expect(arrivalFindings(scene,scene.cameras)).toEqual([]);
  });

  it('停留会把到点时刻推后,算的是真正到最后一点的时刻', () => {
    const clip = walk('w', 0, 5, [0, 0, 0], [4, 0, 0]);
    clip.keyframes.splice(1, 0, { id: 'hold', time: 2.5, transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, pointBehavior: 'hold', holdSeconds: 3 });
    clip.end = 8;
    clip.keyframes[2]!.time = 8;
    const walker = character('甲', [0, 0, 0], { motionClips: [clip] });
    const scene = openQueryScene(project([walker], [lockedCamera('six', [0, 1.5, 6], [0, 1, 0])]));
    expect(scene.project.timeline.duration).toBe(8);
    expect(arrivalFindings(scene, scene.cameras)).toEqual([]);
  });
});

describe('开场谁左谁右', () => {
  it('从正面看甲在左乙在右,从背面看反过来', () => {
    const left = character('甲', [-1, 0, 0]);
    const right = character('乙', [1, 0, 0]);
    const scene = openQueryScene(project([left, right], [
      lockedCamera('front', [0, 1.5, 5], [0, 1, 0]),
      lockedCamera('back', [0, 1.5, -5], [0, 1, 0]),
    ]));

    const findings = screenOrderFindings(scene, scene.cameras, options);

    expect(findings.map((finding) => [finding.cameraId, finding.objectIds])).toEqual([
      ['front', ['甲', '乙']],
      ['back', ['乙', '甲']],
    ]);
    expect(findings[0]!.message).toContain('「甲」、「乙」');
  });

  it('画里不到两个人就没什么左右可说', () => {
    const scene = openQueryScene(project([character('甲', [0, 0, 0])], [lockedCamera('front', [0, 1.5, 5], [0, 1, 0])]));
    expect(screenOrderFindings(scene, scene.cameras, options)).toEqual([]);
  });
});

describe('整份诊断', () => {
  it('警告排在提示前面,并按要求只看指定机位', async () => {
    const walker = character('甲', [-1, 0, 0], { motionClips: [walk('w', 0, 8, [-1, 0, 0], [-1, 0, 0.5])] });
    const other = character('乙', [1, 0, 0]);
    const scene = project([walker, other], [
      lockedCamera('front', [0, 1.5, 5], [0, 1, 0]),
      lockedCamera('back', [0, 1.5, -5], [0, 1, 0]),
    ]);

    const all = (await directorDiagnostics(scene, { kind: 'diagnostics' }));
    const severities = all.findings.map((finding) => finding.severity);
    expect(severities.indexOf('info')).toBeGreaterThan(severities.lastIndexOf('warning'));
    expect(all.summary).toEqual({ warnings: severities.filter((s) => s === 'warning').length, infos: severities.filter((s) => s === 'info').length });
    expect(all.cameraIds).toEqual(['front', 'back']);

    const only = (await directorDiagnostics(scene, { kind: 'diagnostics', cameraIds: ['front'] }));
    expect(only.cameraIds).toEqual(['front']);
    expect(only.findings.every((finding) => finding.cameraId === 'front' || (finding.cameraIds ?? ['front']).every((id) => id === 'front'))).toBe(true);
    expect(only.findings.some((finding) => finding.code === 'axis-crossed')).toBe(false);
  });

  it('采样网格总包含镜头的最后一刻;区间合并把相邻命中连成一段', () => {
    expect(timeGrid(1, 0.4)).toEqual([0, 0.4, 0.8, 1]);
    expect(intervals([
      { t: 0, hit: false }, { t: 1, hit: true }, { t: 2, hit: true }, { t: 3, hit: false }, { t: 4, hit: true },
    ])).toEqual([{ from: 1, to: 2 }, { from: 4, to: 4 }]);
  });
});

describe('头被切', () => {
  // 身体在画里、头不在:导演第一个否掉的构图,也是出画规则看不见的那一种 ——
  // 只要还有一点在画里,它就满意。中近景对准胸口关节时正是这样。
  const a = character('a', [0, 0, 0]);

  it('机位对着胸口、贴到一米:整段镜头都在报头被切', async () => {
    // 一米外 fov 40 的画幅高 0.73 米:对准 1.35 米的胸口,画里是 0.99–1.71 米,头顶 1.82 在外面。
    const chest = lockedCamera('c', [0, 1.35, 1.0], [0, 1.35, 0], 40);
    const findings = (await directorDiagnostics(project([a], [chest]), { kind: 'diagnostics' })).findings;
    const cut = findings.filter((finding) => finding.code === 'subject-head-cut');
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({ severity: 'warning', cameraId: 'c', objectId: 'a', from: 0 });
    expect(cut[0]!.message).toContain('把「a」的头切出了画');
    expect(findings.filter((finding) => finding.code === 'subject-out-of-frame')).toHaveLength(0);
  });

  it('同样的距离对着头的关节就不报;远景里整个人都在画里也不报', async () => {
    const head = lockedCamera('c', [0, 1.6, 1.0], [0, 1.6, 0], 40);
    expect((await directorDiagnostics(project([a], [head]), { kind: 'diagnostics' })).findings.filter((finding) => finding.code === 'subject-head-cut')).toEqual([]);
    const wide = lockedCamera('w', [0, 1.0, 8], [0, 1.0, 0], 40);
    expect((await directorDiagnostics(project([a], [wide]), { kind: 'diagnostics' })).findings.filter((finding) => finding.code === 'subject-head-cut')).toEqual([]);
  });
});
