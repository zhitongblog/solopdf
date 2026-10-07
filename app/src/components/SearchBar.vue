<script setup lang="ts">
/**
 * In-document search.
 *   PDF: the controller's SearchSession (text layer, page by page).
 *   Chapter books (EPUB / MOBI / FB2): the chapter HTML's text, chapter by
 *   chapter; a hit jumps BookView to the chapter and marks the match there.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { store, controllers, labelOf, epubBooks, bookApis } from '../store'
import { SearchSession } from '../viewer/search'
import { t } from '../i18n'
import { jump as navJump } from '../nav'

const emit = defineEmits<{ close: [] }>()
const input = ref<HTMLInputElement>()
const query = ref('')
/** page = PDF page, or 1-based chapter for books; nth = match index inside it */
const hits = ref<{ page: number; preview: string; nth?: number }[]>([])
const status = ref('')
const currentIdx = ref(-1)
let session: SearchSession | null = null
let bookRun = 0

const ctrl = computed(() => { void store.docTick; return store.activeTab ? controllers.get(store.activeTab.id) : undefined })
const book = computed(() => {
  void store.docTick
  const tab = store.activeTab
  return tab && !controllers.get(tab.id) ? epubBooks.get(tab.id) : undefined
})

const MAX_HITS = 500

/** chapter text exactly as BookView's DOM has it (matches are found there again) */
function chapterText(c: number): string {
  const b = book.value
  if (!b) return ''
  const doc = new DOMParser().parseFromString(`<body>${b.chapterHtml(c)}</body>`, 'text/html')
  return doc.body.textContent ?? ''
}

async function runBook(q: string): Promise<void> {
  const b = book.value
  if (!b) return
  const run = ++bookRun
  const needle = q.toLocaleLowerCase()
  const total = b.chapters.length
  const found: { page: number; preview: string; nth: number }[] = []
  for (let c = 1; c <= total && found.length < MAX_HITS; c++) {
    const text = chapterText(c)
    const hay = text.toLocaleLowerCase()
    let at = hay.indexOf(needle)
    let nth = 0
    while (at >= 0 && found.length < MAX_HITS) {
      const pre = text.slice(Math.max(0, at - 24), at).replace(/\s+/g, ' ')
      const post = text.slice(at + q.length, at + q.length + 40).replace(/\s+/g, ' ')
      found.push({ page: c, nth, preview: `${pre}${text.slice(at, at + q.length)}${post}` })
      nth++
      at = hay.indexOf(needle, at + Math.max(1, needle.length))
    }
    if (c % 10 === 0) {
      hits.value = [...found]
      status.value = t('se.progressCh', { done: c, total, n: found.length })
      await new Promise((r) => setTimeout(r, 0))
      if (run !== bookRun) return
    }
  }
  if (run !== bookRun) return
  hits.value = found
  status.value = t('se.results', { n: found.length }) + (found.length >= MAX_HITS ? t('se.capped') : '')
}

function run(): void {
  session?.cancel()
  bookRun++
  hits.value = []
  currentIdx.value = -1
  status.value = ''
  const q = query.value.trim()
  if (!q) return
  if (book.value) {
    status.value = t('se.searching')
    void runBook(q)
    return
  }
  const c = ctrl.value
  if (!c) return
  session = new SearchSession(c, query.value)
  status.value = t('se.searching')
  void session.run((h, done, total) => {
    hits.value = [...h]
    status.value = done < total
      ? t('se.progress', { done, total, n: h.length })
      : t('se.results', { n: h.length }) + (h.length >= MAX_HITS ? t('se.capped') : '')
  })
}

function jump(i: number): void {
  const h = hits.value[i]
  if (!h) return
  const first = currentIdx.value < 0
  currentIdx.value = i
  const tab = store.activeTab
  if (!tab) return
  if (book.value) {
    const api = bookApis.get(tab.id)
    const go = (): void => { void api?.reveal?.(h.page, query.value.trim(), h.nth ?? 0) }
    if (first) navJump(tab.id, go)
    else go()
    return
  }
  const c = ctrl.value
  if (!c) return
  // only the first hit of a search is a history jump — Back then returns to
  // where the reader was before searching, not to the previous hit
  if (first) navJump(tab.id, () => { c.scrollToPage(h.page); c.settle() })
  else { c.scrollToPage(h.page); c.settle() }
}
function next(dir: 1 | -1): void {
  if (!hits.value.length) return
  jump((currentIdx.value + dir + hits.value.length) % hits.value.length)
}

function hitLabel(page: number): string {
  return book.value ? t('se.chapter', { n: page }) : 'p.' + labelOf(store.activeTab, page)
}

onMounted(() => input.value?.focus())
onBeforeUnmount(() => {
  bookRun++
  const tab = store.activeTab
  if (tab) bookApis.get(tab.id)?.clearReveal?.()
})
</script>

<template>
  <div class="searchbar" data-testid="searchbar">
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
        <span class="sh-page">{{ hitLabel(h.page) }}</span>{{ h.preview }}
      </div>
    </div>
  </div>
</template>
