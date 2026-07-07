<script setup lang="ts">
import { store } from '../store'
import { isTauri } from '../platform'
import { t } from '../i18n'
defineEmits<{ open: []; openPath: [path: string]; ocrImage: [] }>()
</script>

<template>
  <div class="welcome">
    <h1>SoloPDF</h1>
    <p>{{ t('wc.tagline') }}</p>
    <button class="open-btn" @click="$emit('open')">{{ t('wc.open') }}</button>
    <button v-if="isTauri()" class="open-btn open-btn-secondary" @click="$emit('ocrImage')">{{ t('wc.ocrImage') }}</button>
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
