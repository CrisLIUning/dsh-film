/** Camera motion clip editing. Ported from Studio's apps/daemon/tests/director-camera-clips-core.test.ts (paths only; async diagnostics awaited). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CameraMotionSnapshot } from '../../src/director/vendor/director-math/schema/cameraMotion.js';
import type { DirectorCameraShot, DirectorObject, SceneSettings } from '../../src/director/vendor/director-math/schema/directorProject.js';
import { createEmptyDirectorProject } from '../../src/director/vendor/director-math/schema/sceneDefaults.js';
import { getCameraPlaybackSnapshot } from '../../src/director/vendor/director-math/schema/cameraPlayback.js';
import { getCameraMotionTrackSnapshot, migrateCameraMotionTrack } from '../../src/director/vendor/director-math/schema/cameraMotionClips.js';
import { editCameraMotionClip } from '../../src/director/vendor/director-math/schema/cameraMotionClipEditing.js';
import { stageCameraPresetClip } from '../../src/director/vendor/director-math/schema/cameraMotionClipPreset.js';

// Captured in the desk at 6159eb4b1, before camera clip implementation.
// The v6 project now uses these curves; public clip editing commands are still pending.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/camera-v5-golden.json', import.meta.url), 'utf8')) as {
  sourceCommit: string;
  objects: DirectorObject[];
  scene: SceneSettings;
  cases: Array<{ camera: DirectorCameraShot; samples: Array<{ seconds: number; expected: CameraMotionSnapshot }> }>;
};

function expectView(actual: CameraMotionSnapshot, expected: CameraMotionSnapshot) {
  expect(actual.fov).toBeCloseTo(expected.fov, 9);
  for (const axis of [0, 1, 2] as const) {
    expect(actual.position[axis]).toBeCloseTo(expected.position[axis], 9);
    expect(actual.target[axis]).toBeCloseTo(expected.target[axis], 9);
  }
}

describe('shared camera clip foundations (not yet a public operation)', () => {
  it('replays all 77 saved v5 frames after camera migration in Node', () => {
    expect(fixture.sourceCommit).toBe('6159eb4b1');
    expect(fixture.cases).toHaveLength(7);
    let samples = 0;
    for (const entry of fixture.cases) {
      const migrated = migrateCameraMotionTrack(entry.camera);
      expect('motionPath' in migrated).toBe(false);
      for (const sample of entry.samples) {
        expectView(getCameraMotionTrackSnapshot(migrated, fixture.objects, sample.seconds, fixture.scene), sample.expected);
        samples++;
      }
    }
    expect(samples).toBe(77);
  });

  it('retains source curves through combined edits and JSON while subjects use scene seconds', () => {
    const original = fixture.cases[5]!.camera;
    const migrated = migrateCameraMotionTrack(original);
    const id = migrated.motionClips[0]!.id;
    const moved = editCameraMotionClip(migrated, { clipId: id, action: 'move', start: 2 }).camera;
    const trimmed = editCameraMotionClip(moved, { clipId: id, action: 'trim', start: 3, end: 7 }).camera;
    const stretched = editCameraMotionClip(trimmed, { clipId: id, action: 'stretch', start: 5, end: 13 }).camera;
    const split = editCameraMotionClip(stretched, { clipId: id, action: 'split', at: 8.13 }).camera;
    const reopened = migrateCameraMotionTrack(JSON.parse(JSON.stringify(split)));
    expect(reopened).toEqual(split);
    for (const seconds of [5, 7, 8.129999, 8.13, 8.130001, 13, 14]) {
      const sourceSeconds = Math.min(5, 1 + (seconds - 5) / 2);
      expectView(
        getCameraMotionTrackSnapshot(reopened, fixture.objects, seconds, fixture.scene),
        getCameraPlaybackSnapshot(original, fixture.objects, sourceSeconds / 6, fixture.scene, undefined, seconds),
      );
    }
  });

  it('compiles ranged presets against the current subject and refuses conflicting insertion', () => {
    const base = fixture.cases[0]!.camera;
    const project = { ...createEmptyDirectorProject(), scene: fixture.scene, objects: fixture.objects, cameras: [migrateCameraMotionTrack(base)] };
    const before = JSON.stringify(project);
    const camera = migrateCameraMotionTrack(base);
    const actor = fixture.objects.find(object => object.kind === 'character')!;
    const result = stageCameraPresetClip(project, camera, { id: 'move', presetId: 'follow', start: 4, end: 8, targetObjectId: actor.id });
    expect(result.clip.source).toEqual({ duration: 4, in: 0, out: 4, origin: 4 });
    expect(result.clip.path.keyframes[0]!.target[0]).toBeCloseTo(2.4, 4);
    expect(result.clip.path.keyframes[2]!.target[0]).toBeCloseTo(4.8, 4);
    expect(() => stageCameraPresetClip(project, result.camera, { id: 'overlap', presetId: 'push-in', start: 6, end: 10 })).toThrow(/重叠/);
    const adjacent = stageCameraPresetClip(project, result.camera, { id: 'next', presetId: 'pull-out', start: 8, end: 12, connectStart: true });
    expectView(getCameraMotionTrackSnapshot(adjacent.camera, fixture.objects, 8, fixture.scene), getCameraMotionTrackSnapshot(result.camera, fixture.objects, 8, fixture.scene));
    expect(JSON.stringify(project)).toBe(before);
    expect(camera.motionClips).toEqual([]);
  });
});
