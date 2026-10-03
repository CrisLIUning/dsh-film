/** Scripts onto the cut: parsing, screenplay dialogue, and the scripts/sound routes on a real cut. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStudioRouter } from '../src/routes.js'
import { StoryService } from '../src/screenwriter/service.js'
import { createEmptyTimelineArchive } from '../src/timeline/archive.js'
import { parseScript, readStories, storyScriptLines } from '../src/timeline/sound.js'
import { TimelineStore } from '../src/timeline/store.js'

let cwd: string
let router: ReturnType<typeof createStudioRouter>

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-sound-'))
  router = createStudioRouter()
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function call(studioPath: string, json?: unknown) {
  const url = new URL(`http://host/api/dsh-film/${json === undefined ? 'studio' : 'studio-write'}`)
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', studioPath)
  if (json !== undefined) url.searchParams.set('method', 'POST')
  const response = await router.dispatch(new Request(url, json === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }))
  return { status: response.status, body: await response.json() as any }
}

/** A cut of two shots, 3 s and 2 s. */
async function cutWithShots(): Promise<void> {
  const archive = createEmptyTimelineArchive('16:9')
  const project = archive.project as Record<string, unknown[]>
  project.visualSegments!.push(
    { id: 'shot-1', name: '推门', kind: 'video', start: 0, duration: 3, trimStart: 0, sourceDuration: 3, assetVersionId: 'canvas-file:canvas/media/a.mp4', director: { shotId: 'desk-shot-a' } },
    { id: 'shot-2', name: '抬头', kind: 'video', start: 3, duration: 2, trimStart: 0, sourceDuration: 2, assetVersionId: 'canvas-file:canvas/media/b.mp4' },
  )
  await new TimelineStore(cwd).save({ document: archive, baseRevision: 0 })
}

async function boardWithScript(text: string): Promise<void> {
  await mkdir(join(cwd, 'film', 'canvas'), { recursive: true })
  await writeFile(join(cwd, 'film', 'canvas', 'document.json'), JSON.stringify({
    id: 'film-1',
    title: '雨夜',
    nodes: [
      { id: 'note-1', type: 'text', title: '对白', position: { x: 0, y: 0 }, metadata: { content: text } },
      { id: 'empty', type: 'text', position: { x: 0, y: 0 }, metadata: { content: '   ' } },
      { id: 'pic', type: 'image', position: { x: 0, y: 0 }, metadata: { content: 'x.png' } },
    ],
    connections: [],
  }))
}

/** A screenplay with one person and two lines of dialogue, through the screenplay service. */
async function screenplayWithDialogue(): Promise<string> {
  const service = new StoryService()
  const created = await service.create(cwd, { title: '雨夜来客' })
  await service.apply(cwd, created.document.documentId, {
    expectedRevision: created.document.revision,
    operations: [
      { kind: 'upsertEntity', entity: { id: 'person_1', kind: 'person', profileBlockId: 'block_p1' }, profileMarkdown: '### 陌生人\n\n戴斗笠。\n' },
      { kind: 'appendBlock', block: { id: 'block_a1', kind: 'action', markdown: '雨很大。\n' } },
      { kind: 'appendBlock', block: { id: 'block_d1', kind: 'dialogue', markdown: '**陌生人**\n借个火。\n' } },
      { kind: 'appendBlock', block: { id: 'block_d2', kind: 'dialogue', markdown: '**掌柜**\n客官里面请。\n' } },
      { kind: 'upsertRecord', collection: 'speech', record: { id: 'speech_1', blockId: 'block_d1', speakerId: 'person_1' } },
    ],
  })
  return created.document.documentId
}

describe('scripts', () => {
  it('reads lines, speakers and shot marks', () => {
    expect(parseScript('第 2 镜\n掌柜：客官里面请。\n#1 陌生人: 借个火\n[desk-shot-a] 雨声\n\n  只有一句  ')).toEqual([
      { text: '客官里面请。', speaker: '掌柜', shot: { number: 2 } },
      { text: '借个火', speaker: '陌生人', shot: { number: 1 } },
      { text: '雨声', shot: { id: 'desk-shot-a' } },
      { text: '只有一句', shot: { id: 'desk-shot-a' } },
    ])
  })

  it('takes a screenplay’s dialogue blocks as its lines, speakers from the screenplay', async () => {
    const documentId = await screenplayWithDialogue()
    const [story] = await readStories(cwd)
    expect(story?.documentId).toBe(documentId)
    expect(storyScriptLines(story!)).toEqual([
      { text: '借个火。', speaker: '陌生人' },
      { text: '客官里面请。', speaker: '掌柜' },
    ])
  })

  it('lists the screenplays with dialogue and the board’s text nodes', async () => {
    const documentId = await screenplayWithDialogue()
    await new StoryService().create(cwd, { title: '没有对白', content: '# 只有描写\n\n雨很大。\n' })
    await boardWithScript('陌生人：借个火\n掌柜：客官里面请')
    const listing = await call('/api/canvas/timelines/film-1/scripts')
    expect(listing.status).toBe(200)
    expect(listing.body.scripts).toEqual(expect.arrayContaining([
      { id: `story:${documentId}`, source: 'story', title: '雨夜来客', lineCount: 2, preview: '陌生人：借个火。' },
      { id: 'note-1', source: 'board', title: '对白', lineCount: 2, preview: '陌生人：借个火' },
    ]))
    // A screenplay with no dialogue has nothing to put on the cut.
    expect(listing.body.scripts.map((script: { id: string }) => script.id).filter((id: string) => id.startsWith('story:'))).toEqual([`story:${documentId}`])
  })
})

describe('putting a script on the cut', () => {
  it('writes one caption per line on the cut’s shots, sharing a shot’s time', async () => {
    await cutWithShots()
    await boardWithScript('第 1 镜\n陌生人：借个火\n掌柜：客官里面请\n第 2 镜\n雨声渐大')
    const placed = await call('/api/canvas/timelines/film-1/sound', { script: { nodeId: 'note-1' }, baseRevision: 1, operationId: 'op1' })
    expect(placed.status).toBe(200)
    expect(placed.body.result.committed).toBe(true)
    expect(placed.body.items).toEqual([
      { index: 0, kind: 'speech', captionId: 'op1-caption-1', shotId: 'desk-shot-a', start: 0, end: 1.5, text: '借个火' },
      { index: 1, kind: 'speech', captionId: 'op1-caption-2', shotId: 'desk-shot-a', start: 1.7, end: 3, text: '客官里面请' },
      { index: 2, kind: 'speech', captionId: 'op1-caption-3', shotId: 'shot-2', start: 3, end: 5, text: '雨声渐大' },
    ])
    const cut = await call('/api/canvas/timelines/film-1')
    expect(cut.body.document.project.captionSegments.map((caption: { id: string; text: string }) => [caption.id, caption.text])).toEqual([
      ['op1-caption-1', '借个火'],
      ['op1-caption-2', '客官里面请'],
      ['op1-caption-3', '雨声渐大'],
    ])
  })

  it('puts a screenplay’s dialogue on the shots in order', async () => {
    await cutWithShots()
    const documentId = await screenplayWithDialogue()
    const placed = await call('/api/canvas/timelines/film-1/sound', { script: { storyDocumentId: documentId }, baseRevision: 1, operationId: 'op2' })
    expect(placed.status).toBe(200)
    expect(placed.body.items.map((item: { text: string; shotId: string }) => [item.text, item.shotId])).toEqual([['借个火。', 'desk-shot-a'], ['客官里面请。', 'shot-2']])
  })

  it('refuses without a reviewed revision, on a stale one, without shots, and for a missing script', async () => {
    await boardWithScript('借个火')
    expect((await call('/api/canvas/timelines/film-1/sound', { script: { nodeId: 'note-1' } })).status).toBe(400)
    expect(await call('/api/canvas/timelines/film-1/sound', { script: { nodeId: 'note-1' }, baseRevision: 0 })).toMatchObject({ status: 422, body: { code: 'CANVAS_TIMELINE_SOUND_NO_SHOTS' } })
    await cutWithShots()
    expect((await call('/api/canvas/timelines/film-1/sound', { script: { nodeId: 'note-1' }, baseRevision: 0 })).status).toBe(409)
    expect(await call('/api/canvas/timelines/film-1/sound', { script: { nodeId: 'nope' }, baseRevision: 1 })).toMatchObject({ status: 404, body: { code: 'CANVAS_TIMELINE_SOUND_NODE_NOT_FOUND' } })
    expect(await call('/api/canvas/timelines/film-1/sound', { script: { storyDocumentId: 'doc_missing' }, baseRevision: 1 })).toMatchObject({ status: 404, body: { code: 'CANVAS_TIMELINE_SOUND_STORY_NOT_FOUND' } })
  })
})
