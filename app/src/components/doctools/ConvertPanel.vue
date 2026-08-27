<script setup lang="ts">
/**
 * PDF → images, images → PDF, and shrink-this-file.
 *
 * Page rendering happens in the WebView (pdf.js is already there and is the
 * same engine that drew the page you are looking at); only the PDF writing
 * side goes to Rust. That keeps "export at 300 dpi" honest — what you export
 * is what you saw.
 */
import { computed, ref } from 'vue'
import { store, controllers } from '../../store'
import { docOps, mobileNoDialogs, pickDirectory, pickOpenPaths, pickSavePath } from '../../platform/docops'
import { t } from '../../i18n'

const emit = defineEmits<{ toast: [msg: string]; open: [path: string] }>()

const tab = computed(() => store.activeTab)
const ctrl = computed(() => { void store.docTick; return tab.value ? controllers.get(tab.value.id) : undefined })
const busy = ref(false)
const progress = ref({ done: 0, total: 0 })

// ── PDF → images ──
const dpi = ref(150)
const format = ref<'png' | 'jpeg'>('png')
const rangeText = ref('')

function parsePages(text: string, total: number): number[] {
  if (!text.trim()) return Array.from({ length: total }, (_, i) => i + 1)
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

async function exportImages(): Promise<void> {
  const c = ctrl.value
  const src = tab.value
  if (!c || !src) return
  const pages = parsePages(rangeText.value, src.numPages)
  if (!pages.length) {
    emit('toast', t('dt.cv.noPages'))
    return
  }
  const dir = mobileNoDialogs() ? null : await pickDirectory()
  if (!mobileNoDialogs() && !dir) return
  busy.value = true
  progress.value = { done: 0, total: pages.length }
  const stem = (src.name ?? 'page').replace(/\.pdf$/i, '')
  try {
    for (const p of pages) {
      const canvas = await c.renderToCanvas(p, dpi.value / 72)
      const blob = await new Promise<Blob | null>((r) =>
        canvas.toBlob(r, format.value === 'png' ? 'image/png' : 'image/jpeg', 0.9),
      )
      if (!blob) continue
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const name = `${stem}-${String(p).padStart(3, '0')}.${format.value === 'png' ? 'png' : 'jpg'}`
      // reuse the signature writer's raw-body path? no — images belong beside
      // the document, so go through the generic save
      await saveBytes(dir ? `${dir}/${name}` : null, name, bytes)
      progress.value = { ...progress.value, done: progress.value.done + 1 }
    }
    emit('toast', t('dt.cv.exported', { n: pages.length }))
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}

/** raw-body write; null dest = app Documents folder (mobile) */
async function saveBytes(dest: string | null, name: string, bytes: Uint8Array): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  if (dest) {
    await invoke('save_pdf_bytes', bytes, { headers: { 'x-dest': encodeURIComponent(dest) } })
  } else {
    await invoke('save_bytes_to_documents', bytes, { headers: { 'x-name': encodeURIComponent(name) } })
  }
}

// ── images → PDF ──
const imageList = ref<string[]>([])
const imageDpi = ref(150)

async function pickImages(): Promise<void> {
  const picked = await pickOpenPaths(['png', 'jpg', 'jpeg'])
  if (picked.length) imageList.value = [...imageList.value, ...picked]
}

async function buildPdf(): Promise<void> {
  if (!imageList.value.length) return
  const dest = await pickSavePath('images.pdf', 'pdf')
  if (dest === undefined) return
  busy.value = true
  try {
    const out = await docOps.fromImages(imageList.value, dest, imageDpi.value)
    emit('toast', t('dt.saved', { file: out.split('/').pop() ?? out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}

// ── compress ──
const maxDim = ref(1600)
const quality = ref(72)
const result = ref<{ before: number; after: number } | null>(null)

const fmtSize = (n: number): string =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`

async function compress(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-compressed.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = true
  result.value = null
  try {
    const r = await docOps.compress(src, dest, null, maxDim.value, quality.value)
    result.value = { before: r.before, after: r.after }
    emit('toast', t('dt.saved', { file: r.path.split('/').pop() ?? r.path }))
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="dt-section">
    <h4>{{ t('dt.cv.toImages') }}</h4>
    <div class="dt-field">
      <label>{{ t('dt.cv.pages') }}</label>
      <input v-model="rangeText" :placeholder="t('dt.cv.pagesPlaceholder')" />
    </div>
    <div class="dt-field">
      <label>{{ t('dt.cv.dpi') }}</label>
      <input type="number" min="72" max="600" step="6" v-model.number="dpi" />
      <select v-model="format">
        <option value="png">PNG</option>
        <option value="jpeg">JPEG</option>
      </select>
    </div>
    <div class="dt-actions">
      <button class="primary" :disabled="busy" @click="exportImages">
        {{ busy && progress.total ? `${progress.done}/${progress.total}` : t('dt.cv.doExport') }}
      </button>
    </div>

    <h4>{{ t('dt.cv.fromImages') }}</h4>
    <div class="dt-list" v-if="imageList.length">
      <div v-for="(p, i) in imageList" :key="p + i" class="dt-list-row">
        <span class="dt-list-idx">{{ i + 1 }}</span>
        <span class="dt-list-name" :title="p">{{ p.split('/').pop() }}</span>
        <button @click="imageList = imageList.filter((_, j) => j !== i)">✕</button>
      </div>
    </div>
    <div class="dt-field">
      <label>{{ t('dt.cv.dpi') }}</label>
      <input type="number" min="72" max="600" step="6" v-model.number="imageDpi" />
    </div>
    <div class="dt-actions">
      <button @click="pickImages">{{ t('dt.cv.pickImages') }}</button>
      <button class="primary" :disabled="busy || !imageList.length" @click="buildPdf">
        {{ t('dt.cv.doBuild') }}
      </button>
    </div>

    <h4>{{ t('dt.cv.compress') }}</h4>
    <p class="dt-hint">{{ t('dt.cv.compressHint') }}</p>
    <div class="dt-field">
      <label>{{ t('dt.cv.maxDim') }}</label>
      <input type="number" min="400" max="4000" step="100" v-model.number="maxDim" />
    </div>
    <div class="dt-field">
      <label>{{ t('dt.cv.quality') }}</label>
      <input type="range" min="40" max="95" step="1" v-model.number="quality" />
      <span class="vm-val">{{ quality }}</span>
    </div>
    <p class="dt-hint" v-if="result">
      {{ fmtSize(result.before) }} → {{ fmtSize(result.after) }}
      ({{ Math.round((1 - result.after / Math.max(1, result.before)) * 100) }}%)
    </p>
    <div class="dt-actions">
      <button class="primary" :disabled="busy" @click="compress">
        {{ busy ? t('dt.working') : t('dt.cv.doCompress') }}
      </button>
    </div>
  </div>
</template>
