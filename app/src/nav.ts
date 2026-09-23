/**
 * Back/forward navigation history, per tab.
 *
 * Every "jump" — link, outline entry, search result, typed page number,
 * bookmark — records where the reader WAS, so ⌥← / ⌘[ / mouse-back / the
 * back pill can return there. Plain scrolling and page turning are not
 * jumps and never touch the history, exactly like a browser.
 *
 *   jump(tab, fn):  back.push(here) ; fwd = [] ; fn()
 *   back(tab):      fwd.push(here)  ; go(back.pop())
 *   forward(tab):   back.push(here) ; go(fwd.pop())
 *
 * Stacks are plain arrays outside reactivity; `navState` mirrors only their
 * depths (and the last jump time) so the toolbar buttons and the phone pill
 * can react without proxying positions.
 */
import { reactive } from 'vue'
import { controllers } from './store'

interface Pos { page: number; ratio: number }

const MAX_DEPTH = 100

const stacks = new Map<number, { back: Pos[]; fwd: Pos[] }>()

/** reactive mirror: depths + when the last jump happened (drives the pill) */
export const navState = reactive<Record<number, { back: number; fwd: number; at: number }>>({})

function stackOf(tabId: number): { back: Pos[]; fwd: Pos[] } {
  let s = stacks.get(tabId)
  if (!s) { s = { back: [], fwd: [] }; stacks.set(tabId, s) }
  return s
}

function sync(tabId: number, jumped = false): void {
  const s = stackOf(tabId)
  const prev = navState[tabId]
  navState[tabId] = { back: s.back.length, fwd: s.fwd.length, at: jumped ? Date.now() : prev?.at ?? 0 }
}

const same = (a: Pos, b: Pos): boolean => a.page === b.page && Math.abs(a.ratio - b.ratio) < 0.02

/**
 * Perform a jump and remember where we came from. When the jump turns out
 * not to move anywhere (outline entry for the page you're on), the record is
 * dropped again so Back never becomes a no-op.
 */
export function jump(tabId: number, fn: () => void): void {
  const commit = remember(tabId)
  fn()
  commit()
}

/** record the current position without jumping (async jumps call this first) */
export function remember(tabId: number): () => void {
  const ctrl = controllers.get(tabId)
  const here = ctrl?.getPosition()
  // the returned commit runs once the async jump has landed
  return () => {
    if (!ctrl || !here) return
    const there = ctrl.getPosition()
    if (same(here, there)) return
    const s = stackOf(tabId)
    const top = s.back[s.back.length - 1]
    if (!top || !same(top, here)) s.back.push(here)
    if (s.back.length > MAX_DEPTH) s.back.shift()
    s.fwd = []
    sync(tabId, true)
  }
}

function go(tabId: number, from: 'back' | 'fwd'): boolean {
  const ctrl = controllers.get(tabId)
  const s = stackOf(tabId)
  const src = from === 'back' ? s.back : s.fwd
  const dst = from === 'back' ? s.fwd : s.back
  if (!ctrl || !src.length) return false
  dst.push(ctrl.getPosition())
  const pos = src.pop()!
  ctrl.restorePosition(pos)
  ctrl.settle()
  sync(tabId, true)
  return true
}

export const goBack = (tabId: number): boolean => go(tabId, 'back')
export const goForward = (tabId: number): boolean => go(tabId, 'fwd')

export function forgetNav(tabId: number): void {
  stacks.delete(tabId)
  delete navState[tabId]
}
