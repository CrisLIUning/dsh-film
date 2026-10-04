/**
 * Answers about a director-desk scene computed from its document with the
 * desk's own math: structure, moments, planned events, actions and
 * diagnostics. Ported from Studio's apps/daemon/src/director/query.ts; the
 * diagnostics (and so the dispatcher) are async here, see ./diagnostics.ts.
 * @module dsh-film/director/query
 */

import { lightDirection } from "./vendor/director-math/schema/sceneLighting.js";
import { resolveCameraMicroMotion } from './vendor/director-math/schema/cameraMicroMotionState.js';
import { cameraFrameAspect, focalLengthFromFov } from './vendor/director-math/schema/cameraOptics.js';
import { characterStandingSize } from './vendor/director-math/schema/characterSizing.js';
import { spatialObjectSummary } from './vendor/director-math/schema/spatialProfile.js';
import { canCalibrateModel, resolveModelCalibration } from "./vendor/director-math/schema/modelCalibration.js";
import { sampleCharacterLook } from './vendor/director-math/schema/characterLook.js';
import { characterActionCatalog } from './vendor/director-math/schema/characterActionCatalog.js';
import { CHARACTER_ACTION_MOTION_POLICY, sampleCharacterPerformance, characterHeadingSource } from './vendor/director-math/schema/characterPerformance.js';
import { listSceneEvents, parseSceneEventTime, resolveSceneEventTime } from './vendor/director-math/schema/sceneEvents.js';
import { getDirectorProjectFingerprint } from './vendor/director-math/schema/projectFingerprint.js';
import { CAMERA_PATH_TEMPLATES } from './vendor/director-math/schema/cameraPathTemplates.js';
import { motionClipSource, motionClipRate } from './vendor/director-math/schema/motionClipTime.js';
import { getShotSequence } from './vendor/director-math/schema/shotSequence.js';
// Answers about a director-desk scene, computed from its document with the
// desk's own motion math: structure, moments, planned events and
// diagnostics. None of these queries
// needs the desk to be open.
import type {
  DirectorCameraWithMotionClips as DirectorCameraShot,
  DirectorObject,
  DirectorProject,
} from './vendor/director-math/schema/directorProject.js';
import { VIEWPORT_CAMERA_ASPECT } from './vendor/director-math/schema/cameraGeometry.js';
import { getSceneDuration } from './vendor/director-math/schema/sceneTime.js';
import { getCameraPathTimingPlan } from './vendor/director-math/schema/cameraMotion.js';
import { getObjectMotionClipSpans, getObjectMotionClips } from './vendor/director-math/schema/objectMotion.js';
import type {
  DirectorDiagnosticsQuery,
  DirectorDiagnosticsResponse,
  DirectorFinding,
  DirectorQuery,
  DirectorQueryResponse,
  DirectorQuerySourceEcho,
  DirectorSampleCamera,
  DirectorSampleFrame,
  DirectorSampleObject,
  DirectorSampleQuery,
  DirectorSampleResponse,
  DirectorStructureCamera,
  DirectorStructureObject,
  DirectorStructureResponse,
} from './contracts/index.js';

import {
  arrivalFindings,
  axisFindings,
  Pace,
  routeBlockedFindings,
  screenOrderFindings,
  sharedSampler,
  subjectFramingFindings,
} from './diagnostics.js';
import { characterHeight, frameObject } from './framing.js';
import {
  cameraMomentAt,
  cameraSubjectAt,
  cameraSubjects,
  isFramableObject,
  openQueryScene,
  sampleObjectsAt,
  shotSeconds,
  yawDegrees,
  type QueryScene,
} from './scene.js';

export { resolveDirectorProject } from './scene.js';

export const DIRECTOR_QUERY_DEFAULT_STEP = 0.1;
export const DIRECTOR_QUERY_MIN_STEP = 0.02;
export const DIRECTOR_QUERY_MAX_STEP = 2;
export const DIRECTOR_QUERY_MAX_SAMPLES = 200;
export const DIRECTOR_QUERY_DEFAULT_ASPECT = VIEWPORT_CAMERA_ASPECT;

export class DirectorQueryError extends Error {
  readonly code = 'DIRECTOR_QUERY_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'DirectorQueryError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The query as the wire allows it, or a `DirectorQueryError` saying what is wrong with it. */
export function parseDirectorQuery(value: unknown): DirectorQuery {
  if (!isRecord(value)) throw new DirectorQueryError('query 必须是对象:{ kind: "structure" | "sample" | "diagnostics" }');
  const aspect = (() => {
    if (value.aspect === undefined) return undefined;
    if (!finiteNumber(value.aspect) || value.aspect <= 0 || value.aspect > 10) {
      throw new DirectorQueryError('aspect 是画幅宽高比,例如 1.7778,要在 0 到 10 之间');
    }
    return value.aspect;
  })();
  switch (value.kind) {
    case 'actions':
      if (typeof value.objectId !== 'string' || !value.objectId.trim()) throw new DirectorQueryError('actions 需要人物 objectId');
      return {kind:'actions',objectId:value.objectId.trim()};
    case 'events':
      if(value.objectId!==undefined&&(typeof value.objectId!=='string'||!value.objectId))throw new DirectorQueryError('objectId 必须是对象 ID');
      if(value.includeDerived!==undefined&&typeof value.includeDerived!=='boolean')throw new DirectorQueryError('includeDerived 必须是布尔值');
      return {kind:'events',...(typeof value.objectId==='string'?{objectId:value.objectId}:{}),...(typeof value.includeDerived==='boolean'?{includeDerived:value.includeDerived}:{})};
    case 'structure':
      if (value.includeCameraPresets !== undefined && typeof value.includeCameraPresets !== 'boolean') throw new DirectorQueryError('includeCameraPresets 必须是布尔值');
      return { kind: 'structure', ...(value.includeCameraPresets === true ? { includeCameraPresets: true } : {}) };
    case 'sample': {
      const at = Array.isArray(value.at) ? value.at : value.at !== undefined ? [value.at] : null;
      if (!at || at.length === 0) {
        throw new DirectorQueryError('sample 需要 at:一个或多个不为负的秒数');
      }
      if (at.length > DIRECTOR_QUERY_MAX_SAMPLES) {
        throw new DirectorQueryError(`一次最多采样 ${DIRECTOR_QUERY_MAX_SAMPLES} 个时刻`);
      }
      try { return {kind:'sample',at:at.map(parseSceneEventTime),...(aspect!==undefined?{aspect}:{})}; } catch(error){throw new DirectorQueryError((error as Error).message);}
    }
    case 'diagnostics': {
      const step = (() => {
        if (value.step === undefined) return undefined;
        if (!finiteNumber(value.step) || value.step < DIRECTOR_QUERY_MIN_STEP || value.step > DIRECTOR_QUERY_MAX_STEP) {
          throw new DirectorQueryError(`step 是采样间隔秒数,要在 ${DIRECTOR_QUERY_MIN_STEP} 到 ${DIRECTOR_QUERY_MAX_STEP} 之间`);
        }
        return value.step;
      })();
      const cameraIds = (() => {
        if (value.cameraIds === undefined) return undefined;
        if (!Array.isArray(value.cameraIds) || !value.cameraIds.every((id) => typeof id === 'string' && id)) {
          throw new DirectorQueryError('cameraIds 是机位 id 的数组');
        }
        return value.cameraIds as string[];
      })();
      return {
        kind: 'diagnostics',
        ...(cameraIds ? { cameraIds } : {}),
        ...(step !== undefined ? { step } : {}),
        ...(aspect !== undefined ? { aspect } : {}),
      };
    }
    default:
      throw new DirectorQueryError('kind 只能是 structure、sample、diagnostics、events 或 actions');
  }
}

/* ── structure ────────────────────────────────────────────────────────────── */

function structureObject(object: DirectorObject): DirectorStructureObject {
  const clips = getObjectMotionClips(object).map((clip) => ({
    id: clip.id,
    ...(clip.name ? { name: clip.name } : {}),
    start: clip.start,
    end: clip.end,
    points: clip.keyframes.length,
    source: { ...motionClipSource(clip) },
    rate: motionClipRate(clip),
    visiblePoints: getObjectMotionClipSpans(clip).arrivals.filter(at => at >= clip.start - 1e-6 && at <= clip.end + 1e-6).length,
    holds: clip.keyframes.filter((keyframe) => keyframe.pointBehavior === 'hold').length,
    arrivals: getObjectMotionClipSpans(clip).arrivals.map((seconds) => Number(seconds.toFixed(3))),
  }));
  return {
    id: object.id,
    name: object.name,
    kind: object.kind as DirectorStructureObject['kind'],
    ...(object.light ? {light:object.light,direction:lightDirection(object)} : {}),
    visible: object.visible,
    ...(['scene','prop'].includes(object.kind) ? {spatial:spatialObjectSummary(object)} : {}),
    ...(object.bodyType ? { bodyType: object.bodyType } : {}),
    ...(object.kind === 'character' ? { height: Number(characterHeight(object).toFixed(3)), heightSource: characterStandingSize(object).source, heightApproximate: characterStandingSize(object).approximate, ...(object.heightMetres !== undefined ? {heightMetres:object.heightMetres} : {}) } : {}),
    position: [...object.transform.position],
    yaw: yawDegrees(object.transform.rotation),
    action: object.characterRig?.actionPresetId ?? null,
    clips,
    ...(object.lookClips?.length ? {lookClips: object.lookClips.map(clip=>({...clip,target:{...clip.target},source:{...clip.source}}))} : {}),
    ...(object.actionClips?.length ? { actionClips: object.actionClips.map(clip => ({...clip, source: {...clip.source}})) } : {}),
    ...(object.crowdId ? { crowdId: object.crowdId } : {}),
  };
}

function structureCamera(scene: QueryScene, camera: DirectorCameraShot): DirectorStructureCamera {
  const moment = cameraMomentAt(scene, camera, 0);
  return {
    id: camera.id,
    name: camera.name,
    ...(camera.microMotion ? {microMotion:camera.microMotion} : {}),
    fov: camera.fov,
    ...(camera.filmGate ? {filmGate:camera.filmGate,aspect:cameraFrameAspect(camera),focalLengthMm:focalLengthFromFov(camera.fov,camera.filmGate)} : {}),
    ...(camera.roll !== undefined ? {roll:camera.roll} : {}),
    ...(camera.composition ? {composition:camera.composition} : {}),
    seconds: shotSeconds(camera),
    keyframeCount: camera.motionClips.reduce((sum, clip) => sum + clip.path.keyframes.length, 0),
    clips: camera.motionClips.map(clip => {
      const arrivals = getCameraPathTimingPlan(clip.path)?.arrivals;
      const times = clip.path.keyframes.map((key, index) => clip.start + ((arrivals?.[index] ?? key.time) * clip.path.duration - clip.source.in) / motionClipRate(clip));
      return { id: clip.id, ...(clip.name ? { name: clip.name } : {}), start: clip.start, end: clip.end,
        ...(clip.path.microMotion ? {microMotion:clip.path.microMotion} : {}),
        ...(clip.path.composition ? {composition:clip.path.composition} : {}),
        ...(clip.path.keyframes.some(key=>key.composition) ? {compositionOverrides:clip.path.keyframes.filter(key=>key.composition).length} : {}),
        source: { ...clip.source }, rate: motionClipRate(clip), points: clip.path.keyframes.length,
        visiblePoints: times.filter(at => at >= clip.start - 1e-9 && at <= clip.end + 1e-9).length,
        holds: clip.path.keyframes.filter(key => key.pointBehavior === 'hold').length,
        arrivals: times.map(at => Number(at.toFixed(3))) };
    }),
    active: scene.project.activeCameraId === camera.id,
    view: { position: moment.view.position, target: moment.view.target },
    subject: cameraSubjectAt(camera, 0),
    subjects: cameraSubjects(camera),
  };
}

export function directorStructure(project: DirectorProject, source: DirectorQuerySourceEcho = {}, includeCameraPresets = false): DirectorStructureResponse {
  const scene = openQueryScene(project);
  return {
    kind: 'structure',
    shots: getShotSequence(project),
    version: project.version,
    source,
    timeline: {
      seconds: getSceneDuration(project),
      loop: Boolean(project.timeline.loop),
      ...(project.timeline.loopRange ? { loopRange: project.timeline.loopRange } : {}),
      activeCameraId: project.activeCameraId,
    },
    scene: { collision: scene.scene.pathCollisionEnabled, groundHeight: scene.scene.groundHeight, ...(scene.scene.lighting?{lighting:scene.scene.lighting}:{}) },
    objects: scene.objects.map(structureObject),
    cameras: scene.cameras.map((camera) => structureCamera(scene, camera)),
    ...(includeCameraPresets ? { cameraPresets: CAMERA_PATH_TEMPLATES } : {}),
    assets: project.assets.filter(asset => asset.sourceType === 'model' && asset.kind !== 'panorama').map(asset => ({
      id: asset.id, name: asset.name?.trim() || asset.fileName, fileName: asset.fileName, kind: asset.kind,
      ...(asset.contentSha256 ? { contentSha256: asset.contentSha256 } : {}),
      ...(asset.resourceVersion !== undefined ? { resourceVersion: asset.resourceVersion } : {}),
      ...(asset.modelFormat ? { modelFormat: asset.modelFormat } : {}),
      instances: project.objects.filter(object => object.assetRefId === asset.id).map(object => object.id),
      scaleMode: asset.kind === 'character' ? 'character' as const : asset.url.startsWith('builtin:') ? 'builtin' as const : asset.modelCalibration ? 'physical' as const : 'legacy-fit' as const,
      ...(asset.characterHeightMetres !== undefined ? { characterHeightMetres: asset.characterHeightMetres } : {}),
      ...(asset.modelCalibration ? { modelCalibration: asset.modelCalibration } : {}),
      ...(asset.modelBounds && canCalibrateModel(asset) ? { modelBounds: asset.modelBounds, modelSize: resolveModelCalibration(asset.modelBounds, asset.modelCalibration).size } : {}),
    })),
    spaces: project.assets
      .filter((asset) => asset.kind === 'scene' && asset.sourceType === 'model')
      .map((asset) => ({ id: asset.id, name: asset.name?.trim() || asset.fileName, fileName: asset.fileName })),
  };
}

/* ── sample ───────────────────────────────────────────────────────────────── */

function sampleFrame(scene: QueryScene, t: number, aspect?: number): DirectorSampleFrame {
  const sampled = sampleObjectsAt(scene, t);
  const objects: DirectorSampleObject[] = sampled.map((item) => ({
    id: item.object.id,
    name: item.object.name,
    kind: item.object.kind as DirectorSampleObject['kind'],
    ...(item.object.light ? {light:item.object.light,direction:lightDirection(item.object)} : {}),
    position: [...item.transform.position],
    yaw: yawDegrees(item.transform.rotation),
    action: item.action,
    moving: item.moving,
    speed: Number(item.speed.toFixed(4)),
    holding: item.holding,
    clipId: item.clipId,
    ...(item.object.kind === 'character' ? { look: sampleCharacterLook(item.object,t,scene.project.objects,scene.scene), performance: {
      headingSource: characterHeadingSource(item.object,t),
      layers: sampleCharacterPerformance(item.object,t),
      actionClipId: item.performance.actionClipId,
      source: item.performance.source,
      animationTimeSeconds: item.performance.animationTimeSeconds,
      loop: item.performance.loop,
    } } : {}),
  }));
  const cameras: DirectorSampleCamera[] = scene.cameras.map((camera) => {
    const moment = cameraMomentAt(scene, camera, t, aspect);
    const microMotion = resolveCameraMicroMotion(camera,t);
    const framing = sampled
      .filter((item) => isFramableObject(item.object))
      .map((item) => {
        const result = frameObject(moment.view, moment.aspect, item.object, item.transform);
        return { objectId: item.object.id, name: item.object.name, ...result };
      })
      .sort((a, b) => {
        if (a.screen && b.screen) return a.screen[0] - b.screen[0];
        return a.screen ? -1 : b.screen ? 1 : 0;
      });
    return {
      id: camera.id,
      name: camera.name,
      ...(microMotion ? {microMotion} : {}),
      progress: Number(moment.progress.toFixed(6)),
      ended: moment.ended,
      position: moment.view.position,
      target: moment.view.target,
      fov: moment.view.fov,
      aspect:moment.aspect,
      ...(camera.filmGate ? {filmGate:camera.filmGate,focalLengthMm:focalLengthFromFov(moment.view.fov,camera.filmGate)} : {}),
      ...(moment.view.roll !== undefined ? {roll:moment.view.roll} : {}),
      subject: moment.subject,
      ...(moment.view.compositionClamped ? {compositionClamped:true} : {}),
      framing,
    };
  });
  return { t, objects, cameras };
}

export function directorSample(
  project: DirectorProject,
  query: DirectorSampleQuery,
  source: DirectorQuerySourceEcho = {},
): DirectorSampleResponse {
  const scene = openQueryScene(project);
  const aspect = query.aspect ?? DIRECTOR_QUERY_DEFAULT_ASPECT;
  return {
    kind: 'sample',
    source,
    aspect,
    frames: query.at.map(t=>{try{return sampleFrame(scene,resolveSceneEventTime(project,t),query.aspect);}catch(error){throw new DirectorQueryError((error as Error).message);}}),
  };
}

/* ── diagnostics ──────────────────────────────────────────────────────────── */

export async function directorDiagnostics(
  project: DirectorProject,
  query: DirectorDiagnosticsQuery,
  source: DirectorQuerySourceEcho = {},
): Promise<DirectorDiagnosticsResponse> {
  const scene = openQueryScene(project);
  const step = query.step ?? DIRECTOR_QUERY_DEFAULT_STEP;
  const aspect = query.aspect ?? DIRECTOR_QUERY_DEFAULT_ASPECT;
  const wanted = query.cameraIds ? new Set(query.cameraIds) : null;
  const cameras = scene.cameras.filter((camera) => !wanted || wanted.has(camera.id));
  const options = { step, ...(query.aspect !== undefined ? {aspect:query.aspect} : {}), pace: new Pace(), sample: sharedSampler(scene) };
  const framing: DirectorFinding[] = [];
  for (const camera of cameras) framing.push(...await subjectFramingFindings(scene, camera, options));
  const findings: DirectorFinding[] = [
    ...listSceneEvents(project).filter(event=>event.time===null).map(event=>({code:'event-unresolved' as const,severity:'warning' as const,...(event.objectId?{objectId:event.objectId}:{}),message:`事件「${event.name}」需要重新关联：${event.issue}`})),
    ...framing,
    ...axisFindings(scene, cameras, options),
    ...await routeBlockedFindings(scene, options, cameras),
    ...arrivalFindings(scene, cameras),
    ...screenOrderFindings(scene, cameras, options),
  ];
  // Warnings first: the agent reads the top of the list, and an axis crossed
  // matters more than who stands where.
  const ordered = [...findings.filter((f) => f.severity === 'warning'), ...findings.filter((f) => f.severity === 'info')];
  return {
    kind: 'diagnostics',
    source,
    step,
    aspect,
    cameraIds: cameras.map((camera) => camera.id),
    findings: ordered,
    summary: {
      warnings: ordered.filter((f) => f.severity === 'warning').length,
      infos: ordered.filter((f) => f.severity === 'info').length,
    },
  };
}

/* ── dispatch ─────────────────────────────────────────────────────────────── */

export async function runDirectorQuery(
  project: DirectorProject,
  query: DirectorQuery,
  source: DirectorQuerySourceEcho = {},
): Promise<DirectorQueryResponse> {
  switch (query.kind) {
    case 'actions': {
      const object = project.objects.find(item => item.id === query.objectId);
      if (!object || object.kind !== 'character') throw new DirectorQueryError('actions 需要有效人物');
      return {kind:'actions',source,fingerprint:getDirectorProjectFingerprint(project),objectId:object.id,motionPolicy:{...CHARACTER_ACTION_MOTION_POLICY},
        actions:characterActionCatalog(project,object), clips:(object.actionClips ?? []).map(clip=>({...clip,source:{...clip.source}}))};
    }
    case 'events':
      return {kind:'events',source,fingerprint:getDirectorProjectFingerprint(project),events:listSceneEvents(project).filter(event=>(query.includeDerived!==false||event.kind==='marker')&&(!query.objectId||event.objectId===query.objectId))};
    case 'structure':
      return directorStructure(project, source, query.includeCameraPresets);
    case 'sample':
      return directorSample(project, query, source);
    case 'diagnostics':
      return directorDiagnostics(project, query, source);
  }
}
