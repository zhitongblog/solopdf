<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store, controllers, annotManagers } from '../store'
import { undoLabelText } from '../annotations/manager'
import { isMobile, isTauri } from '../platform'
import { t } from '../i18n'

defineProps<{ bookmarked?: boolean; tool?: 'none' | 'note' | 'region'; speaking?: boolean }>()
defineEmits<{
  search: []; settings: []; print: []; saveFilled: []; exportMd: []; ocr: []
  book: []; view: []; bookmark: []; tool: [kind: 'note' | 'region']; docTools: []; speak: []
  undo: []; redo: []
}>()

const tab = computed(() => store.activeTab)
const ctrl = computed(() => { void store.docTick; return tab.value ? controllers.get(tab.value.id) : undefined })
// the manager is a plain object: its history is not reactive, but every
// write/undo bumps docTick, so these read it directly (a computed that only
// returns the same manager again would never re-trigger)
const undoState = computed(() => {
  void store.docTick
  const m = tab.value ? annotManagers.get(tab.value.id) : undefined
  const u = m?.nextUndo
  const r = m?.nextRedo
  return {
    canUndo: !!m?.canUndo,
    canRedo: !!m?.canRedo,
    undoTip: t('un.undo') + (u ? ' · ' + undoLabelText(u) : ''),
    redoTip: t('un.redo') + (r ? ' · ' + undoLabelText(r) : ''),
  }
})
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
    <button class="sidebar-btn" :title="t('tb.sidebar')" @click="store.settings.sidebarOpen = !store.settings.sidebarOpen">☰</button>
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
      class="view-btn"
      :class="{ active: ctrl?.autoScrolling }"
      :title="t('tb.viewTip')"
      @click="$emit('view')"
    >{{ t('tb.view') }}</button>
    <div class="sep" />
    <button :class="{ active: bookmarked }" :title="t('tb.bookmark')" @click="$emit('bookmark')">
      {{ bookmarked ? '★' : '☆' }}
    </button>
    <button :class="{ active: tool === 'note' }" :title="t('tb.noteTool')" @click="$emit('tool', 'note')">✎</button>
    <button :class="{ active: tool === 'region' }" :title="t('tb.regionTool')" @click="$emit('tool', 'region')">⬚</button>
    <span class="undo-group">
      <button class="undo-btn" :disabled="!undoState.canUndo" :title="undoState.undoTip" :aria-label="t('un.undo')" @click="$emit('undo')">↶</button>
      <button class="redo-btn" :disabled="!undoState.canRedo" :title="undoState.redoTip" :aria-label="t('un.redo')" @click="$emit('redo')">↷</button>
    </span>
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
    <button v-if="isTauri()" :title="t('tb.docTools')" @click="$emit('docTools')">🛠</button>
    <button v-if="isTauri()" :title="t('tb.ocrTip')" @click="$emit('ocr')">{{ t('tb.ocr') }}</button>
    <button :title="t('tb.exportMdTip')" @click="$emit('exportMd')">MD↓</button>
    <button :class="{ active: speaking }" :title="t('tb.speak')" @click="$emit('speak')">🔊</button>
    <button :title="t('tb.search')" @click="$emit('search')">🔍</button>
    <button v-if="!isMobile()" :title="t('tb.print')" @click="$emit('print')">🖨</button>
    <button :title="t('tb.settings')" @click="$emit('settings')">⚙︎</button>
  </div>
</template>
