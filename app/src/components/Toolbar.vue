<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store, controllers } from '../store'

defineEmits<{ search: []; settings: []; print: []; saveFilled: [] }>()

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
    <button title="侧栏 (⌘B)" @click="store.settings.sidebarOpen = !store.settings.sidebarOpen">☰</button>
    <div class="sep" />
    <div class="page-nav">
      <button title="上一页 (k)" @click="ctrl?.scrollToPage(Math.max(1, tab.currentPage - 1))">‹</button>
      <input v-model="pageInput" @keydown.enter="gotoPage" @blur="gotoPage" />
      <span style="color: var(--fg-dim)">/ {{ tab.numPages }}</span>
      <button title="下一页 (j)" @click="ctrl?.scrollToPage(Math.min(tab.numPages, tab.currentPage + 1))">›</button>
    </div>
    <div class="sep" />
    <button title="缩小 (⌘-)" @click="zoom(-1)">−</button>
    <button title="放大 (⌘+)" @click="zoom(1)">+</button>
    <button title="适应宽度 (⌘0)" @click="ctrl?.setZoom('width')">适宽</button>
    <button title="适应页面" @click="ctrl?.setZoom('page')">适页</button>
    <div class="grow" />
    <button
      v-if="tab.formsDirty"
      class="save-filled"
      title="保存已填写的表单为 PDF 副本"
      @click="$emit('saveFilled')"
    >保存已填表单</button>
    <span class="hint" :title="tab.sidecarLocation">{{ tab.encrypted ? '🔒 ' : '' }}{{ tab.sidecarLocation ? '批注 → ' + tab.sidecarLocation.split('/').pop() : '' }}</span>
    <div class="sep" />
    <button title="搜索 (⌘F)" @click="$emit('search')">🔍</button>
    <button title="打印 (⌘P)" @click="$emit('print')">🖨</button>
    <button title="设置 (⌘,)" @click="$emit('settings')">⚙︎</button>
  </div>
</template>
