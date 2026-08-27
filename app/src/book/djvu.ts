/**
 * DjVu, as a pile of page images.
 *
 * Decoding happens in Rust (djvu-rs, pure Rust and MIT — the reference
 * DjVuLibre is GPL and cannot ship in the App Store build). Each page comes
 * back as a PNG, so the reader is the same one comics use.
 *
 * Rendering is asynchronous, which comics are not, so this class keeps a
 * small window of decoded pages around the reader, kicks off the missing
 * ones, and bumps store.docTick when a page lands — that is what makes the
 * view re-evaluate without ComicView knowing anything about DjVu.
 */
import { store } from '../store'
import { isTauri } from '../platform'

export interface DjvuOutlineEntry {
  title: string
  /** 1-based; 0 when the outline target isn't a plain page number */
  page: number
  depth: number
}

/** how wide to decode a page, in device pixels */
const RENDER_WIDTH = 1400

export class DjvuBook {
  pages: { name: string; index: number }[] = []
  sizes: [number, number][] = []
  outline: DjvuOutlineEntry[] = []
  private path = ''
  private urls = new Map<number, string>()
  private pending = new Set<number>()
  private destroyed = false

  async load(path: string): Promise<void> {
    if (!isTauri()) throw new Error('djvuDesktopOnly')
    this.path = path
    const { invoke } = await import('@tauri-apps/api/core')
    const info = await invoke<{
      pages: number
      sizes: [number, number][]
      bookmarks: DjvuOutlineEntry[]
    }>('djvu_info', { path })
    this.sizes = info.sizes
    this.outline = info.bookmarks
    this.pages = Array.from({ length: info.pages }, (_, index) => ({
      name: `${index + 1}`,
      index,
    }))
    if (!this.pages.length) throw new Error('djvuEmpty')
  }

  /** cached page, or null while it decodes */
  urlFor(index: number): string | null {
    const hit = this.urls.get(index)
    if (hit) return hit
    void this.ensure(index)
    return null
  }

  /** start decoding a page if it isn't already cached or in flight */
  async ensure(index: number): Promise<void> {
    if (this.destroyed) return
    if (index < 0 || index >= this.pages.length) return
    if (this.urls.has(index) || this.pending.has(index)) return
    this.pending.add(index)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const buf = await invoke<ArrayBuffer>('djvu_page', {
        path: this.path,
        page: index,
        width: RENDER_WIDTH,
      })
      if (this.destroyed || !buf.byteLength) return
      this.urls.set(index, URL.createObjectURL(new Blob([buf], { type: 'image/png' })))
      // the view reads pages through a computed; this is its signal
      store.docTick++
    } catch {
      /* an unreadable page shows as a gap, not as a broken document */
    } finally {
      this.pending.delete(index)
    }
  }

  /** keep [from, to] decoded, drop the rest — DjVu scans are big */
  trim(from: number, to: number): void {
    for (const [index, url] of this.urls) {
      if (index < from || index > to) {
        URL.revokeObjectURL(url)
        this.urls.delete(index)
      }
    }
    for (let i = Math.max(0, from); i <= Math.min(this.pages.length - 1, to); i++) {
      void this.ensure(i)
    }
  }

  /** page text, for the cross-document index (many DjVu scans carry one) */
  async textOf(index: number): Promise<string> {
    if (!isTauri()) return ''
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<string>('djvu_text', { path: this.path, page: index }).catch(() => '')
  }

  destroy(): void {
    this.destroyed = true
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
    this.pending.clear()
  }
}
