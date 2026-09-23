<script setup lang="ts">
/**
 * Select / move / resize / recolour / delete drawn marks while READING
 * (no tool armed). Clicking a stroke, shape outline or text box selects it:
 *
 *   ┌─ ─ ─ ─ ─ ─ ┐   drag inside the box   → move
 *   │  selected   │   drag a corner handle  → resize (shapes, text boxes)
 *   └─ ─ ─ ─ ─ ─ ┘   drag an end handle    → re-aim (line, arrow)
 *     [● ● ● ● ●] [━ ━ ━] [✎] [🗑]         → colour / width / edit / delete
 *
 * Positions are recomputed from PDF space every frame while something is
 * selected, so scrolling, zooming or rotating never leaves the box behind.
 * Every change is a manager.update()/remove() call — undo-able, spliced.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  drawBounds, normRect, translateDrawn, type Annotation, type AnchorData, type DrawData,
} from '@solopdf/core'
import { store, controllers, annotManagers } from '../store'
import { t } from '../i18n'
import {
  PEN_COLORS, PEN_WIDTHS, FONT_SIZES, cssColor, renderDrawnPng, textFrame,
} from '../annotations/drawing'
import { normRotation } from '../viewer/geometry'
import TextBoxEditor from './TextBoxEditor.vue'

const props = defineProps<{ tabId: number }>()
const emit = defineEmits<{ toast: [msg: string] }>()

const ctrl = computed(() => { void store.docTick; return controllers.get(props.tabId) })
const mgr = computed(() => { void store.docTick; return annotManagers.get(props.tabId) })

const selId = ref<string | null>(null)
const sel = computed<Annotation | undefined>(() => {
  void store.docTick
  return selId.value ? mgr.value?.annotations.find((a) => a.id === selId.value) : undefined
})
/** client rect of the selection box, refreshed every frame */
const box = ref<{ left: number; top: number; width: number; height: number } | null>(null)
const ends = ref<{ x: number; y: number }[]>([])
const editing = ref<{ left: number; top: number; width: number; minHeight: number; fs: number } | null>(null)
const busy = ref(false)
const narrow = ref(window.innerWidth < 700)

/** in-flight drag: move, corner resize or line-end */
interface Drag {
  mode: 'move' | 'corner' | 'end'
  idx: number
  id: number
  sx: number; sy: number
  dx: number; dy: number
  moved: boolean
}
let drag: Drag | null = null

function host(): HTMLElement | null {
  return document.querySelector(`.pv-scroll[data-tab="${props.tabId}"]`)
}

function marks(id: string): Element[] {
  return [...(host()?.querySelectorAll(`.pv-draw-layer [data-annot="${id}"]`) ?? [])]
}

function select(id: string | null): void {
  if (selId.value && selId.value !== id) for (const el of marks(selId.value)) el.classList.remove('pv-draw-sel')
  selId.value = id
  editing.value = null
}

// ── frame loop: keep the box glued to the mark ──
let raf = 0
function frame(): void {
  raf = 0
  const a = sel.value
  const c = ctrl.value
  if (!a || !c) { box.value = null; ends.value = []; return }
  for (const el of marks(a.id)) el.classList.add('pv-draw-sel')
  const q = liveQuad(a)
  const r = q && c.quadToClient(a.anchor.page, q)
  // scrolled out of the reading area: no box floating over the toolbar
  const hr = host()?.getBoundingClientRect()
  const gone = !r || !hr || r.top + r.height < hr.top || r.top > hr.bottom
  if (gone) { box.value = null } else {
    const off = drag?.mode === 'move' ? { x: drag.dx, y: drag.dy } : { x: 0, y: 0 }
    const b = { left: r.left + off.x, top: r.top + off.y, width: r.width, height: r.height }
    const cur = box.value
    if (!cur || cur.left !== b.left || cur.top !== b.top || cur.width !== b.width || cur.height !== b.height) box.value = b
  }
  const l = liveLine(a)
  if (l) {
    const p1 = c.pdfToClient(a.anchor.page, l[0], l[1])
    const p2 = c.pdfToClient(a.anchor.page, l[2], l[3])
    const off = drag?.mode === 'move' ? { x: drag.dx, y: drag.dy } : { x: 0, y: 0 }
    ends.value = p1 && p2 ? [{ x: p1.x + off.x, y: p1.y + off.y }, { x: p2.x + off.x, y: p2.y + off.y }] : []
  } else if (ends.value.length) ends.value = []
  raf = requestAnimationFrame(frame)
}
watch(selId, (id) => { if (id && !raf) raf = requestAnimationFrame(frame) })
// the mark went away (deleted in the sidebar, undone, external edit)
watch(sel, (a) => { if (selId.value && !a) select(null) })

/** the quad as it will be after the in-flight resize */
function liveQuad(a: Annotation): AnchorData['quads'][0] | null {
  const q = a.anchor.quads[0]
  if (!q) return null
  if (drag?.mode === 'corner' && drag.moved) return resizedQuad(a, drag) ?? q
  if (drag?.mode === 'end' && drag.moved) {
    const d = reaimed(a, drag)
    return d ? drawBounds(a.kind!, d) : q
  }
  return q
}
function liveLine(a: Annotation): [number, number, number, number] | null {
  if (a.kind !== 'line' && a.kind !== 'arrow') return null
  if (drag?.mode === 'end' && drag.moved) return reaimed(a, drag)?.line ?? a.anchor.draw?.line ?? null
  return a.anchor.draw?.line ?? null
}

// ── pointer ──
function onHostDown(e: PointerEvent): void {
  if (e.button > 0) return
  const target = (e.target as Element | null)?.closest?.('[data-draw]') as HTMLElement | SVGElement | null
  if (!target) {
    if (selId.value && !editing.value) select(null)
    return
  }
  const id = (target as HTMLElement).dataset.annot ?? target.getAttribute('data-annot')
  if (!id) return
  e.preventDefault()
  e.stopPropagation()
  window.getSelection()?.removeAllRanges()
  select(id)
  startDrag(e, 'move', 0)
}

function startDrag(e: PointerEvent, mode: Drag['mode'], idx: number): void {
  if (busy.value) return
  drag = { mode, idx, id: e.pointerId, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false }
}

function onDownBox(e: PointerEvent, mode: Drag['mode'], idx = 0): void {
  if (e.button > 0) return
  e.preventDefault()
  e.stopPropagation()
  startDrag(e, mode, idx)
}

function onMove(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.id) return
  drag.dx = e.clientX - drag.sx
  drag.dy = e.clientY - drag.sy
  if (!drag.moved && Math.hypot(drag.dx, drag.dy) < 4) return
  drag.moved = true
  e.preventDefault()
  if (drag.mode === 'move' && selId.value) {
    // live: slide the painted mark itself; text boxes keep their rotation
    for (const el of marks(selId.value)) {
      const h = el as HTMLElement
      if (h.dataset.baseTransform === undefined) h.dataset.baseTransform = h.style.transform || ''
      h.style.transform = `translate(${drag.dx}px, ${drag.dy}px) ${h.dataset.baseTransform}`
    }
  }
}

async function onUp(e: PointerEvent): Promise<void> {
  if (!drag || e.pointerId !== drag.id) return
  const d = drag
  drag = null
  const a = sel.value
  if (!a || !d.moved) { resetTransforms(); return }
  let patch: Partial<AnchorData> | null = null
  if (d.mode === 'move') {
    const c = ctrl.value!
    const p0 = c.clientToPdf(a.anchor.page, d.sx, d.sy)
    const p1 = c.clientToPdf(a.anchor.page, d.sx + d.dx, d.sy + d.dy)
    if (p0 && p1) patch = translateDrawn(a, p1.x - p0.x, p1.y - p0.y)
  } else if (d.mode === 'corner') {
    const q = resizedQuad(a, d)
    if (q) patch = { quads: [q] }
  } else {
    const draw = reaimed(a, d)
    if (draw) patch = { draw, quads: [drawBounds(a.kind!, draw)] }
  }
  if (patch) await save(a, { anchor: { ...a.anchor, ...patch } })
  resetTransforms()
}

function resetTransforms(): void {
  if (!selId.value) return
  for (const el of marks(selId.value)) {
    const h = el as HTMLElement
    if (h.dataset.baseTransform !== undefined) {
      h.style.transform = h.dataset.baseTransform
      delete h.dataset.baseTransform
    }
  }
}

/** corner drag: the opposite corner stays put, in client space */
function resizedQuad(a: Annotation, d: Drag): AnchorData['quads'][0] | null {
  const c = ctrl.value
  const q = a.anchor.quads[0]
  const r = c && q && c.quadToClient(a.anchor.page, q)
  if (!c || !r) return null
  const xs = [r.left, r.left + r.width]
  const ys = [r.top, r.top + r.height]
  // corners: 0 tl, 1 tr, 2 br, 3 bl
  const cx = [0, 1, 1, 0][d.idx]
  const cy = [0, 0, 1, 1][d.idx]
  const fixed = { x: xs[1 - cx], y: ys[1 - cy] }
  const moving = { x: xs[cx] + d.dx, y: ys[cy] + d.dy }
  const p = c.clientToPdf(a.anchor.page, fixed.x, fixed.y)
  const m = c.clientToPdf(a.anchor.page, moving.x, moving.y)
  if (!p || !m) return null
  const n = normRect({ x1: p.x, y1: p.y, x2: m.x, y2: m.y })
  // never collapse to nothing — a 4pt box can't be grabbed again
  if (n.x2 - n.x1 < 4 || n.y2 - n.y1 < 4) return null
  return n
}

/** end-handle drag on a line/arrow */
function reaimed(a: Annotation, d: Drag): DrawData | null {
  const c = ctrl.value
  const draw = a.anchor.draw
  const l = draw?.line
  if (!c || !draw || !l) return null
  const at = c.pdfToClient(a.anchor.page, l[d.idx * 2], l[d.idx * 2 + 1])
  if (!at) return null
  const p = c.clientToPdf(a.anchor.page, at.x + d.dx, at.y + d.dy)
  if (!p) return null
  const line: [number, number, number, number] = [...l]
  line[d.idx * 2] = Math.round(p.x * 10) / 10
  line[d.idx * 2 + 1] = Math.round(p.y * 10) / 10
  return { ...draw, line }
}

// ── edits ──
async function save(a: Annotation, patch: Partial<Pick<Annotation, 'anchor' | 'color' | 'note'>>): Promise<void> {
  const c = ctrl.value
  const m = mgr.value
  if (!c || !m) return
  busy.value = true
  try {
    const next = { ...a, ...patch }
    // text boxes show their text in the sidecar; everything else a picture
    const png = a.kind === 'textbox' ? null : await renderDrawnPng(c, next)
    await m.update(a.id, patch, png)
  } catch (err) {
    emit('toast', t('dr.saveFail', { msg: String((err as Error)?.message ?? err) }))
  } finally {
    busy.value = false
  }
}

function recolor(color: string): void {
  const a = sel.value
  if (a && a.color !== color) void save(a, { color })
}

function rewidth(width: number): void {
  const a = sel.value
  const d = a?.anchor.draw
  if (!a || !d || d.width === width) return
  const draw = { ...d, width }
  const quads = a.kind === 'rect' || a.kind === 'ellipse' ? a.anchor.quads : [drawBounds(a.kind!, draw)]
  void save(a, { anchor: { ...a.anchor, draw, quads } })
}

function refont(fontSize: number): void {
  const a = sel.value
  const d = a?.anchor.draw
  if (!a || !d || d.fontSize === fontSize) return
  void save(a, { anchor: { ...a.anchor, draw: { ...d, fontSize } } })
}

async function remove(): Promise<void> {
  const a = sel.value
  const m = mgr.value
  if (!a || !m) return
  select(null)
  try {
    await m.remove(a.id)
  } catch (err) {
    emit('toast', t('dr.saveFail', { msg: String((err as Error)?.message ?? err) }))
  }
}

/** the text box's frame as seen now: only editable in place when upright */
function upright(a: Annotation): boolean {
  const c = ctrl.value
  if (!c) return false
  return normRotation(c.pageGeometry(a.anchor.page).rotation - (a.anchor.draw?.rotate ?? 0)) === 0
}

function startEdit(): void {
  const a = sel.value
  const c = ctrl.value
  if (!a || a.kind !== 'textbox' || !c || !box.value) return
  const fs = (a.anchor.draw?.fontSize ?? 14) * c.scale
  const q = a.anchor.quads[0]
  const f = textFrame(q, a.anchor.draw?.rotate ?? 0)
  const b = box.value
  // an upright box edits in place; a turned one edits in an upright
  // editor centred on it (typing sideways is nobody's idea of fun)
  const w = f.w * c.scale
  const h = f.h * c.scale
  editing.value = upright(a)
    ? { left: b.left, top: b.top, width: b.width, minHeight: b.height, fs }
    : { left: b.left + b.width / 2 - w / 2, top: b.top + b.height / 2 - h / 2, width: w, minHeight: h, fs }
}

async function commitEdit(r: { text: string; width: number; height: number }): Promise<void> {
  const ed = editing.value
  editing.value = null
  const a = sel.value
  const c = ctrl.value
  if (!ed || !a || !c) return
  if (!r.text.trim()) { await remove(); return }
  let anchor = a.anchor
  // grew while typing: extend the box downward (upright boxes only — the
  // on-screen "down" of a turned box isn't the text's down)
  if (upright(a) && Math.abs(r.height - ed.minHeight) > 1) {
    const p = c.clientToPdf(a.anchor.page, ed.left, ed.top)
    const q = c.clientToPdf(a.anchor.page, ed.left + ed.width, ed.top + r.height)
    if (p && q) anchor = { ...a.anchor, quads: [normRect({ x1: p.x, y1: p.y, x2: q.x, y2: q.y })] }
  }
  if (r.text === a.note && anchor === a.anchor) return
  await save(a, { note: r.text, anchor })
}

function onDbl(e: MouseEvent): void {
  const target = (e.target as Element | null)?.closest?.('[data-draw="textbox"]') as HTMLElement | null
  if (!target) return
  e.preventDefault()
  select(target.dataset.annot ?? null)
  requestAnimationFrame(() => startEdit())
}

function onKey(e: KeyboardEvent): void {
  if (!selId.value || editing.value) return
  const el = e.target as HTMLElement
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); void remove() }
  else if (e.key === 'Escape') select(null)
  else if (e.key === 'Enter' && sel.value?.kind === 'textbox') { e.preventDefault(); startEdit() }
}

const isShape = computed(() => ['rect', 'ellipse', 'textbox'].includes(sel.value?.kind ?? ''))
const isLine = computed(() => sel.value?.kind === 'line' || sel.value?.kind === 'arrow')

/** toolbar placement: above the box, below when there's no room; docked on phones */
const barStyle = computed(() => {
  const b = box.value
  if (!b || narrow.value) return {}
  const above = b.top > 64
  return {
    left: `${Math.max(8, Math.min(b.left, window.innerWidth - 340))}px`,
    top: above ? `${b.top - 48}px` : `${b.top + b.height + 10}px`,
  }
})

let hostEl: HTMLElement | null = null
function onResize(): void { narrow.value = window.innerWidth < 700 }
onMounted(() => {
  hostEl = host()
  hostEl?.addEventListener('pointerdown', onHostDown, true)
  hostEl?.addEventListener('dblclick', onDbl)
  window.addEventListener('pointermove', onMove, { passive: false })
  window.addEventListener('pointerup', onUp)
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  hostEl?.removeEventListener('pointerdown', onHostDown, true)
  hostEl?.removeEventListener('dblclick', onDbl)
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
  if (raf) cancelAnimationFrame(raf)
  select(null)
})

defineExpose({ select, selId })
</script>

<template>
  <template v-if="sel && box">
    <div
      class="ds-box"
      :style="{ left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' }"
      @pointerdown="(e) => onDownBox(e, 'move')"
      @dblclick="sel?.kind === 'textbox' && startEdit()"
    >
      <template v-if="isShape">
        <span
          v-for="i in 4" :key="i"
          class="ds-handle" :class="`ds-c${i - 1}`"
          @pointerdown="(e) => onDownBox(e, 'corner', i - 1)"
        ></span>
      </template>
    </div>
    <span
      v-for="(p, i) in ends" :key="'e' + i"
      class="ds-handle ds-end"
      :style="{ left: p.x + 'px', top: p.y + 'px' }"
      @pointerdown="(e) => onDownBox(e, 'end', i)"
    ></span>

    <div v-if="!editing" class="ds-bar" :class="{ docked: narrow }" :style="barStyle" @pointerdown.stop>
      <button
        v-for="c in PEN_COLORS" :key="c"
        class="swatch dt-swatch" :class="{ on: sel.color === c }"
        :style="{ background: c }" :title="t('dr.color')" :data-color="c"
        @click="recolor(c)"
      />
      <span class="dt-sep"></span>
      <template v-if="sel.kind === 'textbox'">
        <button
          v-for="f in FONT_SIZES" :key="f"
          class="dt-size" :class="{ on: sel.anchor.draw?.fontSize === f }"
          :style="{ fontSize: 9 + f / 2 + 'px' }" :title="t('dr.fontSize')"
          @click="refont(f)"
        >A</button>
        <button class="dt-act" :title="t('dr.edit')" @click="startEdit()">✎</button>
      </template>
      <template v-else>
        <button
          v-for="w in PEN_WIDTHS" :key="w"
          class="dt-size" :class="{ on: sel.anchor.draw?.width === w }" :title="t('dr.width')"
          @click="rewidth(w)"
        ><i :style="{ width: 3 + w * 2 + 'px', height: 3 + w * 2 + 'px', background: cssColor(sel.color) }"></i></button>
      </template>
      <span class="dt-sep"></span>
      <button class="dt-act ds-del" :title="t('dr.delete')" data-act="delete" @click="remove()">🗑</button>
    </div>
  </template>

  <TextBoxEditor
    v-if="editing && sel"
    :left="editing.left"
    :top="editing.top"
    :width="editing.width"
    :min-height="editing.minHeight"
    :font-size="editing.fs"
    :color="cssColor(sel.color)"
    :text="sel.note"
    @commit="commitEdit"
    @cancel="editing = null"
  />
</template>
