/** Local tasks in the film task store, and finding and running ffmpeg (with a Node script standing in for it). */

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilmMediaTasks } from '../src/media/tasks.js'
import { FfmpegCanceledError, ffmpegFilterNames, parseFilterNames, resolveFfmpeg, runFfmpeg } from '../src/render/ffmpeg.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-film-local-tasks-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const nextTick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10))

describe('local tasks', () => {
  it('run, report progress and finish with their file, readable by wait, record and list', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { taskId, status } = await tasks.startLocal(cwd, 'film-1', { surface: 'video', model: 'timeline-render', capability: 'render', requestId: 'r-1', started: '准备渲染' }, async (context) => {
      context.progress('渲染 50%')
      await gate
      return { name: 'canvas/renders/a.mp4', size: 3, kind: 'video', mime: 'video/mp4', durationSeconds: 1 }
    })
    expect(status).toBe('running')
    await nextTick()
    expect((await tasks.wait(cwd, taskId, 0, 0)).progress).toEqual(['准备渲染', '渲染 50%'])
    release()
    const done = await tasks.wait(cwd, taskId, 2, 1000)
    expect(done).toMatchObject({ status: 'done', file: { name: 'canvas/renders/a.mp4', durationSeconds: 1 } })
    expect(await tasks.record(cwd, taskId)).toMatchObject({ kind: 'local', request: { capability: 'render', requestId: 'r-1' } })
    expect((await tasks.list(cwd)).map(task => task.taskId)).toEqual([taskId])
    await tasks.settled()
    expect(JSON.parse(await readFile(join(cwd, 'film', '.tasks', `${taskId}.json`), 'utf8'))).toMatchObject({ status: 'done' })
  })

  it('fail with the body\'s error, and stay cancelled when a cancelled body finishes later', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    const failed = await tasks.startLocal(cwd, 'film-1', { surface: 'video', model: 'm', capability: 'render' }, async () => {
      throw Object.assign(new Error('ffmpeg exited with 1'), { code: 'FFMPEG_FAILED', status: 500 })
    })
    expect(await tasks.wait(cwd, failed.taskId, 0, 1000)).toMatchObject({ status: 'failed', error: { code: 'FFMPEG_FAILED' } })

    let finish!: () => void
    const late = new Promise<void>((resolve) => { finish = resolve })
    let sawAbort = false
    const cancelled = await tasks.startLocal(cwd, 'film-1', { surface: 'video-editor', model: 'whisper', capability: 'transcribe' }, async (context) => {
      context.signal.addEventListener('abort', () => { sawAbort = true })
      await late
      return { name: 'x', size: 0, kind: 'text', mime: 'application/json' }
    })
    await tasks.cancel(cwd, cancelled.taskId)
    expect(sawAbort).toBe(true)
    expect((await tasks.record(cwd, cancelled.taskId))?.status).toBe('interrupted')
    finish()
    await nextTick()
    expect(await tasks.record(cwd, cancelled.taskId)).toMatchObject({ status: 'interrupted', error: { code: 'MEDIA_TASK_CANCELED' } })
  })

  it('add no progress line after a task has ended', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    let report!: (line: string) => void
    let finish!: () => void
    const late = new Promise<void>((resolve) => { finish = resolve })
    const { taskId } = await tasks.startLocal(cwd, 'film-1', { surface: 'video', model: 'm', capability: 'render', started: '准备渲染' }, async (context) => {
      report = context.progress
      await late
      return { name: 'x', size: 0, kind: 'video', mime: 'video/mp4' }
    })
    await tasks.cancel(cwd, taskId)
    // The body, not yet aware it was stopped, reports on.
    report('render 80%')
    finish()
    await nextTick()
    expect((await tasks.record(cwd, taskId))?.progress).toEqual(['准备渲染', '已取消'])
    await tasks.settled()
    expect(JSON.parse(await readFile(join(cwd, 'film', '.tasks', `${taskId}.json`), 'utf8')).progress).toEqual(['准备渲染', '已取消'])
  })

  it('leave a local task interrupted, as after a restart, when the plugin unloads under it — not cancelled', async () => {
    const tasks = new FilmMediaTasks(() => undefined)
    const { taskId } = await tasks.startLocal(cwd, 'film-1', {
      surface: 'video', model: 'm', capability: 'render',
      interruption: { code: 'RENDER_INTERRUPTED', message: '渲染过程中宿主重启，请重新渲染', status: 503 },
      cancellation: { code: 'RENDER_CANCELED', message: '渲染已取消。', status: 499 },
    }, context => new Promise((_resolve, reject) => { context.signal.addEventListener('abort', () => { reject(context.signal.reason) }) }))
    tasks.dispose()
    await nextTick()
    expect(await tasks.record(cwd, taskId)).toMatchObject({ status: 'interrupted', error: { code: 'RENDER_INTERRUPTED' }, progress: ['已开始', '已中断'] })
    await tasks.settled()
  })

  it('are one live task whichever spelling of the workspace asks after them', async () => {
    const alias = `${cwd}-alias`
    await symlink(cwd, alias, 'junction')
    try {
      const tasks = new FilmMediaTasks(() => undefined)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const { taskId } = await tasks.startLocal(cwd, 'film-1', { surface: 'video', model: 'm', capability: 'render' }, async () => {
        await gate
        return { name: 'canvas/renders/a.mp4', size: 1, kind: 'video', mime: 'video/mp4' }
      })
      // The agent asks by another spelling: the running task, not a stale copy read from disk.
      expect((await tasks.wait(alias, taskId, 0, 0)).status).toBe('running')
      release()
      expect(await tasks.wait(alias, taskId, 1, 1000)).toMatchObject({ status: 'done' })
      expect((await tasks.record(cwd, taskId))?.status).toBe('done')
      await tasks.settled()
    } finally {
      await rm(alias, { recursive: true, force: true })
    }
  })

  it('leave a local task interrupted with its own message after a restart', async () => {
    const before = new FilmMediaTasks(() => undefined)
    const { taskId } = await before.startLocal(cwd, 'film-1', {
      surface: 'video', model: 'm', capability: 'render', interruption: { code: 'RENDER_INTERRUPTED', message: '渲染过程中宿主重启，请重新渲染', status: 503 },
    }, () => new Promise(() => {}))
    await before.settled()
    const after = new FilmMediaTasks(() => undefined)
    expect(await after.record(cwd, taskId)).toMatchObject({ status: 'interrupted', error: { code: 'RENDER_INTERRUPTED' } })
    await after.settled()
    before.dispose()
  })
})

describe('finding ffmpeg', () => {
  const none = { probeOnPath: () => false, exists: () => false, env: {}, platform: 'win32' as const }

  it('prefers the setting, then the environment, the download, Studio\'s copy, PATH and install locations', () => {
    const present = (paths: string[]) => (path: string) => paths.includes(path)
    expect(resolveFfmpeg({ ...none, configured: 'C:\\tools\\ffmpeg.exe', exists: present(['C:\\tools\\ffmpeg.exe']) })).toEqual({ binary: 'C:\\tools\\ffmpeg.exe', source: 'setting' })
    expect(resolveFfmpeg({ ...none, env: { DSH_FILM_FFMPEG_PATH: 'D:\\ff.exe' }, exists: present(['D:\\ff.exe']) })?.source).toBe('environment')
    expect(resolveFfmpeg({ ...none, downloaded: () => 'E:\\cache\\ffmpeg.exe', exists: present(['E:\\cache\\ffmpeg.exe']) })?.source).toBe('download')
    const studio = 'C:\\Users\\u\\AppData\\Local\\Programs\\VibeDev\\resources\\vibedev\\ffmpeg\\ffmpeg.exe'
    expect(resolveFfmpeg({ ...none, env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, exists: present([studio]) })).toEqual({ binary: studio, source: 'vibedev-studio' })
    expect(resolveFfmpeg({ ...none, probeOnPath: () => true })).toEqual({ binary: 'ffmpeg', source: 'path' })
    expect(resolveFfmpeg({ ...none, exists: present(['C:\\ffmpeg\\bin\\ffmpeg.exe']) })?.source).toBe('installed')
    expect(resolveFfmpeg(none)).toBeUndefined()
    // A setting naming a missing file falls through rather than failing.
    expect(resolveFfmpeg({ ...none, configured: 'C:\\gone.exe', probeOnPath: () => true })?.source).toBe('path')
  })
})

describe('running ffmpeg', () => {
  /** A stand-in ffmpeg: a Node script run with the current Node. */
  async function fake(body: string): Promise<{ binary: string; argv: (args: string[]) => string[] }> {
    const script = join(cwd, `fake-${Math.random().toString(36).slice(2)}.mjs`)
    await writeFile(script, body)
    return { binary: process.execPath, argv: args => [script, ...args] }
  }

  it('reports output time, and stops a run whose output time stops moving', async () => {
    const ok = await fake(`process.stdout.write('out_time_us=500000\\nout_time_us=1000000\\nprogress=end\\n'); process.exit(0)`)
    const seen: number[] = []
    const result = await runFfmpeg({ binary: ok.binary, argv: ok.argv([]), cwd, stallTimeoutMs: 5000, maxDurationMs: 10000, onOutTime: (seconds) => { seen.push(seconds) } })
    expect(result).toMatchObject({ code: 0, stalled: false, timedOut: false })
    expect(seen).toEqual([0.5, 1])
    const stuck = await fake(`process.stdout.write('out_time_us=100000\\n'); setInterval(() => {}, 1000)`)
    expect(await runFfmpeg({ binary: stuck.binary, argv: stuck.argv([]), cwd, stallTimeoutMs: 300, maxDurationMs: 10000 })).toMatchObject({ stalled: true })
  })

  it('waits the first-output allowance for the first frame, then the stall timeout between frames', async () => {
    // An encoder filling its lookahead: nothing for a while, then steady progress.
    const late = await fake(`
setTimeout(() => {
  let us = 0
  const timer = setInterval(() => {
    us += 100000
    process.stdout.write('out_time_us=' + us + '\\n')
    if (us >= 500000) { clearInterval(timer); process.exit(0) }
  }, 30)
}, 1500)
`)
    expect(await runFfmpeg({ binary: late.binary, argv: late.argv([]), cwd, stallTimeoutMs: 1000, firstOutputTimeoutMs: 8000, maxDurationMs: 20000 }))
      .toMatchObject({ code: 0, stalled: false, produced: true })
    // Without the allowance the same run is taken for stuck.
    expect(await runFfmpeg({ binary: late.binary, argv: late.argv([]), cwd, stallTimeoutMs: 1000, maxDurationMs: 20000 })).toMatchObject({ stalled: true, produced: false })
    // A source that never yields a frame is still stopped, once the allowance is over.
    const never = await fake(`setInterval(() => {}, 1000)`)
    const started = Date.now()
    expect(await runFfmpeg({ binary: never.binary, argv: never.argv([]), cwd, stallTimeoutMs: 100, firstOutputTimeoutMs: 400, maxDurationMs: 10000 })).toMatchObject({ stalled: true, produced: false })
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
  }, 20_000)

  it('stops the tree on cancellation and says so', async () => {
    const forever = await fake(`setInterval(() => {}, 1000)`)
    const controller = new AbortController()
    const running = runFfmpeg({ binary: forever.binary, argv: forever.argv([]), cwd, signal: controller.signal, stallTimeoutMs: 10000, maxDurationMs: 10000 })
    setTimeout(() => { controller.abort() }, 100)
    await expect(running).rejects.toBeInstanceOf(FfmpegCanceledError)
  })

  it('reads the filter list in both column formats', () => {
    const listing = ' T.C scale             V->V       Scale the input video size.\n TS aap               AA->A      Apply Affine Projection.\n ... subtitles        V->V       Render text subtitles.\nFilters:\n'
    expect([...parseFilterNames(listing)].sort()).toEqual(['aap', 'scale', 'subtitles'])
  })

  it('answers an empty filter set for a binary that cannot be asked', async () => {
    expect((await ffmpegFilterNames(join(cwd, 'no-such-ffmpeg.exe'))).size).toBe(0)
  })
})
