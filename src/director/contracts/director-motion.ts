/**
 * Declarative keyframe motion compiled to a skeletal animation. Copied from
 * Studio's packages/contracts/src/api/director-motion.ts.
 * @module dsh-film/director/contracts/director-motion
 */

/** Declarative CPU motion authoring. Uses existing media task IDs and director staging. */
export type DirectorMotionPositionKey = {at:number;position:[number,number,number];stop?:boolean};
export type DirectorMotionRotationKey = {at:number;degrees:[number,number,number];stop?:boolean};
export type DirectorMotionEffectorKey = DirectorMotionPositionKey & {
  /** Source-rig world orientation. */
  degrees?:[number,number,number];
  /** Feet only: local contact relative to neutral ankle. */
  pivot?:[number,number,number];
};
export type DirectorMotionHandKey = {
  at:number; pose:'open'|'relaxed'|'fist'|'point'|'victory'; stop?:boolean;
  /** Each value is 0..1; omitted controls use the pose default, not the previous key. */
  curl?:Partial<Record<'Thumb'|'Index'|'Middle'|'Ring'|'Pinky',number>>;
  spread?:number; thumbOpposition?:number;
};
export interface DirectorCompileMotionRequest {
  requestId: string;
  spec: { schemaVersion: 1; name: string; duration: number; fps: number;
    /** Omitted preserves legacy per-interval ease-in/out. */
    interpolation?:'smooth'|'continuous';
    joints: Record<string, DirectorMotionRotationKey[]>;
    hips?:DirectorMotionPositionKey[];
    /** Horizontal pelvis balance offset, <=.2m per axis; neutral at both ends. */
    bodyOffset?:DirectorMotionPositionKey[];
    feet?:Partial<Record<'LeftFoot'|'RightFoot', DirectorMotionEffectorKey[]>>;
    hands?:Partial<Record<'LeftHand'|'RightHand', DirectorMotionEffectorKey[]>>;
    /** Independent finger controls on characters with complete named phalanx chains. */
    handPoses?:Partial<Record<'LeftHand'|'RightHand', DirectorMotionHandKey[]>>;
  };
}
