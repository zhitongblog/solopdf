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
import type { CropRect } from './viewer/geometry'

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
  /** 文档类型:EPUB/TXT 走图书视图,漫画走 ComicView */
  kind: 'pdf' | 'epub' | 'txt' | 'comic' | 'mobi' | 'djvu'
  /** 图书模式的精确位置(块序):TXT 的 page 粒度是"章",长章恢复
   *  到章首体验差——存/恢复都以块为准,page 仅作章级回退 */
  bookBlock: number
  /** printed page labels from the PDF ("xii", "23"), one per physical page;
   *  null when the document has none. Display only — everything persisted
   *  (sidecar anchors, deep links, bookmarks) stays on physical numbers. */
  pageLabels: string[] | null
}

export interface BookSettings {
  /** 布局:auto = 桌面翻页(宽屏双页)/手机滚动 */
  layout: 'auto' | 'paged' | 'scroll'
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

/** Per-document view state — rotation and crop belong to the FILE, not to
 *  the app: a sideways scan is sideways every time you open it. Capped so
 *  state.json can't grow without bound. */
export interface DocPrefs {
  /** whole-document rotation in degrees */
  rotation?: number
  /** per-page extra rotation, keyed by 1-based page number */
  pageRotations?: Record<string, number>
  /** display-only margin trim */
  crop?: CropRect
  /** last time this entry was touched (for LRU eviction) */
  at?: number
}

export const MAX_DOC_PREFS = 300

/**
 * A place the reader wants to come back to. Deliberately NOT in the sidecar:
 * bookmarks are navigation, not notes, and the whole point of the sidecar is
 * that everything in it is something you wrote.
 */
export interface Bookmark {
  page: number
  /** book-mode block index (TXT/EPUB reflow), when applicable */
  block?: number
  /** scroll offset within the page, 0–1 */
  ratio?: number
  label: string
  /** creation time, doubles as the identity key */
  at: number
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  darkPdf: 'off' | 'smart'
  updateCheck: boolean
  sidebarTab: 'outline' | 'thumbs' | 'annots' | 'marks'
  sidebarOpen: boolean
  language: 'system' | Locale
  book: BookSettings
  /** PDF view: vertical scroll through the doc vs one spread at a time */
  scrollMode: 'continuous' | 'paged'
  /** 1 = single page, 2 = facing pages */
  spread: 1 | 2
  /** in facing mode, page 1 stands alone like a book cover */
  coverAlone: boolean
  /** auto-scroll speed in px/second (0 = off; the toggle keeps the speed) */
  autoScrollSpeed: number
  /** hold the screen backlight while a document is open */
  keepAwake: boolean
  /** book-mode auto-scroll speed in px/second */
  bookAutoSpeed: number
  /** read-aloud voice settings */
  tts: TtsSettings
  /** comic reader */
  comic: ComicSettings
  /** colour a fresh highlight gets */
  defaultColor: string
  /** where the dictionary's explicit "search the web" button goes; %s = word.
   *  Never used automatically — SoloPDF makes no network request on its own. */
  webLookupUrl: string
  /** tint laid under PDF pages (multiply blend); ignored while dark mode
   *  inverts pages — see paperActive() */
  paper: PaperColor
}

export type PaperColor = 'white' | 'sepia' | 'green' | 'grey'

export interface ComicSettings {
  /** 1 = one page, 2 = two-up where the window is wide enough */
  spread: 1 | 2
  /** right-to-left page order (manga) */
  rtl: boolean
  fit: 'height' | 'width' | 'contain'
}

export interface TtsSettings {
  rate: number
  pitch: number
  /** empty = let the engine pick by language */
  voiceURI: string
  /** BCP-47 hint used when no voice is chosen */
  lang: string
}

interface PersistedState {
  settings: Settings
  recents: string[]
  /** reading positions: key = path, fallback key = "hash:<hex>" */
  positions: Record<string, { page: number; ratio: number }>
  hashes: Record<string, string>
  docPrefs: Record<string, DocPrefs>
  bookmarks: Record<string, Bookmark[]>
  stats: import('./stats').Stats
  library: Record<string, import('./library').LibraryItem>
  libraryFolders: string[]
}

/** phones and tablets get different reading defaults from desktops — see the
 *  mobile/desktop split rule: gesture-first small screens want one screenful
 *  per flick, big screens want a continuous scroll under a mouse wheel. */
const MOBILE = /iPhone|iPad|Android/i.test(navigator.userAgent)

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  darkPdf: 'smart',
  updateCheck: false,
  sidebarTab: 'outline',
  sidebarOpen: !MOBILE,
  language: 'system',
  book: { layout: 'auto', bg: 'paper', font: 'sans', size: 18, lineHeight: 1.9, maxWidth: 38 },
  scrollMode: MOBILE ? 'paged' : 'continuous',
  spread: 1,
  coverAlone: true,
  autoScrollSpeed: MOBILE ? 40 : 60,
  // phones are where a sleeping screen actually interrupts reading
  keepAwake: MOBILE,
  bookAutoSpeed: MOBILE ? 30 : 40,
  tts: { rate: 1, pitch: 1, voiceURI: '', lang: '' },
  comic: { spread: MOBILE ? 1 : 2, rtl: false, fit: 'height' },
  defaultColor: 'yellow',
  webLookupUrl: 'https://www.google.com/search?q=define+%s',
  paper: 'white',
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
  docPrefs: {} as Record<string, DocPrefs>,
  bookmarks: {} as Record<string, Bookmark[]>,
  stats: { docs: {}, days: {} } as import('./stats').Stats,
  library: {} as Record<string, import('./library').LibraryItem>,
  libraryFolders: [] as string[],
  loaded: false,

  get activeTab(): TabState | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId)
  },
})

/** non-reactive registries, keyed by tab id */
export const controllers = new Map<number, PdfViewerController>()
export const documents = new Map<number, PDFDocumentProxy>()
export const annotManagers = new Map<number, AnnotationManager>()
/** EPUB and MOBI/KF8 share a chapter interface, so they share a registry —
 *  BookView only ever asks for chapters, toc and chapterHtml(). */
export const epubBooks = new Map<
  number,
  import('./book/epub').EpubBook | import('./book/mobi').MobiBook
>()
export const txtBooks = new Map<number, import('@solopdf/core').TxtBook>()
/** Paged image documents: comics and DjVu scans differ only in how a page
 *  is produced, so they share the reader and this registry. */
export const comicBooks = new Map<
  number,
  import('./book/comic').ComicBook | import('./book/djvu').DjvuBook
>()

/** Book-mode hooks the reader needs from outside the component: which blocks
 *  are on screen, and how to turn to the next lot. Registered by BookView. */
export interface BookApi {
  blocks(): HTMLElement[]
  /** advance one screen/section; false when the book ends */
  advance(): Promise<boolean>
}
export const bookApis = new Map<number, BookApi>()

export function effectiveTheme(): 'light' | 'dark' {
  if (store.settings.theme !== 'system') return store.settings.theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Paper colour is off while dark mode inverts pages: a sepia tint under an
 * inverted canvas comes out as a muddy blue, and the reader who picked dark
 * mode already chose how bright the page should be. With inversion off the
 * page is shown as-is, so the tint still applies.
 */
export function paperSuppressed(): boolean {
  return effectiveTheme() === 'dark' && store.settings.darkPdf === 'smart'
}

/** the paper colour actually painted right now ('white' = none) */
export function paperActive(): PaperColor {
  return paperSuppressed() ? 'white' : store.settings.paper
}

/** printed label for a physical page of a tab (the number when unlabelled) */
export function labelOf(tab: Pick<TabState, 'pageLabels'> | undefined, page: number): string {
  return tab?.pageLabels?.[page - 1] ?? String(page)
}

export async function initStore(): Promise<void> {
  const s = (await platform().loadState()) as Partial<PersistedState>
  if (s.settings) {
    Object.assign(store.settings, s.settings)
    // 嵌套对象要与默认值深合并:旧版本存的 book 缺新字段(如 layout)
    // 时,整体覆盖会让新字段变 undefined
    store.settings.book = { ...DEFAULT_SETTINGS.book, ...(s.settings.book ?? {}) }
    store.settings.tts = { ...DEFAULT_SETTINGS.tts, ...(s.settings.tts ?? {}) }
    store.settings.comic = { ...DEFAULT_SETTINGS.comic, ...(s.settings.comic ?? {}) }
  }
  if (s.recents) store.recents = s.recents
  if (s.positions) store.positions = s.positions
  if (s.hashes) store.hashes = s.hashes
  if (s.docPrefs) store.docPrefs = s.docPrefs
  if (s.bookmarks) store.bookmarks = s.bookmarks
  if (s.stats) store.stats = { docs: s.stats.docs ?? {}, days: s.stats.days ?? {} }
  if (s.library) store.library = s.library
  if (s.libraryFolders) store.libraryFolders = s.libraryFolders
  applyLanguage()
  watch(() => store.settings.language, applyLanguage)
  store.loaded = true
  // persist on change, debounced
  let t = 0
  watch(
    () => [
      store.settings, store.recents, store.positions, store.hashes,
      store.docPrefs, store.bookmarks, store.stats, store.library, store.libraryFolders,
    ],
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
    docPrefs: { ...store.docPrefs },
    bookmarks: { ...store.bookmarks },
    stats: { docs: { ...store.stats.docs }, days: { ...store.stats.days } },
    library: { ...store.library },
    libraryFolders: [...store.libraryFolders],
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
    bookBlock: 0,
    pageLabels: null,
    kind: /\.epub$/i.test(path) ? 'epub'
      : /\.txt$/i.test(path) ? 'txt'
      : /\.(cbz|cbr)$/i.test(path) ? 'comic'
      : /\.(mobi|azw3|azw|prc)$/i.test(path) ? 'mobi'
      : /\.djvu?$/i.test(path) ? 'djvu'
      : 'pdf',
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
  annotManagers.get(id)?.dispose()
  annotManagers.delete(id)
  epubBooks.get(id)?.destroy()
  epubBooks.delete(id)
  txtBooks.delete(id)
  comicBooks.get(id)?.destroy()
  comicBooks.delete(id)
  bookApis.delete(id)
  store.tabs.splice(i, 1)
  if (store.activeTabId === id) {
    store.activeTabId = store.tabs[Math.min(i, store.tabs.length - 1)]?.id ?? 0
  }
}

/** per-document view prefs, keyed by path with a content-hash fallback */
export function docPrefsFor(path: string): DocPrefs {
  const h = store.hashes[path]
  return store.docPrefs[path] ?? (h ? store.docPrefs[`hash:${h}`] : undefined) ?? {}
}

export function saveDocPrefs(path: string, patch: DocPrefs): void {
  const next = { ...docPrefsFor(path), ...patch, at: Date.now() }
  const empty = !next.rotation && !next.crop &&
    !Object.keys(next.pageRotations ?? {}).length
  if (empty) {
    // the hash twin too — docPrefsFor falls back to it, so leaving it would
    // bring the old rotation/crop straight back
    delete store.docPrefs[path]
    const h = store.hashes[path]
    if (h) delete store.docPrefs[`hash:${h}`]
  } else {
    store.docPrefs[path] = next
    const h = store.hashes[path]
    if (h) store.docPrefs[`hash:${h}`] = next
  }
  // LRU eviction — oldest entries go first
  const keys = Object.keys(store.docPrefs)
  if (keys.length > MAX_DOC_PREFS) {
    keys
      .sort((a, b) => (store.docPrefs[a].at ?? 0) - (store.docPrefs[b].at ?? 0))
      .slice(0, keys.length - MAX_DOC_PREFS)
      .forEach((k) => delete store.docPrefs[k])
  }
}

// ── bookmarks ────────────────────────────────────────────────────────────
// Keyed by path with a content-hash mirror, exactly like reading positions:
// files get moved and re-downloaded, and losing every bookmark to a rename
// is the kind of thing that makes people stop trusting an app.

export function bookmarksFor(path: string): Bookmark[] {
  const h = store.hashes[path]
  return store.bookmarks[path] ?? (h ? store.bookmarks[`hash:${h}`] : undefined) ?? []
}

function writeBookmarks(path: string, list: Bookmark[]): void {
  const sorted = [...list].sort((a, b) => a.page - b.page || (a.block ?? 0) - (b.block ?? 0))
  if (sorted.length) store.bookmarks[path] = sorted
  else delete store.bookmarks[path]
  const h = store.hashes[path]
  if (h) {
    if (sorted.length) store.bookmarks[`hash:${h}`] = sorted
    else delete store.bookmarks[`hash:${h}`]
  }
}

export function addBookmark(path: string, bm: Omit<Bookmark, 'at'>): Bookmark {
  const entry: Bookmark = { ...bm, at: Date.now() }
  writeBookmarks(path, [...bookmarksFor(path), entry])
  return entry
}

export function removeBookmark(path: string, at: number): void {
  writeBookmarks(path, bookmarksFor(path).filter((b) => b.at !== at))
}

export function renameBookmark(path: string, at: number, label: string): void {
  writeBookmarks(path, bookmarksFor(path).map((b) => (b.at === at ? { ...b, label } : b)))
}

/** the bookmark on the tab's current page, if any (drives the ★ toggle) */
export function bookmarkAt(path: string, page: number): Bookmark | undefined {
  return bookmarksFor(path).find((b) => b.page === page)
}

export function addRecent(path: string): void {
  store.recents = [path, ...store.recents.filter((p) => p !== path)].slice(0, 20)
}

export function savePosition(tab: TabState): void {
  const ctrl = controllers.get(tab.id)
  if (!ctrl && tab.kind === 'pdf') return
  // 图书标签页:ratio 字段复用为块序(整数),恢复时精确到段落
  const pos = ctrl ? ctrl.getPosition() : { page: tab.currentPage, ratio: tab.bookBlock || 0 }
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
