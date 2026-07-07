<script setup lang="ts">
/**
 * OCR dialog: range + language + output format, then a progress run.
 * Everything executes locally (Vision on Apple, PP-OCR elsewhere).
 */
import { ref, computed } from 'vue'
import { store, documents } from '../store'
import { isMobile } from '../platform'
import { t, currentLocale } from '../i18n'
import {
  ocrDocument, makeSearchable, ocrToMarkdown, langsFor, OcrCancelled, type OcrProgress,
} from '../ocr'

const props = defineProps<{ initialOutput?: 'pdf' | 'md' }>()
const emit = defineEmits<{ close: []; done: [path: string, kind: 'pdf' | 'md'] }>()

const range = ref<'all' | 'current'>('all')
const output = ref<'pdf' | 'md'>(props.initialOutput ?? 'pdf')
const langMode = ref<'auto' | 'zh-en' | 'ja'>('auto')
const running = ref(false)
const progress = ref<OcrProgress>({ done: 0, total: 0 })
const error = ref('')
const cancelled = ref(false)

const tab = computed(() => store.activeTab)

async function run(): Promise<void> {
  const tb = tab.value
  const doc = tb && documents.get(tb.id)
  if (!tb || !doc) return
  running.value = true
  error.value = ''
  cancelled.value = false
  try {
    const pages =
      range.value === 'current'
        ? [tb.currentPage]
        : Array.from({ length: tb.numPages }, (_, i) => i + 1)
    const langs = langsFor(langMode.value, currentLocale.value)
    const results = await ocrDocument(
      doc, pages, langs,
      (p) => { progress.value = p },
      () => cancelled.value,
    )
    const total = [...results.values()].reduce((n, r) => n + r.lines.length, 0)
    if (total === 0) { error.value = t('ocr.nothing'); running.value = false; return }

    if (output.value === 'md') {
      const md = ocrToMarkdown(results, tb.name)
      const { platform } = await import('../platform')
      const dest = await platform().saveText(tb.name.replace(/\.pdf$/i, '') + '-ocr.md', md)
      if (dest) emit('done', dest, 'md')
      else emit('close')
    } else {
      let destPath: string | null = null
      if (!isMobile()) {
        const { save } = await import('@tauri-apps/plugin-dialog')
        destPath = await save({
          defaultPath: tb.name.replace(/\.pdf$/i, '') + '-ocr.pdf',
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        })
        if (!destPath) { running.value = false; return }
      }
      const written = await makeSearchable(doc, tb.path, destPath, results)
      emit('done', written, 'pdf')
    }
  } catch (err) {
    if (err instanceof OcrCancelled) emit('close')
    else error.value = String((err as Error)?.message ?? err)
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="!running && emit('close')">
    <div class="modal ocr-modal">
      <h3>{{ t('ocr.title') }}</h3>

      <template v-if="!running">
        <div class="ocr-row">
          <label>{{ t('ocr.range') }}</label>
          <select v-model="range">
            <option value="all">{{ t('ocr.rangeAll', { n: tab?.numPages ?? 0 }) }}</option>
            <option value="current">{{ t('ocr.rangeCurrent', { n: tab?.currentPage ?? 1 }) }}</option>
          </select>
        </div>
        <div class="ocr-row">
          <label>{{ t('ocr.lang') }}</label>
          <select v-model="langMode">
            <option value="auto">{{ t('ocr.langAuto') }}</option>
            <option value="zh-en">{{ t('ocr.langZhEn') }}</option>
            <option value="ja">{{ t('ocr.langJa') }}</option>
          </select>
        </div>
        <div class="ocr-row">
          <label>{{ t('ocr.output') }}</label>
          <select v-model="output">
            <option value="pdf">{{ t('ocr.outputPdf') }}</option>
            <option value="md">{{ t('ocr.outputMd') }}</option>
          </select>
        </div>
        <p class="modal-note">{{ t('ocr.note') }}</p>
        <p v-if="error" class="ocr-error">{{ error }}</p>
        <div class="modal-actions">
          <button @click="emit('close')">{{ t('ocr.cancel') }}</button>
          <button class="primary" @click="run">{{ t('ocr.start') }}</button>
        </div>
      </template>

      <template v-else>
        <div class="ocr-progress">
          <div class="ocr-progress-bar">
            <div
              class="ocr-progress-fill"
              :style="{ width: progress.total ? (progress.done / progress.total) * 100 + '%' : '0%' }"
            ></div>
          </div>
          <p class="modal-note">{{ t('ocr.progress', { done: progress.done, total: progress.total }) }}</p>
        </div>
        <div class="modal-actions">
          <button @click="cancelled = true">{{ t('ocr.cancelRun') }}</button>
        </div>
      </template>
    </div>
  </div>
</template>
