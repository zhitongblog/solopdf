<script setup lang="ts">
/**
 * Settings, grouped.
 *
 * The flat list worked when there were four switches. There are now enough
 * that the grouping IS the documentation: reading, marks, speech, dictionary,
 * translation, privacy. Anything that belongs to one document (rotation, crop) or to one
 * view (book typography, comic direction) deliberately stays where you use
 * it, not here.
 */
import { computed, onMounted, ref } from 'vue'
import { TRANSLATE_LANGS } from '@solopdf/core'
import { store } from '../store'
import { isMobile, isTauri } from '../platform'
import { t, LOCALES, currentLocale } from '../i18n'
import { nativeEngine } from '../translate'

const emit = defineEmits<{ close: []; stats: [] }>()

const phone = computed(() => isMobile() || window.innerWidth < 700)
const clearing = ref('')

const COLORS = ['yellow', 'green', 'blue', 'pink'] as const

const trEngine = ref('none')
onMounted(async () => { trEngine.value = await nativeEngine() })
const trEngineLabel = computed(() => {
  if (trEngine.value === 'apple') return t('st.trNativeApple')
  if (trEngine.value === 'apple-hosted') return t('st.trNativeHosted')
  if (trEngine.value === 'stub') return t('tr.engStub')
  return t('st.trNativeNone')
})
const tr = computed(() => store.settings.translate)
function langName(tag: string): string {
  try {
    return new Intl.DisplayNames([currentLocale.value], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

async function clearCache(kind: 'textindex' | 'covers'): Promise<void> {
  clearing.value = kind
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('clear_cache', { kind })
  } catch {
    /* nothing cached yet is the same outcome as cleared */
  } finally {
    clearing.value = ''
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="st-shell" :class="{ phone }" @click.stop>
      <header class="dt-head">
        <h3>{{ t('st.title') }}</h3>
        <button class="dt-close" @click="emit('close')">✕</button>
      </header>

      <div class="st-body">
        <h4>{{ t('st.g.general') }}</h4>
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

        <h4>{{ t('st.g.reading') }}</h4>
        <div class="settings-row">
          <div>
            <div class="sr-label">{{ t('vm.layout') }}</div>
            <div class="sr-sub">{{ t('st.layoutSub') }}</div>
          </div>
          <select v-model="store.settings.scrollMode">
            <option value="continuous">{{ t('vm.continuous') }}</option>
            <option value="paged">{{ t('vm.pagedMode') }}</option>
          </select>
        </div>
        <div class="settings-row">
          <div>
            <div class="sr-label">{{ t('vm.single') }} / {{ t('vm.facing') }}</div>
          </div>
          <select v-model.number="store.settings.spread">
            <option :value="1">{{ t('vm.single') }}</option>
            <option :value="2">{{ t('vm.facing') }}</option>
          </select>
        </div>
        <div class="settings-row" v-if="store.settings.spread === 2">
          <div><div class="sr-label">{{ t('vm.coverAlone') }}</div></div>
          <input type="checkbox" v-model="store.settings.coverAlone" />
        </div>
        <div class="settings-row">
          <div>
            <div class="sr-label">{{ t('vm.keepAwake') }}</div>
            <div class="sr-sub">{{ t('st.keepAwakeSub') }}</div>
          </div>
          <input type="checkbox" v-model="store.settings.keepAwake" />
        </div>
        <div class="settings-row">
          <div><div class="sr-label">{{ t('vm.autoScroll') }} · {{ t('vm.speed') }}</div></div>
          <input type="range" min="10" max="400" step="5" v-model.number="store.settings.autoScrollSpeed" />
        </div>

        <h4>{{ t('st.g.marks') }}</h4>
        <div class="settings-row">
          <div>
            <div class="sr-label">{{ t('st.defaultColor') }}</div>
            <div class="sr-sub">{{ t('st.defaultColorSub') }}</div>
          </div>
          <div class="st-swatches">
            <button
              v-for="c in COLORS" :key="c"
              class="swatch" :class="[`sw-${c}`, { on: store.settings.defaultColor === c }]"
              :title="t('hl.' + c)"
              @click="store.settings.defaultColor = c"
            />
          </div>
        </div>

        <h4>{{ t('st.g.speech') }}</h4>
        <div class="settings-row">
          <div><div class="sr-label">{{ t('ra.rate') }}</div></div>
          <input type="range" min="0.5" max="2.5" step="0.1" v-model.number="store.settings.tts.rate" />
        </div>
        <div class="settings-row">
          <div>
            <div class="sr-label">{{ t('ra.voice') }}</div>
            <div class="sr-sub">{{ store.settings.tts.voiceURI || t('ra.autoVoice') }}</div>
          </div>
          <button @click="store.settings.tts.voiceURI = ''">{{ t('st.reset') }}</button>
        </div>

        <h4>{{ t('st.g.dictionary') }}</h4>
        <div class="settings-row">
          <div>
            <div class="sr-label">{{ t('st.webLookup') }}</div>
            <div class="sr-sub">{{ t('st.webLookupSub') }}</div>
          </div>
        </div>
        <div class="settings-row">
          <input class="st-wide" v-model="store.settings.webLookupUrl" placeholder="https://…%s" />
        </div>
        <p class="sr-sub st-note" v-if="isTauri()">{{ t('st.userDicts') }}</p>

        <h4>{{ t('st.g.translate') }}</h4>
        <div class="settings-row">
          <div>
            <div class="sr-label">{{ t('st.trTarget') }}</div>
            <div class="sr-sub">{{ t('st.trTargetSub') }}</div>
          </div>
          <select v-model="tr.target" data-testid="tr-target">
            <option value="">{{ t('tr.auto') }}</option>
            <option v-for="l in TRANSLATE_LANGS" :key="l" :value="l">{{ langName(l) }}</option>
          </select>
        </div>
        <div class="settings-row">
          <div>
            <div class="sr-label">{{ t('st.trNative') }}</div>
            <div class="sr-sub">{{ trEngineLabel }}</div>
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="sr-label">{{ t('st.trProvider') }}</div>
            <div class="sr-sub st-warn">{{ t('st.trProviderSub') }}</div>
          </div>
          <select v-model="tr.provider.kind" data-testid="tr-provider">
            <option value="off">{{ t('st.trOff') }}</option>
            <option value="deepl">{{ t('st.trDeepl') }}</option>
            <option value="openai">{{ t('st.trOpenai') }}</option>
          </select>
        </div>
        <template v-if="tr.provider.kind === 'deepl'">
          <div class="settings-row">
            <input
              class="st-wide" type="password" autocomplete="off" spellcheck="false"
              v-model.trim="tr.provider.deeplKey" :placeholder="t('st.trDeeplKey')"
            />
          </div>
        </template>
        <template v-else-if="tr.provider.kind === 'openai'">
          <div class="settings-row">
            <input
              class="st-wide" autocomplete="off" spellcheck="false"
              v-model.trim="tr.provider.baseUrl" :placeholder="t('st.trBaseUrl') + ' — https://…/v1'"
            />
          </div>
          <div class="settings-row">
            <input
              class="st-wide" type="password" autocomplete="off" spellcheck="false"
              v-model.trim="tr.provider.apiKey" :placeholder="t('st.trApiKey')"
            />
          </div>
          <div class="settings-row">
            <input
              class="st-wide" autocomplete="off" spellcheck="false"
              v-model.trim="tr.provider.model" :placeholder="t('st.trModel') + ' — gpt-4o-mini, deepseek-chat, qwen2.5…'"
            />
          </div>
        </template>
        <p v-if="tr.provider.kind !== 'off' && trEngine !== 'none'" class="sr-sub st-note">
          {{ t('st.trOnlineOnlyFallback') }}
        </p>

        <h4>{{ t('st.g.privacy') }}</h4>
        <div class="settings-row">
          <div>
            <div class="sr-label">{{ t('st.update') }}</div>
            <div class="sr-sub">{{ t('st.updateSub') }}</div>
          </div>
          <input type="checkbox" v-model="store.settings.updateCheck" />
        </div>
        <div class="settings-row">
          <div>
            <div class="sr-label">{{ t('st.stats') }}</div>
            <div class="sr-sub">{{ t('st.statsSub') }}</div>
          </div>
          <button @click="emit('stats')">{{ t('st.open') }}</button>
        </div>
        <div class="settings-row" v-if="isTauri()">
          <div>
            <div class="sr-label">{{ t('st.caches') }}</div>
            <div class="sr-sub">{{ t('st.cachesSub') }}</div>
          </div>
          <div class="st-cache-btns">
            <button :disabled="!!clearing" @click="clearCache('textindex')">
              {{ clearing === 'textindex' ? '…' : t('st.clearIndex') }}
            </button>
            <button :disabled="!!clearing" @click="clearCache('covers')">
              {{ clearing === 'covers' ? '…' : t('st.clearCovers') }}
            </button>
          </div>
        </div>
        <p class="sr-sub st-note">{{ t('st.privacyNote') }}</p>
      </div>

      <div class="dt-footer">
        <button class="primary" @click="emit('close')">{{ t('st.done') }}</button>
      </div>
    </div>
  </div>
</template>
