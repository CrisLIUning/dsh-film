/**
 * Wall/floor/ceiling candidates read from a static model's geometry. Copied
 * from Studio's packages/contracts/src/api/director-model-structure.ts.
 * @module dsh-film/director/contracts/director-model-structure
 */

import type { DirectorQuerySource, DirectorQuerySourceEcho } from './director-query.js';
import type { DirectorSpatialProfile, DirectorStagePlan } from './director-stage.js';
export interface DirectorInspectModelRequest { source:DirectorQuerySource; objectId:string }
export interface DirectorInspectModelResponse {
  source:DirectorQuerySourceEcho; fingerprint:string; objectId:string; assetId:string; partCount:number; ignoredSurfaceCount:number;
  sourceChecks:Array<{code:string;message:string;partNames:string[];stairId?:string;levelId?:string}>;
  candidates:Array<{volume:DirectorSpatialProfile['volumes'][number];group:string;evidence:'metadata'|'name'|'bounds';recommended:boolean;warnings:string[];sourcePartIds:string[];composition?:{kind:"stair-flight";parts:number;sourceVolumeIds:string[]}}>;
  /** A review starting point only. Apply with director_stage and the ORIGINAL fingerprint. */
  plan:DirectorStagePlan;
}
