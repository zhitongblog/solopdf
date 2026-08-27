<script setup lang="ts">
/**
 * Armed-tool overlay for the PDF view: sticky notes and region screenshots.
 *
 * Sits above the page layers only while a tool is armed, so normal reading
 * and text selection are never intercepted. Both tools end in the same
 * editor sheet (note text + colour), because both produce a `##` section in
 * the sidecar and the user is really writing a note either way.
 *
 * Desktop drags with a mouse; phones drag with a finger — the same pointer
 * handlers cover both, and the hint bar gives phones an explicit Cancel
 * (there is no Esc key to press).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Quad } from '@solopdf/core'
import { store, controllers, annotManagers } from '../store'
import { t } from '../i18n'

const props = defineProps<{ tabId: number; tool: 'note' | 'region' }>()
const emit = defineEmits<{ done: [msg: string]; cancel: [] }>()

const ctrl = computed(() => { void store.docTick; return controllers.get(props.tabId) })
const mgr = computed(() => { void store.docTick; return annotManagers.get(props.tabId) })

/** rubber band in client coords */
const band = ref<{ x: number; y: number; w: number; h: number } | null>(null)
const busy = ref(false)
const editor = ref<{
  page: number
  quad: Quad
  kind: 'note' | 'region'
  preview: string | null
  png: Uint8Array | null
} | null>(null)
const noteText = ref('')
const noteColor = ref('yellow')
const COLORS = ['yellow', 'green', 'blue', 'pink'] as const

let startX = 0
let startY = 0
let startPage: number | null = null
let dragging = false

function host(): HTMLElement | null {
  return document.querySelector(`.pv-scroll[data-tab="${props.tabId}"]`)
}

/** clamp a client point into the visible (cropped) box of one page */
function clampToPage(page: number, x: number, y: number): { x: number; y: number } {
  const el = document.querySelector(
    `.pv-scroll[data-tab="${props.tabId}"] .pv-page[data-page="${page}"]`,
  ) as HTMLElement | null
  if (!el) return { x, y }
  const r = el.getBoundingClientRect()
  return {
    x: Math.min(Math.max(x, r.left + 1), r.right - 1),
    y: Math.min(Math.max(y, r.top + 1), r.bottom - 1),
  }
}

function onPointerDown(e: PointerEvent): void {
  const c = ctrl.value
  if (!c || busy.value || editor.value) return
  const page = c.pageAt(e.clientX, e.clientY)
  if (!page) return
  startPage = page
  startX = e.clientX
  startY = e.clientY
  if (props.tool === 'note') {
    void placeNote(page, e.clientX, e.clientY)
    return
  }
  dragging = true
  band.value = { x: e.clientX, y: e.clientY, w: 0, h: 0 }
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging || startPage == null) return
  const p = clampToPage(startPage, e.clientX, e.clientY)
  band.value = {
    x: Math.min(startX, p.x),
    y: Math.min(startY, p.y),
    w: Math.abs(p.x - startX),
    h: Math.abs(p.y - startY),
  }
}

async function onPointerUp(e: PointerEvent): Promise<void> {
  if (!dragging || startPage == null) return
  dragging = false
  const c = ctrl.value
  const rect = band.value
  band.value = null
  // a stray click is not a region — require a box big enough to hold anything
  if (!c || !rect || rect.w < 12 || rect.h < 12) return
  const p = clampToPage(startPage, e.clientX, e.clientY)
  const a = c.clientToPdf(startPage, Math.min(startX, p.x), Math.min(startY, p.y))
  const b = c.clientToPdf(startPage, Math.max(startX, p.x), Math.max(startY, p.y))
  if (!a || !b) return
  const quad: Quad = {
    x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y),
    x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y),
  }
  busy.value = true
  try {
    const png = await c.captureRegion(startPage, quad)
    editor.value = {
      page: startPage,
      quad,
      kind: 'region',
      png,
      preview: URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' })),
    }
    noteText.value = ''
    noteColor.value = 'blue'
  } catch (err) {
    emit('done', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}

async function placeNote(page: number, clientX: number, clientY: number): Promise<void> {
  const c = ctrl.value
  const pt = c?.clientToPdf(page, clientX, clientY)
  if (!pt) return
  editor.value = {
    page,
    quad: { x1: pt.x, y1: pt.y, x2: pt.x + 1, y2: pt.y + 1 },
    kind: 'note',
    png: null,
    preview: null,
  }
  noteText.value = ''
  noteColor.value = 'yellow'
}

async function save(): Promise<void> {
  const ed = editor.value
  const m = mgr.value
  if (!ed || !m) return
  busy.value = true
  try {
    if (ed.kind === 'region' && ed.png) {
      await m.addRegion(ed.page, ed.quad, ed.png, noteText.value.trim(), noteColor.value)
    } else {
      await m.addNote(ed.page, ed.quad.x1, ed.quad.y1, noteText.value.trim())
    }
    emit('done', t('at.saved', { file: m.sidecarLocation.split('/').pop() ?? '' }))
  } catch (err) {
    emit('done', String((err as Error).message ?? err))
  } finally {
    busy.value = false
    closeEditor()
  }
}

function closeEditor(): void {
  if (editor.value?.preview) URL.revokeObjectURL(editor.value.preview)
  editor.value = null
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (editor.value) closeEditor()
    else emit('cancel')
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  closeEditor()
  void host()
})
</script>

<template>
  <div
    class="at-layer"
    :class="`at-${tool}`"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
  >
    <div
      v-if="band"
      class="at-band"
      :style="{ left: band.x + 'px', top: band.y + 'px', width: band.w + 'px', height: band.h + 'px' }"
    ></div>
  </div>

  <div class="at-hint">
    <span>{{ tool === 'note' ? t('at.hintNote') : t('at.hintRegion') }}</span>
    <button @click="emit('cancel')">{{ t('at.cancel') }}</button>
  </div>

  <div v-if="editor" class="modal-mask" @click.self="closeEditor()">
    <div class="modal at-editor">
      <h3>{{ editor.kind === 'region' ? t('at.regionTitle') : t('at.noteTitle') }}</h3>
      <img v-if="editor.preview" class="at-preview" :src="editor.preview" alt="" />
      <textarea
        v-model="noteText"
        :placeholder="t('at.placeholder')"
        rows="4"
        autofocus
        @keydown.enter.meta="save()"
      ></textarea>
      <div class="at-colors">
        <button
          v-for="c in COLORS" :key="c"
          class="swatch" :class="[`sw-${c}`, { on: noteColor === c }]"
          @click="noteColor = c"
        />
      </div>
      <div class="modal-actions">
        <button @click="closeEditor()">{{ t('at.cancel') }}</button>
        <button class="primary" :disabled="busy" @click="save()">{{ t('at.save') }}</button>
      </div>
    </div>
  </div>
</template>
