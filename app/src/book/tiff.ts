/**
 * TIFF / multi-page TIFF, as a pile of page images (the comic/DjVu viewer).
 *
 * Decoding is UTIF (utif2, MIT, pure JS — same code on desktop, phones and in
 * the browser harness): CCITT G3/G4 fax pages, LZW, PackBits, Deflate, JPEG.
 * The file is parsed for its page directory once; pixels are decoded per page
 * on demand, painted to a canvas and kept as a PNG blob URL in a small window
 * around the reader (a 300-page scan does not fit in a phone's memory).
 *
 * Decoding is synchronous work, so it is pushed off the current frame and
 * the view gets "rendering…" first; store.docTick tells it a page landed,
 * exactly like the DjVu source.
 */
import { store } from '../store'

type Ifd = Record<string, unknown> & { width?: number; height?: number; data?: Uint8Array }
interface Utif {
  decode(buf: ArrayBuffer): Ifd[]
  decodeImage(buf: ArrayBuffer, ifd: Ifd): void
  toRGBA8(ifd: Ifd): Uint8Array
}

/** pages larger than this are drawn downscaled (canvas limits on iOS ≈ 16.7MP) */
const MAX_PIXELS = 16_000_000

export class TiffBook {
  pages: { name: string; index: number }[] = []
  sizes: [number, number][] = []
  private buf: ArrayBuffer | null = null
  private ifds: Ifd[] = []
  private utif: Utif | null = null
  private urls = new Map<number, string>()
  private pending = new Set<number>()
  private destroyed = false

  async load(bytes: Uint8Array): Promise<void> {
    const mod = (await import('utif2')) as unknown as { default?: Utif } & Utif
    this.utif = mod.default ?? mod
    // UTIF wants an ArrayBuffer of exactly the file
    this.buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer)
    let all: Ifd[]
    try {
      all = this.utif.decode(this.buf).filter((d) => d.t256 && d.t257)
    } catch {
      throw new Error('tiffBad')
    }
    // NewSubfileType bit 0 = reduced-resolution copy (thumbnail), not a page
    const real = all.filter((d) => !(((d.t254 as number[] | undefined)?.[0] ?? 0) & 1))
    this.ifds = real.length ? real : all
    if (!this.ifds.length) throw new Error('tiffEmpty')
    this.sizes = this.ifds.map((d) => [(d.t256 as number[])[0], (d.t257 as number[])[0]])
    this.pages = this.ifds.map((_, index) => ({ name: `${index + 1}`, index }))
  }

  /** cached page, or null while it decodes */
  urlFor(index: number): string | null {
    const hit = this.urls.get(index)
    if (hit) return hit
    void this.ensure(index)
    return null
  }

  /** decode one page to a canvas (full size unless it is enormous) */
  private paint(index: number): HTMLCanvasElement {
    const ifd = this.ifds[index]
    const u = this.utif!
    u.decodeImage(this.buf!, ifd)
    const w = ifd.width ?? 0
    const h = ifd.height ?? 0
    const rgba = u.toRGBA8(ifd)
    ifd.data = undefined // the decoded strip buffer is now in rgba; let it go
    const full = document.createElement('canvas')
    full.width = w
    full.height = h
    full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, w * h * 4), w, h), 0, 0)
    if (w * h <= MAX_PIXELS) return full
    const k = Math.sqrt(MAX_PIXELS / (w * h))
    const small = document.createElement('canvas')
    small.width = Math.floor(w * k)
    small.height = Math.floor(h * k)
    const ctx = small.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(full, 0, 0, small.width, small.height)
    full.width = 0
    return small
  }

  async ensure(index: number): Promise<void> {
    if (this.destroyed || index < 0 || index >= this.pages.length) return
    if (this.urls.has(index) || this.pending.has(index)) return
    this.pending.add(index)
    try {
      // let "rendering…" paint before the synchronous decode
      await new Promise((r) => setTimeout(r, 0))
      if (this.destroyed) return
      const canvas = this.paint(index)
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
      canvas.width = 0
      if (this.destroyed || !blob) return
      this.urls.set(index, URL.createObjectURL(blob))
      store.docTick++
    } catch (e) {
      console.warn('[tiff] page', index + 1, 'failed:', e)
    } finally {
      this.pending.delete(index)
    }
  }

  /** keep [from, to] decoded, drop the rest */
  trim(from: number, to: number): void {
    for (const [index, url] of this.urls) {
      if (index < from || index > to) {
        URL.revokeObjectURL(url)
        this.urls.delete(index)
      }
    }
    for (let i = Math.max(0, from); i <= Math.min(this.pages.length - 1, to); i++) void this.ensure(i)
  }

  /** one page as JPEG bytes — what the OCR engine eats */
  async pageJpeg(index: number): Promise<Uint8Array> {
    const canvas = this.paint(index)
    // OCR wants dark text on white: flatten any transparency onto white
    const flat = document.createElement('canvas')
    flat.width = canvas.width
    flat.height = canvas.height
    const ctx = flat.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, flat.width, flat.height)
    ctx.drawImage(canvas, 0, 0)
    canvas.width = 0
    const blob = await new Promise<Blob | null>((r) => flat.toBlob(r, 'image/jpeg', 0.9))
    flat.width = 0
    if (!blob) throw new Error('encode failed')
    return new Uint8Array(await blob.arrayBuffer())
  }

  /** small first-page render for the shelf */
  coverCanvas(maxW = 320): HTMLCanvasElement {
    const page = this.paint(0)
    const k = Math.min(1, maxW / page.width)
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(page.width * k))
    c.height = Math.max(1, Math.round(page.height * k))
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(page, 0, 0, c.width, c.height)
    page.width = 0
    return c
  }

  destroy(): void {
    this.destroyed = true
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
    this.pending.clear()
    this.ifds = []
    this.buf = null
  }
}
