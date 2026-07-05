<script setup lang="ts">
import { store } from '../store'
import { t } from '../i18n'
defineEmits<{ new: []; close: [id: number] }>()
</script>

<template>
  <div class="tabbar">
    <div class="tabbar-macpad" />
    <div
      v-for="tb in store.tabs"
      :key="tb.id"
      class="tab"
      :class="{ active: tb.id === store.activeTabId }"
      :title="tb.path"
      @click="store.activeTabId = tb.id"
      @mousedown.middle.prevent="$emit('close', tb.id)"
    >
      <span class="tab-name">{{ tb.name }}</span>
      <button class="tab-close" :title="t('tab.close')" @click.stop="$emit('close', tb.id)">×</button>
    </div>
    <button class="tab-new" :title="t('tab.open')" @click="$emit('new')">+</button>
    <div class="tabbar-spacer" />
  </div>
</template>
