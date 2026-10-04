/**
 * The space plan contract: the plan the agent writes (millimetres), the compile
 * request and answer, and the access report. Ported verbatim from Studio
 * (packages/contracts/src/api/space-plan.ts), keeping its style.
 * @module dsh-film/space-plan/types
 */

/**
 * A building, described well enough to compile.
 *
 * The director desk needs somewhere for a scene to happen. Reconstructing that
 * from a photograph is the hard version of the problem and the wrong one: a
 * reference image gives away its room programme, its topology and its style for
 * free, and its numbers cannot be trusted. Most spaces will not have a
 * reference at all — a film starts from a script, not from architectural
 * drawings.
 *
 * So the agent authors this, and the daemon turns it into geometry. Rooms are
 * boxes and walls, which is a deterministic transform rather than a
 * reconstruction, so the result carries real dimensions and can be checked
 * before anything is built.
 *
 * Every length is millimetres. The compiled geometry is metres, because that is
 * what the desk works in; the conversion is the compiler's business, not the
 * author's.
 */

export interface SpacePlanLevel {
  id: string;
  name: string;
  /** Floor level relative to the ground floor. Negative goes underground. */
  elevation: number;
  /** Floor to ceiling. */
  height: number;
  /** What is on this floor. Carried through for the desk and the agent to read;
   *  the compiler does not lay rooms out from it. */
  rooms?: string[];
}

export interface SpacePlanTower {
  id: string;
  /** Centre as [x, z]. */
  at: [number, number];
  diameter: number;
  /** Top of the shaft. The roof cone sits on it. */
  top: number;
  roofHeight?: number;
}

export interface SpacePlanWing {
  id: string;
  /** [x1, z1, x2, z2]. */
  rect: [number, number, number, number];
  /** Which levels this wing exists on. */
  levels: string[];
}

export interface SpacePlanStair {
  id: string;
  /** Runs from the top of `from` to the floor of `to`. */
  from: string;
  to: string;
  /** Foot of the flight as [x, z]. */
  at: [number, number];
  width: number;
  direction: 'north' | 'south' | 'east' | 'west';
  /** Going per tread. The rise is derived so the flight lands exactly. */
  run?: number;
  /** Landing depth at each end. Defaults to the stair width. */
  landingDepth?: number;
  /** Required clear height above treads/platforms. Defaults to doorHeight. */
  headroom?: number;
}

export interface SpacePlanDefaults {
  wallThickness: number;
  interiorWallThickness: number;
  slabThickness: number;
  doorWidth: number;
  doorHeight: number;
  windowWidth: number;
  windowSill: number;
  windowHeight: number;
  stepRun: number;
}

export interface SpacePlan {
  name: string;
  defaults?: Partial<SpacePlanDefaults>;
  footprint: { width: number; depth: number };
  levels: SpacePlanLevel[];
  towers?: SpacePlanTower[];
  wings?: SpacePlanWing[];
  stairs?: SpacePlanStair[];
  interior?: {
    /** Partition lines. The first and last are the outer walls. */
    spineX?: number[];
    spineZ?: number[];
    /** A double-height space that keeps its partitions out. */
    hall?: { rect: [number, number, number, number]; levels: string[] };
  };
  openings?: {
    /** Distance between exterior windows. 0 leaves the walls blank. */
    exteriorWindowPitch?: number;
  };
  entrance?: { at: [number, number]; width: number; steps: number; stepRise: number; stepRun: number };
}

export interface SpacePlanCompileRequest {
  plan: SpacePlan;
  /** Where the glb goes inside the project. Defaults under `spaces/`. */
  output?: string;
  /** Refuse to write when the plan produced warnings. Off by default: most
   *  warnings are worth seeing rather than blocking on. */
  strict?: boolean;
  /** Compile and report, write nothing. Authoring a building is iterative —
   *  the counts and the warnings are how the author finds out whether the plan
   *  they just wrote is the building they meant. */
  dryRun?: boolean;
}

export interface SpacePlanCompileResponse {
  access: SpacePlanAccessReport;
  /** Whether anything was written. False for a dry run. */
  written: boolean;
  /** Project-relative path of the glb, written or the one that would be. */
  file: string;
  /** What the daemon serves it at, so a host can hand it straight to the desk. */
  url: string;
  bytes: number;
  counts: { walls: number; slabs: number; towers: number; steps: number; openings: number };
  /** Metres. */
  size: { width: number; height: number; depth: number };
  /** One group per level, named `<id>-<name>`, so a shot can address a floor. */
  levels: string[];
  /** Everything the plan says that contradicts something else it says, or that
   *  falls outside the range a building sits in. Never fatal unless `strict`. */
  warnings: string[];
}

/** Original plan dimensions, in millimetres; not calibrated scene coordinates. */
export interface SpacePlanStairAccess {
  id:string;from:string;to:string;start:[number,number,number];end:[number,number,number];
  steps:number;rise:number;going:number;width:number;headroom:number;landingDepth:number;
  footprint:[number,number,number,number];lowerLanding:[number,number,number,number];upperLanding:[number,number,number,number];
}
export interface SpacePlanAccessIssue {
  code:'stair-outside-floor'|'landing-without-floor'|'stair-clearance-blocked'|'floor-unreachable';
  message:string;stairId?:string;levelId?:string;partNames:string[];
}
export interface SpacePlanAccessReport {units:'mm';stairs:SpacePlanStairAccess[];issues:SpacePlanAccessIssue[]}
