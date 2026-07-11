<script setup lang="ts">
/**
 * 图书阅读视图 —— 双源、双布局:
 *   源:PDF(重排块流) / EPUB(spine 章节 HTML)
 *   布局:scroll(纵向滚动) / paged(横向翻页,宽屏自动双页)
 *
 * 翻页实现:当前"节"(PDF 120 块一节 / EPUB 一章)以 CSS 多列排版,
 * 列宽=页宽,translateX 按页步进;节尾再翻进入下一节(真书阅读器的
 * 按章分页策略——千页大书也不用整本布局)。
 * 高亮:批注摘录经 applyMarks 在 DOM 文本节点上就地包 <mark>。
 */
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import type { ReflowBlock } from '@solopdf/core'
import { store, documents, annotManagers, epubBooks, txtBooks } from '../store'
import { isMobile, isTauri } from '../platform'
import { t } from '../i18n'
import type { SelectionInfo } from '../viewer/controller'
import { extractBook } from '../book/extract'
import { applyMarks } from '../book/marks'

const props = defineProps<{ tabId: number; source: 'pdf' | 'epub' | 'txt' }>()
const emit = defineEmits<{ selection: [sel: SelectionInfo | null]; ocr: []; chrome: [] }>()

const SECTION = 120

const host = ref<HTMLDivElement>()
const pagedContent = ref<HTMLDivElement>()
const extracting = ref(true)
const progress = ref({ done: 0, total: 1 })
const empty = ref(false)
const settingsOpen = ref(false)
const tocOpen = ref(false)

const blocks = shallowRef<ReflowBlock[]>([])
const visibleSections = ref<Set<number>>(new Set([0]))
const secIdx = ref(0)
const pageIdx = ref(0)
const pageCount = ref(1)
let pendingLastPage = false
/** syncPagedPage/onScroll 自己写入的块序 —— bookBlock watcher 据此忽略内部更新 */
let lastInternalBlock = -1
let cancelled = false
let io: IntersectionObserver | null = null
let ro: ResizeObserver | null = null

const tab = computed(() => store.tabs.find((x) => x.id === props.tabId))
const book = computed(() => store.settings.book)
const epub = computed(() => (props.source === 'epub' ? epubBooks.get(props.tabId) : undefined))

const layout = computed<'scroll' | 'paged'>(() =>
  // auto = 翻页(手机单页左右滑,桌面宽屏双页)——阅读 app 的通用预期
  book.value.layout === 'auto' ? 'paged' : book.value.layout,
)

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
    '--bk-bg': th.bg, '--bk-fg': th.fg, '--bk-dim': th.dim,
    '--bk-font': FONTS[book.value.font],
    '--bk-size': `${book.value.size}px`,
    '--bk-lh': String(book.value.lineHeight),
    '--bk-maxw': `${book.value.maxWidth}em`,
  } as Record<string, string>
})

// 真全屏:iOS 内嵌 WKWebView 的布局视口固定为"窗口减安全区",
// viewport-fit=cover 只把 html 背景延伸到刘海/home 条区域。所以把
// 文档背景跟着阅读主题走,视口外的安全区就是同色沉浸,而不是白带。
watch(() => [tab.value?.bookMode ?? true, book.value.bg] as const, ([on, bg]) => {
  // body 也要设:视口外区域(underpage)取的是 body 的背景,html 的不生效
  const c = on ? THEMES[bg as keyof typeof THEMES].bg : ''
  document.documentElement.style.background = c
  document.body.style.background = c
}, { immediate: true })
onBeforeUnmount(() => {
  document.documentElement.style.background = ''
  document.body.style.background = ''
})

// ── 数据源抽象 ──
const totalSections = computed(() =>
  props.source === 'epub'
    ? (epub.value?.chapters.length ?? 0)
    : Math.ceil(blocks.value.length / SECTION),
)
/** 章节目录(epub 用解析出的 nav/NCX,txt 用章节检测结果) */
const tocEntries = computed(() =>
  props.source === 'epub'
    ? (epub.value?.toc ?? [])
    : props.source === 'txt'
      ? (txtBooks.get(props.tabId)?.toc ?? [])
      : [],
)
const pdfSections = computed(() => {
  const out: { idx: number; blocks: ReflowBlock[]; start: number }[] = []
  for (let i = 0; i < blocks.value.length; i += SECTION) {
    out.push({ idx: i / SECTION, blocks: blocks.value.slice(i, i + SECTION), start: i })
  }
  return out
})

/** 页码(pdf=原页;epub=章序) → 节序 + 块序 */
function locate(page: number): { sec: number; block?: number } {
  if (props.source === 'epub') return { sec: Math.min(Math.max(page - 1, 0), totalSections.value - 1) }
  // txt/pdf 共用 blocks 定位
  const bi = blocks.value.findIndex((b) => b.page >= page)
  const i = bi < 0 ? blocks.value.length - 1 : bi
  return { sec: Math.floor(i / SECTION), block: i }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── 提取/装载 ──
onMounted(async () => {
  if (props.source === 'pdf') {
    const doc = documents.get(props.tabId)
    if (doc) {
      try {
        const res = await extractBook(doc, (d, tt) => { progress.value = { done: d, total: tt } }, () => cancelled)
        blocks.value = res.doc.blocks
        empty.value = res.empty
      } finally { extracting.value = false }
    }
  } else if (props.source === 'txt') {
    const book = txtBooks.get(props.tabId)
    blocks.value = book?.blocks ?? []
    empty.value = !blocks.value.length
    extracting.value = false
  } else {
    empty.value = (epub.value?.probeTextLength() ?? 0) < 10
    extracting.value = false
  }
  if (tab.value && props.source === 'epub') tab.value.numPages = totalSections.value
  await nextTick()
  document.addEventListener('selectionchange', onSelChange)
  window.addEventListener('keydown', onKey, { capture: true })
  ro = new ResizeObserver(() => { if (layout.value === 'paged') void remeasure(true) })
  if (host.value) ro.observe(host.value)
  await enterAt(tab.value?.currentPage ?? 1, tab.value?.bookBlock || undefined)
})

onBeforeUnmount(() => {
  cancelled = true
  io?.disconnect()
  ro?.disconnect()
  document.removeEventListener('selectionchange', onSelChange)
  window.removeEventListener('keydown', onKey, { capture: true } as any)
})

async function enterAt(page: number, block?: number): Promise<void> {
  // block(块序)可选:TXT 的 page 粒度是"章",恢复进度时用块精确定位
  const sec = block != null && props.source !== 'epub'
    ? Math.min(Math.floor(block / SECTION), Math.max(totalSections.value - 1, 0))
    : locate(page).sec
  const sel = block != null && props.source !== 'epub' ? `[data-block="${block}"]` : `[data-page="${page}"]`
  if (layout.value === 'scroll') {
    if (!visibleSections.value.has(sec)) {
      const next = new Set(visibleSections.value); next.add(sec); visibleSections.value = next
    }
    await nextTick()
    setupIO()
    host.value?.querySelector(sel)?.scrollIntoView({ block: 'start' })
  } else {
    secIdx.value = sec
    await nextTick()
    await remeasure()
    // 定位到目标块所在列
    const el = pagedContent.value?.querySelector(sel) as HTMLElement | null
    if (el) pageIdx.value = Math.min(Math.floor(el.offsetLeft / stepW()), pageCount.value - 1)
    syncPagedPage()
    applySectionMarks()
  }
}

// ── 滚动模式 ──
function setupIO(): void {
  io?.disconnect()
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const si = Number((e.target as HTMLElement).dataset.section)
        if (!visibleSections.value.has(si)) {
          const next = new Set(visibleSections.value); next.add(si); visibleSections.value = next
        }
      }
    }
  }, { root: host.value, rootMargin: '1200px' })
  host.value?.querySelectorAll('[data-section]').forEach((el) => io!.observe(el))
}

const placeholderH = (n: { blocks: ReflowBlock[] }): string =>
  `${n.blocks.reduce((s, b) => s + Math.max(1, Math.ceil(b.text.length / 35)), 0) * book.value.size * book.value.lineHeight + n.blocks.length * book.value.size}px`

let scrollRaf = 0
function onScroll(): void {
  if (layout.value !== 'scroll' || scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const h = host.value, tb = tab.value
    if (!h || !tb) return
    const rect = h.getBoundingClientRect()
    const el = document
      .elementsFromPoint(rect.left + rect.width / 2, rect.top + Math.min(80, rect.height / 3))
      .find((e) => (e as HTMLElement).dataset?.page)
    const p = el ? parseInt((el as HTMLElement).dataset.page!, 10) : NaN
    const blk = (el as HTMLElement | undefined)?.dataset?.block
    if (blk) { lastInternalBlock = parseInt(blk, 10); tb.bookBlock = lastInternalBlock }
    if (!Number.isNaN(p) && p !== tb.currentPage) tb.currentPage = p
  })
}

// ── 翻页模式 ──
const doublePage = computed(() => (host.value?.clientWidth ?? innerWidth) >= 900)
function stepW(): number {
  return (host.value?.clientWidth ?? innerWidth)
}
const pagedStyle = computed(() => {
  const w = stepW()
  const cols = doublePage.value ? 2 : 1
  // 列步进(colW+gap)乘每页列数必须恰好等于页宽 w,否则 translateX
  // 每翻一页漂移 (colW+gap)*cols-w 像素,页数一多就"两页同框"。
  // 取 pad=gap/2:第 n 页首列正好落在 n*w+pad。
  const gap = 48
  const pad = gap / 2
  const colW = w / cols - gap
  return {
    columnWidth: `${colW}px`,
    columnGap: `${gap}px`,
    padding: `28px ${pad}px 44px`,
    transform: `translateX(${-pageIdx.value * w}px)`,
  } as Record<string, string>
})

async function remeasure(keepAnchor = false): Promise<void> {
  await nextTick()
  const el = pagedContent.value
  if (!el) return
  const w = stepW()
  if (!w) return // 隐藏标签页(display:none)宽为 0,除零会把 pageCount 算成 NaN
  const anchorPage = keepAnchor ? tab.value?.currentPage : undefined
  // 两遍布局钉宽:先 max-content 让引擎自由排列量出内容量,再把容器
  // 宽度钉成"恰好 N 列"的精确值(列宽=w/cols-gap,pad=gap/2,故每页
  // 恰占 w)。不钉宽的话 WebKit 会走"溢出列"路径,而溢出列的横向
  // 步进是坏的(实测隔一个容器宽才排一列),翻页必然错位/两页同框。
  const cols = doublePage.value ? 2 : 1
  const gap = 48
  const colW = w / cols - gap
  const widthFor = (k: number) => k * (colW + gap) // 含两侧 pad(2*gap/2)
  el.style.width = 'max-content'
  void el.offsetWidth
  let n = Math.max(cols, Math.round(el.scrollWidth / (colW + gap)))
  el.style.width = `${widthFor(n)}px`
  void el.offsetWidth
  let guard = 0
  while (el.scrollWidth > el.offsetWidth + 1 && guard++ < 16) { // 溢出 → 加列
    n += 1
    el.style.width = `${widthFor(n)}px`
    void el.offsetWidth
  }
  while (n > cols && guard++ < 32) { // 收掉估多了的空尾列
    el.style.width = `${widthFor(n - 1)}px`
    void el.offsetWidth
    if (el.scrollWidth > el.offsetWidth + 1) {
      el.style.width = `${widthFor(n)}px`
      void el.offsetWidth
      break
    }
    n -= 1
  }
  pageCount.value = Math.max(1, Math.ceil(n / cols))
  if (pendingLastPage) {
    pageIdx.value = pageCount.value - 1
    pendingLastPage = false
  } else if (anchorPage !== undefined) {
    // 非 epub 优先按块序锚定:TXT 的 page 是章粒度,按 page 锚会拽回章首
    const blk = props.source !== 'epub' ? tab.value?.bookBlock : 0
    const a = (blk
      ? el.querySelector(`[data-block="${blk}"]`)
      : el.querySelector(`[data-page="${anchorPage}"]`)) as HTMLElement | null
    if (a) pageIdx.value = Math.min(Math.floor(a.offsetLeft / w), pageCount.value - 1)
  }
  pageIdx.value = Math.min(pageIdx.value, pageCount.value - 1)
  syncPagedPage()
}

function syncPagedPage(): void {
  const tb = tab.value
  const el = pagedContent.value
  if (!tb || !el) return
  if (props.source === 'epub') {
    if (tb.currentPage !== secIdx.value + 1) tb.currentPage = secIdx.value + 1
    return
  }
  const x = pageIdx.value * stepW()
  let best: HTMLElement | undefined
  el.querySelectorAll<HTMLElement>('[data-page]').forEach((b) => {
    if (b.offsetLeft <= x + stepW() * 0.6 && (!best || b.offsetLeft > best.offsetLeft)) best = b
  })
  const p = best?.dataset.page ? parseInt(best.dataset.page, 10) : NaN
  if (best?.dataset.block) { lastInternalBlock = parseInt(best.dataset.block, 10); tb.bookBlock = lastInternalBlock }
  if (!Number.isNaN(p) && p !== tb.currentPage) tb.currentPage = p
}

async function turn(dir: 1 | -1): Promise<void> {
  if (extracting.value || empty.value) return
  const next = pageIdx.value + dir
  if (next >= 0 && next < pageCount.value) {
    pageIdx.value = next
    syncPagedPage()
    return
  }
  const ns = secIdx.value + dir
  if (ns < 0 || ns >= totalSections.value) return
  secIdx.value = ns
  pageIdx.value = 0
  pendingLastPage = dir < 0
  await remeasure()
  applySectionMarks()
  syncPagedPage()
}

/** 面板开着时,点内容区先收面板(该次点击不再翻页) */
function closePanels(): boolean {
  if (!settingsOpen.value && !tocOpen.value) return false
  settingsOpen.value = false
  tocOpen.value = false
  return true
}

function onHostClick(e: MouseEvent): void {
  if (closePanels()) return
  if (layout.value !== 'paged') return
  if (window.getSelection()?.toString()) return
  const w = stepW()
  const x = e.clientX - (host.value?.getBoundingClientRect().left ?? 0)
  if (x < w * 0.22) void turn(-1)
  else if (x > w * 0.78) void turn(1)
}

let touchX = 0, touchY = 0
function onTouchStart(e: TouchEvent): void { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY }
function onTouchEnd(e: TouchEvent): void {
  const dx = e.changedTouches[0].clientX - touchX
  const dy = e.changedTouches[0].clientY - touchY
  if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    if (closePanels()) return
    void turn(dx < 0 ? 1 : -1)
  }
}

function onKey(e: KeyboardEvent): void {
  if (!host.value?.isConnected || store.activeTabId !== props.tabId) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const t0 = e.target as HTMLElement
  if (t0.tagName === 'INPUT' || t0.tagName === 'TEXTAREA' || t0.isContentEditable) return
  const eat = () => { e.preventDefault(); e.stopPropagation() }
  if (layout.value === 'paged') {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ' || e.key === 'j') { eat(); void turn(1) }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'k') { eat(); void turn(-1) }
  } else {
    const h = host.value
    const vh = h.clientHeight
    if (e.key === 'ArrowDown') { eat(); h.scrollBy({ top: 120, behavior: 'smooth' }) }
    else if (e.key === 'ArrowUp') { eat(); h.scrollBy({ top: -120, behavior: 'smooth' }) }
    else if (e.key === 'PageDown' || e.key === ' ' || e.key === 'j') { eat(); h.scrollBy({ top: vh * 0.9, behavior: 'smooth' }) }
    else if (e.key === 'PageUp' || e.key === 'k') { eat(); h.scrollBy({ top: -vh * 0.9, behavior: 'smooth' }) }
    else if (e.key === 'Home') { eat(); h.scrollTo({ top: 0 }) }
    else if (e.key === 'End') { eat(); h.scrollTo({ top: h.scrollHeight }) }
  }
}

// 布局/排版参数变化 → 重新排页(保当前页锚点)
watch(() => [book.value.size, book.value.lineHeight, book.value.font, book.value.maxWidth, layout.value], async () => {
  await nextTick()
  if (layout.value === 'paged') { await remeasure(true); applySectionMarks() }
  else { await enterAt(tab.value?.currentPage ?? 1); applyAllScrollMarks() }
})
// 进度恢复晚于挂载时(fileHash 是异步的):bookBlock 被外部写入 → 定位过去。
// 内部翻页写入(lastInternalBlock)要忽略,否则翻到"续排页"(该页只有上一块
// 的续行,无块起点)会被拽回上一页。
watch(() => tab.value?.bookBlock, (b) => {
  if (b == null || b === lastInternalBlock || props.source === 'epub') return
  if (extracting.value || empty.value) return
  void enterAt(tab.value?.currentPage ?? 1, b)
})

// 外部跳转(深链/批注跳回):其他代码把 currentPage 改到视口外时跟随
watch(() => tab.value?.currentPage, (p) => {
  if (p == null || layout.value !== 'paged') return
  const el = pagedContent.value?.querySelector(`[data-page="${p}"]`) as HTMLElement | null
  if (!el) { void enterAt(p, tab.value?.bookBlock || undefined); return }
  const idx = Math.floor(el.offsetLeft / stepW())
  if (Math.abs(idx - pageIdx.value) > (doublePage.value ? 1 : 0)) pageIdx.value = Math.min(idx, pageCount.value - 1)
})

// ── 高亮标记 ──
function annotsFor() {
  return annotManagers.get(props.tabId)?.annotations ?? []
}
function applySectionMarks(): void {
  void nextTick(() => {
    const el = pagedContent.value
    if (el) applyMarks(el, annotsFor())
  })
}
function applyAllScrollMarks(): void {
  void nextTick(() => {
    host.value?.querySelectorAll<HTMLElement>('[data-section]:not(.bk-ph)').forEach((el) => applyMarks(el, annotsFor()))
  })
}
watch(() => store.docTick, () => (layout.value === 'paged' ? applySectionMarks() : applyAllScrollMarks()))
watch(visibleSections, () => applyAllScrollMarks())

// ── 划选 → 高亮 ──
function onSelChange(): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) { emit('selection', null); return }
  const range = sel.getRangeAt(0)
  const startEl = range.startContainer instanceof HTMLElement ? range.startContainer : range.startContainer.parentElement
  const holder = startEl?.closest('[data-page]') as HTMLElement | null
  if (!holder || !host.value?.contains(holder)) { emit('selection', null); return }
  const text = sel.toString().trim()
  if (!text) { emit('selection', null); return }
  const ctxText = holder.textContent ?? ''
  const flat = text.replace(/\s+/g, '')
  const cflat = ctxText.replace(/\s+/g, '')
  const at = cflat.indexOf(flat)
  const pre = at >= 0 ? cflat.slice(Math.max(0, at - 32), at) : ''
  const post = at >= 0 ? cflat.slice(at + flat.length, at + flat.length + 32) : ''
  const rects = range.getClientRects()
  emit('selection', {
    page: parseInt(holder.dataset.page!, 10),
    quads: [], text, pre, post,
    clientRect: rects[rects.length - 1],
  })
}

async function toggleFullscreen(): Promise<void> {
  if (!isTauri() || isMobile()) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const w = getCurrentWindow()
  await w.setFullscreen(!(await w.isFullscreen()))
}

function tocJump(chapter: number): void {
  tocOpen.value = false
  if (chapter > 0) void enterAt(chapter)
}
</script>

<template>
  <div
    ref="host"
    class="bk-scroll"
    :class="{ 'bk-paged': layout === 'paged' }"
    :style="rootStyle"
    @scroll="onScroll"
    @click="onHostClick"
    @touchstart="layout === 'paged' ? onTouchStart($event) : undefined"
    @touchend="layout === 'paged' ? onTouchEnd($event) : undefined"
  >
    <div v-if="extracting" class="bk-center">
      <div class="ocr-progress-bar bk-progress"><div class="ocr-progress-fill" :style="{ width: (progress.done / progress.total) * 100 + '%' }"></div></div>
      <p>{{ t('bk.extracting', { done: progress.done, total: progress.total }) }}</p>
    </div>

    <div v-else-if="empty" class="bk-center">
      <p>{{ t('bk.noText') }}</p>
      <button v-if="source === 'pdf'" class="bk-ocr-btn" @click="emit('ocr')">{{ t('app.ocrBanner') }}</button>
    </div>

    <!-- 滚动布局 -->
    <div v-else-if="layout === 'scroll'" class="bk-page">
      <template v-if="source !== 'epub'">
        <template v-for="s in pdfSections" :key="s.idx">
          <div v-if="visibleSections.has(s.idx)" :data-section="s.idx" class="bk-section">
            <component
              v-for="(b, i) in s.blocks" :key="s.start + i"
              :is="b.type === 'heading' ? 'h' + Math.min((b.level ?? 3) + 1, 6) : 'p'"
              class="bk-block" :data-block="s.start + i" :data-page="b.page"
              v-html="escapeHtml(b.text)"
            />
          </div>
          <div v-else :data-section="s.idx" class="bk-section bk-ph" :style="{ height: placeholderH(s) }"></div>
        </template>
      </template>
      <template v-else>
        <template v-for="c in totalSections" :key="c">
          <div
            v-if="visibleSections.has(c - 1)" :data-section="c - 1" :data-page="c"
            class="bk-section bk-chapter" v-html="epub!.chapterHtml(c)"
          ></div>
          <div v-else :data-section="c - 1" class="bk-section bk-ph" style="height: 90vh"></div>
        </template>
      </template>
      <div class="bk-end">· {{ t('bk.end') }} ·</div>
    </div>

    <!-- 翻页布局:当前节多列排版,横移翻页 -->
    <div v-else class="bk-paged-viewport">
      <div ref="pagedContent" class="bk-paged-content" :style="pagedStyle">
        <template v-if="source !== 'epub'">
          <component
            v-for="(b, i) in pdfSections[secIdx]?.blocks ?? []" :key="(pdfSections[secIdx]?.start ?? 0) + i"
            :is="b.type === 'heading' ? 'h' + Math.min((b.level ?? 3) + 1, 6) : 'p'"
            class="bk-block" :data-block="(pdfSections[secIdx]?.start ?? 0) + i" :data-page="b.page"
            v-html="escapeHtml(b.text)"
          />
        </template>
        <div v-else class="bk-chapter" :data-page="secIdx + 1" v-html="epub!.chapterHtml(secIdx + 1)"></div>
      </div>
      <div class="bk-paged-bar">
        <button @click.stop="turn(-1)">‹</button>
        <span>{{ pageIdx + 1 }} / {{ pageCount }}<template v-if="totalSections > 1"> · {{ secIdx + 1 }}/{{ totalSections }}</template></span>
        <button @click.stop="turn(1)">›</button>
      </div>
    </div>

    <button class="bk-chrome-btn" :title="t('bk.chrome')" @click.stop="emit('chrome')">‹</button>
    <button v-if="!isMobile()" class="bk-fs-btn" :title="t('bk.fullscreen')" @click.stop="toggleFullscreen">⛶</button>
    <button v-if="tocEntries.length" class="bk-toc-btn" :title="t('bk.toc')" @click.stop="tocOpen = !tocOpen">☰</button>
    <button class="bk-aa" :title="t('bk.settings')" @click.stop="settingsOpen = !settingsOpen">Aa</button>

    <div v-if="tocOpen" class="bk-settings bk-toc" @click.stop>
      <div
        v-for="(e, i) in tocEntries" :key="i"
        class="bk-toc-item" :style="{ paddingLeft: 8 + e.depth * 14 + 'px' }"
        @click="tocJump(e.chapter)"
      >{{ e.title }}</div>
    </div>

    <div v-if="settingsOpen" class="bk-settings" @click.stop>
      <div class="bk-row">
        <label>{{ t('bk.layoutLabel') }}</label>
        <select v-model="book.layout">
          <option value="auto">{{ t('bk.layout.auto') }}</option>
          <option value="paged">{{ t('bk.layout.paged') }}</option>
          <option value="scroll">{{ t('bk.layout.scroll') }}</option>
        </select>
      </div>
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
      <div class="bk-row" v-if="layout === 'scroll'">
        <label>{{ t('bk.widthLabel') }}</label>
        <input type="range" min="24" max="60" step="2" v-model.number="book.maxWidth" />
        <span class="bk-val">{{ book.maxWidth }}em</span>
      </div>
    </div>
  </div>
</template>
