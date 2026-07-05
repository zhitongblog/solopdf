<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { store, controllers } from '../store'
import { SearchSession, type SearchHit } from '../viewer/search'
import { t } from '../i18n'

const emit = defineEmits<{ close: [] }>()
const input = ref<HTMLInputElement>()
const query = ref('')
const hits = ref<SearchHit[]>([])
const status = ref('')
const currentIdx = ref(-1)
let session: SearchSession | null = null

const ctrl = computed(() => { void store.docTick; return store.activeTab ? controllers.get(store.activeTab.id) : undefined })

function run(): void {
  session?.cancel()
  hits.value = []
  currentIdx.value = -1
  status.value = ''
  const c = ctrl.value
  if (!c || !query.value.trim()) return
  session = new SearchSession(c, query.value)
  status.value = t('se.searching')
  void session.run((h, done, total) => {
    hits.value = [...h]
    status.value = done < total
      ? t('se.progress', { done, total, n: h.length })
      : t('se.results', { n: h.length }) + (h.length >= 500 ? t('se.capped') : '')
  })
}

function jump(i: number): void {
  const h = hits.value[i]
  if (!h) return
  currentIdx.value = i
  ctrl.value?.scrollToPage(h.page)
}
function next(dir: 1 | -1): void {
  if (!hits.value.length) return
  jump((currentIdx.value + dir + hits.value.length) % hits.value.length)
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div class="searchbar">
    <div class="row">
      <input
        ref="input"
        v-model="query"
        :placeholder="t('se.placeholder')"
        @keydown.enter.exact="hits.length ? next(1) : run()"
        @keydown.enter.shift="next(-1)"
        @keydown.esc="emit('close')"
      />
      <button :title="t('se.prev')" @click="next(-1)">↑</button>
      <button :title="t('se.next')" @click="next(1)">↓</button>
      <button :title="t('se.close')" @click="emit('close')">×</button>
    </div>
    <div class="search-status" v-if="status">{{ status }}</div>
    <div class="results" v-if="hits.length">
      <div
        v-for="(h, i) in hits"
        :key="i"
        class="search-hit"
        :class="{ current: i === currentIdx }"
        @click="jump(i)"
      >
        <span class="sh-page">p.{{ h.page }}</span>{{ h.preview }}
      </div>
    </div>
  </div>
</template>
