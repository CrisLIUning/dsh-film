/**
 * The 结构, 镜头 and 人物/地点/道具 views: the screenplay's scenes, shots and
 * cards as the plugin parsed the saved file. Every change is an operation on
 * the saved screenplay, so the views are read-only while the body has
 * unsaved text. Cards show their main reference image as a cover (Studio
 * `StoryCardImage`); scenes can be sent to the storyboard (送到画布).
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StoryBlock, StoryDeletedObject, StoryEntity, StoryMetadata, StoryObjectTarget, StoryScene, StoryShot } from '../../../screenwriter/contracts/types.ts'
import type { Translate } from '../../types.ts'
import { cardDescription, cardName } from './cards.ts'
import css from './screenwriter.module.css'

export type ObjectFilter = 'active' | 'archived' | 'deleted'
export type EntityKind = StoryEntity['kind']

/** What the views need to know and may do. */
export interface CardViewContext {
  metadata: StoryMetadata
  blocks: ReadonlyMap<string, StoryBlock>
  filter: ObjectFilter
  /** Operations may run now. */
  canMutate: boolean
  t: Translate
  onAddScene: (beforeSceneId?: string) => void
  onAddShot: () => void
  onAddEntity: (kind: EntityKind) => void
  onMove: (kind: 'scene' | 'shot', id: string, direction: -1 | 1) => void
  onArchive: (target: StoryObjectTarget, archived: boolean) => void
  onDelete: (target: StoryObjectTarget) => void
  onRestore: (target: StoryObjectTarget) => void
  onScenePlace: (scene: StoryScene, placeId: string | null) => void
  /** Open a card's details; `references` opens its reference picker at once. */
  onOpenCard: (target: { kind: 'entity' | 'shot'; id: string }, options?: { references?: boolean }) => void
  onEditBlock: (blockId: string) => void
  /** A card's cover image (its whole-screenplay main reference), or `null`. */
  coverUrl: (target: { kind: 'entity' | 'shot'; id: string }) => string | null
  /** Send a scene to the board as a source card (送到画布). */
  onSendScene: (sceneId: string) => void
  /** A send is under way. */
  sending: boolean
}

const GLYPHS: Record<EntityKind | 'shot', ReactNode> = {
  person: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></>,
  place: <><path d="M4 11 12 4l8 7" /><path d="M6 10v10h12V10" /><path d="M10 20v-5h4v5" /></>,
  prop: <><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></>,
  shot: <><rect x="3" y="6" width="18" height="12" rx="1.5" /><path d="M7 6v12M17 6v12M3 10h4M3 14h4M17 10h4M17 14h4" /></>,
}

/**
 * A card's 16:9 cover: its main reference image, or the kind's glyph when it
 * has none or the image cannot be read (Studio `StoryCardImage`).
 * @param props - the image URL and the card kind.
 */
export function CardImage({ url, kind }: { url: string | null; kind: EntityKind | 'shot' }): ReactNode {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [url])
  return (
    <div className={css.cardImage}>
      {url !== null && !failed
        ? <img src={url} alt="" loading="lazy" onError={() => { setFailed(true) }} />
        : <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPHS[kind]}</svg>}
    </div>
  )
}

const titleOf = (blocks: ReadonlyMap<string, StoryBlock>, id: string | undefined | null, t: Translate): string =>
  (id ? cardName(blocks.get(id)?.markdown ?? '') : '') || t('sw.unnamed')

const visible = <T extends { archived?: boolean }>(items: readonly T[], filter: ObjectFilter): T[] =>
  items.filter(item => filter === 'archived' ? item.archived === true : item.archived !== true)

/** Scenes in their declared order. */
export function orderedScenes(metadata: StoryMetadata): StoryScene[] {
  return metadata.sceneOrder.map(id => metadata.scenes.find(scene => scene.id === id)).filter((scene): scene is StoryScene => scene !== undefined)
}

/** Shots in their declared order. */
export function orderedShots(metadata: StoryMetadata): StoryShot[] {
  return metadata.shotOrder.map(id => metadata.shots.find(shot => shot.id === id)).filter((shot): shot is StoryShot => shot !== undefined)
}

function Deleted({ items, context }: { items: StoryDeletedObject[]; context: CardViewContext }): ReactNode {
  const { t } = context
  if (items.length === 0) return <p className={css.quiet}>{t('sw.noDeleted')}</p>
  return (
    <div className={css.cards}>
      {items.map(item => (
        <article key={item.id} className={css.card}>
          <strong className={css.cardTitle}>{item.title || t('sw.unnamed')}</strong>
          <p className={css.quiet}>{t('sw.deletedNote')}</p>
          <div className={css.actions}>
            <Button size="sm" variant="outline" disabled={!context.canMutate} onClick={() => { context.onRestore({ kind: item.kind, id: item.id }) }}>{t('sw.restore')}</Button>
          </div>
        </article>
      ))}
    </div>
  )
}

/**
 * The scenes, with their place and an excerpt.
 * @param props - the context.
 */
export function StructureView({ context }: { context: CardViewContext }): ReactNode {
  const { metadata, blocks, filter, canMutate, t } = context
  if (filter === 'deleted') return <Deleted items={metadata.deletedObjects.filter(item => item.kind === 'scene')} context={context} />
  const scenes = visible(orderedScenes(metadata), filter)
  const places = metadata.entities.filter(entity => entity.kind === 'place' && entity.archived !== true)
  return (
    <div className={css.list}>
      <div className={css.listHeader}>
        <Button size="sm" variant="outline" disabled={!canMutate} onClick={() => { context.onAddScene() }}>{t('sw.newScene')}</Button>
      </div>
      {scenes.length === 0 && <p className={css.quiet}>{t('sw.noScenes')}</p>}
      {scenes.map((scene, index) => {
        const excerpt = scene.blockIds.filter(id => id !== scene.headingBlockId).map(id => blocks.get(id)?.markdown.trim() ?? '').filter(Boolean).join('\n').slice(0, 280)
        return (
          <article key={scene.id} className={css.card}>
            <header className={css.cardHeader}>
              <strong className={css.cardTitle}>{index + 1}. {titleOf(blocks, scene.headingBlockId, t)}</strong>
              <div className={css.iconActions}>
                <Button size="sm" variant="ghost" aria-label={t('sw.moveUp')} title={t('sw.moveUp')} disabled={!canMutate || index === 0} onClick={() => { context.onMove('scene', scene.id, -1) }}>↑</Button>
                <Button size="sm" variant="ghost" aria-label={t('sw.moveDown')} title={t('sw.moveDown')} disabled={!canMutate || index === scenes.length - 1} onClick={() => { context.onMove('scene', scene.id, 1) }}>↓</Button>
              </div>
            </header>
            <label className={css.inlineField}>
              <span>{t('sw.place')}</span>
              <select
                className={css.select}
                value={scene.placeId ?? ''}
                disabled={!canMutate}
                onChange={(event) => { context.onScenePlace(scene, event.currentTarget.value || null) }}
              >
                <option value="">{t('sw.noPlace')}</option>
                {places.map(place => <option key={place.id} value={place.id}>{titleOf(blocks, place.profileBlockId, t)}</option>)}
              </select>
            </label>
            {excerpt !== '' && <p className={css.excerpt}>{excerpt}</p>}
            <div className={css.actions}>
              <Button size="sm" variant="ghost" onClick={() => { context.onEditBlock(scene.headingBlockId) }}>{t('sw.editInBody')}</Button>
              {filter === 'active' && <Button size="sm" variant="ghost" disabled={!canMutate || context.sending} onClick={() => { context.onSendScene(scene.id) }}>{t('sw.handoff.send')}</Button>}
              {filter === 'active' && <Button size="sm" variant="ghost" disabled={!canMutate} onClick={() => { context.onAddScene(scene.id) }}>{t('sw.insertBefore')}</Button>}
              <Button size="sm" variant="ghost" disabled={!canMutate} onClick={() => { context.onArchive({ kind: 'scene', id: scene.id }, scene.archived !== true) }}>{scene.archived === true ? t('sw.unarchive') : t('sw.archive')}</Button>
              <Button size="sm" variant="ghost" disabled={!canMutate} onClick={() => { context.onDelete({ kind: 'scene', id: scene.id }) }}>{t('sw.delete')}</Button>
            </div>
          </article>
        )
      })}
    </div>
  )
}

/**
 * The shots, as cards.
 * @param props - the context.
 */
export function ShotsView({ context }: { context: CardViewContext }): ReactNode {
  const { metadata, blocks, filter, canMutate, t } = context
  if (filter === 'deleted') return <Deleted items={metadata.deletedObjects.filter(item => item.kind === 'shot')} context={context} />
  const shots = visible(orderedShots(metadata), filter)
  const sceneTitle = (sceneId: string | null | undefined): string => {
    const scene = metadata.scenes.find(item => item.id === sceneId)
    return scene === undefined ? t('sw.noScene') : titleOf(blocks, scene.headingBlockId, t)
  }
  return (
    <div className={css.list}>
      <div className={css.listHeader}>
        <Button size="sm" variant="outline" disabled={!canMutate} onClick={context.onAddShot}>{t('sw.newShot')}</Button>
      </div>
      {shots.length === 0 && <p className={css.quiet}>{t('sw.noShots')}</p>}
      <div className={css.cards}>
        {shots.map((shot, index) => {
          const markdown = blocks.get(shot.descriptionBlockId)?.markdown ?? ''
          return (
            <article key={shot.id} className={css.card}>
              <CardImage url={context.coverUrl({ kind: 'shot', id: shot.id })} kind="shot" />
              <header className={css.cardHeader}>
                <strong className={css.cardTitle}>{index + 1}. {cardName(markdown) || t('sw.unnamed')}</strong>
                <div className={css.iconActions}>
                  <Button size="sm" variant="ghost" aria-label={t('sw.moveUp')} title={t('sw.moveUp')} disabled={!canMutate || index === 0} onClick={() => { context.onMove('shot', shot.id, -1) }}>↑</Button>
                  <Button size="sm" variant="ghost" aria-label={t('sw.moveDown')} title={t('sw.moveDown')} disabled={!canMutate || index === shots.length - 1} onClick={() => { context.onMove('shot', shot.id, 1) }}>↓</Button>
                </div>
              </header>
              {cardDescription(markdown) !== '' && <p className={css.excerpt}>{cardDescription(markdown)}</p>}
              <p className={css.meta}>
                <span>{sceneTitle(shot.sceneId)}</span>
                {typeof shot.estimatedSeconds === 'number' && <span>{t('sw.secondsShort', { seconds: shot.estimatedSeconds })}</span>}
              </p>
              <div className={css.actions}>
                <Button size="sm" variant="ghost" onClick={() => { context.onOpenCard({ kind: 'shot', id: shot.id }, { references: true }) }}>{t('sw.ref.choose')}</Button>
                <Button size="sm" variant="ghost" onClick={() => { context.onOpenCard({ kind: 'shot', id: shot.id }) }}>{t('sw.details')}</Button>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The people, places or props.
 * @param props - which kind, and the context.
 */
export function EntitiesView({ kind, context }: { kind: EntityKind; context: CardViewContext }): ReactNode {
  const { metadata, blocks, filter, canMutate, t } = context
  if (filter === 'deleted') return <Deleted items={metadata.deletedObjects.filter(item => item.kind === 'entity' && (item.record as StoryEntity).kind === kind)} context={context} />
  const entities = visible(metadata.entities.filter(entity => entity.kind === kind), filter)
  return (
    <div className={css.list}>
      <div className={css.listHeader}>
        <Button size="sm" variant="outline" disabled={!canMutate} onClick={() => { context.onAddEntity(kind) }}>{t('sw.newCard')}</Button>
      </div>
      {entities.length === 0 && <p className={css.quiet}>{t('sw.noCards')}</p>}
      <div className={css.cards}>
        {entities.map((entity) => {
          const markdown = blocks.get(entity.profileBlockId)?.markdown ?? ''
          return (
            <article key={entity.id} className={css.card}>
              <CardImage url={context.coverUrl({ kind: 'entity', id: entity.id })} kind={entity.kind} />
              <strong className={css.cardTitle}>{cardName(markdown) || t('sw.unnamed')}</strong>
              {cardDescription(markdown) !== '' && <p className={css.excerpt}>{cardDescription(markdown)}</p>}
              {typeof entity.visualIdentity === 'string' && entity.visualIdentity !== '' && <p className={css.meta}>{entity.visualIdentity}</p>}
              <div className={css.actions}>
                <Button size="sm" variant="ghost" onClick={() => { context.onOpenCard({ kind: 'entity', id: entity.id }, { references: true }) }}>{t('sw.ref.choose')}</Button>
                <Button size="sm" variant="ghost" onClick={() => { context.onOpenCard({ kind: 'entity', id: entity.id }) }}>{t('sw.details')}</Button>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
