<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  detectOutlinesFromPages,
  flattenOutlineTree,
  unflattenOutlineTree,
  sanitizeOutlineTree,
  type FlatOutlineItem,
} from '@solopdf/core'
import { store, documents } from '../../store'
import { docOps, pickSavePath } from '../../platform/docops'
import { extractPagesWithGeom } from '../../book/extract'
import { t } from '../../i18n'

const emit = defineEmits<{ open: [path: string]; toast: [msg: string] }>()

const tab = computed(() => store.activeTab)
const items = ref<FlatOutlineItem[]>([])
const detectMode = ref<'auto' | 'fontsize' | 'regex'>('auto')
const customRegex = ref('')
const busy = ref(false)
const detecting = ref(false)
const progress = ref('')

onMounted(async () => {
  const src = tab.value?.path
  if (!src) return
  try {
    const tree = await docOps.getOutlines(src, null)
    items.value = flattenOutlineTree(tree)
  } catch {
    // ignore if encrypted or no outlines
  }
})

async function autoDetect(): Promise<void> {
  const active = tab.value
  if (!active) return
  const doc = documents.get(active.id)
  if (!doc) return
  detecting.value = true
  try {
    const { pages } = await extractPagesWithGeom(doc, (done, total) => {
      progress.value = `${done}/${total}`
    })
    const detected = detectOutlinesFromPages(pages, {
      mode: detectMode.value,
      customRegex: customRegex.value.trim() || undefined,
    })
    const flat = flattenOutlineTree(detected)
    items.value = flat
    emit('toast', t('dt.ol.detected', { n: flat.length }))
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    detecting.value = false
    progress.value = ''
  }
}

function addItem(afterIdx?: number): void {
  const maxPage = tab.value?.numPages ?? 1
  const basePage =
    afterIdx !== undefined && items.value[afterIdx]
      ? items.value[afterIdx].page
      : tab.value?.currentPage ?? 1
  const baseLevel =
    afterIdx !== undefined && items.value[afterIdx]
      ? items.value[afterIdx].level
      : 1
  const newItem: FlatOutlineItem = {
    title: t('dt.ol.newItemTitle'),
    page: Math.max(1, Math.min(maxPage, basePage)),
    level: baseLevel,
  }
  if (afterIdx === undefined) {
    items.value.push(newItem)
  } else {
    items.value.splice(afterIdx + 1, 0, newItem)
  }
}

function removeItem(idx: number): void {
  items.value.splice(idx, 1)
}

function moveItem(idx: number, delta: -1 | 1): void {
  const target = idx + delta
  if (target < 0 || target >= items.value.length) return
  const copy = [...items.value]
  const [moved] = copy.splice(idx, 1)
  copy.splice(target, 0, moved)
  items.value = copy
}

function changeLevel(idx: number, delta: -1 | 1): void {
  const it = items.value[idx]
  if (!it) return
  it.level = Math.max(1, Math.min(4, it.level + delta))
}

async function apply(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const maxPage = tab.value?.numPages ?? 1
  const suggested = src.replace(/\.pdf$/i, '') + '-outlines.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = true
  try {
    const tree = sanitizeOutlineTree(unflattenOutlineTree(items.value), maxPage)
    const out = await docOps.setOutlines(src, dest, null, tree)
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="dt-panel">
    <p class="dt-hint">{{ t('dt.ol.hint') }}</p>

    <div class="dt-form">
      <label class="dt-field">
        <span>{{ t('dt.ol.mode') }}</span>
        <select v-model="detectMode">
          <option value="auto">{{ t('dt.ol.modeAuto') }}</option>
          <option value="fontsize">{{ t('dt.ol.modeFont') }}</option>
          <option value="regex">{{ t('dt.ol.modeRegex') }}</option>
        </select>
      </label>
      <label class="dt-field" v-if="detectMode === 'regex'">
        <span>{{ t('dt.ol.regex') }}</span>
        <input v-model="customRegex" :placeholder="t('dt.ol.regexPh')" />
      </label>
    </div>

    <div class="dt-Sub-toolbar">
      <button class="primary" :disabled="detecting || busy" @click="autoDetect">
        {{ detecting ? `${t('dt.ol.detecting')} ${progress}` : t('dt.ol.detectBtn') }}
      </button>
      <button :disabled="busy" @click="addItem()">+ {{ t('dt.ol.add') }}</button>
      <button v-if="items.length" :disabled="busy" @click="items = []">{{ t('dt.ol.clear') }}</button>
    </div>

    <div v-if="!items.length" class="dt-empty">
      {{ t('dt.ol.empty') }}
    </div>

    <div v-else class="ol-list">
      <div
        v-for="(it, idx) in items"
        :key="idx"
        class="ol-row"
        :style="{ paddingLeft: (it.level - 1) * 18 + 8 + 'px' }"
      >
        <span class="ol-lvl">L{{ it.level }}</span>
        <input
          class="ol-title"
          v-model="it.title"
          :placeholder="t('dt.ol.titlePh')"
        />
        <label class="ol-page-lbl">
          <span>P.</span>
          <input
            type="number"
            class="ol-page"
            v-model.number="it.page"
            min="1"
            :max="tab?.numPages ?? 9999"
          />
        </label>
        <div class="ol-actions">
          <button :disabled="it.level <= 1" @click="changeLevel(idx, -1)" :title="t('dt.ol.outdent')">←</button>
          <button :disabled="it.level >= 4" @click="changeLevel(idx, 1)" :title="t('dt.ol.indent')">→</button>
          <button :disabled="idx === 0" @click="moveItem(idx, -1)" :title="t('dt.ol.moveUp')">↑</button>
          <button :disabled="idx === items.length - 1" @click="moveItem(idx, 1)" :title="t('dt.ol.moveDown')">↓</button>
          <button @click="addItem(idx)" :title="t('dt.ol.add')">+</button>
          <button @click="removeItem(idx)" :title="t('dt.ol.delete')">✕</button>
        </div>
      </div>
    </div>

    <div class="dt-footer">
      <span class="dt-hint-inline">{{ t('dt.ol.count', { n: items.length }) }}</span>
      <button class="primary" :disabled="busy || detecting" @click="apply">
        {{ busy ? t('dt.working') : t('dt.ol.exportBtn') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ol-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  background: var(--bg);
}
.ol-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ol-lvl {
  font-size: 11px;
  color: var(--fg-dim);
  min-width: 20px;
}
.ol-title {
  flex: 1;
  min-width: 120px;
}
.ol-page-lbl {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--fg-dim);
}
.ol-page {
  width: 58px;
  text-align: center;
}
.ol-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.ol-actions button {
  padding: 2px 6px;
  font-size: 12px;
}
</style>
