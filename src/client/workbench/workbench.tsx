/**
 * The film workbench, loaded on first use as client/client.workbench.js.
 *
 * This file and what it imports must not import the entry's modules: the
 * Host's loader cannot resolve one bundle file requiring another, so the
 * entry hands everything over as props (types alone may be shared).
 */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Button, Input, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilmView, Translate, WorkbenchProps } from '../types.ts'
import { ASPECT_RATIOS, TITLE_MAX } from './api.ts'
import type { AspectRatio, FilmProject, ProjectChange } from './api.ts'
import { AppFrame } from './AppFrame.tsx'
import type { FrameProtocol } from './AppFrame.tsx'
import { canvasProtocol } from './canvas-protocol.ts'
import { changeProject, useProject } from './project-store.ts'
import { titleKeyAction, titleToSave } from './project-title.ts'
import { restartText, runtimeText, useRestartNotice } from './runtime-notice.ts'
import type { RestartNotice } from './runtime-notice.ts'
import { ScreenwriterView } from './story/ScreenwriterView.tsx'
import css from './workbench.module.css'

const PROJECT_FILE = 'film/film.json'

/** Host error codes with a sentence of their own; anything else shows the Host's message. */
const PROBLEMS: Readonly<Record<string, string>> = {
  PROJECT_INVALID: 'project.invalid',
  PROJECT_UNSUPPORTED: 'project.unsupported',
  WORKSPACE_NOT_FOUND: 'project.workspaceMissing',
  WORKSPACE_REFUSED: 'project.workspaceRefused',
}

/**
 * The parts this build draws. An older entry still in memory (a restart is
 * pending) may hand over a part this build no longer has.
 */
const VIEWS = { story: true, board: true, director: true } as const satisfies Record<FilmView, true>

const isKnownView = (view: string): view is FilmView => Object.hasOwn(VIEWS, view)

/** The restart banner, at the top of whatever the part shows. */
function RestartBanner({ notice, t }: { notice: RestartNotice | null; t: Translate }): ReactNode {
  if (notice === null) return null
  return <p className={css.restartBanner} role="alert">{restartText(t, notice)}</p>
}

/**
 * Draw one part of the workspace's film project.
 * @param props - the part, the workspace and the entry's helpers.
 * @returns the workbench.
 */
export function Workbench(props: WorkbenchProps): ReactNode {
  const notice = useRestartNotice(props.visible)
  const banner = <RestartBanner notice={notice} t={props.t} />
  if (!isKnownView(props.view)) {
    return (
      <div className={css.root}>
        {banner}
        <p className={css.notice}>{runtimeText(props.t, 'runtime.retiredView')}</p>
      </div>
    )
  }
  return <ProjectPart {...props} banner={banner} notice={notice} />
}

/** A part this build draws, under the restart banner. */
function ProjectPart({ view, cwd, visible, t, openView, banner, notice }: WorkbenchProps & { banner: ReactNode; notice: RestartNotice | null }): ReactNode {
  const { state, reload } = useProject(cwd, visible)
  if (state.status === 'loading') {
    return (
      <div className={css.root}>
        {banner}
        <p className={css.notice} role="status">{t('project.loading')}</p>
      </div>
    )
  }
  if (state.status === 'failed') {
    const explained = PROBLEMS[state.code]
    const headline = explained !== undefined
      ? t(explained)
      : t(state.during === 'start' ? 'project.startFailed' : 'project.loadFailed', { message: state.message })
    return (
      <div className={css.root}>
        {banner}
        <div className={css.notice} role="alert">
          <p>{headline}</p>
          {explained !== undefined && <p className={css.detail}>{state.message}</p>}
          <Button variant="outline" size="sm" onClick={reload}>{t('project.reload')}</Button>
        </div>
      </div>
    )
  }
  // No film yet: the store is creating it (this part is on screen, or another is).
  if (state.project === null) {
    return (
      <div className={css.root}>
        {banner}
        <p className={css.notice} role="status">{t('project.starting')}</p>
      </div>
    )
  }
  const hosted = hostedApp(view, state.project, cwd, openView)
  const native = <NativePart view={view} cwd={cwd} visible={visible} t={t} openView={openView} project={state.project} />
  return (
    <div className={css.root}>
      {banner}
      <ProjectHeader project={state.project} cwd={cwd} t={t} />
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
                // The new app files have no routes until the Host restarts: say so instead of framing a page that cannot load.
                blocked={notice === null ? undefined : <p>{restartText(t, notice)}</p>}
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
    default:
      return undefined
  }
}

/** A part's own view: the script, and what the other parts show while their app is not in this build. */
function NativePart({ view, cwd, visible, t, openView, project }: WorkbenchProps & { project: FilmProject }): ReactNode {
  switch (view) {
    case 'story': return <ScreenwriterView cwd={cwd} project={project} visible={visible} t={t} openView={openView} />
    case 'board': return <p className={css.soon}>{t('board.soon')}</p>
    case 'director': return <p className={css.soon}>{t('director.soon')}</p>
  }
}

/** Saves one change to the film; a refusal is shown in the header. */
type SaveChange = (change: ProjectChange) => Promise<void>

/** The header the three parts share: the film's title (click to rename), its frame menu and its file. */
function ProjectHeader({ project, cwd, t }: { project: FilmProject; cwd: string; t: Translate }): ReactNode {
  const [error, setError] = useState<string | undefined>()
  useEffect(() => { setError(undefined) }, [project.id])
  const save: SaveChange = async (change) => {
    setError(undefined)
    try {
      await changeProject(cwd, change)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  return (
    <header className={css.header}>
      <TitleEditor title={project.title} save={save} t={t} />
      <AspectMenu aspectRatio={project.aspectRatio} save={save} t={t} />
      {error !== undefined
        ? <span className={css.headerError} role="alert" title={error}>{t('project.saveFailed', { message: error })}</span>
        : <span className={css.file} title={t('project.file', { path: PROJECT_FILE })}>{PROJECT_FILE}</span>}
    </header>
  )
}

/**
 * The film's title: a button that turns into an input on click. Enter or
 * leaving the input saves, Escape cancels; a blank or unchanged title saves nothing.
 */
function TitleEditor({ title, save, t }: { title: string; save: SaveChange; t: Translate }): ReactNode {
  const [draft, setDraft] = useState<string | undefined>()
  const [saving, setSaving] = useState<string | undefined>()
  // The draft as typed, read synchronously: Escape and the blur that follows must not both finish the edit.
  const editing = useRef<string | undefined>(undefined)
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (draft !== undefined) input.current?.select()
  }, [draft !== undefined])

  const start = (): void => {
    editing.current = title
    setDraft(title)
  }
  const finish = (keep: boolean): void => {
    const typed = editing.current
    if (typed === undefined) return
    editing.current = undefined
    setDraft(undefined)
    const next = keep ? titleToSave(typed, title) : undefined
    if (next === undefined) return
    setSaving(next)
    void save({ title: next }).finally(() => { setSaving(undefined) })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const action = titleKeyAction(event.key, event.nativeEvent.isComposing || event.keyCode === 229)
    if (action === undefined) return
    event.preventDefault()
    event.stopPropagation()
    finish(action === 'save')
  }

  const shown = saving ?? title
  return (
    <h2 className={css.titleHeading}>
      {draft !== undefined
        ? (
            <Input
              ref={input}
              className={css.titleInput}
              value={draft}
              maxLength={TITLE_MAX}
              aria-label={t('project.title.label')}
              autoFocus
              onChange={(event) => {
                editing.current = event.target.value
                setDraft(event.target.value)
              }}
              onKeyDown={onKeyDown}
              onBlur={() => { finish(true) }}
            />
          )
        : (
            <button type="button" className={css.title} title={t('project.title.edit')} aria-label={`${t('project.title.label')}: ${shown}`} disabled={saving !== undefined} onClick={start}>
              {shown}
            </button>
          )}
    </h2>
  )
}

const isAspectRatio = (value: string): value is AspectRatio => (ASPECT_RATIOS as readonly string[]).includes(value)

/**
 * The film's frame: a menu of the offered frames, the film frame the
 * storyboard canvas and the director desk use. A frame from an earlier
 * version that is no longer offered (4:3) is shown as it is, with no entry
 * checked, until another is picked.
 */
function AspectMenu({ aspectRatio, save, t }: { aspectRatio: string; save: SaveChange; t: Translate }): ReactNode {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState<AspectRatio | undefined>()
  const shown = saving ?? aspectRatio
  const items: MenuEntry[] = [
    { type: 'label', id: 'aspect-label', text: t('project.aspect.label') },
    ...ASPECT_RATIOS.map(value => ({ id: value, label: value })),
  ]
  const pick = (id: string): void => {
    setOpen(false)
    if (!isAspectRatio(id) || id === aspectRatio) return
    setSaving(id)
    void save({ aspectRatio: id }).finally(() => { setSaving(undefined) })
  }
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      anchor={(
        <Button
          variant="ghost"
          size="sm"
          className={css.aspect}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('project.aspect.button', { value: shown })}
          disabled={saving !== undefined}
          onClick={() => { setOpen(value => !value) }}
        >
          {shown}
        </Button>
      )}
      items={items}
      selectedId={shown}
      onSelect={pick}
      footer={[{ type: 'label', id: 'aspect-note', text: t('project.aspect.note') }]}
      portal
      dense
    />
  )
}
