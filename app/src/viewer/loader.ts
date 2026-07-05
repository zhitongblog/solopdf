/**
 * Document opening: range transport + password flow + worker setup.
 */
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker'
import { platform } from '../platform'
import { PlatformRangeTransport, INITIAL_READ } from './transport'

// bundle the worker with vite instead of fetching from CDN (offline-first).
// Constructed LAZILY: eager module-scope `new Worker()` crashes the whole
// import chain on iOS WKWebView (custom-protocol module workers) → blank app.
let workerStarted = false
function ensureWorker(): void {
  if (workerStarted) return
  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()
  workerStarted = true
}

export interface OpenResult {
  doc: PDFDocumentProxy
  size: number
}

export class NeedPasswordError extends Error {
  constructor(public retry: boolean) {
    super(retry ? '密码错误，请重试' : '该 PDF 受密码保护')
  }
}

/**
 * Open a PDF via chunked transport.
 * `askPassword` is called (possibly repeatedly) for encrypted files;
 * returning null cancels opening.
 */
export async function openDocument(
  path: string,
  askPassword: (retry: boolean) => Promise<string | null>,
): Promise<OpenResult> {
  ensureWorker()
  const meta = await platform().fileMeta(path)
  const head = await platform().readChunk(path, 0, Math.min(INITIAL_READ, meta.size))
  const transport = new PlatformRangeTransport(path, meta.size, head)

  const task = pdfjs.getDocument({
    range: transport,
    // enable pdf.js internal chunked loading heuristics
    rangeChunkSize: 1 << 16,
    disableAutoFetch: false,
    // CJK: pdf.js needs cmaps for many Chinese PDFs
    cMapUrl: cmapsUrl(),
    cMapPacked: true,
    standardFontDataUrl: fontsUrl(),
    // JPEG2000 (JPX) images — archive.org scans use them — decode via
    // OpenJPEG WASM; without wasmUrl those images silently fail to paint
    wasmUrl: '/pdfjs/wasm/',
  })

  task.onPassword = (updatePassword: (pw: string) => void, reason: number) => {
    const retry = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD
    askPassword(retry).then((pw) => {
      if (pw === null) {
        task.destroy()
      } else {
        updatePassword(pw)
      }
    })
  }

  const doc = await task.promise
  return { doc, size: meta.size }
}

// cmaps/standard_fonts are copied into public/pdfjs/ by scripts/copy-pdfjs-assets.mjs
// (runs on predev/prebuild). CJK PDFs fail to render glyphs without cmaps.
function cmapsUrl(): string {
  return '/pdfjs/cmaps/'
}

function fontsUrl(): string {
  return '/pdfjs/standard_fonts/'
}
