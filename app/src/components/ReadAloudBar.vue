<script setup lang="ts">
/**
 * Read-aloud transport.
 *
 * Docked to the bottom in both layouts — this is a playback control, and
 * playback controls belong where media controls live. Phones get 44pt targets
 * and hide the voice picker behind a toggle; desktop shows it inline because
 * there is room and picking a voice is a one-time thing people hunt for.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { store } from '../store'
import { isMobile } from '../platform'
import { loadVoices, ttsSupported } from '../tts'
import { speaker, startReading, stopReading } from '../readaloud'
import { t } from '../i18n'

const emit = defineEmits<{ close: [] }>()

const voices = ref<SpeechSynthesisVoice[]>([])
const state = ref(speaker.status)
const showVoices = ref(false)
const error = ref('')
const phone = computed(() => isMobile() || window.innerWidth < 700)

speaker.onStateChange = (s) => {
  state.value = s
  // a clean finish closes the bar; an error keeps it up so the message lands
  if (s === 'idle' && !error.value) emit('close')
}
speaker.onError = (reason) => {
  error.value = reason === 'not-allowed' ? t('ra.blocked') : t('ra.failed', { reason })
}

onMounted(async () => {
  voices.value = await loadVoices()
  const tab = store.activeTab
  if (tab) await startReading(tab.id)
  state.value = speaker.status
})

onBeforeUnmount(() => {
  speaker.onStateChange = () => {}
  speaker.onError = () => {}
  stopReading()
})

function setRate(v: number): void {
  store.settings.tts.rate = v
  speaker.setOptions({ rate: v })
}
function setVoice(uri: string): void {
  store.settings.tts.voiceURI = uri
  const v = voices.value.find((x) => x.voiceURI === uri)
  if (v) store.settings.tts.lang = v.lang
  speaker.setOptions({ voiceURI: uri, lang: store.settings.tts.lang })
}

/** group voices by language so a 60-voice list is navigable */
const grouped = computed(() => {
  const map = new Map<string, SpeechSynthesisVoice[]>()
  for (const v of voices.value) {
    const key = v.lang || '—'
    map.set(key, [...(map.get(key) ?? []), v])
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})
</script>

<template>
  <div class="ra-bar" :class="{ phone }">
    <template v-if="error">
      <span class="ra-unsupported">{{ error }}</span>
      <button class="ra-btn" :title="t('ra.playPause')" @click="error = ''; startReading(store.activeTab!.id)">▶</button>
      <button class="ra-btn ra-stop" @click="emit('close')">✕</button>
    </template>
    <template v-else-if="ttsSupported()">
      <button class="ra-btn" :title="t('ra.prev')" @click="speaker.skip(-1)">⏮</button>
      <button class="ra-btn ra-play" :title="t('ra.playPause')" @click="speaker.toggle()">
        {{ state === 'speaking' ? '⏸' : '▶' }}
      </button>
      <button class="ra-btn" :title="t('ra.next')" @click="speaker.skip(1)">⏭</button>

      <div class="ra-rate">
        <label>{{ t('ra.rate') }}</label>
        <input
          type="range" min="0.5" max="2.5" step="0.1"
          :value="store.settings.tts.rate"
          @input="setRate(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="vm-val">{{ store.settings.tts.rate.toFixed(1) }}×</span>
      </div>

      <button v-if="phone" class="ra-btn" :title="t('ra.voice')" @click="showVoices = !showVoices">🗣</button>
      <select
        v-if="!phone"
        class="ra-voice"
        :value="store.settings.tts.voiceURI"
        @change="setVoice(($event.target as HTMLSelectElement).value)"
      >
        <option value="">{{ t('ra.autoVoice') }}</option>
        <optgroup v-for="[lang, list] in grouped" :key="lang" :label="lang">
          <option v-for="v in list" :key="v.voiceURI" :value="v.voiceURI">{{ v.name }}</option>
        </optgroup>
      </select>

      <button class="ra-btn ra-stop" :title="t('ra.stop')" @click="emit('close')">✕</button>

      <div v-if="phone && showVoices" class="ra-voice-sheet" @click.self="showVoices = false">
        <div class="ra-voice-list">
          <button :class="{ on: !store.settings.tts.voiceURI }" @click="setVoice(''); showVoices = false">
            {{ t('ra.autoVoice') }}
          </button>
          <template v-for="[lang, list] in grouped" :key="lang">
            <div class="ra-voice-lang">{{ lang }}</div>
            <button
              v-for="v in list" :key="v.voiceURI"
              :class="{ on: store.settings.tts.voiceURI === v.voiceURI }"
              @click="setVoice(v.voiceURI); showVoices = false"
            >{{ v.name }}</button>
          </template>
        </div>
      </div>
    </template>
    <template v-else>
      <span class="ra-unsupported">{{ t('ra.unsupported') }}</span>
      <button class="ra-btn ra-stop" @click="emit('close')">✕</button>
    </template>
  </div>
</template>
