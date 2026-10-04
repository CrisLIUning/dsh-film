/**
 * The header's title editing, as plain functions: what a finished edit saves,
 * cleaned the way the Host cleans a title.
 */

import { TITLE_MAX } from './api.ts'

/**
 * Clean a typed title as the Host does: whitespace runs fold to one space,
 * control characters go, and the result is cut to {@link TITLE_MAX} characters.
 * @param title - the typed title.
 * @returns the cleaned title, possibly empty.
 */
export function cleanTitle(title: string): string {
  const folded = title.normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return [...folded].slice(0, TITLE_MAX).join('').trim()
}

/**
 * What finishing a title edit saves.
 * @param draft - what the input holds.
 * @param current - the film's title now.
 * @returns the title to save, or `undefined` when there is nothing to save
 *   (the draft is blank, or the same title once cleaned).
 */
export function titleToSave(draft: string, current: string): string | undefined {
  const title = cleanTitle(draft)
  return title === '' || title === current ? undefined : title
}

/** How a key pressed in the title input ends the edit. */
export type TitleKeyAction = 'save' | 'cancel' | undefined

/**
 * Enter saves and Escape cancels — except while an input method is composing
 * (Enter then picks the candidate, as when typing Chinese).
 * @param key - `KeyboardEvent.key`.
 * @param composing - whether an input method is composing (`isComposing`, or key code 229).
 * @returns what the key does to the edit.
 */
export function titleKeyAction(key: string, composing: boolean): TitleKeyAction {
  if (composing) return undefined
  if (key === 'Enter') return 'save'
  if (key === 'Escape') return 'cancel'
  return undefined
}
