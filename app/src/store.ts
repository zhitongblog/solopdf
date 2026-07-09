/**
 * Global app state (Vue reactive) + persistence via platform backend.
 * Heavy per-document state (controller) lives outside reactivity; tabs hold
 * plain metadata plus an id into the controller registry.
 */
import { reactive, watch } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { platform } from './platform'
import type { PdfViewerController } from './viewer/controller'
import type { AnnotationManager } from './annotations/manager'
import { detectSystemLocale, setLocale, type Locale } from './i18n'

export interface TabState {
  id: number
  path: string
  name: string
  numPages: number
  currentPage: number
  encrypted: boolean
  /** per-doc privacy switch: strip excerpts/fingerprints (encrypted PDFs) */
  stripExcerpts: boolean
  sidecarLocation: string
  loadError: string | null
  /** user has edited AcroForm fields — "保存已填表单" appears */
  formsDirty: boolean
  /** 图书阅读模式(重排视图) */
  bookMode: boolean
}

export interface BookSettings {
  /** 底色主题 */
  bg: 'paper' | 'sepia' | 'green' | 'night'
  /** 字体栈 */
  font: 'sans' | 'serif' | 'kai'
  /** 正文字号 px */
  size: number
  lineHeight: number
  /** 版心最大宽度(em) */
  maxWidth: number
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  darkPdf: 'off' | 'smart'
  updateCheck: boolean
  sidebarTab: 'outline' | 'thumbs' | 'annots'
  sidebarOpen: boolean
  language: 'system' | Locale
  book: BookSettings
}

interface PersistedState {
  settings: Settings
  recents: string[]
  /** reading positions: key = path, fallback key = "hash:<hex>" */
  positions: Record<string, { page: number; ratio: number }>
  hashes: Record<string, string>
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  darkPdf: 'smart',
  updateCheck: false,
  sidebarTab: 'outline',
  sidebarOpen: true,
  language: 'system',
  book: { bg: 'paper', font: 'sans', size: 18, lineHeight: 1.9, maxWidth: 38 },
}

export function applyLanguage(): void {
  const l = store.settings.language
  setLocale(l === 'system' ? detectSystemLocale() : l)
}

let nextTabId = 1

export const store = reactive({
  tabs: [] as TabState[],
  activeTabId: 0,
  /** bumped whenever the non-reactive registries (controllers/documents/
   *  annotManagers) change — computeds that read those Maps must touch this */
  docTick: 0,
  settings: { ...DEFAULT_SETTINGS },
  recents: [] as string[],
  positions: {} as Record<string, { page: number; ratio: number }>,
  hashes: {} as Record<string, string>,
  loaded: false,

  get activeTab(): TabState | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId)
  },
})

/** non-reactive registries, keyed by tab id */
export const controllers = new Map<number, PdfViewerController>()
export const documents = new Map<number, PDFDocumentProxy>()
export const annotManagers = new Map<number, AnnotationManager>()

export function effectiveTheme(): 'light' | 'dark' {
  if (store.settings.theme !== 'system') return store.settings.theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export async function initStore(): Promise<void> {
  const s = (await platform().loadState()) as Partial<PersistedState>
  if (s.settings) Object.assign(store.settings, s.settings)
  if (s.recents) store.recents = s.recents
  if (s.positions) store.positions = s.positions
  if (s.hashes) store.hashes = s.hashes
  applyLanguage()
  watch(() => store.settings.language, applyLanguage)
  store.loaded = true
  // persist on change, debounced
  let t = 0
  watch(
    () => [store.settings, store.recents, store.positions, store.hashes],
    () => {
      clearTimeout(t)
      t = window.setTimeout(persist, 400)
    },
    { deep: true },
  )
}

async function persist(): Promise<void> {
  await platform().saveState({
    settings: { ...store.settings },
    recents: [...store.recents],
    positions: { ...store.positions },
    hashes: { ...store.hashes },
  })
}

export function newTab(path: string): TabState {
  const t: TabState = {
    id: nextTabId++,
    path,
    name: path.split('/').pop() ?? path,
    numPages: 0,
    currentPage: 1,
    encrypted: false,
    stripExcerpts: false,
    sidecarLocation: '',
    loadError: null,
    formsDirty: false,
    bookMode: false,
  }
  store.tabs.push(t)
  store.activeTabId = t.id
  // return the reactive proxy from the array — mutating the raw object
  // would silently skip reactivity (numPages showed "/0" in first E2E run)
  return store.tabs[store.tabs.length - 1]
}

export function closeTab(id: number): void {
  const i = store.tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  controllers.get(id)?.destroy()
  controllers.delete(id)
  documents.delete(id)
  annotManagers.delete(id)
  store.tabs.splice(i, 1)
  if (store.activeTabId === id) {
    store.activeTabId = store.tabs[Math.min(i, store.tabs.length - 1)]?.id ?? 0
  }
}

export function addRecent(path: string): void {
  store.recents = [path, ...store.recents.filter((p) => p !== path)].slice(0, 20)
}

export function savePosition(tab: TabState): void {
  const ctrl = controllers.get(tab.id)
  if (!ctrl) return
  const pos = ctrl.getPosition()
  store.positions[tab.path] = pos
  const h = store.hashes[tab.path]
  if (h) store.positions[`hash:${h}`] = pos
}

/**
 * Restore position: path key first; on miss, wait for the background hash
 * and (if a hash-keyed record exists) smooth-scroll there — never reads the
 * whole file on the render path (design doc rule).
 */
export function restorePosition(tab: TabState): void {
  const ctrl = controllers.get(tab.id)
  if (!ctrl) return
  const byPath = store.positions[tab.path]
  if (byPath) {
    ctrl.restorePosition(byPath)
    return
  }
  void platform()
    .fileHash(tab.path)
    .then((h) => {
      store.hashes[tab.path] = h
      const byHash = store.positions[`hash:${h}`]
      if (byHash && controllers.get(tab.id) === ctrl) {
        ctrl.restorePosition(byHash)
      }
    })
    .catch(() => {})
}
