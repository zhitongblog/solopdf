<script setup lang="ts">
import { computed, ref } from 'vue'
import { store } from '../../store'
import { docOps, pickOpenPaths, pickSavePath } from '../../platform/docops'
import { t } from '../../i18n'

const emit = defineEmits<{ open: [path: string]; toast: [msg: string] }>()

const tab = computed(() => store.activeTab)
const busy = ref('')

// ── N-up ──
const nupGrid = ref<'2x1' | '2x2' | '2x3' | '3x3' | '4x4'>('2x2')
const nupOrient = ref<'auto' | 'portrait' | 'landscape'>('auto')
const nupMargin = ref(18)
const nupGap = ref(12)
const nupBorder = ref(false)

async function runNup(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const [cols, rows] = nupGrid.value.split('x').map((n) => parseInt(n, 10))
  const suggested = src.replace(/\.pdf$/i, '') + `-${nupGrid.value}up.pdf`
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = 'nup'
  try {
    const landscape =
      nupOrient.value === 'auto' ? null : nupOrient.value === 'landscape'
    const out = await docOps.nup(src, dest, null, {
      cols,
      rows,
      landscape,
      margin: nupMargin.value,
      gap: nupGap.value,
      border: nupBorder.value,
    })
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = ''
  }
}

// ── Booklet ──
const bookletBorder = ref(false)

async function runBooklet(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const suggested = src.replace(/\.pdf$/i, '') + '-booklet.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = 'booklet'
  try {
    const out = await docOps.booklet(src, dest, null, bookletBorder.value)
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = ''
  }
}

// ── Normalize Page Size ──
const PAGE_PRESETS: Record<string, { label: string; w: number; h: number }> = {
  A4: { label: 'A4 (595×842 pt)', w: 595.28, h: 841.89 },
  A3: { label: 'A3 (842×1191 pt)', w: 841.89, h: 1190.55 },
  Letter: { label: 'Letter (612×792 pt)', w: 612, h: 792 },
  Legal: { label: 'Legal (612×1008 pt)', w: 612, h: 1008 },
}
const sizePreset = ref<'A4' | 'A3' | 'Letter' | 'Legal'>('A4')

async function runResize(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const preset = PAGE_PRESETS[sizePreset.value]
  const suggested = src.replace(/\.pdf$/i, '') + `-${sizePreset.value.toLowerCase()}.pdf`
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = 'resize'
  try {
    const out = await docOps.resizePages(src, dest, null, preset.w, preset.h)
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = ''
  }
}

// ── Grayscale & Scan Clean ──
const whitenBg = ref(true)

async function runGrayscale(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const suggested = src.replace(/\.pdf$/i, '') + '-grayscale.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = 'grayscale'
  try {
    const out = await docOps.grayscale(src, dest, null, whitenBg.value)
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = ''
  }
}

// ── 5. Split 2-up Spreads (De-nup) ──
const splitDir = ref<'vertical' | 'horizontal'>('vertical')
const splitOnlyWide = ref(true)
const splitRtl = ref(false)
const splitOverlap = ref(4)

async function runSplit2up(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const suggested = src.replace(/\.pdf$/i, '') + '-split2up.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = 'split2up'
  try {
    const out = await docOps.split2up(src, dest, null, {
      direction: splitDir.value,
      only_wide: splitOnlyWide.value,
      rtl: splitRtl.value,
      overlap: splitOverlap.value,
    })
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = ''
  }
}

// ── 6. Single Continuous Large Page ──
const singleGap = ref(16)
const singleBorder = ref(true)

async function runSinglePage(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const suggested = src.replace(/\.pdf$/i, '') + '-singlepage.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = 'singlepage'
  try {
    const out = await docOps.singleLargePage(
      src,
      dest,
      null,
      singleGap.value,
      singleBorder.value,
    )
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = ''
  }
}

// ── 7. Vector Overlay PDF (Letterhead / Background / Stamp PDF) ──
const overlayPath = ref('')
const overlayUnder = ref(true)
const overlayRepeat = ref(true)

async function pickOverlayPdf(): Promise<void> {
  const picked = await pickOpenPaths(['pdf'], false)
  if (picked.length) overlayPath.value = picked[0]
}

async function runOverlay(): Promise<void> {
  const src = tab.value?.path
  if (!src || !overlayPath.value) return
  const suggested = src.replace(/\.pdf$/i, '') + '-overlay.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = 'overlay'
  try {
    const out = await docOps.overlay(
      src,
      dest,
      null,
      overlayPath.value,
      null,
      overlayUnder.value,
      overlayRepeat.value,
    )
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="dt-panel">
    <p class="dt-hint">{{ t('dt.ly.hint') }}</p>

    <!-- 1. N-up -->
    <div class="ly-card">
      <div class="ly-head">
        <h4>{{ t('dt.ly.nupTitle') }}</h4>
        <span class="dt-sub">{{ t('dt.ly.nupSub') }}</span>
      </div>
      <div class="dt-form">
        <label class="dt-field">
          <span>{{ t('dt.ly.grid') }}</span>
          <select v-model="nupGrid">
            <option value="2x1">2x1 (2 {{ t('dt.ly.perSheet') }})</option>
            <option value="2x2">2x2 (4 {{ t('dt.ly.perSheet') }})</option>
            <option value="2x3">2x3 (6 {{ t('dt.ly.perSheet') }})</option>
            <option value="3x3">3x3 (9 {{ t('dt.ly.perSheet') }})</option>
            <option value="4x4">4x4 (16 {{ t('dt.ly.perSheet') }})</option>
          </select>
        </label>
        <label class="dt-field">
          <span>{{ t('dt.ly.orientation') }}</span>
          <select v-model="nupOrient">
            <option value="auto">{{ t('dt.ly.orientAuto') }}</option>
            <option value="portrait">{{ t('dt.ly.orientPortrait') }}</option>
            <option value="landscape">{{ t('dt.ly.orientLandscape') }}</option>
          </select>
        </label>
        <div class="ly-inline-fields">
          <label class="dt-field">
            <span>{{ t('dt.ly.margin') }} (pt)</span>
            <input type="number" v-model.number="nupMargin" min="0" max="100" />
          </label>
          <label class="dt-field">
            <span>{{ t('dt.ly.gap') }} (pt)</span>
            <input type="number" v-model.number="nupGap" min="0" max="80" />
          </label>
        </div>
        <label class="ly-check">
          <input type="checkbox" v-model="nupBorder" />
          <span>{{ t('dt.ly.border') }}</span>
        </label>
      </div>
      <div class="ly-actions">
        <button class="primary" :disabled="!!busy" @click="runNup">
          {{ busy === 'nup' ? t('dt.working') : t('dt.ly.nupBtn') }}
        </button>
      </div>
    </div>

    <!-- 2. Booklet -->
    <div class="ly-card">
      <div class="ly-head">
        <h4>{{ t('dt.ly.bookletTitle') }}</h4>
        <span class="dt-sub">{{ t('dt.ly.bookletSub') }}</span>
      </div>
      <label class="ly-check">
        <input type="checkbox" v-model="bookletBorder" />
        <span>{{ t('dt.ly.border') }}</span>
      </label>
      <div class="ly-actions">
        <button class="primary" :disabled="!!busy" @click="runBooklet">
          {{ busy === 'booklet' ? t('dt.working') : t('dt.ly.bookletBtn') }}
        </button>
      </div>
    </div>

    <!-- 3. Normalize Page Size -->
    <div class="ly-card">
      <div class="ly-head">
        <h4>{{ t('dt.ly.resizeTitle') }}</h4>
        <span class="dt-sub">{{ t('dt.ly.resizeSub') }}</span>
      </div>
      <div class="dt-form">
        <label class="dt-field">
          <span>{{ t('dt.ly.paperSize') }}</span>
          <select v-model="sizePreset">
            <option v-for="(spec, k) in PAGE_PRESETS" :key="k" :value="k">
              {{ spec.label }}
            </option>
          </select>
        </label>
      </div>
      <div class="ly-actions">
        <button class="primary" :disabled="!!busy" @click="runResize">
          {{ busy === 'resize' ? t('dt.working') : t('dt.ly.resizeBtn') }}
        </button>
      </div>
    </div>

    <!-- 4. Grayscale & Scan Clean -->
    <div class="ly-card">
      <div class="ly-head">
        <h4>{{ t('dt.ly.grayTitle') }}</h4>
        <span class="dt-sub">{{ t('dt.ly.graySub') }}</span>
      </div>
      <label class="ly-check">
        <input type="checkbox" v-model="whitenBg" />
        <span>{{ t('dt.ly.whitenBg') }}</span>
      </label>
      <div class="ly-actions">
        <button class="primary" :disabled="!!busy" @click="runGrayscale">
          {{ busy === 'grayscale' ? t('dt.working') : t('dt.ly.grayBtn') }}
        </button>
      </div>
    </div>

    <!-- 5. Split 2-up Spreads (De-nup) -->
    <div class="ly-card">
      <div class="ly-head">
        <h4>{{ t('dt.ly.split2upTitle') }}</h4>
        <span class="dt-sub">{{ t('dt.ly.split2upSub') }}</span>
      </div>
      <div class="dt-form">
        <div class="ly-inline-fields">
          <label class="dt-field">
            <span>{{ t('dt.ly.splitDir') }}</span>
            <select v-model="splitDir">
              <option value="vertical">{{ t('dt.ly.splitVertical') }}</option>
              <option value="horizontal">{{ t('dt.ly.splitHorizontal') }}</option>
            </select>
          </label>
          <label class="dt-field">
            <span>{{ t('dt.ly.splitOverlap') }} (pt)</span>
            <input type="number" v-model.number="splitOverlap" min="0" max="60" />
          </label>
        </div>
        <label class="ly-check">
          <input type="checkbox" v-model="splitOnlyWide" />
          <span>{{ t('dt.ly.splitOnlyWide') }}</span>
        </label>
        <label class="ly-check">
          <input type="checkbox" v-model="splitRtl" />
          <span>{{ t('dt.ly.splitRtl') }}</span>
        </label>
      </div>
      <div class="ly-actions">
        <button class="primary" :disabled="!!busy" @click="runSplit2up">
          {{ busy === 'split2up' ? t('dt.working') : t('dt.ly.split2upBtn') }}
        </button>
      </div>
    </div>

    <!-- 6. Single Continuous Large Page -->
    <div class="ly-card">
      <div class="ly-head">
        <h4>{{ t('dt.ly.singleTitle') }}</h4>
        <span class="dt-sub">{{ t('dt.ly.singleSub') }}</span>
      </div>
      <div class="dt-form">
        <label class="dt-field">
          <span>{{ t('dt.ly.gap') }} (pt)</span>
          <input type="number" v-model.number="singleGap" min="0" max="120" />
        </label>
        <label class="ly-check">
          <input type="checkbox" v-model="singleBorder" />
          <span>{{ t('dt.ly.singleBorder') }}</span>
        </label>
      </div>
      <div class="ly-actions">
        <button class="primary" :disabled="!!busy" @click="runSinglePage">
          {{ busy === 'singlepage' ? t('dt.working') : t('dt.ly.singleBtn') }}
        </button>
      </div>
    </div>

    <!-- 7. Vector Overlay PDF (Letterhead / Stationery) -->
    <div class="ly-card">
      <div class="ly-head">
        <h4>{{ t('dt.ly.overlayTitle') }}</h4>
        <span class="dt-sub">{{ t('dt.ly.overlaySub') }}</span>
      </div>
      <div class="dt-form">
        <div class="dt-actions">
          <button @click="pickOverlayPdf">{{ t('dt.ly.overlayPick') }}</button>
          <span class="dt-sub" v-if="overlayPath">{{ overlayPath.split('/').pop() }}</span>
        </div>
        <label class="ly-check">
          <input type="checkbox" v-model="overlayUnder" />
          <span>{{ t('dt.ly.overlayUnder') }}</span>
        </label>
        <label class="ly-check">
          <input type="checkbox" v-model="overlayRepeat" />
          <span>{{ t('dt.ly.overlayRepeat') }}</span>
        </label>
      </div>
      <div class="ly-actions">
        <button class="primary" :disabled="!!busy || !overlayPath" @click="runOverlay">
          {{ busy === 'overlay' ? t('dt.working') : t('dt.ly.overlayBtn') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ly-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 10px;
}
.ly-head h4 {
  margin: 0 0 2px;
  font-size: 13.5px;
}
.ly-inline-fields {
  display: flex;
  gap: 10px;
}
.ly-inline-fields .dt-field {
  flex: 1;
}
.ly-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  cursor: pointer;
}
.ly-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
