<script setup lang="ts">
/**
 * Permanent PDF Page Crop (updates /CropBox & /MediaBox in a copy-out PDF).
 *
 * Includes 1-click Auto-Detect Whitespace that analyzes text bounds (or rendered
 * bitmap ink for scanned pages) across pages, with optional odd/even page
 * asymmetry for book binding margins.
 */
import { computed, ref } from 'vue'
import { computeAutoCropMargins, detectBitmapContentBox, type PageContentBoundsInput } from '@solopdf/core'
import { store, documents, controllers } from '../../store'
import { extractPagesWithGeom } from '../../book/extract'
import { docOps, pickSavePath } from '../../platform/docops'
import { t } from '../../i18n'

const emit = defineEmits<{ toast: [msg: string]; open: [path: string] }>()

const tab = computed(() => store.activeTab)
const doc = computed(() => { void store.docTick; return tab.value ? documents.get(tab.value.id) : undefined })
const ctrl = computed(() => { void store.docTick; return tab.value ? controllers.get(tab.value.id) : undefined })

const busy = ref(false)
const detecting = ref(false)

// [top, right, bottom, left] in PDF points
const topPt = ref(0)
const rightPt = ref(0)
const bottomPt = ref(0)
const leftPt = ref(0)

const useOddEven = ref(false)
const oddMargins = ref<[number, number, number, number]>([0, 0, 0, 0])
const evenMargins = ref<[number, number, number, number]>([0, 0, 0, 0])

const paddingPt = ref(12)
const ignoreHeaderFooter = ref(false)
const pagesText = ref('')

function parsePageList(text: string, total: number): number[] {
  if (!text.trim()) return []
  const out = new Set<number>()
  for (const part of text.split(/[,，]/)) {
    const m = part.trim().match(/^(\d+)(?:\s*[-–~至]\s*(\d+))?$/)
    if (!m) continue
    const a = Math.max(1, Math.min(total, parseInt(m[1], 10)))
    const b = m[2] ? Math.max(1, Math.min(total, parseInt(m[2], 10))) : a
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) out.add(p)
  }
  return [...out].sort((x, y) => x - y)
}

async function autoDetectWhitespace(): Promise<void> {
  const d = doc.value
  if (!d) return
  detecting.value = true
  try {
    const { pages } = await extractPagesWithGeom(d)
    const inputs: PageContentBoundsInput[] = []
    for (const p of pages) {
      if (p.lines.length > 0) {
        inputs.push({
          page: p.page,
          width: p.width,
          height: p.height,
          boxes: p.lines.map((l) => ({ x: l.x, y: l.y, w: l.w, h: l.h })),
        })
      } else if (ctrl.value && inputs.length < 12) {
        // Fallback for scanned pages: sample bitmap ink box at low scale
        const canvas = await ctrl.value.renderToCanvas(p.page, 0.4)
        const ctx = canvas.getContext('2d')
        if (ctx) {
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const box = detectBitmapContentBox(img.data, canvas.width, canvas.height)
          if (box) {
            inputs.push({
              page: p.page,
              width: p.width,
              height: p.height,
              boxes: [box],
            })
          }
        }
      }
    }
    const res = computeAutoCropMargins(inputs, {
      paddingPt: paddingPt.value,
      ignoreHeaderFooter: ignoreHeaderFooter.value,
    })
    ;[topPt.value, rightPt.value, bottomPt.value, leftPt.value] = res.margins
    oddMargins.value = res.oddMargins
    evenMargins.value = res.evenMargins
    emit('toast', t('dt.crop.detected', { n: res.analyzedPages }))
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    detecting.value = false
  }
}

async function applyCrop(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const margins: [number, number, number, number] = [
    Math.max(0, topPt.value),
    Math.max(0, rightPt.value),
    Math.max(0, bottomPt.value),
    Math.max(0, leftPt.value),
  ]
  if (margins.every((m) => m === 0) && !useOddEven.value) {
    emit('toast', t('dt.crop.zeroHint'))
    return
  }
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-cropped.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return

  busy.value = true
  try {
    const out = await docOps.cropPages(src, dest, null, {
      margins,
      odd_margins: useOddEven.value ? oddMargins.value : null,
      even_margins: useOddEven.value ? evenMargins.value : null,
      pages: parsePageList(pagesText.value, tab.value?.numPages ?? 9999),
    })
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
    <h4>{{ t('dt.crop.title') }}</h4>
    <p class="dt-hint">{{ t('dt.crop.hint') }}</p>

    <div class="dt-field">
      <label>{{ t('dt.crop.padding') }}</label>
      <input type="number" min="0" max="72" step="2" v-model.number="paddingPt" />
      <label class="dt-check">
        <input type="checkbox" v-model="ignoreHeaderFooter" />
        {{ t('dt.crop.ignoreHF') }}
      </label>
    </div>

    <div class="dt-actions">
      <button :disabled="detecting || busy" @click="autoDetectWhitespace">
        {{ detecting ? t('dt.working') : t('dt.crop.autoDetect') }}
      </button>
    </div>

    <div class="dt-field">
      <label>{{ t('dt.crop.top') }} (pt)</label>
      <input type="number" min="0" max="300" step="1" v-model.number="topPt" />
      <label>{{ t('dt.crop.bottom') }} (pt)</label>
      <input type="number" min="0" max="300" step="1" v-model.number="bottomPt" />
    </div>

    <div class="dt-field">
      <label>{{ t('dt.crop.left') }} (pt)</label>
      <input type="number" min="0" max="300" step="1" v-model.number="leftPt" />
      <label>{{ t('dt.crop.right') }} (pt)</label>
      <input type="number" min="0" max="300" step="1" v-model.number="rightPt" />
    </div>

    <div class="dt-field">
      <label class="dt-check">
        <input type="checkbox" v-model="useOddEven" />
        {{ t('dt.crop.oddEven') }}
      </label>
    </div>

    <p class="dt-hint" v-if="useOddEven">
      {{ t('dt.crop.oddLabel') }}: {{ oddMargins.join(' / ') }} pt ·
      {{ t('dt.crop.evenLabel') }}: {{ evenMargins.join(' / ') }} pt
    </p>

    <div class="dt-field">
      <label>{{ t('dt.cv.pages') }}</label>
      <input v-model="pagesText" :placeholder="t('dt.cv.pagesPlaceholder')" />
    </div>

    <div class="dt-actions">
      <button class="primary" :disabled="busy || detecting" @click="applyCrop">
        {{ busy ? t('dt.working') : t('dt.crop.apply') }}
      </button>
    </div>
  </div>
</template>
