<script setup lang="ts">
import { store } from '../store'
defineEmits<{ open: []; openPath: [path: string] }>()
</script>

<template>
  <div class="welcome">
    <h1>SoloPDF</h1>
    <p>免费 · 无广告 · 本地化 · 高亮即笔记</p>
    <button class="open-btn" @click="$emit('open')">打开 PDF（⌘O）</button>
    <div class="recents" v-if="store.recents.length">
      <div
        v-for="p in store.recents.slice(0, 8)"
        :key="p"
        class="recent-item"
        :title="p"
        @click="$emit('openPath', p)"
      >
        {{ p.split('/').pop() }}
      </div>
    </div>
    <p class="drop-hint">高亮的内容会保存为 .annotations.md，可用 SoloMD 打开</p>
  </div>
</template>
