<script setup lang="ts">
/**
 * 图书阅读模式:重排视图。
 *  - extractBook() 全书提取(带进度),块按 section 懒渲染(IO 观察)
 *  - 主题/字体/字号/行距/版心宽 全部来自 settings.book(即改即生效并持久化)
 *  - 高亮:已有批注以 <mark> 内联显示;划选文字冒出取色器,锚定走文字指纹
 *  - 位置:进入时跳到当前页对应块,滚动时回写 tab.currentPage(供切回原版式)
 */
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import type { ReflowBlock } from '@solopdf/core'
import { store, documents, annotManagers } from '../store'
import { t } from '../i18n'
import type { SelectionInfo } from '../viewer/controller'
import { extractBook } from '../book/extract'

const props = defineProps<{ tabId: number }>()
const emit = defineEmits<{ selection: [sel: SelectionInfo | null]; ocr: [] }>()

const SECTION = 120

const host = ref<HTMLDivElement>()
const blocks = shallowRef<ReflowBlock[]>([])
const extracting = ref(true)
const progress = ref({ done: 0, total: 1 })
const empty = ref(false)
const settingsOpen = ref(false)
const visibleSections = ref<Set<number>>(new Set([0]))
let cancelled = false
let io: IntersectionObserver | null = null

const tab = computed(() => store.tabs.find((x) => x.id === props.tabId))
const book = computed(() => store.settings.book)

const THEMES = {
  paper: { bg: '#fbfaf7', fg: '#1f2328', dim: '#8a8f98' },
  sepia: { bg: '#f4ecd8', fg: '#433422', dim: '#9a8a72' },
  green: { bg: '#cce8cf', fg: '#233029', dim: '#6d8274' },
  night: { bg: '#101114', fg: '#c8ccd2', dim: '#6c7280' },
} as const

const FONTS = {
  sans: '-apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Segoe UI", sans-serif',
  serif: '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", SimSun, Georgia, serif',
  kai: '"Kaiti SC", KaiTi, "TW-Kai", "Noto Serif CJK SC", serif',
} as const

const rootStyle = computed(() => {
  const th = THEMES[book.value.bg]
  return {
    '--bk-bg': th.bg,
    '--bk-fg': th.fg,
    '--bk-dim': th.dim,
    '--bk-font': FONTS[book.value.font],
    '--bk-size': `${book.value.size}px`,
    '--bk-lh': String(book.value.lineHeight),
    '--bk-maxw': `${book.value.maxWidth}em`,
  } as Record<string, string>
})

const sections = computed(() => {
  const out: { idx: number; blocks: ReflowBlock[]; start: number }[] = []
  for (let i = 0; i < blocks.value.length; i += SECTION) {
    out.push({ idx: i / SECTION, blocks: blocks.value.slice(i, i + SECTION), start: i })
  }
  return out
})

// 未渲染 section 的占位高度(按当前字号估算,IO 命中后替换为真实内容)
const placeholderH = (n: { blocks: ReflowBlock[] }): string =>
  `${n.blocks.reduce((s, b) => s + Math.max(1, Math.ceil(b.text.length / 35)), 0) * book.value.size * book.value.lineHeight + n.blocks.length * book.value.size}px`

// ── 高亮内联标记 ──
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function blockHtml(b: ReflowBlock): string {
  void store.docTick
  const mgr = annotManagers.get(props.tabId)
  let html = escapeHtml(b.text)
  if (mgr) {
    for (const a of mgr.annotations) {
      if (a.orphan || !a.excerpt || Math.abs(a.anchor.page - b.page) > 1) continue
      const ex = escapeHtml(a.excerpt.replace(/…$/, ''))
      if (ex.length < 2) continue
      const at = html.indexOf(ex)
      if (at >= 0) {
        html =
          html.slice(0, at) +
          `<mark class="bk-hl bk-hl-${a.color}" data-annot="${a.id}">` +
          html.slice(at, at + ex.length) +
          '</mark>' +
          html.slice(at + ex.length)
      }
    }
  }
  return html
}

// ── 提取 ──
onMounted(async () => {
  const doc = documents.get(props.tabId)
  if (!doc) return
  try {
    const res = await extractBook(
      doc,
      (done, total) => { progress.value = { done, total } },
      () => cancelled,
    )
    blocks.value = res.doc.blocks
    empty.value = res.empty
  } finally {
    extracting.value = false
  }
  await nextTick()
  setupIO()
  jumpToPage(tab.value?.currentPage ?? 1)
  document.addEventListener('selectionchange', onSelChange)
})

onBeforeUnmount(() => {
  cancelled = true
  io?.disconnect()
  document.removeEventListener('selectionchange', onSelChange)
})

function setupIO(): void {
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const si = Number((e.target as HTMLElement).dataset.section)
          if (!visibleSections.value.has(si)) {
            const next = new Set(visibleSections.value)
            next.add(si)
            visibleSections.value = next
          }
        }
      }
    },
    { root: host.value, rootMargin: '1200px' },
  )
  host.value?.querySelectorAll('[data-section]').forEach((el) => io!.observe(el))
}

// ── 位置同步 ──
async function jumpToPage(page: number): Promise<void> {
  const bi = blocks.value.findIndex((b) => b.page >= page)
  if (bi < 0) return
  const si = Math.floor(bi / SECTION)
  if (!visibleSections.value.has(si)) {
    const next = new Set(visibleSections.value)
    next.add(si)
    visibleSections.value = next
    await nextTick()
  }
  host.value?.querySelector(`[data-block="${bi}"]`)?.scrollIntoView({ block: 'start' })
}

let scrollRaf = 0
function onScroll(): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const h = host.value
    const tb = tab.value
    if (!h || !tb) return
    const rect = h.getBoundingClientRect()
    const el = document
      .elementsFromPoint(rect.left + rect.width / 2, rect.top + Math.min(80, rect.height / 3))
      .find((e) => (e as HTMLElement).dataset?.page)
    const p = el ? parseInt((el as HTMLElement).dataset.page!, 10) : NaN
    if (!Number.isNaN(p) && p !== tb.currentPage) tb.currentPage = p
  })
}

// 字号等变化会改变占位高度估算——保持当前页可见
watch(() => [book.value.size, book.value.lineHeight, book.value.font], async () => {
  await nextTick()
  void jumpToPage(tab.value?.currentPage ?? 1)
})

// ── 划选 → 高亮 ──
function onSelChange(): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) { emit('selection', null); return }
  const range = sel.getRangeAt(0)
  const el = (range.startContainer instanceof HTMLElement
    ? range.startContainer
    : range.startContainer.parentElement)?.closest('[data-block]') as HTMLElement | null
  if (!el || !host.value?.contains(el)) { emit('selection', null); return }
  const text = sel.toString().trim()
  if (!text) { emit('selection', null); return }
  const b = blocks.value[parseInt(el.dataset.block!, 10)]
  if (!b) { emit('selection', null); return }
  const flat = text.replace(/\s+/g, '')
  const bflat = b.text.replace(/\s+/g, '')
  const at = bflat.indexOf(flat)
  const pre = at >= 0 ? bflat.slice(Math.max(0, at - 32), at) : ''
  const post = at >= 0 ? bflat.slice(at + flat.length, at + flat.length + 32) : ''
  const rects = range.getClientRects()
  emit('selection', {
    page: b.page,
    quads: [], // 图书模式没有版面坐标——纯文字指纹锚定,回原版式时自动重解析
    text,
    pre,
    post,
    clientRect: rects[rects.length - 1],
  })
}
</script>

<template>
  <div ref="host" class="bk-scroll" :style="rootStyle" @scroll="onScroll">
    <div v-if="extracting" class="bk-center">
      <div class="ocr-progress-bar bk-progress"><div class="ocr-progress-fill" :style="{ width: (progress.done / progress.total) * 100 + '%' }"></div></div>
      <p>{{ t('bk.extracting', { done: progress.done, total: progress.total }) }}</p>
    </div>

    <div v-else-if="empty" class="bk-center">
      <p>{{ t('bk.noText') }}</p>
      <button class="bk-ocr-btn" @click="emit('ocr')">{{ t('app.ocrBanner') }}</button>
    </div>

    <div v-else class="bk-page">
      <template v-for="s in sections" :key="s.idx">
        <div v-if="visibleSections.has(s.idx)" :data-section="s.idx" class="bk-section">
          <template v-for="(b, i) in s.blocks" :key="s.start + i">
            <component
              :is="b.type === 'heading' ? 'h' + Math.min((b.level ?? 3) + 1, 6) : 'p'"
              class="bk-block"
              :data-block="s.start + i"
              :data-page="b.page"
              v-html="blockHtml(b)"
            />
          </template>
        </div>
        <div v-else :data-section="s.idx" class="bk-section bk-ph" :style="{ height: placeholderH(s) }"></div>
      </template>
      <div class="bk-end">· {{ t('bk.end') }} ·</div>
    </div>

    <button class="bk-aa" :title="t('bk.settings')" @click="settingsOpen = !settingsOpen">Aa</button>

    <div v-if="settingsOpen" class="bk-settings" @click.self="settingsOpen = false">
      <div class="bk-row">
        <label>{{ t('bk.bgLabel') }}</label>
        <div class="bk-swatches">
          <button
            v-for="(th, key) in THEMES" :key="key"
            class="bk-swatch" :class="{ active: book.bg === key }"
            :style="{ background: th.bg, color: th.fg }"
            :title="t('bk.bg.' + key)"
            @click="book.bg = key as any"
          >A</button>
        </div>
      </div>
      <div class="bk-row">
        <label>{{ t('bk.fontLabel') }}</label>
        <select v-model="book.font">
          <option value="sans">{{ t('bk.font.sans') }}</option>
          <option value="serif">{{ t('bk.font.serif') }}</option>
          <option value="kai">{{ t('bk.font.kai') }}</option>
        </select>
      </div>
      <div class="bk-row">
        <label>{{ t('bk.sizeLabel') }}</label>
        <input type="range" min="14" max="28" step="1" v-model.number="book.size" />
        <span class="bk-val">{{ book.size }}px</span>
      </div>
      <div class="bk-row">
        <label>{{ t('bk.lhLabel') }}</label>
        <input type="range" min="1.4" max="2.4" step="0.1" v-model.number="book.lineHeight" />
        <span class="bk-val">{{ book.lineHeight.toFixed(1) }}</span>
      </div>
      <div class="bk-row">
        <label>{{ t('bk.widthLabel') }}</label>
        <input type="range" min="24" max="60" step="2" v-model.number="book.maxWidth" />
        <span class="bk-val">{{ book.maxWidth }}em</span>
      </div>
    </div>
  </div>
</template>
