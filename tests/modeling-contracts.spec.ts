/**
 * The procedural model record contract: version identity, freshness, quality
 * versus run status, capabilities, normalisation and visual review. Studio's
 * packages/contracts/tests/model-project.test.ts, ported verbatim.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MODEL_REVIEW_ASPECTS, canonicalModelInputs, diffModelInputs, isProjectRelativePath,
  modelArtifactFreshness, modelCapabilities, modelQualitySummary, modelReviewSummary,
  modelVersionDir, modelVersionId, normalizeModelProjectRecord,
  type ModelCheckRecord, type ModelInputs, type ModelProjectRecord, type ModelReviewNote,
  type ModelRunRecord,
} from '../src/modeling/contracts/model-project.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const hash = (seed: string) => createHash('sha256').update(seed).digest('hex');

const inputs = (overrides: Partial<ModelInputs> = {}): ModelInputs => ({
  entry: 'models/knight/knight.ts',
  sources: [
    { path: 'models/knight/knight.ts', sha256: hash('entry'), bytes: 100 },
    { path: 'models/knight/parts/helm.ts', sha256: hash('helm'), bytes: 50 },
  ],
  resources: [{ path: 'models/knight/textures/steel.png', sha256: hash('steel'), bytes: 2048 }],
  parameters: { height: 1.82, wireframe: false },
  toolchain: { three: '0.184.0', bundler: 'esbuild', bundlerVersion: '0.25.12', runtime: 'model-runtime@1' },
  ...overrides,
});

describe('version identity', () => {
  it('moves when an IMPORTED module changes, not only the entry', () => {
    const before = modelVersionId(inputs(), sha256);
    const after = modelVersionId(inputs({
      sources: [
        { path: 'models/knight/knight.ts', sha256: hash('entry'), bytes: 100 },
        { path: 'models/knight/parts/helm.ts', sha256: hash('helm v2'), bytes: 55 },
      ],
    }), sha256);
    expect(after).not.toBe(before);
    expect(diffModelInputs(inputs(), inputs({
      sources: [
        { path: 'models/knight/knight.ts', sha256: hash('entry'), bytes: 100 },
        { path: 'models/knight/parts/helm.ts', sha256: hash('helm v2'), bytes: 55 },
      ],
    })).changedSources).toEqual(['models/knight/parts/helm.ts']);
  });

  it('moves when a texture changes', () => {
    const next = inputs({ resources: [{ path: 'models/knight/textures/steel.png', sha256: hash('rusted'), bytes: 2048 }] });
    expect(modelVersionId(next, sha256)).not.toBe(modelVersionId(inputs(), sha256));
    expect(diffModelInputs(inputs(), next).changedResources).toEqual(['models/knight/textures/steel.png']);
  });

  it('moves when a parameter changes, and names which one', () => {
    const next = inputs({ parameters: { height: 1.9, wireframe: false } });
    expect(modelVersionId(next, sha256)).not.toBe(modelVersionId(inputs(), sha256));
    expect(diffModelInputs(inputs(), next).changedParameters).toEqual(['height']);
  });

  it('moves when three or the bundler moves', () => {
    const next = inputs({ toolchain: { ...inputs().toolchain, three: '0.185.0' } });
    expect(modelVersionId(next, sha256)).not.toBe(modelVersionId(inputs(), sha256));
    expect(diffModelInputs(inputs(), next).changedToolchain).toEqual(['three']);
  });

  it('is stable across source order and parameter key order', () => {
    const reordered = inputs({
      sources: [...inputs().sources].reverse(),
      parameters: { wireframe: false, height: 1.82 },
    });
    expect(modelVersionId(reordered, sha256)).toBe(modelVersionId(inputs(), sha256));
    expect(diffModelInputs(inputs(), reordered).changed).toBe(false);
  });

  it('distinguishes two entries with identical content', () => {
    const same = hash('shared');
    const a = inputs({ entry: 'models/a/a.ts', sources: [{ path: 'models/a/a.ts', sha256: same, bytes: 1 }] });
    const b = inputs({ entry: 'models/b/b.ts', sources: [{ path: 'models/b/b.ts', sha256: same, bytes: 1 }] });
    expect(modelVersionId(a, sha256)).not.toBe(modelVersionId(b, sha256));
  });

  it('treats -0 and 0 as the same parameter and drops non-finite numbers', () => {
    expect(canonicalModelInputs(inputs({ parameters: { spin: -0 } })))
      .toBe(canonicalModelInputs(inputs({ parameters: { spin: 0 } })));
    expect(canonicalModelInputs(inputs({ parameters: { spin: NaN } }))).toContain('"spin":null');
  });

  it('keys version output directories apart', () => {
    expect(modelVersionDir('knight', hash('a'))).not.toBe(modelVersionDir('knight', hash('b')));
    expect(modelVersionDir('knight', hash('a'))).toContain('models/knight/versions/');
  });
});

describe('freshness', () => {
  it('marks anything from another version as needing an update', () => {
    expect(modelArtifactFreshness(hash('v1'), hash('v1'))).toBe('current');
    expect(modelArtifactFreshness(hash('v1'), hash('v2'))).toBe('needs-update');
    expect(modelArtifactFreshness('', hash('v1'))).toBe('needs-update');
  });
});

describe('run status versus quality verdict', () => {
  const versionId = hash('v1');
  const check = (over: Partial<ModelCheckRecord>): ModelCheckRecord => ({
    id: 'c', gate: 'geometry_integrity', versionId, runId: 'r', applicability: 'applicable', ...over,
  });

  it('lets a successful run carry a failing gate', () => {
    const summary = modelQualitySummary([
      check({ id: 'c1', gate: 'geometry_integrity', verdict: 'fail', reason: 'openEdges=4' }),
      check({ id: 'c2', gate: 'self_intersection', verdict: 'pass' }),
    ], versionId);
    expect(summary.verdict).toBe('fail');
    expect(summary.failedGates).toEqual(['geometry_integrity']);
    expect(summary.passed).toBe(1);
  });

  it('calls a partly-run set incomplete rather than a pass', () => {
    const summary = modelQualitySummary([
      check({ id: 'c1', verdict: 'pass' }),
      check({ id: 'c2', gate: 'turntable_gate', applicability: 'not-run', reason: '截图链未接' }),
    ], versionId);
    expect(summary.verdict).toBe('incomplete');
    expect(summary.notRunGates).toEqual(['turntable_gate']);
  });

  it('does not count another version\'s checks', () => {
    expect(modelQualitySummary([check({ versionId: hash('other'), verdict: 'fail' })], versionId).verdict).toBe('incomplete');
  });

  it('refuses a verdict on a check that does not apply', () => {
    const record = normalizeModelProjectRecord({
      schemaVersion: 1, id: 'knight', kind: 'character', title: '骑士',
      createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
      versions: [], runs: [],
      checks: [{ id: 'c', gate: 'hair_gate', versionId, runId: 'r', applicability: 'not-applicable', verdict: 'pass', reason: '无参考图' }],
    });
    expect(record?.checks[0]?.verdict).toBeUndefined();
    expect(record?.checks[0]?.applicability).toBe('not-applicable');
  });
});

describe('capabilities', () => {
  const versionId = hash('v1');
  const base = (runs: ModelRunRecord[], checks: ModelCheckRecord[] = []): ModelProjectRecord => ({
    schemaVersion: 1, id: 'knight', kind: 'character', title: '骑士',
    createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
    orientation: { unit: 'metre', up: 'y', forward: '+z' },
    parameterSchema: [],
    versions: [{
      versionId, createdAt: '2026-09-07T00:00:00.000Z', inputs: inputs(),
      bundle: { key: hash('bundle-key'), sha256: hash('b'), bytes: 10, producedAt: '2026-09-07T00:00:00.000Z' },
      capabilities: [],
    }],
    runs, checks, reviews: [],
  });
  const run = (over: Partial<ModelRunRecord>): ModelRunRecord => ({
    runId: 'r', kind: 'build', versionId, status: 'succeeded', requestedBy: 'cli',
    startedAt: '2026-09-07T00:00:00.000Z', artifacts: [], checkIds: [], ...over,
  });

  it('earns each rung separately and stops at an unverified export', () => {
    const record = base([run({ runId: 'r1', kind: 'mesh-dump' }), run({ runId: 'r2', kind: 'glb-export' })]);
    expect(modelCapabilities(record, versionId)).toEqual(['source', 'preview', 'mesh-dump', 'glb-exported']);
  });

  it('keeps loadable, placeable, plays-its-own-clips and desk-drivable apart', () => {
    const structural = ['glb-readback-bounds', 'glb-readback-ground', 'glb-readback-parts', 'glb-readback-materials'];
    const check = (gate: string, verdict: 'pass' | 'fail'): ModelCheckRecord =>
      ({ id: gate, gate, versionId, runId: 'r3', applicability: 'applicable', verdict });

    // Reads back with its parts, but a metre too big: loadable, not placeable.
    const loose = base(
      [run({ runId: 'r3', kind: 'glb-readback' })],
      [check('glb-readback-parts', 'pass'), check('glb-readback-bounds', 'fail')],
    );
    expect(modelCapabilities(loose, versionId)).toContain('glb-loadable');
    expect(modelCapabilities(loose, versionId)).not.toContain('desk-placeable');

    // Structurally right, and its clips do nothing: placeable, plays nothing.
    const still = base(
      [run({ runId: 'r3', kind: 'glb-readback' })],
      [...structural.map((gate) => check(gate, 'pass')), check('glb-readback-animation', 'fail')],
    );
    expect(modelCapabilities(still, versionId)).toContain('desk-placeable');
    expect(modelCapabilities(still, versionId)).not.toContain('plays-own-clips');

    // Its own clips move it, but the desk will not take it as a character.
    const solo = base(
      [run({ runId: 'r3', kind: 'glb-readback' })],
      [...structural.map((gate) => check(gate, 'pass')), check('glb-readback-animation', 'pass'), check('glb-readback-character-rig', 'fail')],
    );
    expect(modelCapabilities(solo, versionId)).toContain('plays-own-clips');
    expect(modelCapabilities(solo, versionId)).not.toContain('desk-character-actions');

    // All four only when every gate says so.
    const full = base(
      [run({ runId: 'r3', kind: 'glb-readback' })],
      [...structural.map((gate) => check(gate, 'pass')), check('glb-readback-animation', 'pass'), check('glb-readback-character-rig', 'pass')],
    );
    expect(modelCapabilities(full, versionId)).toEqual(expect.arrayContaining(
      ['glb-loadable', 'desk-placeable', 'plays-own-clips', 'desk-character-actions'],
    ));
  });

  it('withholds verification when a readback check failed or never ran', () => {
    const failed = base(
      [run({ runId: 'r3', kind: 'glb-readback' })],
      [{ id: 'k1', gate: 'glb-readback-bounds', versionId, runId: 'r3', applicability: 'applicable', verdict: 'fail' }],
    );
    expect(modelCapabilities(failed, versionId)).not.toContain('glb-verified');
    const unchecked = base([run({ runId: 'r3', kind: 'glb-readback' })]);
    expect(modelCapabilities(unchecked, versionId)).not.toContain('glb-verified');
  });

  it('reports nothing for a version the record does not have', () => {
    expect(modelCapabilities(base([]), hash('missing'))).toEqual([]);
  });
});

describe('normalisation', () => {
  it('rejects a record whose sources do not contain its entry', () => {
    expect(normalizeModelProjectRecord({
      schemaVersion: 1, id: 'k', kind: 'prop', title: 'k',
      createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
      versions: [{ versionId: hash('v'), inputs: { ...inputs(), sources: [] } }], runs: [], checks: [],
    })?.versions).toEqual([]);
  });

  it('refuses paths that leave the project', () => {
    for (const path of ['/etc/passwd', '../secrets.ts', 'a/../../b', 'https://host/x.ts', 'C:/x.ts', 'a\\b']) {
      expect(isProjectRelativePath(path)).toBe(false);
    }
    expect(isProjectRelativePath('models/knight/knight.ts')).toBe(true);
  });

  it('rejects an unknown schema version or a bad id outright', () => {
    expect(normalizeModelProjectRecord({ schemaVersion: 2, id: 'k', kind: 'prop' })).toBeNull();
    expect(normalizeModelProjectRecord({ schemaVersion: 1, id: '../k', kind: 'prop' })).toBeNull();
  });

  it('keeps an interrupted run as its own state', () => {
    const record = normalizeModelProjectRecord({
      schemaVersion: 1, id: 'k', kind: 'prop', title: 'k',
      createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
      versions: [], checks: [],
      runs: [{ runId: 'r', kind: 'mesh-dump', versionId: hash('v'), status: 'interrupted', requestedBy: 'mcp', startedAt: '2026-09-07T00:00:00.000Z', artifacts: [], checkIds: [] }],
    });
    expect(record?.runs[0]?.status).toBe('interrupted');
  });
});

describe('visual review', () => {
  const versionId = hash('v1');
  const older = hash('v0');
  const note = (over: Partial<ModelReviewNote>): ModelReviewNote => ({
    id: 'n1', versionId, raisedBy: 'user', aspect: 'form',
    concern: '箱体比参考图短了一截', createdAt: '2026-09-08T00:00:00.000Z', status: 'open', ...over,
  });

  it('names what to look at by what the model is for', () => {
    expect(MODEL_REVIEW_ASPECTS.scene).toEqual(['proportion', 'space', 'walkable']);
    expect(MODEL_REVIEW_ASPECTS.character).toEqual(['silhouette', 'rig', 'motion']);
    // A weapon and a vehicle are judged like props, not like people.
    expect(MODEL_REVIEW_ASPECTS.weapon).toEqual(MODEL_REVIEW_ASPECTS.prop);
    expect(MODEL_REVIEW_ASPECTS.vehicle).toEqual(MODEL_REVIEW_ASPECTS.prop);
  });

  it('counts what is still open and says which aspects to look at', () => {
    const summary = modelReviewSummary([
      note({ id: 'n1', aspect: 'form' }),
      note({ id: 'n2', aspect: 'material', status: 'addressed', addressedInVersionId: versionId }),
      note({ id: 'n3', aspect: 'size', status: 'accepted' }),
    ], versionId);
    expect(summary).toMatchObject({ open: 1, addressed: 1, accepted: 1, openAspects: ['form'] });
  });

  it('keeps an unanswered note from an earlier version in view', () => {
    const summary = modelReviewSummary([note({ id: 'n1', versionId: older })], versionId);
    expect(summary.open).toBe(1);
    // Editing the source does not answer a criticism; it only changes the
    // version the criticism is still waiting on.
    expect(summary.carriedOver).toBe(1);
  });

  it('is separate from the gate verdict, because eyes and scripts answer different questions', () => {
    const record = normalizeModelProjectRecord({
      schemaVersion: 1, id: 'crate', kind: 'prop', title: '木箱',
      createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
      versions: [], runs: [], checks: [], reviews: [note({})],
    });
    expect(modelQualitySummary(record!.checks, versionId).verdict).toBe('incomplete');
    expect(modelReviewSummary(record!.reviews, versionId).open).toBe(1);
  });

  it('refuses a note without a concern, a version or a known status', () => {
    const read = (review: unknown) => normalizeModelProjectRecord({
      schemaVersion: 1, id: 'crate', kind: 'prop', title: 'c',
      createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
      versions: [], runs: [], checks: [], reviews: [review],
    })?.reviews ?? [];
    expect(read(note({ concern: '' }))).toEqual([]);
    expect(read({ ...note({}), versionId: 'not-a-hash' })).toEqual([]);
    expect(read({ ...note({}), status: 'maybe' })).toEqual([]);
    expect(read(note({}))).toHaveLength(1);
  });

  it('remembers which version the user confirmed, without touching the others', () => {
    const record = normalizeModelProjectRecord({
      schemaVersion: 1, id: 'crate', kind: 'prop', title: 'c',
      createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
      versions: [], runs: [], checks: [], reviews: [], adoptedVersionId: older,
    });
    expect(record?.adoptedVersionId).toBe(older);
  });
});
