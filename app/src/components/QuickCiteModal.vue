<script setup lang="ts">
/**
 * Global Quick Cite & Paper Switcher (⌘⇧K / Ctrl+Shift+K).
 * Search the local shelf by title, author, year, DOI, arXiv, citeKey or #tag.
 *   - Enter: copy formatted citation (\cite{key}, [@key], BibTeX, APA, GB/T)
 *   - Shift+Enter / Cmd+Enter: open the paper
 *   - Tab: cycle citation format
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { formatAuthorsShort, formatCitation, toBibtex } from '@solopdf/core'
import { store } from '../store'
import { citeKeyOf, citeOf, type LibraryItem } from '../library'
import { copyText } from '../clipboard'
import { t } from '../i18n'

type QuickMode = 'latex' | 'pandoc' | 'bibtex' | 'apa' | 'gbt'
const MODES: { id: QuickMode; label: string }[] = [
  { id: 'latex', label: '\\cite{}' },
  { id: 'pandoc', label: '[@key]' },
  { id: 'bibtex', label: 'BibTeX' },
  { id: 'apa', label: 'APA' },
  { id: 'gbt', label: 'GB/T' },
]

const emit = defineEmits<{ close: []; open: [path: string]; toast: [msg: string] }>()

const inputEl = ref<HTMLInputElement>()
const query = ref('')
const mode = ref<QuickMode>('latex')
const activeIdx = ref(0)

const results = computed<LibraryItem[]>(() => {
  void store.library
  const q = query.value.trim().toLowerCase()
  const list = Object.values(store.library).filter((it) => {
    if (it.missing) return false
    if (!q) return true
    const hay = [
      it.name,
      it.cite?.title,
      ...(it.cite?.authors ?? []).map((a) => a.literal || `${a.given ?? ''} ${a.family}`),
      it.cite?.journal,
      it.cite?.doi,
      it.cite?.arxiv,
      it.cite?.year ? String(it.cite.year) : '',
      it.citeKey,
      ...(it.tags ?? []),
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q)
  })
  return list
    .sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt))
    .slice(0, 40)
})

watch(results, () => { activeIdx.value = 0 })

onMounted(() => {
  void nextTick(() => inputEl.value?.focus())
})

async function copyItem(it: LibraryItem): Promise<void> {
  const meta = citeOf(it)
  const key = citeKeyOf(it)
  let out = ''
  let label = ''
  if (mode.value === 'latex') { out = `\\cite{${key}}`; label = out }
  else if (mode.value === 'pandoc') { out = `[@${key}]`; label = out }
  else if (mode.value === 'bibtex') { out = toBibtex(meta, key); label = `BibTeX (${key})` }
  else if (mode.value === 'apa') { out = formatCitation(meta, 'apa'); label = 'APA' }
  else { out = formatCitation(meta, 'gbt'); label = 'GB/T 7714' }
  emit('toast', (await copyText(out)) ? t('lb.citeCopied', { text: label }) : t('app.copyFail'))
  emit('close')
}

function openItem(it: LibraryItem): void {
  emit('open', it.path)
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); emit('close'); return }
  if (e.key === 'Tab') {
    e.preventDefault()
    const i = MODES.findIndex((m) => m.id === mode.value)
    mode.value = MODES[(i + 1) % MODES.length].id
    return
  }
  if (!results.value.length) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIdx.value = (activeIdx.value + 1) % results.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = (activeIdx.value - 1 + results.value.length) % results.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const cur = results.value[activeIdx.value]
    if (!cur) return
    if (e.shiftKey || e.metaKey || e.ctrlKey) openItem(cur)
    else void copyItem(cur)
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')" @keydown="onKeydown">
    <div class="modal qc-modal">
      <div class="qc-top">
        <input
          ref="inputEl"
          v-model="query"
          class="qc-input"
          :placeholder="t('qc.placeholder')"
        />
        <div class="qc-modes">
          <button
            v-for="m in MODES" :key="m.id"
            :class="{ on: mode === m.id }"
            @click="mode = m.id"
          >{{ m.label }}</button>
        </div>
      </div>
      <div class="qc-list" v-if="results.length">
        <div
          v-for="(it, idx) in results" :key="it.path"
          class="qc-row" :class="{ active: idx === activeIdx }"
          @mouseenter="activeIdx = idx"
          @click="copyItem(it)"
        >
          <div class="qc-row-main">
            <div class="qc-title">{{ it.cite?.title || it.name }}</div>
            <div class="qc-sub">
              <span>{{ citeKeyOf(it) }}</span>
              <span v-if="it.cite?.authors?.length"> · {{ formatAuthorsShort(it.cite.authors) }}</span>
              <span v-if="it.cite?.year"> · {{ it.cite.year }}</span>
              <span v-if="it.cite?.journal"> · {{ it.cite.journal }}</span>
            </div>
          </div>
          <button class="qc-open" :title="t('lp.openPaper')" @click.stop="openItem(it)">↗</button>
        </div>
      </div>
      <div v-else class="qc-empty">{{ t('qc.empty') }}</div>
      <div class="qc-foot">{{ t('qc.hint') }}</div>
    </div>
  </div>
</template>
