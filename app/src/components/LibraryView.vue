<script setup lang="ts">
/**
 * The shelf — what you see when no document is open.
 *
 * Supports two views:
 *   - Cover grid (default): visual bookshelf with covers & reading progress.
 *   - Academic table: paper metadata (title, authors, year, venue, DOI,
 *     reading status, tags), quick cite copy (\cite{key}, [@key], BibTeX,
 *     APA, GB/T 7714), inline metadata editing, and shelf-level .bib
 *     export / import.
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  citeKey, doiUrl, exportBibtexLibrary, fetchDoiMetadata, formatAuthorsShort, formatCitation,
  parseAuthorName, splitAuthors, toBibtex, type CitationMeta,
} from '@solopdf/core'
import { store } from '../store'
import { isMobile, isTauri, platform } from '../platform'
import { pickDirectory } from '../platform/docops'
import { copyText } from '../clipboard'
import {
  addFolder, allTags, citeKeyOf, citeOf, coverUrl, cycleReadStatus,
  extractMissingMetadata, importBibtexToLibrary, progressOf, refreshMissing,
  removeFolder, removeFromLibrary, rescanAll, setLibraryCite, setTags,
  statusOf, toggleFavorite, type LibraryItem,
} from '../library'
import { t } from '../i18n'
import { isSupporter, initSupporterState } from '../supporter'
import SupportDialog from './SupportDialog.vue'

const emit = defineEmits<{
  open: [path: string]
  pick: []
  ocrImage: []
  search: []
  toast: [msg: string]
}>()

const query = ref('')
const filter = ref<'all' | 'favorites' | 'reading' | 'unread' | 'done'>('all')
const tagFilter = ref('')
const sort = ref<'recent' | 'name' | 'year' | 'author' | 'progress'>('recent')
const viewMode = computed<'grid' | 'table'>({
  get: () => store.settings.libraryView ?? 'grid',
  set: (v) => { store.settings.libraryView = v },
})
const covers = ref<Record<string, string>>({})
const busy = ref(false)
const editingTags = ref<string | null>(null)
const tagText = ref('')
const showSupport = ref(false)
const phone = computed(() => isMobile() || window.innerWidth < 700)

// ── quick-cite popover ──
const citeMenuPath = ref<string | null>(null)

// ── metadata editor modal ──
const editMetaItem = ref<LibraryItem | null>(null)
const metaForm = ref({ title: '', authors: '', year: '', journal: '', doi: '', arxiv: '', key: '' })
const fetchingMeta = ref(false)

// ── batch metadata extraction ──
const indexing = ref<{ done: number; total: number } | null>(null)
let indexSignal: { cancelled: boolean } | null = null
const unindexedCount = computed(() => {
  void store.library
  return Object.values(store.library).filter((it) => it.kind === 'pdf' && !it.missing && !it.cite).length
})

async function toggleBatchExtract(): Promise<void> {
  if (indexing.value && indexSignal) {
    indexSignal.cancelled = true
    return
  }
  const signal = { cancelled: false }
  indexSignal = signal
  const list = Object.values(store.library)
  try {
    const res = await extractMissingMetadata(list, (done, total) => {
      indexing.value = { done, total }
    }, signal)
    emit('toast', t('lb.extracted', { n: res.updated }))
  } finally {
    indexing.value = null
    indexSignal = null
  }
}

// ── .bib import modal ──
const bibImportOpen = ref(false)
const bibImportText = ref('')

function displayTitle(it: LibraryItem): string {
  return it.cite?.title?.trim() || it.name
}

function displayAuthors(it: LibraryItem): string {
  return it.cite?.authors?.length ? formatAuthorsShort(it.cite.authors) : ''
}

function displayVenue(it: LibraryItem): string {
  if (it.cite?.journal) return it.cite.journal
  if (it.cite?.arxiv) return `arXiv:${it.cite.arxiv}`
  if (it.cite?.publisher) return it.cite.publisher
  return ''
}

const items = computed<LibraryItem[]>(() => {
  void store.library
  const q = query.value.trim().toLowerCase()
  let list = Object.values(store.library).filter((it) => {
    if (q) {
      const hay = [
        it.name,
        it.cite?.title,
        ...(it.cite?.authors ?? []).map((a) => a.literal || `${a.given ?? ''} ${a.family}`),
        it.cite?.journal,
        it.cite?.doi,
        it.cite?.arxiv,
        it.cite?.year ? String(it.cite.year) : '',
        it.citeKey,
        ...(it.tags ?? []),
      ].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (tagFilter.value && !(it.tags ?? []).includes(tagFilter.value)) return false
    if (filter.value === 'favorites' && !it.favorite) return false
    const st = statusOf(it)
    if (filter.value === 'reading' && st !== 'reading') return false
    if (filter.value === 'unread' && st !== 'unread') return false
    if (filter.value === 'done' && st !== 'done') return false
    return true
  })
  list = [...list]
  if (sort.value === 'name') list.sort((a, b) => displayTitle(a).localeCompare(displayTitle(b)))
  else if (sort.value === 'year') list.sort((a, b) => (b.cite?.year ?? 0) - (a.cite?.year ?? 0) || displayTitle(a).localeCompare(displayTitle(b)))
  else if (sort.value === 'author') list.sort((a, b) => (displayAuthors(a) || '\uffff').localeCompare(displayAuthors(b) || '\uffff'))
  else if (sort.value === 'progress') list.sort((a, b) => progressOf(b) - progressOf(a))
  else list.sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt))
  return list
})

async function loadCovers(): Promise<void> {
  if (viewMode.value !== 'grid') return
  for (const it of items.value.slice(0, 120)) {
    if (!it.cover || covers.value[it.path]) continue
    const url = await coverUrl(it)
    if (url) covers.value = { ...covers.value, [it.path]: url }
  }
}
onMounted(async () => {
  await loadCovers()
  void refreshMissing()
  void initSupporterState()
})
watch([items, viewMode], loadCovers)

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

// ── quick cite ──
async function copyQuickCite(it: LibraryItem, mode: 'latex' | 'pandoc' | 'bibtex' | 'apa' | 'gbt'): Promise<void> {
  const meta = citeOf(it)
  const key = citeKeyOf(it)
  let out = ''
  let preview = ''
  if (mode === 'latex') { out = `\\cite{${key}}`; preview = out }
  else if (mode === 'pandoc') { out = `[@${key}]`; preview = out }
  else if (mode === 'bibtex') { out = toBibtex(meta, key); preview = `BibTeX (${key})` }
  else if (mode === 'apa') { out = formatCitation(meta, 'apa'); preview = 'APA' }
  else { out = formatCitation(meta, 'gbt'); preview = 'GB/T 7714' }
  citeMenuPath.value = null
  emit('toast', (await copyText(out)) ? t('lb.citeCopied', { text: preview }) : t('app.copyFail'))
}

// ── export / import .bib ──
async function exportBib(): Promise<void> {
  const list = items.value.filter((it) => it.kind === 'pdf' || !!it.cite)
  if (!list.length) {
    emit('toast', t('lb.bibEmpty'))
    return
  }
  const { bib } = exportBibtexLibrary(list.map((it) => ({ meta: citeOf(it), key: it.citeKey })))
  try {
    const saved = await platform().saveText('references.bib', bib)
    if (saved) {
      emit('toast', t('lb.bibExported', { n: list.length }))
      return
    }
  } catch {
    // fall back to clipboard if save dialog fails
  }
  if (await copyText(bib)) emit('toast', t('lb.bibCopied', { n: list.length }))
}

function onBibFilePicked(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  void file.text().then((txt) => { bibImportText.value = txt })
}

function applyBibImport(): void {
  const txt = bibImportText.value.trim()
  if (!txt) return
  const res = importBibtexToLibrary(txt)
  bibImportOpen.value = false
  bibImportText.value = ''
  emit('toast', t('lb.bibImported', res))
}

// ── inline metadata editor ──
function openMetaEditor(it: LibraryItem): void {
  const m = citeOf(it)
  editMetaItem.value = it
  fetchingMeta.value = false
  metaForm.value = {
    title: m.title,
    authors: m.authors.map((a) => a.literal ?? (a.given ? `${a.given} ${a.family}` : a.family)).join('; '),
    year: m.year ? String(m.year) : '',
    journal: m.journal ?? '',
    doi: m.doi ?? '',
    arxiv: m.arxiv ?? '',
    key: citeKeyOf(it),
  }
}

function buildMetaFromForm(it: LibraryItem): CitationMeta {
  const base = citeOf(it)
  const authors = metaForm.value.authors
    .split(/\s*;\s*/)
    .filter(Boolean)
    .flatMap((s) => splitAuthors(s))
    .map(parseAuthorName)
  const yearNum = /^\d{4}$/.test(metaForm.value.year.trim()) ? parseInt(metaForm.value.year.trim(), 10) : undefined
  const cleanDoi = metaForm.value.doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '') || undefined
  const cleanArxiv = metaForm.value.arxiv.trim().replace(/^arxiv:\s*/i, '').replace(/^https?:\/\/arxiv\.org\/abs\//i, '') || undefined
  const journal = metaForm.value.journal.trim() || undefined
  return {
    ...base,
    title: metaForm.value.title.trim() || base.title,
    authors,
    year: yearNum,
    journal,
    doi: cleanDoi,
    arxiv: cleanArxiv,
    url: cleanDoi ? doiUrl(cleanDoi) : cleanArxiv ? `https://arxiv.org/abs/${cleanArxiv}` : base.url,
    type: journal ? 'article' : cleanArxiv ? 'preprint' : base.type,
    source: { title: 'none', authors: 'none', year: 'none' },
  }
}

async function fetchOnlineMeta(): Promise<void> {
  const it = editMetaItem.value
  if (!it || fetchingMeta.value) return
  const draft = buildMetaFromForm(it)
  if (!draft.doi && !draft.arxiv) return
  fetchingMeta.value = true
  try {
    const fresh = await fetchDoiMetadata(draft, fetch)
    metaForm.value = {
      title: fresh.title,
      authors: fresh.authors.map((a) => a.literal ?? (a.given ? `${a.given} ${a.family}` : a.family)).join('; '),
      year: fresh.year ? String(fresh.year) : '',
      journal: fresh.journal ?? '',
      doi: fresh.doi ?? '',
      arxiv: fresh.arxiv ?? '',
      key: citeKey(fresh),
    }
    emit('toast', t('lb.fetchDone'))
  } catch (err) {
    const code = String((err as Error)?.message ?? err)
    const key = ['noIdentifier', 'doiNotFound', 'timeout', 'network'].includes(code) ? `ci.err.${code}` : ''
    emit('toast', key ? t(key) : code)
  } finally {
    fetchingMeta.value = false
  }
}

function saveMetaEditor(): void {
  const it = editMetaItem.value
  if (!it) return
  const updated = buildMetaFromForm(it)
  setLibraryCite(it.path, updated, metaForm.value.key)
  editMetaItem.value = null
  emit('toast', t('lb.metaSaved'))
}

const KIND_GLYPH: Record<string, string> = {
  pdf: 'PDF', epub: 'EPUB', txt: 'TXT', mobi: 'MOBI', comic: 'CBZ', djvu: 'DJVU', fb2: 'FB2', tiff: 'TIFF', other: '·',
}
</script>

<template>
  <div class="lb" :class="{ phone }" @click="citeMenuPath = null">
    <header class="lb-head">
      <h1>SoloPDF</h1>
      <div class="lb-head-actions">
        <button class="primary" @click="emit('pick')">{{ t('wc.open') }}</button>
        <button v-if="isTauri() && !phone" :disabled="busy" @click="pickFolder">{{ t('lb.addFolder') }}</button>
        <button v-if="isTauri()" @click="emit('ocrImage')">{{ t('wc.ocrImage') }}</button>
        <button v-if="items.length" @click="emit('search')">{{ t('lb.searchAll') }}</button>
        <button v-if="unindexedCount > 0 || indexing" @click="toggleBatchExtract">
          {{ indexing ? t('lb.extracting', indexing) : t('lb.extractMeta', { n: unindexedCount }) }}
        </button>
        <button v-if="Object.keys(store.library).length" @click="exportBib">{{ t('lb.exportBib') }}</button>
        <button v-if="Object.keys(store.library).length" @click="bibImportOpen = true">{{ t('lb.importBib') }}</button>
        <button @click="showSupport = true" :title="t('sup.title')">
          {{ isSupporter ? '✨ ' + t('sup.badge') : '❤️ ' + t('sup.btn') }}
        </button>
      </div>
    </header>

    <div class="lb-controls" v-if="Object.keys(store.library).length">
      <input class="lb-search" v-model="query" :placeholder="t('lb.filterAcademic')" />
      <div class="af-chips">
        <button
          v-for="f in (['all', 'reading', 'unread', 'done', 'favorites'] as const)" :key="f"
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
        <option value="year">{{ t('lb.s.year') }}</option>
        <option value="author">{{ t('lb.s.author') }}</option>
        <option value="progress">{{ t('lb.s.progress') }}</option>
      </select>
      <div class="lb-view-toggle" role="group">
        <button :class="{ on: viewMode === 'grid' }" :title="t('lb.viewGrid')" @click="viewMode = 'grid'">⊞</button>
        <button :class="{ on: viewMode === 'table' }" :title="t('lb.viewTable')" @click="viewMode = 'table'">☰</button>
      </div>
    </div>

    <div v-if="!Object.keys(store.library).length" class="lb-empty">
      <p>{{ t('lb.emptyTitle') }}</p>
      <p class="lb-empty-sub">{{ phone ? t('lb.emptyPhone') : t('lb.emptyDesktop') }}</p>
    </div>

    <!-- Academic table view -->
    <div v-else-if="viewMode === 'table'" class="lb-table-wrap">
      <table class="lb-table">
        <thead>
          <tr>
            <th class="col-fav"></th>
            <th class="col-status">{{ t('lb.col.status') }}</th>
            <th class="col-title">{{ t('lb.col.title') }}</th>
            <th class="col-author" v-if="!phone">{{ t('lb.col.author') }}</th>
            <th class="col-year">{{ t('lb.col.year') }}</th>
            <th class="col-tags" v-if="!phone">{{ t('lb.col.tags') }}</th>
            <th class="col-actions">{{ t('lb.col.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="it in items" :key="it.path"
            :class="{ missing: it.missing }"
            @click="!it.missing && emit('open', it.path)"
          >
            <td class="col-fav" @click.stop>
              <button class="lb-tbl-fav" :class="{ on: it.favorite }" :title="t('lb.favorite')" @click="toggleFavorite(it.path)">
                {{ it.favorite ? '★' : '☆' }}
              </button>
            </td>
            <td class="col-status" @click.stop>
              <button
                class="lb-status"
                :class="`st-${statusOf(it)}`"
                :title="t('lb.stTip')"
                @click="cycleReadStatus(it.path)"
              >{{ t('lb.st.' + statusOf(it)) }}</button>
            </td>
            <td class="col-title">
              <div class="lb-tbl-title" :title="it.path">{{ displayTitle(it) }}</div>
              <div class="lb-tbl-sub">
                <span v-if="it.missing" class="lb-missing">{{ t('lb.missing') }}</span>
                <template v-else>
                  <span v-if="phone && displayAuthors(it)">{{ displayAuthors(it) }} · </span>
                  <span v-if="displayVenue(it)">{{ displayVenue(it) }}</span>
                  <span v-else>{{ it.name }}</span>
                  <span v-if="it.cite?.doi" class="lb-tbl-doi"> · {{ it.cite.doi }}</span>
                </template>
              </div>
              <div v-if="editingTags === it.path" class="lb-tagedit" @click.stop>
                <input
                  v-model="tagText" :placeholder="t('lb.tagsPlaceholder')"
                  @keydown.enter="saveTags(it)" @keydown.esc="editingTags = null"
                />
                <button @click="saveTags(it)">{{ t('sb.save') }}</button>
              </div>
            </td>
            <td class="col-author" v-if="!phone">{{ displayAuthors(it) || '—' }}</td>
            <td class="col-year">{{ it.cite?.year ?? '—' }}</td>
            <td class="col-tags" v-if="!phone" @click.stop>
              <div class="lb-tbl-tags">
                <span v-for="g in (it.tags ?? [])" :key="g" class="lb-tag-pill" @click="tagFilter = tagFilter === g ? '' : g">#{{ g }}</span>
                <button class="lb-mini" :title="t('lb.tags')" @click="startTags(it)">+</button>
              </div>
            </td>
            <td class="col-actions" @click.stop>
              <div class="lb-act-group">
                <div class="lb-cite-wrap">
                  <button class="lb-mini" :title="t('lb.quickCite')" @click="citeMenuPath = citeMenuPath === it.path ? null : it.path">❝</button>
                  <div v-if="citeMenuPath === it.path" class="lb-cite-pop">
                    <button @click="copyQuickCite(it, 'latex')">\cite{{ '{' + citeKeyOf(it) + '}' }}</button>
                    <button @click="copyQuickCite(it, 'pandoc')">[@{{ citeKeyOf(it) }}]</button>
                    <button @click="copyQuickCite(it, 'bibtex')">BibTeX</button>
                    <button @click="copyQuickCite(it, 'apa')">APA</button>
                    <button @click="copyQuickCite(it, 'gbt')">GB/T 7714</button>
                  </div>
                </div>
                <button class="lb-mini" :title="t('lb.editMeta')" @click="openMetaEditor(it)">✎</button>
                <button class="lb-mini" :title="t('lb.remove')" @click="removeFromLibrary(it.path)">✕</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Cover grid view -->
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
        <div class="lb-name" :title="it.path">{{ displayTitle(it) }}</div>
        <div v-if="displayAuthors(it) || it.cite?.year" class="lb-acad-sub">
          {{ [displayAuthors(it), it.cite?.year].filter(Boolean).join(' · ') }}
        </div>
        <div class="lb-meta">
          <span v-if="it.missing" class="lb-missing">{{ t('lb.missing') }}</span>
          <span v-else-if="it.pages">{{ t('lb.pages', { n: it.pages }) }}</span>
          <span class="lb-spacer"></span>
          <button class="lb-mini" :title="t('lb.quickCite')" @click.stop="copyQuickCite(it, 'latex')">❝</button>
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

    <!-- Edit academic metadata modal -->
    <div v-if="editMetaItem" class="modal-backdrop" @click.self="editMetaItem = null">
      <div class="modal lb-meta-modal">
        <div class="modal-head">
          <h3>{{ t('lb.editMeta') }}</h3>
          <button @click="editMetaItem = null">✕</button>
        </div>
        <div class="lb-form">
          <label>{{ t('lb.meta.title') }}<input v-model="metaForm.title" /></label>
          <label>{{ t('lb.meta.authors') }}<input v-model="metaForm.authors" /></label>
          <div class="lb-form-row">
            <label>{{ t('lb.meta.year') }}<input v-model="metaForm.year" inputmode="numeric" /></label>
            <label>{{ t('lb.meta.key') }}<input v-model="metaForm.key" /></label>
          </div>
          <label>{{ t('lb.meta.venue') }}<input v-model="metaForm.journal" /></label>
          <div class="lb-form-row">
            <label>{{ t('lb.meta.arxiv') }}<input v-model="metaForm.arxiv" placeholder="1706.03762" /></label>
            <label>{{ t('lb.meta.doi') }}<input v-model="metaForm.doi" placeholder="10.xxxx/..." /></label>
          </div>
        </div>
        <div class="modal-foot">
          <button
            :disabled="fetchingMeta || (!metaForm.doi.trim() && !metaForm.arxiv.trim())"
            @click="fetchOnlineMeta"
          >{{ fetchingMeta ? t('lb.fetchingOnline') : t('lb.fetchOnline') }}</button>
          <span class="lb-spacer"></span>
          <button @click="editMetaItem = null">{{ t('ocr.cancel') }}</button>
          <button class="primary" @click="saveMetaEditor">{{ t('sb.save') }}</button>
        </div>
      </div>
    </div>

    <!-- Import .bib modal -->
    <div v-if="bibImportOpen" class="modal-backdrop" @click.self="bibImportOpen = false">
      <div class="modal lb-bib-modal">
        <div class="modal-head">
          <h3>{{ t('lb.bibImportTitle') }}</h3>
          <button @click="bibImportOpen = false">✕</button>
        </div>
        <p class="lb-bib-hint">{{ t('lb.bibImportHint') }}</p>
        <div class="lb-bib-file">
          <label class="lb-file-btn">
            {{ t('lb.bibChooseFile') }}
            <input type="file" accept=".bib,text/plain" hidden @change="onBibFilePicked" />
          </label>
        </div>
        <textarea
          v-model="bibImportText"
          class="lb-bib-area"
          rows="8"
          :placeholder="t('lb.bibPastePlaceholder')"
        />
        <div class="modal-foot">
          <button @click="bibImportOpen = false">{{ t('ocr.cancel') }}</button>
          <button class="primary" :disabled="!bibImportText.trim()" @click="applyBibImport">{{ t('lb.bibApply') }}</button>
        </div>
      </div>
    </div>

    <SupportDialog v-if="showSupport" @close="showSupport = false" />
  </div>
</template>
