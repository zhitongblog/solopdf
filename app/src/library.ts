/**
 * The shelf.
 *
 * Until now "your documents" meant a list of the last 20 paths. That is fine
 * on a desktop with a Finder behind it and useless on a phone, which has no
 * file manager at all — so the shelf is the mobile file manager, and on
 * desktop it is the thing that remembers where you were in each book.
 *
 * Entries come from two places:
 *   - every document you open (automatically)
 *   - folders you point SoloPDF at (desktop only; a sandboxed phone has no
 *     folder to scan)
 *
 * Covers are rendered once from page 1 and cached in appData, never beside
 * the document.
 */
import { store, type TabState } from './store'
import { isTauri } from './platform'
import {
  citeKey, extractCitation, findArxivId, findDoi, parseBibtex, readCitationInput,
  type CitationMeta,
} from '@solopdf/core'
import { openDocument } from './viewer/loader'

export type ReadStatus = 'unread' | 'reading' | 'done'

export interface LibraryItem {
  path: string
  name: string
  kind: 'pdf' | 'epub' | 'txt' | 'comic' | 'mobi' | 'djvu' | 'fb2' | 'tiff' | 'other'
  addedAt: number
  lastOpenedAt: number
  favorite?: boolean
  tags?: string[]
  pages?: number
  /** cover cache key (also the file stem in appData/covers) */
  cover?: string
  /** false once a scan or an open finds the file gone */
  missing?: boolean
  /** explicit reading status; falls back to progressOf(item) when unset */
  readStatus?: ReadStatus
  /** cached academic citation metadata (from PDF or imported .bib) */
  cite?: CitationMeta
  /** custom or derived BibTeX citekey */
  citeKey?: string
}

export function kindOf(path: string): LibraryItem['kind'] {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  if (/\.fb2\.zip$/i.test(path) || ext === 'fb2' || ext === 'fbz') return 'fb2'
  if (ext === 'tif' || ext === 'tiff') return 'tiff'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'epub') return 'epub'
  if (ext === 'txt') return 'txt'
  if (ext === 'cbz' || ext === 'cbr' || ext === 'zip') return 'comic'
  if (ext === 'mobi' || ext === 'azw3' || ext === 'azw' || ext === 'prc') return 'mobi'
  if (ext === 'djvu' || ext === 'djv') return 'djvu'
  return 'other'
}

/** stable, filesystem-safe key for a path (FNV-1a; only needs to not collide) */
export function pathKey(path: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `c${h.toString(16).padStart(8, '0')}${path.length.toString(36)}`
}

export function addToLibrary(path: string, patch: Partial<LibraryItem> = {}): LibraryItem {
  const now = Date.now()
  const prev = store.library[path]
  // order matters: existing entry first (it holds tags/favourite/cover),
  // then the fields we always derive, then the caller's patch
  const item: LibraryItem = {
    ...prev,
    path,
    name: patch.name ?? prev?.name ?? path.split('/').pop() ?? path,
    kind: kindOf(path),
    addedAt: prev?.addedAt ?? now,
    lastOpenedAt: prev?.lastOpenedAt ?? 0,
    ...patch,
  }
  store.library[path] = item
  return item
}

export function noteOpened(tab: TabState): void {
  addToLibrary(tab.path, {
    name: tab.name,
    lastOpenedAt: Date.now(),
    pages: tab.numPages || undefined,
    missing: false,
  })
}

export function removeFromLibrary(path: string): void {
  delete store.library[path]
}

export function toggleFavorite(path: string): void {
  const item = store.library[path]
  if (item) item.favorite = !item.favorite
}

export function setTags(path: string, tags: string[]): void {
  const item = store.library[path]
  if (item) item.tags = tags.filter(Boolean)
}

/** every tag in use, for the filter row */
export function allTags(): string[] {
  const set = new Set<string>()
  for (const item of Object.values(store.library)) for (const t of item.tags ?? []) set.add(t)
  return [...set].sort()
}

/** 0–1, from the reading position we already keep */
export function progressOf(item: LibraryItem): number {
  const pos = store.positions[item.path]
  if (!pos || !item.pages) return 0
  return Math.min(1, Math.max(0, (pos.page - 1 + (pos.ratio || 0)) / item.pages))
}

/** effective reading status: explicit user choice overrides progress heuristic */
export function statusOf(item: LibraryItem): ReadStatus {
  if (item.readStatus) return item.readStatus
  const p = progressOf(item)
  if (p >= 0.98) return 'done'
  if (p > 0.001) return 'reading'
  return 'unread'
}

export function setReadStatus(path: string, status: ReadStatus): void {
  const item = store.library[path]
  if (item) item.readStatus = status
}

export function cycleReadStatus(path: string): ReadStatus {
  const item = store.library[path]
  if (!item) return 'unread'
  const cur = statusOf(item)
  const next: ReadStatus = cur === 'unread' ? 'reading' : cur === 'reading' ? 'done' : 'unread'
  item.readStatus = next
  return next
}

export function setLibraryCite(path: string, meta: CitationMeta, customKey?: string): void {
  const item = store.library[path]
  if (!item) return
  item.cite = meta
  item.citeKey = (customKey?.trim() || citeKey(meta)).replace(/[\s,{}]/g, '') || 'ref'
}

/** citation metadata for a shelf item, synthesizing a minimal fallback from filename */
export function citeOf(item: LibraryItem): CitationMeta {
  if (item.cite) return item.cite
  const stem = item.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || item.name
  return {
    title: stem,
    authors: [],
    type: 'misc',
    source: { title: 'fileName', authors: 'none', year: 'none' },
  }
}

export function citeKeyOf(item: LibraryItem): string {
  return item.citeKey || citeKey(citeOf(item))
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

/**
 * Import a `.bib` file into the local shelf: match parsed entries against
 * existing local documents by DOI → arXiv ID → normalized title / citekey,
 * enriching their cached `cite` + `citeKey`.
 */
export function importBibtexToLibrary(bibText: string): { total: number; matched: number } {
  const entries = parseBibtex(bibText)
  const items = Object.values(store.library)
  let matched = 0
  for (const e of entries) {
    const eDoi = e.meta.doi?.toLowerCase()
    const eArxiv = e.meta.arxiv?.toLowerCase()
    const eTitle = normTitle(e.meta.title)
    const eKey = e.key.toLowerCase()

    const hit = items.find((it) => {
      const c = it.cite
      if (eDoi && c?.doi?.toLowerCase() === eDoi) return true
      if (eArxiv && (c?.arxiv?.toLowerCase() === eArxiv || it.name.toLowerCase().includes(eArxiv))) return true
      if (eKey.length >= 4 && (it.citeKey?.toLowerCase() === eKey || it.name.toLowerCase().includes(eKey))) return true
      if (eTitle.length >= 8) {
        const iTitle = normTitle(c?.title || it.name.replace(/\.[^.]+$/, ''))
        if (iTitle === eTitle || (iTitle.length >= 8 && (iTitle.includes(eTitle) || eTitle.includes(iTitle)))) return true
      }
      return false
    })
    if (hit) {
      setLibraryCite(hit.path, e.meta, e.key)
      matched++
    }
  }
  return { total: entries.length, matched }
}

/**
 * Batch-extract academic citation metadata (title, authors, year, DOI, arXiv)
 * for PDFs on the shelf that haven't been indexed yet. Opens each PDF silently
 * (skipping encrypted ones), reads only XMP/Info + first 2 pages, and destroys
 * the document immediately so RAM stays flat.
 */
export async function extractMissingMetadata(
  items: LibraryItem[],
  onProgress: (done: number, total: number) => void,
  signal: { cancelled: boolean },
): Promise<{ done: number; updated: number }> {
  const todo = items.filter((it) => it.kind === 'pdf' && !it.missing && !it.cite)
  const total = todo.length
  let done = 0
  let updated = 0
  onProgress(0, total)
  for (const it of todo) {
    if (signal.cancelled) break
    try {
      const { doc } = await openDocument(it.path, async () => null)
      try {
        const inp = await readCitationInput(doc as never, it.name, 2)
        const meta = extractCitation(inp)
        setLibraryCite(it.path, meta)
        if (!it.pages && doc.numPages) {
          const cur = store.library[it.path]
          if (cur) cur.pages = doc.numPages
        }
        updated++
      } finally {
        await doc.destroy().catch(() => {})
      }
    } catch {
      /* password-protected or unreadable PDF — skip gracefully */
    }
    done++
    onProgress(done, total)
    await new Promise((r) => setTimeout(r, 0))
  }
  return { done, updated }
}

/**
 * Given a reference snippet from an in-text citation preview (e.g. "[12] Vaswani
 * et al., Attention Is All You Need, 2017, arXiv:1706.03762"), try to find a
 * matching paper already on the user's local shelf.
 */
export function findLibraryPaper(refText: string, excludePath?: string): LibraryItem | null {
  const clean = refText.trim()
  if (clean.length < 8) return null
  const doi = findDoi(clean)?.toLowerCase()
  const arxiv = findArxivId(clean)?.id.toLowerCase()
  const normRef = normTitle(clean)
  const candidates = Object.values(store.library).filter((it) => !it.missing && it.path !== excludePath)

  // 1. Exact DOI match
  if (doi) {
    const hit = candidates.find((it) => it.cite?.doi?.toLowerCase() === doi)
    if (hit) return hit
  }
  // 2. Exact arXiv ID match
  if (arxiv) {
    const hit = candidates.find((it) =>
      it.cite?.arxiv?.toLowerCase() === arxiv || it.name.toLowerCase().includes(arxiv),
    )
    if (hit) return hit
  }
  // 3. Normalized title substring match (require >= 14 normalized chars to avoid false positives)
  let best: LibraryItem | null = null
  let bestLen = 0
  for (const it of candidates) {
    const t0 = normTitle(it.cite?.title || it.name.replace(/\.[^.]+$/, ''))
    if (t0.length >= 14 && normRef.includes(t0) && t0.length > bestLen) {
      best = it
      bestLen = t0.length
    }
  }
  return best
}

// ── folders (desktop) ────────────────────────────────────────────────────

export async function addFolder(path: string): Promise<number> {
  if (!store.libraryFolders.includes(path)) store.libraryFolders = [...store.libraryFolders, path]
  return await scanFolder(path)
}

export function removeFolder(path: string): void {
  store.libraryFolders = store.libraryFolders.filter((p) => p !== path)
}

export async function scanFolder(path: string, maxDepth = 4): Promise<number> {
  if (!isTauri()) return 0
  const { invoke } = await import('@tauri-apps/api/core')
  const files = await invoke<{ path: string; name: string }[]>('scan_folder', { path, maxDepth })
  for (const f of files) addToLibrary(f.path, { name: f.name })
  return files.length
}

export async function rescanAll(): Promise<number> {
  let n = 0
  for (const folder of store.libraryFolders) n += await scanFolder(folder)
  return n
}

/** mark entries whose file has gone away, without deleting the reader's tags */
export async function refreshMissing(): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  for (const item of Object.values(store.library)) {
    const there = await invoke<boolean>('file_exists', { path: item.path }).catch(() => true)
    item.missing = !there
  }
}

// ── covers ───────────────────────────────────────────────────────────────

const coverUrls = new Map<string, string>()

export async function coverUrl(item: LibraryItem): Promise<string | null> {
  if (!item.cover) return null
  const hit = coverUrls.get(item.cover)
  if (hit) return hit
  if (!isTauri()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const buf = await invoke<ArrayBuffer>('read_cover', { key: item.cover })
    if (!buf.byteLength) return null
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }))
    coverUrls.set(item.cover, url)
    return url
  } catch {
    return null
  }
}

/**
 * Render and cache a cover from an already-open document. Called after a
 * successful open, so it costs one extra small render and never blocks the
 * first page appearing.
 */
export async function captureCover(path: string, canvas: HTMLCanvasElement): Promise<void> {
  if (!isTauri()) return
  const key = pathKey(path)
  try {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.72))
    if (!blob) return
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('write_cover', new Uint8Array(await blob.arrayBuffer()), {
      headers: { 'x-key': encodeURIComponent(key) },
    })
    coverUrls.delete(key)
    addToLibrary(path, { cover: key })
  } catch {
    /* a missing cover is cosmetic */
  }
}
