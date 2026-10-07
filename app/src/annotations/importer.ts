/**
 * Annotations made in other apps — the app side of core/import.ts.
 *
 *   open ─▶ scanForImport(doc) ─▶ mgr.pdfAnnots ─▶ banner / sidebar count
 *                                      │
 *               "Import" ─▶ mgr.importFromPdf() ─▶ ONE sidecar write (one undo)
 *                                      │
 *   controller.setAnnotations() ─▶ importedRefs() ─▶ renderHiding(): pdf.js
 *                                  skips those originals on the canvas
 *
 * Why hiding is needed at all: pdf.js paints every annotation's appearance
 * stream into the page canvas. Once a highlight lives in the sidecar we draw
 * it ourselves (recolourable, editable, deletable) — leaving the original on
 * the canvas would show it twice, and a deleted mark would still be there.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { scanPdfAnnotations, needsLineFix, fixLineDirections, type PdfAnnot } from '@solopdf/core'

/** Every importable annotation in the PDF, /L directions restored. */
export async function scanForImport(doc: PDFDocumentProxy): Promise<PdfAnnot[]> {
  const pdf = await scanPdfAnnotations(doc)
  // pdf.js normalizes Line /L; the raw bytes are only fetched (whole file)
  // when a diagonal or arrowed line actually needs its direction back
  if (needsLineFix(pdf)) {
    const bytes = await doc.getData().catch(() => null)
    if (bytes) fixLineDirections(pdf, bytes)
  }
  return pdf
}

interface ModifiedIds { ids: Set<string>; hash: string }
const patched = new WeakSet<object>()
/** ids to hide for the render() call currently being issued, null otherwise */
let hiding: ModifiedIds | null = null

/**
 * Run `render` (a synchronous call to page.render()) with the given PDF
 * annotation ids left off the canvas.
 *
 * Mechanism — pdf.js's own "this annotation is being edited" path:
 * page.render() synchronously asks the document's AnnotationStorage for
 * `modifiedIds` and ships them to the worker, which skips every annotation
 * in that set when it builds the operator list (Annotation
 * .mustBeViewedWhenEditing). pdf.js uses it so an annotation taken over by
 * its editor isn't drawn twice — exactly our situation. The ids are part of
 * the op-list cache key (via `hash`), so hidden and unhidden renders of one
 * page never share a cached list.
 *
 * Alternatives rejected:
 *   - AnnotationMode.DISABLE: also drops form widgets' and stamps' looks,
 *     i.e. everything we don't import.
 *   - ENABLE_STORAGE + `{ noView: true }` storage entries: switches form
 *     rendering from live widgets back to the canvas, and those entries
 *     would leak into "save filled form" output.
 *
 * The override is scoped: `hiding` is only set for the duration of the
 * synchronous render() call, so thumbnails, print and presentation (which
 * don't draw our marks) still show the PDF's own annotations.
 */
export function renderHiding<T>(doc: PDFDocumentProxy, ids: Iterable<string>, render: () => T): T {
  const set = new Set(ids)
  if (!set.size) return render()
  const storage = doc.annotationStorage as unknown as object
  if (!patched.has(storage)) {
    patched.add(storage)
    // the getter lives on the prototype; an own property shadows it per doc
    let proto = Object.getPrototypeOf(storage)
    let desc: PropertyDescriptor | undefined
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'modifiedIds'))) proto = Object.getPrototypeOf(proto)
    const base = desc?.get
    Object.defineProperty(storage, 'modifiedIds', {
      configurable: true,
      get(): ModifiedIds {
        const own: ModifiedIds = base ? base.call(this) : { ids: new Set(), hash: '' }
        if (!hiding) return own
        const ids = new Set([...own.ids, ...hiding.ids])
        return { ids, hash: `${own.hash}|solopdf:${hiding.hash}` }
      },
    })
  }
  hiding = { ids: set, hash: [...set].sort().join(',') }
  try {
    return render()
  } finally {
    hiding = null
  }
}
