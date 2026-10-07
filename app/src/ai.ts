/**
 * Ask AI — the app side.
 *
 * Off by default and bring-your-own-endpoint, exactly like the translation
 * provider: nothing is sent until the reader (1) turned it on in Settings,
 * (2) approved the endpoint once, and (3) asked something. Retrieval,
 * prompts, map-reduce and stream parsing live in @solopdf/core (shared with
 * the CLI); this file only supplies
 *   - the document's text, page by page (PDF via pdf.js, EPUB/MOBI/TXT by
 *     chapter), indexed once per tab
 *   - the transport: Rust streams on desktop/iOS (same reason translate goes
 *     through Rust: CORS and the OS TLS stack), the WebView fetch on Android
 *     and in the web build
 *   - the per-tab conversation state the panel renders
 */
import { reactive } from 'vue'
import {
  indexDocument, textFromItems, aiProviderReady, askDocument, explainPassage, summarizePage, summarizeDocument,
  uiLangToTarget, isLocalEndpoint, endpointHost, citedPages, sidecarSafe,
  type AiProvider, type DocIndex, type PageText, type StreamTransport, type CiteUnit, type TaskResult, type AiError,
  type ProviderRequest,
} from '@solopdf/core'
import { isTauri } from './platform'
import { store, documents, epubBooks, txtBooks, annotManagers, type AiSettings } from './store'
import { currentLocale, t } from './i18n'

export function aiSettings(): AiSettings {
  return store.settings.ai
}

/** turned on AND pointed somewhere */
export function aiReady(): boolean {
  const s = store.settings.ai
  return !!s?.enabled && aiProviderReady(s.provider)
}

const endpointKey = (p: AiProvider): string => p.baseUrl.trim().replace(/\/+$/, '')

export function endpointApproved(): boolean {
  const s = store.settings.ai
  return s.approved.includes(endpointKey(s.provider))
}

export function approveEndpoint(): void {
  const s = store.settings.ai
  const k = endpointKey(s.provider)
  if (!s.approved.includes(k)) s.approved = [...s.approved, k].slice(-20)
}

export function endpointInfo(): { url: string; host: string; local: boolean; model: string } {
  const p = store.settings.ai.provider
  return { url: p.baseUrl.trim(), host: endpointHost(p.baseUrl), local: isLocalEndpoint(p.baseUrl), model: p.model.trim() }
}

// ── transport ───────────────────────────────────────────────────────────

const isAndroid = (): boolean => /Android/i.test(navigator.userAgent)

const abortError = (): Error => {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

/** WebView fetch, streaming the body (Android, web build) */
const fetchTransport: StreamTransport = async (req, signal) => {
  const res = await fetch(req.url, {
    method: 'POST',
    headers: Object.fromEntries([...req.headers, ['Content-Type', 'application/json']]),
    body: req.body,
    signal,
  })
  const reader = res.body?.getReader()
  const dec = new TextDecoder()
  return {
    status: res.status,
    chunks: (async function* () {
      if (!reader) { yield await res.text(); return }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        yield dec.decode(value, { stream: true })
      }
      const tail = dec.decode()
      if (tail) yield tail
    })(),
  }
}

let nextStreamId = 1

/** Rust (ureq + OS TLS) → Tauri channel, one message per SSE line */
const tauriTransport: StreamTransport = async (req: ProviderRequest, signal) => {
  const { invoke, Channel } = await import('@tauri-apps/api/core')
  const id = nextStreamId++
  const queue: string[] = []
  let ended = false
  let failure: unknown = null
  let wake: (() => void) | null = null
  const poke = (): void => { const w = wake; wake = null; w?.() }
  let gotStatus: (n: number) => void = () => {}
  let noStatus: (e: unknown) => void = () => {}
  const status = new Promise<number>((res, rej) => { gotStatus = res; noStatus = rej })

  const ch = new Channel<{ status?: number; data?: string; end?: boolean }>()
  ch.onmessage = (m) => {
    if (typeof m.status === 'number') gotStatus(m.status)
    else if (typeof m.data === 'string') queue.push(m.data)
    else if (m.end) ended = true
    poke()
  }
  const onAbort = (): void => {
    void invoke('ai_http_cancel', { id }).catch(() => {})
    failure = abortError()
    noStatus(failure)
    poke()
  }
  if (signal?.aborted) throw abortError()
  signal?.addEventListener('abort', onAbort, { once: true })
  invoke('ai_http_stream', { id, url: req.url, headers: req.headers, body: req.body, onEvent: ch })
    .catch((e) => { failure = new Error(String(e)); noStatus(failure); poke() })

  const code = await status
  return {
    status: code,
    chunks: (async function* () {
      try {
        for (;;) {
          if (queue.length) { yield queue.shift()!; continue }
          if (failure) throw failure
          if (ended) return
          await new Promise<void>((r) => { wake = r })
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    })(),
  }
}

export function transport(): StreamTransport {
  return isTauri() && !isAndroid() ? tauriTransport : fetchTransport
}

// ── the document's text ─────────────────────────────────────────────────

export interface DocText {
  index: DocIndex
  unit: CiteUnit
  /** highest page / chapter number (citation range) */
  max: number
  /** characters of text in the whole document */
  chars: number
}

const docCache = new Map<number, Promise<DocText>>()

/** chapter HTML → text with paragraph breaks kept */
function htmlText(html: string): string {
  const withBreaks = html.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section)>|<br\s*\/?>/gi, '$&\n')
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html')
  return doc.body.textContent ?? ''
}

async function extractPages(tabId: number, onProgress?: (done: number, total: number) => void): Promise<{ pages: PageText[]; unit: CiteUnit }> {
  const tab = store.tabs.find((t) => t.id === tabId)
  if (!tab) throw new Error('no document')
  if (tab.kind === 'pdf') {
    const doc = documents.get(tabId)
    if (!doc) throw new Error('document not loaded')
    const pages: PageText[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      pages.push({ page: p, text: textFromItems(tc.items as { str?: string; hasEOL?: boolean }[]) })
      onProgress?.(p, doc.numPages)
      if (p % 25 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    return { pages, unit: 'page' }
  }
  if (tab.kind === 'txt') {
    const book = txtBooks.get(tabId)
    const by = new Map<number, string[]>()
    for (const b of book?.blocks ?? []) {
      const list = by.get(b.page) ?? []
      list.push(b.text)
      by.set(b.page, list)
    }
    return { pages: [...by].map(([page, t]) => ({ page, text: t.join('\n\n') })), unit: 'chapter' }
  }
  if (tab.kind === 'epub' || tab.kind === 'mobi') {
    const book = epubBooks.get(tabId)
    const n = book?.chapters.length ?? 0
    const pages: PageText[] = []
    for (let c = 1; c <= n; c++) {
      pages.push({ page: c, text: htmlText(book!.chapterHtml(c)) })
      onProgress?.(c, n)
      if (c % 10 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    return { pages, unit: 'chapter' }
  }
  throw new Error('unsupported')
}

/** whether this tab has text the assistant can read */
export function aiSupported(kind: string | undefined): boolean {
  return kind === 'pdf' || kind === 'epub' || kind === 'mobi' || kind === 'txt'
}

/** text + BM25 index for a tab, built once (the progress hook sees the first build) */
export function documentText(tabId: number, onProgress?: (done: number, total: number) => void): Promise<DocText> {
  // tab ids are never reused: drop entries for closed tabs
  for (const id of docCache.keys()) if (!store.tabs.some((t) => t.id === id)) docCache.delete(id)
  let p = docCache.get(tabId)
  if (!p) {
    p = extractPages(tabId, onProgress).then(({ pages, unit }) => ({
      index: indexDocument(pages),
      unit,
      max: pages.reduce((m, x) => Math.max(m, x.page), 0),
      chars: pages.reduce((n, x) => n + x.text.trim().length, 0),
    }))
    p.catch(() => docCache.delete(tabId))
    docCache.set(tabId, p)
  }
  return p
}

// ── conversation state ──────────────────────────────────────────────────

export type EntryKind = 'summary' | 'page' | 'ask' | 'explain'

export interface AiEntry {
  id: number
  kind: EntryKind
  /** the question / selection / page the entry is about */
  prompt: string
  /** page the entry is about (page summary, explain) */
  page?: number
  text: string
  status: 'reading' | 'running' | 'done' | 'error' | 'cancelled'
  error?: AiError
  progress?: { done: number; total: number; phase: 'extract' | 'map' }
  sources: number[]
  truncated?: boolean
  /** where it was sent (settings may change afterwards) */
  endpoint: { url: string; model: string }
  /** id of the sidecar note made from this answer */
  savedId?: string
}

export const aiState = reactive({
  /** panel visible */
  open: false,
  /** per tab id */
  threads: {} as Record<number, AiEntry[]>,
  /** explain-selection request handed over by the shell */
  pending: null as null | { tabId: number; text: string; page: number },
})

const controllers = new Map<number, AbortController>()
let nextEntry = 1

export function entriesFor(tabId: number): AiEntry[] {
  return (aiState.threads[tabId] ??= [])
}

export function cancelEntry(e: AiEntry): void {
  controllers.get(e.id)?.abort()
}

export function isRunning(e: AiEntry): boolean {
  return e.status === 'reading' || e.status === 'running'
}

/** summary language: the UI's */
const uiLang = (): string => uiLangToTarget(currentLocale.value)

/**
 * Run one task for a tab and stream it into a new entry. Callers have
 * already checked aiReady() and endpointApproved().
 */
export async function runTask(
  tabId: number,
  kind: EntryKind,
  prompt: string,
  page?: number,
): Promise<AiEntry> {
  const list = entriesFor(tabId)
  const { url, model } = endpointInfo()
  list.push({ id: nextEntry++, kind, prompt, page, text: '', status: 'reading', sources: [], endpoint: { url, model } })
  // the reactive proxy, so the panel sees every write
  const entry = list[list.length - 1]
  const ac = new AbortController()
  controllers.set(entry.id, ac)
  const tab = store.tabs.find((t) => t.id === tabId)
  const ctx = { docName: tab?.name ?? '', lang: uiLang() }
  const s = store.settings.ai
  const send = transport()
  try {
    const doc = await documentText(tabId, (done, total) => {
      entry.progress = { done, total, phase: 'extract' }
    })
    entry.progress = undefined
    if (ac.signal.aborted) { entry.status = 'cancelled'; return entry }
    if (doc.chars < 20) {
      entry.status = 'error'
      entry.error = { code: 'empty', message: 'notext' }
      return entry
    }
    entry.status = 'running'
    const fullCtx = { ...ctx, unit: doc.unit }
    const hooks = {
      signal: ac.signal,
      onText: (t: string) => { entry.text = t },
      onProgress: (done: number, total: number) => {
        entry.progress = total > 1 ? { done, total, phase: 'map' } : undefined
      },
    }
    let r: TaskResult
    if (kind === 'ask') r = await askDocument(s.provider, doc.index, prompt, fullCtx, send, { ...hooks, k: s.topK })
    else if (kind === 'explain') r = await explainPassage(s.provider, doc.index, prompt, page ?? 1, fullCtx, send, hooks)
    else if (kind === 'page') r = await summarizePage(s.provider, doc.index, page ?? 1, fullCtx, send, hooks)
    else r = await summarizeDocument(s.provider, doc.index, fullCtx, send, { ...hooks, budgetChars: s.summaryBudget })
    entry.sources = r.sources
    entry.truncated = r.truncated
    entry.progress = undefined
    if (r.error) {
      entry.status = r.error.code === 'cancelled' ? 'cancelled' : 'error'
      entry.error = r.error
    } else {
      entry.text = r.text ?? ''
      entry.status = 'done'
    }
  } catch (e) {
    entry.status = ac.signal.aborted ? 'cancelled' : 'error'
    entry.error = { code: 'network', message: String((e as Error)?.message ?? e) }
  } finally {
    controllers.delete(entry.id)
  }
  return entry
}

/** highest citable page (PDF) / chapter (books) of a tab, for parseCitations */
export function citeMax(tabId: number): number {
  const tab = store.tabs.find((t) => t.id === tabId)
  if (!tab) return 0
  if (tab.kind === 'pdf') return tab.numPages
  if (tab.kind === 'epub' || tab.kind === 'mobi') return epubBooks.get(tabId)?.chapters.length ?? 0
  if (tab.kind === 'txt') return (txtBooks.get(tabId)?.blocks ?? []).reduce((m, b) => Math.max(m, b.page), 0)
  return 0
}

/** what an entry was about, in the UI language (panel title, note heading) */
export function entryTitle(e: AiEntry, unit: CiteUnit): string {
  if (e.kind === 'summary') return t('ai.qSummaryDoc')
  if (e.kind === 'page') return t(unit === 'chapter' ? 'ai.qSummaryChapter' : 'ai.qSummaryPage', { page: e.page ?? '' })
  if (e.kind === 'explain') {
    const s = e.prompt.replace(/\s+/g, ' ').trim()
    return t('ai.qExplain', { text: s.length > 80 ? s.slice(0, 80) + '…' : s })
  }
  return e.prompt.trim()
}

export const unitOf = (tabId: number): CiteUnit =>
  store.tabs.find((t) => t.id === tabId)?.kind === 'pdf' ? 'page' : 'chapter'

/**
 * "Save to notes": the answer becomes an ordinary note annotation in the
 * Markdown sidecar, pinned to the page of its first citation. It goes
 * through the annotation manager, so ⌘Z undoes it like any other edit, and
 * the note keeps its [p.N] citations as written (the section carries the
 * jump-back link).
 */
export async function saveEntryAsNote(tabId: number, e: AiEntry): Promise<{ id: string; page: number; file: string }> {
  const tab = store.tabs.find((x) => x.id === tabId)
  const mgr = annotManagers.get(tabId)
  if (!tab || !mgr) throw new Error('no document')
  const max = citeMax(tabId)
  const page = citedPages(e.text, max)[0] ?? e.page ?? e.sources[0] ?? tab.currentPage ?? 1
  const p = store.settings.ai.provider
  const body = [
    `**AI · ${entryTitle(e, unitOf(tabId)).replace(/\*/g, '')}**`,
    '',
    sidecarSafe(e.text),
    '',
    `*${p.model.trim()} · ${endpointHost(p.baseUrl)}*`,
  ].join('\n')
  let x = 0
  let y = 0
  const doc = documents.get(tabId)
  if (tab.kind === 'pdf' && doc) {
    // a pin in the page's top-right margin, clear of the text
    const view = (await doc.getPage(page)).view
    x = view[2] - 24
    y = view[3] - 24
  }
  const a = await mgr.addNote(page, x, y, body)
  e.savedId = a.id
  return { id: a.id, page, file: mgr.sidecarLocation.split('/').pop() ?? '' }
}

/** the saved note is still in the sidecar (an undo removes it) */
export function noteStillThere(tabId: number, e: AiEntry): boolean {
  return !!e.savedId && !!annotManagers.get(tabId)?.annotations.some((a) => a.id === e.savedId)
}
