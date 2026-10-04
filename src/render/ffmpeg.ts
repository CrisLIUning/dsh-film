/**
 * Finding and running ffmpeg for the Host's own media work: rendering the cut
 * and preparing audio for the gateway's speech recognition. Ported from
 * Studio's apps/daemon/src/ffmpeg-binaries.ts, system-ffmpeg.ts
 * (`ffmpegFilterNames`) and canvas-timeline-render.ts (`runFfmpeg`).
 *
 * ffmpeg runs as a separate program the person already has or downloaded on
 * consent; nothing of it is part of this plugin. Resolution, first hit wins:
 * the plugin setting, `DSH_FILM_FFMPEG_PATH`, the verified download, the copy
 * an installed VibeDev Studio ships, a PATH binary that runs `-version`, and
 * well-known install locations. Unlike Studio, a cancelled run stops the
 * process tree at once and is reported as cancelled even when ffmpeg's exit
 * races the signal.
 * @module dsh-film/render/ffmpeg
 */

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

const PROBE_TIMEOUT_MS = 5_000

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>

export interface FfmpegProbe {
  /** The plugin setting naming a binary. */
  configured?: string
  env?: Env
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  /** Whether `ffmpeg -version` succeeds through PATH lookup. */
  probeOnPath?: () => boolean
  /** The copy downloaded on consent, if any. */
  downloaded?: () => string | undefined
}

/** Where a resolved binary came from, for messages and diagnostics. */
export type FfmpegSource = 'setting' | 'environment' | 'download' | 'vibedev-studio' | 'path' | 'installed'

export interface ResolvedFfmpeg {
  binary: string
  source: FfmpegSource
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const trimmed = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '')

function probeOnPathDefault(): boolean {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, shell: false })
  return probe.error === undefined && probe.status === 0
}

/**
 * The ffmpeg an installed VibeDev Studio ships (its pinned build with every
 * filter the planner emits).
 * @param env - the environment.
 * @param platform - the platform.
 * @returns candidate paths.
 */
export function studioFfmpegCandidates(env: Env, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return ['/Applications/VibeDev.app/Contents/Resources/vibedev/ffmpeg/ffmpeg']
  const localAppData = trimmed(env.LOCALAPPDATA)
  return localAppData === '' ? [] : [win32.join(localAppData, 'Programs', 'VibeDev', 'resources', 'vibedev', 'ffmpeg', 'ffmpeg.exe')]
}

/**
 * Well-known install locations, most common first (Studio's list).
 * @param platform - the platform.
 * @param env - the environment.
 * @returns candidate paths.
 */
export function installedFfmpegCandidates(platform: NodeJS.Platform, env: Env): string[] {
  if (platform === 'win32') {
    const localAppData = trimmed(env.LOCALAPPDATA)
    const programFiles = trimmed(env.ProgramFiles) || 'C:\\Program Files'
    const programData = trimmed(env.ProgramData) || 'C:\\ProgramData'
    const userProfile = trimmed(env.USERPROFILE)
    return [
      ...(localAppData !== '' ? [win32.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')] : []),
      win32.join(programData, 'chocolatey', 'bin', 'ffmpeg.exe'),
      ...(userProfile !== '' ? [win32.join(userProfile, 'scoop', 'shims', 'ffmpeg.exe')] : []),
      win32.join(programFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'),
      win32.join('C:\\ffmpeg', 'bin', 'ffmpeg.exe'),
    ]
  }
  return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].map(path => posix.normalize(path))
}

/**
 * Find ffmpeg.
 * @param probe - the setting and injectable host facts.
 * @returns the binary and where it came from, or `undefined` when there is none.
 */
export function resolveFfmpeg(probe: FfmpegProbe = {}): ResolvedFfmpeg | undefined {
  const env = probe.env ?? process.env
  const platform = probe.platform ?? process.platform
  const exists = probe.exists ?? isExecutableFile
  const configured = trimmed(probe.configured)
  if (configured !== '' && exists(configured)) return { binary: configured, source: 'setting' }
  const override = trimmed(env.DSH_FILM_FFMPEG_PATH)
  if (override !== '' && exists(override)) return { binary: override, source: 'environment' }
  const downloaded = probe.downloaded?.()
  if (downloaded !== undefined && exists(downloaded)) return { binary: downloaded, source: 'download' }
  const studio = studioFfmpegCandidates(env, platform).find(exists)
  if (studio !== undefined) return { binary: studio, source: 'vibedev-studio' }
  if ((probe.probeOnPath ?? probeOnPathDefault)()) return { binary: 'ffmpeg', source: 'path' }
  const installed = installedFfmpegCandidates(platform, env).find(exists)
  return installed === undefined ? undefined : { binary: installed, source: 'installed' }
}

/**
 * Stop a child and everything it started (on Windows `taskkill /T`), so an
 * ffmpeg tree never outlives its task.
 * @param child - the child process.
 */
export function stopProcessTree(child: Pick<ChildProcess, 'pid' | 'kill' | 'exitCode'>): void {
  if (child.exitCode !== null) return
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: PROBE_TIMEOUT_MS })
    if (result.status === 0) return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Already gone.
  }
}

/**
 * The filter names in `ffmpeg -filters` output: ` T.C scale  V->V  Scale …`
 * (ffmpeg 4–7, three flag columns) and ` TS aap  AA->A  Apply …` (ffmpeg 8, two).
 * @param stdout - the listing.
 * @returns the names.
 */
export function parseFilterNames(stdout: string): Set<string> {
  const names = new Set<string>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*[A-Z.]{2,4}\s+([A-Za-z0-9_]+)\s+\S+->\S+/u.exec(line)
    if (match?.[1] !== undefined) names.add(match[1])
  }
  return names
}

const filterSupport = new Map<string, Promise<Set<string>>>()

/**
 * The filters a binary has (`ffmpeg -filters`), remembered per binary. A build
 * can lack one the planner needs (no libass: no `subtitles`), and the render
 * should say so on the request rather than fail a task.
 * @param binary - the ffmpeg binary.
 * @param timeoutMs - how long to wait for the answer.
 * @returns the filter names; empty when the binary could not be asked.
 */
export function ffmpegFilterNames(binary: string, timeoutMs = 10_000): Promise<Set<string>> {
  let pending = filterSupport.get(binary)
  if (pending === undefined) {
    pending = new Promise<Set<string>>((resolve) => {
      const names = new Set<string>()
      let stdout = ''
      let child: ChildProcess
      try {
        child = spawn(binary, ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false })
      } catch {
        resolve(names)
        return
      }
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        for (const name of parseFilterNames(stdout)) names.add(name)
        resolve(names)
      }
      const timer = setTimeout(() => {
        stopProcessTree(child)
        settle()
      }, timeoutMs)
      timer.unref()
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.on('error', () => { settle() })
      child.on('close', () => { settle() })
    })
    filterSupport.set(binary, pending)
    // A binary that could not be asked is asked again next time.
    void pending.then((names) => { if (names.size === 0) filterSupport.delete(binary) })
  }
  return pending
}

export class FfmpegCanceledError extends Error {
  override name = 'FfmpegCanceledError'
  readonly code = 'FFMPEG_CANCELED'
}

export interface FfmpegRun {
  binary: string
  argv: string[]
  cwd: string
  signal?: AbortSignal
  /** No new output time for this long stops the run (a source ffmpeg cannot decode). */
  stallTimeoutMs: number
  /**
   * The allowance before the first output time instead, when longer: an
   * encoder holds its lookahead's worth of frames before it writes a packet,
   * which at a large graded frame takes minutes. Defaults to `stallTimeoutMs`.
   */
  firstOutputTimeoutMs?: number
  /** The whole run may take this long. */
  maxDurationMs: number
  /** Output time in seconds, from `-progress pipe:1`. */
  onOutTime?: (seconds: number) => void
}

export interface FfmpegRunResult {
  code: number
  /** The last 8 KiB ffmpeg wrote to stderr. */
  stderr: string
  stalled: boolean
  timedOut: boolean
  /** Whether any output time arrived (a stall before it ran on the first-output allowance). */
  produced?: boolean
}

/**
 * Run ffmpeg with two clocks — one restarted by every new output time, one
 * for the whole run — and stop its tree on cancellation. Pass
 * `-progress pipe:1` in `argv` to get `onOutTime`.
 * @param run - the binary, arguments, working folder, signal and limits.
 * @returns the exit code, stderr's tail and which clock stopped it, if any.
 */
export function runFfmpeg(run: FfmpegRun): Promise<FfmpegRunResult> {
  return new Promise((resolve, reject) => {
    if (run.signal?.aborted === true) {
      reject(new FfmpegCanceledError('ffmpeg was cancelled before it started'))
      return
    }
    const child = spawn(run.binary, run.argv, { cwd: run.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
    let stderr = ''
    let pending = ''
    let settled = false
    let stalled = false
    let timedOut = false
    let cancelled = false
    let lastOutTime = -1
    const stop = (): void => { stopProcessTree(child) }
    const onAbort = (): void => {
      cancelled = true
      stop()
    }
    const arm = (ms: number): NodeJS.Timeout => {
      const timer = setTimeout(() => {
        stalled = true
        stop()
      }, ms)
      timer.unref()
      return timer
    }
    // Until the first output time the encoder may still be filling its lookahead.
    let stallTimer = arm(Math.max(run.stallTimeoutMs, run.firstOutputTimeoutMs ?? 0))
    const maxTimer = setTimeout(() => {
      timedOut = true
      stop()
    }, run.maxDurationMs)
    maxTimer.unref()
    const done = (): void => {
      clearTimeout(stallTimer)
      clearTimeout(maxTimer)
      run.signal?.removeEventListener('abort', onAbort)
    }
    run.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      // Once a clock has stopped it, what the dying process still says is not progress.
      if (stalled || timedOut || cancelled) return
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const match = /^out_time_(?:us|ms)=(\d+)/u.exec(line.trim())
        if (match?.[1] === undefined) continue
        // ffmpeg reports both keys in microseconds despite the `ms` name.
        const seconds = Number(match[1]) / 1_000_000
        if (seconds > lastOutTime) {
          lastOutTime = seconds
          clearTimeout(stallTimer)
          stallTimer = arm(run.stallTimeoutMs)
        }
        run.onOutTime?.(seconds)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8192) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      done()
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      done()
      if (cancelled || run.signal?.aborted === true) {
        reject(new FfmpegCanceledError('ffmpeg was cancelled'))
        return
      }
      resolve({ code: code ?? 1, stderr, stalled, timedOut, produced: lastOutTime >= 0 })
    })
  })
}
