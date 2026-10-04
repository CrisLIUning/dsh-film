/** Shared fixtures of the caption tests: Studio's test cut, a film workspace holding it, and fake engines. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaptionRecognition, CaptionRecognizerInput } from '../../src/captions/contracts.js'
import type { CaptionEngineDriver } from '../../src/captions/engines.js'
import { CaptionService } from '../../src/captions/service.js'
import { FilmMediaTasks } from '../../src/media/tasks.js'
import type { MediaServiceLike } from '../../src/media/tasks.js'
import { TimelineStore } from '../../src/timeline/store.js'

/** Studio's `tests/captions/service.test.ts` cut: two video clips (one trimmed at double speed) and three captions. */
export const original = {
  format: 'timeline-studio-archive',
  version: 3,
  project: {
    visualSegments: [
      { id: 'a', type: 'video', duration: 4, sourceStart: 2, sourceDuration: 8, playbackRate: 2, assetVersionId: 'canvas-file:a.mp4' },
      { id: 'b', type: 'video', duration: 3, assetVersionId: 'canvas-file:b.mp4' },
    ],
    audioSegments: [],
    musicSegments: [],
    captionSegments: [
      { id: 'edge', text: 'boundary', source: 'asr', start: 0, end: 2, fontId: 'custom', audioSegmentId: 'preserve' },
      { id: 'wrong', text: 'incorrect', source: 'asr', start: 2, end: 3 },
      { id: 'last', text: 'outside', start: 6, end: 7 },
    ],
    ratioId: '16:9',
    script: 'boundary\nincorrect\noutside',
  },
  media: {},
}

export const PROJECT = 'p'

export type Recognize = (input: CaptionRecognizerInput & { model: string }) => Promise<CaptionRecognition[]>

/** Every source heard saying one line in its first second. */
export const hearOneLine: Recognize = async input => input.sources.map(source => ({ sourceClipId: source.clipId, segments: [{ text: `heard ${source.clipId}`, start: 0, end: 1 }] }))

/** An engine that recognises with `recognize` and prepares nothing. */
export function fakeEngine(recognize: Recognize = hearOneLine, id: 'whisper' | 'gateway' = 'whisper'): CaptionEngineDriver & { inputs: Array<CaptionRecognizerInput & { model: string }> } {
  const inputs: Array<CaptionRecognizerInput & { model: string }> = []
  return {
    id,
    inputs,
    preflight: async () => ({ model: id === 'whisper' ? 'whisper-small-q8' : 'gateway:asr' }),
    prepare: async () => ({ 'speech-vad': '/api/dsh-film/models/silero-vad/r/speech-vad' }),
    recognize: async (input) => {
      inputs.push(input)
      return recognize(input)
    },
    describe: async () => ({ id, available: true }),
  }
}

export interface Workspace {
  cwd: string
  tasks: FilmMediaTasks
  store: TimelineStore
  service: CaptionService
  cleanup(): Promise<void>
}

/**
 * A workspace with the film's two source files and Studio's cut saved at revision 1.
 * @param engines - the engines the service offers.
 * @param media - dsh-media's service, for the task store.
 */
export async function workspace(engines: ConstructorParameters<typeof CaptionService>[0]['engines'] = { whisper: fakeEngine() }, media: () => MediaServiceLike | undefined = () => undefined): Promise<Workspace> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-film-captions-'))
  await mkdir(join(cwd, 'film'), { recursive: true })
  await writeFile(join(cwd, 'film', 'a.mp4'), 'fixture source A')
  await writeFile(join(cwd, 'film', 'b.mp4'), 'fixture source B')
  const store = new TimelineStore(cwd)
  await store.save({ baseRevision: 0, document: original })
  const tasks = new FilmMediaTasks(media)
  const service = new CaptionService({ tasks, engines, timelines: dir => new TimelineStore(dir) })
  return {
    cwd, tasks, store, service,
    async cleanup() {
      await service.whenIdle()
      tasks.dispose()
      await rm(cwd, { recursive: true, force: true })
    },
  }
}
