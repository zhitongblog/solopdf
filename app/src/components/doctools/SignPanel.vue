<script setup lang="ts">
/**
 * Signatures and date/text stamps.
 *
 * Signatures live in the app's own data folder, never beside a document — a
 * signature that leaks into a shared folder is a real-world problem, not a
 * theoretical one.
 *
 * Placement happens on a rendered preview of the target page rather than by
 * arming a tool over the reader: you can see the whole page while you place
 * it, which is what people actually want when signing a form, and the same
 * drag works with a mouse or a finger.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { store, controllers } from '../../store'
import { docOps, pickOpenPaths, pickSavePath } from '../../platform/docops'
import { t } from '../../i18n'

const emit = defineEmits<{ toast: [msg: string]; open: [path: string] }>()

const tab = computed(() => store.activeTab)
const ctrl = computed(() => { void store.docTick; return tab.value ? controllers.get(tab.value.id) : undefined })
const busy = ref(false)

// ── library ──
const sigs = ref<{ path: string; url: string }[]>([])
const chosen = ref<string>('')

async function loadSigs(): Promise<void> {
  try {
    const paths = await docOps.listSignatures()
    const next: { path: string; url: string }[] = []
    for (const p of paths) {
      const bytes = await docOps.readFileBytes(p)
      if (!bytes.length) continue
      next.push({ path: p, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' })) })
    }
    for (const s of sigs.value) URL.revokeObjectURL(s.url)
    sigs.value = next
    if (!chosen.value && next.length) chosen.value = next[0].path
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  }
}
onMounted(loadSigs)

async function importSignature(): Promise<void> {
  const picked = await pickOpenPaths(['png'], false)
  if (!picked.length) return
  const bytes = await docOps.readFileBytes(picked[0])
  await docOps.saveSignature(`sig-${Date.now()}.png`, bytes)
  await loadSigs()
}

async function removeSignature(path: string): Promise<void> {
  await docOps.deleteSignature(path)
  if (chosen.value === path) chosen.value = ''
  await loadSigs()
}

// ── draw pad ──
const padOpen = ref(false)
const pad = ref<HTMLCanvasElement>()
let drawing = false
let padDirty = false

function padPos(e: PointerEvent): { x: number; y: number } {
  const r = pad.value!.getBoundingClientRect()
  return {
    x: ((e.clientX - r.left) / r.width) * pad.value!.width,
    y: ((e.clientY - r.top) / r.height) * pad.value!.height,
  }
}
function padDown(e: PointerEvent): void {
  drawing = true
  padDirty = true
  const ctx = pad.value!.getContext('2d')!
  ctx.strokeStyle = '#111'
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const p = padPos(e)
  ctx.beginPath()
  ctx.moveTo(p.x, p.y)
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
}
function padMove(e: PointerEvent): void {
  if (!drawing) return
  const ctx = pad.value!.getContext('2d')!
  const p = padPos(e)
  ctx.lineTo(p.x, p.y)
  ctx.stroke()
}
function padUp(): void {
  drawing = false
}
function padClear(): void {
  const c = pad.value
  if (!c) return
  c.getContext('2d')!.clearRect(0, 0, c.width, c.height)
  padDirty = false
}

async function padSave(): Promise<void> {
  const c = pad.value
  if (!c || !padDirty) return
  // trim the transparent margin so the saved signature has no dead space
  const trimmed = trimCanvas(c)
  const blob = await new Promise<Blob | null>((r) => trimmed.toBlob(r, 'image/png'))
  if (!blob) return
  await docOps.saveSignature(`sig-${Date.now()}.png`, new Uint8Array(await blob.arrayBuffer()))
  padOpen.value = false
  padClear()
  await loadSigs()
}

function trimCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = src.getContext('2d')!
  const { width: w, height: h } = src
  const data = ctx.getImageData(0, 0, w, h).data
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return src
  const pad = 6
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad)
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad)
  const out = document.createElement('canvas')
  out.width = maxX - minX + 1
  out.height = maxY - minY + 1
  out.getContext('2d')!.drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height)
  return out
}

// ── text / date stamp ──
const stampText = ref('')
function todayText(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
async function makeTextStamp(): Promise<void> {
  const text = (stampText.value || todayText()).trim()
  if (!text) return
  const scale = 4 // render big; it gets scaled down onto the page
  const font = `${16 * scale}px -apple-system, "PingFang SC", "Segoe UI", sans-serif`
  const probe = document.createElement('canvas').getContext('2d')!
  probe.font = font
  const w = Math.ceil(probe.measureText(text).width) + 8 * scale
  const h = Math.ceil(22 * scale)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.font = font
  ctx.fillStyle = '#111'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 4 * scale, h / 2)
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'))
  if (!blob) return
  await docOps.saveSignature(`text-${Date.now()}.png`, new Uint8Array(await blob.arrayBuffer()))
  stampText.value = ''
  await loadSigs()
}

// ── placement ──
const page = ref(1)
const preview = ref<HTMLCanvasElement>()
const previewUrl = ref('')
const previewSize = ref({ w: 0, h: 0 })
/** placement box in PREVIEW pixel coordinates */
const box = ref({ x: 40, y: 40, w: 160, h: 60 })
const chosenUrl = computed(() => sigs.value.find((s) => s.path === chosen.value)?.url ?? '')

async function renderPreview(): Promise<void> {
  const c = ctrl.value
  if (!c || !tab.value) return
  const p = Math.min(Math.max(1, page.value), tab.value.numPages)
  const canvas = await c.renderToCanvas(p, 1)
  previewSize.value = { w: canvas.width, h: canvas.height }
  previewUrl.value = canvas.toDataURL('image/jpeg', 0.7)
}
onMounted(renderPreview)
watch([page, () => tab.value?.id], renderPreview)

let dragMode: 'move' | 'resize' | null = null
let dragStart = { x: 0, y: 0, box: { x: 0, y: 0, w: 0, h: 0 } }

function stageScale(): number {
  const el = preview.value?.parentElement
  if (!el || !previewSize.value.w) return 1
  return el.clientWidth / previewSize.value.w
}

function onBoxDown(e: PointerEvent, mode: 'move' | 'resize'): void {
  dragMode = mode
  dragStart = { x: e.clientX, y: e.clientY, box: { ...box.value } }
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  e.stopPropagation()
}
function onBoxMove(e: PointerEvent): void {
  if (!dragMode) return
  const s = stageScale() || 1
  const dx = (e.clientX - dragStart.x) / s
  const dy = (e.clientY - dragStart.y) / s
  if (dragMode === 'move') {
    box.value = { ...box.value, x: dragStart.box.x + dx, y: dragStart.box.y + dy }
  } else {
    // keep the signature's aspect ratio: a stretched signature looks forged
    const ratio = dragStart.box.h / Math.max(1, dragStart.box.w)
    const w = Math.max(24, dragStart.box.w + dx)
    box.value = { ...box.value, w, h: w * ratio }
  }
}
function onBoxUp(): void {
  dragMode = null
}

/** fit the box to the chosen signature's aspect ratio when it changes */
watch(chosenUrl, (url) => {
  if (!url) return
  const img = new Image()
  img.onload = () => {
    const w = box.value.w
    box.value = { ...box.value, h: (w * img.height) / img.width }
  }
  img.src = url
})

async function apply(): Promise<void> {
  const src = tab.value?.path
  const c = ctrl.value
  if (!src || !c || !chosen.value) return
  // preview was rendered at scale 1, i.e. 1px == 1pt, with y measured DOWN
  // from the top; PDF user space is y-up from the bottom
  const geo = c.pageGeometry(page.value)
  const pageH = previewSize.value.h
  const rect: [number, number, number, number] = [
    box.value.x,
    pageH - box.value.y - box.value.h,
    box.value.w,
    box.value.h,
  ]
  void geo
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-signed.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = true
  try {
    const out = await docOps.stamp(src, dest, null, [
      { page: page.value, rect, imagePath: chosen.value },
    ])
    emit('toast', t('dt.saved', { file: out.split('/').pop() ?? out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="dt-section">
    <h4>{{ t('dt.sg.library') }}</h4>
    <div class="dt-sigs">
      <button
        v-for="s in sigs" :key="s.path"
        class="dt-sig" :class="{ on: chosen === s.path }"
        @click="chosen = s.path"
      >
        <img :src="s.url" alt="" />
        <span class="dt-sig-del" @click.stop="removeSignature(s.path)">✕</span>
      </button>
      <div v-if="!sigs.length" class="dt-empty">{{ t('dt.sg.empty') }}</div>
    </div>
    <div class="dt-actions">
      <button @click="padOpen = !padOpen">{{ t('dt.sg.draw') }}</button>
      <button @click="importSignature">{{ t('dt.sg.import') }}</button>
    </div>

    <div v-if="padOpen" class="dt-pad-wrap">
      <canvas
        ref="pad" class="dt-pad" width="600" height="200"
        @pointerdown="padDown" @pointermove="padMove" @pointerup="padUp" @pointercancel="padUp"
      ></canvas>
      <div class="dt-actions">
        <button @click="padClear">{{ t('dt.sg.clear') }}</button>
        <button class="primary" @click="padSave">{{ t('dt.sg.savePad') }}</button>
      </div>
    </div>

    <div class="dt-field">
      <label>{{ t('dt.sg.textStamp') }}</label>
      <input v-model="stampText" :placeholder="todayText()" />
      <button @click="makeTextStamp">{{ t('dt.sg.makeText') }}</button>
    </div>

    <h4>{{ t('dt.sg.place') }}</h4>
    <div class="dt-field">
      <label>{{ t('dt.sg.page') }}</label>
      <input type="number" min="1" :max="tab?.numPages ?? 1" v-model.number="page" />
    </div>
    <div
      class="dt-stage"
      @pointermove="onBoxMove" @pointerup="onBoxUp" @pointercancel="onBoxUp"
    >
      <img v-if="previewUrl" ref="preview" class="dt-stage-img" :src="previewUrl" alt="" />
      <div
        v-if="chosenUrl && previewSize.w"
        class="dt-stage-box"
        :style="{
          left: (box.x / previewSize.w * 100) + '%',
          top: (box.y / previewSize.h * 100) + '%',
          width: (box.w / previewSize.w * 100) + '%',
          height: (box.h / previewSize.h * 100) + '%',
        }"
        @pointerdown="onBoxDown($event, 'move')"
      >
        <img :src="chosenUrl" alt="" />
        <span class="dt-stage-handle" @pointerdown="onBoxDown($event, 'resize')"></span>
      </div>
    </div>

    <div class="dt-footer">
      <button class="primary" :disabled="busy || !chosen" @click="apply">
        {{ busy ? t('dt.working') : t('dt.sg.apply') }}
      </button>
    </div>
  </div>
</template>
