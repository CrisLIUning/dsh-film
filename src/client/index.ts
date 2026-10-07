/**
 * dsh-film browser half: the two parts of the film workbench — script,
 * storyboard — as right-sidebar tab types, each with an entry box on the
 * sidebar's guide page. The 3D director desk has no tab of its own: it opens
 * inside the storyboard canvas, as a director node on the board.
 *
 * Built by tsdown into the `__ModuleLoader__` factory bundle at
 * client/client.js, with the workbench itself in client/client.workbench.js,
 * loaded on first use. React and the client primitives come from the Host's
 * module table. The Host surfaces used here are typed structurally, so this
 * external package depends on no monorepo-internal types.
 */

import { en, zh } from './locales.ts'
import { TabBody } from './TabBody.tsx'
import type { Translate } from './types.ts'
import { PARTS } from './views.ts'

/** The dictionary namespace this plugin owns. */
const LOCALE_NAMESPACE = 'dsh-film'

interface LocaleService {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
}

interface SlotsService {
  inject(slot: string, register: () => unknown): unknown
  register(options: Record<string, unknown>, render: unknown): unknown
}

/** The slice of a right-sidebar tab type definition this plugin uses. */
interface TabDefinition {
  id: string
  kind: string
  /** Keep a visited body mounted through hiding (the DSH sidebar's `keepMounted`). */
  keepMounted?: boolean
  title: (address: string) => string
  guide: readonly {
    id: string
    order: number
    title: () => string
    description: () => string
    icon: unknown
  }[]
}

interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
  sidebarRightTabs: { register(definition: TabDefinition): unknown }
}

export const name = 'dsh-film'
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Register the dictionaries, then each part's tab type and body.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-film: dictionaries')
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  for (const part of PARTS) {
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: part.id,
      kind: part.kind,
      ...(part.keepMounted === true ? { keepMounted: true } : {}),
      title: () => t(`${part.view}.title`),
      guide: [{
        id: part.view,
        order: part.order,
        title: () => t(`${part.view}.title`),
        description: () => t(`${part.view}.guide.description`),
        icon: part.artwork,
      }],
    }), `dsh-film: ${part.kind} type`)
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: part.id, locale: LOCALE_NAMESPACE, inject: () => ({ translate: t, view: part.view }) },
      TabBody,
    )), `dsh-film: ${part.kind} body`)
  }
}
