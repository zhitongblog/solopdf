<script setup lang="ts">
import { store } from '../store'
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <h3>设置</h3>
      <div class="settings-row">
        <div>
          <div class="sr-label">主题</div>
          <div class="sr-sub">跟随系统 / 浅色 / 深色</div>
        </div>
        <select v-model="store.settings.theme">
          <option value="system">系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>
      <div class="settings-row">
        <div>
          <div class="sr-label">深色模式下 PDF 页面</div>
          <div class="sr-sub">智能反色：纯文字页反色，含图片页保持原样</div>
        </div>
        <select v-model="store.settings.darkPdf">
          <option value="smart">智能反色</option>
          <option value="off">保持原样</option>
        </select>
      </div>
      <div class="settings-row">
        <div>
          <div class="sr-label">检查更新</div>
          <div class="sr-sub">关闭后应用零网络请求（当前版本未配置更新源）</div>
        </div>
        <input type="checkbox" v-model="store.settings.updateCheck" />
      </div>
      <div class="modal-actions">
        <button class="primary" @click="emit('close')">完成</button>
      </div>
    </div>
  </div>
</template>
