<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { store, controllers } from '../store'
import { SearchSession, type SearchHit } from '../viewer/search'

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
  status.value = '搜索中…'
  void session.run((h, done, total) => {
    hits.value = [...h]
    status.value = done < total
      ? `搜索中… ${done}/${total} 页，${h.length} 个结果`
      : `${h.length} 个结果${h.length >= 500 ? '（已达上限）' : ''}`
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
        placeholder="搜索文档…（回车）"
        @keydown.enter.exact="hits.length ? next(1) : run()"
        @keydown.enter.shift="next(-1)"
        @keydown.esc="emit('close')"
      />
      <button title="上一个" @click="next(-1)">↑</button>
      <button title="下一个" @click="next(1)">↓</button>
      <button title="关闭 (Esc)" @click="emit('close')">×</button>
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
