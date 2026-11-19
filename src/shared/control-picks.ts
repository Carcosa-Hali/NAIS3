/**
 * Builds the expression a controls-panel selection is pinned as.
 *
 * - random() variables: the ticked options become `random(a @3, b)` (a single tick pins that option);
 * - row() / deal() variables: the ticked rows (`<Sheet/key#12>`) or column pools (`<Sheet/*[column=value]>`)
 *   become `row(<…> @3, <…>)` / `deal(…)`; a single ticked row is pinned as `row(<…>)`.
 *
 * Pure module, shared by the renderer and the tests.
 */

import type { PinPick } from './types'

/** `random(<a#1>)` -> `<a#1>`; a literal option stays as it is. */
export function optionItem(lock: string): string {
  const match = /^random\(([\s\S]*)\)$/.exec(lock.trim())
  return match ? match[1] : lock.trim()
}

/** `row(<a#1>)` / `deal(<a#1>)` -> `<a#1>`; a bare reference stays as it is. */
export function rowItem(lock: string): string {
  const match = /^(?:row|deal)\(([\s\S]*)\)$/.exec(lock.trim())
  return match ? match[1].trim() : lock.trim()
}

const weightSuffix = (weight: number): string =>
  Number.isFinite(weight) && weight !== 1 ? ` @${Math.max(0, Math.round(weight * 100) / 100)}` : ''

/** The `$name := …` expression for a set of ticked entries; '' when nothing (with a weight above 0) is ticked. */
export function picksLock(fn: 'random' | 'row' | 'deal', picks: PinPick[]): string {
  const live = picks.filter((pick) => pick.weight > 0)
  if (live.length === 0) return ''
  if (fn === 'random') {
    if (live.length === 1) return live[0].lock
    return `random(${live.map((p) => optionItem(p.lock) + weightSuffix(p.weight)).join(', ')})`
  }
  const items = live.map((p) => rowItem(p.lock))
  // one exact row: a plain pin (taken by deal() like any pinned row)
  if (items.length === 1 && /#\d+>$/.test(items[0])) return `row(${items[0]})`
  return `${fn}(${items.map((item, i) => item + weightSuffix(live[i].weight)).join(', ')})`
}

/** Short text for a pin made of picks: `a`, or `a, b (+3)`. */
export function picksLabel(picks: PinPick[], limit = 2): string {
  const live = picks.filter((pick) => pick.weight > 0)
  const head = live
    .slice(0, limit)
    .map((p) => p.label)
    .join(', ')
  return live.length > limit ? `${head} (+${live.length - limit})` : head
}
