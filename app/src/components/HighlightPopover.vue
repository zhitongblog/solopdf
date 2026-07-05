<script setup lang="ts">
import { computed } from 'vue'
import type { SelectionInfo } from '../viewer/controller'
import { t } from '../i18n'

const props = defineProps<{ selection: SelectionInfo }>()
defineEmits<{ pick: [color: string] }>()

const style = computed(() => {
  const r = props.selection.clientRect
  const top = Math.min(window.innerHeight - 48, r.bottom + 8)
  const left = Math.min(window.innerWidth - 140, Math.max(8, r.left + r.width / 2 - 60))
  return { top: `${top}px`, left: `${left}px` }
})
</script>

<template>
  <div class="hl-pop" :style="style" @mousedown.prevent>
    <button class="swatch sw-yellow" :title="t('hl.yellow')" @click="$emit('pick', 'yellow')" />
    <button class="swatch sw-green" :title="t('hl.green')" @click="$emit('pick', 'green')" />
    <button class="swatch sw-blue" :title="t('hl.blue')" @click="$emit('pick', 'blue')" />
    <button class="swatch sw-pink" :title="t('hl.pink')" @click="$emit('pick', 'pink')" />
  </div>
</template>
