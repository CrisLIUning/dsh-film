/**
 * The renderer download: the pinned FFmpeg the background render can fetch
 * after the person agrees (ported from Studio's win-ffmpeg pack test, over the
 * editing desk's model store). The packaged pin, where it is offered, the
 * consent gate, and — with a zip made here by Windows' tar.exe and served by a
 * fake network — unpacking, per-file checks, LICENSE.txt and SOURCE.txt, and
 * the render route finding the result.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilmMediaTasks } from '../../src/media/tasks.js'
import { EditorModels, packagedModelManifests, rendererManifests } from '../../src/models/service.js'
import type { EditorModelManifest } from '../../src/models/service.js'
import { createProject } from '../../src/project.js'
import type { TimelineRenderInput, TimelineRenderOutput } from '../../src/render/timeline-render.js'
import { createStudioRouter } from '../../src/routes.js'
import { modelFileRoutes } from '../../src/studio/model-routes.js'
import { createEmptyTimelineArchive } from '../../src/timeline/archive.js'
import { TimelineStore } from '../../src/timeline/store.js'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const RENDERER = 'ffmpeg-win64-gpl-shared-9.0'
const GATEWAY = 'https://vibedev.jzsaas.com/marketplace/v2/blobs/sha256/'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-film-renderer-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the packaged renderer', () => {
  const [ffmpeg] = rendererManifests()

  it('is the FFmpeg build VibeDev Studio ships, pinned by size and digest, from the gateway first', () => {
    expect(rendererManifests()).toHaveLength(1)
    expect(ffmpeg).toMatchObject({ id: RENDERER, capability: 'renderer', platforms: ['win32-x64'], license: { name: 'GPL-2.0-or-later' } })
    expect(ffmpeg!.artifacts).toEqual([{
      id: 'archive',
      fileName: 'ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-shared-9.0.zip',
      bytes: 86_333_540,
      sha256: '64f7d1460ce986804386582eeec3bd95117a4e84f7567ad416dd33f434fe8286',
      sources: [
        `${GATEWAY}64f7d1460ce986804386582eeec3bd95117a4e84f7567ad416dd33f434fe8286`,
        'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-shared-9.0.zip',
      ],
    }])
  })

  it('keeps ffmpeg, every DLL it loads and the licence — not ffprobe or ffplay — each with its own digest', () => {
    const archive = ffmpeg!.archive!
    expect(archive.root).toBe('ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-shared-9.0')
    expect(archive.program).toBe('ffmpeg.exe')
    expect(archive.files.map(file => file.fileName).sort()).toEqual([
      'LICENSE.txt', 'avcodec-63.dll', 'avdevice-63.dll', 'avfilter-12.dll', 'avformat-63.dll', 'avutil-61.dll', 'ffmpeg.exe', 'swresample-7.dll', 'swscale-10.dll',
    ])
    for (const file of archive.files) {
      expect(file.path).toBe(file.fileName === 'LICENSE.txt' ? 'LICENSE.txt' : `bin/${file.fileName}`)
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.bytes).toBeGreaterThan(0)
    }
    expect(archive.files.find(file => file.fileName === 'avcodec-63.dll')?.bytes).toBe(119_112_704)
    // SOURCE.txt names the FFmpeg commit and the build, as Studio's does.
    expect(archive.sourceNote.join('\n')).toContain('from FFmpeg commit 46d8f462ee on the release/9.0 branch of https://git.ffmpeg.org/ffmpeg.git')
    expect(archive.sourceNote.join('\n')).toContain('autobuild-2026-10-01-13-06')
  })

  it('tells the person it is a separate program, its licence, its size and its source', () => {
    const notice = ffmpeg!.license.notice!
    expect(ffmpeg!.label).toContain('独立程序')
    expect(notice).toContain('独立的开源程序')
    expect(notice).toContain('GPL')
    expect(notice).toContain('约 86 MB')
    expect(notice).toContain('46d8f462ee')
    expect(notice).toContain('LICENSE.txt')
    expect(ffmpeg!.license.url).toMatch(/^https:\/\//)
  })

  it('is offered on Windows x64 only, beside the editor models, and served by no model route', () => {
    const onWindows = new EditorModels({ root, platform: 'win32-x64' })
    const elsewhere = new EditorModels({ root, platform: 'darwin-arm64' })
    const listed = onWindows.list().find(model => model.id === RENDERER)
    expect(listed).toMatchObject({ capability: 'renderer', totalBytes: 86_333_540, sourceHosts: ['vibedev.jzsaas.com', 'github.com'], program: { fileName: 'ffmpeg.exe' } })
    expect(listed!.program!.installedBytes).toBeGreaterThan(190_000_000)
    expect(elsewhere.list().some(model => model.id === RENDERER)).toBe(false)
    expect(onWindows.list()).toHaveLength(packagedModelManifests().length + 1)
    expect(modelFileRoutes(onWindows).some(route => route.path.includes(RENDERER))).toBe(false)
  })

  it('downloads nothing before the person agrees', async () => {
    const fetch = vi.fn(async () => new Response('x'))
    const models = new EditorModels({ root, platform: 'win32-x64', fetch: fetch as unknown as typeof globalThis.fetch })
    await expect(models.startPrepare(RENDERER)).rejects.toMatchObject({ status: 409, code: 'VIDEO_EDITOR_MODEL_CONSENT_REQUIRED' })
    expect(fetch).not.toHaveBeenCalled()
    expect(await models.programFile(RENDERER)).toBeUndefined()
  })
})

/** A small "FFmpeg" zip made with Windows' own tar.exe, the tool that unpacks the real one. */
async function makeArchive(): Promise<{ zip: Uint8Array; manifest: EditorModelManifest; files: Record<string, Uint8Array> }> {
  const source = join(root, 'source')
  const top = 'ffmpeg-test-build'
  const files: Record<string, Uint8Array> = {
    'bin/ffmpeg.exe': new TextEncoder().encode('MZ pretend ffmpeg '.repeat(40)),
    'bin/avutil-61.dll': new TextEncoder().encode('MZ pretend avutil '.repeat(80)),
    'LICENSE.txt': new TextEncoder().encode('GNU GENERAL PUBLIC LICENSE\nVersion 2\n'),
  }
  for (const [path, bytes] of Object.entries({ ...files, 'bin/ffplay.exe': new TextEncoder().encode('not kept') })) {
    const target = join(source, top, ...path.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, bytes)
  }
  const zipPath = join(root, 'ffmpeg-test.zip')
  const tar = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  execFileSync(tar, ['-a', '-cf', zipPath, '-C', source, top], { windowsHide: true })
  const zip = new Uint8Array(await readFile(zipPath))
  await rm(source, { recursive: true, force: true })
  await rm(zipPath, { force: true })
  const manifest: EditorModelManifest = {
    id: 'ffmpeg-test',
    label: 'FFmpeg 测试版',
    capability: 'renderer',
    revision: 'r1',
    platforms: ['win32-x64'],
    license: { name: 'GPL-2.0-or-later' },
    artifacts: [{ id: 'archive', fileName: 'ffmpeg-test.zip', bytes: zip.byteLength, sha256: sha256(zip), sources: [`${GATEWAY}${sha256(zip)}`] }],
    archive: {
      root: top,
      program: 'ffmpeg.exe',
      files: Object.entries(files).map(([path, bytes]) => ({ path, fileName: path.split('/').pop()!, bytes: bytes.byteLength, sha256: sha256(bytes) })),
      sourceNote: ['FFmpeg test build', 'from commit abc'],
    },
  }
  return { zip, manifest, files }
}

function network(zip: Uint8Array) {
  const requests: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    requests.push(String(input))
    return new Response(zip.slice(), { headers: { 'content-length': String(zip.byteLength) } })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

async function prepared(models: EditorModels, modelId: string) {
  const { taskId } = await models.startPrepare(modelId)
  await models.whenIdle()
  return models.task(taskId)
}

describe.skipIf(process.platform !== 'win32')('downloading and unpacking a renderer', () => {
  it('unpacks only the listed files, checks each, keeps the licence and writes SOURCE.txt', async () => {
    const { zip, manifest, files } = await makeArchive()
    const net = network(zip)
    const models = new EditorModels({ root, manifests: [manifest], platform: 'win32-x64', fetch: net.fetch })
    await models.setConsent('ffmpeg-test', true)
    const task = await prepared(models, 'ffmpeg-test')
    expect(task).toMatchObject({ status: 'done', progress: 100, phase: 'FFmpeg 测试版 已下载' })
    const folder = join(root, 'ffmpeg-test', 'r1')
    expect((await readdir(folder)).sort()).toEqual(['LICENSE.txt', 'SOURCE.txt', 'avutil-61.dll', 'ffmpeg.exe'])
    expect(new Uint8Array(await readFile(join(folder, 'ffmpeg.exe')))).toEqual(files['bin/ffmpeg.exe'])
    expect(await readFile(join(folder, 'SOURCE.txt'), 'utf8')).toBe('FFmpeg test build\r\nfrom commit abc')
    // The archive and the scratch folders are gone; only the program's folder stays.
    expect(await readdir(join(root, 'ffmpeg-test'))).toEqual(['r1'])
    expect(await models.programFile('ffmpeg-test')).toBe(join(folder, 'ffmpeg.exe'))
    // A second preparation finds it in place and fetches nothing.
    expect(await prepared(models, 'ffmpeg-test')).toMatchObject({ status: 'done', phase: 'FFmpeg 测试版 已在本机' })
    expect(net.requests).toHaveLength(1)
  })

  it('refuses an archive whose unpacked file does not match its digest, keeping nothing of it', async () => {
    const { zip, manifest } = await makeArchive()
    const tampered: EditorModelManifest = { ...manifest, archive: { ...manifest.archive!, files: manifest.archive!.files.map(file => file.fileName === 'avutil-61.dll' ? { ...file, sha256: 'f'.repeat(64) } : file) } }
    const models = new EditorModels({ root, manifests: [tampered], platform: 'win32-x64', fetch: network(zip).fetch })
    await models.setConsent('ffmpeg-test', true)
    expect(await prepared(models, 'ffmpeg-test')).toMatchObject({ status: 'failed', error: { code: 'VIDEO_EDITOR_MODEL_INTEGRITY_FAILED' } })
    expect(await readdir(join(root, 'ffmpeg-test'))).toEqual([])
    expect(await models.programFile('ffmpeg-test')).toBeUndefined()
  })

  it('refuses a download that is not the pinned archive', async () => {
    const { zip, manifest } = await makeArchive()
    const other = new Uint8Array(zip)
    other[other.length - 1] = other.at(-1)! ^ 0xff
    const models = new EditorModels({ root, manifests: [manifest], platform: 'win32-x64', fetch: network(other).fetch })
    await models.setConsent('ffmpeg-test', true)
    expect(await prepared(models, 'ffmpeg-test')).toMatchObject({ status: 'failed', error: { code: 'VIDEO_EDITOR_MODEL_INTEGRITY_FAILED' } })
    expect(await models.programFile('ffmpeg-test')).toBeUndefined()
  })

  it('keeps a verified archive when unpacking fails, and unpacks it next time without fetching again', async () => {
    const { zip, manifest } = await makeArchive()
    const net = network(zip)
    const broken = new EditorModels({ root, manifests: [manifest], platform: 'win32-x64', fetch: net.fetch, extract: async () => { throw new Error('tar.exe is missing') } })
    await broken.setConsent('ffmpeg-test', true)
    expect(await prepared(broken, 'ffmpeg-test')).toMatchObject({ status: 'failed', error: { code: 'VIDEO_EDITOR_MODEL_EXTRACT_FAILED', message: expect.stringContaining('tar.exe is missing') } })
    const fixed = new EditorModels({ root, manifests: [manifest], platform: 'win32-x64', fetch: net.fetch })
    expect(await prepared(fixed, 'ffmpeg-test')).toMatchObject({ status: 'done' })
    expect(net.requests).toHaveLength(1)
  })

  it('stops counting a program whose file was changed afterwards', async () => {
    const { zip, manifest } = await makeArchive()
    const models = new EditorModels({ root, manifests: [manifest], platform: 'win32-x64', fetch: network(zip).fetch })
    await models.setConsent('ffmpeg-test', true)
    await prepared(models, 'ffmpeg-test')
    const program = await models.programFile('ffmpeg-test')
    const bytes = await readFile(program!)
    bytes[0] = 0
    await writeFile(program!, bytes)
    expect(await models.programFile('ffmpeg-test')).toBeUndefined()
  })

  it('goes through the editor models\' consent and prepare routes, and the render then finds it', async () => {
    const { zip, manifest } = await makeArchive()
    const models = new EditorModels({ root, manifests: [manifest], platform: 'win32-x64', fetch: network(zip).fetch })
    const cwd = join(root, 'workspace')
    await mkdir(join(cwd, 'film', 'canvas', 'media'), { recursive: true })
    await createProject(cwd, { title: '雨夜', aspectRatio: '16:9' })
    await writeFile(join(cwd, 'film', 'canvas', 'media', 'still.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    const archive = createEmptyTimelineArchive('16:9')
    archive.project.visualSegments = [{ id: 'clip-1', type: 'image', duration: 1, assetVersionId: 'canvas-file:canvas/media/still.png', integrity: { archivePath: 'canvas/media/still.png' } }]
    await new TimelineStore(cwd).save({ document: archive, baseRevision: 0 })
    const tasks = new FilmMediaTasks(() => undefined)
    const render = vi.fn(async (input: TimelineRenderInput): Promise<TimelineRenderOutput> => {
      const target = join(input.projectDir, ...input.outputPath.split('/'))
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, 'stub')
      return { path: input.outputPath, absolutePath: target, size: 4, mtime: 1, sha256: 'x', width: 1280, height: 720, frameRate: 30, durationSeconds: 1, hasAudio: false, targetLoudnessLufs: -14 }
    })
    // The download comes before an installed Studio's copy and PATH.
    const router = createStudioRouter({ tasks, models, renderer: { render, filterNames: async () => new Set(), resolveFfmpeg: undefined } })
    const call = async (path: string, body?: unknown) => {
      const url = new URL(`http://host/api/dsh-film/${body === undefined ? 'studio' : 'studio-write'}`)
      url.searchParams.set('cwd', cwd)
      url.searchParams.set('path', path)
      const response = await router.dispatch(new Request(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
      return { status: response.status, body: await response.json() as any }
    }
    try {
      expect((await call('/api/media/video-editor-models')).body.models[0]).toMatchObject({ id: 'ffmpeg-test', capability: 'renderer', program: { fileName: 'ffmpeg.exe' } })
      expect((await call('/api/media/video-editor-models/ffmpeg-test/prepare', {})).body.code).toBe('VIDEO_EDITOR_MODEL_CONSENT_REQUIRED')
      expect((await call('/api/media/video-editor-models/ffmpeg-test/consent', { granted: true })).body).toMatchObject({ granted: true })
      const started = await call('/api/media/video-editor-models/ffmpeg-test/prepare', {})
      expect(started.status).toBe(202)
      await models.whenIdle()
      expect((await call(`/api/media/video-editor-model-tasks/${started.body.taskId}`)).body).toMatchObject({ status: 'done' })
      if (process.env.DSH_FILM_FFMPEG_PATH === undefined || process.env.DSH_FILM_FFMPEG_PATH.trim() === '') {
        const accepted = await call('/api/canvas/timelines/film-1/render?project=film-1', {})
        expect(accepted.status).toBe(202)
        await tasks.wait(cwd, accepted.body.taskId, 1, 2000)
        expect(render.mock.calls[0]![0].ffmpegBinary).toBe(join(root, 'ffmpeg-test', 'r1', 'ffmpeg.exe'))
      }
      // The plugin setting comes first.
      const configured = join(root, 'ffmpeg-test', 'r1', 'avutil-61.dll')
      const withSetting = createStudioRouter({ tasks, models, ffmpegPath: configured, renderer: { render, filterNames: async () => new Set() } })
      const url = new URL('http://host/api/dsh-film/studio-write')
      url.searchParams.set('cwd', cwd)
      url.searchParams.set('path', '/api/canvas/timelines/film-1/render?project=film-1')
      const second = await withSetting.dispatch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'set' }) }))
      const accepted = await second.json() as { taskId: string }
      await tasks.wait(cwd, accepted.taskId, 1, 2000)
      expect(render.mock.calls.at(-1)![0].ffmpegBinary).toBe(configured)
    } finally {
      tasks.dispose()
      await tasks.settled()
    }
  })
})
