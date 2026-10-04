/** Camera motion clips in queries. Ported from Studio's apps/daemon/tests/director-camera-clips-query.test.ts (paths only; async diagnostics awaited). */
import { describe, expect, it } from 'vitest';
import { directorSample, directorStructure, resolveDirectorProject } from '../../src/director/query.js';
import { cameraSubjectAt } from '../../src/director/scene.js';
import { createCameraMotionClip } from '../../src/director/vendor/director-math/schema/cameraMotionClips.js';
import { DEFAULT_CAMERA_MOTION_PATH } from '../../src/director/vendor/director-math/schema/cameraMotion.js';
import { parseDirectorStagePlan, stageDirectorScene } from '../../src/director/staging.js';
import { lockedCamera, project } from './fixtures.js';

function sceneWithClips() {
  const scene = project([], [lockedCamera('cam', [0, 2, 8], [0, 1, 0])]);
  const segment = (id: string, start: number) => createCameraMotionClip(id, { ...DEFAULT_CAMERA_MOTION_PATH, duration: 8,
    interpolation: 'linear', speedMode: 'custom', customEasing: [0, 0, 1, 1],
    keyframes: [0, .5, 1].map((time, index) => ({ id: `${id}_${index}`, time, position: [time * 8, 2, 8], target: [0, 1, 0], fov: 50,
      targetMode: 'object', targetObjectId: id === 'b' ? 'actor_b' : 'actor_a', targetBodyPart: 'head' })) }, start, start + 4);
  const first = segment('a', 0), second = segment('b', 10);
  scene.cameras[0]!.motionClips = [first, { ...second, end: 12, source: { ...second.source, in: 2, out: 6 } }];
  scene.timeline.duration = 20;
  return scene;
}

describe('v6 camera tracks at the daemon boundary', () => {
  it('reports retained source ranges, rates and visible points in scene seconds', () => {
    const camera = directorStructure(sceneWithClips()).cameras[0]!;
    expect(camera).toMatchObject({ seconds: 12, keyframeCount: 6, clips: [
      { id: 'a', start: 0, end: 4, rate: 2, visiblePoints: 3, arrivals: [0, 2, 4] },
      { id: 'b', start: 10, end: 12, rate: 2, visiblePoints: 1, arrivals: [9, 11, 13], source: { duration: 8, in: 2, out: 6, origin: 10 } },
    ] });
  });
  it('JSON reopen and query sampling use the active clip, including gaps and the end', () => {
    const scene = resolveDirectorProject(JSON.parse(JSON.stringify(sceneWithClips())))!;
    const at = [0, 4, 9, 10, 11, 12, 16];
    const frames = directorSample(scene, { kind: 'sample', at }).frames;
    expect(frames.map(frame => frame.cameras[0]!.position[0])).toEqual([0, 8, 8,
      expect.closeTo(2, 4), expect.closeTo(4, 8), expect.closeTo(6, 4), expect.closeTo(6, 4)]);
    expect(frames.map(frame => frame.cameras[0]!.subject?.objectId)).toEqual(['actor_a', 'actor_a', 'actor_a', 'actor_b', 'actor_b', 'actor_b', 'actor_b']);
    expect(cameraSubjectAt(scene.cameras[0]!, 11)).toEqual({ objectId: 'actor_b', bodyPart: 'head' });
  });
  it('existing stage commands create canonical cameras and subsequent reads keep their motion', () => {
    const scene = project([], [lockedCamera('cam', [0, 2, 8], [0, 1, 0])]);
    const staged = stageDirectorScene(scene, parseDirectorStagePlan({ ops: [{ type: 'camera_preset', cameraId: 'cam', presetId: 'push-in', duration: 4 }] })).project;
    expect(staged.version).toBe(15);
    expect(staged.cameras[0]).not.toHaveProperty('motionPath');
    expect(staged.cameras[0]!.motionClips).toHaveLength(1);
    const reopened = resolveDirectorProject(JSON.parse(JSON.stringify(staged)))!;
    const frames = directorSample(reopened, { kind: 'sample', at: [0, 4] }).frames;
    expect(frames[0]!.cameras[0]!.position).not.toEqual(frames[1]!.cameras[0]!.position);
  });
  it('rejects a project with both motion representations instead of silently taking one', () => {
    const scene = sceneWithClips();
    expect(() => resolveDirectorProject({ ...scene, cameras: [{ ...scene.cameras[0], motionPath: DEFAULT_CAMERA_MOTION_PATH }] })).toThrow(/同时包含/);
  });
});
