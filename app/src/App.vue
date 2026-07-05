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
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import {
  store, controllers, documents, annotManagers, initStore, newTab, closeTab,
  addRecent, savePosition, restorePosition, effectiveTheme,
} from './store'
import { platform, isTauri } from './platform'
import { openDocument } from './viewer/loader'
import { PdfViewerController, type SelectionInfo } from './viewer/controller'
import { AnnotationManager } from './annotations/manager'
import { printDocument } from './print'
import TabBar from './components/TabBar.vue'
import Toolbar from './components/Toolbar.vue'
import Sidebar from './components/Sidebar.vue'
import SearchBar from './components/SearchBar.vue'
import PasswordDialog from './components/PasswordDialog.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import HighlightPopover from './components/HighlightPopover.vue'
import WelcomeScreen from './components/WelcomeScreen.vue'

const scrollHost = ref<HTMLDivElement>()
const selection = ref<SelectionInfo | null>(null)
const searchOpen = ref(false)
const settingsOpen = ref(false)
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

// ── open/close ──
async function openPath(path: string, jumpTo?: { page: number; annot?: string }): Promise<void> {
  // focus existing tab for same path
  const existing = store.tabs.find((t) => t.path === path)
  if (existing) {
    store.activeTabId = existing.id
    if (jumpTo) jumpAfterLoad(existing.id, jumpTo)
    return
  }
  const tab = newTab(path)
  await nextTick() // let the scroll host for this tab mount
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
    if (!host) throw new Error('内部错误：找不到渲染容器')
    const ctrl = new PdfViewerController(doc, host, effectiveTheme)
    ctrl.darkPdf = store.settings.darkPdf
    controllers.set(tab.id, ctrl)
    ctrl.onVisiblePage = (p) => { tab.currentPage = p }
    ctrl.onSelection = (sel) => { selection.value = sel && store.activeTabId === tab.id ? sel : null }
    ctrl.onFormsDirty = () => { tab.formsDirty = true }
    await ctrl.init()

    const mgr = new AnnotationManager(path, tab.name, tab.stripExcerpts)
    annotManagers.set(tab.id, mgr)
    store.docTick++
    mgr.onChange = (annots) => { void ctrl.setAnnotations(annots) }
    await mgr.load()
    tab.sidecarLocation = mgr.sidecarLocation

    addRecent(path)
    restorePosition(tab)
    if (jumpTo) jumpAfterLoad(tab.id, jumpTo)
  } catch (err) {
    tab.loadError = String((err as Error)?.message ?? err)
    showToast(`打开失败：${tab.loadError}`)
  }
}

function jumpAfterLoad(tabId: number, jump: { page: number; annot?: string }): void {
  setTimeout(() => {
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
async function highlightSelection(color: string): Promise<void> {
  const sel = selection.value
  const tab = store.activeTab
  if (!sel || !tab) return
  const mgr = annotManagers.get(tab.id)
  const ctrl = controllers.get(tab.id)
  if (!mgr || !ctrl) return
  // encrypted privacy prompt — once per doc
  if (tab.encrypted && !privacyAsked.has(tab.id)) {
    privacyAsked.add(tab.id)
    const strip = await new Promise<boolean>((resolve) => { privacyAsk.value = { resolve } })
    privacyAsk.value = null
    tab.stripExcerpts = strip
    mgr.stripExcerpts = strip
  }
  try {
    await mgr.addFromSelection(sel, color)
    ctrl.clearSelection()
    showToast(`已高亮 → ${mgr.sidecarLocation.split('/').pop()}`)
  } catch (err) {
    showToast(`批注保存失败：${(err as Error).message}`)
  }
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
  else if (!mod && e.key === 'Escape') { searchOpen.value = false; settingsOpen.value = false }
  else if (!mod && tab && ctrl && !isTyping(e)) {
    if (e.key === 'j' || e.key === 'PageDown') ctrl.scrollToPage(Math.min(tab.currentPage + 1, tab.numPages))
    else if (e.key === 'k' || e.key === 'PageUp') ctrl.scrollToPage(Math.max(tab.currentPage - 1, 1))
    else if (e.key === 'Home') ctrl.scrollToPage(1)
    else if (e.key === 'End') ctrl.scrollToPage(tab.numPages)
  }
}
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
}

async function saveFilledForm(): Promise<void> {
  const tab = store.activeTab
  const ctrl = tab && controllers.get(tab.id)
  if (!tab || !ctrl) return
  try {
    const bytes = await ctrl.saveFilled()
    const suggested = tab.name.replace(/\.pdf$/i, '') + '-filled.pdf'
    const dest = await platform().savePdf(suggested, bytes)
    if (dest) showToast(`已保存：${dest.split('/').pop()}`)
  } catch (err) {
    showToast(`保存失败：${(err as Error).message}`)
  }
}

async function doPrint(): Promise<void> {
  const tab = store.activeTab
  const doc = tab && documents.get(tab.id)
  if (!tab || !doc) return
  showToast('正在准备打印…')
  try {
    await printDocument(doc)
  } catch (err) {
    showToast(`打印失败：${(err as Error).message}`)
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

// position autosave every 5s + on unload
let posTimer = 0
onMounted(async () => {
  await initStore()
  applyTheme()
  window.addEventListener('keydown', onKey)
  window.addEventListener('focus', onFocus)
  posTimer = window.setInterval(() => { const t = store.activeTab; if (t) savePosition(t) }, 5000)

  if (isTauri()) {
    // deep links + files passed by OS (file association / second instance)
    const { listen } = await import('@tauri-apps/api/event')
    await listen<string[]>('solopdf://open-files', (e) => {
      for (const f of e.payload) {
        if (f.startsWith('solopdf://')) handleDeepLink(f)
        else void openPath(f)
      }
    })
    const args = await (await import('@tauri-apps/api/core')).invoke<string[]>('startup_files')
    for (const f of args) {
      if (f.startsWith('solopdf://')) handleDeepLink(f)
      else void openPath(f)
    }
  } else {
    // web E2E harness: window.__solopdf.open('<fixture>.pdf')
    ;(window as any).__solopdf = {
      open: (name: string) => openPath(`/Volumes/Dev/code/pdf/test-fixtures/${name}`),
      openLink: (url: string) => handleDeepLink(url),
      store,
      controllers,
      annotManagers,
      documents,
      printDocument,
    }
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('focus', onFocus)
  clearInterval(posTimer)
})

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
    <TabBar @new="pickAndOpen" @close="onCloseTab" />
    <div class="app-main">
      <Sidebar v-if="store.settings.sidebarOpen && store.activeTab" />
      <div class="app-content">
        <Toolbar
          v-if="store.activeTab"
          @search="searchOpen = !searchOpen"
          @settings="settingsOpen = true"
          @print="doPrint"
          @save-filled="saveFilledForm"
        />
        <WelcomeScreen v-if="!store.tabs.length" @open="pickAndOpen" @open-path="openPath" />
        <template v-for="tab in store.tabs" :key="tab.id">
          <div
            v-show="tab.id === store.activeTabId"
            class="pv-scroll"
            :data-tab="tab.id"
          >
            <div v-if="tab.loadError" class="welcome">
              <h1>无法打开</h1>
              <p>{{ tab.loadError }}</p>
              <button class="open-btn" @click="onCloseTab(tab.id)">关闭标签</button>
            </div>
          </div>
        </template>
        <div v-if="noTextBanner" class="notext-banner">该页无文字层 — 文字选择与高亮不可用</div>
        <SearchBar v-if="searchOpen && store.activeTab" @close="searchOpen = false" />
      </div>
    </div>

    <HighlightPopover v-if="selection" :selection="selection" @pick="highlightSelection" />

    <PasswordDialog
      v-if="pwRequest"
      :retry="pwRequest.retry"
      @submit="(pw) => pwRequest!.resolve(pw)"
      @cancel="pwRequest!.resolve(null)"
    />

    <div v-if="privacyAsk" class="modal-mask">
      <div class="modal">
        <h3>加密 PDF 的批注隐私</h3>
        <p class="modal-note">
          高亮摘录和定位指纹会以<b>明文</b>写入批注文件。这个 PDF 有密码，
          你可以选择仅保存批注内容、不保存原文摘录（定位精度会降低）。
        </p>
        <div class="modal-actions">
          <button @click="privacyAsk!.resolve(true)">仅存批注（更隐私）</button>
          <button class="primary" @click="privacyAsk!.resolve(false)">正常保存</button>
        </div>
      </div>
    </div>

    <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
