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

type OcConfig = Awaited<ReturnType<PDFDocumentProxy['getOptionalContentConfig']>>

/** render all pages to JPEG data URLs in batches; `oc` = the reader's
 *  current layer visibility (prints what is on screen, not the defaults) */
async function renderPagesToImages(doc: PDFDocumentProxy, oc?: OcConfig | null): Promise<string[]> {
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
        ...(oc ? { optionalContentConfigPromise: Promise.resolve(oc) } : {}),
      } as any).promise
      urls.push(canvas.toDataURL('image/jpeg', 0.92))
      canvas.width = 0 // release backing store immediately
      canvas.height = 0
    }
    await new Promise((r) => setTimeout(r, 0)) // yield between batches
  }
  return urls
}

export interface PrintNativeHints {
  path?: string
  name?: string
  formsDirty?: boolean
  encrypted?: boolean
}

/** Tauri path: prefer native PDFKit/UIKit vector printing when possible;
 *  fall back to DOM overlay + webview print (Windows/Linux, encrypted PDFs,
 *  or documents with custom layer overrides). */
async function printViaTauri(
  doc: PDFDocumentProxy,
  oc?: OcConfig | null,
  hints?: PrintNativeHints,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  // Native PDFKit / AirPrint: crisp vector output, zero HTML pagination drift.
  // Skip when encrypted (PDFDocument would be locked without password) or when
  // optional-content layers exist (user may have toggled layers in the UI).
  if (!hints?.encrypted && !oc) {
    try {
      const payload = hints?.formsDirty
        ? { bytes: Array.from(await doc.saveDocument()), jobName: hints.name }
        : hints?.path
          ? { path: hints.path, jobName: hints.name }
          : null
      if (payload) {
        const handled = await invoke<boolean>('print_pdf', payload)
        if (handled) return
      }
    } catch {
      // fall through to webview overlay path
    }
  }
  await printViaOverlay(doc, oc)
}

/** Webview overlay path: keep .print-mode alive until the print dialog closes
 *  (wry's print() is non-blocking on macOS, so immediate finally cleanup would
 *  rip out the overlay before the print preview finishes rendering). */
async function printViaOverlay(doc: PDFDocumentProxy, oc?: OcConfig | null): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  const urls = await renderPagesToImages(doc, oc)
  const overlay = document.createElement('div')
  overlay.className = 'print-overlay'
  for (const u of urls) {
    const img = document.createElement('img')
    img.src = u
    overlay.appendChild(img)
  }
  document.body.appendChild(overlay)
  document.documentElement.classList.add('print-mode')

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    window.removeEventListener('afterprint', cleanup)
    document.documentElement.classList.remove('print-mode')
    overlay.remove()
  }

  try {
    await new Promise<void>((resolve) => {
      const imgs = [...overlay.querySelectorAll('img')]
      let pending = imgs.filter((i) => !i.complete).length
      if (!pending) return resolve()
      for (const i of imgs) {
        if (!i.complete) i.onload = i.onerror = () => { if (--pending === 0) resolve() }
      }
    })
    window.addEventListener('afterprint', cleanup, { once: true })
    await invoke('print_webview')
    // Fallback if the platform webview never fires `afterprint`
    setTimeout(cleanup, 60_000)
  } catch (err) {
    cleanup()
    throw err
  }
}

export async function printDocument(
  doc: PDFDocumentProxy,
  /** test seam: E2E stubs the system dialog call */
  trigger?: (w: Window) => void,
  /** optional-content config carrying the reader's layer choices */
  oc?: OcConfig | null,
  hints?: PrintNativeHints,
): Promise<void> {
  if (isTauri() && !trigger) {
    return printViaTauri(doc, oc, hints)
  }
  const doTrigger = trigger ?? ((w: Window) => w.print())
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  try {
    const fdoc = frame.contentDocument!
    fdoc.open()
    fdoc.write('<!doctype html><html><head><style>' +
      '@page{margin:0}html,body{margin:0;padding:0;background:#fff}' +
      'img{display:block;max-width:100%;max-height:99.5vh;width:auto;height:auto;margin:0 auto;page-break-inside:avoid;break-inside:avoid}' +
      'img:not(:last-child){page-break-after:always;break-after:page}' +
      '</style></head><body></body></html>')
    fdoc.close()

    for (const u of await renderPagesToImages(doc, oc)) {
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
