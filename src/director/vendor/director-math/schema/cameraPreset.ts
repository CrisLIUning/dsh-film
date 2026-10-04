// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import { validateCameraRoll } from "./cameraOptics.js";
import { migrateCameraMotionTrack } from './cameraMotionClips.js';
import type { DirectorCameraMotionPath, DirectorProject } from './directorProject.js';
import { CAMERA_PATH_TEMPLATES, createCameraPathTemplate, type CameraPathTemplateId } from './cameraPathTemplates.js';
import { getCameraMotionPath, normalizeCameraMotionPath, type CameraMotionSnapshot } from './cameraMotion.js';
import { getCameraPlaybackAtSeconds } from './cameraPlayback.js';
import { getDirectorObjectFocusTarget, isCameraFocusableObject } from './cameraTarget.js';
import { getConstrainedObjectMotionSnapshot } from './routeCollision.js';
import { ensureSceneTimeline } from './sceneTime.js';
import { DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS, type DirectorCameraTargetBodyPart } from './semanticBody.js';
/** A preset compiles the camera's current single path (scene 0 through duration).
 * Range/clip insertion is a separate operation; replacement must be explicit. */
export interface CameraPresetInput {
    cameraId: string;
    presetId: CameraPathTemplateId;
    duration?: number;
    scale?: number;
    targetObjectId?: string | null;
    targetBodyPart?: DirectorCameraTargetBodyPart;
    /** Lens position, not the camera rig. Defaults to the saved camera at scene 0. */
    snapshot?: CameraMotionSnapshot;
    replaceExisting?: boolean;
}
export function parseCameraPresetInput(raw: unknown): CameraPresetInput {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('运镜预设参数必须是对象');
    const value = raw as Record<string, unknown>;
    if (typeof value.cameraId !== 'string' || !value.cameraId.trim())
        throw new Error('运镜预设需要 cameraId');
    if (!CAMERA_PATH_TEMPLATES.some(item => item.id === value.presetId))
        throw new Error('未知运镜预设 presetId');
    for (const [key, min, max] of [['duration', .5, 3600], ['scale', .25, 3]] as const) {
        const n = value[key];
        if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max))
            throw new Error(`${key} 必须在 ${min}–${max} 之间`);
    }
    if (value.targetObjectId !== undefined && value.targetObjectId !== null && (typeof value.targetObjectId !== 'string' || !value.targetObjectId.trim()))
        throw new Error('targetObjectId 必须是对象 id 或 null');
    if (value.targetBodyPart !== undefined && !DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS.some(item => item.value === value.targetBodyPart))
        throw new Error('未知跟踪部位 targetBodyPart');
    if (value.replaceExisting !== undefined && typeof value.replaceExisting !== 'boolean')
        throw new Error('replaceExisting 必须是布尔值');
    let snapshot: CameraMotionSnapshot | undefined;
    if (value.snapshot !== undefined) {
        const v = value.snapshot as CameraMotionSnapshot;
        const point = (p: unknown) => Array.isArray(p) && p.length === 3 && p.every(n => typeof n === 'number' && Number.isFinite(n));
        if (!v || !point(v.position) || !point(v.target) || typeof v.fov !== 'number' || !Number.isFinite(v.fov) || v.fov < 10 || v.fov > 120)
            throw new Error('snapshot 需要有限的 position、target 和 10–120° fov');
        if (Math.hypot(...v.position.map((n, i) => n - v.target[i])) < .001)
            throw new Error('镜头位置与看向点不能重合');
        if (v.roll !== undefined) validateCameraRoll(v.roll);
    snapshot = { position: [...v.position], target: [...v.target], fov: v.fov, ...(v.roll !== undefined ? {roll:v.roll} : {}) };
    }
    return {
        cameraId: value.cameraId, presetId: value.presetId as CameraPathTemplateId,
        ...(value.duration !== undefined ? { duration: value.duration as number } : {}),
        ...(value.scale !== undefined ? { scale: value.scale as number } : {}),
        ...(value.targetObjectId !== undefined ? { targetObjectId: value.targetObjectId as string | null } : {}),
        ...(value.targetBodyPart !== undefined ? { targetBodyPart: value.targetBodyPart as DirectorCameraTargetBodyPart } : {}),
        ...(value.replaceExisting !== undefined ? { replaceExisting: value.replaceExisting as boolean } : {}),
        ...(snapshot ? { snapshot } : {}),
    };
}
/** Pure draft generation. Does not write, seek, select, or change the monitored camera. */
export function compileCameraPreset(project: DirectorProject, raw: CameraPresetInput, sceneStart = 0): DirectorCameraMotionPath {
    if (!Number.isFinite(sceneStart) || sceneStart < 0) throw new Error("预设起点必须是非负场景秒数");
    const input = parseCameraPresetInput(raw);
    const camera = project.cameras.find(item => item.id === input.cameraId);
    if (!camera)
        throw new Error(`机位不存在：${input.cameraId}`);
    if (project.objects.some(item => item.kind === 'camera' && item.linkedCameraId === camera.id && item.locked))
        throw new Error('机位已锁定');
    const definition = CAMERA_PATH_TEMPLATES.find(item => item.id === input.presetId)!;
    const duration = input.duration ?? definition.duration;
    const snapshot = input.snapshot ?? getCameraPlaybackAtSeconds(camera, project.objects, sceneStart, project.scene);
    const target = input.targetObjectId ? project.objects.find(item => item.id === input.targetObjectId && isCameraFocusableObject(item)) : null;
    if (input.targetObjectId && !target)
        throw new Error(`跟踪主体不存在或不可跟踪：${input.targetObjectId}`);
    const bodyPart = input.targetBodyPart ?? (target?.kind === 'character' ? 'chest' : 'center');
    const path = createCameraPathTemplate({
        cameraId: camera.id, templateId: input.presetId, snapshot, scale: input.scale,
        targetObjectId: target?.id ?? null, targetBodyPart: bodyPart,
        focusAt: progress => {
            if (!target)
                return [...snapshot.target];
            const transform = getConstrainedObjectMotionSnapshot(target, sceneStart + progress * duration, project.scene, project.objects);
            return getDirectorObjectFocusTarget({ ...target, transform });
        },
    });
    return normalizeCameraMotionPath({ ...path, ...(snapshot.roll !== undefined ? {roll:snapshot.roll} : {}), duration, preset: { id: definition.id, version: definition.version } }, camera.target, camera);
}
export function applyCameraPreset(project: DirectorProject, input: CameraPresetInput): DirectorProject {
    const path = compileCameraPreset(project, input);
    const camera = project.cameras.find(item => item.id === input.cameraId)!;
    if (camera.motionClips.some(clip => clip.path.keyframes.length) && input.replaceExisting !== true)
        throw new Error('机位已有路线；预览后明确 replaceExisting 才能替换');
    return ensureSceneTimeline({ ...project, cameras: project.cameras.map(item => item.id === camera.id ? migrateCameraMotionTrack({ ...cameraBase(item), motionPath: path }) : item) });
}

function cameraBase(camera: DirectorProject['cameras'][number]) { const { motionClips: _clips, motionDefaults: _defaults, ...base } = camera; return base; }
