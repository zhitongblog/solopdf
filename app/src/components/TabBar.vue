<script setup lang="ts">
import { store } from '../store'
defineEmits<{ new: []; close: [id: number] }>()
</script>

<template>
  <div class="tabbar">
    <div class="tabbar-macpad" />
    <div
      v-for="t in store.tabs"
      :key="t.id"
      class="tab"
      :class="{ active: t.id === store.activeTabId }"
      :title="t.path"
      @click="store.activeTabId = t.id"
      @mousedown.middle.prevent="$emit('close', t.id)"
    >
      <span class="tab-name">{{ t.name }}</span>
      <button class="tab-close" title="关闭 (⌘W)" @click.stop="$emit('close', t.id)">×</button>
    </div>
    <button class="tab-new" title="打开 PDF (⌘O)" @click="$emit('new')">+</button>
    <div class="tabbar-spacer" />
  </div>
</template>
