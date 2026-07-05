<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { t } from '../i18n'
const props = defineProps<{ retry: boolean }>()
const emit = defineEmits<{ submit: [pw: string]; cancel: [] }>()
const pw = ref('')
const input = ref<HTMLInputElement>()
onMounted(() => input.value?.focus())
</script>

<template>
  <div class="modal-mask">
    <div class="modal">
      <h3>{{ props.retry ? t('pw.retry') : t('pw.title') }}</h3>
      <p class="modal-note">{{ t('pw.note') }}</p>
      <input
        ref="input"
        v-model="pw"
        type="password"
        :placeholder="t('pw.placeholder')"
        @keydown.enter="emit('submit', pw)"
        @keydown.esc="emit('cancel')"
      />
      <div class="modal-actions">
        <button @click="emit('cancel')">{{ t('pw.cancel') }}</button>
        <button class="primary" @click="emit('submit', pw)">{{ t('pw.open') }}</button>
      </div>
    </div>
  </div>
</template>
