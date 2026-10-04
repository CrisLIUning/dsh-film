/**
 * This window as a caption runner: the Host has no browser, so the editing
 * desk's speech recognition (Whisper, and the speech regions the gateway
 * engine needs) runs here, in a hidden frame, whatever tab is open. The
 * window keeps one event stream to the Host's runner hub; when a job is
 * offered it loads `apps/editor/caption-runner.html` in a hidden same-origin
 * frame, which claims the job (the first window to claim wins), does it and
 * posts the result itself. The frame is removed when the job ends, which
 * frees the model's memory.
 * @module dsh-film/client/caption-runner
 */

/** The runner hub's events (see the Host's `captions/runner`). */
interface JobEvent { jobId: string; kind?: string }
interface ClaimedEvent { jobId: string; runnerId: string }

/** How long a cancelled frame is kept so it can stop its worker cleanly. */
const CANCEL_GRACE_MS = 2_000

const parse = <T>(event: MessageEvent): T | undefined => {
  try {
    const value: unknown = JSON.parse(String(event.data))
    return value !== null && typeof value === 'object' ? value as T : undefined
  } catch {
    return undefined
  }
}

/**
 * Start serving caption jobs from this window.
 * @param base - the document's base URL (the Host's origin and path).
 * @returns stops the runner and removes any frame.
 */
export function startCaptionRunner(base: string = document.baseURI): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  const frames = new Map<string, HTMLIFrameElement>()
  let runnerId: string | undefined
  const remove = (jobId: string): void => {
    frames.get(jobId)?.remove()
    frames.delete(jobId)
  }
  const mount = (jobId: string): void => {
    if (runnerId === undefined || frames.has(jobId)) return
    const url = new URL('api/dsh-film/apps/editor/caption-runner.html', base)
    url.searchParams.set('job', jobId)
    url.searchParams.set('runner', runnerId)
    const frame = document.createElement('iframe')
    frame.src = url.href
    frame.title = 'dsh-film caption runner'
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none'
    frames.set(jobId, frame)
    document.body.appendChild(frame)
  }
  const source = new EventSource(new URL('api/dsh-film/caption-runner/events', base), { withCredentials: true })
  source.addEventListener('hello', (event) => {
    const hello = parse<{ runnerId?: unknown }>(event as MessageEvent)
    // A reconnect is a new runner: the Host has already counted the old one's jobs as lost.
    for (const jobId of [...frames.keys()]) remove(jobId)
    runnerId = typeof hello?.runnerId === 'string' ? hello.runnerId : undefined
  })
  source.addEventListener('job', (event) => {
    const job = parse<JobEvent>(event as MessageEvent)
    if (typeof job?.jobId === 'string') mount(job.jobId)
  })
  source.addEventListener('claimed', (event) => {
    const claimed = parse<ClaimedEvent>(event as MessageEvent)
    // Another window took it: this frame has nothing to do.
    if (claimed !== undefined && claimed.runnerId !== runnerId) remove(claimed.jobId)
  })
  source.addEventListener('cancel', (event) => {
    const job = parse<JobEvent>(event as MessageEvent)
    if (typeof job?.jobId !== 'string') return
    const frame = frames.get(job.jobId)
    frame?.contentWindow?.postMessage({ type: 'cancel', jobId: job.jobId }, location.origin)
    if (frame !== undefined) setTimeout(() => { if (frames.get(job.jobId) === frame) remove(job.jobId) }, CANCEL_GRACE_MS)
  })
  source.addEventListener('done', (event) => {
    const job = parse<JobEvent>(event as MessageEvent)
    if (typeof job?.jobId === 'string') remove(job.jobId)
  })
  // The page may also say it is finished (after posting its result or error).
  const finished = (event: MessageEvent): void => {
    if (event.origin !== location.origin) return
    const data = event.data as { type?: unknown; jobId?: unknown } | null
    if (data === null || typeof data !== 'object' || (data.type !== 'done' && data.type !== 'caption-runner-done') || typeof data.jobId !== 'string') return
    const frame = frames.get(data.jobId)
    if (frame !== undefined && event.source === frame.contentWindow) remove(data.jobId)
  }
  window.addEventListener('message', finished)
  return () => {
    window.removeEventListener('message', finished)
    source.close()
    for (const jobId of [...frames.keys()]) remove(jobId)
  }
}
