/**
 * Search across the whole shelf, not just the open document.
 *
 * Two passes, deliberately ordered:
 *
 *  1. ANNOTATIONS — the sidecar `.md` files. Tiny, always current, and the
 *     thing people actually want to find again ("where did I write about
 *     quantisation?"). Runs instantly over the entire library.
 *  2. FULL TEXT — the documents themselves, via a cached per-document text
 *     index. Building an index costs one full text extraction, so it happens
 *     on demand with progress and a stop button, and is reused afterwards.
 *
 * Indexes live in appData/cache/textindex, gzipped, keyed by path. They are
 * disposable: delete the folder and the worst that happens is the next
 * search is slow again.
 */
import { gzipSync, gunzipSync } from 'fflate'
import { normalize, parse as parseSidecar } from '@solopdf/core'
import { store } from './store'
import { platform, isTauri } from './platform'
import { pathKey, type LibraryItem } from './library'
import { openDocument } from './viewer/loader'

const CACHE_KIND = 'textindex'
/** bump when the on-disk shape changes */
const INDEX_VERSION = 1

export interface Hit {
  path: string
  name: string
  page: number
  /** 'text' | 'note' */
  where: 'text' | 'note'
  preview: string
  /** annotation id, when the hit came from a sidecar */
  annot?: string
}

interface TextIndex {
  v: number
  /** page number → normalized page text */
  pages: string[]
}

// ── index storage ────────────────────────────────────────────────────────

async function readIndex(path: string): Promise<TextIndex | null> {
  if (!isTauri()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const buf = await invoke<ArrayBuffer>('read_cache', { kind: CACHE_KIND, key: pathKey(path) })
    if (!buf.byteLength) return null
    const json = new TextDecoder().decode(gunzipSync(new Uint8Array(buf)))
    const idx = JSON.parse(json) as TextIndex
    return idx.v === INDEX_VERSION ? idx : null
  } catch {
    return null
  }
}

async function writeIndex(path: string, idx: TextIndex): Promise<void> {
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const bytes = gzipSync(new TextEncoder().encode(JSON.stringify(idx)), { level: 6 })
    await invoke('write_cache', bytes, {
      headers: {
        'x-kind': encodeURIComponent(CACHE_KIND),
        'x-key': encodeURIComponent(pathKey(path)),
      },
    })
  } catch {
    /* an index we couldn't cache just gets rebuilt next time */
  }
}

export async function hasIndex(path: string): Promise<boolean> {
  return (await readIndex(path)) !== null
}

export async function clearIndexes(): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('clear_cache', { kind: CACHE_KIND }).catch(() => {})
}

/**
 * Extract and cache a document's text. PDFs go through pdf.js (the same
 * engine that renders them, so the text matches what you can select); TXT is
 * read directly; EPUB is skipped for now — its text lives in the reflow
 * pipeline, not in pages.
 */
export async function buildIndex(
  item: LibraryItem,
  onProgress?: (done: number, total: number) => void,
  isCancelled: () => boolean = () => false,
): Promise<TextIndex | null> {
  if (item.kind === 'txt') {
    const meta = await platform().fileMeta(item.path)
    const bytes = await platform().readChunk(item.path, 0, meta.size)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      text = new TextDecoder('gb18030').decode(bytes)
    }
    // one "page" per 3000 characters keeps previews and jumps meaningful
    const pages: string[] = []
    for (let i = 0; i < text.length; i += 3000) pages.push(normalize(text.slice(i, i + 3000)))
    const idx = { v: INDEX_VERSION, pages }
    await writeIndex(item.path, idx)
    return idx
  }
  if (item.kind !== 'pdf') return null

  const { doc } = await openDocument(item.path, async () => null) // encrypted: skip
  try {
    const pages: string[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      if (isCancelled()) return null
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      const strings = (tc.items as { str?: string }[]).map((i) => i.str ?? '')
      pages.push(normalize(strings.join(' ')))
      onProgress?.(p, doc.numPages)
    }
    const idx = { v: INDEX_VERSION, pages }
    await writeIndex(item.path, idx)
    return idx
  } finally {
    void doc.destroy()
  }
}

// ── searching ────────────────────────────────────────────────────────────

function preview(text: string, at: number, len: number): string {
  const lo = Math.max(0, at - 24)
  const hi = Math.min(text.length, at + len + 24)
  return (
    (lo > 0 ? '…' : '') +
    text.slice(lo, at) + '「' + text.slice(at, at + len) + '」' + text.slice(at + len, hi) +
    (hi < text.length ? '…' : '')
  )
}

function searchIndex(item: LibraryItem, idx: TextIndex, q: string, cap: number): Hit[] {
  const out: Hit[] = []
  for (let p = 0; p < idx.pages.length && out.length < cap; p++) {
    const text = idx.pages[p]
    let from = 0
    while (out.length < cap) {
      const at = text.indexOf(q, from)
      if (at < 0) break
      out.push({
        path: item.path,
        name: item.name,
        page: p + 1,
        where: 'text',
        preview: preview(text, at, q.length),
      })
      from = at + Math.max(1, q.length)
    }
  }
  return out
}

/** Pass 1: every sidecar in the library. Fast enough to run on every query. */
export async function searchAnnotations(query: string, cap = 200): Promise<Hit[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: Hit[] = []
  for (const item of Object.values(store.library)) {
    if (out.length >= cap) break
    let text = ''
    try {
      text = (await platform().readSidecar(item.path)).text
    } catch {
      continue
    }
    if (!text.trim()) continue
    for (const a of parseSidecar(text).annotations) {
      const hay = `${a.excerpt}\n${a.note}`
      const at = hay.toLowerCase().indexOf(q)
      if (at < 0) continue
      out.push({
        path: item.path,
        name: item.name,
        page: a.anchor.page,
        where: 'note',
        preview: preview(hay.replace(/\n/g, ' '), at, q.length),
        annot: a.id,
      })
      if (out.length >= cap) break
    }
  }
  return out
}

export interface FullTextProgress {
  /** document being worked on */
  name: string
  doneDocs: number
  totalDocs: number
  /** page progress inside the current document, when it is being indexed */
  page?: number
  pages?: number
}

/**
 * Pass 2: full text. `buildMissing` decides whether documents without a
 * cached index get one built (slow, visible) or are skipped.
 */
export async function searchFullText(
  query: string,
  opts: {
    buildMissing: boolean
    onProgress?: (p: FullTextProgress) => void
    onHits?: (hits: Hit[]) => void
    isCancelled?: () => boolean
    cap?: number
  },
): Promise<Hit[]> {
  const q = normalize(query)
  if (!q) return []
  const cap = opts.cap ?? 300
  const isCancelled = opts.isCancelled ?? (() => false)
  const items = Object.values(store.library).filter((i) => i.kind === 'pdf' || i.kind === 'txt')
  const all: Hit[] = []
  let doneDocs = 0
  for (const item of items) {
    if (isCancelled() || all.length >= cap) break
    opts.onProgress?.({ name: item.name, doneDocs, totalDocs: items.length })
    let idx = await readIndex(item.path)
    if (!idx && opts.buildMissing) {
      try {
        idx = await buildIndex(
          item,
          (page, pages) => opts.onProgress?.({ name: item.name, doneDocs, totalDocs: items.length, page, pages }),
          isCancelled,
        )
      } catch {
        idx = null // unreadable or password-protected — not a failure of the search
      }
    }
    if (idx) {
      const hits = searchIndex(item, idx, q, cap - all.length)
      if (hits.length) {
        all.push(...hits)
        opts.onHits?.(hits)
      }
    }
    doneDocs++
  }
  opts.onProgress?.({ name: '', doneDocs, totalDocs: items.length })
  return all
}
