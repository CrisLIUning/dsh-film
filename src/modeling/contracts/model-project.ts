/**
 * The model project record: what a procedurally built model IS, across every
 * artefact made from it.
 *
 * A model belongs to the PROJECT. The director desk is one place that uses it,
 * a web page is another, and the source stays useful after both. So the record
 * lives with the project and names, in one place, the source, the parameters,
 * the resources, the toolchain, and every artefact derived from them.
 *
 * VERSION IDENTITY IS THE WHOLE POINT. A version is the content hash of the
 * complete input set — the transitive source closure, the declared runtime
 * resources, the parameter values, and the toolchain versions — never the entry
 * file alone. Editing an imported module, swapping a texture or changing a
 * parameter all move the version, which is what makes every earlier bundle,
 * screenshot, gate result and GLB read as "needs update" instead of quietly
 * describing a model that no longer exists.
 *
 * TASK STATUS AND QUALITY VERDICT ARE SEPARATE FIELDS. A run that executed
 * cleanly and produced a failing watertightness gate is a successful run with a
 * failing check — a legal and common outcome. Nothing here lets a run status
 * stand in for a quality verdict, or the reverse.
 *
 * Ported verbatim from Studio (packages/contracts/src/api/model-project.ts),
 * keeping its style. Paths in a record are relative to the Studio project,
 * which is the workspace's film/ folder here.
 * @module dsh-film/modeling/contracts/model-project
 */

/** A file, by project-relative path and content. */
export interface ModelContentRef { path: string; sha256: string; bytes: number }

/** A file some run produced, tied to the version it came from. */
export interface ModelArtifactRef extends ModelContentRef {
  versionId: string;
  runId: string;
  producedAt: string;
}

export const MODEL_KINDS = ['scene', 'character', 'prop', 'weapon', 'vehicle'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

/** Declared so the UI can offer the parameter and the record can pin its value. */
export interface ModelParameterDeclaration {
  key: string;
  label?: string;
  type: 'number' | 'boolean' | 'string' | 'enum';
  default?: unknown;
  min?: number;
  max?: number;
  options?: string[];
}

/**
 * Metres and Y-up are the desk's convention, but a model that declares something
 * else must say so rather than be silently mis-scaled on import.
 */
export interface ModelOrientation {
  unit: 'metre';
  up: 'y' | 'z';
  forward: '+z' | '-z' | '+x' | '-x';
}

/**
 * Everything the version id is computed from. `sources` is the TRANSITIVE
 * closure the bundler actually read, not just the entry.
 */
export interface ModelInputs {
  entry: string;
  sources: ModelContentRef[];
  resources: ModelContentRef[];
  parameters: Record<string, unknown>;
  toolchain: { three: string; bundler: string; bundlerVersion: string; runtime: string };
}

export const MODEL_RUN_KINDS = ['build', 'mesh-dump', 'capture', 'glb-export', 'glb-readback'] as const;
export type ModelRunKind = (typeof MODEL_RUN_KINDS)[number];

/**
 * Whether the WORK ran. `interrupted` is its own state: a daemon restart leaves
 * runs that neither succeeded nor failed, and calling those "failed" would
 * invent a result nobody observed.
 */
export const MODEL_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export type ModelRunStatus = (typeof MODEL_RUN_STATUSES)[number];

export interface ModelRunRecord {
  runId: string;
  kind: ModelRunKind;
  /**
   * Empty until the build resolves one. A run is persisted the moment it starts
   * so a daemon restart can report it as interrupted, and at that point its
   * version is genuinely not known yet — writing a fake one would attach the run
   * to a model state that never existed.
   */
  versionId: string;
  status: ModelRunStatus;
  requestedBy: 'web' | 'cli' | 'mcp';
  clientRequestId?: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
  /** What was asked for, so a retry re-runs the same thing after a restart. */
  input?: {
    entry: string;
    parameters: Record<string, unknown>;
    resources: string[];
    /** Capture-only: the batch this run was asked to take. */
    capture?: {
      cameras?: Array<Record<string, unknown>>;
      passes?: string[];
      /** Project-relative reference the model is compared against. */
      reference?: string;
      review?: Record<string, unknown>;
    };
  };
  artifacts: ModelArtifactRef[];
  checkIds: string[];
}

/**
 * Whether the CHECK applies, and separately what it said. "not-run" and
 * "not-applicable" are not passes: a clean verdict a gate never reached is the
 * failure this pipeline keeps rediscovering.
 */
export const MODEL_CHECK_APPLICABILITY = ['applicable', 'not-applicable', 'not-run'] as const;
export type ModelCheckApplicability = (typeof MODEL_CHECK_APPLICABILITY)[number];

export interface ModelCheckRecord {
  id: string;
  gate: string;
  versionId: string;
  runId: string;
  applicability: ModelCheckApplicability;
  /** Only ever set when applicability is `applicable`. */
  verdict?: 'pass' | 'fail';
  /** Why it does not apply, why it did not run, or what it found. */
  reason?: string;
  evidence?: ModelArtifactRef[];
}

/**
 * What the model can actually be used for.
 *
 * Each rung is earned separately and none of them implies the next. In
 * particular the four claims people run together are kept apart:
 *
 *   glb-loadable          the file reads back and has geometry
 *   desk-placeable        its size, footing and parts agree with the source, so
 *                         a position in a shot means something
 *   plays-own-clips       its own clips actually move it — sampled, not named
 *   desk-character-actions the desk accepts it as a rigged character and can
 *                         drive it with the desk's own action library
 *
 * A model can be loadable and not placeable, placeable and play nothing, and
 * play its own clips without being drivable by the desk's actions.
 */
export const MODEL_ASSET_CAPABILITIES = [
  'source', 'preview', 'mesh-dump', 'captures',
  'glb-exported', 'glb-loadable', 'glb-verified',
  'desk-placeable', 'plays-own-clips', 'desk-character-actions',
] as const;
export type ModelAssetCapability = (typeof MODEL_ASSET_CAPABILITIES)[number];

/**
 * The built bundle lives in the daemon's cache, not in the project: it is
 * derived, it is keyed by its inputs, and a user's project should not fill up
 * with build output. So it is referenced by cache key, not by project path.
 */
export interface ModelBundleRef {
  key: string;
  sha256: string;
  bytes: number;
  producedAt: string;
}

export interface ModelVersionRecord {
  versionId: string;
  createdAt: string;
  inputs: ModelInputs;
  /** Named separately from the run that made it: a version can be rebuilt. */
  bundle?: ModelBundleRef;
  capabilities: ModelAssetCapability[];
}

/**
 * What to LOOK at, by what the model is for.
 *
 * A building is judged on proportion, space and whether you can walk it; a
 * character on silhouette, rig and motion; a prop on form, material and size.
 * Running a crate through a character review is not thoroughness, it is noise —
 * and it teaches people to ignore the result.
 */
export const MODEL_REVIEW_ASPECTS: Record<ModelKind, readonly string[]> = {
  scene: ['proportion', 'space', 'walkable'],
  character: ['silhouette', 'rig', 'motion'],
  prop: ['form', 'material', 'size'],
  weapon: ['form', 'material', 'size'],
  vehicle: ['form', 'material', 'size'],
};

export const MODEL_REVIEW_STATUSES = ['open', 'addressed', 'accepted', 'dismissed'] as const;
export type ModelReviewStatus = (typeof MODEL_REVIEW_STATUSES)[number];

/**
 * One concrete thing somebody said was wrong, against one version.
 *
 * Script gates cannot say whether a model looks like the reference; a person or
 * the main agent looking at the SAME version's preview and captures can. The
 * note carries the version it was raised against, so a fix is checked against
 * the thing that was actually criticised rather than against whatever the
 * source has become since.
 */
export interface ModelReviewNote {
  id: string;
  versionId: string;
  raisedBy: 'user' | 'agent';
  /** Which of the usage's aspects this is about. */
  aspect: string;
  /** The concern, in the reviewer's words. Not a gate name. */
  concern: string;
  evidence?: ModelArtifactRef[];
  createdAt: string;
  status: ModelReviewStatus;
  /** The version that was meant to answer it. */
  addressedInVersionId?: string;
  resolvedAt?: string;
  resolution?: string;
}

export interface ModelProjectRecord {
  schemaVersion: 1;
  id: string;
  kind: ModelKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  orientation: ModelOrientation;
  parameterSchema: ModelParameterDeclaration[];
  /** Newest first. Old versions are kept; they are never rewritten to look current. */
  versions: ModelVersionRecord[];
  runs: ModelRunRecord[];
  checks: ModelCheckRecord[];
  /** Visual review: what people said, against which version. */
  reviews: ModelReviewNote[];
  /** The version the user confirmed for use. Older ones stay adoptable. */
  adoptedVersionId?: string;
}

/* ── path and value hygiene ────────────────────────────────────────────────── */

const HEX64 = /^[0-9a-f]{64}$/;
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, max = 512): string => typeof v === 'string' ? v.trim().slice(0, max) : '';
const iso = (v: unknown): string => {
  const value = text(v, 64);
  return value && !Number.isNaN(Date.parse(value)) ? value : '';
};

/**
 * A project-relative POSIX path and nothing else: no absolute path, no scheme,
 * no traversal, no backslash, no control characters. Same rule the modeling
 * brief applies to reference images, for the same reason.
 */
export function isProjectRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 1000) return false;
  if (value.startsWith('/') || value.includes('://') || /[\\\x00-\x1f]/.test(value)) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function contentRef(value: unknown): ModelContentRef | null {
  const v = rec(value);
  if (!isProjectRelativePath(v.path) || !HEX64.test(text(v.sha256, 64))) return null;
  const bytes = typeof v.bytes === 'number' && Number.isSafeInteger(v.bytes) && v.bytes >= 0 ? v.bytes : 0;
  return { path: v.path, sha256: text(v.sha256, 64), bytes };
}

/* ── version identity ──────────────────────────────────────────────────────── */

/** Recursive key sort, so a parameter object written in another order is the same value. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalValue(source[key]);
    return out;
  }
  // -0 and 0 are the same parameter; NaN and Infinity cannot round-trip JSON.
  if (typeof value === 'number') return Number.isFinite(value) ? value + 0 : null;
  return value;
}

const byPath = (a: ModelContentRef, b: ModelContentRef) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The exact bytes a version id is the hash of.
 *
 * Sorted by path, so the bundler's traversal order cannot change the id; the
 * entry is listed separately AND inside `sources`, so moving the entry between
 * two files with identical content is still a different version.
 */
export function canonicalModelInputs(inputs: ModelInputs): string {
  return JSON.stringify({
    v: 1,
    entry: inputs.entry,
    sources: [...inputs.sources].sort(byPath).map((ref) => [ref.path, ref.sha256]),
    resources: [...inputs.resources].sort(byPath).map((ref) => [ref.path, ref.sha256]),
    parameters: canonicalValue(inputs.parameters ?? {}),
    toolchain: canonicalValue(inputs.toolchain),
  });
}

/** `sha256` is supplied by the caller: node:crypto in the daemon, WebCrypto in a page. */
export function modelVersionId(inputs: ModelInputs, sha256: (text: string) => string): string {
  return sha256(canonicalModelInputs(inputs));
}

export interface ModelInputsDiff {
  changed: boolean;
  entryChanged: boolean;
  addedSources: string[];
  removedSources: string[];
  changedSources: string[];
  addedResources: string[];
  removedResources: string[];
  changedResources: string[];
  changedParameters: string[];
  changedToolchain: string[];
}

/** Says WHY a version moved, so "needs update" can name the file that moved it. */
export function diffModelInputs(previous: ModelInputs, next: ModelInputs): ModelInputsDiff {
  const index = (refs: ModelContentRef[]) => new Map(refs.map((ref) => [ref.path, ref.sha256]));
  const compare = (before: ModelContentRef[], after: ModelContentRef[]) => {
    const from = index(before), to = index(after);
    return {
      added: [...to.keys()].filter((path) => !from.has(path)).sort(),
      removed: [...from.keys()].filter((path) => !to.has(path)).sort(),
      changed: [...to.keys()].filter((path) => from.has(path) && from.get(path) !== to.get(path)).sort(),
    };
  };
  const sources = compare(previous.sources, next.sources);
  const resources = compare(previous.resources, next.resources);
  const keys = (value: Record<string, unknown>) => new Set(Object.keys(value ?? {}));
  const parameterKeys = [...new Set([...keys(previous.parameters), ...keys(next.parameters)])].sort();
  const changedParameters = parameterKeys.filter((key) =>
    JSON.stringify(canonicalValue(previous.parameters?.[key])) !== JSON.stringify(canonicalValue(next.parameters?.[key])));
  const toolchainKeys = ['three', 'bundler', 'bundlerVersion', 'runtime'] as const;
  const changedToolchain = toolchainKeys.filter((key) => previous.toolchain?.[key] !== next.toolchain?.[key]);
  const diff: ModelInputsDiff = {
    changed: false,
    entryChanged: previous.entry !== next.entry,
    addedSources: sources.added, removedSources: sources.removed, changedSources: sources.changed,
    addedResources: resources.added, removedResources: resources.removed, changedResources: resources.changed,
    changedParameters, changedToolchain: [...changedToolchain],
  };
  diff.changed = diff.entryChanged
    || sources.added.length > 0 || sources.removed.length > 0 || sources.changed.length > 0
    || resources.added.length > 0 || resources.removed.length > 0 || resources.changed.length > 0
    || changedParameters.length > 0 || changedToolchain.length > 0;
  return diff;
}

/* ── freshness, quality, capability ────────────────────────────────────────── */

export type ModelArtifactFreshness = 'current' | 'needs-update';

export function modelArtifactFreshness(itemVersionId: string, currentVersionId: string): ModelArtifactFreshness {
  return itemVersionId && itemVersionId === currentVersionId ? 'current' : 'needs-update';
}

export interface ModelQualitySummary {
  applicable: number;
  passed: number;
  failed: number;
  notRun: number;
  notApplicable: number;
  /** `incomplete` whenever an applicable gate has no verdict yet: not a pass. */
  verdict: 'pass' | 'fail' | 'incomplete';
  failedGates: string[];
  notRunGates: string[];
}

/** Quality for ONE version. Checks from other versions are ignored, never counted. */
export function modelQualitySummary(checks: ModelCheckRecord[], versionId: string): ModelQualitySummary {
  const mine = checks.filter((check) => check.versionId === versionId);
  const applicable = mine.filter((check) => check.applicability === 'applicable');
  const failedGates = [...new Set(applicable.filter((check) => check.verdict === 'fail').map((check) => check.gate))].sort();
  const notRunGates = [...new Set(mine.filter((check) => check.applicability === 'not-run').map((check) => check.gate))].sort();
  const passed = applicable.filter((check) => check.verdict === 'pass').length;
  const undecided = applicable.filter((check) => check.verdict !== 'pass' && check.verdict !== 'fail').length;
  return {
    applicable: applicable.length,
    passed,
    failed: failedGates.length,
    notRun: notRunGates.length,
    notApplicable: mine.filter((check) => check.applicability === 'not-applicable').length,
    verdict: failedGates.length > 0 ? 'fail'
      : undecided > 0 || notRunGates.length > 0 || applicable.length === 0 ? 'incomplete'
        : 'pass',
    failedGates,
    notRunGates,
  };
}

/** The artefacts of one version, each with whether it still describes the model. */
export function versionArtifacts(record: ModelProjectRecord, versionId: string): Array<ModelArtifactRef & { kind: ModelRunKind }> {
  return record.runs
    .filter((run) => run.versionId === versionId)
    .flatMap((run) => run.artifacts.map((artifact) => ({ ...artifact, kind: run.kind })));
}

/**
 * What this version is good for, derived from what actually succeeded.
 *
 * Each capability is tied to a specific gate, and a gate that did not run or
 * does not apply grants nothing. An unverified export is a file, not an asset;
 * a model whose clips came back but move nothing does not "play its own clips";
 * and a rig the desk will not accept as a character cannot take the desk's
 * action library, however well it animates on its own.
 */
export function modelCapabilities(record: ModelProjectRecord, versionId: string): ModelAssetCapability[] {
  const version = record.versions.find((entry) => entry.versionId === versionId);
  if (!version) return [];
  const runs = record.runs.filter((run) => run.versionId === versionId);
  const succeeded = (kind: ModelRunKind) => runs.some((run) => run.kind === kind && run.status === 'succeeded');
  const out: ModelAssetCapability[] = ['source'];
  if (version.bundle) out.push('preview');
  if (succeeded('mesh-dump')) out.push('mesh-dump');
  if (succeeded('capture')) out.push('captures');
  if (succeeded('glb-export')) out.push('glb-exported');
  const readbackChecks = record.checks.filter((check) =>
    check.versionId === versionId && check.gate.startsWith('glb-readback') && check.applicability === 'applicable');
  const passed = (gate: string) => readbackChecks.some((check) => check.gate === gate && check.verdict === 'pass');
  if (!succeeded('glb-readback') || readbackChecks.length === 0) return out;
  // It reads back and has geometry. That alone says nothing about its size.
  if (passed('glb-readback-parts')) out.push('glb-loadable');
  // Structure agrees with the source: size, footing, parts, materials.
  const structural = ['glb-readback-bounds', 'glb-readback-ground', 'glb-readback-parts', 'glb-readback-materials'];
  if (structural.every((gate) => passed(gate))) out.push('glb-verified', 'desk-placeable');
  // Its own clips move it — sampled, not merely present.
  if (passed('glb-readback-animation')) out.push('plays-own-clips');
  // And the desk will drive it with its own action library.
  if (passed('glb-readback-character-rig')) out.push('desk-character-actions');
  return out;
}

/* ── normalisation ─────────────────────────────────────────────────────────── */

const MAX_VERSIONS = 200, MAX_RUNS = 500, MAX_CHECKS = 2000, MAX_REVIEWS = 500;

function normalizeInputs(value: unknown): ModelInputs | null {
  const v = rec(value);
  if (!isProjectRelativePath(v.entry)) return null;
  const sources = (Array.isArray(v.sources) ? v.sources : []).slice(0, 2000).map(contentRef).filter(Boolean) as ModelContentRef[];
  if (!sources.some((ref) => ref.path === v.entry)) return null;
  const toolchain = rec(v.toolchain);
  return {
    entry: v.entry,
    sources,
    resources: (Array.isArray(v.resources) ? v.resources : []).slice(0, 2000).map(contentRef).filter(Boolean) as ModelContentRef[],
    parameters: rec(v.parameters),
    toolchain: {
      three: text(toolchain.three, 64),
      bundler: text(toolchain.bundler, 64),
      bundlerVersion: text(toolchain.bundlerVersion, 64),
      runtime: text(toolchain.runtime, 64),
    },
  };
}

function normalizeBundle(value: unknown): ModelBundleRef | null {
  const v = rec(value);
  const key = text(v.key, 64);
  if (!HEX64.test(key) || !HEX64.test(text(v.sha256, 64)) || !iso(v.producedAt)) return null;
  const bytes = typeof v.bytes === 'number' && Number.isSafeInteger(v.bytes) && v.bytes >= 0 ? v.bytes : 0;
  return { key, sha256: text(v.sha256, 64), bytes, producedAt: iso(v.producedAt) };
}

function normalizeArtifact(value: unknown): ModelArtifactRef | null {
  const ref = contentRef(value);
  const v = rec(value);
  if (!ref || !HEX64.test(text(v.versionId, 64)) || !text(v.runId, 128) || !iso(v.producedAt)) return null;
  return { ...ref, versionId: text(v.versionId, 64), runId: text(v.runId, 128), producedAt: iso(v.producedAt) };
}

function normalizeRun(value: unknown): ModelRunRecord | null {
  const v = rec(value);
  const runId = text(v.runId, 128);
  if (!runId || !MODEL_RUN_KINDS.includes(v.kind as ModelRunKind)) return null;
  const versionId = text(v.versionId, 64);
  if ((versionId && !HEX64.test(versionId)) || !MODEL_RUN_STATUSES.includes(v.status as ModelRunStatus)) return null;
  const startedAt = iso(v.startedAt);
  if (!startedAt) return null;
  const input = rec(v.input);
  return {
    runId,
    kind: v.kind as ModelRunKind,
    versionId,
    status: v.status as ModelRunStatus,
    requestedBy: ['web', 'cli', 'mcp'].includes(String(v.requestedBy)) ? v.requestedBy as ModelRunRecord['requestedBy'] : 'web',
    ...(text(v.clientRequestId, 128) ? { clientRequestId: text(v.clientRequestId, 128) } : {}),
    startedAt,
    ...(iso(v.endedAt) ? { endedAt: iso(v.endedAt) } : {}),
    ...(text(v.error, 4000) ? { error: text(v.error, 4000) } : {}),
    ...(isProjectRelativePath(input.entry) ? {
      input: {
        entry: input.entry,
        parameters: rec(input.parameters),
        resources: (Array.isArray(input.resources) ? input.resources : [])
          .slice(0, 2000).filter(isProjectRelativePath),
        ...(input.capture && typeof input.capture === 'object' ? { capture: normalizeCaptureInput(input.capture) } : {}),
      },
    } : {}),
    artifacts: (Array.isArray(v.artifacts) ? v.artifacts : []).slice(0, 200).map(normalizeArtifact).filter(Boolean) as ModelArtifactRef[],
    checkIds: (Array.isArray(v.checkIds) ? v.checkIds : []).slice(0, 200).map((id) => text(id, 128)).filter(Boolean),
  };
}

function normalizeCaptureInput(value: unknown): NonNullable<NonNullable<ModelRunRecord['input']>['capture']> {
  const v = rec(value);
  const reference = isProjectRelativePath(v.reference) ? v.reference : undefined;
  return {
    ...(Array.isArray(v.cameras) ? { cameras: v.cameras.slice(0, 64).map(rec) } : {}),
    ...(Array.isArray(v.passes) ? { passes: v.passes.slice(0, 12).map((item) => text(item, 64)).filter(Boolean) } : {}),
    ...(reference ? { reference } : {}),
    ...(v.review && typeof v.review === 'object' ? { review: rec(v.review) } : {}),
  };
}

function normalizeCheck(value: unknown): ModelCheckRecord | null {
  const v = rec(value);
  const id = text(v.id, 128), gate = text(v.gate, 128);
  if (!id || !gate || !HEX64.test(text(v.versionId, 64))) return null;
  if (!MODEL_CHECK_APPLICABILITY.includes(v.applicability as ModelCheckApplicability)) return null;
  const applicability = v.applicability as ModelCheckApplicability;
  // A verdict outside `applicable` would be exactly the confusion this record
  // exists to prevent, so it is dropped rather than carried.
  const verdict = applicability === 'applicable' && (v.verdict === 'pass' || v.verdict === 'fail') ? v.verdict : undefined;
  return {
    id, gate,
    versionId: text(v.versionId, 64),
    runId: text(v.runId, 128),
    applicability,
    ...(verdict ? { verdict } : {}),
    ...(text(v.reason, 4000) ? { reason: text(v.reason, 4000) } : {}),
    ...(Array.isArray(v.evidence)
      ? { evidence: v.evidence.slice(0, 50).map(normalizeArtifact).filter(Boolean) as ModelArtifactRef[] }
      : {}),
  };
}

function normalizeReview(value: unknown): ModelReviewNote | null {
  const v = rec(value);
  const id = text(v.id, 128), concern = text(v.concern, 4000);
  if (!id || !concern || !HEX64.test(text(v.versionId, 64))) return null;
  if (!MODEL_REVIEW_STATUSES.includes(v.status as ModelReviewStatus)) return null;
  const createdAt = iso(v.createdAt);
  if (!createdAt) return null;
  return {
    id,
    versionId: text(v.versionId, 64),
    raisedBy: v.raisedBy === 'agent' ? 'agent' : 'user',
    aspect: text(v.aspect, 64) || 'general',
    concern,
    ...(Array.isArray(v.evidence)
      ? { evidence: v.evidence.slice(0, 50).map(normalizeArtifact).filter(Boolean) as ModelArtifactRef[] }
      : {}),
    createdAt,
    status: v.status as ModelReviewStatus,
    ...(HEX64.test(text(v.addressedInVersionId, 64)) ? { addressedInVersionId: text(v.addressedInVersionId, 64) } : {}),
    ...(iso(v.resolvedAt) ? { resolvedAt: iso(v.resolvedAt) } : {}),
    ...(text(v.resolution, 4000) ? { resolution: text(v.resolution, 4000) } : {}),
  };
}

/**
 * Where a version stands with its reviewers.
 *
 * Deliberately separate from `modelQualitySummary`: gates and eyes answer
 * different questions, and a model with every gate green and three open visual
 * notes is not finished.
 */
export interface ModelReviewSummary {
  open: number;
  addressed: number;
  accepted: number;
  dismissed: number;
  /** Aspects that still have something open, so a reviewer knows where to look. */
  openAspects: string[];
  /** Notes raised against an EARLIER version and never answered since. */
  carriedOver: number;
}

export function modelReviewSummary(reviews: ModelReviewNote[], versionId: string): ModelReviewSummary {
  const live = reviews.filter((note) => note.status === 'open' || note.status === 'addressed');
  const mine = reviews.filter((note) => note.versionId === versionId);
  const open = live.filter((note) => note.status === 'open');
  return {
    open: open.length,
    addressed: live.filter((note) => note.status === 'addressed').length,
    accepted: mine.filter((note) => note.status === 'accepted').length,
    dismissed: mine.filter((note) => note.status === 'dismissed').length,
    openAspects: [...new Set(open.map((note) => note.aspect))].sort(),
    carriedOver: open.filter((note) => note.versionId !== versionId).length,
  };
}

function normalizeParameter(value: unknown): ModelParameterDeclaration | null {
  const v = rec(value);
  const key = text(v.key, 64);
  if (!key || !['number', 'boolean', 'string', 'enum'].includes(String(v.type))) return null;
  return {
    key,
    ...(text(v.label, 128) ? { label: text(v.label, 128) } : {}),
    type: v.type as ModelParameterDeclaration['type'],
    ...(v.default !== undefined ? { default: canonicalValue(v.default) } : {}),
    ...(typeof v.min === 'number' && Number.isFinite(v.min) ? { min: v.min } : {}),
    ...(typeof v.max === 'number' && Number.isFinite(v.max) ? { max: v.max } : {}),
    ...(Array.isArray(v.options) ? { options: v.options.slice(0, 100).map((o) => text(o, 64)).filter(Boolean) } : {}),
  };
}

/** Read a record off disk without trusting it: it is a file a person can edit. */
export function normalizeModelProjectRecord(value: unknown): ModelProjectRecord | null {
  const v = rec(value);
  if (v.schemaVersion !== 1 || !isModelId(v.id) || !MODEL_KINDS.includes(v.kind as ModelKind)) return null;
  const orientation = rec(v.orientation);
  const createdAt = iso(v.createdAt) || new Date(0).toISOString();
  const versions = (Array.isArray(v.versions) ? v.versions : []).slice(0, MAX_VERSIONS).map((entry) => {
    const e = rec(entry);
    const inputs = normalizeInputs(e.inputs);
    if (!inputs || !HEX64.test(text(e.versionId, 64))) return null;
    return {
      versionId: text(e.versionId, 64),
      createdAt: iso(e.createdAt) || createdAt,
      inputs,
      ...(normalizeBundle(e.bundle) ? { bundle: normalizeBundle(e.bundle)! } : {}),
      capabilities: (Array.isArray(e.capabilities) ? e.capabilities : [])
        .filter((c: unknown): c is ModelAssetCapability => MODEL_ASSET_CAPABILITIES.includes(c as ModelAssetCapability)),
    } satisfies ModelVersionRecord;
  }).filter(Boolean) as ModelVersionRecord[];
  return {
    schemaVersion: 1,
    id: v.id,
    kind: v.kind as ModelKind,
    title: text(v.title, 200) || v.id,
    createdAt,
    updatedAt: iso(v.updatedAt) || createdAt,
    orientation: {
      unit: 'metre',
      up: orientation.up === 'z' ? 'z' : 'y',
      forward: ['+z', '-z', '+x', '-x'].includes(String(orientation.forward)) ? orientation.forward as ModelOrientation['forward'] : '+z',
    },
    parameterSchema: (Array.isArray(v.parameterSchema) ? v.parameterSchema : [])
      .slice(0, 200).map(normalizeParameter).filter(Boolean) as ModelParameterDeclaration[],
    versions,
    runs: (Array.isArray(v.runs) ? v.runs : []).slice(0, MAX_RUNS).map(normalizeRun).filter(Boolean) as ModelRunRecord[],
    checks: (Array.isArray(v.checks) ? v.checks : []).slice(0, MAX_CHECKS).map(normalizeCheck).filter(Boolean) as ModelCheckRecord[],
    reviews: (Array.isArray(v.reviews) ? v.reviews : []).slice(0, MAX_REVIEWS).map(normalizeReview).filter(Boolean) as ModelReviewNote[],
    ...(HEX64.test(text(v.adoptedVersionId, 64)) ? { adoptedVersionId: text(v.adoptedVersionId, 64) } : {}),
  };
}

/** Where a model's record and outputs live inside the project. */
export const MODELS_DIR = 'models';
export function modelDir(modelId: string): string { return `${MODELS_DIR}/${modelId}`; }
export function modelRecordPath(modelId: string): string { return `${modelDir(modelId)}/model.json`; }
/** Outputs are keyed by version, so two versions never overwrite each other's evidence. */
export function modelVersionDir(modelId: string, versionId: string): string {
  return `${modelDir(modelId)}/versions/${versionId.slice(0, 16)}`;
}

/** Forge progress is reported separately from daemon execution and quality checks. */
export interface ModelWorkflow {
  sourceRevision: string;
  kind: ModelKind;
  entries: string[];
  currentStep: string | null;
  currentPass: string | null;
  status: string;
  steps: Array<{ id: string; status: string }>;
  warnings: string[];
}

export interface ModelEnvironment {
  browser: { found: true; kind: 'embedded' | 'system' } | { found: false; kind?: never };
  python: { found: boolean; command?: string; version?: string };
}
