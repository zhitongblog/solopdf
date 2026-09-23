<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store, controllers, annotManagers, labelOf } from '../store'
import { resolvePageInput } from '@solopdf/core'
import { undoLabelText } from '../annotations/manager'
import { isMobile, isTauri } from '../platform'
import { t } from '../i18n'
import { navState, jump, goBack, goForward } from '../nav'
import { isDrawTool, TOOL_GLYPH, type DrawTool } from '../annotations/drawing'
import { splitAvailable } from '../viewer/split'

defineProps<{ bookmarked?: boolean; tool?: 'none' | 'note' | 'region' | DrawTool; speaking?: boolean }>()
defineEmits<{
  search: []; settings: []; print: []; saveFilled: []; exportMd: []; ocr: []
  book: []; view: []; rotate: []; bookmark: []; tool: [kind: 'note' | 'region' | 'draw']; docTools: []; speak: []
  undo: []; redo: []; split: []
}>()

const tab = computed(() => store.activeTab)
const ctrl = computed(() => { void store.docTick; return tab.value ? controllers.get(tab.value.id) : undefined })
const nav = computed(() => (tab.value ? navState[tab.value.id] : undefined))
/** the page box shows the PRINTED label ("xii"); typing takes a label or a
 *  physical number (resolvePageInput has the precedence rules) */
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
const shownLabel = computed(() => (tab.value ? labelOf(tab.value, tab.value.currentPage) : '1'))
watch(shownLabel, (l) => { pageInput.value = l }, { immediate: true })
/** labelled docs show the physical position as a secondary "(35 / 400)" */
const labelled = computed(() => !!tab.value?.pageLabels)

// Enter jumps itself instead of relying on the blur it triggers: blur() on an
// input in an unfocused window fires no blur event. The blur that may follow
// finds the page already reached and does nothing.
function gotoPage(e: Event): void {
  const tb = tab.value
  const c = ctrl.value
  const el = e.target as HTMLInputElement
  if (!tb || !c) return
  // read the element, not the model: IME commits can land without an input event
  const n = resolvePageInput(el.value, tb.pageLabels, tb.numPages)
  // a real page change is a jump: it goes on the back/forward history
  if (n && n !== tb.currentPage) jump(tb.id, () => { c.scrollToPage(n); c.settle() })
  // on a miss (or a jump that lands on the same page) put the label back —
  // on the element too, since the model may already hold that same string
  pageInput.value = el.value = labelOf(tb, n ?? tb.currentPage)
}
function zoom(dir: 1 | -1): void {
  ctrl.value?.setZoom((ctrl.value.scale) * (dir > 0 ? 1.15 : 1 / 1.15))
}
</script>

<template>
  <div class="toolbar" v-if="tab">
    <button class="sidebar-btn" :title="t('tb.sidebar')" @click="store.settings.sidebarOpen = !store.settings.sidebarOpen">☰</button>
    <div class="sep" />
    <button v-if="nav?.back" class="nav-back" :title="t('nav.backTip')" @click="goBack(tab.id)">↩</button>
    <button v-if="nav?.fwd" class="nav-fwd" :title="t('nav.forwardTip')" @click="goForward(tab.id)">↪</button>
    <div class="page-nav">
      <button :title="t('tb.prev')" @click="ctrl?.scrollToPage(Math.max(1, tab.currentPage - 1))">‹</button>
      <input
        v-model="pageInput"
        class="page-box"
        :class="{ labelled }"
        :title="labelled ? t('tb.pageLabelTip') : ''"
        @focus="($event.target as HTMLInputElement).select()"
        @keydown.enter="gotoPage($event); ($event.target as HTMLInputElement).blur()"
        @blur="gotoPage"
      />
      <span v-if="labelled" class="page-phys">({{ tab.currentPage }} / {{ tab.numPages }})</span>
      <span v-else class="page-phys">/ {{ tab.numPages }}</span>
      <button :title="t('tb.next')" @click="ctrl?.scrollToPage(Math.min(tab.numPages, tab.currentPage + 1))">›</button>
    </div>
    <div class="sep" />
    <button :title="t('tb.zoomOut')" @click="zoom(-1)">−</button>
    <button :title="t('tb.zoomIn')" @click="zoom(1)">+</button>
    <button :title="t('tb.fitWidthTip')" @click="ctrl?.setZoom('width')">{{ t('tb.fitWidth') }}</button>
    <button :title="t('tb.fitPageTip')" @click="ctrl?.setZoom('page')">{{ t('tb.fitPage') }}</button>
    <button class="rotate-btn" :title="t('tb.rotate')" @click="$emit('rotate')"><svg class="rot-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.46-3.54" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12.5 1.5v3.5H9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <button
      class="view-btn"
      :class="{ active: ctrl?.autoScrolling }"
      :title="t('tb.viewTip')"
      @click="$emit('view')"
    >{{ t('tb.view') }}</button>
    <button
      v-if="splitAvailable && !tab.bookMode"
      class="split-btn"
      :class="{ active: !!tab.split }"
      :title="t('tb.splitTip')"
      @click="$emit('split')"
    >{{ tab.split?.dir === 'col' ? '⬒' : '◫' }}</button>
    <div class="sep" />
    <button :class="{ active: bookmarked }" :title="t('tb.bookmark')" @click="$emit('bookmark')">
      {{ bookmarked ? '★' : '☆' }}
    </button>
    <button :class="{ active: tool === 'note' }" :title="t('tb.noteTool')" @click="$emit('tool', 'note')">✎</button>
    <button :class="{ active: tool === 'region' }" :title="t('tb.regionTool')" @click="$emit('tool', 'region')">⬚</button>
    <!-- one button for the whole drawing group: pen, eraser, text box,
         shapes — the tools themselves live in the draw bar it opens -->
    <button
      class="draw-btn"
      :class="{ active: tool && isDrawTool(tool) }"
      :title="t('tb.drawTool')"
      @click="$emit('tool', 'draw')"
    >{{ tool && isDrawTool(tool) ? TOOL_GLYPH[tool] : '🖊' }}</button>
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
