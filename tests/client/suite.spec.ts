/**
 * The suite helper: reading what this Host actually has, and the one click that leads to the
 * plugin centre. The cards themselves are thin React over this, so everything that could
 * recommend the wrong thing (or nothing at all) is pinned here.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CENTER_SPEC, SUITE, bundlePresent, centerPanel, createSuiteStore, missingFrom, observePresence,
  openCenter, presentFrom, presentFromAnswer, readPresence, suiteHint,
} from '../../src/client/suite.ts'
import { SuiteCard, suiteCardView } from '../../src/client/workbench/SuiteCard.tsx'

// The Host provides the primitives at run time; the card's own lines and buttons are what this pins.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null }))

/** The entry's bound dictionary, as the cards receive it: here the key is the line. */
const t = (key: string): string => key

const WANTED = [
  { package: SUITE.account, key: 'suite.account.missing' },
  { package: SUITE.viewer, key: 'suite.viewer.missing' },
]

/** An inventory answer as the Host sends it. */
const answer = (rows: readonly unknown[]) => ({ ok: true, value: rows })

/** A manager that answers with one inventory. */
function manager(rows: readonly unknown[]) {
  return { listBundles: vi.fn(async () => answer(rows)) }
}

/** A factory component, as `SlotsService.register` takes: only its identity matters here. */
const Factory = () => null

/**
 * A slots entry as the Host really stores it: the identity lives under `options`.
 * @param options - the entry's `key`/`id`, exactly as the Host keeps them.
 * @returns the stored entry.
 */
const stored = (options: Record<string, unknown>) => ({ component: Factory, options, inject: [], order: 0 })

/** The first drawn element with this label that carries a click, so a test can fire it without a DOM. */
function clickable(node: unknown, label: string): (() => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = clickable(child, label)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node !== 'object' || node === null) return undefined
  const props = (node as { props?: Record<string, unknown> }).props
  if (props === undefined) return undefined
  if (props.children === label && typeof props.onClick === 'function') return props.onClick as () => void
  return clickable(props.children, label)
}

/** A settled store over a fake Host, so a card can be drawn for real. */
async function settled(ctx: Record<string, unknown>) {
  const store = createSuiteStore(ctx, WANTED, t)
  const stop = store.start()
  await vi.waitFor(() => { expect(store.getSnapshot().read).toBe(true) })
  return { store, stop }
}

describe('what the Host has', () => {
  it('counts an installed bundle and one the application provides itself', () => {
    expect(bundlePresent({ installed: true })).toBe(true)
    expect(bundlePresent({ installed: false, removable: false })).toBe(true)
    expect(bundlePresent({ installed: false, removable: false, source: '/somewhere' })).toBe(false)
    expect(bundlePresent({ installed: false, removable: true })).toBe(false)
    expect(bundlePresent({})).toBe(false)
  })

  it('names the present packages and ignores anything else in the answer', () => {
    expect([...presentFrom(answer([
      { name: SUITE.account, installed: true },
      { name: SUITE.viewer, installed: false, removable: false },
      { name: 'dshmarket', installed: false, removable: true },
      { name: '', installed: true },
      { name: SUITE.film, installed: 'yes' },
      null,
    ]))].sort()).toEqual([SUITE.account, SUITE.viewer].sort())
    expect(presentFrom(undefined).size).toBe(0)
    expect(presentFrom({ ok: true, value: 'not a list' }).size).toBe(0)
    expect(presentFrom({ ok: false, error: { message: 'gone' } }).size).toBe(0)
  })

  it('reports a missing or failing manager as unread, not as an empty Host', async () => {
    expect(await readPresence({})).toEqual({ ok: false, present: new Set() })
    expect(await readPresence({ remote: {} })).toEqual({ ok: false, present: new Set() })
    expect(await readPresence({ remote: { pluginManager: {} } })).toEqual({ ok: false, present: new Set() })
    const failing = { pluginManager: { listBundles: vi.fn(async () => { throw new Error('offline') }) } }
    expect(await readPresence({ remote: failing })).toEqual({ ok: false, present: new Set() })
    const working = manager([{ name: SUITE.film, installed: true }])
    expect([...(await readPresence({ remote: { pluginManager: working } })).present]).toEqual([SUITE.film])
    expect(working.listBundles).toHaveBeenCalledOnce()
  })

  it('treats a refused answer and a value that is not a list as unread, never as an empty Host', async () => {
    const refused = { pluginManager: { listBundles: vi.fn(async () => ({ ok: false, error: { message: 'not available' } })) } }
    expect(await readPresence({ remote: refused })).toEqual({ ok: false, present: new Set() })
    const notAList = { pluginManager: { listBundles: vi.fn(async () => ({ ok: true, value: 'nope' })) } }
    expect(await readPresence({ remote: notAList })).toEqual({ ok: false, present: new Set() })
    expect(presentFromAnswer({ ok: false, error: {} })).toEqual({ ok: false, present: new Set() })
    expect(presentFromAnswer({ ok: true })).toEqual({ ok: false, present: new Set() })
    expect(presentFromAnswer(null)).toEqual({ ok: false, present: new Set() })
    // An accepted envelope, and a Host that answers with the list itself, are both inventories.
    const accepted = { pluginManager: { listBundles: vi.fn(async () => answer([{ name: SUITE.account, installed: true }])) } }
    expect(await readPresence({ remote: accepted })).toEqual({ ok: true, present: new Set([SUITE.account]) })
    const bare = { pluginManager: { listBundles: vi.fn(async () => [{ name: SUITE.viewer, installed: true }]) } }
    expect(await readPresence({ remote: bare })).toEqual({ ok: true, present: new Set([SUITE.viewer]) })
  })

  it('survives a context whose optional reads throw', async () => {
    const strict = { get remote(): unknown { throw new Error('cannot get property "remote" without inject') } }
    expect(await readPresence(strict)).toEqual({ ok: false, present: new Set() })
    expect(observePresence(strict, () => {})).toEqual(expect.any(Function))
    expect(centerPanel(strict)).toBeUndefined()
    expect(openCenter(strict)).toEqual({ kind: 'manual', spec: CENTER_SPEC })
    // A context whose `get` refuses still answers through the property read.
    const refusingGet = {
      get: (_name: string): unknown => { throw new Error('no such service') },
      remote: { pluginManager: { listBundles: async () => answer([]) } },
    }
    expect(await readPresence(refusingGet)).toEqual({ ok: true, present: new Set() })
  })

  it('follows plugin-manager/changed and stays quiet without an event bus', () => {
    const listeners: Array<() => void> = []
    const $on = vi.fn((_event: string, listener: () => void) => { listeners.push(listener); return () => { listeners.pop() } })
    const stop = observePresence({ remote: { $on } }, () => {})
    expect($on).toHaveBeenCalledExactlyOnceWith('plugin-manager/changed', expect.any(Function))
    stop()
    expect(listeners).toHaveLength(0)
    expect(observePresence({}, () => {})).toEqual(expect.any(Function))
    expect(observePresence({ remote: { $on: 'not a function' } }, () => {})).toEqual(expect.any(Function))
    const refusing = { $on: vi.fn(() => { throw new Error('no bus') }) }
    expect(observePresence({ remote: refusing }, () => {})).toEqual(expect.any(Function))
  })
})

describe('the way to the centre', () => {
  it('reads the identity the Host really stores, under options', () => {
    const selectPanel = vi.fn()
    const ctx = {
      slots: { entries: () => [stored({ key: 'plugins' }), stored({ key: 'vibedev-center', id: 'centre-entry' })] },
      layout: { selectPanel },
    }
    expect(centerPanel(ctx)).toBe('vibedev-center')
    expect(openCenter(ctx)).toEqual({ kind: 'center' })
    expect(selectPanel).toHaveBeenCalledExactlyOnceWith('vibedev-center')
  })

  it('still recognises an older flat entry and one that carries only the id', () => {
    const selectPanel = vi.fn()
    expect(centerPanel({ slots: { entries: () => [{ key: 'vibedev-center' }] }, layout: { selectPanel } })).toBe('vibedev-center')
    expect(centerPanel({ slots: { entries: () => [stored({ id: 'vibedev-center' })] }, layout: { selectPanel } })).toBe('vibedev-center')
    expect(centerPanel({ slots: { entries: () => [stored({ key: 'plugins' })] }, layout: { selectPanel } })).toBeUndefined()
    expect(centerPanel({ slots: { entries: () => [stored({}), null, 'junk'] }, layout: { selectPanel } })).toBeUndefined()
  })

  it('falls back to the Plugins entry when the centre has no page here', () => {
    const selectPanel = vi.fn()
    const openBundle = vi.fn()
    const ctx = { slots: { entries: () => [stored({ key: 'plugins' })] }, layout: { selectPanel }, pluginNavigation: { openBundle } }
    expect(openCenter(ctx)).toEqual({ kind: 'plugins' })
    expect(selectPanel).not.toHaveBeenCalled()
    expect(openBundle).toHaveBeenCalledExactlyOnceWith(SUITE.center)
    expect(openCenter({ layout: { selectPanel }, pluginNavigation: { openBundle } })).toEqual({ kind: 'plugins' })
    expect(openCenter({ slots: {}, layout: {}, pluginNavigation: { openBundle } })).toEqual({ kind: 'plugins' })
  })

  it('walks past a panel the layout refuses to a prefilled install, then to the spec', () => {
    const openInstall = vi.fn()
    const refused = {
      slots: { entries: () => [stored({ key: 'vibedev-center' })] },
      layout: { selectPanel: () => { throw new Error('panel is not registered') } },
      pluginNavigation: { openBundle: () => { throw new Error('no plugins panel') }, openInstall },
    }
    expect(openCenter(refused)).toEqual({ kind: 'plugins' })
    expect(openInstall).toHaveBeenCalledExactlyOnceWith({ spec: CENTER_SPEC })
    expect(openCenter({})).toEqual({ kind: 'manual', spec: CENTER_SPEC })
    expect(openCenter({ layout: {}, pluginNavigation: {} })).toEqual({ kind: 'manual', spec: CENTER_SPEC })
    expect(openCenter({ pluginNavigation: { openBundle: 'not a function' } })).toEqual({ kind: 'manual', spec: CENTER_SPEC })
  })
})

describe('what a card says', () => {
  it('reasons about exactly what is absent, and offers the centre once nothing is', () => {
    const none = { ok: true, present: new Set<string>() }
    expect(missingFrom(none.present, WANTED)).toEqual(WANTED)
    expect(suiteHint(none, WANTED, t)).toEqual({
      kind: 'missing',
      missing: WANTED.map(want => ({ package: want.package, line: want.key })),
    })
    expect(suiteHint({ ok: true, present: new Set([SUITE.account]) }, WANTED, t).missing.map(want => want.line))
      .toEqual(['suite.viewer.missing'])
    expect(suiteHint({ ok: true, present: new Set([SUITE.account, SUITE.viewer, SUITE.film, SUITE.center]) }, WANTED, t))
      .toEqual({ kind: 'tools', missing: [] })
  })

  it('claims nothing about a Host whose inventory could not be read', () => {
    expect(suiteHint({ ok: false, present: new Set() }, WANTED, t)).toEqual({ kind: 'tools', missing: [] })
  })

  it('reads once, refreshes on a plugin change, and copies where the page has a clipboard', async () => {
    let listeners: Array<() => void> = []
    const rows: Array<unknown> = [{ name: SUITE.account, installed: true }]
    const ctx = {
      remote: {
        pluginManager: { listBundles: async () => answer(rows) },
        $on: (_event: string, listener: () => void) => {
          listeners.push(listener)
          return () => { listeners = listeners.filter(entry => entry !== listener) }
        },
      },
    }
    const store = createSuiteStore(ctx, WANTED, t)
    expect(store.getSnapshot().read).toBe(false)
    const seen = vi.fn()
    const stop = store.subscribe(seen)
    const stopObserving = store.start()
    await vi.waitFor(() => { expect(store.getSnapshot().read).toBe(true) })
    expect(store.getSnapshot().hint.missing.map(want => want.line)).toEqual(['suite.viewer.missing'])
    // The Host installs the viewer: the next change re-reads and the reason goes away.
    rows.push({ name: SUITE.viewer, installed: true })
    listeners[0]!()
    await vi.waitFor(() => { expect(store.getSnapshot().hint.kind).toBe('tools') })
    expect(seen).toHaveBeenCalled()
    stop()
    stopObserving()
    expect(await store.copy(CENTER_SPEC)).toBe(false)
  })
})

describe('the card the workbench draws', () => {
  /** What the card draws, as HTML, for one settled Host. */
  const drawn = async (ctx: Record<string, unknown>) => {
    const { store, stop } = await settled(ctx)
    try {
      return renderToStaticMarkup(createElement(SuiteCard, { suite: store, t }))
    } finally {
      stop()
    }
  }

  it('names exactly what is missing, and only that', async () => {
    const html = await drawn({ remote: { pluginManager: manager([{ name: SUITE.account, installed: true }]) } })
    expect(html).toContain('suite.missing.title')
    expect(html).toContain('suite.viewer.missing')
    expect(html).not.toContain('suite.account.missing')
    expect(html).toContain('data-dsh-film-suite="missing"')
  })

  it('offers the rest of the tools, with no reason, when the Host has everything', async () => {
    const html = await drawn({
      remote: { pluginManager: manager([
        { name: SUITE.account, installed: true }, { name: SUITE.viewer, installed: false, removable: false },
      ]) },
    })
    expect(html).toContain('suite.tools.title')
    expect(html).not.toContain('suite.account.missing')
    expect(html).not.toContain('suite.viewer.missing')
    expect(html).toContain('data-dsh-film-suite="tools"')
  })

  it('claims nothing missing on a Host with no plugin manager at all', async () => {
    const html = await drawn({})
    expect(html).toContain('suite.tools.title')
    expect(html).not.toContain('suite.missing.title')
    expect(html).not.toContain('suite.account.missing')
    expect(html).not.toContain('suite.viewer.missing')
  })

  it('draws nothing before the first read settled', async () => {
    const store = createSuiteStore({}, WANTED, t)
    expect(renderToStaticMarkup(createElement(SuiteCard, { suite: store, t }))).toBe('')
  })

  it('sends an installed centre straight to its panel from the card button', async () => {
    const selectPanel = vi.fn()
    const { store, stop } = await settled({ slots: { entries: () => [stored({ key: 'vibedev-center' })] }, layout: { selectPanel } })
    try {
      const tree = suiteCardView({
        t, hint: store.getSnapshot().hint, copied: false,
        onOpen: () => { void store.open() }, onCopy: () => {},
      })
      clickable(tree, 'suite.open')!()
      expect(selectPanel).toHaveBeenCalledExactlyOnceWith('vibedev-center')
    } finally {
      stop()
    }
  })

  it('sends a Host without the centre to its Plugins entry, and one without either to the spec', async () => {
    const openBundle = vi.fn()
    const { store, stop } = await settled({ pluginNavigation: { openBundle } })
    try {
      const tree = suiteCardView({
        t, hint: store.getSnapshot().hint, copied: false,
        onOpen: () => { void store.open() }, onCopy: () => {},
      })
      clickable(tree, 'suite.open')!()
      expect(openBundle).toHaveBeenCalledExactlyOnceWith(SUITE.center)
    } finally {
      stop()
    }
    const bare = await settled({})
    try {
      expect(bare.store.open()).toEqual({ kind: 'manual', spec: CENTER_SPEC })
      const spec = (bare.store.open() as { spec: string }).spec
      const onCopy = vi.fn()
      const tree = suiteCardView({ t, hint: bare.store.getSnapshot().hint, manual: { spec }, copied: false, onOpen: () => {}, onCopy })
      expect(renderToStaticMarkup(createElement('div', null, tree))).toContain(spec)
      clickable(tree, 'suite.copy')!(  )
      expect(onCopy).toHaveBeenCalledExactlyOnceWith(spec)
    } finally {
      bare.stop()
    }
  })
})
