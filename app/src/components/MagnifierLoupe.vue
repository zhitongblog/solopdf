<script setup lang="ts">
/**
 * Magnifier loupe (Skim / Preview): hold Z over a PDF page and a circle
 * shows the area under the pointer at 2–4×. Scroll the wheel while holding
 * Z to change the power. Desktop only — a phone has pinch-zoom and no hover.
 *
 * Sharp, not CSS-scaled: the page region around the pointer is RENDERED by
 * pdf.js at (view scale × power × devicePixelRatio) into a tile 2.5 loupes
 * wide; moving inside the tile is a cheap drawImage, leaving it renders the
 * next tile (latest request wins, the old tile stays up meanwhile).
 */
import { onBeforeUnmount, onMounted, ref, watch, computed } from 'vue'
import { store, controllers, splitControllers } from '../store'
import type { PdfViewerController } from '../viewer/controller'

const props = defineProps<{ tabId: number; enabled: boolean }>()

const D = 240 // loupe diameter, CSS px
const TILE = 2.5 // tile edge in loupe diameters

const holding = ref(false)
const pos = ref<{ x: number; y: number } | null>(null)
const shown = ref(false)
const canvas = ref<HTMLCanvasElement>()
const inverted = ref(false)
const zoom = computed(() => store.settings.aids.loupeZoom)

interface Tile {
  ctrl: PdfViewerController
  page: number
  scale: number
  zoom: number
  /** covered region in view px (page at ctrl.scale, rotated, uncropped) */
  x: number
  y: number
  w: number
  h: number
  /** tile px per view px */
  k: number
  canvas: HTMLCanvasElement
}
let tile: Tile | null = null
let rendering = false
let pending = false
/** the last thing drawn — exposed for E2E */
const last = ref<{ page: number; k: number; tileW: number; tileH: number } | null>(null)

function paneCtrlAt(x: number, y: number): PdfViewerController | undefined {
  for (const c of [controllers.get(props.tabId), splitControllers.get(props.tabId)]) {
    if (!c) continue
    const r = c.host.getBoundingClientRect()
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return c
  }
  return undefined
}

/** pointer → (controller, page, point in the page's view space) */
function locate(x: number, y: number): { ctrl: PdfViewerController; page: number; vx: number; vy: number; inv: boolean } | null {
  const ctrl = paneCtrlAt(x, y)
  if (!ctrl) return null
  const page = ctrl.pageAt(x, y)
  if (!page) return null
  const el = ctrl.pageElement(page)
  const inner = el?.querySelector<HTMLElement>('.pv-page-inner')
  if (!inner) return null
  const r = inner.getBoundingClientRect()
  return {
    ctrl, page, vx: x - r.left, vy: y - r.top,
    inv: !!inner.querySelector('canvas.pv-inverted'),
  }
}

async function renderTile(ctrl: PdfViewerController, page: number, vx: number, vy: number): Promise<void> {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const z = zoom.value
  const k = z * dpr
  const span = (D * TILE) / z // view px covered
  const { box, rotation, scale } = ctrl.pageGeometry(page)
  const rot = rotation % 180 !== 0
  const pageW = (rot ? box.h : box.w) * scale
  const pageH = (rot ? box.w : box.h) * scale
  const x = Math.max(0, Math.min(vx - span / 2, pageW - span))
  const y = Math.max(0, Math.min(vy - span / 2, pageH - span))
  const w = Math.min(span, pageW)
  const h = Math.min(span, pageH)
  const c = await ctrl.renderToCanvas(page, scale * k, { x: x * k, y: y * k, w: w * k, h: h * k })
  tile = { ctrl, page, scale, zoom: z, x, y, w, h, k, canvas: c }
  last.value = { page, k, tileW: c.width, tileH: c.height }
}

function tileCovers(t: Tile, ctrl: PdfViewerController, page: number, vx: number, vy: number): boolean {
  const half = D / 2 / zoom.value
  return t.ctrl === ctrl && t.page === page && t.scale === ctrl.scale && t.zoom === zoom.value &&
    vx - half >= t.x - 1 && vx + half <= t.x + t.w + 1 && vy - half >= t.y - 1 && vy + half <= t.y + t.h + 1
}

function draw(vx: number, vy: number): void {
  const cv = canvas.value
  const t = tile
  if (!cv || !t) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const px = Math.round(D * dpr)
  if (cv.width !== px) { cv.width = px; cv.height = px }
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#888'
  ctx.fillRect(0, 0, px, px)
  // source: the loupe's footprint in tile pixels, centred on the pointer
  const sx = (vx - t.x) * t.k - px / 2
  const sy = (vy - t.y) * t.k - px / 2
  ctx.drawImage(t.canvas, sx, sy, px, px, 0, 0, px, px)
}

async function update(): Promise<void> {
  const p = pos.value
  if (!holding.value || !props.enabled || !p) { shown.value = false; return }
  const at = locate(p.x, p.y)
  if (!at) { shown.value = false; return }
  shown.value = true
  inverted.value = at.inv
  if (tile && tileCovers(tile, at.ctrl, at.page, at.vx, at.vy)) { draw(at.vx, at.vy); return }
  if (tile && tile.ctrl === at.ctrl && tile.page === at.page) draw(at.vx, at.vy) // stale but close
  if (rendering) { pending = true; return }
  rendering = true
  try {
    await renderTile(at.ctrl, at.page, at.vx, at.vy)
  } catch { /* page torn down mid-render */ } finally {
    rendering = false
  }
  if (pending) { pending = false; void update(); return }
  const now = pos.value && locate(pos.value.x, pos.value.y)
  if (now && holding.value) draw(now.vx, now.vy)
}

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'z' && e.key !== 'Z') return
  if (!props.enabled || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return
  e.preventDefault()
  if (e.repeat || holding.value) return
  holding.value = true
  void update()
}
function onKeyUp(e: KeyboardEvent): void {
  if (e.key === 'z' || e.key === 'Z') release()
}
function release(): void {
  holding.value = false
  shown.value = false
}
function onMove(e: PointerEvent): void {
  if (e.pointerType !== 'mouse') return
  pos.value = { x: e.clientX, y: e.clientY }
  if (holding.value) void update()
}
function onWheel(e: WheelEvent): void {
  if (!holding.value || !shown.value) return
  e.preventDefault()
  const z = Math.min(4, Math.max(2, store.settings.aids.loupeZoom + (e.deltaY < 0 ? 0.5 : -0.5)))
  if (z !== store.settings.aids.loupeZoom) store.settings.aids.loupeZoom = z
}

watch(zoom, () => { tile = null; void update() })
watch(() => [props.tabId, props.enabled], () => { tile = null; release() })

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', release)
  document.addEventListener('pointermove', onMove, { passive: true })
  window.addEventListener('wheel', onWheel, { passive: false })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', release)
  document.removeEventListener('pointermove', onMove)
  window.removeEventListener('wheel', onWheel)
})

defineExpose({
  /** E2E: hold the loupe at a client point (a key hold is hard to script) */
  async show(x: number, y: number): Promise<boolean> {
    pos.value = { x, y }
    holding.value = true
    await update()
    // the first render may still be finishing a superseded request
    for (let i = 0; i < 40 && (rendering || pending); i++) await new Promise((r) => setTimeout(r, 50))
    return shown.value
  },
  hide: release,
  info: () => ({ shown: shown.value, zoom: zoom.value, ...last.value, canvas: canvas.value?.width ?? 0 }),
})
</script>

<template>
  <!-- v-show, not v-if: the canvas must exist before the first draw -->
  <div
    v-show="shown && pos"
    class="loupe"
    :style="{ left: `${(pos?.x ?? 0) - D / 2}px`, top: `${(pos?.y ?? 0) - D / 2}px`, width: `${D}px`, height: `${D}px` }"
  >
    <canvas ref="canvas" :class="{ 'pv-inverted': inverted }" :style="{ width: `${D}px`, height: `${D}px` }"></canvas>
    <span class="loupe-zoom">{{ zoom }}×</span>
  </div>
</template>
