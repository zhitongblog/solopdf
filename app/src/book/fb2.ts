/**
 * FictionBook 2 reader (.fb2, zipped .fbz / .fb2.zip).
 *
 * Parsing lives in core (shared with the CLI/MCP, pure TS, no DOMParser);
 * this class only adapts it to the chapter interface BookView already speaks
 * for EPUB and MOBI: title / chapters / toc / chapterHtml / destroy. Images
 * are base64 <binary> blobs inside the XML — turned into blob URLs the first
 * time a chapter that shows them is rendered, and revoked on close.
 */
import { unzipSync } from 'fflate'
import {
  parseFb2, isZipBytes, pickFb2Entry, base64ToBytes, type Fb2Book as Fb2Data, type Fb2TocEntry,
} from '@solopdf/core'

export class Fb2Book {
  title = ''
  authors: string[] = []
  chapters: { href: string }[] = []
  toc: Fb2TocEntry[] = []
  coverId: string | null = null
  private data: Fb2Data | null = null
  private blobUrls = new Map<string, string>()
  private htmlCache = new Map<number, string>()

  load(bytes: Uint8Array): void {
    let xml = bytes
    if (isZipBytes(bytes)) {
      const files = unzipSync(bytes, { filter: (f) => /\.(fb2|xml)$/i.test(f.name) })
      const entry = pickFb2Entry(Object.keys(files))
      if (!entry) throw new Error('fb2NoBook')
      xml = files[entry]
    }
    try {
      this.data = parseFb2(xml)
    } catch (e) {
      const code = String((e as Error)?.message ?? e)
      throw new Error(code.startsWith('fb2') ? code : 'fb2Bad')
    }
    this.title = this.data.title
    this.authors = this.data.authors
    this.toc = this.data.toc
    this.coverId = this.data.coverId
    // BookView only needs the count; href is a stable per-chapter label
    this.chapters = this.data.chapters.map((_, i) => ({ href: `#ch${i + 1}` }))
  }

  /** blob URL for a <binary id>, created on first use */
  imageUrl(id: string): string | null {
    const hit = this.blobUrls.get(id)
    if (hit) return hit
    const bin = this.data?.binaries.get(id)
    if (!bin) return null
    try {
      const bytes = base64ToBytes(bin.base64)
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: bin.contentType }))
      this.blobUrls.set(id, url)
      return url
    } catch {
      return null // corrupt base64: the image is simply missing
    }
  }

  /** chapter → render-ready HTML (1-based; cached) */
  chapterHtml(chapter: number): string {
    const cached = this.htmlCache.get(chapter)
    if (cached !== undefined) return cached
    const ch = this.data?.chapters[chapter - 1]
    if (!ch) return ''
    // core escapes every attribute it writes, so the id is a plain token here
    const html = ch.html.replace(/<img data-fb2-src="([^"]*)" alt="([^"]*)">/g, (_m, id: string, alt: string) => {
      const url = this.imageUrl(unescapeAttr(id))
      return url ? `<img src="${url}" alt="${alt}">` : ''
    })
    this.htmlCache.set(chapter, html)
    return html
  }

  /** chapter plain text (search, empty-book probe) */
  chapterText(chapter: number): string {
    return this.data?.chapters[chapter - 1]?.text ?? ''
  }

  probeTextLength(maxChapters = 5): number {
    let n = 0
    for (let c = 1; c <= Math.min(maxChapters, this.chapters.length); c++) n += this.chapterText(c).trim().length
    return n
  }

  /** cover image bytes + type, for the shelf thumbnail */
  coverBytes(): { bytes: Uint8Array; type: string } | null {
    const bin = this.coverId ? this.data?.binaries.get(this.coverId) : undefined
    if (!bin) return null
    try {
      return { bytes: base64ToBytes(bin.base64), type: bin.contentType }
    } catch {
      return null
    }
  }

  destroy(): void {
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url)
    this.blobUrls.clear()
    this.htmlCache.clear()
    this.data = null
  }
}

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
