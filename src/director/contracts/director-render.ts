/**
 * Rendering frames, contact sheets and reference videos of a director-desk
 * scene through the open desk. Copied from Studio's
 * packages/contracts/src/api/director-render.ts.
 * @module dsh-film/director/contracts/director-render
 */

/**
 * Rendering a director-desk scene into the project: frames of shots at
 * moments, a reference video of a shot, and a contact sheet — every shot's
 * opening frame on one image.
 *
 * The desktop daemon can render a saved scene in isolated embedded Chromium.
 * Prefer the asynchronous director-background contract for long output jobs.
 * The foreground adapter remains available for older hosts.
 */
import type { DirectorQuerySourceEcho } from './director-query.js';

export type DirectorRenderMoment = 'start' | 'middle' | 'end';

export interface DirectorRenderFrameRequest {
  /** Which shot; the active camera when omitted. */
  cameraId?: string;
  shotId?: string;
  /** A moment in that shot, in scene seconds; wins over `position`. Past the end is the end. */
  at?: number;
  /** The shot's start, its end, or the desk's playhead. */
  position?: 'first' | 'current' | 'last';
  fileName?: string;
}

export interface DirectorRenderRequest {
  /** A board's director node. A scene handed over inline cannot be rendered — nothing holds it. */
  source: {
    boardId: string;
    nodeId?: string;
    project?: string;
  };
  expectedFingerprint?: string;
  frames?: DirectorRenderFrameRequest[];
  /** MP4 of one camera/take, or the ordered cut with sequence:true (exclusive of cameraId/shotId). */
  video?: boolean | { sequence?: boolean; shotId?: string; cameraId?: string; fps?: 24 | 30 | 60 };
  /** One frame per shot on one image, each at the same moment of itself. */
  sheet?: boolean | { moment?: DirectorRenderMoment; cameraIds?: string[]; sequence?: boolean };
  /** Frames and video; the sheet's own cells are always 720p. */
  quality?: '720p' | '1080p';
}

export interface DirectorRenderedFile {
    directorFingerprint?: string;
  kind: 'frame' | 'video' | 'sheet';
  /** Project-relative, for `view_image`, `get_file` and `od files read`. Empty when the page could not put it in the project. */
  path: string;
  /** The same file served: `/api/projects/<id>/raw/<path>`. */
  url: string;
  fileName: string;
  width: number;
  height: number;
  /** The board node that holds it, wired from the director node. */
  nodeId?: string;
  cameraId?: string;
  cameraName?: string;
  shotId?: string;
  sourceIn?: number;
  sourceOut?: number;
  /** Ordered source ranges and their destination seconds; present for sequence output. */
  sequence?: { shots: { shotId: string; cameraId: string; sourceIn: number; sourceOut: number; start: number; end: number }[] };
  /** frame: the moment shown, in scene seconds of that shot. */
  seconds?: number;
  /** video: the shot's length. */
  durationSeconds?: number;
  /** Explicit encoded frame grid; older embedded versions may omit it. */
  frameCount?: number;
  frameRate?: number;
}

export interface DirectorRenderResponse {
  source: DirectorQuerySourceEcho;
  /** The film project the files landed in, as the page reported it. */
  project: string | null;
  desk: 'open' | 'background';
  taskId?: string;
  canvasAttached?: boolean;
  attachmentError?: {code:string;message:string};
  files: DirectorRenderedFile[];
}

/** A logical output job includes rendering, project uploads and durable board save. */
export interface DirectorRenderTask {
  jobId: string;
  label: string;
  phase: 'preparing' | 'rendering' | 'finalizing' | 'saving' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  completedFrames: number;
  totalFrames: number;
  savedOutputs: number;
  error?: string;
}
export interface DirectorRenderStatusRequest { source: DirectorRenderRequest['source'] }
export interface DirectorRenderCancelRequest extends DirectorRenderStatusRequest { jobId: string }
export interface DirectorRenderStatusResponse {
  source: DirectorQuerySourceEcho;
  desk: 'open';
  task: DirectorRenderTask | null;
}
