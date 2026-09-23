<script setup lang="ts">
/**
 * Armed drawing tools for the PDF view: pen, eraser, text box, rectangle,
 * ellipse, line, arrow. Sibling of AnnotToolLayer (note pin / region grab),
 * same contract: exists only while a tool is armed, never intercepts normal
 * reading.
 *
 * Input routing — the palm-rejection rule:
 *
 *   no stylus seen yet ──▶ full-screen overlay takes every pointer
 *                          (mouse and finger both draw)
 *   stylus seen once   ──▶ overlay goes transparent; pen + mouse are caught
 *                          on the page host, fingers fall through and scroll
 *
 * Every stroke/shape is converted to PDF user space on the fly, so what gets
 * stored is independent of zoom, rotation and crop. All writes go through
 * AnnotationManager (addDrawn / update / remove) — never the sidecar directly.
 *
 * Ink grouping: consecutive strokes on one page, in one colour and width,
 * extend a single ink mark — one doodle is one entry in the notes list, not
 * forty.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  drawBounds, finishStroke, normRect, pressureFactor, type Annotation, type AnchorData, type DrawData,
} from '@solopdf/core'
import { store, controllers, annotManagers } from '../store'
import { t } from '../i18n'
import {
  DRAW_TOOLS, TOOL_GLYPH, PEN_COLORS, PEN_WIDTHS, FONT_SIZES, penState, paintDrawn, cssColor,
  renderDrawnPng, eraserHit, appendStroke, dropStrokes, type DrawTool,
} from '../annotations/drawing'
import TextBoxEditor from './TextBoxEditor.vue'

const props = defineProps<{ tabId: number; tool: DrawTool }>()
const emit = defineEmits<{ switch: [tool: DrawTool]; cancel: []; toast: [msg: string] }>()

const ctrl = computed(() => { void store.docTick; return controllers.get(props.tabId) })
const mgr = computed(() => { void store.docTick; return annotManagers.get(props.tabId) })
const st = store.settings.draw

const penOnly = ref(penState.seen)
const live = ref<HTMLCanvasElement>()
const editor = ref<{
  page: number
  left: number; top: number; width: number; minHeight: number
} | null>(null)

/** one pointer gesture in progress */
interface Gesture {
  id: number
  page: number
  type: string
  /** PDF-space samples */
  pts: number[]
  pressure: number[]
  sx: number; sy: number
  cx: number; cy: number
}
let g: Gesture | null = null
/** strokes saved but not yet repainted by the page layer */
const pending: { page: number; a: Annotation }[] = []
/** eraser: annotation id → stroke indices (or 'all') brushed so far */
let erased = new Map<string, Set<number> | 'all'>()
/** ink mark the next stroke extends */
let inkId: string | null = null
/** writes are strictly sequential: stroke N+1 extends what stroke N wrote */
let queue: Promise<void> = Promise.resolve()

function host(): HTMLElement | null {
  return document.querySelector(`.pv-scroll[data-tab="${props.tabId}"]`)
}

function fail(err: unknown): void {
  emit('toast', t('dr.saveFail', { msg: String((err as Error)?.message ?? err) }))
}

// ── input ────────────────────────────────────────────────────────────────

/** fingers don't draw once a stylus has shown up */
function accepts(e: PointerEvent): boolean {
  if (e.pointerType === 'pen' && !penState.seen) {
    penState.seen = true
    penOnly.value = true
    emit('toast', t('dr.penOnly'))
  }
  return !(penState.seen && e.pointerType === 'touch')
}

function onDown(e: PointerEvent): void {
  if (g || editor.value || !accepts(e)) return
  if (e.button > 0) return
  const c = ctrl.value
  if (!c) return
  const page = c.pageAt(e.clientX, e.clientY)
  if (!page) return
  const p = c.clientToPdf(page, e.clientX, e.clientY)
  if (!p) return
  e.preventDefault()
  e.stopPropagation()
  g = {
    id: e.pointerId, page, type: e.pointerType, pts: [p.x, p.y],
    pressure: [e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5],
    sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY,
  }
  try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* synthetic */ }
  if (props.tool === 'eraser') erase(page, p.x, p.y)
  paintLive()
}

function onMove(e: PointerEvent): void {
  if (!g || e.pointerId !== g.id) return
  const c = ctrl.value
  if (!c) return
  e.preventDefault()
  // coalesced samples: a 240Hz Pencil delivers several per frame
  const samples = (e.getCoalescedEvents?.() ?? []).length ? e.getCoalescedEvents() : [e]
  for (const s of samples) {
    const p = c.clientToPdf(g.page, s.clientX, s.clientY)
    if (!p) continue
    if (props.tool === 'pen' || props.tool === 'eraser') {
      g.pts.push(p.x, p.y)
      g.pressure.push(g.type === 'pen' && s.pressure > 0 ? s.pressure : 0.5)
      if (props.tool === 'eraser') erase(g.page, p.x, p.y)
    } else {
      g.pts = [g.pts[0], g.pts[1], p.x, p.y]
    }
  }
  g.cx = e.clientX
  g.cy = e.clientY
  paintLive()
}

function onUp(e: PointerEvent): void {
  if (!g || e.pointerId !== g.id) return
  const done = g
  g = null
  const dist = Math.hypot(done.cx - done.sx, done.cy - done.sy)
  switch (props.tool) {
    case 'pen': commitStroke(done); break
    case 'eraser': commitErase(); break
    case 'text': openEditor(done, dist); break
    default:
      if (dist >= 6) commitShape(done)
  }
  paintLive()
}

function onCancel(e: PointerEvent): void {
  if (!g || e.pointerId !== g.id) return
  g = null
  if (props.tool === 'eraser') restoreErased()
  paintLive()
}

/** a stylus touch must not scroll or start a text selection; a finger may */
function onTouch(e: TouchEvent): void {
  const stylus = [...e.touches].some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus')
  if (stylus || (g && g.type === 'pen')) e.preventDefault()
}

// ── live preview ─────────────────────────────────────────────────────────

function draftAnnotation(gs: Gesture): Annotation | null {
  const d = previewDraw(gs)
  if (!d) return null
  return {
    id: '_draft', anchor: { page: gs.page, quads: [d.quad], pre: '', post: '', draw: d.draw },
    excerpt: '', note: '', color: st.color, kind: d.kind, createdAt: '',
  }
}

function previewDraw(gs: Gesture): { kind: Annotation['kind']; draw: DrawData; quad: AnchorData['quads'][0] } | null {
  const w = st.width
  if (props.tool === 'pen') {
    const f = gs.type === 'pen' ? gs.pressure.map(pressureFactor) : undefined
    const draw: DrawData = { width: w, strokes: [gs.pts], ...(f ? { pressure: [f] } : {}) }
    return { kind: 'ink', draw, quad: drawBounds('ink', draw) }
  }
  if (gs.pts.length < 4) return null
  const [x1, y1, x2, y2] = gs.pts
  if (props.tool === 'rect' || props.tool === 'ellipse') {
    const quad = normRect({ x1, y1, x2, y2 })
    return { kind: props.tool, draw: { width: w }, quad }
  }
  if (props.tool === 'line' || props.tool === 'arrow') {
    const r = (n: number): number => Math.round(n * 10) / 10
    const draw: DrawData = { width: w, line: [r(x1), r(y1), r(x2), r(y2)] }
    return { kind: props.tool, draw, quad: drawBounds(props.tool, draw) }
  }
  return null
}

function paintLive(): void {
  const cv = live.value
  const c = ctrl.value
  if (!cv || !c) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  if (cv.width !== Math.round(window.innerWidth * dpr) || cv.height !== Math.round(window.innerHeight * dpr)) {
    cv.width = Math.round(window.innerWidth * dpr)
    cv.height = Math.round(window.innerHeight * dpr)
  }
  const ctx = cv.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, cv.width, cv.height)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const scale = c.scale
  const draw = (page: number, a: Annotation): void => {
    paintDrawn(ctx, a, (x, y) => c.pdfToClient(page, x, y) ?? { x: -9999, y: -9999 }, scale)
  }
  for (const p of pending) draw(p.page, p.a)
  if (g && props.tool !== 'eraser') {
    if (props.tool === 'text') {
      // text: the box being dragged out
      ctx.strokeStyle = cssColor(st.color)
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1
      ctx.strokeRect(Math.min(g.sx, g.cx), Math.min(g.sy, g.cy), Math.abs(g.cx - g.sx), Math.abs(g.cy - g.sy))
      ctx.setLineDash([])
    } else {
      const a = draftAnnotation(g)
      if (a) draw(g.page, a)
    }
  }
  if (g && props.tool === 'eraser') {
    ctx.strokeStyle = 'rgba(128,128,128,0.8)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(g.cx, g.cy, eraserRadiusPx(), 0, Math.PI * 2)
    ctx.stroke()
  }
}

// ── pen ──────────────────────────────────────────────────────────────────

function commitStroke(gs: Gesture): void {
  const c = ctrl.value
  const m = mgr.value
  if (!c || !m) return
  const usePressure = gs.type === 'pen' && gs.pressure.some((p) => Math.abs(p - 0.5) > 0.02)
  const { points, factors } = finishStroke(gs.pts, usePressure ? gs.pressure : null)
  if (!points.length) return
  const color = st.color
  const width = st.width
  const saved: DrawData = { width, strokes: [points], ...(factors ? { pressure: [factors] } : {}) }
  const entry = {
    page: gs.page,
    a: draftOf('ink', { page: gs.page, quads: [drawBounds('ink', saved)], pre: '', post: '', draw: saved }, color),
  }
  pending.push(entry)
  queue = queue.then(async () => {
    const prev = inkId ? m.annotations.find((a) => a.id === inkId) : undefined
    const extend = prev && prev.kind === 'ink' && prev.anchor.page === gs.page &&
      prev.color === color && prev.anchor.draw?.width === width
    if (extend && prev) {
      const draw = appendStroke(prev.anchor.draw!, points, factors)
      const anchor: AnchorData = { ...prev.anchor, draw, quads: [drawBounds('ink', draw)] }
      const png = await renderDrawnPng(c, { ...prev, anchor })
      await m.update(prev.id, { anchor }, png)
    } else {
      const anchor = entry.a.anchor
      const png = await renderDrawnPng(c, entry.a)
      const a = await m.addDrawn({ anchor, kind: 'ink', color }, png)
      inkId = a.id
    }
  }).catch(fail).finally(() => settle(entry))
}

/** drop a saved stroke from the preview once the page layer has it */
function settle(entry: { page: number; a: Annotation }): void {
  setTimeout(() => {
    const i = pending.indexOf(entry)
    if (i >= 0) pending.splice(i, 1)
    paintLive()
  }, 120)
}

function draftOf(kind: Annotation['kind'], anchor: AnchorData, color: string): Annotation {
  return { id: '_draft', anchor, excerpt: '', note: '', color, kind, createdAt: '' }
}

// ── shapes ───────────────────────────────────────────────────────────────

function commitShape(gs: Gesture): void {
  const c = ctrl.value
  const m = mgr.value
  const d = previewDraw(gs)
  if (!c || !m || !d) return
  const anchor: AnchorData = { page: gs.page, quads: [d.quad], pre: '', post: '', draw: d.draw }
  const color = st.color
  const entry = { page: gs.page, a: draftOf(d.kind, anchor, color) }
  pending.push(entry)
  inkId = null
  queue = queue.then(async () => {
    const png = await renderDrawnPng(c, entry.a)
    await m.addDrawn({ anchor, kind: d.kind, color }, png)
  }).catch(fail).finally(() => settle(entry))
}

// ── eraser ───────────────────────────────────────────────────────────────

function eraserRadiusPx(): number {
  return g?.type === 'touch' ? 14 : 8
}

function erase(page: number, x: number, y: number): void {
  const c = ctrl.value
  if (!c) return
  const tol = eraserRadiusPx() / c.scale
  for (const a of c.annotationsOn(page)) {
    const hit = eraserHit(a, x, y, tol)
    if (hit === null) continue
    const layer = host()?.querySelector(`.pv-page[data-page="${page}"] .pv-draw-layer`)
    if (hit === 'all') {
      erased.set(a.id, 'all')
      layer?.querySelector(`[data-annot="${a.id}"]`)?.classList.add('pv-erased')
    } else {
      const cur = erased.get(a.id)
      if (cur === 'all') continue
      const set = cur ?? new Set<number>()
      set.add(hit)
      erased.set(a.id, set)
      layer?.querySelectorAll(`[data-annot="${a.id}"] [data-stroke="${hit}"]`).forEach((el) => el.classList.add('pv-erased'))
    }
  }
}

function restoreErased(): void {
  host()?.querySelectorAll('.pv-erased').forEach((el) => el.classList.remove('pv-erased'))
  erased = new Map()
}

function commitErase(): void {
  const c = ctrl.value
  const m = mgr.value
  const work = erased
  erased = new Map()
  if (!c || !m || !work.size) return
  queue = queue.then(async () => {
    for (const [id, what] of work) {
      const a = m.annotations.find((x) => x.id === id)
      if (!a) continue
      const rest = what === 'all' || !a.anchor.draw ? null : dropStrokes(a.anchor.draw, what)
      if (!rest) {
        await m.remove(id)
        if (inkId === id) inkId = null
        continue
      }
      const anchor: AnchorData = { ...a.anchor, draw: rest, quads: [drawBounds('ink', rest)] }
      const png = await renderDrawnPng(c, { ...a, anchor })
      await m.update(id, { anchor }, png)
    }
  }).catch(fail)
}

// ── text box ─────────────────────────────────────────────────────────────

function openEditor(gs: Gesture, dist: number): void {
  const c = ctrl.value
  if (!c) return
  const fs = st.fontSize * c.scale
  let left = gs.sx
  let top = gs.sy
  // a click gets a comfortable default width; a drag sets its own
  let width = 200 * c.scale
  if (dist >= 12) {
    left = Math.min(gs.sx, gs.cx)
    top = Math.min(gs.sy, gs.cy)
    width = Math.max(40, Math.abs(gs.cx - gs.sx))
  } else {
    top -= fs * 0.7 // put the first line on the click, not below it
  }
  // keep it on the page it was started on
  const box = c.quadToClient(gs.page, pageQuad(gs.page))
  if (box) width = Math.max(40, Math.min(width, box.left + box.width - left - 2))
  editor.value = { page: gs.page, left, top, width, minHeight: fs * 1.5 }
}

/** the whole page as a PDF-space quad */
function pageQuad(page: number): { x1: number; y1: number; x2: number; y2: number } {
  const { box } = ctrl.value!.pageGeometry(page)
  return { x1: box.x0, y1: box.y0, x2: box.x0 + box.w, y2: box.y0 + box.h }
}

function commitText(r: { text: string; width: number; height: number }): void {
  const ed = editor.value
  editor.value = null
  const c = ctrl.value
  const m = mgr.value
  if (!ed || !c || !m || !r.text.trim()) return
  const a = c.clientToPdf(ed.page, ed.left, ed.top)
  const b = c.clientToPdf(ed.page, ed.left + r.width, ed.top + r.height)
  if (!a || !b) return
  const quad = normRect({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  const rotate = c.pageGeometry(ed.page).rotation
  const draw: DrawData = { width: 0, fontSize: st.fontSize, ...(rotate ? { rotate } : {}) }
  const anchor: AnchorData = { page: ed.page, quads: [quad], pre: '', post: '', draw }
  const color = st.color
  inkId = null
  queue = queue.then(async () => {
    await m.addDrawn({ anchor, kind: 'textbox', color, note: r.text })
  }).catch(fail)
}

// ── bar ──────────────────────────────────────────────────────────────────

function pickColor(c: string): void { st.color = c }
function pickWidth(w: number): void { st.width = w }
function pickFont(f: number): void { st.fontSize = f }

watch(() => props.tool, () => {
  g = null
  restoreErased()
  paintLive()
})

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !editor.value) emit('cancel')
}

// ── stylus mode: listen on the page host so fingers scroll natively ──
let hostEl: HTMLElement | null = null
function bindHost(): void {
  hostEl = host()
  if (!hostEl) return
  hostEl.addEventListener('pointerdown', onHostDown, true)
  hostEl.addEventListener('touchstart', onTouch, { passive: false })
  hostEl.addEventListener('touchmove', onTouch, { passive: false })
  hostEl.classList.add('pv-drawing')
}
function onHostDown(e: PointerEvent): void {
  if (!penOnly.value) return
  onDown(e)
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointermove', onMove, { passive: false })
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('resize', paintLive)
  host()?.addEventListener('scroll', paintLive)
  bindHost()
  paintLive()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onCancel)
  window.removeEventListener('resize', paintLive)
  host()?.removeEventListener('scroll', paintLive)
  if (hostEl) {
    hostEl.removeEventListener('pointerdown', onHostDown, true)
    hostEl.removeEventListener('touchstart', onTouch)
    hostEl.removeEventListener('touchmove', onTouch)
    hostEl.classList.remove('pv-drawing')
  }
  restoreErased()
})

defineExpose({ penOnly })
</script>

<template>
  <div
    class="at-layer dt-layer"
    :class="[`dt-${tool}`, { 'dt-pen-only': penOnly }]"
    @pointerdown="onDown"
  ></div>
  <canvas ref="live" class="dt-live"></canvas>

  <TextBoxEditor
    v-if="editor"
    :left="editor.left"
    :top="editor.top"
    :width="editor.width"
    :min-height="editor.minHeight"
    :font-size="st.fontSize * (ctrl?.scale ?? 1)"
    :color="cssColor(st.color)"
    text=""
    @commit="commitText"
    @cancel="editor = null"
  />

  <div class="at-hint dt-bar" @pointerdown.stop>
    <div class="dt-row">
      <button
        v-for="k in DRAW_TOOLS" :key="k"
        class="dt-tool" :class="{ on: tool === k }"
        :title="t('dr.tool.' + k)" :aria-label="t('dr.tool.' + k)"
        :data-tool="k"
        @click="emit('switch', k)"
      >{{ TOOL_GLYPH[k] }}</button>
      <span class="dt-sep"></span>
      <button class="dt-done" @click="emit('cancel')">{{ t('dr.done') }}</button>
    </div>
    <div v-if="tool !== 'eraser'" class="dt-row">
      <button
        v-for="c in PEN_COLORS" :key="c"
        class="swatch dt-swatch" :class="{ on: st.color === c }"
        :style="{ background: c }" :title="t('dr.color')" :data-color="c"
        @click="pickColor(c)"
      />
      <span class="dt-sep"></span>
      <template v-if="tool === 'text'">
        <button
          v-for="f in FONT_SIZES" :key="f"
          class="dt-size" :class="{ on: st.fontSize === f }"
          :style="{ fontSize: 9 + f / 2 + 'px' }" :title="t('dr.fontSize')"
          @click="pickFont(f)"
        >A</button>
      </template>
      <template v-else>
        <button
          v-for="w in PEN_WIDTHS" :key="w"
          class="dt-size" :class="{ on: st.width === w }" :title="t('dr.width')" :data-width="w"
          @click="pickWidth(w)"
        ><i :style="{ width: 3 + w * 2 + 'px', height: 3 + w * 2 + 'px', background: cssColor(st.color) }"></i></button>
      </template>
    </div>
    <div v-else class="dt-row dt-note">{{ t('dr.hintEraser') }}</div>
  </div>
</template>
