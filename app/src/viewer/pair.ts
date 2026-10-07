/**
 * Two DIFFERENT documents side by side (desktop / iPad width only).
 *
 * Same-document split (split.ts) puts a second viewport of ONE tab next to
 * the first. A pair instead lays out two whole TABS next to each other, each
 * with everything it already has: its own controller, document, annotation
 * manager and sidecar. Nothing is duplicated and nothing is shared.
 *
 * Design:
 *   - Focus IS the active tab. Clicking (or scrolling into) a pane makes its
 *     tab `store.activeTabId`, so every existing caller — toolbar, page box,
 *     sidebar, search, keyboard, highlight → sidecar, undo — acts on the
 *     focused document without knowing pairs exist. The split.ts invariant
 *     ("controllers maps a tab to its focused pane") is untouched: a paired
 *     tab never has a same-document split (opening one dissolves the other).
 *   - The pair is visible whenever its left OR right tab is active; switching
 *     to a third tab shows that tab alone, switching back restores the pair.
 *   - DOM: every tab's `.pv-panes` already exists. The tab loop sits in
 *     `.pv-stage`, which is `display: contents` (no layout change at all)
 *     until a pair is visible; then it becomes a flex row and the two paired
 *     `.pv-panes` are shown side by side, ordered around a divider.
 *   - Sync scroll (optional, page-locked): the pane the user is driving
 *     (last wheel / pointer / key input) keeps the other pane's reading line
 *     on the corresponding page — same page + the offset at the moment sync
 *     was switched on, or, while comparing, the page the alignment matched.
 *     Only the driver propagates, so the follower's own scroll events never
 *     echo back.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { store, controllers } from '../store'
import { splitAvailable, closeSplit } from './split'

export interface PairState {
  /** left (row) / top (col) tab */
  a: number
  /** right / bottom tab */
  b: number
  dir: 'row' | 'col'
  /** share of the first pane (0.2–0.8) */
  ratio: number
  sync: boolean
  /** page offset b − a captured when sync was switched on */
  offset: number
}

const DIVIDER = 6

export const pair = ref<PairState | null>(null)

/** the pair is on screen (one of its tabs is the active one) */
export const pairVisible = computed(() => {
  const p = pair.value
  return !!p && splitAvailable.value && (store.activeTabId === p.a || store.activeTabId === p.b)
})

export function inPair(tabId: number): boolean {
  const p = pair.value
  return !!p && (p.a === tabId || p.b === tabId)
}

/** a paired tab whose pane is on screen right now */
export function pairShown(tabId: number): boolean {
  return pairVisible.value && inPair(tabId)
}

export function partnerOf(tabId: number): number | null {
  const p = pair.value
  if (!p) return null
  return p.a === tabId ? p.b : p.b === tabId ? p.a : null
}

/** a tab can join a pair: a loaded PDF in page view */
export function pairable(tabId: number): boolean {
  const t = store.tabs.find((x) => x.id === tabId)
  return !!t && t.kind === 'pdf' && !t.bookMode && !t.loadError && controllers.has(tabId)
}

/**
 * Optional page mapper for sync scroll (document compare installs one built
 * from its page alignment). Returns the page on the OTHER side — `exact`
 * false when `page` has no counterpart and this is the page before the gap —
 * or null to leave the other pane where it is.
 */
export type PageMapper = (from: 'a' | 'b', page: number) => { page: number; exact: boolean } | null
let mapper: PageMapper | null = null
export function setPairMapper(m: PageMapper | null): void { mapper = m }

/** called when a pair dissolves (compare tears its marks down) */
const closeListeners: (() => void)[] = []
export function onPairClose(fn: () => void): void { closeListeners.push(fn) }

/** tabs whose pane changed size while hidden: re-fit when next shown */
const needsRefit = new Map<number, { page: number; ratio: number }>()

function positionOf(tabId: number): { page: number; ratio: number } {
  const c = controllers.get(tabId)
  const t = store.tabs.find((x) => x.id === tabId)
  // a hidden (display:none) host has no scroll offset to read
  if (c && c.host.clientWidth > 0) return c.getPosition()
  return { page: t?.currentPage ?? 1, ratio: 0 }
}

async function relayout(ids: number[], pos: Map<number, { page: number; ratio: number }>): Promise<void> {
  await nextTick()
  for (const id of ids) {
    const c = controllers.get(id)
    const p = pos.get(id)
    if (!c || !p) continue
    if (c.host.clientWidth === 0) { needsRefit.set(id, p); continue }
    c.onResize()
    c.restorePosition(p)
    c.update()
  }
}

/** put tab `b` next to tab `a` (a left/top). Returns false if not possible. */
export async function openPair(a: number, b: number, opts: { dir?: 'row' | 'col'; sync?: boolean; focus?: number } = {}): Promise<boolean> {
  if (a === b || !splitAvailable.value || !pairable(a) || !pairable(b)) return false
  const old = pair.value
  if (old && !(inPair(a) && inPair(b))) await closePair()
  const pos = new Map([[a, positionOf(a)], [b, positionOf(b)]])
  // a pair replaces any same-document split on either side
  for (const id of [a, b]) {
    const t = store.tabs.find((x) => x.id === id)
    if (t?.split) await closeSplit(t)
  }
  pair.value = {
    a, b,
    dir: opts.dir ?? store.settings.splitDir,
    ratio: old?.ratio ?? 0.5,
    sync: opts.sync ?? old?.sync ?? false,
    offset: 0,
  }
  if (pair.value.sync) pair.value.offset = pageOf(b) - pageOf(a)
  const focus = opts.focus ?? (store.activeTabId === a || store.activeTabId === b ? store.activeTabId : a)
  store.activeTabId = focus
  driver = null
  await relayout([a, b], pos)
  store.docTick++
  return true
}

/** dissolve the pair; the focused tab keeps the full width */
export async function closePair(): Promise<void> {
  const p = pair.value
  if (!p) return
  const ids = [p.a, p.b].filter((id) => store.tabs.some((t) => t.id === id))
  const pos = new Map(ids.map((id) => [id, positionOf(id)] as const))
  pair.value = null
  mapper = null
  driver = null
  for (const fn of closeListeners) fn()
  await relayout(ids, pos)
  store.docTick++
}

/** focus a pane of the visible pair (= make its tab the active one) */
export function focusPairTab(tabId: number): void {
  if (pairShown(tabId) && store.activeTabId !== tabId) store.activeTabId = tabId
}

/** armed-tool overlays cover both panes: focus whichever pane is under the point */
export function focusPairAt(x: number, y: number): boolean {
  const p = pair.value
  if (!p || !pairVisible.value) return false
  for (const id of [p.a, p.b]) {
    const el = controllers.get(id)?.host
    const r = el?.getBoundingClientRect()
    if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      if (store.activeTabId === id) return false
      store.activeTabId = id
      return true
    }
  }
  return false
}

function pageOf(tabId: number): number {
  return controllers.get(tabId)?.currentPage() ?? 1
}

export function setPairSync(on: boolean): void {
  const p = pair.value
  if (!p) return
  p.sync = on
  if (on) {
    p.offset = pageOf(p.b) - pageOf(p.a)
    // line the follower up right away, from the focused pane
    driver = store.activeTabId
    syncFrom(driver)
  }
}

// ── sync scroll ──

/** the pane the user is driving; only its scrolling propagates */
let driver: number | null = null
export function noteDriver(tabId: number): void { if (inPair(tabId)) driver = tabId }
/** programmatic navigation of both panes: stop propagating until the user acts */
export function releaseDriver(): void { driver = null }

window.addEventListener('keydown', () => { if (pairVisible.value) driver = store.activeTabId }, true)

/** map a page of `tabId` to the partner's corresponding page */
export function mapToPartner(tabId: number, page: number): { page: number; exact: boolean } | null {
  const p = pair.value
  if (!p) return null
  const side = p.a === tabId ? 'a' : 'b'
  if (mapper) return mapper(side, page)
  const other = controllers.get(side === 'a' ? p.b : p.a)
  if (!other) return null
  const target = side === 'a' ? page + p.offset : page - p.offset
  const clamped = Math.min(Math.max(target, 1), other.numPages)
  return { page: clamped, exact: clamped === target }
}

function syncFrom(tabId: number): void {
  const other = partnerOf(tabId)
  const me = controllers.get(tabId)
  const them = other != null ? controllers.get(other) : undefined
  if (!me || !them) return
  const line = me.readingLine()
  const target = mapToPartner(tabId, line.page)
  if (!target) return
  // a page with no counterpart (inserted / deleted while comparing, or past
  // the end of the shorter document): the other side waits at the end of
  // the page before the gap
  them.alignReadingLine(target.page, target.exact ? line.frac : 1)
}

/** from the host's onVisiblePage: fires on every scroll frame of a pane */
export function onPairScroll(tabId: number): void {
  const p = pair.value
  if (!p || !p.sync || driver !== tabId || !pairVisible.value) return
  syncFrom(tabId)
}

// ── layout upkeep ──

/** drag the divider between the two documents */
export function startPairDividerDrag(e: PointerEvent): void {
  const p = pair.value
  const divider = e.currentTarget as HTMLElement
  const box = divider.parentElement
  if (!p || !box) return
  e.preventDefault()
  divider.setPointerCapture?.(e.pointerId)
  const ids = [p.a, p.b]
  const pos = ids.map(positionOf)
  let raf = 0
  const move = (ev: PointerEvent): void => {
    const r = box.getBoundingClientRect()
    const along = p.dir === 'row' ? ev.clientX - r.left : ev.clientY - r.top
    const total = (p.dir === 'row' ? r.width : r.height) - DIVIDER
    p.ratio = Math.min(0.8, Math.max(0.2, along / Math.max(1, total)))
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      ids.forEach((id, i) => { const c = controllers.get(id); if (c) { c.onResize(); c.restorePosition(pos[i]) } })
    })
  }
  const up = (): void => {
    divider.removeEventListener('pointermove', move)
    divider.removeEventListener('pointerup', up)
    divider.removeEventListener('pointercancel', up)
    divider.classList.remove('dragging')
  }
  divider.classList.add('dragging')
  divider.addEventListener('pointermove', move)
  divider.addEventListener('pointerup', up)
  divider.addEventListener('pointercancel', up)
}

/** both panes re-fit to their (new) sizes — sidebar toggled, ratio reset … */
export async function relayoutPair(): Promise<void> {
  const p = pair.value
  if (!p) return
  const ids = [p.a, p.b]
  await relayout(ids, new Map(ids.map((id) => [id, positionOf(id)] as const)))
}

// a tab that changed size while hidden: re-fit when shown again
watch(() => store.activeTabId, async (id) => {
  const ids = pairShown(id) && pair.value ? [pair.value.a, pair.value.b] : [id]
  const todo = ids.filter((x) => needsRefit.has(x))
  if (!todo.length) return
  const pos = new Map(todo.map((x) => [x, needsRefit.get(x)!] as const))
  for (const x of todo) needsRefit.delete(x)
  await relayout(todo, pos)
})

// a paired tab closed, turned into a book, failed — the pair is over
watch(
  () => store.tabs.map((t) => `${t.id}:${t.bookMode ? 1 : 0}:${t.loadError ? 1 : 0}`).join(','),
  () => {
    const p = pair.value
    if (!p) return
    const ok = (id: number): boolean => {
      const t = store.tabs.find((x) => x.id === id)
      return !!t && !t.bookMode && !t.loadError
    }
    if (!ok(p.a) || !ok(p.b)) void closePair()
  },
)

// too narrow for two documents
watch(splitAvailable, (on) => { if (!on) void closePair() })
