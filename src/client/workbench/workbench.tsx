/**
 * The film workbench, loaded on first use as client/client.workbench.js.
 *
 * This file and what it imports must not import the entry's modules: the
 * Host's loader cannot resolve one bundle file requiring another, so the
 * entry hands everything over as props (types alone may be shared).
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Input, SegmentedControl, Tag, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilmView, Translate, WorkbenchProps } from '../types.ts'
import { ASPECT_RATIOS, fetchAssets, mediaUrl } from './api.ts'
import type { AspectRatio, FilmProject, MediaAsset } from './api.ts'
import { AppFrame } from './AppFrame.tsx'
import type { FrameProtocol } from './AppFrame.tsx'
import { canvasProtocol } from './canvas-protocol.ts'
import { startProject, useProject } from './project-store.ts'
import { ScreenwriterView } from './story/ScreenwriterView.tsx'
import css from './workbench.module.css'

const PROJECT_FILE = 'film/film.json'

/** Host error codes with a sentence of their own; anything else shows the Host's message. */
const PROBLEMS: Readonly<Record<string, string>> = {
  PROJECT_INVALID: 'project.invalid',
  PROJECT_UNSUPPORTED: 'project.unsupported',
  WORKSPACE_NOT_FOUND: 'project.workspaceMissing',
}

/**
 * Draw one part of the workspace's film project.
 * @param props - the part, the workspace and the entry's helpers.
 * @returns the workbench.
 */
export function Workbench({ view, cwd, visible, t, openView }: WorkbenchProps): ReactNode {
  const { state, reload } = useProject(cwd, visible)
  if (state.status === 'loading') return <p className={css.notice} role="status">{t('project.loading')}</p>
  if (state.status === 'failed') {
    const explained = PROBLEMS[state.code]
    return (
      <div className={css.notice} role="alert">
        <p>{explained === undefined ? t('project.loadFailed', { message: state.message }) : t(explained)}</p>
        {explained !== undefined && <p className={css.detail}>{state.message}</p>}
        <Button variant="outline" size="sm" onClick={reload}>{t('project.reload')}</Button>
      </div>
    )
  }
  if (state.project === null) return <CreateProject cwd={cwd} t={t} />
  const hosted = hostedApp(view, state.project, cwd, openView)
  const native = <NativePart view={view} cwd={cwd} visible={visible} t={t} openView={openView} project={state.project} />
  return (
    <div className={css.root}>
      <ProjectHeader project={state.project} t={t} />
      {hosted === undefined
        ? <div className={css.body}>{native}</div>
        : (
            <div className={css.frameBody}>
              <AppFrame
                key={`${view}:${state.project.id}`}
                app={hosted.app}
                protocol={hosted.protocol}
                title={t(`${view}.title`)}
                t={t}
                missing={<div className={css.body}>{native}</div>}
              />
            </div>
          )}
    </div>
  )
}

/**
 * The original app that draws a part, with the protocol the workbench hosts it by.
 * The storyboard and the director desk are the same canvas page: the desk is
 * its overlay, as in Studio.
 */
function hostedApp(view: FilmView, project: FilmProject, cwd: string, openView: (view: FilmView) => void): { app: string; protocol: FrameProtocol } | undefined {
  switch (view) {
    case 'board':
    case 'director':
      return { app: 'canvas', protocol: canvasProtocol({ projectId: project.id, title: project.title, cwd, view: view === 'board' ? 'canvas' : 'director', openView }) }
    case 'timeline':
      return { app: 'editor', protocol: filmProtocol({ cwd, project: project.id }) }
    default:
      return undefined
  }
}

/** For apps written for this workbench: the workspace in the URL, the look by message. */
function filmProtocol(query: Readonly<Record<string, string>>): FrameProtocol {
  return {
    query: theme => ({ ...query, theme: theme.scheme }),
    sendTheme: (post, theme) => { post({ source: 'dsh-film', type: 'theme', theme }) },
    receive: () => {},
  }
}

/** A part's own view: the script, and what the other parts show while their app is not in this build. */
function NativePart({ view, cwd, visible, t, project }: WorkbenchProps & { project: FilmProject }): ReactNode {
  switch (view) {
    case 'timeline': return <MediaShelf cwd={cwd} visible={visible} t={t} />
    case 'story': return <ScreenwriterView cwd={cwd} project={project} visible={visible} t={t} />
    case 'board': return <p className={css.soon}>{t('board.soon')}</p>
    case 'director': return <p className={css.soon}>{t('director.soon')}</p>
  }
}

function ProjectHeader({ project, t }: { project: FilmProject; t: Translate }): ReactNode {
  return (
    <header className={css.header}>
      <h2 className={css.title} title={project.title}>{project.title}</h2>
      <Tag tone="neutral">{project.aspectRatio}</Tag>
      <span className={css.file} title={t('project.file', { path: PROJECT_FILE })}>{PROJECT_FILE}</span>
    </header>
  )
}

/** The last folder name of a workspace path: a starting title. */
function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(part => part !== '')
  return parts[parts.length - 1] ?? ''
}

function CreateProject({ cwd, t }: { cwd: string; t: Translate }): ReactNode {
  const [title, setTitle] = useState(() => folderName(cwd))
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (busy || title.trim() === '') return
    setBusy(true)
    setError(undefined)
    startProject(cwd, title, aspectRatio)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
        setBusy(false)
      })
  }
  return (
    <form className={css.create} onSubmit={submit}>
      <h2 className={css.createTitle}>{t('project.empty.title')}</h2>
      <p className={css.quiet}>{t('project.empty.body')}</p>
      <label className={css.field}>
        <span className={css.label}>{t('project.field.title')}</span>
        <Input
          value={title}
          maxLength={80}
          placeholder={t('project.field.titlePlaceholder')}
          onChange={(event) => { setTitle(event.target.value) }}
          disabled={busy}
        />
      </label>
      <div className={css.field}>
        <span className={css.label}>{t('project.field.aspect')}</span>
        <SegmentedControl
          id="dsh-film-aspect"
          label={t('project.field.aspect')}
          value={aspectRatio}
          options={ASPECT_RATIOS.map(value => ({ value, label: value }))}
          onChange={setAspectRatio}
          disabled={busy}
        />
      </div>
      {error !== undefined && <p className={css.error} role="alert">{t('project.createFailed', { message: error })}</p>}
      <div>
        <Button type="submit" variant="primary" disabled={busy || title.trim() === ''}>
          {busy ? t('project.creating') : t('project.create')}
        </Button>
      </div>
    </form>
  )
}

type ShelfState =
  | { status: 'loading' }
  | { status: 'ready'; assets: MediaAsset[]; truncated: boolean }
  | { status: 'failed'; message: string }

function MediaShelf({ cwd, visible, t }: { cwd: string; visible: boolean; t: Translate }): ReactNode {
  const [state, setState] = useState<ShelfState>({ status: 'loading' })
  const [selected, setSelected] = useState<MediaAsset | undefined>()
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    fetchAssets(cwd, controller.signal)
      .then((listing) => { setState({ status: 'ready', ...listing }) })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      })
    return () => { controller.abort() }
  }, [cwd, visible, revision])
  return (
    <section className={css.shelf}>
      <Preview cwd={cwd} asset={selected} visible={visible} t={t} />
      <div className={css.shelfHeader}>
        <h3 className={css.sectionTitle}>{t('assets.title')}</h3>
        <Button variant="ghost" size="sm" onClick={() => { setRevision(value => value + 1) }}>{t('assets.refresh')}</Button>
      </div>
      {state.status === 'loading' && <p className={css.quiet} role="status">{t('assets.loading')}</p>}
      {state.status === 'failed' && <p className={css.error} role="alert">{t('assets.loadFailed', { message: state.message })}</p>}
      {state.status === 'ready' && state.assets.length === 0 && <p className={css.quiet}>{t('assets.empty')}</p>}
      {state.status === 'ready' && state.assets.length > 0 && (
        <ul className={css.assets}>
          {state.assets.map(asset => (
            <li key={asset.path}>
              <button
                type="button"
                className={css.asset}
                aria-pressed={selected?.path === asset.path}
                onClick={() => { setSelected(asset) }}
                title={asset.path}
              >
                <span className={css.assetKind}>{t(`kind.${asset.kind}`)}</span>
                <span className={css.assetPath}>{asset.path}</span>
                <span className={css.assetSize}>{fileSizeText(asset.bytes)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.status === 'ready' && state.truncated && <p className={css.quiet}>{t('assets.truncated', { count: state.assets.length })}</p>}
    </section>
  )
}

function Preview({ cwd, asset, visible, t }: { cwd: string; asset: MediaAsset | undefined; visible: boolean; t: Translate }): ReactNode {
  const player = useRef<HTMLMediaElement | null>(null)
  const [failed, setFailed] = useState<string | undefined>()
  useEffect(() => { setFailed(undefined) }, [asset?.path])
  useEffect(() => {
    if (!visible) player.current?.pause()
  }, [visible])
  if (asset === undefined) return <div className={css.preview}><p className={css.quiet}>{t('preview.empty')}</p></div>
  if (failed === asset.path) return <div className={css.preview}><p className={css.error}>{t('preview.failed', { path: asset.path })}</p></div>
  const src = mediaUrl(cwd, asset.path)
  const onError = (): void => { setFailed(asset.path) }
  return (
    <div className={css.preview}>
      {asset.kind === 'video' && (
        <video key={src} ref={(element) => { player.current = element }} className={css.media} src={src} controls preload="metadata" onError={onError} />
      )}
      {asset.kind === 'audio' && (
        <audio key={src} ref={(element) => { player.current = element }} className={css.audio} src={src} controls preload="metadata" onError={onError} />
      )}
      {asset.kind === 'image' && <img key={src} className={css.media} src={src} alt={asset.path} onError={onError} />}
    </div>
  )
}

