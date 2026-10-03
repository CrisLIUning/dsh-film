/**
 * The editing desk's document: a Timeline Studio v3 archive, as the editor
 * and its command engine take it (Studio's `video-editor-bridge`
 * `empty-archive.ts`).
 * @module dsh-film/timeline/archive
 */

export type TimelineArchive = Record<string, unknown> & { format: 'timeline-studio-archive'; version: 3; project: Record<string, unknown> }

/**
 * What a cut looks like before anyone has made one: the editor and the engine
 * refuse anything but a v3 archive with a `project`, so "no cut yet" is this
 * skeleton rather than `null`.
 * @param ratioId - the film's aspect, when it has one.
 * @returns the empty archive.
 */
export function createEmptyTimelineArchive(ratioId?: string): TimelineArchive {
  return {
    format: 'timeline-studio-archive',
    version: 3,
    project: {
      ...(ratioId !== undefined ? { ratioId } : {}),
      visualSegments: [],
      visualOverlaySegments: [],
      audioSegments: [],
      musicSegments: [],
      captionSegments: [],
    },
    media: { visuals: [], overlays: [], audioSegments: [], audio: null, sourceAudio: null, music: null },
    vibedevBootstrap: { source: 'canvas-board' },
  }
}

/**
 * Whether a value is a v3 archive with a project: the three facts the engine
 * checks before it touches a document.
 * @param value - anything.
 * @returns whether it is an archive.
 */
export function isTimelineArchive(value: unknown): value is TimelineArchive {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const archive = value as Record<string, unknown>
  return archive.format === 'timeline-studio-archive'
    && archive.version === 3
    && archive.project !== null && typeof archive.project === 'object' && !Array.isArray(archive.project)
}
