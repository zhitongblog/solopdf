<script setup lang="ts">
/**
 * Watermark & Page Numbers / Bates Numbering panel.
 *
 * All operations follow SoloPDF's copy-out rule: writes a new PDF and leaves
 * the source untouched.
 */
import { computed, ref } from 'vue'
import { colorTriple } from '@solopdf/core'
import { store } from '../../store'
import { docOps, pickOpenPaths, pickSavePath } from '../../platform/docops'
import { t } from '../../i18n'

const emit = defineEmits<{ toast: [msg: string]; open: [path: string] }>()

const tab = computed(() => store.activeTab)
const busy = ref(false)

// ── Watermark state ──
const wmKind = ref<'text' | 'image'>('text')
const wmText = ref('CONFIDENTIAL / 机密')
const wmImagePath = ref('')
const wmPosition = ref('tile')
const wmFontSize = ref(42)
const wmColorHex = ref('#595959')
const wmOpacity = ref(0.22)
const wmRotate = ref(45)
const wmSpacing = ref(220)
const wmScale = ref(0.35)
const wmUnder = ref(false)
const wmPagesText = ref('')

const PRESETS = ['机密', '内部资料', '草稿 DRAFT', '样本 SAMPLE', '禁止外传']

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

async function pickWmImage(): Promise<void> {
  const picked = await pickOpenPaths(['png'], false)
  if (picked.length) wmImagePath.value = picked[0]
}

async function applyWatermark(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  if (wmKind.value === 'text' && !wmText.value.trim()) {
    emit('toast', t('dt.wm.needText'))
    return
  }
  if (wmKind.value === 'image' && !wmImagePath.value) {
    emit('toast', t('dt.wm.needImage'))
    return
  }
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-watermarked.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return

  busy.value = true
  try {
    const out = await docOps.watermark(
      src,
      dest,
      null,
      {
        text: wmKind.value === 'text' ? wmText.value.trim() : '',
        font_size: wmFontSize.value,
        color: colorTriple(wmColorHex.value),
        opacity: wmOpacity.value,
        rotate: wmRotate.value,
        position: wmPosition.value,
        tile_spacing: wmSpacing.value,
        scale: wmScale.value,
        under: wmUnder.value,
        pages: parsePageList(wmPagesText.value, tab.value?.numPages ?? 9999),
      },
      wmKind.value === 'image' ? wmImagePath.value : null,
    )
    emit('toast', t('dt.saved', { file: out.split('/').pop() ?? out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}

// ── Page Numbers / Bates state ──
const pnFormat = ref('{n} / {total}')
const pnPosition = ref('bottom-center')
const pnStartNumber = ref(1)
const pnFromPage = ref(1)
const pnToPage = ref(0)
const pnFontSize = ref(10)
const pnMargin = ref(28)
const pnColorHex = ref('#404040')

const FORMAT_PRESETS = [
  { label: '1 / 10', val: '{n} / {total}' },
  { label: '1', val: '{n}' },
  { label: '第 1 页', val: '第 {n} 页' },
  { label: '第 1 / 10 页', val: '第 {n} / {total} 页' },
  { label: 'Bates (DOC-000001)', val: 'DOC-{n:06}' },
]

async function applyPageNumbers(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-numbered.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return

  busy.value = true
  try {
    const out = await docOps.addPageNumbers(src, dest, null, {
      format: pnFormat.value || '{n}',
      position: pnPosition.value,
      start_number: Math.max(1, pnStartNumber.value),
      from_page: Math.max(1, pnFromPage.value),
      to_page: Math.max(0, pnToPage.value),
      font_size: pnFontSize.value,
      margin: pnMargin.value,
      color: colorTriple(pnColorHex.value),
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
    <h4>{{ t('dt.wm.title') }}</h4>
    <p class="dt-hint">{{ t('dt.wm.hint') }}</p>

    <div class="vm-seg">
      <button :class="{ active: wmKind === 'text' }" @click="wmKind = 'text'">{{ t('dt.wm.kindText') }}</button>
      <button :class="{ active: wmKind === 'image' }" @click="wmKind = 'image'">{{ t('dt.wm.kindImage') }}</button>
    </div>

    <template v-if="wmKind === 'text'">
      <div class="dt-field">
        <label>{{ t('dt.wm.text') }}</label>
        <input v-model="wmText" :placeholder="t('dt.wm.textPlaceholder')" />
      </div>
      <div class="dt-actions">
        <button v-for="p in PRESETS" :key="p" @click="wmText = p">{{ p }}</button>
      </div>
      <div class="dt-field">
        <label>{{ t('dt.wm.fontSize') }}</label>
        <input type="number" min="10" max="160" v-model.number="wmFontSize" />
        <label>{{ t('dr.color') }}</label>
        <input type="color" v-model="wmColorHex" />
      </div>
    </template>

    <template v-else>
      <div class="dt-field">
        <label>{{ t('dt.wm.imageFile') }}</label>
        <span class="dt-list-name" v-if="wmImagePath">{{ wmImagePath.split('/').pop() }}</span>
        <button @click="pickWmImage">{{ t('dt.sg.import') }}</button>
      </div>
      <div class="dt-field">
        <label>{{ t('dt.wm.scale') }}</label>
        <input type="range" min="0.1" max="0.9" step="0.05" v-model.number="wmScale" />
        <span class="vm-val">{{ Math.round(wmScale * 100) }}%</span>
      </div>
    </template>

    <div class="dt-field">
      <label>{{ t('dt.wm.position') }}</label>
      <select v-model="wmPosition">
        <option value="tile">{{ t('dt.wm.posTile') }}</option>
        <option value="center">{{ t('dt.wm.posCenter') }}</option>
        <option value="top-left">{{ t('dt.wm.posTL') }}</option>
        <option value="top-center">{{ t('dt.wm.posTC') }}</option>
        <option value="top-right">{{ t('dt.wm.posTR') }}</option>
        <option value="bottom-left">{{ t('dt.wm.posBL') }}</option>
        <option value="bottom-center">{{ t('dt.wm.posBC') }}</option>
        <option value="bottom-right">{{ t('dt.wm.posBR') }}</option>
      </select>
    </div>

    <div class="dt-field" v-if="wmPosition === 'tile'">
      <label>{{ t('dt.wm.spacing') }}</label>
      <input type="number" min="80" max="500" step="10" v-model.number="wmSpacing" />
    </div>

    <div class="dt-field">
      <label>{{ t('dt.wm.opacity') }}</label>
      <input type="range" min="0.05" max="1" step="0.02" v-model.number="wmOpacity" />
      <span class="vm-val">{{ Math.round(wmOpacity * 100) }}%</span>
    </div>

    <div class="dt-field">
      <label>{{ t('dt.wm.rotate') }}</label>
      <input type="number" min="-180" max="180" step="5" v-model.number="wmRotate" />
      <label class="dt-check">
        <input type="checkbox" v-model="wmUnder" />
        {{ t('dt.wm.under') }}
      </label>
    </div>

    <div class="dt-field">
      <label>{{ t('dt.cv.pages') }}</label>
      <input v-model="wmPagesText" :placeholder="t('dt.cv.pagesPlaceholder')" />
    </div>

    <div class="dt-actions">
      <button class="primary" :disabled="busy" @click="applyWatermark">
        {{ busy ? t('dt.working') : t('dt.wm.apply') }}
      </button>
    </div>

    <h4>{{ t('dt.pn.title') }}</h4>
    <p class="dt-hint">{{ t('dt.pn.hint') }}</p>

    <div class="dt-field">
      <label>{{ t('dt.pn.format') }}</label>
      <input v-model="pnFormat" />
    </div>
    <div class="dt-actions">
      <button v-for="fp in FORMAT_PRESETS" :key="fp.val" @click="pnFormat = fp.val">{{ fp.label }}</button>
    </div>

    <div class="dt-field">
      <label>{{ t('dt.wm.position') }}</label>
      <select v-model="pnPosition">
        <option value="bottom-center">{{ t('dt.wm.posBC') }}</option>
        <option value="bottom-right">{{ t('dt.wm.posBR') }}</option>
        <option value="bottom-left">{{ t('dt.wm.posBL') }}</option>
        <option value="bottom-outside">{{ t('dt.pn.posBottomOut') }}</option>
        <option value="top-center">{{ t('dt.wm.posTC') }}</option>
        <option value="top-right">{{ t('dt.wm.posTR') }}</option>
        <option value="top-left">{{ t('dt.wm.posTL') }}</option>
        <option value="top-outside">{{ t('dt.pn.posTopOut') }}</option>
      </select>
    </div>

    <div class="dt-field">
      <label>{{ t('dt.pn.fromPage') }}</label>
      <input type="number" min="1" :max="tab?.numPages ?? 9999" v-model.number="pnFromPage" />
      <label>{{ t('dt.pn.startNum') }}</label>
      <input type="number" min="1" v-model.number="pnStartNumber" />
    </div>

    <div class="dt-field">
      <label>{{ t('dt.wm.fontSize') }}</label>
      <input type="number" min="6" max="36" v-model.number="pnFontSize" />
      <label>{{ t('dt.pn.margin') }}</label>
      <input type="number" min="8" max="120" v-model.number="pnMargin" />
      <input type="color" v-model="pnColorHex" />
    </div>

    <div class="dt-actions">
      <button class="primary" :disabled="busy" @click="applyPageNumbers">
        {{ busy ? t('dt.working') : t('dt.pn.apply') }}
      </button>
    </div>
  </div>
</template>
