/** The browser half registers exactly the three parts as right-sidebar tab types: the 0.1 editing desk tab is gone. */

import { describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/client/index.ts'
import { PARTS, kindOf } from '../../src/client/views.ts'
import { en, zh } from '../../src/client/locales.ts'

// The Host provides the primitives at run time; the tab bodies are not drawn here.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null }))

describe('the tab types', () => {
  it('registers the story, board and director tab types and nothing else', () => {
    const types: Array<{ id: string; kind: string; guide: readonly { id: string }[] }> = []
    const bodies: string[] = []
    const ctx = {
      effect: (callback: () => unknown) => { callback() },
      locale: { register: () => () => {}, bind: () => (key: string) => key },
      slots: {
        inject: (_slot: string, register: () => unknown) => register(),
        register: (options: Record<string, unknown>) => { bodies.push(String(options.key)); return () => {} },
      },
      sidebarRightTabs: { register: (definition: { id: string; kind: string; guide: readonly { id: string }[] }) => { types.push(definition); return () => {} } },
    }
    apply(ctx)
    expect(types.map(type => [type.id, type.kind, type.guide.map(entry => entry.id)])).toEqual([
      ['dsh-film/story', 'film-story', ['story']],
      ['dsh-film/board', 'film-board', ['board']],
      ['dsh-film/director', 'film-director', ['director']],
    ])
    expect(bodies).toEqual(['dsh-film/story', 'dsh-film/board', 'dsh-film/director'])
  })

  it('has no timeline part, kind or strings', () => {
    expect(PARTS.map(part => part.view)).toEqual(['story', 'board', 'director'])
    expect(() => kindOf('timeline' as never)).toThrow(/unknown part/u)
    for (const dictionary of [zh, en]) {
      expect(Object.keys(dictionary).filter(key => /^(timeline|assets|kind|preview)\./u.test(key) || /timeline|Timeline|\.clip$/u.test(key))).toEqual([])
      expect(Object.values(dictionary).join('\n')).not.toMatch(/剪辑台|editing desk/u)
    }
  })
})
