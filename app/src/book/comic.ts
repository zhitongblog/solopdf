/**
 * Comic archives: CBZ (zip) and CBR (rar).
 *
 * A comic is an ordered pile of images, so the whole model is "sorted entry
 * names + a way to get bytes for one of them". Pages are decoded lazily and
 * released again as you move away — a 300-page scan at 2MB a page will not
 * fit in a phone's memory, and pre-decoding it would be the fastest way to
 * get killed by the OS.
 *
 * CBZ goes through fflate, already here for EPUB. CBR goes through
 * node-unrar-js (MIT wrapper around the UnRAR sources; see NOTICE), loaded
 * only when a .cbr is actually opened so nobody pays for it otherwise.
 */
import { unzipSync } from 'fflate'

const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i

export interface ComicPage {
  name: string
  /** index in reading order */
  index: number
}

/** natural sort: page2 before page10, which plain string order gets wrong */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g
  const ax = a.toLowerCase().match(re) ?? []
  const bx = b.toLowerCase().match(re) ?? []
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const x = ax[i]
    const y = bx[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d/.test(x)
    const ny = /^\d/.test(y)
    if (nx && ny) {
      const d = parseInt(x, 10) - parseInt(y, 10)
      if (d) return d
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export class ComicBook {
  pages: ComicPage[] = []
  /** archive kind, for error messages */
  kind: 'cbz' | 'cbr' = 'cbz'
  private zip: Record<string, Uint8Array> | null = null
  private rar: { extract(name: string): Uint8Array | null } | null = null
  private urls = new Map<number, string>()

  async load(bytes: Uint8Array, path: string): Promise<void> {
    this.kind = /\.cbr$/i.test(path) || isRar(bytes) ? 'cbr' : 'cbz'
    if (this.kind === 'cbz') await this.loadZip(bytes)
    else await this.loadRar(bytes)
    if (!this.pages.length) throw new Error('archiveEmpty')
  }

  private async loadZip(bytes: Uint8Array): Promise<void> {
    const files = unzipSync(bytes, { filter: (f) => IMAGE_RE.test(f.name) && !f.name.includes('__MACOSX/') })
    this.zip = files
    this.pages = Object.keys(files)
      .sort(naturalCompare)
      .map((name, index) => ({ name, index }))
  }

  private async loadRar(bytes: Uint8Array): Promise<void> {
    const { createExtractorFromData } = await import('node-unrar-js')
    // node-unrar-js wants its own copy: it hands the buffer to WASM
    const extractor = await createExtractorFromData({ data: bytes.slice().buffer as ArrayBuffer })
    const list = extractor.getFileList()
    const names: string[] = []
    for (const h of list.fileHeaders) {
      if (h.flags.directory || !IMAGE_RE.test(h.name)) continue
      if (h.name.includes('__MACOSX/')) continue
      names.push(h.name)
    }
    names.sort(naturalCompare)
    this.pages = names.map((name, index) => ({ name, index }))
    this.rar = {
      extract(name: string): Uint8Array | null {
        const res = extractor.extract({ files: [name] })
        for (const f of res.files) {
          if (f.extraction) return f.extraction
        }
        return null
      },
    }
  }

  private bytesFor(index: number): Uint8Array | null {
    const page = this.pages[index]
    if (!page) return null
    if (this.zip) return this.zip[page.name] ?? null
    return this.rar?.extract(page.name) ?? null
  }

  /** blob URL for one page, created on demand and cached */
  urlFor(index: number): string | null {
    const hit = this.urls.get(index)
    if (hit) return hit
    const bytes = this.bytesFor(index)
    if (!bytes) return null
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(this.pages[index].name) }))
    this.urls.set(index, url)
    return url
  }

  /** drop every cached page outside [from, to] — this is the memory budget */
  trim(from: number, to: number): void {
    for (const [index, url] of this.urls) {
      if (index < from || index > to) {
        URL.revokeObjectURL(url)
        this.urls.delete(index)
      }
    }
  }

  destroy(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
    this.zip = null
    this.rar = null
  }
}

function isRar(bytes: Uint8Array): boolean {
  // "Rar!\x1a\x07"
  return bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21
}

function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'avif') return 'image/avif'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/jpeg'
}
