<script setup lang="ts">
import { computed } from 'vue'
import type { SelectionInfo } from '../viewer/controller'

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
    <button class="swatch sw-yellow" title="黄色高亮" @click="$emit('pick', 'yellow')" />
    <button class="swatch sw-green" title="绿色高亮" @click="$emit('pick', 'green')" />
    <button class="swatch sw-blue" title="蓝色高亮" @click="$emit('pick', 'blue')" />
    <button class="swatch sw-pink" title="粉色高亮" @click="$emit('pick', 'pink')" />
  </div>
</template>
