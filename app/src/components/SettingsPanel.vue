<script setup lang="ts">
import { store } from '../store'
import { t, LOCALES } from '../i18n'
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <h3>{{ t('st.title') }}</h3>
      <div class="settings-row">
        <div>
          <div class="sr-label">{{ t('st.language') }}</div>
        </div>
        <select v-model="store.settings.language">
          <option value="system">{{ t('st.langSystem') }}</option>
          <option v-for="l in LOCALES" :key="l.value" :value="l.value">{{ l.label }}</option>
        </select>
      </div>
      <div class="settings-row">
        <div>
          <div class="sr-label">{{ t('st.theme') }}</div>
          <div class="sr-sub">{{ t('st.themeSub') }}</div>
        </div>
        <select v-model="store.settings.theme">
          <option value="system">{{ t('st.system') }}</option>
          <option value="light">{{ t('st.light') }}</option>
          <option value="dark">{{ t('st.dark') }}</option>
        </select>
      </div>
      <div class="settings-row">
        <div>
          <div class="sr-label">{{ t('st.darkPdf') }}</div>
          <div class="sr-sub">{{ t('st.darkPdfSub') }}</div>
        </div>
        <select v-model="store.settings.darkPdf">
          <option value="smart">{{ t('st.smart') }}</option>
          <option value="off">{{ t('st.keep') }}</option>
        </select>
      </div>
      <div class="settings-row">
        <div>
          <div class="sr-label">{{ t('st.update') }}</div>
          <div class="sr-sub">{{ t('st.updateSub') }}</div>
        </div>
        <input type="checkbox" v-model="store.settings.updateCheck" />
      </div>
      <div class="modal-actions">
        <button class="primary" @click="emit('close')">{{ t('st.done') }}</button>
      </div>
    </div>
  </div>
</template>
