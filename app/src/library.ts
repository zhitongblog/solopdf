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

export interface LibraryItem {
  path: string
  name: string
  kind: 'pdf' | 'epub' | 'txt' | 'comic' | 'mobi' | 'djvu' | 'other'
  addedAt: number
  lastOpenedAt: number
  favorite?: boolean
  tags?: string[]
  pages?: number
  /** cover cache key (also the file stem in appData/covers) */
  cover?: string
  /** false once a scan or an open finds the file gone */
  missing?: boolean
}

export function kindOf(path: string): LibraryItem['kind'] {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (ext === 'epub') return 'epub'
  if (ext === 'txt') return 'txt'
  if (ext === 'cbz' || ext === 'cbr') return 'comic'
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
