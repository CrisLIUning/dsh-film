/**
 * What a director would notice looking at the blocking: framing, the
 * 180-degree line, routes through walls, late arrivals, screen order.
 * Ported from Studio's apps/daemon/src/director/diagnostics.ts with one change:
 * the two checks that sample the whole scene clock (framing, blocked routes)
 * are async and yield to the event loop every few milliseconds, and the
 * samples of one moment are shared between cameras. Studio runs them inline in
 * its daemon; here they run on the Host's event loop, which a long scene at a
 * fine step would otherwise hold for seconds.
 * @module dsh-film/director/diagnostics
 */

import { setImmediate as nextTurn } from 'node:timers/promises';
import { hasSpatialTerrain } from './vendor/director-math/schema/spatialTerrain.js';
import { cameraForMotionClip } from './vendor/director-math/schema/cameraMotionClips.js';
import { getCameraRouteCollision, getObjectRouteCollision, getObjectTerrainPosition } from './vendor/director-math/schema/routeCollision.js';
import { getSceneDuration } from './vendor/director-math/schema/sceneTime.js';
// What a director would notice looking at the blocking — derived from the
// scene, not stored in it. Each check is its own function so each can be
// shown to fire on a scene that has the problem and stay quiet on one that
// does not; a diagnostic that cannot be made to fire is a comment, and one
// that fires on a clean scene is noise the agent learns to ignore.
import type { DirectorCameraWithMotionClips as DirectorCameraShot, DirectorObject, DirectorTransform } from './vendor/director-math/schema/directorProject.js';
import {
  getObjectMotionClipSpans,
  getObjectMotionClips,
  getObjectMotionSnapshot,
  hasObjectMotion,
} from './vendor/director-math/schema/objectMotion.js';
import { constrainObjectMotionTransform } from './vendor/director-math/schema/pathCollision.js';
import type { DirectorFinding } from './contracts/index.js';

import { frameObject, projectToScreen } from './framing.js';
import {
  cameraMomentAt,
  cameraSubjects,
  isFramableObject,
  sampleObjectsAt,
  type QueryScene,
  type SampledObject,
} from './scene.js';

/** How long a check may hold the event loop before it lets other work run. */
const SLICE_MS = 8;

/**
 * Lets a long check give the event loop back. `due()` is cheap enough to ask
 * on every sample; `rest()` waits one turn of the loop.
 */
export class Pace {
  private last = performance.now();

  due(): boolean {
    return performance.now() - this.last >= SLICE_MS;
  }

  async rest(): Promise<void> {
    await nextTurn();
    this.last = performance.now();
  }
}

/** Every object at a moment, sampled once however many cameras ask (the samples are pure). */
export function sharedSampler(scene: QueryScene): (seconds: number) => SampledObject[] {
  const memo = new Map<number, SampledObject[]>();
  return (seconds) => {
    let sampled = memo.get(seconds);
    if (!sampled) memo.set(seconds, sampled = sampleObjectsAt(scene, seconds));
    return sampled;
  };
}

export interface DiagnosticOptions {
  step: number;
  aspect?: number;
  /** Yields between samples; one per diagnostics run. */
  pace?: Pace;
  /** Shared object samples; see {@link sharedSampler}. */
  sample?: (seconds: number) => SampledObject[];
}

function label(item: { name?: string; id: string }) {
  return item.name?.trim() || item.id;
}

function seconds(value: number) {
  return Number(value.toFixed(2));
}

/** 0, step, 2·step … and the end itself, so the last frame is always looked at. */
export function timeGrid(end: number, step: number): number[] {
  const grid: number[] = [];
  const safeStep = Math.max(0.001, step);
  for (let t = 0; t < end; t += safeStep) grid.push(Number(t.toFixed(6)));
  grid.push(Number(end.toFixed(6)));
  return grid;
}

/** Runs of consecutive samples where `hit` held, as [first, last] times. */
export function intervals(samples: Array<{ t: number; hit: boolean }>): Array<{ from: number; to: number }> {
  const result: Array<{ from: number; to: number }> = [];
  let open: { from: number; to: number } | null = null;
  for (const sample of samples) {
    if (sample.hit) {
      if (open) open.to = sample.t;
      else open = { from: sample.t, to: sample.t };
    } else if (open) {
      result.push(open);
      open = null;
    }
  }
  if (open) result.push(open);
  return result;
}

/**
 * Who leaves the frame, and when. Tracking may place its subject away from
 * the centre, so check both tracked subjects and static set-ups: the character who walks out of a locked-off wide is
 * the classic thing nobody notices until the render. Characters that never
 * enter the shot at all are not reported — they are simply not in it.
 */
export async function subjectFramingFindings(scene: QueryScene, camera: DirectorCameraShot, options: DiagnosticOptions): Promise<DirectorFinding[]> {
  const findings: DirectorFinding[] = [];
  const pace = options.pace ?? new Pace();
  const sample = options.sample ?? sharedSampler(scene);
  const duration = getSceneDuration(scene.project);
  const grid = timeGrid(duration, options.step);
  const subjects = new Set(cameraSubjects(camera).map((subject) => subject.objectId));
  const characters = scene.objects.filter((object) => object.kind === 'character' && isFramableObject(object));
  const clamped: Array<{t:number;hit:boolean}> = [];
  const framingByObject = new Map<string, Array<{ t: number; framing: 'full' | 'partial' | 'out'; head?: 'in' | 'out' }>>();
  for (const t of grid) {
    if (pace.due()) await pace.rest();
    const moment = cameraMomentAt(scene, camera, t, options.aspect);
    clamped.push({t,hit:Boolean(moment.view.compositionClamped)});
    const sampled = sample(t);
    for (const character of characters) {
      const posed = sampled.find((item) => item.object.id === character.id);
      if (!posed) continue;
      const result = frameObject(moment.view, moment.aspect, character, posed.transform);
      const list = framingByObject.get(character.id) ?? [];
      list.push({ t, framing: result.framing, ...(result.head ? { head: result.head } : {}) });
      framingByObject.set(character.id, list);
    }
  }
  for (const span of intervals(clamped)) findings.push({code:'composition-unreachable',severity:'warning',cameraId:camera.id,from:seconds(span.from),to:seconds(span.to),message:`机位「${label(camera)}」在 ${seconds(span.from)}–${seconds(span.to)} 秒接近垂直俯仰，当前无横滚投影无法精确满足主体构图；请调整机位或看向`});
  for (const character of characters) {
    const samples = framingByObject.get(character.id) ?? [];
    if (!samples.some((sample) => sample.framing !== 'out')) continue;
    const severity = subjects.size === 0 || subjects.has(character.id) ? 'warning' : 'info';
    for (const span of intervals(samples.map((sample) => ({ t: sample.t, hit: sample.framing === 'out' })))) {
      findings.push({
        code: 'subject-out-of-frame',
        severity,
        cameraId: camera.id,
        objectId: character.id,
        from: seconds(span.from),
        to: seconds(span.to),
        message: `机位「${label(camera)}」在 ${seconds(span.from)}–${seconds(span.to)} 秒里看不到「${label(character)}」`,
      });
    }
    // The body in the frame and the head not: the first thing a director
    // rejects, and the one framing fault a tight size can hide from the
    // out-of-frame rule, which is happy as long as something is in.
    if (subjects.size > 0 && !subjects.has(character.id)) continue;
    for (const span of intervals(samples.map((sample) => ({ t: sample.t, hit: sample.framing !== 'out' && sample.head === 'out' })))) {
      findings.push({
        code: 'subject-head-cut',
        severity: 'warning',
        cameraId: camera.id,
        objectId: character.id,
        from: seconds(span.from),
        to: seconds(span.to),
        message: `机位「${label(camera)}」在 ${seconds(span.from)}–${seconds(span.to)} 秒里把「${label(character)}」的头切出了画`,
      });
    }
  }
  return findings;
}

interface AxisSide {
  cameraId: string;
  side: number;
  leftToRight: string[];
}

function cross2(ax: number, az: number, bx: number, bz: number) {
  return ax * bz - az * bx;
}

/**
 * The 180-degree rule. Two set-ups on opposite sides of the line between two
 * characters swap their screen sides on the cut; the same holds for a single
 * character's line of movement. Judged at the start of the shots, where a
 * scene covered from several angles has everyone standing where the coverage
 * was planned around.
 */
export function axisFindings(scene: QueryScene, cameras: DirectorCameraShot[], options: DiagnosticOptions): DirectorFinding[] {
  const findings: DirectorFinding[] = [];
  const sampled = sampleObjectsAt(scene, 0);
  const characters = sampled.filter((item) => item.object.kind === 'character' && isFramableObject(item.object));
  const moments = cameras.map((camera) => cameraMomentAt(scene, camera, 0, options.aspect));

  const sidesFor = (origin: DirectorTransform['position'], axisX: number, axisZ: number, required: string[]) =>
    moments.flatMap((moment): AxisSide[] => {
      const framed = characters
        .map((item) => ({ item, result: frameObject(moment.view, moment.aspect, item.object, item.transform) }))
        .filter(({ result }) => result.framing !== 'out' && result.screen);
      if (!required.every((id) => framed.some(({ item }) => item.object.id === id))) return [];
      const side = cross2(axisX, axisZ, moment.view.position[0] - origin[0], moment.view.position[2] - origin[2]);
      if (Math.abs(side) < 1e-6) return [];
      return [{
        cameraId: moment.camera.id,
        side: Math.sign(side),
        leftToRight: framed.sort((a, b) => a.result.screen![0] - b.result.screen![0]).map(({ item }) => item.object.id),
      }];
    });

  const report = (sides: AxisSide[], objectIds: string[], describe: (a: AxisSide, b: AxisSide) => string) => {
    for (let i = 0; i < sides.length; i += 1) {
      for (let j = i + 1; j < sides.length; j += 1) {
        const a = sides[i]!;
        const b = sides[j]!;
        if (a.side === b.side) continue;
        findings.push({
          code: 'axis-crossed',
          severity: 'warning',
          cameraIds: [a.cameraId, b.cameraId],
          objectIds,
          message: describe(a, b),
        });
      }
    }
  };

  const nameOf = (id: string) => label(scene.objects.find((object) => object.id === id) ?? { id });
  const cameraName = (id: string) => label(cameras.find((camera) => camera.id === id) ?? { id });

  // Two characters: the line between them.
  for (let i = 0; i < characters.length; i += 1) {
    for (let j = i + 1; j < characters.length; j += 1) {
      const a = characters[i]!;
      const b = characters[j]!;
      const axisX = b.transform.position[0] - a.transform.position[0];
      const axisZ = b.transform.position[2] - a.transform.position[2];
      if (Math.hypot(axisX, axisZ) < 0.05) continue;
      const sides = sidesFor(a.transform.position, axisX, axisZ, [a.object.id, b.object.id]);
      report(sides, [a.object.id, b.object.id], (left, right) => {
        const order = (side: AxisSide) => side.leftToRight.indexOf(a.object.id) < side.leftToRight.indexOf(b.object.id)
          ? `「${nameOf(a.object.id)}」在左`
          : `「${nameOf(a.object.id)}」在右`;
        return `机位「${cameraName(left.cameraId)}」和「${cameraName(right.cameraId)}」在「${nameOf(a.object.id)}」—「${nameOf(b.object.id)}」连线的两侧:前者${order(left)},后者${order(right)},切过去两人会左右对调`;
      });
    }
  }

  // One character on the move: the line of its travel.
  for (const item of characters) {
    if (!hasObjectMotion(item.object, 2)) continue;
    const clips = getObjectMotionClips(item.object).filter((clip) => clip.keyframes.length > 0);
    const firstClip = clips[0];
    const first = firstClip ? getObjectMotionSnapshot(item.object, firstClip.start) : null;
    const lastClip = clips[clips.length - 1];
    const last = lastClip ? getObjectMotionSnapshot(item.object, lastClip.end) : null;
    if (!first || !last) continue;
    const axisX = last.position[0] - first.position[0];
    const axisZ = last.position[2] - first.position[2];
    if (Math.hypot(axisX, axisZ) < 0.5) continue;
    const sides = sidesFor(first.position, axisX, axisZ, [item.object.id]);
    report(sides, [item.object.id], (left, right) =>
      `「${nameOf(item.object.id)}」的走位在机位「${cameraName(left.cameraId)}」和「${cameraName(right.cameraId)}」里方向相反:一台里向左走,另一台里向右走`);
  }

  return findings;
}

/**
 * Routes that run through something solid. Checked with collision forced on,
 * whatever the scene setting: with it on the desk shoves the character out
 * of the wall, with it off the character walks through it, and either way the
 * route was drawn through a wall.
 */
export async function routeBlockedFindings(scene: QueryScene, options: DiagnosticOptions, cameras: DirectorCameraShot[] = scene.cameras): Promise<DirectorFinding[]> {
  const findings: DirectorFinding[] = [];
  const pace = options.pace ?? new Pace();
  const colliding = { ...scene.scene, pathCollisionEnabled: true };
  const obstacles = scene.project.objects.filter((object) =>
    object.visible && !hasObjectMotion(object) && (object.kind === 'prop' || object.kind === 'scene'));
  const displaced = (object: DirectorObject, transform: DirectorTransform, against: DirectorObject[]) => {
    const constrained = constrainObjectMotionTransform(object, transform, colliding, against, object.kind==='character' && hasSpatialTerrain(scene.project.objects));
    return Math.hypot(constrained.position[0] - transform.position[0], constrained.position[2] - transform.position[2]) > 1e-4;
  };

  for (const object of scene.objects) {
    if (!hasObjectMotion(object, 2)) continue;
    for (const clip of getObjectMotionClips(object)) {
      if (clip.keyframes.length < 2) continue;
      if (pace.due()) await pace.rest();
      const clipObject = {...object,motionClips:[clip]};
      const swept = getObjectRouteCollision(clipObject,clip.end,colliding,scene.project.objects);
      if (swept) {
        let lo=clip.start,hi=clip.end;
        for(let i=0;i<35;i++){const mid=(lo+hi)/2;if(getObjectRouteCollision(clipObject,mid,colliding,scene.project.objects))hi=mid;else lo=mid;}
        const obstacle=obstacles.find(o=>o.id===swept.objectId);
        findings.push({code:'route-blocked',severity:'warning',objectId:object.id,objectIds:[swept.objectId],from:seconds(hi),to:seconds(clip.end),
          message:swept.reason==='support-ended'
            ? `「${label(object)}」的路线在 ${seconds(hi)} 秒离开楼面后没有可衔接支撑；${scene.scene.pathCollisionEnabled?'人物会停在边缘':'防穿模关闭'}。请检查楼梯、坡面或平台标注。`
            : `「${label(object)}」的路线在 ${seconds(hi)} 秒遇到「${label(obstacle??{id:swept.objectId})}」；${scene.scene.pathCollisionEnabled?'该片段在首次碰撞处停住':'防穿模关闭，预演会穿过'}。请调整路线或检查开口。`});
        continue;
      }
      const samples: Array<{ t: number; hit: boolean; blockers: string[] }> = [];
      for (const offset of timeGrid(clip.end - clip.start, options.step)) {
        if (pace.due()) await pace.rest();
        const t = clip.start + offset;
        const raw = getObjectMotionSnapshot(object, t);
        const position=getObjectTerrainPosition(object,t,colliding,scene.project.objects);
        const transform=position?{...raw,position}:raw;
        const hit = displaced(object, transform, scene.project.objects);
        const blockers = hit
          ? obstacles.filter((obstacle) => obstacle.id !== object.id && displaced(object, transform, [obstacle])).map((obstacle) => obstacle.id)
          : [];
        samples.push({ t, hit, blockers });
      }
      for (const span of intervals(samples)) {
        const blockers = [...new Set(samples.filter((s) => s.t >= span.from && s.t <= span.to).flatMap((s) => s.blockers))];
        const names = blockers.map((id) => `「${label(scene.project.objects.find((item) => item.id === id) ?? { id })}」`).join('、');
        findings.push({
          code: 'route-blocked',
          severity: 'warning',
          objectId: object.id,
          ...(blockers.length ? { objectIds: blockers } : {}),
          from: seconds(span.from),
          to: seconds(span.to),
          message: `「${label(object)}」的路线在 ${seconds(span.from)}–${seconds(span.to)} 秒穿过${names || '障碍物'};${
            scene.scene.pathCollisionEnabled ? '碰撞开着,人物会被推到旁边' : '碰撞关着,人物会直接穿过去'
          }`,
        });
      }
    }
  }
  for(const camera of cameras) for(const clip of camera.motionClips) {
    if (pace.due()) await pace.rest();
    const curve=cameraForMotionClip(camera,clip),start=clip.source.in/clip.path.duration,end=clip.source.out/clip.path.duration;
    const hit=getCameraRouteCollision(curve,end,start,scene.project.objects);
    if(!hit)continue;
    let lo=0,hi=1;
    for(let i=0;i<35;i++){const mid=(lo+hi)/2;if(getCameraRouteCollision(curve,start+(end-start)*mid,start,scene.project.objects))hi=mid;else lo=mid;}
    const obstacle=obstacles.find(o=>o.id===hit.objectId);
    findings.push({code:'route-blocked',severity:'warning',cameraId:camera.id,objectIds:[hit.objectId],from:seconds(clip.start+(clip.end-clip.start)*hi),to:seconds(clip.end),
      message:`机位「${label(camera)}」的路线遇到「${label(obstacle??{id:hit.objectId})}」；${scene.scene.pathCollisionEnabled?'该片段在首次碰撞处停住':'防穿模关闭，预演会穿过'}。请调整运镜或检查开口。`});
  }
  return findings;
}

/**
 * Whether everyone gets where they are going before the shot is over, and
 * whether a route even starts inside it. A camera is a shot from 0 for its
 * scene length until shot source ranges exist; ending a camera path holds
 * its lens, it does not end the scene.
 */
export function arrivalFindings(scene: QueryScene, cameras: DirectorCameraShot[]): DirectorFinding[] {
  const findings: DirectorFinding[] = [];
  for (const camera of cameras) {
    const duration = getSceneDuration(scene.project);
    for (const object of scene.objects) {
      const clips = getObjectMotionClips(object).filter((clip) => clip.keyframes.length > 0);
      if (clips.length === 0) continue;
      const firstStart = Math.min(...clips.map((clip) => clip.start));
      const lastArrival = Math.max(...clips.map((clip) => {
        const spans = getObjectMotionClipSpans(clip);
        return Math.max(clip.start, Math.min(clip.end, spans.arrivals[spans.arrivals.length - 1] ?? clip.start));
      }));
      if (firstStart >= duration) {
        findings.push({
          code: 'route-after-shot',
          severity: 'info',
          cameraId: camera.id,
          objectId: object.id,
          from: seconds(duration),
          to: seconds(firstStart),
          message: `「${label(object)}」的路线从 ${seconds(firstStart)} 秒才开始,机位「${label(camera)}」在 ${seconds(duration)} 秒就结束了,这台机位拍不到它动`,
        });
      } else if (lastArrival > duration + 1e-6) {
        findings.push({
          code: 'arrives-late',
          severity: 'warning',
          cameraId: camera.id,
          objectId: object.id,
          from: seconds(duration),
          to: seconds(lastArrival),
          message: `「${label(object)}」要到 ${seconds(lastArrival)} 秒才走到最后一点,机位「${label(camera)}」在 ${seconds(duration)} 秒结束`,
        });
      }
    }
  }
  return findings;
}

/**
 * Who stands where in the frame as each shot opens, left to right. Not a
 * fault, the thing a director keeps in their head across a cut.
 */
export function screenOrderFindings(scene: QueryScene, cameras: DirectorCameraShot[], options: DiagnosticOptions): DirectorFinding[] {
  const findings: DirectorFinding[] = [];
  const sampled = sampleObjectsAt(scene, 0);
  for (const camera of cameras) {
    const moment = cameraMomentAt(scene, camera, 0, options.aspect);
    const framed = sampled
      .filter((item) => item.object.kind === 'character' && isFramableObject(item.object))
      .map((item) => ({ item, result: frameObject(moment.view, moment.aspect, item.object, item.transform) }))
      .filter(({ result }) => result.framing !== 'out' && result.screen)
      .sort((a, b) => a.result.screen![0] - b.result.screen![0]);
    if (framed.length < 2) continue;
    findings.push({
      code: 'screen-order',
      severity: 'info',
      cameraId: camera.id,
      objectIds: framed.map(({ item }) => item.object.id),
      message: `机位「${label(camera)}」开场画面从左到右:${framed.map(({ item }) => `「${label(item.object)}」`).join('、')}`,
    });
  }
  return findings;
}

export { projectToScreen };
