<script setup lang="ts">
/**
 * Sidebar: outline / thumbnails / bookmarks / annotations.
 * Outline: full tree from doc.getOutline(); each entry's destination is
 * resolved through the same core resolver as in-page links, so a click lands
 * on the exact /XYZ spot (not just the page top) and is recorded in the
 * back/forward history.
 * Thumbnails: IntersectionObserver-driven lazy render at 0.18 scale.
 * Bookmarks: user-placed, from the store (never the sidecar — see store.ts).
 * Annotations: filterable by kind, colour, #tag and free text; sortable.
 */
import { computed, ref, watch, onBeforeUnmount, nextTick } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  store, controllers, documents, annotManagers, labelOf,
  bookmarksFor, removeBookmark, renameBookmark, type Bookmark,
} from '../store'
import { t } from '../i18n'
import { jump } from '../nav'
import { openExternal } from '../platform'
import { resolveDestination, safeExternalUrl, type Annotation, type AnnotationKind, type LinkDest } from '@solopdf/core'

const emit = defineEmits<{ goto: [page: number, block?: number] }>()

const tab = computed(() => store.activeTab)
// registries are plain Maps — touch store.docTick so these recompute on open
const ctrl = computed(() => { void store.docTick; return tab.value ? controllers.get(tab.value.id) : undefined })
const doc = computed(() => { void store.docTick; return tab.value ? documents.get(tab.value.id) : undefined })
const mgr = computed(() => { void store.docTick; return tab.value ? annotManagers.get(tab.value.id) : undefined })

// ── outline ──
interface OutlineNode {
  title: string
  page: number | null
  /** exact destination (page + coordinates), when the entry has one */
  dest: LinkDest | null
  /** entries that point at a web page instead */
  url: string | null
  children: OutlineNode[]
  open: boolean
  depth: number
}
const outline = ref<OutlineNode[]>([])

async function loadOutline(d: PDFDocumentProxy): Promise<void> {
  outline.value = []
  const raw = await d.getOutline().catch(() => null)
  if (!raw) return
  const build = async (items: any[], depth: number): Promise<OutlineNode[]> => {
    const out: OutlineNode[] = []
    for (const it of items) {
      // unresolvable dest → title-only node
      const dest = it.dest != null ? await resolveDestination(d, it.dest) : null
      out.push({
        title: it.title ?? '', page: dest?.page ?? null, dest,
        url: dest ? null : safeExternalUrl(it.url ?? it.unsafeUrl),
        children: it.items?.length ? await build(it.items, depth + 1) : [],
        open: depth < 1,
        depth,
      })
    }
    return out
  }
  outline.value = await build(raw, 0)
}

function flatten(nodes: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = []
  for (const n of nodes) {
    out.push(n)
    if (n.open && n.children.length) out.push(...flatten(n.children))
  }
  return out
}
const flatOutline = computed(() => flatten(outline.value))

// ── thumbnails ──
const thumbHost = ref<HTMLDivElement>()
let observer: IntersectionObserver | null = null
const renderedThumbs = new Set<number>()

async function setupThumbs(): Promise<void> {
  await nextTick()
  observer?.disconnect()
  renderedThumbs.clear()
  const host = thumbHost.value
  const d = doc.value
  if (!host || !d) return
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const el = e.target as HTMLElement
        const p = parseInt(el.dataset.page!, 10)
        if (renderedThumbs.has(p)) continue
        renderedThumbs.add(p)
        void renderThumb(d, p, el)
      }
    },
    { root: host, rootMargin: '200px' },
  )
  host.querySelectorAll('.thumb').forEach((el) => observer!.observe(el))
}

async function renderThumb(d: PDFDocumentProxy, pageNum: number, el: HTMLElement): Promise<void> {
  try {
    const page = await d.getPage(pageNum)
    const vp = page.getViewport({ scale: 0.18 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(vp.width * 2)
    canvas.height = Math.floor(vp.height * 2)
    canvas.style.width = `${vp.width}px`
    canvas.style.height = `${vp.height}px`
    await page.render({
      canvasContext: canvas.getContext('2d', { alpha: false })!,
      viewport: vp,
      transform: [2, 0, 0, 2, 0, 0],
    } as any).promise
    el.querySelector('.thumb-ph')?.replaceWith(canvas)
  } catch { /* thumb render failure is cosmetic */ }
}

// ── bookmarks ──
const bookmarks = computed<Bookmark[]>(() => {
  void store.bookmarks
  return tab.value ? bookmarksFor(tab.value.path) : []
})
const bmEditing = ref<number | null>(null)
const bmLabel = ref('')

function gotoBookmark(b: Bookmark): void {
  emit('goto', b.page, b.block)
  closeIfNarrow()
}
function startBmEdit(b: Bookmark): void {
  bmEditing.value = b.at
  bmLabel.value = b.label
}
function saveBmEdit(b: Bookmark): void {
  if (tab.value) renameBookmark(tab.value.path, b.at, bmLabel.value.trim() || b.label)
  bmEditing.value = null
}

// ── annotations tab ──
const editingId = ref<string | null>(null)
const editText = ref('')
const annots = ref<Annotation[]>([])
const filterKind = ref<'all' | AnnotationKind>('all')
const filterColor = ref<'all' | string>('all')
const filterTag = ref<string>('')
const query = ref('')
const sortBy = ref<'page' | 'recent'>('page')
const previews = ref<Record<string, string>>({})

const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu

function tagsOf(a: Annotation): string[] {
  return [...a.note.matchAll(TAG_RE)].map((m) => m[1])
}

function syncAnnots(): void {
  annots.value = mgr.value ? [...mgr.value.annotations] : []
  void loadPreviews()
}

/** region screenshots get a thumbnail in the list — that's the whole point */
async function loadPreviews(): Promise<void> {
  const m = mgr.value
  if (!m) return
  for (const a of annots.value) {
    if (a.kind !== 'region' || previews.value[a.id]) continue
    const url = await m.assetUrl(a)
    if (url) previews.value = { ...previews.value, [a.id]: url }
  }
}

watch(mgr, (m) => {
  previews.value = {}
  syncAnnots()
  if (m) {
    const prev = m.onChange
    m.onChange = (a) => { prev(a); syncAnnots() }
  }
}, { immediate: true })

const allTags = computed(() => {
  const set = new Set<string>()
  for (const a of annots.value) for (const g of tagsOf(a)) set.add(g)
  return [...set].sort()
})

const usedColors = computed(() => [...new Set(annots.value.map((a) => a.color))])

const shownAnnots = computed(() => {
  const q = query.value.trim().toLowerCase()
  let list = annots.value.filter((a) => {
    if (filterKind.value !== 'all' && (a.kind ?? 'highlight') !== filterKind.value) return false
    if (filterColor.value !== 'all' && a.color !== filterColor.value) return false
    if (filterTag.value && !tagsOf(a).includes(filterTag.value)) return false
    if (q && !(a.excerpt + '\n' + a.note).toLowerCase().includes(q)) return false
    return true
  })
  list = [...list]
  if (sortBy.value === 'page') list.sort((a, b) => a.anchor.page - b.anchor.page)
  else list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return list
})

const KIND_GLYPH: Record<string, string> = {
  highlight: '▮', underline: 'U̲', strike: 'S̶', squiggly: '∿', note: '✎', region: '⬚',
}
const KINDS: (AnnotationKind | 'all')[] = ['all', 'highlight', 'underline', 'strike', 'squiggly', 'note', 'region']

function closeIfNarrow(): void {
  if (window.innerWidth < 700) store.settings.sidebarOpen = false
}
/** every sidebar jump goes through the tab's back/forward history */
function jumpPage(p: number): void {
  const c = ctrl.value
  if (tab.value && c) jump(tab.value.id, () => { c.scrollToPage(p); c.settle() })
  closeIfNarrow()
}
function followOutline(n: OutlineNode): void {
  if (n.url) { void openExternal(n.url); return }
  if (n.dest) ctrl.value?.goToDest(n.dest)
  else if (n.page) { jumpPage(n.page); return }
  else return
  closeIfNarrow()
}
function jumpTo(a: Annotation): void {
  if (a.orphan) return
  const c = ctrl.value
  if (tab.value && c) jump(tab.value.id, () => c.flashAnnotation(a.id))
  closeIfNarrow()
}
function startEdit(a: Annotation): void {
  editingId.value = a.id
  editText.value = a.note
}
async function saveEdit(a: Annotation): Promise<void> {
  await mgr.value?.updateNote(a.id, editText.value)
  editingId.value = null
}
async function removeAnnot(a: Annotation): Promise<void> {
  await mgr.value?.remove(a.id)
}

// reload sidebar data when the document changes
watch([doc, () => store.settings.sidebarTab], async ([d]) => {
  if (!d) return
  if (store.settings.sidebarTab === 'outline') await loadOutline(d)
  if (store.settings.sidebarTab === 'thumbs') await setupThumbs()
}, { immediate: true })

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="sidebar" v-if="tab">
    <div class="sidebar-tabs">
      <button :class="{ active: store.settings.sidebarTab === 'outline' }" @click="store.settings.sidebarTab = 'outline'">{{ t('sb.outline') }}</button>
      <button :class="{ active: store.settings.sidebarTab === 'thumbs' }" @click="store.settings.sidebarTab = 'thumbs'">{{ t('sb.thumbs') }}</button>
      <button :class="{ active: store.settings.sidebarTab === 'marks' }" @click="store.settings.sidebarTab = 'marks'">{{ t('sb.marks') }}</button>
      <button :class="{ active: store.settings.sidebarTab === 'annots' }" @click="store.settings.sidebarTab = 'annots'">{{ t('sb.annots') }}</button>
    </div>

    <div class="sidebar-body" v-if="store.settings.sidebarTab === 'outline'">
      <div v-if="!flatOutline.length" class="annot-empty">{{ t('sb.noOutline') }}</div>
      <div
        v-for="(n, i) in flatOutline"
        :key="i"
        class="outline-item"
        :style="{ paddingLeft: `${n.depth * 14}px` }"
      >
        <span
          class="outline-toggle"
          @click.stop="n.open = !n.open"
        >{{ n.children.length ? (n.open ? '▾' : '▸') : '' }}</span>
        <span class="ol-title" :title="n.url ?? n.title" @click="followOutline(n)">{{ n.title }}</span>
        <span class="ol-page" v-if="n.page">{{ labelOf(tab, n.page) }}</span>
      </div>
    </div>

    <div class="sidebar-body" v-else-if="store.settings.sidebarTab === 'thumbs'" ref="thumbHost">
      <div
        v-for="p in tab.numPages"
        :key="p"
        class="thumb"
        :class="{ current: p === tab.currentPage }"
        :data-page="p"
        @click="jumpPage(p)"
      >
        <div class="thumb-ph" style="width: 110px; height: 150px"></div>
        <div class="thumb-num">
          {{ labelOf(tab, p) }}<span v-if="labelOf(tab, p) !== String(p)" class="thumb-phys"> · {{ p }}</span>
        </div>
      </div>
    </div>

    <div class="sidebar-body" v-else-if="store.settings.sidebarTab === 'marks'">
      <div v-if="!bookmarks.length" class="annot-empty">{{ t('sb.noMarks') }}</div>
      <div v-for="b in bookmarks" :key="b.at" class="bm-item" @click="gotoBookmark(b)">
        <template v-if="bmEditing === b.at">
          <input
            v-model="bmLabel" class="bm-input" @click.stop
            @keydown.enter="saveBmEdit(b)" @keydown.esc="bmEditing = null"
          />
          <button @click.stop="saveBmEdit(b)">{{ t('sb.save') }}</button>
        </template>
        <template v-else>
          <span class="bm-star">★</span>
          <span class="bm-label" :title="b.label">{{ b.label }}</span>
          <span class="bm-page" :title="`${b.page} / ${tab.numPages}`">p.{{ labelOf(tab, b.page) }}</span>
          <button class="bm-btn" :title="t('sb.rename')" @click.stop="startBmEdit(b)">✎</button>
          <button class="bm-btn" :title="t('sb.delete')" @click.stop="removeBookmark(tab.path, b.at)">✕</button>
        </template>
      </div>
    </div>

    <div class="sidebar-body annots-body" v-else>
      <div class="annot-filters">
        <input class="af-search" v-model="query" :placeholder="t('sb.search')" />
        <div class="af-chips">
          <button
            v-for="k in KINDS" :key="k"
            class="af-chip" :class="{ on: filterKind === k }"
            :title="k === 'all' ? t('sb.allKinds') : t('hl.kind.' + k)"
            @click="filterKind = k"
          >{{ k === 'all' ? t('sb.all') : KIND_GLYPH[k] }}</button>
        </div>
        <div class="af-chips" v-if="usedColors.length > 1">
          <button class="af-chip" :class="{ on: filterColor === 'all' }" @click="filterColor = 'all'">{{ t('sb.all') }}</button>
          <button
            v-for="c in usedColors" :key="c"
            class="af-chip af-color" :class="[`sw-${c}`, { on: filterColor === c }]"
            @click="filterColor = c"
          />
        </div>
        <div class="af-chips" v-if="allTags.length">
          <button class="af-chip" :class="{ on: !filterTag }" @click="filterTag = ''">{{ t('sb.all') }}</button>
          <button
            v-for="g in allTags" :key="g"
            class="af-chip" :class="{ on: filterTag === g }"
            @click="filterTag = filterTag === g ? '' : g"
          >#{{ g }}</button>
        </div>
        <div class="af-sort">
          <button :class="{ on: sortBy === 'page' }" @click="sortBy = 'page'">{{ t('sb.byPage') }}</button>
          <button :class="{ on: sortBy === 'recent' }" @click="sortBy = 'recent'">{{ t('sb.byRecent') }}</button>
        </div>
      </div>

      <div v-if="!annots.length" class="annot-empty">
        <span v-html="t('sb.annotEmpty')"></span>
      </div>
      <div v-else-if="!shownAnnots.length" class="annot-empty">{{ t('sb.noMatch') }}</div>
      <div
        v-for="a in shownAnnots"
        :key="a.id"
        class="annot-item"
        :class="{ orphan: a.orphan }"
        @click="jumpTo(a)"
      >
        <img v-if="previews[a.id]" class="ai-thumb" :src="previews[a.id]" alt="" />
        <div class="ai-excerpt" v-if="a.excerpt">{{ a.excerpt }}</div>
        <template v-if="editingId === a.id">
          <textarea v-model="editText" @click.stop @keydown.enter.meta="saveEdit(a)" />
          <div class="ai-meta">
            <button @click.stop="saveEdit(a)">{{ t('sb.save') }}</button>
            <button @click.stop="editingId = null">{{ t('sb.cancel') }}</button>
          </div>
        </template>
        <template v-else>
          <div class="ai-note" v-if="a.note">{{ a.note }}</div>
          <div class="ai-meta">
            <span class="ai-kind" :class="`sw-${a.color}`">{{ KIND_GLYPH[a.kind ?? 'highlight'] }}</span>
            <span :title="`${a.anchor.page} / ${tab.numPages}`">p.{{ labelOf(tab, a.anchor.page) }}</span>
            <span v-if="a.orphan" :title="t('sb.orphanTip')">{{ t('sb.orphan') }}</span>
            <span style="flex: 1"></span>
            <button @click.stop="startEdit(a)">{{ t('sb.edit') }}</button>
            <button @click.stop="removeAnnot(a)">{{ t('sb.delete') }}</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
