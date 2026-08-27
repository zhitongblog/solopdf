<script setup lang="ts">
/**
 * Word lookup panel.
 *
 * Opens from the selection popover. On desktop it floats near the selection;
 * on a phone it docks to the bottom, because a panel over the word you just
 * tapped hides the thing you are trying to read.
 *
 * The web-search button is the ONLY thing here that can touch the network,
 * it is never automatic, and it opens the system browser rather than
 * fetching in-app — SoloPDF's "zero network" promise stays literally true.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { store } from '../store'
import { isMobile, isTauri } from '../platform'
import { lookup, systemDefine, webLookup, type DictEntry } from '../dict'
import { t } from '../i18n'

const props = defineProps<{ word: string; anchor: DOMRect | null }>()
const emit = defineEmits<{ close: []; toast: [msg: string] }>()

const entries = ref<DictEntry[]>([])
const loading = ref(true)
const phone = computed(() => isMobile() || window.innerWidth < 560)

const style = computed(() => {
  if (phone.value || !props.anchor) return {}
  const r = props.anchor
  const top = Math.min(window.innerHeight - 260, r.bottom + 10)
  const left = Math.min(window.innerWidth - 340, Math.max(8, r.left))
  return { top: `${top}px`, left: `${left}px` }
})

async function run(): Promise<void> {
  loading.value = true
  entries.value = await lookup(props.word)
  loading.value = false
}
onMounted(run)
watch(() => props.word, run)

async function openSystem(): Promise<void> {
  const r = await systemDefine(props.word)
  if (r === 'shown') emit('close')
  else emit('toast', r === 'none' ? t('dc.noSystemEntry') : t('dc.noSystem'))
}

async function openWeb(): Promise<void> {
  await webLookup(props.word, store.settings.webLookupUrl)
  emit('close')
}
</script>

<template>
  <div class="dc-mask" @click.self="emit('close')">
    <div class="dc-pop" :class="{ phone }" :style="style" @click.stop>
      <div class="dc-head">
        <strong class="dc-word">{{ word }}</strong>
        <button class="dc-close" @click="emit('close')">✕</button>
      </div>

      <div class="dc-body">
        <div v-if="loading" class="dc-empty">{{ t('dc.loading') }}</div>
        <template v-else-if="entries.length">
          <div v-for="(e, i) in entries" :key="i" class="dc-entry">
            <div class="dc-line">
              <span v-if="e.traditional" class="dc-trad">{{ e.traditional }}</span>
              <span v-if="e.pronunciation" class="dc-pron">{{ e.pronunciation }}</span>
              <span class="dc-src">{{ e.source }}</span>
            </div>
            <div class="dc-def">{{ e.definition }}</div>
          </div>
        </template>
        <div v-else class="dc-empty">{{ t('dc.notFound') }}</div>
      </div>

      <div class="dc-actions">
        <button v-if="isTauri()" @click="openSystem">{{ t('dc.system') }}</button>
        <button @click="openWeb">{{ t('dc.web') }}</button>
      </div>
    </div>
  </div>
</template>
