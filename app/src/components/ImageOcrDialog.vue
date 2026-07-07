<script setup lang="ts">
/**
 * Image → text: runs OCR on a picked picture and shows the editable
 * result with copy / save-as-Markdown actions. Local only.
 */
import { ref, onMounted } from 'vue'
import { platform } from '../platform'
import { t, currentLocale } from '../i18n'
import { ocrImageBytes, ocrToPlainText, langsFor } from '../ocr'

/** either a picked file path (desktop) or in-memory bytes (mobile camera/photos) */
const props = defineProps<{ path?: string; bytes?: Uint8Array; name?: string }>()
const emit = defineEmits<{ close: []; toast: [msg: string] }>()

const text = ref('')
const busy = ref(true)
const error = ref('')

onMounted(async () => {
  try {
    let bytes = props.bytes
    if (!bytes && props.path) {
      const { invoke } = await import('@tauri-apps/api/core')
      const meta = await invoke<{ size: number }>('file_meta', { path: props.path })
      const buf = await invoke<ArrayBuffer>('read_chunk', {
        path: props.path, offset: 0, length: meta.size,
      })
      bytes = new Uint8Array(buf)
    }
    if (!bytes) throw new Error('no image')
    const lines = await ocrImageBytes(bytes, langsFor('auto', currentLocale.value))
    text.value = ocrToPlainText(lines)
    if (!text.value.trim()) error.value = t('ocr.nothing')
  } catch (err) {
    error.value = String((err as Error)?.message ?? err)
  } finally {
    busy.value = false
  }
})

async function copyAll(): Promise<void> {
  await navigator.clipboard.writeText(text.value)
  emit('toast', t('app.copied'))
}

async function saveMd(): Promise<void> {
  const base = props.name ?? props.path?.split('/').pop() ?? 'image'
  const name = base.replace(/\.(png|jpe?g|webp|tiff?)$/i, '')
  const dest = await platform().saveText(`${name}-ocr.md`, text.value)
  if (dest) {
    emit('toast', t('app.ocrDone', { file: dest.split('/').pop()! }))
    emit('close')
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal ocr-modal ocr-image-modal">
      <h3>{{ t('ocr.imageTitle') }}</h3>
      <p v-if="busy" class="modal-note">{{ t('ocr.recognizing') }}</p>
      <p v-else-if="error" class="ocr-error">{{ error }}</p>
      <textarea v-if="!busy && !error" v-model="text" class="ocr-text" spellcheck="false"></textarea>
      <div class="modal-actions">
        <button @click="emit('close')">{{ t('ocr.close') }}</button>
        <template v-if="!busy && !error">
          <button @click="copyAll">{{ t('ocr.copy') }}</button>
          <button class="primary" @click="saveMd">{{ t('ocr.saveMd') }}</button>
        </template>
      </div>
    </div>
  </div>
</template>
