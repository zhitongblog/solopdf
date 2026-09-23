<script setup lang="ts">
/**
 * Orchestrator: tabs ⇄ controllers ⇄ annotation managers.
 * Request flow for opening a file:
 *   openPath(path)
 *     ├── newTab() ................ reactive metadata
 *     ├── openDocument() .......... range transport + password dialog
 *     ├── new PdfViewerController . owns scroll DOM (non-reactive)
 *     ├── new AnnotationManager ... sidecar load + anchor resolve
 *     └── restorePosition() ....... path key, hash fallback (bg)
 */
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import {
  store, controllers, documents, annotManagers, epubBooks, txtBooks, comicBooks, initStore, newTab, closeTab,
  addRecent, savePosition, restorePosition, effectiveTheme, docPrefsFor, saveDocPrefs,
  addBookmark, removeBookmark, bookmarkAt, type TabState,
} from './store'
import { platform, isTauri, isMobile } from './platform'
import { t } from './i18n'
import { exportMarkdown } from './export'
import { openDocument } from './viewer/loader'
import { PdfViewerController, type SelectionInfo } from './viewer/controller'
import { AnnotationManager } from './annotations/manager'
import { printDocument } from './print'
import { initWakeLock, setKeepAwake } from './wakelock'
import TabBar from './components/TabBar.vue'
import Toolbar from './components/Toolbar.vue'
import Sidebar from './components/Sidebar.vue'
import SearchBar from './components/SearchBar.vue'
import PasswordDialog from './components/PasswordDialog.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import HighlightPopover from './components/HighlightPopover.vue'
import OcrDialog from './components/OcrDialog.vue'
import ImageOcrDialog from './components/ImageOcrDialog.vue'
import BookView from './components/BookView.vue'
import ViewMenu from './components/ViewMenu.vue'
import AnnotToolLayer from './components/AnnotToolLayer.vue'
import DocTools from './components/doctools/DocTools.vue'
import ReadAloudBar from './components/ReadAloudBar.vue'
import DictPopup from './components/DictPopup.vue'
import TranslatePopup from './components/TranslatePopup.vue'
import StatsPanel from './components/StatsPanel.vue'
import LibraryView from './components/LibraryView.vue'
import LibrarySearch from './components/LibrarySearch.vue'
import ComicView from './components/ComicView.vue'
import { noteOpened, captureCover, addToLibrary } from './library'
import { startStats, stopStats, noteTurn } from './stats'
import { speaker, startReading, stopReading } from './readaloud'
import type { AnnotationKind } from '@solopdf/core'

const scrollHost = ref<HTMLDivElement>()
const selection = ref<SelectionInfo | null>(null)
const searchOpen = ref(false)
const settingsOpen = ref(false)
const viewMenuOpen = ref(false)
/** armed annotation tool; 'none' means normal reading/selection */
const tool = ref<'none' | 'note' | 'region'>('none')
const docToolsOpen = ref(false)
const readAloud = ref(false)
const dictWord = ref<{ word: string; anchor: DOMRect | null } | null>(null)
/** translation panel; `sel` is a snapshot so "add as note" still has the
 *  selection after clicks inside the panel collapse the live one */
const translateReq = ref<{ text: string; anchor: DOMRect | null; sel: SelectionInfo | null; tabId: number } | null>(null)
const statsOpen = ref(false)
const librarySearchOpen = ref(false)
const ocrOpen = ref(false)
const imageOcrPath = ref('')
const imageOcrBytes = ref<{ bytes: Uint8Array; name: string } | null>(null)
const chromeReveal = ref(false) // 图书模式下临时唤出标签栏/工具栏
const toast = ref('')
const noTextBanner = ref(false)
const pwRequest = ref<{ retry: boolean; resolve: (pw: string | null) => void } | null>(null)
const privacyAsk = ref<{ resolve: (strip: boolean) => void } | null>(null)
let privacyAsked = new Set<number>()

function showToast(msg: string): void {
  toast.value = msg
  setTimeout(() => { if (toast.value === msg) toast.value = '' }, 3200)
}

// ── theme ──
function applyTheme(): void {
  document.documentElement.classList.toggle('dark', effectiveTheme() === 'dark')
}
watch(() => store.settings.theme, applyTheme)
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)

/**
 * TXT/EPUB 的进度记忆 hash 回退:微信/Files"用 SoloPDF 打开"每次拷进
 * Inbox 的路径都不同,路径键永远 miss——按内容 hash 补一次(PDF 那侧
 * restorePosition 已有同款逻辑)。顺便把 hash 记下,之后 savePosition
 * 会同时写 hash 键。
 */
function restoreBookByHash(tab: TabState, hadPos: boolean): void {
  void platform().fileHash(tab.path).then((h) => {
    store.hashes[tab.path] = h
    if (hadPos) return
    const byHash = store.positions[`hash:${h}`]
    if (byHash && store.tabs.some((x) => x.id === tab.id)) {
      tab.bookBlock = byHash.ratio || 0
      tab.currentPage = byHash.page
    }
  }).catch(() => {})
}

// ── open/close ──
async function openPath(rawPath: string, jumpTo?: { page: number; annot?: string }): Promise<void> {
  // Phones hand us a throwaway path (picker temp dir, or a fresh Inbox copy
  // on every "open with"). Import once into our own Library folder so the
  // path — and with it the sidecar, the reading position and the shelf entry
  // — survives the next launch. Desktop returns the path unchanged.
  let path = rawPath
  let importError = ''
  try {
    path = await platform().importDocument(rawPath)
  } catch (err) {
    importError = String((err as Error).message ?? err)
    showToast(t('app.importFail', { msg: importError }))
  }
  // focus existing tab for same path
  const existing = store.tabs.find((t) => t.path === path)
  if (existing) {
    store.activeTabId = existing.id
    if (jumpTo) jumpAfterLoad(existing.id, jumpTo)
    return
  }
  const tab = newTab(path)
  await nextTick() // let the scroll host for this tab mount

  // ── DjVu:页面在 Rust 侧解码成 PNG,前端当"图片页"读 ──
  if (tab.kind === 'djvu') {
    try {
      const { DjvuBook } = await import('./book/djvu')
      const bk = new DjvuBook()
      await bk.load(path)
      comicBooks.set(tab.id, bk)
      tab.numPages = bk.pages.length
      const pos = store.positions[path]
      tab.currentPage = jumpTo?.page ?? pos?.page ?? 1
      restoreBookByHash(tab, !!(jumpTo || pos))
      store.docTick++
      addRecent(path)
      noteOpened(tab)
    } catch (err) {
      const raw = String((err as Error)?.message ?? err)
      const msg = raw.startsWith('djvu') ? t('dj.' + raw) : raw
      tab.loadError = msg
      showToast(t('app.openFail', { msg }))
    }
    return
  }

  // ── 漫画(CBZ/CBR):整包读进来 → 排序图片条目 → 专用视图 ──
  if (tab.kind === 'comic') {
    try {
      const meta = await platform().fileMeta(path)
      const bytes = await platform().readChunk(path, 0, meta.size)
      const { ComicBook } = await import('./book/comic')
      const cb = new ComicBook()
      await cb.load(bytes, path)
      comicBooks.set(tab.id, cb)
      tab.numPages = cb.pages.length
      const pos = store.positions[path]
      tab.currentPage = jumpTo?.page ?? pos?.page ?? 1
      restoreBookByHash(tab, !!(jumpTo || pos))
      store.docTick++
      addRecent(path)
      noteOpened(tab)
    } catch (err) {
      const msg = (err as Error)?.message === 'archiveEmpty'
        ? t('cm.noImages')
        : String((err as Error)?.message ?? err)
      tab.loadError = msg
      showToast(t('app.openFail', { msg }))
    }
    return
  }

  // ── TXT:解码(UTF-8 → GBK 回退)→ 章节/段落 → 图书视图 ──
  if (tab.kind === 'txt') {
    try {
      const meta = await platform().fileMeta(path)
      const bytes = await platform().readChunk(path, 0, meta.size)
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        text = new TextDecoder('gb18030').decode(bytes) // 网文 TXT 常见 GBK/GB18030
      }
      const { txtToBlocks } = await import('@solopdf/core')
      const book = txtToBlocks(text)
      txtBooks.set(tab.id, book)
      tab.numPages = Math.max(book.toc.length, 1)
      const mgr = new AnnotationManager(path, tab.name, false)
      annotManagers.set(tab.id, mgr)
      mgr.onChange = () => { store.docTick++ }
      await mgr.load()
      tab.sidecarLocation = mgr.sidecarLocation
      const pos = store.positions[path]
      tab.currentPage = jumpTo?.page ?? pos?.page ?? 1
      if (!jumpTo && pos) tab.bookBlock = pos.ratio || 0
      restoreBookByHash(tab, !!(jumpTo || pos))
      tab.bookMode = true
      store.docTick++
      addRecent(path)
      noteOpened(tab)
    } catch (err) {
      tab.loadError = String((err as Error)?.message ?? err)
      showToast(t('app.openFail', { msg: tab.loadError }))
    }
    return
  }

  // ── EPUB / MOBI / AZW3:只有图书视图,无 pdf.js 管线 ──
  if (tab.kind === 'epub' || tab.kind === 'mobi') {
    try {
      const meta = await platform().fileMeta(path)
      const bytes = await platform().readChunk(path, 0, meta.size)
      let bk: import('./book/epub').EpubBook | import('./book/mobi').MobiBook
      if (tab.kind === 'mobi') {
        const { MobiBook } = await import('./book/mobi')
        const m = new MobiBook()
        m.load(bytes)
        bk = m
      } else {
        const { EpubBook } = await import('./book/epub')
        const e = new EpubBook()
        e.load(bytes)
        bk = e
      }
      epubBooks.set(tab.id, bk)
      if (bk.title) tab.name = bk.title
      const mgr = new AnnotationManager(path, tab.name, false)
      annotManagers.set(tab.id, mgr)
      mgr.onChange = () => { store.docTick++ }
      await mgr.load()
      tab.sidecarLocation = mgr.sidecarLocation
      const pos = store.positions[path]
      tab.currentPage = jumpTo?.page ?? pos?.page ?? 1
      restoreBookByHash(tab, !!(jumpTo || pos))
      tab.bookMode = true
      store.docTick++
      addRecent(path)
      noteOpened(tab)
    } catch (err) {
      const raw = String((err as Error)?.message ?? err)
      // the MOBI reader speaks in codes so the message can be translated
      const msg = raw.startsWith('mobi') ? t('mb.' + raw) : raw
      tab.loadError = msg
      showToast(t('app.openFail', { msg }))
    }
    return
  }

  try {
    const askPassword = (retry: boolean): Promise<string | null> => {
      tab.encrypted = true
      return new Promise((resolve) => { pwRequest.value = { retry, resolve } })
    }
    const { doc } = await openDocument(path, async (retry) => {
      const pw = await askPassword(retry)
      pwRequest.value = null
      if (pw === null) closeTab(tab.id)
      return pw
    })
    if (!store.tabs.find((t) => t.id === tab.id)) { void doc.destroy(); return } // cancelled
    documents.set(tab.id, doc)
    tab.numPages = doc.numPages

    const host = hostFor(tab.id)
    if (!host) throw new Error('internal: render host missing')
    const ctrl = new PdfViewerController(doc, host, effectiveTheme)
    ctrl.darkPdf = store.settings.darkPdf
    // per-document view state (rotation/crop) + global layout preference,
    // applied BEFORE init() so the first layout pass is already correct
    ctrl.scrollMode = store.settings.scrollMode
    ctrl.spread = store.settings.spread
    ctrl.coverAlone = store.settings.coverAlone
    const prefs = docPrefsFor(path)
    if (prefs.rotation) ctrl.rotation = prefs.rotation
    if (prefs.pageRotations) ctrl.setPageRotations(prefs.pageRotations)
    if (prefs.crop) ctrl.crop = prefs.crop
    controllers.set(tab.id, ctrl)
    ctrl.onVisiblePage = (p) => {
      if (p !== tab.currentPage) noteTurn()
      tab.currentPage = p
    }
    ctrl.onSelection = (sel) => { selection.value = sel && store.activeTabId === tab.id ? sel : null }
    ctrl.onFormsDirty = () => { tab.formsDirty = true }
    await ctrl.init()

    const mgr = new AnnotationManager(path, tab.name, tab.stripExcerpts)
    annotManagers.set(tab.id, mgr)
    store.docTick++
    mgr.onChange = (annots) => {
      void ctrl.setAnnotations(annots)
      store.docTick++ // 图书模式的内联高亮靠它重渲染
    }
    await mgr.load()
    tab.sidecarLocation = mgr.sidecarLocation

    addRecent(path)
    noteOpened(tab)
    restorePosition(tab)
    if (jumpTo) jumpAfterLoad(tab.id, jumpTo)
    // shelf cover: one extra small render, after the page the reader wanted
    void ctrl.renderToCanvas(1, 0.35).then((c) => captureCover(path, c)).catch(() => {})
  } catch (err) {
    // an import failure is the real cause when the open then fails too —
    // showing only "no such file" would send debugging the wrong way
    tab.loadError = importError
      ? `${t('app.importFail', { msg: importError })}`
      : String((err as Error)?.message ?? err)
    showToast(t('app.openFail', { msg: tab.loadError }))
  }
}

function jumpAfterLoad(tabId: number, jump: { page: number; annot?: string }): void {
  setTimeout(() => {
    const tab = store.tabs.find((x) => x.id === tabId)
    if (tab && tab.kind !== 'pdf') { tab.bookBlock = 0; tab.currentPage = jump.page; return }
    const ctrl = controllers.get(tabId)
    if (!ctrl) return
    if (jump.annot) ctrl.flashAnnotation(jump.annot)
    else ctrl.scrollToPage(jump.page)
  }, 350)
}

function hostFor(tabId: number): HTMLElement | null {
  return document.querySelector(`.pv-scroll[data-tab="${tabId}"]`)
}

async function pickAndOpen(): Promise<void> {
  const files = await platform().pickFiles()
  if (!files) return
  if (platform().kind === 'web') {
    // web mode: pickFiles returns the fixtures list; open the first not-yet-open
    const fresh = files.find((f) => !store.tabs.some((t) => t.path === f))
    if (fresh) await openPath(fresh)
    return
  }
  for (const f of files) await openPath(f)
}

function onCloseTab(id: number): void {
  const tab = store.tabs.find((t) => t.id === id)
  if (tab) savePosition(tab)
  closeTab(id)
}

// ── highlight ──
async function highlightSelection(
  color: string,
  kind: AnnotationKind = 'highlight',
  note = '',
  selOverride?: SelectionInfo,
): Promise<void> {
  const sel = selOverride ?? selection.value
  const tab = store.activeTab
  if (!sel || !tab) return
  const mgr = annotManagers.get(tab.id)
  const ctrl = controllers.get(tab.id) // epub 标签页没有 controller
  if (!mgr) return
  // encrypted privacy prompt — once per doc
  if (tab.encrypted && !privacyAsked.has(tab.id)) {
    privacyAsked.add(tab.id)
    const strip = await new Promise<boolean>((resolve) => { privacyAsk.value = { resolve } })
    privacyAsk.value = null
    tab.stripExcerpts = strip
    mgr.stripExcerpts = strip
  }
  try {
    await mgr.addFromSelection(sel, color, note, kind)
    if (ctrl) ctrl.clearSelection()
    else { window.getSelection()?.removeAllRanges(); selection.value = null }
    showToast(t('app.highlighted', { file: mgr.sidecarLocation.split('/').pop()! }))
  } catch (err) {
    showToast(t('app.annotSaveFail', { msg: (err as Error).message }))
  }
}

/** popover ✎: mark the selection AND open the note editor for it */
const pendingNote = ref<{ color: string; kind: AnnotationKind; text: string } | null>(null)
function askNoteForSelection(color: string, kind: AnnotationKind): void {
  pendingNote.value = { color, kind, text: '' }
}
async function saveSelectionNote(): Promise<void> {
  const p = pendingNote.value
  if (!p) return
  pendingNote.value = null
  await highlightSelection(p.color, p.kind, p.text.trim())
}

function defineSelection(): void {
  const sel = selection.value
  if (!sel?.text.trim()) return
  dictWord.value = { word: sel.text.trim().slice(0, 40), anchor: sel.clientRect ?? null }
}

function translateSelection(): void {
  const sel = selection.value
  const tab = store.activeTab
  if (!sel?.text.trim() || !tab) return
  translateReq.value = {
    text: sel.text.trim().slice(0, 5000),
    anchor: sel.clientRect ?? null,
    sel: { ...sel, quads: sel.quads.map((q) => ({ ...q })) },
    tabId: tab.id,
  }
}

/** translation panel → a highlight of the original with the translation as its note */
async function addTranslationNote(translation: string): Promise<void> {
  const req = translateReq.value
  translateReq.value = null
  if (!req?.sel || store.activeTabId !== req.tabId) {
    showToast(t('tr.noSelection'))
    return
  }
  await highlightSelection(store.settings.defaultColor, 'highlight', translation, req.sel)
}

async function copySelection(): Promise<void> {
  const text = selection.value?.text
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    showToast(t('app.copied'))
  } catch {
    showToast(t('app.copyFail'))
  }
}

// ── bookmarks ──
const currentBookmark = computed(() => {
  void store.bookmarks
  const tab = store.activeTab
  return tab ? bookmarkAt(tab.path, tab.currentPage) : undefined
})

function toggleBookmark(): void {
  const tab = store.activeTab
  if (!tab) return
  const existing = bookmarkAt(tab.path, tab.currentPage)
  if (existing) {
    removeBookmark(tab.path, existing.at)
    showToast(t('app.bookmarkRemoved'))
    return
  }
  const ctrl = controllers.get(tab.id)
  addBookmark(tab.path, {
    page: tab.currentPage,
    block: tab.kind === 'pdf' && !tab.bookMode ? undefined : tab.bookBlock,
    ratio: ctrl?.getPosition().ratio,
    // a bookmark with no name is a page number you have to remember; default
    // to the page so the list is at least scannable
    label: t('app.bookmarkLabel', { page: tab.currentPage }),
  })
  showToast(t('app.bookmarkAdded'))
}

function gotoBookmark(page: number, block?: number): void {
  const tab = store.activeTab
  if (!tab) return
  if (tab.bookMode || tab.kind !== 'pdf') {
    tab.currentPage = page
    if (block != null) tab.bookBlock = block
    return
  }
  controllers.get(tab.id)?.scrollToPage(page)
}

// ── focus refresh (external SoloMD edits) ──
function onFocus(): void {
  const tab = store.activeTab
  if (!tab) return
  void annotManagers.get(tab.id)?.refresh()
}

// ── keyboard ──
function onKey(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey
  const tab = store.activeTab
  const ctrl = tab ? controllers.get(tab.id) : undefined
  if (mod && e.key === 'o') { e.preventDefault(); void pickAndOpen() }
  else if (mod && e.key === 'f') { e.preventDefault(); if (tab) searchOpen.value = true }
  else if (mod && e.key === 'w') { e.preventDefault(); if (tab) onCloseTab(tab.id) }
  else if (mod && e.key === 'p') { e.preventDefault(); void doPrint() }
  else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); ctrl?.setZoom(ctrl.scale * 1.15) }
  else if (mod && e.key === '-') { e.preventDefault(); ctrl?.setZoom(ctrl.scale / 1.15) }
  else if (mod && e.key === '0') { e.preventDefault(); ctrl?.setZoom('width') }
  else if (mod && e.key === ',') { e.preventDefault(); settingsOpen.value = !settingsOpen.value }
  else if (mod && e.key === 'b') { e.preventDefault(); store.settings.sidebarOpen = !store.settings.sidebarOpen }
  else if (mod && e.key === 'd') { e.preventDefault(); toggleBookmark() }
  else if (!mod && e.key === 'Escape') {
    searchOpen.value = false; settingsOpen.value = false; translateReq.value = null
  }
  else if (!mod && tab && ctrl && !tab.bookMode && !isTyping(e)) {
    if (e.key === 'j' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); ctrl.turnPage(1) }
    else if (e.key === 'k' || e.key === 'PageUp') { e.preventDefault(); ctrl.turnPage(-1) }
    else if (e.key === 'ArrowRight' && ctrl.scrollMode === 'paged') { e.preventDefault(); ctrl.turnPage(1) }
    else if (e.key === 'ArrowLeft' && ctrl.scrollMode === 'paged') { e.preventDefault(); ctrl.turnPage(-1) }
    else if (e.key === 'Home') ctrl.scrollToPage(1)
    else if (e.key === 'End') ctrl.scrollToPage(tab.numPages)
    else if (e.key === 'r' || e.key === 'R') { rotateDoc(e.key === 'R' ? -90 : 90) }
    else if (e.key === 'a') { toggleAutoScroll() }
  }
}
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
}

function rotateDoc(delta: number): void {
  const tab = store.activeTab
  const ctrl = tab && controllers.get(tab.id)
  if (!tab || !ctrl) return
  ctrl.rotateBy(delta)
  saveDocPrefs(tab.path, {
    rotation: ctrl.rotation || undefined,
    pageRotations: Object.keys(ctrl.pageRotations()).length ? ctrl.pageRotations() : undefined,
  })
  store.docTick++
}

function toggleAutoScroll(): void {
  const tab = store.activeTab
  const ctrl = tab && controllers.get(tab.id)
  if (!ctrl) return
  if (ctrl.autoScrolling) ctrl.stopAutoScroll()
  else ctrl.setAutoScroll(store.settings.autoScrollSpeed)
  store.docTick++
}

async function saveFilledForm(): Promise<void> {
  const tab = store.activeTab
  const ctrl = tab && controllers.get(tab.id)
  if (!tab || !ctrl) return
  try {
    const bytes = await ctrl.saveFilled()
    const suggested = tab.name.replace(/\.pdf$/i, '') + '-filled.pdf'
    const dest = await platform().savePdf(suggested, bytes)
    if (dest) showToast(t('app.saved', { file: dest.split('/').pop()! }))
  } catch (err) {
    showToast(t('app.saveFail', { msg: (err as Error).message }))
  }
}

async function exportMd(): Promise<void> {
  const tab = store.activeTab
  const doc = tab && documents.get(tab.id)
  if (!tab || !doc) return
  try {
    const mgr = annotManagers.get(tab.id)
    const md = await exportMarkdown(doc, tab.name, mgr?.annotations ?? [])
    const suggested = tab.name.replace(/\.pdf$/i, '') + '.md'
    const dest = await platform().saveText(suggested, md)
    if (dest) showToast(t('app.exported', { file: dest.split('/').pop()! }))
  } catch (err) {
    showToast(t('app.exportFail', { msg: (err as Error).message }))
  }
}

// ── 图书模式 ──
function toggleBookMode(): void {
  const tab = store.activeTab
  if (!tab || tab.kind !== 'pdf') return
  tab.bookMode = !tab.bookMode
  chromeReveal.value = false
  if (!tab.bookMode) {
    // 回原版式:跳到图书里读到的页
    selection.value = null
    controllers.get(tab.id)?.scrollToPage(tab.currentPage)
  }
}

// ── OCR ──
function onOcrDone(dest: string, kind: 'pdf' | 'md'): void {
  ocrOpen.value = false
  showToast(t('app.ocrDone', { file: dest.split('/').pop()! }))
  // open the searchable copy right away so the user can verify search/copy
  if (kind === 'pdf') void openPath(dest)
}

async function pickImageForOcr(): Promise<void> {
  if (isMobile()) {
    // iOS: a native file input surfaces the system sheet with 拍照 /
    // 照片图库 / 浏览 — camera capture included, no extra plugin needed
    // (requires NSCameraUsageDescription in Info.plist)
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      imageOcrBytes.value = { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name || 'photo.jpg' }
    }
    input.click()
    return
  }
  const { open } = await import('@tauri-apps/plugin-dialog')
  const sel = await open({
    multiple: false,
    filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg'] }],
  })
  if (typeof sel === 'string') imageOcrPath.value = sel
}

async function doPrint(): Promise<void> {
  const tab = store.activeTab
  const doc = tab && documents.get(tab.id)
  if (!tab || !doc) return
  showToast(t('app.printPrep'))
  try {
    await printDocument(doc)
  } catch (err) {
    showToast(t('app.printFail', { msg: (err as Error).message }))
  }
}

// ── deep links (solopdf://open?file=…&page=…&annot=…) ──
function handleDeepLink(url: string): void {
  try {
    const u = new URL(url)
    if (u.protocol !== 'solopdf:') return
    const file = u.searchParams.get('file')
    const page = parseInt(u.searchParams.get('page') ?? '1', 10)
    const annot = u.searchParams.get('annot') ?? undefined
    if (file) void openPath(decodeURIComponent(file), { page, annot })
  } catch { /* malformed link — ignore */ }
}

// ── no-text-layer banner: show when current page has no text ──
let bannerTimer = 0
watch(
  () => [store.activeTabId, store.activeTab?.currentPage],
  () => {
    clearTimeout(bannerTimer)
    bannerTimer = window.setTimeout(() => {
      const tab = store.activeTab
      if (!tab) { noTextBanner.value = false; return }
      const pageEl = document.querySelector(`.pv-scroll[data-tab="${tab.id}"] .pv-page[data-page="${tab.currentPage}"]`)
      noTextBanner.value = pageEl?.getAttribute('data-has-text') === '0'
    }, 400)
  },
)

let resizeTimer = 0
function onResize(): void {
  clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    for (const c of controllers.values()) c.onResize()
  }, 150)
}

// position autosave every 5s + on unload
let posTimer = 0
onMounted(async () => {
  await initStore()
  // phones: sidebar starts closed regardless of persisted desktop preference
  if (window.innerWidth < 700) store.settings.sidebarOpen = false
  applyTheme()
  initWakeLock()
  setKeepAwake(store.settings.keepAwake)
  startStats()
  // a phone that lost its settings still has its books
  void platform().listImported().then((paths) => {
    for (const p of paths) addToLibrary(p)
  }).catch(() => {})
  window.addEventListener('keydown', onKey)
  window.addEventListener('focus', onFocus)
  window.addEventListener('resize', onResize)
  posTimer = window.setInterval(() => { const t = store.activeTab; if (t) savePosition(t) }, 5000)

  // E2E harness — used by browser tests and by the native debug bridge
  ;(window as any).__solopdf = {
    open: (name: string) =>
      openPath(name.startsWith('/') ? name : `/Volumes/Dev/code/pdf/test-fixtures/${name}`),
    openLink: (url: string) => handleDeepLink(url),
    store,
    controllers,
    annotManagers,
    documents,
    printDocument,
    exportMd,
    ocr: await import('./ocr'),
    openImageOcr: (p: string) => { imageOcrPath.value = p },
    toggleBookMode,
    rotateDoc,
    toggleAutoScroll,
    toggleBookmark,
    highlightSelection,
    setTool: (k: 'none' | 'note' | 'region') => { tool.value = k },
    openDocTools: () => { docToolsOpen.value = true },
    setReadAloud: (on: boolean) => { readAloud.value = on },
    lookupWord: (w: string) => { dictWord.value = { word: w, anchor: null } },
    translateSelection,
    translateText: (text: string) => { translateReq.value = { text, anchor: null, sel: null, tabId: store.activeTabId } },
    translateReq,
    setTranslateStub: async (on: boolean) => (await import('./translate')).setTranslateStub(on),
    openStats: () => { statsOpen.value = true },
    openLibrarySearch: () => { librarySearchOpen.value = true },
    readAloudRef: readAloud,
    tts: { speaker, startReading, stopReading },
    epubBooks,
    comicBooks,
    closeTab,
  }

  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    // deep links + files passed by OS (file association / second instance)
    const { listen } = await import('@tauri-apps/api/event')
    // RunEvent::Opened delivers file:// URLs (Finder double-click, iOS Files
    // "open with") — both live (event) and buffered-at-cold-launch
    // (startup_files) arrivals need the same decode to a plain path
    const openOsFile = (f: string): void => {
      if (f.startsWith('solopdf://')) handleDeepLink(f)
      else if (f.startsWith('file://')) void openPath(decodeURIComponent(f.replace(/^file:\/\//, '')))
      // content:// (Android "open with") goes through openPath untouched —
      // the importer turns it into a path we own
      else void openPath(f)
    }
    // Android delivers "open with" through the deep-link plugin's URL event
    // rather than RunEvent::Opened, which only exists on Apple platforms.
    // getCurrent() covers the cold-launch case: the plugin reads the launch
    // intent in load(), which happens before this listener exists.
    if (/Android/i.test(navigator.userAgent)) {
      const dl = await import('@tauri-apps/plugin-deep-link')
      await dl.onOpenUrl((urls) => { for (const u of urls) openOsFile(u) }).catch(() => {})
      const launched = await dl.getCurrent().catch(() => null)
      for (const u of launched ?? []) openOsFile(u)
    }
    await listen<string[]>('solopdf://open-files', (e) => {
      for (const f of e.payload) openOsFile(f)
    })
    const args = await invoke<string[]>('startup_files')
    for (const f of args) openOsFile(f)
    // debug bridge polling (only when app launched with SOLOPDF_DEBUG=1)
    if (await invoke<boolean>('debug_enabled')) {
      setInterval(async () => {
        const cmds = await invoke<[number, string][]>('debug_poll')
        for (const [id, js] of cmds) {
          let out: string
          try {
            const val = await new Function(`return (async () => { ${js} })()`)()
            out = typeof val === 'string' ? val : JSON.stringify(val) ?? 'undefined'
          } catch (e) {
            out = 'ERR: ' + String(e)
          }
          await invoke('debug_report', { id, result: out })
        }
      }, 200)
    }
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('resize', onResize)
  stopStats()
  clearTimeout(resizeTimer)
  clearInterval(posTimer)
})

watch(() => store.settings.keepAwake, (on) => setKeepAwake(on))
// speech that keeps reading a document you navigated away from is a bug
watch(() => store.activeTabId, () => { readAloud.value = false })

// zoom / dark-pdf propagation
watch(() => store.settings.darkPdf, (m) => {
  for (const c of controllers.values()) c.setDarkPdf(m)
})
watch(() => store.settings.theme, () => {
  for (const c of controllers.values()) c.setDarkPdf(store.settings.darkPdf)
})
</script>

<template>
  <div class="app">
    <TabBar v-if="!store.activeTab?.bookMode || chromeReveal" @new="pickAndOpen" @close="onCloseTab" />
    <div class="app-main">
      <div
        v-if="store.settings.sidebarOpen && store.activeTab && store.activeTab.kind === 'pdf'"
        class="sidebar-backdrop"
        @click="store.settings.sidebarOpen = false"
      ></div>
      <Sidebar v-if="store.settings.sidebarOpen && store.activeTab && store.activeTab.kind === 'pdf'" />
      <div class="app-content">
        <Toolbar
          v-if="store.activeTab && store.activeTab.kind === 'pdf' && (!store.activeTab.bookMode || chromeReveal)"
          @search="searchOpen = !searchOpen"
          @settings="settingsOpen = true"
          @print="doPrint"
          @save-filled="saveFilledForm"
          @export-md="exportMd"
          @ocr="ocrOpen = true"
          @book="toggleBookMode"
          @view="viewMenuOpen = !viewMenuOpen"
          @bookmark="toggleBookmark"
          @doc-tools="docToolsOpen = true"
          @speak="readAloud = !readAloud"
          :speaking="readAloud"
          @tool="(k) => (tool = tool === k ? 'none' : k)"
          :bookmarked="!!currentBookmark"
          :tool="tool"
        />
        <LibraryView
          v-if="!store.tabs.length"
          @pick="pickAndOpen"
          @open="openPath"
          @ocr-image="pickImageForOcr"
          @search="librarySearchOpen = true"
          @toast="showToast"
        />
        <template v-for="tab in store.tabs" :key="tab.id">
          <div
            v-show="tab.id === store.activeTabId && !tab.bookMode"
            class="pv-scroll"
            :data-tab="tab.id"
          >
            <div v-if="tab.loadError" class="welcome">
              <h1>{{ t('app.cantOpen') }}</h1>
              <p>{{ tab.loadError }}</p>
              <button class="open-btn" @click="onCloseTab(tab.id)">{{ t('app.closeTab') }}</button>
            </div>
          </div>
          <ComicView
            v-if="tab.kind === 'comic' || tab.kind === 'djvu'"
            v-show="tab.id === store.activeTabId"
            :tab-id="tab.id"
            @chrome="chromeReveal = !chromeReveal"
          />
          <BookView
            v-else-if="tab.bookMode"
            v-show="tab.id === store.activeTabId"
            :tab-id="tab.id"
            :source="tab.kind === 'mobi' ? 'epub' : tab.kind"
            @selection="(s) => (selection = s)"
            @ocr="ocrOpen = true"
            @chrome="chromeReveal = !chromeReveal"
          />
        </template>
        <div v-if="noTextBanner" class="notext-banner">
          {{ t('app.noTextLayer') }}
          <button v-if="isTauri()" class="banner-ocr-btn" @click="ocrOpen = true">{{ t('app.ocrBanner') }}</button>
        </div>
        <SearchBar v-if="searchOpen && store.activeTab" @close="searchOpen = false" />
      </div>
    </div>

    <HighlightPopover
      v-if="selection && tool === 'none' && !translateReq"
      :selection="selection"
      @pick="highlightSelection"
      @note="askNoteForSelection"
      @copy="copySelection"
      @define="defineSelection"
      @translate="translateSelection"
    />

    <TranslatePopup
      v-if="translateReq"
      :text="translateReq.text"
      :anchor="translateReq.anchor"
      @close="translateReq = null"
      @toast="showToast"
      @add-note="addTranslationNote"
      @define="(w) => { translateReq = null; dictWord = { word: w, anchor: null } }"
      @settings="translateReq = null; settingsOpen = true"
    />

    <DictPopup
      v-if="dictWord"
      :word="dictWord.word"
      :anchor="dictWord.anchor"
      @close="dictWord = null"
      @toast="showToast"
    />

    <AnnotToolLayer
      v-if="tool !== 'none' && store.activeTab && store.activeTab.kind === 'pdf' && !store.activeTab.bookMode"
      :tab-id="store.activeTab.id"
      :tool="tool"
      @cancel="tool = 'none'"
      @done="(m) => { tool = 'none'; showToast(m) }"
    />

    <div v-if="pendingNote" class="modal-mask" @click.self="pendingNote = null">
      <div class="modal at-editor">
        <h3>{{ t('at.noteTitle') }}</h3>
        <textarea
          v-model="pendingNote.text"
          :placeholder="t('at.placeholder')"
          rows="4"
          autofocus
          @keydown.enter.meta="saveSelectionNote()"
        ></textarea>
        <div class="modal-actions">
          <button @click="pendingNote = null">{{ t('at.cancel') }}</button>
          <button class="primary" @click="saveSelectionNote()">{{ t('at.save') }}</button>
        </div>
      </div>
    </div>

    <PasswordDialog
      v-if="pwRequest"
      :retry="pwRequest.retry"
      @submit="(pw) => pwRequest!.resolve(pw)"
      @cancel="pwRequest!.resolve(null)"
    />

    <div v-if="privacyAsk" class="modal-mask">
      <div class="modal">
        <h3>{{ t('pv.title') }}</h3>
        <p class="modal-note">{{ t('pv.body') }}</p>
        <div class="modal-actions">
          <button @click="privacyAsk!.resolve(true)">{{ t('pv.strip') }}</button>
          <button class="primary" @click="privacyAsk!.resolve(false)">{{ t('pv.normal') }}</button>
        </div>
      </div>
    </div>

    <ViewMenu
      v-if="viewMenuOpen && store.activeTab && store.activeTab.kind === 'pdf'"
      @close="viewMenuOpen = false"
      @toast="showToast"
    />
    <ReadAloudBar v-if="readAloud && store.activeTab" @close="readAloud = false" />

    <DocTools
      v-if="docToolsOpen && store.activeTab && store.activeTab.kind === 'pdf'"
      @close="docToolsOpen = false"
      @toast="showToast"
      @open="(p) => { docToolsOpen = false; void openPath(p) }"
    />
    <LibrarySearch
      v-if="librarySearchOpen"
      @close="librarySearchOpen = false"
      @toast="showToast"
      @open="(p, page, annot) => { librarySearchOpen = false; void openPath(p, { page, annot }) }"
    />
    <StatsPanel v-if="statsOpen" @close="statsOpen = false" @toast="showToast" />
    <SettingsPanel
      v-if="settingsOpen"
      @close="settingsOpen = false"
      @stats="settingsOpen = false; statsOpen = true"
    />
    <OcrDialog v-if="ocrOpen && store.activeTab" @close="ocrOpen = false" @done="onOcrDone" />
    <ImageOcrDialog
      v-if="imageOcrPath"
      :path="imageOcrPath"
      @close="imageOcrPath = ''"
      @toast="showToast"
    />
    <ImageOcrDialog
      v-if="imageOcrBytes"
      :bytes="imageOcrBytes.bytes"
      :name="imageOcrBytes.name"
      @close="imageOcrBytes = null"
      @toast="showToast"
    />
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
