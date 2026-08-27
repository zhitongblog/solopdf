<script setup lang="ts">
/**
 * Merge several PDFs into one, or split this one into parts.
 *
 * Split accepts either explicit ranges ("1-3, 4-10, 11") or "every N pages",
 * because those are the two ways people actually describe the job.
 */
import { computed, ref } from 'vue'
import { store } from '../../store'
import { docOps, pickDirectory, pickOpenPaths, pickSavePath } from '../../platform/docops'
import { t } from '../../i18n'

const emit = defineEmits<{ toast: [msg: string]; open: [path: string] }>()

const tab = computed(() => store.activeTab)
const busy = ref(false)

// ── merge ──
const mergeList = ref<string[]>([])
function initMergeList(): void {
  if (!mergeList.value.length && tab.value) mergeList.value = [tab.value.path]
}
initMergeList()

async function addFiles(): Promise<void> {
  const picked = await pickOpenPaths(['pdf'])
  if (picked.length) mergeList.value = [...mergeList.value, ...picked]
}
function removeAt(i: number): void {
  mergeList.value = mergeList.value.filter((_, j) => j !== i)
}
function moveAt(i: number, dir: -1 | 1): void {
  const j = i + dir
  if (j < 0 || j >= mergeList.value.length) return
  const next = [...mergeList.value]
  ;[next[i], next[j]] = [next[j], next[i]]
  mergeList.value = next
}

async function doMerge(): Promise<void> {
  if (mergeList.value.length < 2) {
    emit('toast', t('dt.ms.needTwo'))
    return
  }
  const dest = await pickSavePath('merged.pdf', 'pdf')
  if (dest === undefined) return
  busy.value = true
  try {
    const out = await docOps.merge(mergeList.value, dest)
    emit('toast', t('dt.saved', { file: out.split('/').pop() ?? out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}

// ── split ──
const mode = ref<'ranges' | 'every'>('ranges')
const rangeText = ref('')
const everyN = ref(10)

/** "1-3, 5, 8-12" → [[1,3],[5,5],[8,12]], clamped to the document */
function parseRanges(text: string, total: number): [number, number][] {
  const out: [number, number][] = []
  for (const part of text.split(/[,，]/)) {
    const m = part.trim().match(/^(\d+)(?:\s*[-–~至]\s*(\d+))?$/)
    if (!m) continue
    const from = Math.max(1, Math.min(total, parseInt(m[1], 10)))
    const to = m[2] ? Math.max(1, Math.min(total, parseInt(m[2], 10))) : from
    out.push(from <= to ? [from, to] : [to, from])
  }
  return out
}

const previewRanges = computed<[number, number][]>(() => {
  const total = tab.value?.numPages ?? 0
  if (!total) return []
  if (mode.value === 'every') {
    const n = Math.max(1, Math.floor(everyN.value))
    const out: [number, number][] = []
    for (let p = 1; p <= total; p += n) out.push([p, Math.min(total, p + n - 1)])
    return out
  }
  return parseRanges(rangeText.value, total)
})

async function doSplit(): Promise<void> {
  const src = tab.value?.path
  const ranges = previewRanges.value
  if (!src || !ranges.length) {
    emit('toast', t('dt.ms.noRanges'))
    return
  }
  const dir = await pickDirectory()
  busy.value = true
  try {
    const files = await docOps.split(src, dir, null, ranges)
    emit('toast', t('dt.ms.splitDone', { n: files.length, dir: files[0]?.split('/').slice(0, -1).pop() ?? '' }))
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="dt-section">
    <h4>{{ t('dt.ms.merge') }}</h4>
    <p class="dt-hint">{{ t('dt.ms.mergeHint') }}</p>
    <div class="dt-list">
      <div v-for="(p, i) in mergeList" :key="p + i" class="dt-list-row">
        <span class="dt-list-idx">{{ i + 1 }}</span>
        <span class="dt-list-name" :title="p">{{ p.split('/').pop() }}</span>
        <button :disabled="i === 0" @click="moveAt(i, -1)">↑</button>
        <button :disabled="i === mergeList.length - 1" @click="moveAt(i, 1)">↓</button>
        <button @click="removeAt(i)">✕</button>
      </div>
      <div v-if="!mergeList.length" class="dt-empty">{{ t('dt.ms.noFiles') }}</div>
    </div>
    <div class="dt-actions">
      <button @click="addFiles">{{ t('dt.ms.addFiles') }}</button>
      <button class="primary" :disabled="busy || mergeList.length < 2" @click="doMerge">
        {{ busy ? t('dt.working') : t('dt.ms.doMerge') }}
      </button>
    </div>

    <h4>{{ t('dt.ms.split') }}</h4>
    <div class="vm-seg">
      <button :class="{ active: mode === 'ranges' }" @click="mode = 'ranges'">{{ t('dt.ms.byRanges') }}</button>
      <button :class="{ active: mode === 'every' }" @click="mode = 'every'">{{ t('dt.ms.byEvery') }}</button>
    </div>
    <div v-if="mode === 'ranges'" class="dt-field">
      <input v-model="rangeText" :placeholder="t('dt.ms.rangesPlaceholder')" />
    </div>
    <div v-else class="dt-field">
      <label>{{ t('dt.ms.everyLabel') }}</label>
      <input type="number" min="1" :max="tab?.numPages ?? 1" v-model.number="everyN" />
    </div>
    <p class="dt-hint" v-if="previewRanges.length">
      {{ t('dt.ms.willMake', { n: previewRanges.length }) }}
      <span class="dt-ranges">{{ previewRanges.map((r) => (r[0] === r[1] ? r[0] : `${r[0]}–${r[1]}`)).join(' · ') }}</span>
    </p>
    <div class="dt-actions">
      <button class="primary" :disabled="busy || !previewRanges.length" @click="doSplit">
        {{ busy ? t('dt.working') : t('dt.ms.doSplit') }}
      </button>
    </div>
  </div>
</template>
