<script setup lang="ts">
/**
 * Sidebar "Changes" tab while two documents are compared: summary, pages
 * that could not be compared (no text layer), previous / next, and the list
 * of differences — clicking one brings it into view in both documents.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import { compareSession, compareCurrent, gotoChange, stepChange, endCompare } from '../compare'
import { pair, setPairSync } from '../viewer/pair'
import { documents, controllers } from '../store'
import {
  computeVisualDiff,
  mapComparedPage,
  type CompareChange,
  type VisualDiffHotspot,
} from '@solopdf/core'

const listEl = ref<HTMLDivElement>()
const s = computed(() => compareSession.value)
const changes = computed(() => s.value?.result.changes ?? [])

// ── Visual Overlay & Blink Compare ──
const visualOpen = ref(false)
const visualMode = ref<'anaglyph' | 'tint' | 'blink'>('anaglyph')
const visualPageA = ref(1)
const visualPageB = ref(1)
const visualDiffRatio = ref(0)
const visualHotspots = ref<VisualDiffHotspot[]>([])
const blinkSide = ref<'a' | 'b'>('a')
const diffCanvas = ref<HTMLCanvasElement | null>(null)
let cachedImgA: ImageData | null = null
let cachedImgB: ImageData | null = null
let cachedDiffRgba: Uint8ClampedArray | null = null
let cachedW = 0
let cachedH = 0
let blinkTimer: ReturnType<typeof setInterval> | null = null

function stopBlinkTimer(): void {
  if (blinkTimer) {
    clearInterval(blinkTimer)
    blinkTimer = null
  }
}

async function openVisualCompare(): Promise<void> {
  const sess = s.value
  if (!sess) return
  const ctrlA = controllers.get(sess.a)
  const pA = typeof ctrlA?.currentPage === 'function' ? ctrlA.currentPage() : 1
  const mappedB = mapComparedPage(sess.result.pairs, 'a', pA) ?? pA
  visualPageA.value = pA
  visualPageB.value = mappedB
  visualOpen.value = true
  await nextTick()
  await renderVisualPair()
}

function closeVisualCompare(): void {
  stopBlinkTimer()
  visualOpen.value = false
}

async function stepVisualPage(delta: -1 | 1): Promise<void> {
  const sess = s.value
  if (!sess) return
  const docA = documents.get(sess.a)
  const docB = documents.get(sess.b)
  if (!docA || !docB) return
  const nextA = Math.min(Math.max(1, visualPageA.value + delta), docA.numPages)
  const nextB = Math.min(Math.max(1, visualPageB.value + delta), docB.numPages)
  visualPageA.value = nextA
  visualPageB.value = nextB
  await renderVisualPair()
}

async function renderVisualPair(): Promise<void> {
  const sess = s.value
  if (!sess || !visualOpen.value) return
  const docA = documents.get(sess.a)
  const docB = documents.get(sess.b)
  if (!docA || !docB) return
  const pgA = await docA.getPage(Math.min(Math.max(1, visualPageA.value), docA.numPages))
  const pgB = await docB.getPage(Math.min(Math.max(1, visualPageB.value), docB.numPages))
  const vpA = pgA.getViewport({ scale: 1.35 })
  const vpB = pgB.getViewport({ scale: 1.35 })
  const w = Math.max(Math.round(vpA.width), Math.round(vpB.width))
  const h = Math.max(Math.round(vpA.height), Math.round(vpB.height))
  cachedW = w
  cachedH = h

  const cA = document.createElement('canvas')
  cA.width = w
  cA.height = h
  const ctxA = cA.getContext('2d')!
  ctxA.fillStyle = '#ffffff'
  ctxA.fillRect(0, 0, w, h)
  await pgA.render({ canvasContext: ctxA, canvas: cA, viewport: vpA }).promise

  const cB = document.createElement('canvas')
  cB.width = w
  cB.height = h
  const ctxB = cB.getContext('2d')!
  ctxB.fillStyle = '#ffffff'
  ctxB.fillRect(0, 0, w, h)
  await pgB.render({ canvasContext: ctxB, canvas: cB, viewport: vpB }).promise

  cachedImgA = ctxA.getImageData(0, 0, w, h)
  cachedImgB = ctxB.getImageData(0, 0, w, h)
  recomputeAndPaintVisual()
}

function recomputeAndPaintVisual(): void {
  if (!cachedImgA || !cachedImgB || !cachedW || !cachedH) return
  const mode = visualMode.value === 'tint' ? 'tint' : 'anaglyph'
  const res = computeVisualDiff(
    cachedImgA.data,
    cachedW,
    cachedH,
    cachedImgB.data,
    cachedW,
    cachedH,
    {
      mode,
      threshold: 28,
    },
  )
  cachedDiffRgba = res.rgba
  visualDiffRatio.value = res.diffRatio
  visualHotspots.value = res.hotspots
  stopBlinkTimer()
  if (visualMode.value === 'blink') {
    blinkSide.value = 'a'
    paintVisualCanvas()
    blinkTimer = setInterval(() => {
      blinkSide.value = blinkSide.value === 'a' ? 'b' : 'a'
      paintVisualCanvas()
    }, 650)
  } else {
    paintVisualCanvas()
  }
}

function paintVisualCanvas(): void {
  const cvs = diffCanvas.value
  if (!cvs || !cachedW || !cachedH) return
  cvs.width = cachedW
  cvs.height = cachedH
  const ctx = cvs.getContext('2d')
  if (!ctx) return
  if (visualMode.value === 'blink') {
    const src = blinkSide.value === 'a' ? cachedImgA : cachedImgB
    if (src) ctx.putImageData(src, 0, 0)
  } else if (cachedDiffRgba) {
    const img = new ImageData(new Uint8ClampedArray(cachedDiffRgba), cachedW, cachedH)
    ctx.putImageData(img, 0, 0)
    ctx.save()
    ctx.strokeStyle = 'rgba(220, 38, 38, 0.85)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 3])
    for (const hs of visualHotspots.value) {
      ctx.strokeRect(hs.x, hs.y, hs.width, hs.height)
    }
    ctx.restore()
  }
}

watch(visualMode, () => {
  recomputeAndPaintVisual()
})

onBeforeUnmount(() => {
  stopBlinkTimer()
})

function kindLabel(c: CompareChange): string {
  if (c.pageInserted) return t('cmp.pageInserted', { page: c.pageInserted })
  if (c.pageDeleted) return t('cmp.pageDeleted', { page: c.pageDeleted })
  return t(c.kind === 'change' ? 'cmp.changed' : c.kind === 'insert' ? 'cmp.inserted' : 'cmp.deleted')
}

// keep the selected entry in view as next/prev walks the list
watch(compareCurrent, async (i) => {
  await nextTick()
  listEl.value?.querySelector<HTMLElement>(`[data-change-index="${i}"]`)?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <div v-if="s" class="sidebar-body cmp-panel">
    <div class="cmp-head">
      <div class="cmp-docs">
        <div><span class="cmp-tag cmp-tag-a">{{ t('cmp.tagOld') }}</span> <span class="cmp-docname" :title="s.nameA">{{ s.nameA }}</span></div>
        <div><span class="cmp-tag cmp-tag-b">{{ t('cmp.tagNew') }}</span> <span class="cmp-docname" :title="s.nameB">{{ s.nameB }}</span></div>
      </div>
      <div class="cmp-summary">
        <strong>{{ t('cmp.summary', { n: changes.length }) }}</strong>
        <span class="cmp-chip cmp-k-change">{{ t('cmp.changed') }} {{ s.result.stats.changed }}</span>
        <span class="cmp-chip cmp-k-insert">{{ t('cmp.inserted') }} {{ s.result.stats.inserted + s.result.stats.insertedPages }}</span>
        <span class="cmp-chip cmp-k-delete">{{ t('cmp.deleted') }} {{ s.result.stats.deleted + s.result.stats.deletedPages }}</span>
      </div>
      <p v-if="s.result.noTextA.length || s.result.noTextB.length" class="cmp-notext">
        {{ t('cmp.noText') }}
        <template v-if="s.result.noTextA.length"><br />{{ t('cmp.tagOld') }}: p.{{ s.result.noTextA.join(', ') }}</template>
        <template v-if="s.result.noTextB.length"><br />{{ t('cmp.tagNew') }}: p.{{ s.result.noTextB.join(', ') }}</template>
      </p>
      <div class="cmp-nav">
        <button class="cmp-prev" :disabled="!changes.length" :title="t('cmp.prev')" @click="stepChange(-1)">‹ {{ t('cmp.prevShort') }}</button>
        <span class="cmp-pos">{{ compareCurrent >= 0 ? compareCurrent + 1 : '–' }} / {{ changes.length }}</span>
        <button class="cmp-next" :disabled="!changes.length" :title="t('cmp.next')" @click="stepChange(1)">{{ t('cmp.nextShort') }} ›</button>
      </div>
      <div class="cmp-opts">
        <label class="vm-check">
          <input type="checkbox" :checked="pair?.sync" @change="setPairSync(($event.target as HTMLInputElement).checked)" />
          {{ t('cmp.sync') }}
        </label>
        <button class="cmp-end" @click="endCompare()">{{ t('cmp.end') }}</button>
      </div>
      <div class="cmp-visual-bar">
        <button class="cmp-visual-btn" @click="openVisualCompare">
          👁 {{ t('cmp.visualBtn') }}
        </button>
      </div>
    </div>
    <div v-if="!changes.length" class="annot-empty">{{ t('cmp.none') }}</div>
    <div ref="listEl" class="cmp-list">
      <div
        v-for="(c, i) in changes"
        :key="c.id"
        class="cmp-item"
        :class="[`cmp-k-${c.kind}`, { current: i === compareCurrent }]"
        :data-change-index="i"
        @click="gotoChange(i)"
      >
        <div class="cmp-item-meta">
          <span class="cmp-kind">{{ kindLabel(c) }}</span>
          <span class="cmp-pages">p.{{ c.a.page }} → p.{{ c.b.page }}</span>
        </div>
        <div v-if="c.a.text" class="cmp-old">{{ c.a.text }}</div>
        <div v-if="c.b.text" class="cmp-new">{{ c.b.text }}</div>
        <div v-if="!c.a.text && !c.b.text" class="cmp-empty">{{ t('cmp.emptyText') }}</div>
      </div>
    </div>

    <!-- Visual Overlay & Blink Compare Modal -->
    <div v-if="visualOpen" class="modal-mask" @click.self="closeVisualCompare">
      <div class="modal cmp-visual-modal">
        <div class="cmp-v-head">
          <h3>{{ t('cmp.visualTitle') }}</h3>
          <button @click="closeVisualCompare">✕</button>
        </div>
        <div class="cmp-v-controls">
          <div class="cmp-v-modes">
            <button
              :class="{ primary: visualMode === 'anaglyph' }"
              @click="visualMode = 'anaglyph'"
            >
              {{ t('cmp.modeAnaglyph') }}
            </button>
            <button
              :class="{ primary: visualMode === 'tint' }"
              @click="visualMode = 'tint'"
            >
              {{ t('cmp.modeTint') }}
            </button>
            <button
              :class="{ primary: visualMode === 'blink' }"
              @click="visualMode = 'blink'"
            >
              {{ t('cmp.modeBlink') }}
            </button>
          </div>
          <div class="cmp-v-pages">
            <button @click="stepVisualPage(-1)">‹</button>
            <span>p.{{ visualPageA }} ↔ p.{{ visualPageB }}</span>
            <button @click="stepVisualPage(1)">›</button>
          </div>
          <div class="cmp-v-stats">
            <span>
              {{ t('cmp.diffRatio') }}: <strong>{{ (visualDiffRatio * 100).toFixed(2) }}%</strong>
            </span>
            <span>· {{ visualHotspots.length }} {{ t('cmp.hotspots') }}</span>
            <span v-if="visualMode === 'blink'" class="cmp-v-blink-badge">
              {{ t('cmp.blinkShowing') }}
              <strong>{{ blinkSide === 'a' ? t('cmp.tagOld') : t('cmp.tagNew') }}</strong>
            </span>
          </div>
        </div>
        <div class="cmp-v-stage">
          <canvas ref="diffCanvas" class="cmp-v-canvas" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cmp-visual-bar {
  margin-top: 6px;
  display: flex;
}
.cmp-visual-btn {
  width: 100%;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  font-size: 12px;
  cursor: pointer;
}
.cmp-visual-modal {
  width: min(92vw, 960px);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cmp-v-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.cmp-v-head h3 {
  margin: 0;
  font-size: 15px;
}
.cmp-v-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
}
.cmp-v-modes,
.cmp-v-pages {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cmp-v-stats {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cmp-v-stage {
  overflow: auto;
  max-height: 72vh;
  display: flex;
  justify-content: center;
  background: var(--bg-sub, #f3f4f6);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
}
.cmp-v-canvas {
  max-width: 100%;
  height: auto;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
</style>
