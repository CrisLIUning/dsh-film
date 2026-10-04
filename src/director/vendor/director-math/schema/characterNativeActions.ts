// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
import type { DirectorAssetRef, DirectorObject } from "./directorProject.js";

export type NativeActionClipNames = Partial<Record<string, string>>;
const LEGACY_XBOT: NativeActionClipNames = {
  "crouch-cycle": "sneak_pose",
  "jump-cycle": "idle",
  "run-cycle": "run",
  "side-step-left": "walk",
  "walk-cycle": "walk",
  "wave-cycle": "agree",
};

const LEGACY_SOLDIER: NativeActionClipNames = {
  "crouch-cycle": "idle",
  "jump-cycle": "idle",
  "run-cycle": "run",
  "side-step-left": "walk",
  "walk-cycle": "walk",
  "wave-cycle": "idle",
};

const LEGACY_ROBOT: NativeActionClipNames = {
  "crouch-cycle": "sitting",
  "jump-cycle": "jump",
  "run-cycle": "running",
  "side-step-left": "walking",
  "walk-cycle": "walking",
  "wave-cycle": "wave",
};

// New choices must describe the animation that actually plays. In particular,
// sitting is not crouching, walking is not side-stepping, and idle is not jumping.
export const XBOT_NATIVE_ACTION_CLIPS: NativeActionClipNames = { "walk-cycle": "walk", "run-cycle": "run" };
export const SOLDIER_NATIVE_ACTION_CLIPS: NativeActionClipNames = { "walk-cycle": "walk", "run-cycle": "run" };
export const ROBOT_EXPRESSIVE_ACTION_CLIPS: NativeActionClipNames = {
  "walk-cycle": "walking", "run-cycle": "running", "jump-cycle": "jump", "wave-cycle": "wave",
};
const LEGACY_NAMES = { xbot: LEGACY_XBOT, soldier: LEGACY_SOLDIER, robot: LEGACY_ROBOT, fbx: {} as NativeActionClipNames };
type LegacyFamily = keyof typeof LEGACY_NAMES;
const PRESET_IDS = new Set(Object.keys(LEGACY_XBOT));

export function characterNativeFamily(asset: Pick<DirectorAssetRef, "url" | "modelFormat"> | undefined): LegacyFamily {
  if (!(asset?.modelFormat === "glb" || /\.glb(?:$|[?#])/i.test(asset?.url ?? ""))) return "fbx";
  if (/robot-expressive\.glb(?:$|[?#])/i.test(asset?.url ?? "")) return "robot";
  if (/soldier\.glb(?:$|[?#])/i.test(asset?.url ?? "")) return "soldier";
  return "xbot";
}
export function characterNativeNames(asset: Pick<DirectorAssetRef, "url" | "modelFormat"> | undefined): NativeActionClipNames {
  const family = characterNativeFamily(asset);
  return family === "robot" ? ROBOT_EXPRESSIVE_ACTION_CLIPS : family === "soldier" ? SOLDIER_NATIVE_ACTION_CLIPS
    : family === "xbot" ? XBOT_NATIVE_ACTION_CLIPS : {};
}

/** v7 retains the old resolver explicitly, including its old FBX fallback when
 * the native alias was absent. Never reinterpret an old saved action silently. */
export function parseLegacyCharacterActionId(id: string | null | undefined): { presetId: string; nativeName?: string; family: LegacyFamily } | null {
  const match = /^legacy-action:(xbot|soldier|robot|fbx):([a-z-]+)$/.exec(id ?? "");
  if (!match || !PRESET_IDS.has(match[2])) return null;
  const family = match[1] as LegacyFamily;
  return { presetId: match[2], family, nativeName: LEGACY_NAMES[family][match[2]] };
}
export function characterPresetId(id: string | null | undefined) {
  return parseLegacyCharacterActionId(id)?.presetId ?? id;
}
export function characterNativeClipName(id: string | null | undefined, names: NativeActionClipNames) {
  const legacy = parseLegacyCharacterActionId(id);
  return legacy ? legacy.nativeName : id ? names[id] : undefined;
}

export function migrateCharacterActionSemantics(object: DirectorObject, asset: DirectorAssetRef | undefined): DirectorObject {
  if (object.kind !== "character" || object.characterRig?.rigType !== "mixamo") return object;
  const family = characterNativeFamily(asset), names = characterNativeNames(asset);
  const rewrite = (id: string | null | undefined) => {
    if (!id || !PRESET_IDS.has(id)) return id;
    if (id !== "crouch-cycle" && LEGACY_NAMES[family][id] === names[id]) return id;
    return `legacy-action:${family}:${id}`;
  };
  return {
    ...object,
    characterRig: { ...object.characterRig, actionPresetId: rewrite(object.characterRig.actionPresetId) },
    ...(object.actionClips ? { actionClips: object.actionClips.map(clip => ({ ...clip, actionId: rewrite(clip.actionId) ?? null })) } : {}),
    ...(object.motionClips ? { motionClips: object.motionClips.map(clip => ({ ...clip, keyframes: clip.keyframes.map(point => ({
      ...point,
      ...(point.actionPresetId !== undefined ? { actionPresetId: rewrite(point.actionPresetId) } : {}),
      ...(point.holdActionPresetId !== undefined ? { holdActionPresetId: rewrite(point.holdActionPresetId) } : {}),
    })) })) } : {}),
  };
}

export function referencedLegacyCharacterActions(object: DirectorObject) {
  const ids = [object.characterRig?.actionPresetId, ...(object.actionClips ?? []).map(c => c.actionId),
    ...(object.motionClips ?? []).flatMap(c => c.keyframes.flatMap(p => [p.actionPresetId, p.holdActionPresetId]))];
  return [...new Set(ids.filter((id): id is string => Boolean(parseLegacyCharacterActionId(id))))];
}

/** Metadata of the bundled GLBs; a binary hash test guards replacement of their
 * bytes. Explicit per-project inspection takes priority over these defaults. */
export const BUNDLED_CHARACTER_NATIVE_ANIMATIONS = {
  "robot-expressive.glb": {
    "sha256": "047f5e5fb3bb6d378bd1df16ca6137f2a596c99b3a1b5690b4020c05aaf6f319",
    "clips": [
      {
        "name": "Dance",
        "duration": 3.33333325386047
      },
      {
        "name": "Death",
        "duration": 0.958333313465118
      },
      {
        "name": "Idle",
        "duration": 3.33333325386047
      },
      {
        "name": "Jump",
        "duration": 0.708333313465118
      },
      {
        "name": "No",
        "duration": 1.66666662693024
      },
      {
        "name": "Punch",
        "duration": 0.833333313465118
      },
      {
        "name": "Running",
        "duration": 0.958333313465118
      },
      {
        "name": "Sitting",
        "duration": 0.416666656732559
      },
      {
        "name": "Standing",
        "duration": 0.416666656732559
      },
      {
        "name": "ThumbsUp",
        "duration": 1.58333337306976
      },
      {
        "name": "Walking",
        "duration": 0.958333313465118
      },
      {
        "name": "WalkJump",
        "duration": 0.833333313465118
      },
      {
        "name": "Wave",
        "duration": 1.83333337306976
      },
      {
        "name": "Yes",
        "duration": 1.66666662693024
      }
    ]
  },
  "soldier.glb": {
    "sha256": "dfb230fc1f942f259dd00281a1186953ad602fc5d69067ce63e24b2aa439736b",
    "clips": [
      {
        "name": "Idle",
        "duration": 1.9666666666666694
      },
      {
        "name": "Run",
        "duration": 0.7
      },
      {
        "name": "TPose",
        "duration": 0.03333333333333333
      },
      {
        "name": "Walk",
        "duration": 1.0333333333333332
      }
    ]
  },
  "xbot.glb": {
    "sha256": "002f8d269de68e5dce3d25195caf390d1aa359bbfaae3fcf4c8dc78ec36c3ba5",
    "clips": [
      {
        "name": "agree",
        "duration": 1.8333333333333333
      },
      {
        "name": "headShake",
        "duration": 2.566666666666667
      },
      {
        "name": "idle",
        "duration": 2.5
      },
      {
        "name": "run",
        "duration": 0.7
      },
      {
        "name": "sad_pose",
        "duration": 0.06666666666666667
      },
      {
        "name": "sneak_pose",
        "duration": 0.06666666666666667
      },
      {
        "name": "walk",
        "duration": 0.9666666666666667
      }
    ]
  }
} as const;
export function bundledCharacterNativeClips(asset: DirectorAssetRef | undefined): readonly { name: string; duration: number }[] {
  const match = /(?:^|\/)local-assets\/mixamo\/characters\/(xbot\.glb|soldier\.glb|robot-expressive\.glb)(?:$|[?#])/.exec(asset?.url ?? "");
  if (!match || asset?.storageKey) return [];
  return BUNDLED_CHARACTER_NATIVE_ANIMATIONS[match[1] as keyof typeof BUNDLED_CHARACTER_NATIVE_ANIMATIONS].clips;
}

/** Actual first-clip lengths of the bundled FBX action sources. */
export const BUNDLED_CHARACTER_ACTION_SOURCES = {
  "jump.fbx": {
    "duration": 1.899999976158142,
    "sha256": "47f9865af9a62ad0474d5909032fd3c91a76609e6dd2f63048f641105ce9cf5b"
  },
  "run.fbx": {
    "duration": 0.7166666388511658,
    "sha256": "609f833ec48beb0b0d2c4b3c57b530c9c704c72811ff6a1030677394f2bebde2"
  },
  "side-step-left.fbx": {
    "duration": 1.2333333492279053,
    "sha256": "591f5449fadfa516af8210e2a52e4b85ae623785989ba98c51ebf30e89bb7fff"
  },
  "sit-stand.fbx": {
    "duration": 0.6000000238418579,
    "sha256": "7b930455da1119b357271d72bd8006cc154af375d9d5ca48866414df29b5171c"
  },
  "walk.fbx": {
    "duration": 1.0333333015441895,
    "sha256": "d1e6bd01fa8cb2106679f12714c17f3c880286e5ae635a972ff6fe4bcd2b8305"
  },
  "wave.fbx": {
    "duration": 4.733333110809326,
    "sha256": "8291b7ec647bd01bcef6ff17c61c25ae2c691b6054e44fca92760cf98b83fd4b"
  }
} as const;
