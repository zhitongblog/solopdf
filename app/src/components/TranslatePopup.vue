<script setup lang="ts">
/**
 * Selection translation panel.
 *
 * Same shell as the dictionary popup: floats under the selection on desktop,
 * docks to the bottom on a phone. The engine is on-device where the OS has
 * one (Apple Translation); an online provider only runs when the reader set
 * one up in Settings, and the panel says which engine answered so it is never
 * a surprise that text went out.
 *
 * "Add as note" hands the translation back to the shell, which makes a
 * highlight of the original selection with the translation as its note — the
 * sidecar gets one ordinary annotation, nothing new to parse.
 */
import { computed, onMounted, ref } from 'vue'
import { TRANSLATE_LANGS } from '@solopdf/core'
import { store } from '../store'
import { isMobile, isTauri } from '../platform'
import { t, currentLocale } from '../i18n'
import {
  translateText, translateOnline, downloadLanguages, openLanguageSettings,
  hasProvider, isSingleWord, nativeEngine, type TranslateResult,
} from '../translate'

const props = defineProps<{ text: string; anchor: DOMRect | null }>()
const emit = defineEmits<{
  close: []
  toast: [msg: string]
  addNote: [translation: string]
  define: [word: string]
  settings: []
}>()

const result = ref<TranslateResult | null>(null)
const loading = ref(true)
const busy = ref(false)
const engine = ref('none')
const target = ref<string>(store.settings.translate.target)
const phone = computed(() => isMobile() || window.innerWidth < 560)
const isMacDesktop = /Macintosh|Mac OS X/i.test(navigator.userAgent) && !isMobile()

const style = computed(() => {
  if (phone.value) return {}
  // no selection rect (opened from the harness / a shortcut): centre it
  if (!props.anchor) return { top: '18vh', left: 'calc(50% - 180px)' }
  const r = props.anchor
  const top = Math.min(window.innerHeight - 300, r.bottom + 10)
  const left = Math.min(window.innerWidth - 370, Math.max(8, r.left))
  return { top: `${Math.max(8, top)}px`, left: `${left}px` }
})

/** "zh-Hans" → "简体中文" in the UI language */
function langName(tag: string | undefined): string {
  if (!tag) return ''
  try {
    return new Intl.DisplayNames([currentLocale.value], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

const engineLabel = computed(() => {
  const e = result.value?.engine
  if (e === 'apple') return t('tr.engApple')
  if (e === 'deepl') return t('tr.engOnline', { name: 'DeepL' })
  if (e === 'openai') return t('tr.engOnline', { name: store.settings.translate.provider.model || 'AI' })
  if (e === 'stub') return t('tr.engStub')
  return ''
})

async function run(): Promise<void> {
  loading.value = true
  result.value = await translateText(props.text, target.value)
  loading.value = false
}

onMounted(async () => {
  engine.value = await nativeEngine()
  await run()
})

function changeTarget(): void {
  // remembered: the next selection translates into the same language
  store.settings.translate.target = target.value
  void run()
}

async function copy(): Promise<void> {
  const text = result.value?.text
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    emit('toast', t('app.copied'))
  } catch {
    emit('toast', t('app.copyFail'))
  }
}

async function download(): Promise<void> {
  const r = result.value
  if (!r?.source || !r.target) return
  busy.value = true
  const ok = await downloadLanguages(r.source, r.target)
  busy.value = false
  if (ok) await run()
  else emit('toast', t('tr.downloadFail'))
}

async function useOnline(): Promise<void> {
  loading.value = true
  result.value = await translateOnline(props.text, target.value)
  loading.value = false
}

async function openSystemSettings(): Promise<void> {
  if (!(await openLanguageSettings())) emit('toast', t('tr.iosSettings'))
}

const message = computed(() => {
  const r = result.value
  if (!r || r.text) return ''
  const pair = `${langName(r.source)} → ${langName(r.target)}`
  switch (r.code) {
    case 'notInstalled': return t('tr.notInstalled', { pair })
    case 'noEngine': return t('tr.noEngine')
    case 'same': return t('tr.same', { lang: langName(r.target) })
    case 'unsupported': return t('tr.unsupported', { pair })
    case 'auth': return t('tr.auth')
    case 'cancelled': return t('tr.cancelled')
    case 'empty': return t('tr.empty')
    default: return t('tr.failed', { msg: r.error ?? '' })
  }
})

const canDownload = computed(() =>
  result.value?.code === 'notInstalled' && isTauri() && engine.value.startsWith('apple'))
const word = computed(() => isSingleWord(props.text))
</script>

<template>
  <div class="dc-mask" @click.self="emit('close')">
    <div class="dc-pop tr-pop" :class="{ phone }" :style="style" @click.stop>
      <div class="dc-head">
        <strong class="tr-title">{{ t('tr.title') }}</strong>
        <span v-if="result?.source" class="tr-from">{{ langName(result.source) }} →</span>
        <select v-model="target" class="tr-target" :title="t('tr.target')" @change="changeTarget">
          <option value="">{{ t('tr.auto') }}</option>
          <option v-for="l in TRANSLATE_LANGS" :key="l" :value="l">{{ langName(l) }}</option>
        </select>
        <button class="dc-close" @click="emit('close')">✕</button>
      </div>

      <div class="dc-body">
        <div class="tr-src">{{ text }}</div>
        <div v-if="loading" class="dc-empty">{{ t('tr.loading') }}</div>
        <div v-else-if="result?.text" class="tr-out">{{ result.text }}</div>
        <div v-else class="tr-msg">
          <p>{{ message }}</p>
          <div class="tr-msg-actions">
            <button v-if="canDownload" class="primary" :disabled="busy" @click="download">
              {{ busy ? '…' : t('tr.download') }}
            </button>
            <button v-if="result?.code === 'notInstalled' && isMacDesktop && isTauri()" @click="openSystemSettings">
              {{ t('tr.systemSettings') }}
            </button>
            <button v-if="result?.code === 'notInstalled' && hasProvider()" @click="useOnline">
              {{ t('tr.useOnline') }}
            </button>
            <button v-if="result?.code === 'noEngine'" class="primary" @click="emit('settings')">
              {{ t('tr.openSettings') }}
            </button>
            <button v-if="result?.code === 'noEngine' && word" @click="emit('define', text.trim())">
              {{ t('tr.dictionary') }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="result?.text && !loading" class="dc-actions">
        <button @click="copy">{{ t('tr.copy') }}</button>
        <button class="primary" @click="emit('addNote', result.text)">{{ t('tr.addNote') }}</button>
      </div>
      <div v-if="engineLabel && !loading" class="tr-engine">{{ engineLabel }}</div>
    </div>
  </div>
</template>
