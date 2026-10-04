/** Tracked shot sizes keep the subject framed. Ported from Studio's apps/daemon/tests/director-shot-fit.test.ts (paths only; async diagnostics awaited). */
import { describe, expect, it } from 'vitest';
import { character, project, transform } from './fixtures.js';
import { characterHeight, frameObject, projectToScreen } from '../../src/director/framing.js';
import { SHOT_ANGLES, SHOT_SIZE_IDS, SHOT_SIZES, resolveShot } from '../../src/director/vocabulary.js';
import { parseDirectorStagePlan, stageDirectorScene } from '../../src/director/staging.js';
import { directorDiagnostics, directorSample } from '../../src/director/query.js';

describe('pitched shot framing', () => {
  it.each([false, true])('keeps the requested body interval in perspective at every angle (tracked=%s)', tracked => {
    for (const height of [.8, 1.82, 3]) for (const angle of Object.keys(SHOT_ANGLES) as (keyof typeof SHOT_ANGLES)[]) {
      for (const fov of [10, 40, 100, 120]) for (const size of SHOT_SIZE_IDS) {
        const actor = character('actor', [4, 3, -7], { heightMetres: height, transform: transform([4, 3, -7], [0, .73, 0]) });
        const resolved = resolveShot(actor, actor.transform, { size, angle, side: 'back-left', fov, tracked });
        for (const fraction of [SHOT_SIZES[size].low, SHOT_SIZES[size].high]) {
          const point = projectToScreen(resolved.view, 16 / 9, [4, 3 + height * fraction, -7]);
          const label = JSON.stringify({height, angle, fov, size, tracked, fraction});
          expect(point, label).not.toBeNull();
          expect(Math.abs(point!.y), label).toBeLessThanOrEqual(1.002);
          expect(Math.abs(point!.x), label).toBeLessThan(.002);
        }
      }
    }
  });

  it.each(['high', 'low', 'top'] as const)('full %s shot includes head and feet at a wide field of view', angle => {
    const actor = character('actor', [0, 3, 0], { heightMetres: 1.82 });
    const resolved = resolveShot(actor, actor.transform, { size: 'full', angle, fov: 100 });
    expect(frameObject(resolved.view, 16 / 9, actor, actor.transform)).toMatchObject({ framing: 'full', head: 'in' });
    // The author asked for this pitch. Fixing the crop must not silently flatten it.
    const delta = resolved.view.target.map((v, i) => v - resolved.view.position[i]!);
    expect(Math.atan2(delta[1]!, Math.hypot(delta[0]!, delta[2]!)) * 180 / Math.PI).toBeCloseTo(SHOT_ANGLES[angle].pitch, 2);
  });

  it('extra distance remains an additive dolly offset and never changes the requested FOV', () => {
    const actor = character('actor', [0, 0, 0]);
    const base = resolveShot(actor, actor.transform, { size: 'full', angle: 'high', fov: 100 });
    const farther = resolveShot(actor, actor.transform, { size: 'full', angle: 'high', fov: 100, distance: 2 });
    expect(farther.distance - base.distance).toBeCloseTo(2, 4);
    expect(farther.view.fov).toBe(100);
    const head = [0, characterHeight(actor), 0] as [number, number, number];
    expect(Math.abs(projectToScreen(farther.view, 16 / 9, head)!.y)).toBeLessThan(Math.abs(projectToScreen(base.view, 16 / 9, head)!.y));
  });

  it('shot, camera_move and follow compile to saved curves that retain full framing during playback', async () => {
    const original = project([character('actor', [0, 3, 0], { heightMetres: 1.82 })], [], { pathCollisionEnabled: false });
    const before = JSON.stringify(original);
    const shot = { subject: 'actor', size: 'full', angle: 'high', fov: 100 };
    const staged = stageDirectorScene(original, parseDirectorStagePlan({ ops: [
      { type: 'move', objectId: 'actor', start: 0, end: 4, path: [[0,3,0],[0,3,2]], pace: 'uniform', facing: 'path', action: null, arriveAction: null },
      { type: 'shot', cameraId: 'static', shot, seconds: 4 },
      { type: 'camera_move', cameraId: 'moving', keyframes: [{at:0,shot}, {at:4,shot}], interpolation: 'linear', pace: 'custom' },
      { type: 'follow', cameraId: 'following', shot, seconds: 4 },
    ] }));
    const loaded = JSON.parse(JSON.stringify(staged.project));
    expect(JSON.stringify(original)).toBe(before);
    const frames = directorSample(loaded, { kind: 'sample', at: [0, .5, 2, 3.5, 4] }).frames;
    for (const frame of frames) for (const camera of frame.cameras.filter(c => c.id !== 'static' || frame.t === 0)) {
      expect(camera.framing.find(s => s.objectId === 'actor'), JSON.stringify({t:frame.t,camera})).toMatchObject({framing:'full'});
    }
    const findings = (await directorDiagnostics(loaded, { kind: 'diagnostics', cameraIds: ['following'] })).findings;
    expect(findings.filter(f => f.code === 'subject-head-cut')).toEqual([]);
  });
});
