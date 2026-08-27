<script setup lang="ts">
/**
 * The shelf — what you see when no document is open.
 *
 * Desktop: a cover grid with a folder list you can point at your books.
 * Phone: the same grid, but it IS the file manager (iOS has no Finder), so
 * the "open a file" affordance stays large and the folder machinery — which
 * a sandboxed phone can't use — is hidden entirely.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { store } from '../store'
import { isMobile, isTauri } from '../platform'
import { pickDirectory } from '../platform/docops'
import {
  addFolder, allTags, coverUrl, progressOf, refreshMissing, removeFolder,
  removeFromLibrary, rescanAll, setTags, toggleFavorite, type LibraryItem,
} from '../library'
import { t } from '../i18n'

const emit = defineEmits<{
  open: [path: string]
  pick: []
  ocrImage: []
  search: []
  toast: [msg: string]
}>()

const query = ref('')
const filter = ref<'all' | 'favorites' | 'reading' | 'unread'>('all')
const tagFilter = ref('')
const sort = ref<'recent' | 'name' | 'progress'>('recent')
const covers = ref<Record<string, string>>({})
const busy = ref(false)
const editingTags = ref<string | null>(null)
const tagText = ref('')
const phone = computed(() => isMobile() || window.innerWidth < 700)

const items = computed<LibraryItem[]>(() => {
  void store.library
  const q = query.value.trim().toLowerCase()
  let list = Object.values(store.library).filter((it) => {
    if (q && !it.name.toLowerCase().includes(q)) return false
    if (tagFilter.value && !(it.tags ?? []).includes(tagFilter.value)) return false
    if (filter.value === 'favorites' && !it.favorite) return false
    const p = progressOf(it)
    if (filter.value === 'reading' && !(p > 0.001 && p < 0.98)) return false
    if (filter.value === 'unread' && p > 0.001) return false
    return true
  })
  list = [...list]
  if (sort.value === 'name') list.sort((a, b) => a.name.localeCompare(b.name))
  else if (sort.value === 'progress') list.sort((a, b) => progressOf(b) - progressOf(a))
  else list.sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt))
  return list
})

async function loadCovers(): Promise<void> {
  for (const it of items.value.slice(0, 120)) {
    if (!it.cover || covers.value[it.path]) continue
    const url = await coverUrl(it)
    if (url) covers.value = { ...covers.value, [it.path]: url }
  }
}
onMounted(async () => {
  await loadCovers()
  void refreshMissing()
})
watch(items, loadCovers)

async function pickFolder(): Promise<void> {
  const dir = await pickDirectory()
  if (!dir) return
  busy.value = true
  try {
    const n = await addFolder(dir)
    emit('toast', t('lb.scanned', { n }))
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}

async function rescan(): Promise<void> {
  busy.value = true
  try {
    emit('toast', t('lb.scanned', { n: await rescanAll() }))
  } finally {
    busy.value = false
  }
}

function startTags(it: LibraryItem): void {
  editingTags.value = it.path
  tagText.value = (it.tags ?? []).join(', ')
}
function saveTags(it: LibraryItem): void {
  setTags(it.path, tagText.value.split(/[,，]/).map((s) => s.trim()))
  editingTags.value = null
}

const KIND_GLYPH: Record<string, string> = { pdf: 'PDF', epub: 'EPUB', txt: 'TXT', other: '·' }
</script>

<template>
  <div class="lb" :class="{ phone }">
    <header class="lb-head">
      <h1>SoloPDF</h1>
      <div class="lb-head-actions">
        <button class="primary" @click="emit('pick')">{{ t('wc.open') }}</button>
        <button v-if="isTauri() && !phone" :disabled="busy" @click="pickFolder">{{ t('lb.addFolder') }}</button>
        <button v-if="isTauri()" @click="emit('ocrImage')">{{ t('wc.ocrImage') }}</button>
        <button v-if="items.length" @click="emit('search')">{{ t('lb.searchAll') }}</button>
      </div>
    </header>

    <div class="lb-controls" v-if="Object.keys(store.library).length">
      <input class="lb-search" v-model="query" :placeholder="t('lb.filter')" />
      <div class="af-chips">
        <button
          v-for="f in (['all', 'reading', 'unread', 'favorites'] as const)" :key="f"
          class="af-chip" :class="{ on: filter === f }"
          @click="filter = f"
        >{{ t('lb.f.' + f) }}</button>
      </div>
      <div class="af-chips" v-if="allTags().length">
        <button class="af-chip" :class="{ on: !tagFilter }" @click="tagFilter = ''">{{ t('sb.all') }}</button>
        <button
          v-for="g in allTags()" :key="g"
          class="af-chip" :class="{ on: tagFilter === g }"
          @click="tagFilter = tagFilter === g ? '' : g"
        >#{{ g }}</button>
      </div>
      <select v-model="sort" class="lb-sort">
        <option value="recent">{{ t('lb.s.recent') }}</option>
        <option value="name">{{ t('lb.s.name') }}</option>
        <option value="progress">{{ t('lb.s.progress') }}</option>
      </select>
    </div>

    <div v-if="!Object.keys(store.library).length" class="lb-empty">
      <p>{{ t('lb.emptyTitle') }}</p>
      <p class="lb-empty-sub">{{ phone ? t('lb.emptyPhone') : t('lb.emptyDesktop') }}</p>
    </div>

    <div v-else class="lb-grid">
      <div
        v-for="it in items" :key="it.path"
        class="lb-item" :class="{ missing: it.missing }"
        @click="!it.missing && emit('open', it.path)"
      >
        <div class="lb-cover">
          <img v-if="covers[it.path]" :src="covers[it.path]" alt="" />
          <div v-else class="lb-cover-ph">{{ KIND_GLYPH[it.kind] }}</div>
          <div class="lb-progress" v-if="progressOf(it) > 0.001">
            <div :style="{ width: progressOf(it) * 100 + '%' }"></div>
          </div>
          <button
            class="lb-fav" :class="{ on: it.favorite }"
            :title="t('lb.favorite')"
            @click.stop="toggleFavorite(it.path)"
          >{{ it.favorite ? '★' : '☆' }}</button>
        </div>
        <div class="lb-name" :title="it.path">{{ it.name }}</div>
        <div class="lb-meta">
          <span v-if="it.missing" class="lb-missing">{{ t('lb.missing') }}</span>
          <span v-else-if="it.pages">{{ t('lb.pages', { n: it.pages }) }}</span>
          <span class="lb-spacer"></span>
          <button class="lb-mini" :title="t('lb.tags')" @click.stop="startTags(it)">#</button>
          <button class="lb-mini" :title="t('lb.remove')" @click.stop="removeFromLibrary(it.path)">✕</button>
        </div>
        <div v-if="editingTags === it.path" class="lb-tagedit" @click.stop>
          <input
            v-model="tagText" :placeholder="t('lb.tagsPlaceholder')"
            @keydown.enter="saveTags(it)" @keydown.esc="editingTags = null"
          />
          <button @click="saveTags(it)">{{ t('sb.save') }}</button>
        </div>
      </div>
    </div>

    <footer class="lb-folders" v-if="isTauri() && !phone && store.libraryFolders.length">
      <span class="lb-folders-label">{{ t('lb.folders') }}</span>
      <span v-for="f in store.libraryFolders" :key="f" class="lb-folder" :title="f">
        {{ f.split('/').pop() }}
        <button @click="removeFolder(f)">✕</button>
      </span>
      <button :disabled="busy" @click="rescan">{{ busy ? t('lb.scanning') : t('lb.rescan') }}</button>
    </footer>
  </div>
</template>
