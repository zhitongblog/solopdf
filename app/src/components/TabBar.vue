<script setup lang="ts">
import { computed, ref } from 'vue'
import { store } from '../store'
import { t } from '../i18n'
import { isMacDesktop } from '../platform'
import { pair, inPair, pairable } from '../viewer/pair'
import { splitAvailable } from '../viewer/split'
const emit = defineEmits<{
  new: []
  close: [id: number]
  /** show tab `id` on the right of the active document */
  pair: [id: number]
  /** open the compare dialog with the active document vs tab `id` */
  compare: [id: number]
  unpair: []
}>()

/** right-click menu: two-document actions (desktop / iPad width only) */
const menu = ref<{ id: number; x: number; y: number } | null>(null)
const menuTab = computed(() => store.tabs.find((x) => x.id === menu.value?.id))
const canPairWith = computed(() => {
  const m = menu.value
  const active = store.activeTab
  return !!m && !!active && m.id !== active.id && pairable(m.id) && pairable(active.id)
})

function onContextMenu(e: MouseEvent, id: number): void {
  const tb = store.tabs.find((x) => x.id === id)
  if (!splitAvailable.value || tb?.kind !== 'pdf') return
  e.preventDefault()
  menu.value = { id, x: e.clientX, y: e.clientY }
}
function act(kind: 'pair' | 'compare' | 'unpair'): void {
  const m = menu.value
  menu.value = null
  if (!m) return
  if (kind === 'unpair') emit('unpair')
  else if (kind === 'pair') emit('pair', m.id)
  else emit('compare', m.id)
}

/** a tab can be dragged onto the right half of the document area */
function onDragStart(e: DragEvent, id: number): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-solopdf-tab', String(id))
  e.dataTransfer.effectAllowed = 'move'
}
</script>

<template>
  <div class="tabbar">
    <div v-if="isMacDesktop()" class="tabbar-macpad" />
    <div
      v-for="tb in store.tabs"
      :key="tb.id"
      class="tab"
      :class="{ active: tb.id === store.activeTabId, paired: inPair(tb.id) }"
      :title="tb.path"
      :draggable="tb.kind === 'pdf' && splitAvailable"
      @click="store.activeTabId = tb.id"
      @mousedown.middle.prevent="$emit('close', tb.id)"
      @contextmenu="onContextMenu($event, tb.id)"
      @dragstart="onDragStart($event, tb.id)"
    >
      <span v-if="inPair(tb.id)" class="tab-pair-mark" :title="t('tab.paired')">{{ pair?.a === tb.id ? '◧' : '◨' }}</span>
      <span class="tab-name">{{ tb.name }}</span>
      <button class="tab-close" :title="t('tab.close')" @click.stop="$emit('close', tb.id)">×</button>
    </div>
    <button class="tab-new" :title="t('tab.open')" @click="$emit('new')">+</button>
    <div class="tabbar-spacer" />
    <div v-if="menu" class="tab-menu-mask" @click="menu = null" @contextmenu.prevent="menu = null">
      <div class="tab-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @click.stop>
        <div class="tab-menu-title">{{ menuTab?.name }}</div>
        <button :disabled="!canPairWith" @click="act('pair')">◨ {{ t('tab.openRight') }}</button>
        <button :disabled="!canPairWith" @click="act('compare')">⇆ {{ t('tab.compareWith') }}</button>
        <button v-if="inPair(menu.id)" @click="act('unpair')">▣ {{ t('tab.closePair') }}</button>
      </div>
    </div>
  </div>
</template>
