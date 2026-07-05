<script setup lang="ts">
import { store } from '../store'
import { t } from '../i18n'
defineEmits<{ open: []; openPath: [path: string] }>()
</script>

<template>
  <div class="welcome">
    <h1>SoloPDF</h1>
    <p>{{ t('wc.tagline') }}</p>
    <button class="open-btn" @click="$emit('open')">{{ t('wc.open') }}</button>
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
    <p class="drop-hint">{{ t('wc.hint') }}</p>
  </div>
</template>
