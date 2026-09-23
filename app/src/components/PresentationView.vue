<script setup lang="ts">
/**
 * Presentation mode: one page at a time, fitted to the screen on black.
 *
 * Deliberately independent of the reading view underneath: pages are
 * rendered here with renderFitted() (rotation + crop honoured), so the
 * scroll position of the document never moves and exiting drops the reader
 * back exactly where they were. Neighbours are pre-rendered so a flip is
 * instant. Page colours are shown as authored — no dark-mode inversion (the
 * black surround already does that job); the paper tint still applies.
 *
 * Input: → ↓ Space PageDown Enter n j = next; ← ↑ PageUp Backspace p k =
 * previous; Home/End; Esc exits. Click/tap: left 30% goes back, the rest
 * forward; horizontal swipe; mouse wheel.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { store, controllers, labelOf } from '../store'
import { t } from '../i18n'

const props = defineProps<{ tabId: number; startPage: number }>()
const emit = defineEmits<{ exit: [] }>()

const tab = computed(() => store.tabs.find((x) => x.id === props.tabId))
const numPages = computed(() => tab.value?.numPages ?? 1)
const page = ref(Math.min(Math.max(props.startPage, 1), numPages.value))
const stage = ref<HTMLDivElement>()
const slot = ref<HTMLDivElement>()
/** counter + exit button, shown briefly after every flip or pointer move */
const chrome = ref(true)
/** pointer idle → cursor hidden */
const idle = ref(false)
const failed = ref(false)

let chromeTimer = 0
let idleTimer = 0
function poke(): void {
  chrome.value = true
  idle.value = false
  clearTimeout(chromeTimer)
  clearTimeout(idleTimer)
  chromeTimer = window.setTimeout(() => { chrome.value = false }, 1800)
  idleTimer = window.setTimeout(() => { idle.value = true }, 2000)
}

// ── rendering (current page + neighbours cached for instant flips) ──
interface Rendered { canvas: HTMLCanvasElement; w: number; h: number }
const cache = new Map<number, Promise<Rendered>>()
let cacheKey = ''

function viewport(): { w: number; h: number } {
  const el = stage.value
  if (!el) return { w: window.innerWidth, h: window.innerHeight }
  // the stage pads itself clear of notches / home indicator (safe areas)
  const cs = getComputedStyle(el)
  const px = (v: string): number => parseFloat(v) || 0
  return {
    w: Math.max(50, el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight)),
    h: Math.max(50, el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom)),
  }
}

function renderPage(p: number): Promise<Rendered> {
  const ctrl = controllers.get(props.tabId)
  if (!ctrl) return Promise.reject(new Error('no document'))
  const { w, h } = viewport()
  const key = `${w}x${h}`
  if (key !== cacheKey) { cache.clear(); cacheKey = key }
  let hit = cache.get(p)
  if (!hit) {
    hit = ctrl.renderFitted(p, w, h)
    hit.catch(() => cache.delete(p))
    cache.set(p, hit)
  }
  return hit
}

async function show(): Promise<void> {
  const p = page.value
  failed.value = false
  try {
    const r = await renderPage(p)
    if (p !== page.value || !slot.value) return // flipped on while rendering
    slot.value.replaceChildren(r.canvas)
    slot.value.style.width = `${r.w}px`
    slot.value.style.height = `${r.h}px`
  } catch {
    if (p === page.value) failed.value = true
  }
  // warm the neighbours, forget the rest (a 1000-page deck must not pile up)
  for (const k of cache.keys()) if (Math.abs(k - p) > 2) cache.delete(k)
  if (p < numPages.value) void renderPage(p + 1).catch(() => {})
  if (p > 1) void renderPage(p - 1).catch(() => {})
}

function go(p: number): void {
  const n = Math.min(Math.max(p, 1), numPages.value)
  poke()
  if (n === page.value) return
  page.value = n
  void show()
}
const next = (): void => go(page.value + 1)
const prev = (): void => go(page.value - 1)

// ── input ──
function onKey(e: KeyboardEvent): void {
  // own every key while presenting: the reader's shortcuts underneath
  // (rotate, search, zoom) must not fire on a hidden view
  e.stopImmediatePropagation()
  if (e.metaKey || e.ctrlKey || e.altKey) {
    // Cmd/Ctrl+Shift+P toggles presentation off again
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); emit('exit') }
    return
  }
  const k = e.key
  if (k === 'Escape' || k === 'F5') { e.preventDefault(); emit('exit') }
  else if (['ArrowRight', 'ArrowDown', 'PageDown', 'Enter', 'n', 'j'].includes(k) || (k === ' ' && !e.shiftKey)) { e.preventDefault(); next() }
  else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'k'].includes(k) || (k === ' ' && e.shiftKey)) { e.preventDefault(); prev() }
  else if (k === 'Home') { e.preventDefault(); go(1) }
  else if (k === 'End') { e.preventDefault(); go(numPages.value) }
}

let down: { x: number; y: number; type: string } | null = null
function onPointerDown(e: PointerEvent): void {
  down = { x: e.clientX, y: e.clientY, type: e.pointerType }
}
function onPointerUp(e: PointerEvent): void {
  if (!down || e.button > 0) { down = null; return }
  const dx = e.clientX - down.x
  const dy = e.clientY - down.y
  down = null
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    // swipe: finger moves left → next page, like turning paper
    if (dx < 0) next()
    else prev()
    return
  }
  if (Math.abs(dx) > 12 || Math.abs(dy) > 12) return // a drag, not a tap
  const w = stage.value?.clientWidth || window.innerWidth
  if (e.clientX < w * 0.3) prev()
  else next()
}
function onContextMenu(e: MouseEvent): void {
  e.preventDefault()
  prev()
}
let wheelAt = 0
function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const now = performance.now()
  if (now - wheelAt < 350 || Math.abs(e.deltaY) < 4) return
  wheelAt = now
  if (e.deltaY > 0) next()
  else prev()
}

let resizeTimer = 0
function onResize(): void {
  clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => { cache.clear(); void show() }, 150)
}

const counter = computed(() => {
  const label = labelOf(tab.value, page.value)
  const phys = `${page.value} / ${numPages.value}`
  return label === String(page.value) ? phys : `${label}  (${phys})`
})

onMounted(() => {
  // capture phase + stopImmediatePropagation: App's reader shortcuts listen
  // on window in the bubble phase and never see a key while we're up
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onResize)
  poke()
  void show()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', onResize)
  clearTimeout(chromeTimer)
  clearTimeout(idleTimer)
  clearTimeout(resizeTimer)
  cache.clear()
})

defineExpose({ page, go })
</script>

<template>
  <div
    ref="stage"
    class="pres"
    :class="{ 'pres-idle': idle }"
    :data-page="page"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointermove="(e) => e.pointerType === 'mouse' && poke()"
    @contextmenu="onContextMenu"
    @wheel="onWheel"
  >
    <div ref="slot" class="pres-page"></div>
    <div v-if="failed" class="pres-fail">{{ t('pr.renderFail') }}</div>
    <div class="pres-counter" :class="{ on: chrome }">{{ counter }}</div>
    <button
      class="pres-exit"
      :class="{ on: chrome }"
      :title="t('pr.exit')"
      @pointerdown.stop
      @pointerup.stop
      @click.stop="emit('exit')"
    >✕</button>
  </div>
</template>
