<script setup lang="ts">
/**
 * Sidebar: outline / thumbnails / annotations.
 * Outline: full tree from doc.getOutline(), lazy dest->page resolution.
 * Thumbnails: IntersectionObserver-driven lazy render at 0.18 scale.
 */
import { computed, ref, watch, onBeforeUnmount, nextTick } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { store, controllers, documents, annotManagers } from '../store'
import { t } from '../i18n'
import type { Annotation } from '@solopdf/core'

const tab = computed(() => store.activeTab)
// registries are plain Maps — touch store.docTick so these recompute on open
const ctrl = computed(() => { void store.docTick; return tab.value ? controllers.get(tab.value.id) : undefined })
const doc = computed(() => { void store.docTick; return tab.value ? documents.get(tab.value.id) : undefined })
const mgr = computed(() => { void store.docTick; return tab.value ? annotManagers.get(tab.value.id) : undefined })

// ── outline ──
interface OutlineNode {
  title: string
  page: number | null
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
      let page: number | null = null
      try {
        let dest = it.dest
        if (typeof dest === 'string') dest = await d.getDestination(dest)
        if (Array.isArray(dest) && dest[0]) page = (await d.getPageIndex(dest[0])) + 1
      } catch { /* unresolvable dest → title-only node */ }
      out.push({
        title: it.title ?? '', page,
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

// ── annotations tab ──
const editingId = ref<string | null>(null)
const editText = ref('')
const annots = ref<Annotation[]>([])

function syncAnnots(): void {
  annots.value = mgr.value ? [...mgr.value.annotations] : []
}
watch(mgr, (m) => {
  syncAnnots()
  if (m) {
    const prev = m.onChange
    m.onChange = (a) => { prev(a); syncAnnots() }
  }
}, { immediate: true })

function closeIfNarrow(): void {
  if (window.innerWidth < 700) store.settings.sidebarOpen = false
}
function jumpTo(a: Annotation): void {
  if (a.orphan) return
  ctrl.value?.flashAnnotation(a.id)
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
        <span class="ol-title" :title="n.title" @click="n.page && (ctrl?.scrollToPage(n.page), closeIfNarrow())">{{ n.title }}</span>
        <span class="ol-page" v-if="n.page">{{ n.page }}</span>
      </div>
    </div>

    <div class="sidebar-body" v-else-if="store.settings.sidebarTab === 'thumbs'" ref="thumbHost">
      <div
        v-for="p in tab.numPages"
        :key="p"
        class="thumb"
        :class="{ current: p === tab.currentPage }"
        :data-page="p"
        @click="ctrl?.scrollToPage(p); closeIfNarrow()"
      >
        <div class="thumb-ph" style="width: 110px; height: 150px"></div>
        <div class="thumb-num">{{ p }}</div>
      </div>
    </div>

    <div class="sidebar-body" v-else>
      <div v-if="!annots.length" class="annot-empty">
        <span v-html="t('sb.annotEmpty')"></span>
      </div>
      <div
        v-for="a in annots"
        :key="a.id"
        class="annot-item"
        :class="{ orphan: a.orphan }"
        @click="jumpTo(a)"
      >
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
            <span>p.{{ a.anchor.page }}</span>
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
