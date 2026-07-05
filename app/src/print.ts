/**
 * Print: render pages to images into a hidden iframe, then system dialog.
 * wry's native print is inconsistent across WKWebView/WebView2/webkit2gtk,
 * so we normalize by printing an image sequence.
 * Memory: batches of 10 pages at capped DPI; canvases released after each
 * page is serialized to a data URL (500-page docs must not OOM — perf T6).
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

const BATCH = 10
const PRINT_DPI = 200 // ≈2.08x of 96dpi

export async function printDocument(doc: PDFDocumentProxy): Promise<void> {
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
        const img = fdoc.createElement('img')
        img.src = canvas.toDataURL('image/jpeg', 0.92)
        fdoc.body.appendChild(img)
        canvas.width = 0 // release backing store immediately
        canvas.height = 0
      }
      await new Promise((r) => setTimeout(r, 0)) // yield between batches
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
    frame.contentWindow!.print()
  } finally {
    // give the print dialog time to snapshot the frame before removal
    setTimeout(() => frame.remove(), 60_000)
  }
}
