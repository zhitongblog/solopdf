<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store, controllers } from '../store'
import { isMobile, isTauri } from '../platform'
import { t } from '../i18n'

defineEmits<{ search: []; settings: []; print: []; saveFilled: []; exportMd: []; ocr: []; book: [] }>()

const tab = computed(() => store.activeTab)
const ctrl = computed(() => { void store.docTick; return tab.value ? controllers.get(tab.value.id) : undefined })
const pageInput = ref('1')
watch(() => tab.value?.currentPage, (p) => { if (p) pageInput.value = String(p) })

function gotoPage(): void {
  const n = parseInt(pageInput.value, 10)
  if (tab.value && ctrl.value && n >= 1 && n <= tab.value.numPages) ctrl.value.scrollToPage(n)
}
function zoom(dir: 1 | -1): void {
  ctrl.value?.setZoom((ctrl.value.scale) * (dir > 0 ? 1.15 : 1 / 1.15))
}
</script>

<template>
  <div class="toolbar" v-if="tab">
    <button :title="t('tb.sidebar')" @click="store.settings.sidebarOpen = !store.settings.sidebarOpen">☰</button>
    <div class="sep" />
    <div class="page-nav">
      <button :title="t('tb.prev')" @click="ctrl?.scrollToPage(Math.max(1, tab.currentPage - 1))">‹</button>
      <input v-model="pageInput" @keydown.enter="gotoPage" @blur="gotoPage" />
      <span style="color: var(--fg-dim)">/ {{ tab.numPages }}</span>
      <button :title="t('tb.next')" @click="ctrl?.scrollToPage(Math.min(tab.numPages, tab.currentPage + 1))">›</button>
    </div>
    <div class="sep" />
    <button :title="t('tb.zoomOut')" @click="zoom(-1)">−</button>
    <button :title="t('tb.zoomIn')" @click="zoom(1)">+</button>
    <button :title="t('tb.fitWidthTip')" @click="ctrl?.setZoom('width')">{{ t('tb.fitWidth') }}</button>
    <button :title="t('tb.fitPageTip')" @click="ctrl?.setZoom('page')">{{ t('tb.fitPage') }}</button>
    <button
      class="book-toggle"
      :class="{ active: tab.bookMode }"
      :title="t('tb.bookTip')"
      @click="$emit('book')"
    >📖</button>
    <div class="grow" />
    <button
      v-if="tab.formsDirty"
      class="save-filled"
      :title="t('tb.saveFilledTip')"
      @click="$emit('saveFilled')"
    >{{ t('tb.saveFilled') }}</button>
    <span class="hint" :title="tab.sidecarLocation">{{ tab.encrypted ? '🔒 ' : '' }}{{ tab.sidecarLocation ? t('tb.annotTo') + tab.sidecarLocation.split('/').pop() : '' }}</span>
    <div class="sep" />
    <button v-if="isTauri()" :title="t('tb.ocrTip')" @click="$emit('ocr')">{{ t('tb.ocr') }}</button>
    <button :title="t('tb.exportMdTip')" @click="$emit('exportMd')">MD↓</button>
    <button :title="t('tb.search')" @click="$emit('search')">🔍</button>
    <button v-if="!isMobile()" :title="t('tb.print')" @click="$emit('print')">🖨</button>
    <button :title="t('tb.settings')" @click="$emit('settings')">⚙︎</button>
  </div>
</template>
