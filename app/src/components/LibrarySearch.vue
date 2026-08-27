<script setup lang="ts">
/**
 * Search the whole shelf.
 *
 * Annotations answer immediately; full text is opt-in per search because the
 * first pass over an un-indexed library is genuinely slow and pretending
 * otherwise would just look broken. Progress and a stop button are always
 * visible while that runs.
 */
import { computed, onMounted, ref } from 'vue'
import { store } from '../store'
import { isMobile } from '../platform'
import {
  clearIndexes, searchAnnotations, searchFullText,
  type FullTextProgress, type Hit,
} from '../librarySearch'
import { t } from '../i18n'

const emit = defineEmits<{ close: []; open: [path: string, page: number, annot?: string]; toast: [msg: string] }>()

const query = ref('')
const noteHits = ref<Hit[]>([])
const textHits = ref<Hit[]>([])
const searching = ref(false)
const progress = ref<FullTextProgress | null>(null)
const input = ref<HTMLInputElement>()
let cancelled = false

const phone = computed(() => isMobile() || window.innerWidth < 700)
const docCount = computed(() => Object.keys(store.library).length)

onMounted(() => input.value?.focus())

async function runNotes(): Promise<void> {
  noteHits.value = await searchAnnotations(query.value)
}

async function runFullText(buildMissing: boolean): Promise<void> {
  if (!query.value.trim()) return
  cancelled = false
  searching.value = true
  textHits.value = []
  try {
    await searchFullText(query.value, {
      buildMissing,
      isCancelled: () => cancelled,
      onProgress: (p) => { progress.value = p },
      onHits: (h) => { textHits.value = [...textHits.value, ...h] },
    })
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    searching.value = false
    progress.value = null
  }
}

function stop(): void {
  cancelled = true
}

async function wipeIndexes(): Promise<void> {
  await clearIndexes()
  emit('toast', t('ls.cleared'))
}

function go(h: Hit): void {
  emit('open', h.path, h.page, h.annot)
}

/** group by document so one book's twelve hits read as one block */
const grouped = computed(() => {
  const map = new Map<string, { name: string; hits: Hit[] }>()
  for (const h of [...noteHits.value, ...textHits.value]) {
    const g = map.get(h.path) ?? { name: h.name, hits: [] }
    g.hits.push(h)
    map.set(h.path, g)
  }
  return [...map.entries()]
})
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="ls-shell" :class="{ phone }" @click.stop>
      <header class="dt-head">
        <h3>{{ t('ls.title') }}</h3>
        <span class="dt-file">{{ t('ls.scope', { n: docCount }) }}</span>
        <button class="dt-close" @click="emit('close')">✕</button>
      </header>

      <div class="ls-bar">
        <input
          ref="input" v-model="query" :placeholder="t('ls.placeholder')"
          @keydown.enter="runNotes(); runFullText(false)"
          @input="runNotes()"
        />
        <button :disabled="searching || !query.trim()" @click="runFullText(false)">{{ t('ls.searchIndexed') }}</button>
        <button class="primary" :disabled="searching || !query.trim()" @click="runFullText(true)">
          {{ t('ls.searchAll') }}
        </button>
        <button v-if="searching" class="danger" @click="stop">{{ t('ls.stop') }}</button>
      </div>

      <div class="ls-status" v-if="progress">
        {{ t('ls.progress', { done: progress.doneDocs, total: progress.totalDocs }) }}
        <template v-if="progress.name"> · {{ progress.name }}</template>
        <template v-if="progress.pages"> · {{ progress.page }}/{{ progress.pages }}</template>
      </div>

      <div class="ls-body">
        <div v-if="!grouped.length" class="dt-empty">
          {{ query.trim() ? t('ls.noHits') : t('ls.hint') }}
        </div>
        <div v-for="[path, g] in grouped" :key="path" class="ls-group">
          <div class="ls-doc">{{ g.name }} <span class="ls-count">{{ g.hits.length }}</span></div>
          <div v-for="(h, i) in g.hits.slice(0, 30)" :key="i" class="ls-hit" @click="go(h)">
            <span class="ls-where" :class="h.where">{{ h.where === 'note' ? '✎' : 'p' }}{{ h.page }}</span>
            <span class="ls-preview">{{ h.preview }}</span>
          </div>
          <div v-if="g.hits.length > 30" class="ls-more">{{ t('ls.more', { n: g.hits.length - 30 }) }}</div>
        </div>
      </div>

      <div class="dt-footer">
        <button @click="wipeIndexes">{{ t('ls.clearIndex') }}</button>
      </div>
    </div>
  </div>
</template>
