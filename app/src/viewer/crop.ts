/**
 * Auto margin detection ("裁边").
 *
 * Renders a handful of sampled pages at thumbnail scale, finds the bounding
 * box of non-background pixels on each, and keeps the SMALLEST margin seen —
 * conservative on purpose: a crop that eats a figure bleeding to the edge on
 * one page is much worse than a crop that leaves a few extra millimetres.
 *
 * Runs off the render path (explicit user action), at 0.2 scale, on at most
 * SAMPLES pages — a 1048-page scan costs the same as an 8-page one.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { CropRect } from './geometry'

const SAMPLES = 8
const DETECT_SCALE = 0.2
/** luminance below this counts as "content" on a white page */
const DARK = 246
/** never trim more than this fraction off one side */
const MAX_TRIM = 0.4
/** breathing room added back to每 side, in fractions */
const PAD = 0.006

/** Page indices to sample: evenly spread, skipping the cover when possible. */
function samplePages(numPages: number): number[] {
  if (numPages <= SAMPLES) return Array.from({ length: numPages }, (_, i) => i + 1)
  const first = numPages > 3 ? 2 : 1 // covers are often full-bleed
  const span = numPages - first
  const out: number[] = []
  for (let i = 0; i < SAMPLES; i++) out.push(first + Math.round((span * i) / (SAMPLES - 1)))
  return [...new Set(out)]
}

/** Content bounding box of one rendered page, as fractions of its viewport. */
function contentBox(data: Uint8ClampedArray, w: number, h: number): CropRect | null {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    const row = y * w * 4
    for (let x = 0; x < w; x++) {
      const i = row + x * 4
      // rec.601 luma is plenty for "is this pixel ink"
      const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
      if (lum < DARK) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null // blank page — contributes nothing
  return {
    l: minX / w,
    t: minY / h,
    r: (w - 1 - maxX) / w,
    b: (h - 1 - maxY) / h,
  }
}

/**
 * Detect display margins for a document.
 * `rotationOf(page)` supplies the total rotation the viewer will render with,
 * so the returned fractions are already in rotated-page space.
 */
export async function detectCrop(
  doc: PDFDocumentProxy,
  rotationOf: (page: number) => number,
  isCancelled: () => boolean = () => false,
): Promise<CropRect | null> {
  let best: CropRect | null = null
  let seen = 0
  for (const p of samplePages(doc.numPages)) {
    if (isCancelled()) return null
    let box: CropRect | null = null
    try {
      const page = await doc.getPage(p)
      const vp = page.getViewport({ scale: DETECT_SCALE, rotation: page.rotate + rotationOf(p) })
      const w = Math.max(1, Math.floor(vp.width))
      const h = Math.max(1, Math.floor(vp.height))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, w, h)
      await page.render({ canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise
      box = contentBox(ctx.getImageData(0, 0, w, h).data, w, h)
    } catch {
      continue // one unrenderable page must not kill detection
    }
    if (!box) continue
    seen++
    best = best
      ? {
          l: Math.min(best.l, box.l),
          t: Math.min(best.t, box.t),
          r: Math.min(best.r, box.r),
          b: Math.min(best.b, box.b),
        }
      : box
  }
  if (!best || !seen) return null
  const clamp = (v: number): number => Math.max(0, Math.min(MAX_TRIM, v - PAD))
  const out = { l: clamp(best.l), t: clamp(best.t), r: clamp(best.r), b: clamp(best.b) }
  // a crop that trims nothing is not worth persisting
  if (out.l + out.t + out.r + out.b < 0.01) return null
  return out
}
