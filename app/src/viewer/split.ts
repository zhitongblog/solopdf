/**
 * Split view — two viewports onto ONE open PDF (desktop / iPad width only).
 *
 * Design:
 *   - The already-loaded PDFDocumentProxy is shared. The second pane is just
 *     another PdfViewerController on a second scroll host; pdf.js caches page
 *     proxies per document, so nothing is re-read, re-downloaded or re-parsed.
 *   - `controllers` (store) ALWAYS maps a tab to its FOCUSED pane's
 *     controller; `splitControllers` holds the other one. Focusing a pane
 *     swaps the two entries. Every existing caller — toolbar, page box,
 *     search, keyboard nav, outline/thumbnail clicks, read-aloud, note/region
 *     tools, position autosave — therefore acts on the focused pane without
 *     knowing split view exists, and with split off the single-pane code path
 *     is literally the one it always was (splitControllers is simply empty).
 *   - Document-level view state (rotation, crop, scroll mode, spread) is
 *     mirrored between the two controllers through `peer` (controller.ts);
 *     scroll position and zoom stay per-pane.
 *   - Each pane virtualizes on its own, so memory is bounded by two live
 *     windows of pages, never the whole document.
 *   - DOM: pane 0 is the original `.pv-scroll[data-tab]` host and outlives
 *     the split; pane 1 (`.pv-scroll[data-split-tab]`) exists only while
 *     split. Closing while pane 1 has focus copies its position + zoom onto
 *     pane 0 first, so the reader stays where they were looking.
 *   - Annotations: both panes render from the same AnnotationManager (App
 *     wires mgr.onChange to both), so a highlight made in one pane shows up
 *     in the other immediately.
 */
import { nextTick, ref, watch } from 'vue'
import {
  store, controllers, splitControllers, documents, annotManagers, effectiveTheme,
  type TabState,
} from '../store'
import { PdfViewerController } from './controller'

/** below this the entry points are hidden and an open split closes */
export const SPLIT_MIN_WIDTH = 700
const DIVIDER = 6

export const splitAvailable = ref(window.innerWidth >= SPLIT_MIN_WIDTH)
window.addEventListener('resize', () => {
  splitAvailable.value = window.innerWidth >= SPLIT_MIN_WIDTH
  if (!splitAvailable.value) for (const t of store.tabs) if (t.split) void closeSplit(t)
})
/** position to apply once a split opened in a hidden (background) tab is
 *  shown — a display:none host has no size to lay pages out against */
const pendingPos = new Map<number, { page: number; ratio: number }>()

// A split tab brought back to the front: re-fit and re-render both panes
// where they were (or where the split opened, if that happened offscreen).
watch(() => store.activeTabId, async () => {
  await nextTick()
  const tab = store.activeTab
  if (!tab?.split) return
  const pos = pendingPos.get(tab.id)
  if (!pos) { await relayoutPanes(tab); return }
  pendingPos.delete(tab.id)
  for (const c of [controllers.get(tab.id), splitControllers.get(tab.id)]) {
    if (!c) continue
    c.onResize()
    c.restorePosition(pos)
    c.update()
  }
})

/** the controller rendering DOM pane 0 or 1 of a tab */
export function paneController(tab: TabState, pane: 0 | 1): PdfViewerController | undefined {
  if (!tab.split) return pane === 0 ? controllers.get(tab.id) : undefined
  return tab.split.focus === pane ? controllers.get(tab.id) : splitControllers.get(tab.id)
}

/** make `pane` the focused one: swap registry entries, sync the page box */
export function focusPane(tab: TabState, pane: 0 | 1): void {
  if (!tab.split || tab.split.focus === pane) return
  const a = controllers.get(tab.id)
  const b = splitControllers.get(tab.id)
  if (!a || !b) return
  controllers.set(tab.id, b)
  splitControllers.set(tab.id, a)
  tab.split.focus = pane
  tab.currentPage = b.currentPage()
  store.docTick++
}

/** focus the pane holding a page under the client point; its controller */
export function focusPaneAt(tab: TabState, x: number, y: number): PdfViewerController | undefined {
  if (!tab.split) return controllers.get(tab.id)
  for (const pane of [0, 1] as const) {
    if (paneController(tab, pane)?.pageAt(x, y)) {
      focusPane(tab, pane)
      return controllers.get(tab.id)
    }
  }
  return undefined
}

/**
 * Open (or re-orient) the split. `wire` installs the host's callbacks
 * (visible page, selection, forms) on the new controller — the same ones the
 * main pane got when the document opened.
 */
export async function openSplit(
  tab: TabState,
  dir: 'row' | 'col',
  wire: (c: PdfViewerController) => void,
): Promise<void> {
  store.settings.splitDir = dir
  if (tab.split) {
    if (tab.split.dir !== dir) {
      tab.split.dir = dir
      await relayoutPanes(tab)
    }
    return
  }
  const main = controllers.get(tab.id)
  const doc = documents.get(tab.id)
  if (!main || !doc || tab.kind !== 'pdf' || tab.bookMode || !splitAvailable.value) return
  const pos = main.getPosition()
  tab.split = { dir, ratio: 0.5, focus: 0 }
  await nextTick()
  const host = document.querySelector<HTMLElement>(`.pv-scroll[data-split-tab="${tab.id}"]`)
  if (!host) { tab.split = null; return }
  // the user may already have switched tabs; lay out when it's shown again
  const visible = (): boolean => host.clientWidth > 0 && store.activeTabId === tab.id
  if (visible()) {
    main.onResize()
    main.restorePosition(pos)
  } else pendingPos.set(tab.id, pos)

  const c = new PdfViewerController(doc, host, effectiveTheme)
  c.darkPdf = main.darkPdf
  c.scrollMode = main.scrollMode
  c.spread = main.spread
  c.coverAlone = main.coverAlone
  c.rotation = main.rotation
  c.setPageRotations(main.pageRotations())
  c.crop = main.crop
  c.fitMode = main.fitMode
  c.scale = main.scale
  wire(c)
  splitControllers.set(tab.id, c)
  await c.init()
  // closed (or the tab went away) while page 1 was loading
  if (!tab.split || !store.tabs.includes(tab) ||
      (splitControllers.get(tab.id) !== c && controllers.get(tab.id) !== c)) {
    c.destroy(true)
    return
  }
  c.peer = main
  main.peer = c
  const mgr = annotManagers.get(tab.id)
  if (mgr) void c.setAnnotations(mgr.annotations)
  // init() fitted before the pane had content (no scrollbar yet): re-fit
  // now so both panes use the same usable width
  if (visible()) {
    c.onResize()
    c.restorePosition(pos)
  } else pendingPos.set(tab.id, pos)
  store.docTick++
}

/** close the split; pane 0 survives, carrying the focused pane's view */
export async function closeSplit(tab: TabState): Promise<void> {
  if (!tab.split) return
  const focused = controllers.get(tab.id)
  const pane0 = paneController(tab, 0)
  const pane1 = paneController(tab, 1)
  const pos = focused?.getPosition()
  const zoom = focused ? (focused.fitMode === 'manual' ? focused.scale : focused.fitMode) : 'width'
  splitControllers.delete(tab.id)
  pendingPos.delete(tab.id)
  pane1?.destroy(true)
  if (pane0) controllers.set(tab.id, pane0)
  tab.split = null
  await nextTick()
  if (pane0 && pos) {
    pane0.setZoom(zoom)
    pane0.restorePosition(pos)
    tab.currentPage = pane0.currentPage()
  }
  store.docTick++
}

/** both panes re-fit to their (new) host sizes, keeping their positions */
export async function relayoutPanes(tab: TabState): Promise<void> {
  const cs = [controllers.get(tab.id), splitControllers.get(tab.id)]
    .filter((c): c is PdfViewerController => !!c)
  const pos = cs.map((c) => c.getPosition())
  await nextTick()
  cs.forEach((c, i) => { c.onResize(); c.restorePosition(pos[i]); c.update() })
}

/** drag the divider between the panes (mouse or finger) */
export function startDividerDrag(tab: TabState, e: PointerEvent): void {
  const split = tab.split
  const divider = e.currentTarget as HTMLElement
  const box = divider.parentElement
  if (!split || !box) return
  e.preventDefault()
  divider.setPointerCapture?.(e.pointerId)
  const cs = [controllers.get(tab.id), splitControllers.get(tab.id)]
    .filter((c): c is PdfViewerController => !!c)
  const pos = cs.map((c) => c.getPosition())
  let raf = 0
  const move = (ev: PointerEvent): void => {
    const r = box.getBoundingClientRect()
    const along = split.dir === 'row' ? ev.clientX - r.left : ev.clientY - r.top
    const total = (split.dir === 'row' ? r.width : r.height) - DIVIDER
    split.ratio = Math.min(0.8, Math.max(0.2, along / Math.max(1, total)))
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      cs.forEach((c, i) => { c.onResize(); c.restorePosition(pos[i]) })
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
