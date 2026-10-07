<script setup lang="ts">
/**
 * Reading ruler / line focus (Edge "line focus", Sioyek ruler): a band over
 * the current line(s), everything else dimmed. An accessibility aid —
 * dyslexia, attention, just tired eyes on a dense two-column paper.
 *
 *   mouse ........ the band follows the pointer, snapping to text lines
 *   ↑ ↓ / k j .... previous / next line, in reading order (column-aware);
 *                  past the last line it scrolls / turns the page
 *   touch ........ drag the grip on the band's right edge
 *
 * The band is anchored to the TEXT, not the screen: it is stored in the
 * scroll host's content coordinates, so scrolling carries it along with
 * the line it marks. The overlay never takes pointer events (selection,
 * links and highlights work through it), except the grip.
 *
 * Works in the PDF view (either split pane — whichever the pointer or the
 * focus is in) and the reflowed book view. Line geometry: viewer/ruler.ts.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { lineAt, bandAround, type LineBox } from '@solopdf/core'
import { store, controllers, splitControllers, bookApis } from '../store'
import { collectLines, hostKind, hostsFor, viewportOf } from '../viewer/ruler'
import { t } from '../i18n'

const props = defineProps<{ tabId: number; book: boolean; disabled?: boolean }>()

const aids = computed(() => store.settings.aids)
const active = computed(() => aids.value.ruler && !props.disabled && props.tabId > 0)

const host = shallowRef<HTMLElement | null>(null)
/** current line + band, in the host's CONTENT coordinates */
let cur: LineBox | null = null
let band: LineBox | null = null
/** what the template draws, client coordinates */
const view = ref<{ vp: LineBox; band: LineBox } | null>(null)

/** a measured line list is reused for a moment (mouse moves come fast) */
let cache: { host: HTMLElement; st: number; sl: number; at: number; lines: LineBox[] } | null = null
function lines(h: HTMLElement, fresh = false): LineBox[] {
  const now = performance.now()
  if (!fresh && cache && cache.host === h && cache.st === h.scrollTop && cache.sl === h.scrollLeft && now - cache.at < 250) {
    return cache.lines
  }
  const ls = collectLines(h)
  cache = { host: h, st: h.scrollTop, sl: h.scrollLeft, at: now, lines: ls }
  return ls
}

function toContent(h: HTMLElement, b: LineBox): LineBox {
  const vp = viewportOf(h)
  const dx = h.scrollLeft - vp.left
  const dy = h.scrollTop - vp.top
  return { left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy }
}
function toClient(h: HTMLElement, b: LineBox): LineBox {
  const vp = viewportOf(h)
  const dx = vp.left - h.scrollLeft
  const dy = vp.top - h.scrollTop
  return { left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy }
}

function paint(): void {
  const h = host.value
  if (!active.value || !h || !band || !h.isConnected) { view.value = null; return }
  view.value = { vp: viewportOf(h), band: toClient(h, band) }
}

function validHosts(): HTMLElement[] {
  return props.tabId > 0 ? hostsFor(props.tabId, props.book) : []
}
/** the host keys act on: the focused pane (a click in a pane focuses it) */
function keyHost(): HTMLElement | null {
  return validHosts()[0] ?? null
}

function setLine(h: HTMLElement, ls: LineBox[], i: number): void {
  host.value = h
  cur = toContent(h, ls[i])
  band = toContent(h, bandAround(ls, i, aids.value.rulerLines)!)
  paint()
}

/** no text layer (a scan): a plain band of N text-ish lines at y */
const FALLBACK_LINE = 26
function setBandAtY(h: HTMLElement, y: number): void {
  const vp = viewportOf(h)
  const half = (FALLBACK_LINE * aids.value.rulerLines) / 2
  const c = Math.min(Math.max(y, vp.top + half), vp.bottom - half)
  host.value = h
  cur = null
  band = toContent(h, { left: vp.left, right: vp.right, top: c - half, bottom: c + half })
  paint()
}

/** snap to the line nearest a client point */
function snapAt(h: HTMLElement, x: number, y: number, fresh = false): void {
  const ls = lines(h, fresh)
  if (!ls.length) { setBandAtY(h, y); return }
  const vp = viewportOf(h)
  // only lines on screen are candidates for a pointer
  const vis = ls.map((l, k) => [l, k] as const).filter(([l]) => l.bottom > vp.top && l.top < vp.bottom)
  if (!vis.length) { setBandAtY(h, y); return }
  const k = lineAt(vis.map(([l]) => l), x, y)
  setLine(h, ls, vis[k][1])
}

function visible(l: LineBox, vp: LineBox, margin = 2): boolean {
  return l.top >= vp.top - margin && l.bottom <= vp.bottom + margin
}

function currentIndex(h: HTMLElement, ls: LineBox[]): number {
  if (!cur) return -1
  const c = toClient(h, cur)
  const i = lineAt(ls, (c.left + c.right) / 2, (c.top + c.bottom) / 2)
  if (i < 0) return -1
  const l = ls[i]
  // the remembered line must still be (about) there — otherwise the layout
  // changed under us (zoom, page turn) and we start over
  return Math.abs(l.top - c.top) < (c.bottom - c.top) && l.right > c.left && l.left < c.right ? i : -1
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** poll until rendering has produced lines that satisfy `ok` */
async function waitLines(h: HTMLElement, ok: (ls: LineBox[]) => number, timeout = 2000): Promise<{ ls: LineBox[]; i: number } | null> {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    await sleep(60)
    const ls = lines(h, true)
    const i = ok(ls)
    if (i >= 0) return { ls, i }
  }
  return null
}

function controllerOf(h: HTMLElement) {
  const a = controllers.get(props.tabId)
  if (a?.host === h) return a
  const b = splitControllers.get(props.tabId)
  return b?.host === h ? b : undefined
}

/** paged layouts: turn to the next/previous screen; false at either end */
async function turnPage(h: HTMLElement, dir: 1 | -1): Promise<boolean> {
  const ctrl = hostKind(h) === 'pdf' ? controllerOf(h) : undefined
  if (ctrl) {
    if (ctrl.scrollMode !== 'paged') return false
    const page = ctrl.currentPage()
    ctrl.turnPage(dir)
    if (ctrl.currentPage() === page) return false
    if (dir < 0) h.scrollTop = h.scrollHeight // previous page: start at its end
    return true
  }
  if (!h.querySelector('.bk-paged-content')) return false
  const api = bookApis.get(props.tabId)
  return !!api && (await (dir > 0 ? api.advance() : api.retreat()))
}

/** scroll line k into view and mark it: going down it lands a third of the
 *  way down, going up two thirds — context stays on the side of travel */
function bringIn(h: HTMLElement, ls: LineBox[], k: number, dir: 1 | -1): void {
  const vp = viewportOf(h)
  const H = vp.bottom - vp.top
  const l = ls[k]
  const before = h.scrollTop
  h.scrollTop += dir > 0 ? l.top - vp.top - H * 0.3 : l.bottom - vp.top - H * 0.7
  const dy = h.scrollTop - before
  cache = null
  setLine(h, dy ? ls.map((b) => ({ ...b, top: b.top - dy, bottom: b.bottom - dy })) : ls, k)
}

let moving = false
/** next / previous line in reading order; past the end it scrolls or turns */
async function move(dir: 1 | -1): Promise<void> {
  if (moving) return
  const h = keyHost()
  if (!h) return
  moving = true
  try {
    await moveIn(h, dir)
  } finally {
    moving = false
  }
}

async function moveIn(h: HTMLElement, dir: 1 | -1): Promise<void> {
  // the band was in the other split pane: its line means nothing here
  if (host.value !== h) { cur = null; band = null }
  const vp = viewportOf(h)
  const H = vp.bottom - vp.top
  const ls = lines(h, true)
  if (!ls.length) {
    // no text (a scan, an illustration page): step a band's height,
    // scrolling — or turning the page — when it would leave the view
    const c = band ? toClient(h, band) : null
    const step = FALLBACK_LINE * aids.value.rulerLines
    let y = c ? (c.top + c.bottom) / 2 + dir * step : vp.top + H * 0.3
    if (y > vp.bottom - step / 2 || y < vp.top + step / 2) {
      const before = h.scrollTop
      h.scrollTop += dir * H * 0.6
      y -= h.scrollTop - before
      if (h.scrollTop === before && await turnPage(h, dir)) {
        const got = await waitLines(h, (xs) => (xs.length ? (dir > 0 ? 0 : xs.length - 1) : -1), 900)
        if (got) { setLine(h, got.ls, got.i); return }
        y = dir > 0 ? vp.top : vp.bottom
      }
    }
    setBandAtY(h, y)
    return
  }
  let i = currentIndex(h, ls)
  if (i < 0 || !visible(ls[i], vp, ls[i].bottom - ls[i].top)) {
    // nothing marked yet, or it scrolled away: start from what is on screen
    const vis = ls.map((l, k) => [l, k] as const).filter(([l]) => visible(l, vp))
    if (vis.length) { setLine(h, ls, (dir > 0 ? vis[0] : vis[vis.length - 1])[1]); return }
    // a screen with no text on it (a full-page illustration): go to the
    // nearest line in the direction of travel, or scroll on to find one
    let k = -1
    if (dir > 0) k = ls.findIndex((l) => l.top >= vp.bottom - 2)
    else for (let q = ls.length - 1; q >= 0; q--) if (ls[q].bottom <= vp.top + 2) { k = q; break }
    if (k >= 0) { bringIn(h, ls, k, dir); return }
    const before = h.scrollTop
    h.scrollTop += dir * H * 0.6
    if (h.scrollTop === before && !(await turnPage(h, dir))) return
    setBandAtY(h, dir > 0 ? vp.top : vp.bottom)
    return
  }
  const j = i + dir
  const kind = hostKind(h)
  const ctrl = kind === 'pdf' ? controllerOf(h) : undefined
  const bookPaged = kind === 'book' && !!h.querySelector('.bk-paged-content')
  if (j >= 0 && j < ls.length && !(bookPaged && !visible(ls[j], vp))) {
    const l = ls[j]
    if (visible(l, vp)) { setLine(h, ls, j); return }
    bringIn(h, ls, j, dir)
    return
  }
  // ran out of measured lines: the page / screen ends here
  const prev = cur!
  if (ctrl?.scrollMode === 'paged' || bookPaged) {
    if (!(await turnPage(h, dir))) return // first / last page
    const got = await waitLines(h, (xs) => {
      const v = viewportOf(h)
      const vis = xs.map((l, k) => [l, k] as const).filter(([l]) => visible(l, v))
      return vis.length ? (dir > 0 ? vis[0] : vis[vis.length - 1])[1] : -1
    })
    if (got) setLine(h, got.ls, got.i)
    return
  }
  // continuous: scroll on and pick the first line beyond the one we were on
  const before = h.scrollTop
  h.scrollTop += dir * H * 0.6
  if (h.scrollTop === before) return // end of the document
  const got = await waitLines(h, (xs) => {
    const cs = xs.map((l) => toContent(h, l))
    if (dir > 0) return cs.findIndex((c) => c.top >= prev.bottom - 1)
    for (let k = cs.length - 1; k >= 0; k--) if (cs[k].bottom <= prev.top + 1) return k
    return -1
  })
  if (!got) return
  const l = got.ls[got.i]
  const v = viewportOf(h)
  if (!visible(l, v)) {
    const b2 = h.scrollTop
    h.scrollTop += dir > 0 ? l.top - v.top - (v.bottom - v.top) * 0.3 : l.bottom - v.top - (v.bottom - v.top) * 0.7
    const dy = h.scrollTop - b2
    cache = null
    setLine(h, got.ls.map((b) => ({ ...b, top: b.top - dy, bottom: b.bottom - dy })), got.i)
  } else setLine(h, got.ls, got.i)
}

// ── input ────────────────────────────────────────────────────────────────

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

/** window capture, registered before the book/comic views': the ruler's
 *  keys win over their page-turn bindings while it is on */
function onKey(e: KeyboardEvent): void {
  if (!active.value || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return
  const dir = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0
  if (!dir || !keyHost()) return
  e.preventDefault()
  e.stopImmediatePropagation()
  void move(dir as 1 | -1)
}

let followTimer = 0
function onPointerMove(e: PointerEvent): void {
  if (!active.value || !aids.value.rulerFollow || e.pointerType !== 'mouse' || e.buttons || dragging) return
  const h = (e.target as Element | null)?.closest?.('.pv-scroll, .bk-scroll') as HTMLElement | null
  if (!h || !validHosts().includes(h)) return
  const { clientX: x, clientY: y } = e
  if (followTimer) return
  // a short timer rather than rAF: rAF stalls in a throttled webview
  followTimer = window.setTimeout(() => {
    followTimer = 0
    if (active.value) snapAt(h, x, y)
  }, 40)
}

let dragging = false
function startDrag(e: PointerEvent): void {
  const h = host.value
  if (!h) return
  e.preventDefault()
  e.stopPropagation()
  dragging = true
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent): void => {
    const b = view.value?.band
    snapAt(h, b ? (b.left + b.right) / 2 : ev.clientX, ev.clientY)
  }
  const end = (): void => {
    dragging = false
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', end)
    el.removeEventListener('pointercancel', end)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
}

/** re-measure after the layout moved under the band (zoom, resize, turn) */
let resnapTimer = 0
function resnapSoon(delay = 200): void {
  clearTimeout(resnapTimer)
  resnapTimer = window.setTimeout(resnap, delay)
}
function resnap(): void {
  if (!active.value) return
  const h = keyHost()
  if (!h) { view.value = null; return }
  const vp = viewportOf(h)
  const c = band && host.value === h ? toClient(h, cur ?? band) : null
  if (c && c.bottom > vp.top && c.top < vp.bottom) snapAt(h, (c.left + c.right) / 2, (c.top + c.bottom) / 2, true)
  else snapAt(h, (vp.left + vp.right) / 2, vp.top + (vp.bottom - vp.top) * 0.35, true)
}

function onScroll(e: Event): void {
  if (!active.value || e.target !== host.value) return
  paint()
  resnapSoon(220)
}

onMounted(() => {
  window.addEventListener('keydown', onKey, { capture: true })
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  window.addEventListener('resize', () => resnapSoon(300))
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, { capture: true })
  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('scroll', onScroll, { capture: true })
  clearTimeout(resnapTimer)
  clearTimeout(followTimer)
})

// switching on, switching tab / view: start fresh where the reader is
watch(() => [active.value, props.tabId, props.book] as const, () => {
  cur = null
  band = null
  host.value = null
  cache = null
  view.value = null
  if (active.value) resnapSoon(props.book ? 400 : 120)
})
watch(() => aids.value.rulerLines, () => resnapSoon(0))
// page turns that didn't come from the ruler (click, swipe, toolbar)
watch(() => store.tabs.find((x) => x.id === props.tabId)?.currentPage, () => { if (active.value) resnapSoon(260) })
watch(() => store.docTick, () => { if (active.value) resnapSoon(260) })

const style = computed(() => {
  const v = view.value
  if (!v) return null
  const padX = 6
  const padY = 3
  return {
    layer: { left: `${v.vp.left}px`, top: `${v.vp.top}px`, width: `${v.vp.right - v.vp.left}px`, height: `${v.vp.bottom - v.vp.top}px` },
    band: {
      left: `${v.band.left - v.vp.left - padX}px`,
      top: `${v.band.top - v.vp.top - padY}px`,
      width: `${v.band.right - v.band.left + padX * 2}px`,
      height: `${v.band.bottom - v.band.top + padY * 2}px`,
      '--ruler-dim': String(aids.value.rulerDim),
    },
  }
})

defineExpose({
  move,
  /** E2E: snap to the line at a client point in the focused/main host */
  snapAt: (x: number, y: number) => { const h = keyHost(); if (h) snapAt(h, x, y, true) },
  info: () => ({
    on: active.value,
    band: view.value?.band ?? null,
    host: host.value ? (host.value.dataset.tab ? 'main' : host.value.dataset.splitTab ? 'split' : 'book') : null,
    lines: host.value ? collectLines(host.value).length : 0,
  }),
})
</script>

<template>
  <div v-if="style" class="ruler-layer" :style="style.layer" aria-hidden="true">
    <div class="ruler-band" :style="style.band">
      <div class="ruler-grip" :title="t('ra.grip')" @pointerdown="startDrag"></div>
    </div>
  </div>
</template>
