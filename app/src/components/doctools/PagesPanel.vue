<script setup lang="ts">
/**
 * Page management: rotate, delete, extract, reorder — then save as a new PDF.
 *
 * The whole panel edits a plan (an ordered list of source page numbers plus
 * per-page rotation), and only "Save as" turns that plan into a file. That
 * way a mis-click costs an undo, not a document, and one round-trip through
 * lopdf does arrangement and rotation together.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { store, documents } from '../../store'
import { isMobile } from '../../platform'
import { docOps, pickSavePath } from '../../platform/docops'
import { t } from '../../i18n'

const emit = defineEmits<{ toast: [msg: string]; open: [path: string] }>()

interface PagePlan {
  /** 1-based page number in the SOURCE document */
  src: number
  /** extra rotation to apply on save, degrees */
  rot: number
  thumb: string | null
}

const tab = computed(() => store.activeTab)
const doc = computed(() => { void store.docTick; return tab.value ? documents.get(tab.value.id) : undefined })
const plan = ref<PagePlan[]>([])
const selected = ref<Set<number>>(new Set())
const busy = ref(false)
const dragFrom = ref<number | null>(null)
const phone = computed(() => isMobile() || window.innerWidth < 700)

function reset(): void {
  const n = tab.value?.numPages ?? 0
  plan.value = Array.from({ length: n }, (_, i) => ({ src: i + 1, rot: 0, thumb: null }))
  selected.value = new Set()
  void renderThumbs()
}

/** thumbnails at a deliberately small scale — this grid can hold 1000 pages */
async function renderThumbs(): Promise<void> {
  const d = doc.value
  if (!d) return
  for (let i = 0; i < plan.value.length; i++) {
    const item = plan.value[i]
    if (item.thumb) continue
    try {
      const page = await d.getPage(item.src)
      const vp = page.getViewport({ scale: 0.16 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(vp.width))
      canvas.height = Math.max(1, Math.floor(vp.height))
      const ctx = canvas.getContext('2d', { alpha: false })!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise
      item.thumb = canvas.toDataURL('image/jpeg', 0.6)
      plan.value = [...plan.value]
    } catch {
      /* a page that won't thumbnail can still be moved and saved */
    }
    // let the UI breathe every few pages
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0))
  }
}

onMounted(reset)
watch(() => tab.value?.id, reset)

// ── selection ──
function toggle(i: number): void {
  const next = new Set(selected.value)
  next.has(i) ? next.delete(i) : next.add(i)
  selected.value = next
}
function selectAll(): void {
  selected.value = new Set(plan.value.map((_, i) => i))
}
function selectNone(): void {
  selected.value = new Set()
}
const anySelected = computed(() => selected.value.size > 0)
/** operate on the selection, or on everything when nothing is picked */
function targets(): number[] {
  return anySelected.value ? [...selected.value].sort((a, b) => a - b) : plan.value.map((_, i) => i)
}

// ── plan edits ──
function rotate(delta: number): void {
  const idx = new Set(targets())
  plan.value = plan.value.map((p, i) => (idx.has(i) ? { ...p, rot: (((p.rot + delta) % 360) + 360) % 360 } : p))
}

function removeSelected(): void {
  if (!anySelected.value) return
  if (selected.value.size >= plan.value.length) {
    emit('toast', t('dt.pages.keepOne'))
    return
  }
  plan.value = plan.value.filter((_, i) => !selected.value.has(i))
  selected.value = new Set()
}

function move(dir: -1 | 1): void {
  const idx = [...selected.value].sort((a, b) => (dir < 0 ? a - b : b - a))
  if (!idx.length) return
  const next = [...plan.value]
  const moved = new Set<number>()
  for (const i of idx) {
    const j = i + dir
    if (j < 0 || j >= next.length || selected.value.has(j)) continue
    ;[next[i], next[j]] = [next[j], next[i]]
    moved.add(j)
  }
  plan.value = next
  selected.value = moved.size ? moved : selected.value
}

/** desktop nicety: drag a page onto another to drop it there */
function onDragStart(i: number): void {
  dragFrom.value = i
}
function onDrop(i: number): void {
  const from = dragFrom.value
  dragFrom.value = null
  if (from === null || from === i) return
  const next = [...plan.value]
  const [item] = next.splice(from, 1)
  next.splice(i, 0, item)
  plan.value = next
}

const dirty = computed(() => {
  const p = plan.value
  if (p.length !== (tab.value?.numPages ?? 0)) return true
  return p.some((x, i) => x.src !== i + 1 || x.rot !== 0)
})

// ── save ──
async function saveAs(onlySelected: boolean): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const items = onlySelected && anySelected.value
    ? [...selected.value].sort((a, b) => a - b).map((i) => plan.value[i])
    : plan.value
  if (!items.length) return
  const suffix = onlySelected ? '-extract' : '-pages'
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + suffix + '.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return // cancelled
  busy.value = true
  try {
    // arrangement first, then rotation — rotation is addressed by the
    // POSITION in the new file, which only exists after arranging
    let out = await docOps.arrangePages(src, dest, null, items.map((p) => p.src))
    const groups = new Map<number, number[]>()
    items.forEach((p, i) => {
      if (!p.rot) return
      const g = groups.get(p.rot) ?? []
      g.push(i + 1)
      groups.set(p.rot, g)
    })
    for (const [deg, pages] of groups) {
      out = await docOps.rotatePages(out, out, null, pages, deg)
    }
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
    <p class="dt-hint">{{ t('dt.pages.hint') }}</p>

    <div class="dt-actions">
      <button @click="selectAll">{{ t('dt.pages.selectAll') }}</button>
      <button :disabled="!anySelected" @click="selectNone">{{ t('dt.pages.selectNone') }}</button>
      <span class="dt-count">{{ t('dt.pages.count', { n: selected.size, total: plan.length }) }}</span>
    </div>
    <div class="dt-actions">
      <button @click="rotate(-90)">⟲ {{ t('vm.ccw') }}</button>
      <button @click="rotate(90)">⟳ {{ t('vm.cw') }}</button>
      <button :disabled="!anySelected" @click="move(-1)">←</button>
      <button :disabled="!anySelected" @click="move(1)">→</button>
      <button :disabled="!anySelected" class="danger" @click="removeSelected">{{ t('dt.pages.remove') }}</button>
    </div>

    <div class="dt-grid">
      <div
        v-for="(p, i) in plan" :key="`${p.src}-${i}`"
        class="dt-page" :class="{ on: selected.has(i) }"
        :draggable="!phone"
        @click="toggle(i)"
        @dragstart="onDragStart(i)"
        @dragover.prevent
        @drop="onDrop(i)"
      >
        <div class="dt-thumb" :style="{ transform: `rotate(${p.rot}deg)` }">
          <img v-if="p.thumb" :src="p.thumb" alt="" />
          <div v-else class="dt-thumb-ph"></div>
        </div>
        <div class="dt-page-no">
          {{ i + 1 }}<span v-if="p.src !== i + 1" class="dt-orig">←{{ p.src }}</span>
        </div>
      </div>
    </div>

    <div class="dt-footer">
      <button :disabled="busy || !anySelected" @click="saveAs(true)">{{ t('dt.pages.extract') }}</button>
      <button class="primary" :disabled="busy || !dirty" @click="saveAs(false)">
        {{ busy ? t('dt.working') : t('dt.pages.save') }}
      </button>
    </div>
  </div>
</template>
