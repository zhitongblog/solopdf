/**
 * Print: render pages to an image sequence, then the system dialog.
 *
 * Two triggers, one renderer:
 *  - browser/dev: hidden iframe + contentWindow.print()
 *  - Tauri/macOS: WKWebView ignores JS print() entirely (silent no-op — the
 *    "打印没有反应" bug), so we inject a fullscreen print overlay into the
 *    MAIN document, hide the app chrome via a .print-mode class, and call
 *    the Rust `print_webview` command (native WKWebView printOperation).
 *
 * Memory: batches of 10 pages at capped DPI; canvases released after each
 * page is serialized to a data URL (500-page docs must not OOM — perf T6).
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { isTauri } from './platform'

const BATCH = 10
const PRINT_DPI = 200 // ≈2.08x of 96dpi

/** render all pages to JPEG data URLs in batches */
async function renderPagesToImages(doc: PDFDocumentProxy): Promise<string[]> {
  const urls: string[] = []
  const scale = PRINT_DPI / 96
  for (let start = 1; start <= doc.numPages; start += BATCH) {
    const end = Math.min(start + BATCH - 1, doc.numPages)
    for (let p = start; p <= end; p++) {
      const page = await doc.getPage(p)
      const vp = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(vp.width)
      canvas.height = Math.floor(vp.height)
      await page.render({
        canvasContext: canvas.getContext('2d', { alpha: false })!,
        viewport: vp,
      } as any).promise
      urls.push(canvas.toDataURL('image/jpeg', 0.92))
      canvas.width = 0 // release backing store immediately
      canvas.height = 0
    }
    await new Promise((r) => setTimeout(r, 0)) // yield between batches
  }
  return urls
}

/** Tauri path: overlay in the main document + native WKWebView print */
async function printViaOverlay(doc: PDFDocumentProxy): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  const urls = await renderPagesToImages(doc)
  const overlay = document.createElement('div')
  overlay.className = 'print-overlay'
  for (const u of urls) {
    const img = document.createElement('img')
    img.src = u
    overlay.appendChild(img)
  }
  document.body.appendChild(overlay)
  document.documentElement.classList.add('print-mode')
  try {
    await new Promise<void>((resolve) => {
      const imgs = [...overlay.querySelectorAll('img')]
      let pending = imgs.filter((i) => !i.complete).length
      if (!pending) return resolve()
      for (const i of imgs) {
        if (!i.complete) i.onload = i.onerror = () => { if (--pending === 0) resolve() }
      }
    })
    await invoke('print_webview')
  } finally {
    // native print dialog is modal on macOS — safe to clean up right after
    document.documentElement.classList.remove('print-mode')
    overlay.remove()
  }
}

export async function printDocument(
  doc: PDFDocumentProxy,
  /** test seam: E2E stubs the system dialog call */
  trigger?: (w: Window) => void,
): Promise<void> {
  if (isTauri() && !trigger) {
    return printViaOverlay(doc)
  }
  const doTrigger = trigger ?? ((w: Window) => w.print())
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  try {
    const fdoc = frame.contentDocument!
    fdoc.open()
    fdoc.write('<!doctype html><html><head><style>' +
      '@page{margin:0}body{margin:0}img{display:block;width:100%;page-break-after:always}' +
      '</style></head><body></body></html>')
    fdoc.close()

    for (const u of await renderPagesToImages(doc)) {
      const img = fdoc.createElement('img')
      img.src = u
      fdoc.body.appendChild(img)
    }

    await new Promise<void>((resolve) => {
      const imgs = [...fdoc.images]
      let pending = imgs.filter((i) => !i.complete).length
      if (!pending) return resolve()
      for (const i of imgs) {
        if (!i.complete) i.onload = i.onerror = () => { if (--pending === 0) resolve() }
      }
    })

    frame.contentWindow!.focus()
    doTrigger(frame.contentWindow!)
  } finally {
    // give the print dialog time to snapshot the frame before removal
    setTimeout(() => frame.remove(), 60_000)
  }
}
