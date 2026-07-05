<script setup lang="ts">
import { onMounted, ref } from 'vue'
const props = defineProps<{ retry: boolean }>()
const emit = defineEmits<{ submit: [pw: string]; cancel: [] }>()
const pw = ref('')
const input = ref<HTMLInputElement>()
onMounted(() => input.value?.focus())
</script>

<template>
  <div class="modal-mask">
    <div class="modal">
      <h3>{{ props.retry ? '密码错误，请重试' : '该 PDF 受密码保护' }}</h3>
      <p class="modal-note">密码仅用于本次打开，会话内记住，不会写入磁盘。</p>
      <input
        ref="input"
        v-model="pw"
        type="password"
        placeholder="输入密码"
        @keydown.enter="emit('submit', pw)"
        @keydown.esc="emit('cancel')"
      />
      <div class="modal-actions">
        <button @click="emit('cancel')">取消</button>
        <button class="primary" @click="emit('submit', pw)">打开</button>
      </div>
    </div>
  </div>
</template>
