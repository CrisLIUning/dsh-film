/**
 * A building the agent writes, and this turns into geometry.
 *
 * The director desk needs somewhere for a scene to happen — a corridor to walk,
 * a room to shoot in. Reconstructing that from a photograph is the hard version
 * of the problem, and it is the wrong version: a reference drawing gives its
 * room programme and its style away for free, but its NUMBERS cannot be trusted.
 * The one this was built against contradicted itself three ways — bay widths
 * summing to 27400 under a 25400 total, storey annotations of 280 against level
 * marks 11.6/5.6/5.1/6.5/8.0 apart, a 2540m² footprint over five floors
 * declared as 8120m². Measuring off a picture inherits all of that.
 *
 * So the split is: the agent AUTHORS the plan — levels, footprint, towers,
 * wings, spine lines, a room programme, where the stairs go — reading the
 * reference for intent rather than for dimensions. This compiles it. Rooms are
 * boxes and walls, which is a deterministic transform and not a reconstruction,
 * so the result carries real dimensions instead of plausible-looking ones and
 * can be validated against itself before anything is built.
 *
 * The output is what the desk actually consumes: solid walls a character is
 * stopped by, slabs to stand on, openings that are real gaps so a camera can
 * see through a window, and one group per level so a shot can address a floor.
 *
 * Ported verbatim from Studio (apps/daemon/src/space-plan.ts), keeping its
 * style; only the imports changed, and the plan types it repeated now come from
 * ./types.ts (the contract copy). Pure: no files, no browser, no three.
 * @module dsh-film/space-plan/compile
 */

import { SpacePlanInputError, assertSpacePlanInput } from './input.js';
import type { SpacePlan, SpacePlanAccessReport, SpacePlanDefaults } from './types.js';
import { inspectSpacePlanAccess, resolveSpacePlanStairs, stairOpeningsAt, subtractPlanRects, planRectsOverlap, type PlanRect } from './access.js';

/** The most parts one plan may compile to. */
export const MAX_SPACE_PARTS = 100_000;

export type { SpacePlan, SpacePlanDefaults, SpacePlanLevel, SpacePlanStair, SpacePlanTower, SpacePlanWing } from './types.js';

const DEFAULTS: SpacePlanDefaults = {
  wallThickness: 900,
  interiorWallThickness: 300,
  slabThickness: 200,
  doorWidth: 1200,
  doorHeight: 2400,
  windowWidth: 1000,
  windowSill: 900,
  windowHeight: 1800,
  stepRun: 280,
};

export type SpacePartKind = 'box' | 'cylinder' | 'cone';
export type SpacePartRole = 'wall' | 'slab' | 'roof' | 'step';

export interface SpacePart {
  name: string;
  /** Which level's group it belongs to, or null for the shell. */
  group: string;
  kind: SpacePartKind;
  role: SpacePartRole;
  /** Centre in metres. */
  position: [number, number, number];
  /** Metres. Boxes use all three; cylinders and cones use [radius, height, radius]. */
  size: [number, number, number];
}

export interface CompiledSpacePlan {
  access:SpacePlanAccessReport;
  parts: SpacePart[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  counts: { walls: number; slabs: number; towers: number; steps: number; openings: number };
  warnings: string[];
}

const MM = 0.001;

/**
 * Everything a plan can say that contradicts something else it says.
 *
 * This is the check the reference drawing would have failed. A compiler without
 * it produces a building that looks right and measures wrong, which is the
 * failure that matters: the desk's collision, ground-snapping and safe-distance
 * all read these numbers as true.
 */
function validatePlanDimensions(plan: SpacePlan): string[] {
  const warnings: string[] = [];
  if (plan.levels.length === 0) {
    warnings.push('平面没有任何楼层');
    return warnings;
  }

  const byId = new Map(plan.levels.map((level) => [level.id, level]));
  if (byId.size !== plan.levels.length) warnings.push('存在重复的楼层 id');

  const ordered = [...plan.levels].sort((a, b) => a.elevation - b.elevation);
  for (let i = 1; i < ordered.length; i += 1) {
    const below = ordered[i - 1]!;
    const top = below.elevation + below.height;
    const gap = ordered[i]!.elevation - top;
    if (Math.abs(gap) > 1) {
      warnings.push(
        `层高不连续:${below.name} 顶面 ${top} 与 ${ordered[i]!.name} 标高 ${ordered[i]!.elevation} 差 ${gap}`,
      );
    }
  }

  for (const level of plan.levels) {
    if (level.height <= 0) warnings.push(`${level.name} 的层高必须大于 0`);
  }

  const spineX = plan.interior?.spineX;
  if (spineX && spineX.length >= 2) {
    const span = spineX[spineX.length - 1]! - spineX[0]!;
    if (Math.abs(span - plan.footprint.width) > 1) {
      warnings.push(`开间分段跨度 ${span} 与外轮廓宽度 ${plan.footprint.width} 不一致`);
    }
    for (let i = 1; i < spineX.length; i += 1) {
      if (spineX[i]! <= spineX[i - 1]!) warnings.push('spineX 必须从小到大且不重复');
    }
  }
  const spineZ = plan.interior?.spineZ;
  if (spineZ && spineZ.length >= 2) {
    const span = spineZ[spineZ.length - 1]! - spineZ[0]!;
    if (Math.abs(span - plan.footprint.depth) > 1) {
      warnings.push(`进深分段跨度 ${span} 与外轮廓进深 ${plan.footprint.depth} 不一致`);
    }
  }

  for (const wing of plan.wings ?? []) {
    for (const levelId of wing.levels) {
      if (!byId.has(levelId)) warnings.push(`${wing.id} 指向不存在的层 ${levelId}`);
    }
  }

  for (const stair of plan.stairs ?? []) {
    const from = byId.get(stair.from);
    const to = byId.get(stair.to);
    if (!from || !to) {
      warnings.push(`${stair.id} 指向不存在的层`);
      continue;
    }
    if (to.elevation <= from.elevation) warnings.push(`${stair.id} 的终点不高于起点`);
  }

  // A level poking out above the towers means the roofs are inside the building.
  const highest = plan.levels.reduce((a, b) => (a.elevation + a.height > b.elevation + b.height ? a : b));
  const shaftTop = Math.max(0, ...(plan.towers ?? []).map((tower) => tower.top));
  if ((plan.towers ?? []).length > 0 && highest.elevation + highest.height > shaftTop + 1) {
    warnings.push(`顶层顶面 ${highest.elevation + highest.height} 高于塔身 ${shaftTop}`);
  }

  warnings.push(...checkPlausible(plan));
  return warnings;
}

/**
 * Bounds a building has to sit inside to be somewhere a person could be.
 *
 * The consistency checks above ask whether a plan agrees with itself, which is
 * the question a reference drawing fails. A plan written without one fails a
 * different question: it agrees with itself perfectly and describes a corridor
 * two hundred metres long, or a storey nobody can stand up in. Numbers invented
 * to sound right have no floor under them, so this puts one there.
 *
 * Deliberately generous, and warnings rather than refusals — a cathedral nave
 * really is twenty metres, and a crawlspace really is a metre. The range is set
 * to catch a misplaced decimal point, not to argue with the author.
 */
const PLAUSIBLE = {
  storeyHeight: [2000, 25000],
  footprintSide: [2000, 400000],
  doorWidth: [700, 6000],
  doorHeight: [1800, 12000],
  stairRise: [80, 250],
  stairGoing: [200, 450],
  towerDiameter: [1000, 60000],
} as const;

function outside(value: number, range: readonly [number, number]): boolean {
  return value < range[0] || value > range[1];
}

function checkPlausible(plan: SpacePlan): string[] {
  const warnings: string[] = [];
  const d: SpacePlanDefaults = { ...DEFAULTS, ...plan.defaults };

  for (const level of plan.levels) {
    if (outside(level.height, PLAUSIBLE.storeyHeight)) {
      warnings.push(`${level.name} 层高 ${level.height}mm 超出常见范围 ${PLAUSIBLE.storeyHeight.join('–')}mm`);
    }
  }
  for (const [label, side] of [['宽度', plan.footprint.width], ['进深', plan.footprint.depth]] as const) {
    if (outside(side, PLAUSIBLE.footprintSide)) {
      warnings.push(`外轮廓${label} ${side}mm 超出常见范围 ${PLAUSIBLE.footprintSide.join('–')}mm`);
    }
  }
  if (outside(d.doorWidth, PLAUSIBLE.doorWidth)) warnings.push(`门宽 ${d.doorWidth}mm 超出常见范围`);
  if (outside(d.doorHeight, PLAUSIBLE.doorHeight)) warnings.push(`门高 ${d.doorHeight}mm 超出常见范围`);

  // An opening taller than the wall it is cut into leaves no lintel, and the
  // wall silently comes out as a gap.
  const shortest = plan.levels.reduce((a, b) => (a.height <= b.height ? a : b), plan.levels[0]!);
  if (shortest && d.doorHeight >= shortest.height) {
    warnings.push(`门高 ${d.doorHeight}mm 不低于最矮的 ${shortest.name}(${shortest.height}mm)`);
  }
  if (shortest && d.windowSill + d.windowHeight >= shortest.height) {
    warnings.push(`窗顶 ${d.windowSill + d.windowHeight}mm 不低于最矮的 ${shortest.name}(${shortest.height}mm)`);
  }

  // A wall thicker than the bay it divides leaves no room between the walls.
  const spineX = plan.interior?.spineX ?? [];
  for (let i = 1; i < spineX.length; i += 1) {
    const bay = spineX[i]! - spineX[i - 1]!;
    if (bay <= d.interiorWallThickness) {
      warnings.push(`第 ${i} 个开间 ${bay}mm 不大于内墙厚 ${d.interiorWallThickness}mm`);
    }
  }

  const levelsById = new Map(plan.levels.map((level) => [level.id, level]));
  for (const stair of plan.stairs ?? []) {
    const from = levelsById.get(stair.from);
    const to = levelsById.get(stair.to);
    if (!from || !to || to.elevation <= from.elevation) continue;
    const going = stair.run ?? d.stepRun;
    if (outside(going, PLAUSIBLE.stairGoing)) {
      warnings.push(`${stair.id} 踏面 ${going}mm 超出常见范围 ${PLAUSIBLE.stairGoing.join('–')}mm`);
    }
    const climb = to.elevation - from.elevation;
    const rise = climb / Math.max(1, Math.round(climb / 175));
    if (outside(rise, PLAUSIBLE.stairRise)) {
      warnings.push(`${stair.id} 踏步高 ${Math.round(rise)}mm 超出常见范围 ${PLAUSIBLE.stairRise.join('–')}mm`);
    }
  }

  for (const tower of plan.towers ?? []) {
    if (outside(tower.diameter, PLAUSIBLE.towerDiameter)) {
      warnings.push(`${tower.id} 直径 ${tower.diameter}mm 超出常见范围`);
    }
    if (tower.top <= 0) warnings.push(`${tower.id} 塔身高度必须大于 0`);
  }

  return warnings;
}

/**
 * Compile a plan into axis-aligned parts (metres), with its counts, bounds,
 * warnings and the access report run on the compiled solids.
 * @param plan - the plan, millimetres.
 * @returns the compiled building.
 * @throws SpacePlanInputError for a malformed plan.
 */
export function compileSpacePlan(plan: SpacePlan): CompiledSpacePlan {
  assertSpacePlanInput(plan);
  const d: SpacePlanDefaults = { ...DEFAULTS, ...plan.defaults };
  const parts: SpacePart[] = [];
  // dsh-film: a hard ceiling on parts, so no plan can make the Host allocate without limit.
  const pushPart = (part: SpacePart) => {
    if (parts.length >= MAX_SPACE_PARTS) throw new SpacePlanInputError(`平面生成的部件超过 ${MAX_SPACE_PARTS} 个，请简化平面`);
    parts.push(part);
  };
  const counts = { walls: 0, slabs: 0, towers: 0, steps: 0, openings: 0 };
  const warnings = validatePlanDimensions(plan);
  const stairs = resolveSpacePlanStairs(plan,d);

  const box = (
    group: string,
    role: SpacePartRole,
    name: string,
    w: number,
    h: number,
    dp: number,
    x: number,
    y: number,
    z: number,
  ) => {
    pushPart({
      name,
      group,
      kind: 'box',
      role,
      position: [x * MM, y * MM, z * MM],
      size: [w * MM, h * MM, dp * MM],
    });
  };

  /**
   * A wall run, with window openings punched at a fixed pitch.
   *
   * The openings are real gaps built as separate spans rather than a texture or
   * a boolean cut: a camera looking through a window has to actually see
   * through it, and a character walking a route has to be stopped by the wall
   * and not by the glass. Keeping it to axis-aligned boxes also keeps the
   * result readable by a collision pass that only understands boxes.
   */
  const wallRun = (
    group: string,
    seg: { x1: number; z1: number; x2: number; z2: number },
    base: number,
    height: number,
    thickness: number,
    pitch: number,
  ) => {
    const horizontal = Math.abs(seg.z2 - seg.z1) < 1;
    const length = horizontal ? Math.abs(seg.x2 - seg.x1) : Math.abs(seg.z2 - seg.z1);
    if (length < 1 || height < 1) return;
    const midX = (seg.x1 + seg.x2) / 2;
    const midZ = (seg.z1 + seg.z2) / 2;

    const openings = pitch > 0 ? Math.max(0, Math.floor(length / pitch) - 1) : 0;
    if (parts.length + openings > MAX_SPACE_PARTS) throw new SpacePlanInputError(`平面生成的部件超过 ${MAX_SPACE_PARTS} 个，请简化平面`);
    const cuts: Array<[number, number]> = [];
    for (let i = 1; i <= openings; i += 1) {
      const centre = (length * i) / (openings + 1);
      cuts.push([centre - d.windowWidth / 2, centre + d.windowWidth / 2]);
    }
    counts.openings += cuts.length;

    const place = (from: number, to: number, yBase: number, yHeight: number, tag: string) => {
      const span = to - from;
      if (span < 1 || yHeight < 1) return;
      const offset = from + span / 2 - length / 2;
      box(
        group,
        'wall',
        `${group}-wall-${tag}`,
        horizontal ? span : thickness,
        yHeight,
        horizontal ? thickness : span,
        horizontal ? midX + offset : midX,
        yBase + yHeight / 2,
        horizontal ? midZ : midZ + offset,
      );
      counts.walls += 1;
    };

    let cursor = 0;
    for (const [from, to] of cuts) {
      if (from > cursor) place(cursor, from, base, height, 'full');
      cursor = to;
    }
    if (cursor < length) place(cursor, length, base, height, 'full');

    const head = d.windowSill + d.windowHeight;
    for (const [from, to] of cuts) {
      place(from, to, base, d.windowSill, 'sill');
      place(from, to, base + head, height - head, 'lintel');
    }
  };

  const rect = (
    group: string,
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    base: number,
    height: number,
    thickness: number,
    pitch: number,
  ) => {
    wallRun(group, { x1, z1, x2, z2: z1 }, base, height, thickness, pitch);
    wallRun(group, { x1, z1: z2, x2, z2 }, base, height, thickness, pitch);
    wallRun(group, { x1, z1, x2: x1, z2 }, base, height, thickness, pitch);
    wallRun(group, { x1: x2, z1, x2, z2 }, base, height, thickness, pitch);
  };

  const slab = (group:string,level:number,rect:PlanRect) => {
    const openings=stairOpeningsAt(stairs,level);
    const pieces=subtractPlanRects(rect,openings);
    pieces.forEach(([x0,z0,x1,z1],i)=>{
      box(group,'slab',`${group}-slab${pieces.length===1?'':`-${i+1}`}`,x1-x0,d.slabThickness,z1-z0,(x0+x1)/2,level-d.slabThickness/2,(z0+z1)/2);
      counts.slabs++;
    });
    counts.openings+=openings.filter(o=>planRectsOverlap(rect,o)).length;
  };

  /* ── levels ─────────────────────────────────────────────────────────────── */
  const pitch = plan.openings?.exteriorWindowPitch ?? 3200;
  const halfW = plan.footprint.width / 2;
  const halfD = plan.footprint.depth / 2;

  for (const level of plan.levels) {
    const group = `${level.id}-${level.name}`;
    slab(group,level.elevation,[-halfW,-halfD,halfW,halfD]);
    rect(group, -halfW, -halfD, halfW, halfD, level.elevation, level.height, d.wallThickness, pitch);

    const hall = plan.interior?.hall;
    const hallOpen = Boolean(hall && hall.levels.includes(level.id));
    const spineX = plan.interior?.spineX ?? [];
    const spineZ = plan.interior?.spineZ ?? [];
    for (const x of spineX.slice(1, -1)) {
      for (let i = 0; i < spineZ.length - 1; i += 1) {
        const z1 = spineZ[i]!;
        const z2 = spineZ[i + 1]!;
        if (hallOpen && hall && x > hall.rect[0] && x < hall.rect[2] && z1 >= hall.rect[1] && z2 <= hall.rect[3]) continue;
        const doorAt = (z1 + z2) / 2;
        const half = d.doorWidth / 2;
        wallRun(group, { x1: x, z1, x2: x, z2: doorAt - half }, level.elevation, level.height, d.interiorWallThickness, 0);
        wallRun(group, { x1: x, z1: doorAt + half, x2: x, z2 }, level.elevation, level.height, d.interiorWallThickness, 0);
        const header = level.height - d.doorHeight;
        if (header > 1) {
          box(group, 'wall', `${group}-header`, d.interiorWallThickness, header, d.doorWidth, x, level.elevation + d.doorHeight + header / 2, doorAt);
          counts.walls += 1;
          counts.openings += 1;
        }
      }
    }
  }

  /* ── towers ─────────────────────────────────────────────────────────────── */
  for (const tower of plan.towers ?? []) {
    const r = tower.diameter / 2;
    pushPart({
      name: `${tower.id}-shaft`,
      group: tower.id,
      kind: 'cylinder',
      role: 'wall',
      position: [tower.at[0] * MM, (tower.top / 2) * MM, tower.at[1] * MM],
      size: [r * MM, tower.top * MM, r * MM],
    });
    const roofHeight = tower.roofHeight ?? 0;
    if (roofHeight > 0) {
      pushPart({
        name: `${tower.id}-roof`,
        group: tower.id,
        kind: 'cone',
        role: 'roof',
        position: [tower.at[0] * MM, (tower.top + roofHeight / 2) * MM, tower.at[1] * MM],
        size: [r * 1.12 * MM, roofHeight * MM, r * 1.12 * MM],
      });
    }
    counts.towers += 1;
  }

  /* ── wings ──────────────────────────────────────────────────────────────── */
  const levelsById = new Map(plan.levels.map((level) => [level.id, level]));
  for (const wing of plan.wings ?? []) {
    const [x1, z1, x2, z2] = wing.rect;
    for (const levelId of wing.levels) {
      const level = levelsById.get(levelId);
      if (!level) continue;
      const group = `${wing.id}-${levelId}`;
      slab(group,level.elevation,[Math.min(x1,x2),Math.min(z1,z2),Math.max(x1,x2),Math.max(z1,z2)]);
      rect(group, x1, z1, x2, z2, level.elevation, level.height, d.wallThickness, pitch);
    }
  }

  /* ── stairs ─────────────────────────────────────────────────────────────────
   * The difference between a model and somewhere a character can walk. The
   * going is given; the rise is derived so the flight lands exactly on the
   * upper floor rather than a step short of it.
   */
  for (const stair of stairs) {
    const axis = stair.start[0] !== stair.end[0] ? 'x' : 'z';
    const axisIndex = axis === 'x' ? 0 : 2;
    const sign = stair.end[axisIndex] > stair.start[axisIndex] ? 1 : -1;
    for (let i = 0; i < stair.steps; i += 1) {
      const y = stair.start[1] + stair.rise * (i + .5);
      const along = sign * stair.going * (i + .5);
      box(stair.id, 'step', `${stair.id}-step-${i + 1}`,
        axis === 'x' ? stair.going : stair.width, stair.rise, axis === 'x' ? stair.width : stair.going,
        stair.start[0] + (axis === 'x' ? along : 0), y, stair.start[2] + (axis === 'z' ? along : 0));
      counts.steps += 1;
    }
  }

  /* ── entrance ───────────────────────────────────────────────────────────── */
  const entrance = plan.entrance;
  if (entrance) {
    for (let i = 0; i < entrance.steps; i += 1) {
      box(
        'entrance',
        'step',
        `entrance-step-${i + 1}`,
        entrance.width,
        entrance.stepRise,
        entrance.stepRun,
        entrance.at[0],
        -(i + 1) * entrance.stepRise + entrance.stepRise / 2,
        entrance.at[1] + i * entrance.stepRun,
      );
      counts.steps += 1;
    }
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    for (let axis = 0; axis < 3; axis += 1) {
      const half = part.kind === 'box' || axis === 1 ? part.size[axis]! / 2 : part.size[axis]!;
      min[axis] = Math.min(min[axis]!, part.position[axis]! - half);
      max[axis] = Math.max(max[axis]!, part.position[axis]! + half);
    }
  }

  const access=inspectSpacePlanAccess(plan,stairs,parts);
  warnings.push(...access.issues.map(i=>i.message));
  return { parts, bounds: { min, max }, counts, warnings, access };
}

/** Same geometry and access checks as compilation; no files are written. */
export function validateSpacePlan(plan:SpacePlan):string[] { return compileSpacePlan(plan).warnings; }
