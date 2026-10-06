/**
 * The complementary VibeDev components this plugin's own work leans on, and the
 * way to the plugin centre that lists the rest.
 *
 * What the Host actually has comes from its plugin inventory (a bundle the
 * profile installed, or one the application provides itself); the centre's own
 * page is opened where it is registered, and otherwise the Host's install
 * entry, and otherwise the spec a person can paste into the Plugins page. Every
 * service is read optionally through a property check, so a Host without a
 * plugin manager, without a panel layout, or without the plugin navigation
 * contract keeps this plugin working and simply shows no entry, or the manual
 * one. Nothing here installs anything: the centre and the Plugins page own
 * every install, approval and progress.
 *
 * Package names are the stable ones the centre's catalogue and the plugin
 * manager know; no version is named here, because the catalogue and the install
 * dialog are what discover the current one.
 */

/** The VibeDev components by package name; the centre is the way to all of them. */
export const SUITE = {
  account: '@vibedev-si/dsh-vibedev',
  center: '@vibedev-si/dsh-ecosystem',
  film: 'dsh-film',
  viewer: '@vibedev-si/dsh-media-viewer',
} as const

/** The package a person can add on the Plugins page when nothing can open the centre. */
export const CENTER_SPEC = SUITE.center

/** The main panel the VibeDev plugin centre registers its page under. */
const CENTER_PANEL = 'vibedev-center'

/** One row of the Host's bundle inventory, as much as this module reads. */
export interface SuiteBundle {
  readonly name?: unknown
  readonly installed?: unknown
  readonly removable?: unknown
  readonly source?: unknown
}

/** The client context, as much as this module reads; every service is optional. */
export interface SuiteContext {
  readonly remote?: unknown
  readonly slots?: unknown
  readonly layout?: unknown
  readonly pluginNavigation?: unknown
}

/** The packages present on this Host, by name. */
export type Presence = ReadonlySet<string>

/** What one inventory read found: `ok` is false when nothing could be read. */
export interface PresenceRead {
  readonly ok: boolean
  readonly present: Presence
}

/** Where one request for the rest ended up. */
export type CenterTarget =
  | { readonly kind: 'center' }
  | { readonly kind: 'plugins' }
  | { readonly kind: 'manual'; readonly spec: string }

/** One component a surface leans on: the package to look for and the copy that explains the need. */
export interface SuiteWant<K extends string = string> {
  readonly package: string
  /** Dictionary key of the line shown while this package is absent. */
  readonly key: K
}

/** One absent component, with the line to show. */
export interface SuiteLine {
  readonly package: string
  /** The translated reason this component is offered. */
  readonly line: string
}

/** What a surface says next to its own work. */
export interface SuiteHint {
  /** `missing` names what is absent; `tools` offers the way to everything else, and claims nothing. */
  readonly kind: 'missing' | 'tools'
  readonly missing: readonly SuiteLine[]
}

/** What the entry hands a lazily loaded card. */
export interface SuiteView {
  subscribe(listener: () => void): () => void
  getSnapshot(): SuiteSnapshot
  /** @returns what opening the centre did; `manual` carries the spec to offer instead. */
  open(): CenterTarget
  /** @param text - text to place on the clipboard. @returns whether it was written. */
  copy(text: string): Promise<boolean>
}

/** What a card renders for. */
export interface SuiteSnapshot {
  /** False until the first read settled; nothing is claimed before that. */
  readonly read: boolean
  /** What the read found: an unreadable inventory offers the centre, not a recommendation. */
  readonly found: PresenceRead
  readonly hint: SuiteHint
}

/** A property value read as a record, without trusting its declared type. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * One service of the client context, read optionally.
 * `ctx.get(name)` answers for an absent or inactive service without the strict property read;
 * a Host, or a service, whose own getter throws answers undefined here rather than failing the plugin.
 * @param ctx - the client context.
 * @param name - the service name.
 * @returns the service, or undefined when this Host does not serve it.
 */
function service(ctx: unknown, name: string): unknown {
  const record = asRecord(ctx)
  if (record === undefined) return undefined
  const get: unknown = record.get
  if (typeof get === 'function') {
    try {
      const value: unknown = (get as (name: string) => unknown).call(record, name)
      if (value !== undefined) return value
    } catch (_error) {
      // A strict context refuses a service it was not injected with; the property read below is the fallback.
    }
  }
  try {
    return record[name]
  } catch (_error) {
    // A strict property getter throws for the same reason.
    return undefined
  }
}

/**
 * Whether the Host has a bundle: the profile installed it, or the application provides it itself.
 * @param bundle - one inventory row.
 * @returns whether the component is usable without installing anything.
 */
export function bundlePresent(bundle: SuiteBundle): boolean {
  return bundle.installed === true || (bundle.removable === false && !bundle.source)
}

/**
 * The present package names of one inventory answer's rows.
 * @param answer - the Host's answer to `listBundles`.
 * @returns the names, empty when the answer carries no list.
 */
export function presentFrom(answer: unknown): Presence {
  const rows = asRecord(answer)?.value
  if (!Array.isArray(rows)) return new Set()
  const names = new Set<string>()
  for (const row of rows) {
    const bundle = asRecord(row)
    if (bundle === undefined || !bundlePresent(bundle)) continue
    if (typeof bundle.name === 'string' && bundle.name !== '') names.add(bundle.name)
  }
  return names
}

/**
 * What one inventory answer means. Only an accepted envelope carrying a list is an inventory:
 * a refused answer (`ok: false` with an error) and a value that is not a list are both unread,
 * never an empty Host, so nothing is ever reported missing on the strength of a failure.
 * A Host that answers with the list itself is accepted as well.
 * @param answer - the Host's answer to `listBundles`.
 * @returns the read, with `ok` false when nothing could be learned.
 */
export function presentFromAnswer(answer: unknown): PresenceRead {
  const record = asRecord(answer)
  if (record === undefined) return { ok: false, present: new Set() }
  if (record.ok === true && Array.isArray(record.value)) return { ok: true, present: presentFrom(record) }
  if (Array.isArray(answer)) return { ok: true, present: presentFrom({ value: answer }) }
  return { ok: false, present: new Set() }
}

/**
 * Read the Host's plugin inventory once.
 * @param ctx - the client context.
 * @returns what is present, or `ok: false` when no inventory could be read.
 */
export async function readPresence(ctx: SuiteContext): Promise<PresenceRead> {
  const manager = asRecord(service(service(ctx, 'remote'), 'pluginManager'))
  const listBundles: unknown = manager?.listBundles
  if (typeof listBundles !== 'function') return { ok: false, present: new Set() }
  try {
    return presentFromAnswer(await (listBundles as () => unknown).call(manager))
  } catch (_error) {
    // A manager that cannot answer is not an inventory of nothing: the caller offers the centre only.
    return { ok: false, present: new Set() }
  }
}

/**
 * Hear about installs, removals and activations.
 * @param ctx - the client context.
 * @param listener - called after every change.
 * @returns the unsubscribe, a no-op on a Host without the event bus.
 */
export function observePresence(ctx: SuiteContext, listener: () => void): () => void {
  const remote = asRecord(service(ctx, 'remote'))
  const on: unknown = remote?.$on
  if (typeof on !== 'function') return () => {}
  try {
    const off: unknown = (on as (event: string, listener: () => void) => unknown).call(remote, 'plugin-manager/changed', listener)
    if (typeof off !== 'function') return () => {}
    const stop = off as () => void
    return () => { stop() }
  } catch (_error) {
    // An event bus that refuses the subscription leaves the first read standing.
    return () => {}
  }
}

/**
 * The centre's main panel, where this Host registered one.
 * A slots entry keeps its identity in `options` (`options.key` is the panel id the layout
 * selects); older shapes kept `key`/`id` at the top level, which is still read as a fallback.
 * @param ctx - the client context.
 * @returns the panel id the layout selects, or undefined when there is no centre page.
 */
export function centerPanel(ctx: SuiteContext): string | undefined {
  const slots = asRecord(service(ctx, 'slots'))
  const entries: unknown = slots?.entries
  if (typeof entries !== 'function') return undefined
  const listed: unknown = (entries as (slot: string) => unknown).call(slots, 'main')
  if (!Array.isArray(listed)) return undefined
  for (const entry of listed) {
    const record = asRecord(entry)
    const options = asRecord(record?.options)
    const key = options?.key ?? record?.key ?? options?.id ?? record?.id
    if (key === CENTER_PANEL) return CENTER_PANEL
  }
  return undefined
}

/**
 * Send the person to the VibeDev plugin centre, or to the Host's own way of installing it.
 * A panel that is gone, a layout that refuses, and a missing navigation contract each fall
 * through to the next, and the last answer is the spec to paste.
 * @param ctx - the client context.
 * @returns what was opened.
 */
export function openCenter(ctx: SuiteContext): CenterTarget {
  const panel = centerPanel(ctx)
  const selectPanel: unknown = asRecord(service(ctx, 'layout'))?.selectPanel
  if (panel !== undefined && typeof selectPanel === 'function') {
    try {
      (selectPanel as (id: string) => unknown).call(service(ctx, 'layout'), panel)
      return { kind: 'center' }
    } catch (_error) {
      // The layout throws for a panel that is no longer registered; the install fallbacks follow.
    }
  }
  const navigation = asRecord(service(ctx, 'pluginNavigation'))
  const openBundle: unknown = navigation?.openBundle
  if (typeof openBundle === 'function') {
    try {
      (openBundle as (name: string) => unknown).call(navigation, SUITE.center)
      return { kind: 'plugins' }
    } catch (_error) {
      // Same for a Plugins panel this Host does not have; try the install dialog.
    }
  }
  const openInstall: unknown = navigation?.openInstall
  if (typeof openInstall === 'function') {
    try {
      (openInstall as (prefill: { spec: string }) => unknown).call(navigation, { spec: CENTER_SPEC })
      return { kind: 'plugins' }
    } catch (_error) {
      // Nothing could open: the card offers the spec instead.
    }
  }
  return { kind: 'manual', spec: CENTER_SPEC }
}

/**
 * Which of `wanted` this Host does not have yet.
 * @param present - what the Host has.
 * @param wanted - the components, in the order the surface lists them.
 * @returns the absent ones.
 */
export function missingFrom<K extends string>(present: Presence, wanted: readonly SuiteWant<K>[]): readonly SuiteWant<K>[] {
  return wanted.filter(want => !present.has(want.package))
}

/**
 * What a surface says: the reasons something is absent, or the one way to the rest.
 * An inventory that could not be read claims nothing and offers the centre.
 * @param read - the inventory read.
 * @param wanted - the components this surface leans on.
 * @param translate - the entry's bound dictionary, so a card renders lines rather than keys.
 * @returns the hint the card renders.
 */
export function suiteHint<K extends string>(
  read: PresenceRead, wanted: readonly SuiteWant<K>[], translate: (key: K) => string,
): SuiteHint {
  if (!read.ok) return { kind: 'tools', missing: [] }
  const missing = missingFrom(read.present, wanted)
  if (missing.length === 0) return { kind: 'tools', missing: [] }
  return { kind: 'missing', missing: missing.map(want => ({ package: want.package, line: translate(want.key) })) }
}

/** Write text through the browser's clipboard, where the page has one. */
async function writeClipboard(text: string): Promise<boolean> {
  const clipboard = asRecord(asRecord(globalThis)?.navigator)?.clipboard
  const writeText: unknown = asRecord(clipboard)?.writeText
  if (typeof writeText !== 'function') return false
  try {
    await (writeText as (text: string) => Promise<void>).call(clipboard, text)
    return true
  } catch (_error) {
    // A refused clipboard leaves the spec on screen to select by hand.
    return false
  }
}

/**
 * The entry's read of what this Host has, shared by every card it hands to the workbench.
 * @param ctx - the client context.
 * @param wanted - the components this plugin's own work leans on.
 * @param translate - the entry's bound dictionary.
 * @returns the store: subscribe and render through {@link SuiteView}, and start it inside an effect.
 */
export function createSuiteStore<K extends string>(
  ctx: SuiteContext, wanted: readonly SuiteWant<K>[], translate: (key: K) => string,
): SuiteView & { start(): () => void } {
  let snapshot: SuiteSnapshot = { read: false, found: { ok: false, present: new Set() }, hint: { kind: 'tools', missing: [] } }
  const listeners = new Set<() => void>()
  const publish = (next: SuiteSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const read = async (): Promise<void> => {
    const found = await readPresence(ctx)
    publish({ read: true, found, hint: suiteHint(found, wanted, translate) })
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    open: () => openCenter(ctx),
    copy: writeClipboard,
    start: () => {
      void read()
      return observePresence(ctx, () => { void read() })
    },
  }
}
