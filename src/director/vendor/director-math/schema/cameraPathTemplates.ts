// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { CameraMotionSnapshot } from "./cameraMotion.js";
import type { DirectorCameraMotionPath } from "./directorProject.js";
import type { DirectorCameraTargetBodyPart, DirectorCameraTargetFollowMode } from "./semanticBody.js";
import { add, sub, normalize, length, lengthSq, multiplyScalar, roundTuple, type Vec3 } from "./vec3.js";
export type CameraPathTemplateId = "push-in" | "pull-out" | "pan-left" | "pan-right" | "tilt-up" | "tilt-down" | "truck-left" | "truck-right" | "crane-orbit-up" | "follow" | "parallel-follow" | "handheld" | "over-shoulder-reveal" | "orbit-close" | "crane-orbit-down" | "low-angle-follow" | "overhead-follow" | "foreground-reveal" | "pan-in-place-left" | "pan-in-place-right" | "tilt-in-place-up" | "tilt-in-place-down";
export interface CameraPathTemplateDefinition {
    id: CameraPathTemplateId;
    label: string;
    description: string;
    duration: number;
    group: "official" | "community";
    suitableFor: string;
    version: string;
    contribution?: CameraPathTemplateContribution;
}
export interface CameraPathTemplateContribution {
    contributorName: string | null;
    contact: string | null;
    sourceUrl: string | null;
    license: string;
}
const COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG: CameraPathTemplateContribution = {
    contributorName: "AIGC 耀光",
    contact: "抖音号：AIJPDM001",
    sourceUrl: null,
    license: "群友提供镜头预设构想，项目内置实现",
};
export const CAMERA_PATH_TEMPLATES: CameraPathTemplateDefinition[] = [
    { id: "push-in", label: "推镜", description: "由远到近靠近主体", duration: 5, group: "official", suitableFor: "人物介绍、情绪强调", version: "1.0.0" },
    { id: "pull-out", label: "拉镜", description: "由近到远离开主体", duration: 5, group: "official", suitableFor: "环境揭示、段落收尾", version: "1.0.0" },
    { id: "pan-left", label: "左环绕", description: "原左摇镜：机位绕主体移动，保留原有轨迹", duration: 5, group: "official", suitableFor: "空间关系、人物观察", version: "1.0.0" },
    { id: "pan-right", label: "右环绕", description: "原右摇镜：机位绕主体移动，保留原有轨迹", duration: 5, group: "official", suitableFor: "空间关系、人物观察", version: "1.0.0" },
    { id: "tilt-up", label: "弧线升镜", description: "原俯仰抬镜：机位沿弧线抬升，保留原有轨迹", duration: 5, group: "official", suitableFor: "人物亮相、强调高度", version: "1.0.0" },
    { id: "tilt-down", label: "弧线降镜", description: "原俯拍压镜：机位沿弧线下降，保留原有轨迹", duration: 5, group: "official", suitableFor: "环境交代、俯视主体", version: "1.0.0" },
    { id: "truck-left", label: "左移镜", description: "横向移动制造视差", duration: 5, group: "official", suitableFor: "场景层次、横向揭示", version: "1.0.0" },
    { id: "truck-right", label: "右移镜", description: "横向移动制造视差", duration: 5, group: "official", suitableFor: "场景层次、横向揭示", version: "1.0.0" },
    { id: "crane-orbit-up", label: "环绕摇臂升镜", description: "一边环绕一边升高", duration: 8, group: "community", suitableFor: "人物出场、场景揭示、高潮镜头", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
    { id: "follow", label: "跟拍", description: "保持距离跟随运动主体", duration: 6, group: "community", suitableFor: "走路、跑步、运动主体", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
    { id: "parallel-follow", label: "平行跟拍", description: "在主体侧面同步移动", duration: 6, group: "community", suitableFor: "人物行进、车辆侧拍", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
    { id: "handheld", label: "手持晃镜", description: "轻微不规则手持运动", duration: 6, group: "community", suitableFor: "纪实、紧张、主观现场感", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
    { id: "over-shoulder-reveal", label: "过肩绕正面", description: "从人物侧后方绕到正面", duration: 7, group: "community", suitableFor: "对话、人物亮相、情绪转折", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
    { id: "orbit-close", label: "近景半环绕", description: "保持近景距离做半环绕", duration: 7, group: "community", suitableFor: "人物特写、产品细节", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
    { id: "crane-orbit-down", label: "环绕摇臂降镜", description: "一边环绕一边降低机位", duration: 8, group: "community", suitableFor: "落到主体、从全景进入表演", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
    { id: "low-angle-follow", label: "低机位追拍", description: "贴近地面跟随运动主体", duration: 6, group: "community", suitableFor: "奔跑、车辆、力量感", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
    { id: "overhead-follow", label: "俯视跟拍", description: "从主体上方同步跟随", duration: 6, group: "community", suitableFor: "路线交代、群像、运动场面", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
    { id: "foreground-reveal", label: "横移揭示", description: "横向越过前景逐步露出主体", duration: 6, group: "community", suitableFor: "悬念揭示、空间转场", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
    { id: "pan-in-place-left", label: "原地左摇", description: "镜头位置固定，向左转动朝向", duration: 5, group: "official", suitableFor: "横向观察、揭示空间", version: "1.0.0" },
    { id: "pan-in-place-right", label: "原地右摇", description: "镜头位置固定，向右转动朝向", duration: 5, group: "official", suitableFor: "横向观察、揭示空间", version: "1.0.0" },
    { id: "tilt-in-place-up", label: "原地上摇", description: "镜头位置固定，向上抬起朝向", duration: 5, group: "official", suitableFor: "建筑高度、人物亮相", version: "1.0.0" },
    { id: "tilt-in-place-down", label: "原地下摇", description: "镜头位置固定，向下压低朝向", duration: 5, group: "official", suitableFor: "上下空间关系、细节揭示", version: "1.0.0" },
];
export function getCameraPathTemplatesByGroup(group: CameraPathTemplateDefinition["group"]) {
    return CAMERA_PATH_TEMPLATES.filter((template) => template.group === group);
}
const STANDARD_TIMES = [0, .5, 1];
const HANDHELD_TIMES = [0, .16, .33, .5, .67, .84, 1];
const CINEMATIC_TIMES = [0, .25, .5, .75, 1];
const radians = (degrees: number) => degrees * (Math.PI / 180);
const scaledAdd = (a: Vec3, b: Vec3, scale: number): Vec3 => [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Quaternion axis-angle rotation; arithmetic matches the original three implementation. */
function rotate(v: Vec3, axis: Vec3, angle: number): Vec3 {
    const s = Math.sin(angle / 2), w = Math.cos(angle / 2);
    const [x, y, z] = multiplyScalar(axis, s), [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx];
}
export const isInPlaceCameraTemplate = (id: string) => id.startsWith("pan-in-place-") || id.startsWith("tilt-in-place-");
export function createCameraPathTemplate({ cameraId, focusAt, scale = 1, snapshot, targetObjectId = null, targetBodyPart = "center", targetFollowMode = "immediate", templateId }: {
    cameraId: string;
    focusAt: (progress: number) => Vec3;
    scale?: number;
    snapshot: CameraMotionSnapshot;
    targetObjectId?: string | null;
    targetBodyPart?: DirectorCameraTargetBodyPart;
    targetFollowMode?: DirectorCameraTargetFollowMode;
    templateId: CameraPathTemplateId;
}): DirectorCameraMotionPath {
    const definition = CAMERA_PATH_TEMPLATES.find(item => item.id === templateId);
    if (!definition)
        throw new Error(`Unknown camera path template: ${templateId}`);
    const range = Math.max(.25, Math.min(3, Number.isFinite(scale) ? scale : 1));
    const motionRange = definition.group === "community" ? 1 : range;
    const times = templateId === "handheld" ? HANDHELD_TIMES : templateId === "over-shoulder-reveal" || templateId === "orbit-close" ? CINEMATIC_TIMES : STANDARD_TIMES;
    let baseOffset = sub(snapshot.position, focusAt(.5));
    if (lengthSq(baseOffset) < .25)
        baseOffset = [0, 1.4, 6];
    let radial: Vec3 = [baseOffset[0], 0, baseOffset[2]];
    if (lengthSq(radial) < .0001)
        radial = [0, 0, 1];
    radial = normalize(radial);
    const up: Vec3 = [0, 1, 0], right = normalize(cross(multiplyScalar(radial, -1), up));
    const movement = sub(focusAt(1), focusAt(0));
    movement[1] = 0;
    const moving = lengthSq(movement) > .0001;
    const side = moving ? normalize(cross(normalize(movement), up)) : right;
    const distance = Math.max(2, length(baseOffset));
    const jitter = [[0, 0, 0], [.08, .04, -.03], [-.05, -.03, .04], [.06, -.02, 0], [-.07, .03, -.02], [.04, -.04, .03], [0, 0, 0]];
    const offsetAt = (t: number, i: number): Vec3 => {
        const c = t - .5;
        switch (templateId) {
            case "push-in":
            case "pull-out": return multiplyScalar(baseOffset, 1 + (templateId === "push-in" ? -1 : 1) * c * .7 * motionRange);
            case "pan-left":
            case "pan-right": return rotate(baseOffset, up, (templateId === "pan-left" ? -1 : 1) * c * radians(55) * motionRange);
            case "tilt-up":
            case "tilt-down": return rotate(baseOffset, right, (templateId === "tilt-up" ? -1 : 1) * c * radians(42) * motionRange);
            case "truck-left":
            case "truck-right": return scaledAdd(baseOffset, right, (templateId === "truck-left" ? -1 : 1) * c * distance * .75 * motionRange);
            case "crane-orbit-up": return scaledAdd(rotate(baseOffset, up, t * radians(65) * motionRange), up, t * distance * .45 * motionRange);
            case "parallel-follow": return moving ? scaledAdd(multiplyScalar(side, distance), up, Math.max(.8, baseOffset[1])) : scaledAdd(baseOffset, right, c * distance * .9 * motionRange);
            case "follow": return scaledAdd(baseOffset, radial, c * distance * .18 * motionRange);
            case "over-shoulder-reveal": return multiplyScalar(rotate(baseOffset, up, radians(-30 + t * 105) * motionRange), 1 - t * .28);
            case "orbit-close": return rotate(multiplyScalar(baseOffset, .72), up, c * radians(125) * motionRange);
            case "crane-orbit-down": return scaledAdd(rotate(baseOffset, up, t * radians(65) * motionRange), up, -t * Math.max(.8, baseOffset[1]) * .7 * motionRange);
            case "low-angle-follow": return scaledAdd(scaledAdd(multiplyScalar(radial, distance * .82), up, .35), right, c * distance * .25 * motionRange);
            case "overhead-follow": return scaledAdd(scaledAdd(multiplyScalar(radial, distance * .32), up, Math.max(3, distance * 1.05)), right, c * distance * .2 * motionRange);
            case "foreground-reveal": return scaledAdd(scaledAdd(baseOffset, right, c * distance * 1.35 * motionRange), radial, -t * distance * .18 * motionRange);
            default: {
                const j = jitter[i] ?? jitter[0];
                return scaledAdd(scaledAdd(scaledAdd(baseOffset, right, j[0] * distance * motionRange), up, j[1] * distance * motionRange), radial, j[2] * distance * motionRange);
            }
        }
    };
    const inPlace = isInPlaceCameraTemplate(templateId);
    return {
        duration: definition.duration, loop: false, interpolation: templateId === "handheld" ? "linear" : "smooth", easing: templateId === "handheld" ? "linear" : "ease-in-out",
        keyframes: times.map((time, index) => {
            let target = focusAt(time), position: Vec3;
            if (inPlace) {
                position = [...snapshot.position];
                const aim = sub(targetObjectId ? focusAt(0) : snapshot.target, position);
                const horizontal = templateId.startsWith("pan-");
                const direction = templateId.endsWith("left") || templateId.endsWith("up") ? 1 : -1;
                const aimRight = normalize(cross(normalize(aim), up));
                const axis = horizontal ? up : lengthSq(aimRight) < .0001 ? right : aimRight;
                target = add(position, rotate(aim, axis, time * radians(horizontal ? 55 : 42) * range * direction));
            }
            else {
                const offset = offsetAt(time, index);
                position = add(target, definition.group === "community" ? multiplyScalar(offset, range) : offset);
            }
            return { id: `${cameraId}_${templateId}_${index + 1}`, time, position: roundTuple(position), target: roundTuple(target), fov: snapshot.fov,
                targetMode: targetObjectId && !inPlace ? "object" : "manual", targetObjectId: inPlace ? null : targetObjectId, targetBodyPart, targetFollowMode };
        }),
    };
}
