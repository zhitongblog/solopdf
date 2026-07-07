/**
 * OCR orchestration (Tauri only — engines live in Rust):
 *   1. render each page to an offscreen canvas via pdf.js
 *   2. ship JPEG bytes to the native engine (Vision / PP-OCR)
 *   3. results come back as normalized image-space lines (top-left origin)
 *   4a. searchable PDF: convert lines to PDF user-space points and let
 *       Rust inject the invisible text layer over the ORIGINAL file
 *   4b. Markdown: group lines into paragraphs by vertical gaps
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { t } from './i18n'

export interface OcrLine {
  t: string
  c: number
  x: number
  y: number
  w: number
  h: number
}

export interface OcrPageResult {
  /** 1-based page number */
  page: number
  lines: OcrLine[]
}

/** long-side render target: ~200dpi on A4, capped for huge pages */
const TARGET_LONG_SIDE = 2200

export interface OcrProgress {
  done: number
  total: number
}

export class OcrCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

async function renderPageToJpeg(
  doc: PDFDocumentProxy,
  pageNum: number,
): Promise<{ bytes: Uint8Array; widthPx: number; heightPx: number }> {
  const page = await doc.getPage(pageNum)
  const vp1 = page.getViewport({ scale: 1 })
  const scale = Math.min(TARGET_LONG_SIDE / Math.max(vp1.width, vp1.height), 4)
  const vp = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(vp.width)
  canvas.height = Math.floor(vp.height)
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport: vp } as never).promise
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.88))
  if (!blob) throw new Error('canvas encode failed')
  canvas.width = 0 // release backing store eagerly (iOS memory)
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    widthPx: Math.floor(vp.width),
    heightPx: Math.floor(vp.height),
  }
}

async function ocrBytes(bytes: Uint8Array, langs: string[]): Promise<OcrLine[]> {
  const { invoke } = await import('@tauri-apps/api/core')
  const json = await invoke<string>('ocr_image', bytes, {
    headers: { 'x-langs': langs.join(',') },
  })
  return JSON.parse(json) as OcrLine[]
}

/** OCR one encoded image (already-loaded bytes, e.g. an opened picture) */
export async function ocrImageBytes(bytes: Uint8Array, langs: string[]): Promise<OcrLine[]> {
  return await ocrBytes(bytes, langs)
}

/** Run OCR over the given pages of a document. */
export async function ocrDocument(
  doc: PDFDocumentProxy,
  pageNums: number[],
  langs: string[],
  onProgress?: (p: OcrProgress) => void,
  isCancelled?: () => boolean,
): Promise<Map<number, { lines: OcrLine[]; widthPx: number; heightPx: number }>> {
  const out = new Map<number, { lines: OcrLine[]; widthPx: number; heightPx: number }>()
  let done = 0
  for (const p of pageNums) {
    if (isCancelled?.()) throw new OcrCancelled()
    const { bytes, widthPx, heightPx } = await renderPageToJpeg(doc, p)
    if (isCancelled?.()) throw new OcrCancelled()
    const lines = await ocrBytes(bytes, langs)
    out.set(p, { lines, widthPx, heightPx })
    onProgress?.({ done: ++done, total: pageNums.length })
  }
  return out
}

/** image-space normalized line box → PDF user-space {x, y(bottom), w, h} */
export async function toPdfSpace(
  doc: PDFDocumentProxy,
  results: Map<number, { lines: OcrLine[]; widthPx: number; heightPx: number }>,
): Promise<{ page: number; lines: { text: string; x: number; y: number; w: number; h: number }[] }[]> {
  const pages: { page: number; lines: { text: string; x: number; y: number; w: number; h: number }[] }[] = []
  for (const [pageNum, r] of results) {
    const page = await doc.getPage(pageNum)
    const vp = page.getViewport({ scale: 1 })
    // viewport pixel scale used at render time
    const sx = r.widthPx / vp.width
    const sy = r.heightPx / vp.height
    const lines = r.lines
      .filter((l) => l.t.trim().length > 0)
      .map((l) => {
        // normalized → viewport px (top-left origin) → PDF user space via
        // convertToPdfPoint (handles /Rotate and MediaBox offsets)
        const vx1 = (l.x * r.widthPx) / sx
        const vy1 = (l.y * r.heightPx) / sy
        const vx2 = ((l.x + l.w) * r.widthPx) / sx
        const vy2 = ((l.y + l.h) * r.heightPx) / sy
        const [ax, ay] = vp.convertToPdfPoint(vx1, vy1)
        const [bx, by] = vp.convertToPdfPoint(vx2, vy2)
        return {
          text: l.t,
          x: Math.min(ax, bx),
          y: Math.min(ay, by),
          w: Math.abs(bx - ax),
          h: Math.abs(by - ay),
        }
      })
    pages.push({ page: pageNum - 1, lines })
  }
  return pages
}

/** toPdfSpace + Rust text-layer injection in one call.
 *  destPath null → app Documents dir (iOS). Returns the written path. */
export async function makeSearchable(
  doc: PDFDocumentProxy,
  srcPath: string,
  destPath: string | null,
  results: Map<number, { lines: OcrLine[]; widthPx: number; heightPx: number }>,
): Promise<string> {
  const pages = await toPdfSpace(doc, results)
  const { invoke } = await import('@tauri-apps/api/core')
  return await invoke<string>('ocr_make_searchable', { srcPath, destPath, pages })
}

/** Group OCR lines into paragraphs; returns Markdown for the whole run. */
export function ocrToMarkdown(
  results: Map<number, { lines: OcrLine[] }>,
  docName: string,
): string {
  const parts: string[] = [`# ${docName.replace(/\.(pdf|png|jpe?g)$/i, '')}`, '']
  parts.push(`> ${t('ocr.mdBanner')}`)
  parts.push('')
  const pageNums = [...results.keys()].sort((a, b) => a - b)
  for (const p of pageNums) {
    const lines = [...results.get(p)!.lines]
      .filter((l) => l.t.trim())
      .sort((a, b) => a.y - b.y || a.x - b.x)
    parts.push(`<!-- p.${p} -->`)
    if (!lines.length) {
      parts.push('')
      continue
    }
    const heights = lines.map((l) => l.h).sort((a, b) => a - b)
    const medianH = heights[Math.floor(heights.length / 2)]
    let para: string[] = []
    let lastBottom = -1
    const flush = () => {
      if (para.length) {
        parts.push(para.join(''))
        parts.push('')
        para = []
      }
    }
    for (const l of lines) {
      if (lastBottom >= 0 && l.y - lastBottom > medianH * 0.8) flush()
      // CJK lines join without spaces; latin lines need one
      const sep = para.length && /[a-zA-Z0-9)]$/.test(para[para.length - 1]) ? ' ' : ''
      para.push(sep + l.t.trim())
      lastBottom = l.y + l.h
    }
    flush()
  }
  return parts.join('\n')
}

/** plain text (for the image→text panel) */
export function ocrToPlainText(lines: OcrLine[]): string {
  return [...lines]
    .filter((l) => l.t.trim())
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((l) => l.t.trim())
    .join('\n')
}

/** language hints per UI locale + user override */
export function langsFor(mode: 'auto' | 'zh-en' | 'ja', uiLocale: string): string[] {
  if (mode === 'ja') return ['ja', 'en-US']
  if (mode === 'zh-en') return ['zh-Hans', 'zh-Hant', 'en-US']
  // auto: bias to the UI language first
  if (uiLocale.startsWith('ja')) return ['ja', 'en-US']
  if (uiLocale.startsWith('zh')) return ['zh-Hans', 'zh-Hant', 'en-US', 'ja']
  return ['en-US', 'zh-Hans', 'ja']
}
