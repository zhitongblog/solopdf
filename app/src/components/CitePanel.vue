<script setup lang="ts">
/**
 * Document info + "Copy citation" (Zotero / Google Scholar reader style).
 *
 * Offline by default: title, authors, year, DOI and arXiv id come from the
 * PDF's XMP / Info dictionary and its first two pages (core/cite.ts). Every
 * field is editable here — heuristics are wrong sometimes, and fixing a typo
 * beats re-typing a BibTeX entry. "Fetch exact metadata" is the only path
 * that goes online, and only when clicked: it asks doi.org for the record.
 */
import { computed, onMounted, ref } from 'vue'
import {
  readCitationInput, extractCitation, formatCitation, fetchDoiMetadata, splitAuthors, parseAuthorName,
  pageDeepLink, doiUrl, type CitationMeta, type CiteFormat,
} from '@solopdf/core'
import { store, documents } from '../store'
import { openExternal } from '../platform'
import { copyText } from '../clipboard'
import { t } from '../i18n'

const emit = defineEmits<{ close: []; toast: [msg: string] }>()

const tab = computed(() => store.activeTab)
const meta = ref<CitationMeta | null>(null)
const loading = ref(true)
const online = ref<'idle' | 'busy' | 'done' | 'error'>('idle')
const onlineMsg = ref('')
const fmt = computed<CiteFormat>({
  get: () => store.settings.aids.citeFormat,
  set: (v) => { store.settings.aids.citeFormat = v },
})

onMounted(async () => {
  const tb = tab.value
  const doc = tb && documents.get(tb.id)
  if (!tb || !doc) { loading.value = false; return }
  try {
    const input = await readCitationInput(doc as never, tb.path.split('/').pop() ?? '')
    meta.value = extractCitation(input)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    loading.value = false
  }
})

const authorsText = computed({
  get: () => (meta.value?.authors ?? []).map((a) => a.literal ?? (a.given ? `${a.given} ${a.family}` : a.family)).join('; '),
  set: (v: string) => {
    if (!meta.value) return
    meta.value.authors = v.split(/\s*;\s*/).filter(Boolean).flatMap((s) => splitAuthors(s)).map(parseAuthorName)
    meta.value.source.authors = 'none'
  },
})
const yearText = computed({
  get: () => (meta.value?.year ? String(meta.value.year) : ''),
  set: (v: string) => { if (meta.value) meta.value.year = /^\d{4}$/.test(v.trim()) ? parseInt(v, 10) : undefined },
})
const doiText = computed({
  get: () => meta.value?.doi ?? '',
  set: (v: string) => {
    if (!meta.value) return
    const d = v.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
    meta.value.doi = d || undefined
    meta.value.url = d ? doiUrl(d) : meta.value.arxiv ? `https://arxiv.org/abs/${meta.value.arxiv}` : undefined
  },
})

const citation = computed(() => (meta.value ? formatCitation(meta.value, fmt.value) : ''))
const canFetch = computed(() => !!(meta.value?.doi || meta.value?.arxiv))

const SOURCE_KEYS: Record<string, string> = {
  xmp: 'ci.src.xmp', info: 'ci.src.info', firstPage: 'ci.src.firstPage', fileName: 'ci.src.fileName',
  online: 'ci.src.online', arxiv: 'ci.src.arxiv', none: 'ci.src.manual',
}
const srcLabel = (k: string): string => t(SOURCE_KEYS[k] ?? 'ci.src.manual')

async function copyCitation(): Promise<void> {
  if (!citation.value) return
  emit('toast', (await copyText(citation.value)) ? t('ci.copied', { fmt: t('ci.fmt.' + fmt.value) }) : t('app.copyFail'))
}

async function copyPageLink(): Promise<void> {
  const tb = tab.value
  if (!tb) return
  const link = pageDeepLink(tb.path, tb.currentPage)
  emit('toast', (await copyText(link)) ? t('ci.linkCopied', { page: tb.currentPage }) : t('app.copyFail'))
}

async function fetchExact(): Promise<void> {
  const m = meta.value
  if (!m || online.value === 'busy') return
  online.value = 'busy'
  onlineMsg.value = ''
  try {
    meta.value = await fetchDoiMetadata(m, (url, init) => fetch(url, init))
    online.value = 'done'
  } catch (err) {
    const code = String((err as Error).message ?? err)
    online.value = 'error'
    onlineMsg.value = code === 'doiNotFound' ? t('ci.err.notFound')
      : code === 'timeout' ? t('ci.err.timeout')
        : t('ci.err.network', { msg: code })
  }
}

defineExpose({ meta, citation, fetchExact, copyCitation, copyPageLink })
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal cite-panel">
      <h3>{{ t('ci.title') }}</h3>
      <p v-if="loading" class="modal-note">{{ t('ci.reading') }}</p>
      <template v-else-if="meta">
        <div class="ci-grid">
          <label>{{ t('ci.f.title') }}</label>
          <div class="ci-field">
            <input type="text" v-model="meta.title" @input="meta.source.title = 'none'" />
            <span class="ci-src">{{ srcLabel(meta.source.title) }}</span>
          </div>
          <label>{{ t('ci.f.authors') }}</label>
          <div class="ci-field">
            <input type="text" v-model.lazy="authorsText" :placeholder="t('ci.authorsPh')" />
            <span class="ci-src">{{ meta.authors.length ? srcLabel(meta.source.authors) : t('ci.none') }}</span>
          </div>
          <label>{{ t('ci.f.year') }}</label>
          <div class="ci-field ci-short">
            <input type="text" inputmode="numeric" v-model.lazy="yearText" />
            <span class="ci-src">{{ meta.year ? srcLabel(meta.source.year) : t('ci.none') }}</span>
          </div>
          <label>DOI</label>
          <div class="ci-field">
            <input type="text" v-model.lazy="doiText" :placeholder="t('ci.none')" />
            <button v-if="meta.doi" class="ci-link" :title="doiUrl(meta.doi)" @click="openExternal(doiUrl(meta.doi))">↗</button>
          </div>
          <template v-if="meta.arxiv">
            <label>arXiv</label>
            <div class="ci-field">
              <span class="ci-id">{{ meta.arxiv }}{{ meta.arxivVersion ?? '' }}</span>
              <button class="ci-link" @click="openExternal(`https://arxiv.org/abs/${meta.arxiv}`)">↗</button>
            </div>
          </template>
          <template v-if="meta.journal">
            <label>{{ t('ci.f.journal') }}</label>
            <div class="ci-field"><input type="text" v-model="meta.journal" /></div>
          </template>
        </div>

        <div class="vm-seg ci-fmt">
          <button :class="{ active: fmt === 'bibtex' }" @click="fmt = 'bibtex'">BibTeX</button>
          <button :class="{ active: fmt === 'apa' }" @click="fmt = 'apa'">APA</button>
          <button :class="{ active: fmt === 'gbt' }" @click="fmt = 'gbt'">GB/T 7714</button>
        </div>
        <pre class="ci-out" data-testid="cite-out">{{ citation }}</pre>

        <div class="ci-online">
          <button :disabled="!canFetch || online === 'busy'" @click="fetchExact()">
            {{ online === 'busy' ? t('ci.fetching') : t('ci.fetch') }}
          </button>
          <span class="ci-note">
            <template v-if="online === 'done'">✓ {{ t('ci.fetched') }}</template>
            <template v-else-if="online === 'error'">{{ onlineMsg }}</template>
            <template v-else-if="canFetch">{{ t('ci.fetchNote') }}</template>
            <template v-else>{{ t('ci.noId') }}</template>
          </span>
        </div>
      </template>
      <div class="modal-actions">
        <button @click="copyPageLink()">{{ t('ci.copyLink') }}</button>
        <button @click="emit('close')">{{ t('ci.close') }}</button>
        <button class="primary" :disabled="!citation" @click="copyCitation()">{{ t('ci.copy') }}</button>
      </div>
    </div>
  </div>
</template>
