/**
 * PdfViewerController — owns the scroll container DOM for one document.
 *
 *   container (.pv-scroll, overflow:auto)
 *     └── .pv-canvas-area (width = page width * scale)
 *           ├── .pv-page[data-page=1]  (absolute, top computed)
 *           │     ├── canvas           (rendered when visible ±BUFFER)
 *           │     ├── .pv-textlayer    (pdf.js TextLayer, selectable)
 *           │     └── .pv-hl-layer     (annotation highlight rects)
 *           ├── .pv-page[data-page=2] ...
 *
 * Virtual scrolling: page heights measured from page 1's viewport (per-page
 * viewports fetched lazily; heights corrected as real pages load). Only
 * pages within viewport ± RENDER_BUFFER hold live canvases; others are
 * placeholders — this is what keeps a 1048-page scan from eating all RAM.
 *
 * Kept deliberately outside Vue reactivity: the scroll hot path repaints at
 * 60fps and must not churn proxies.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { TextLayer, OPS, AnnotationLayer, AnnotationMode } from 'pdfjs-dist'
import { SimpleLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { buildPageIndex, matchOnPage, type PageTextIndex } from '@solopdf/core'
import type { Annotation, Quad } from '@solopdf/core'

const RENDER_BUFFER = 2 // pages beyond viewport kept live
const MAX_DPR = 2 // cap canvas backing resolution (perf review T6)
const PAGE_GAP = 12

export type DarkPdfMode = 'off' | 'smart'

export interface SelectionInfo {
  page: number
  quads: Quad[]
  text: string
  pre: string
  post: string
  /** viewport rect of selection end, for popover placement */
  clientRect: DOMRect
}

interface PageSlot {
  el: HTMLDivElement
  canvas: HTMLCanvasElement | null
  textLayerDiv: HTMLDivElement | null
  hlLayer: HTMLDivElement | null
  page: PDFPageProxy | null
  rendered: boolean
  rendering: boolean
  renderTask: { cancel(): void } | null
  height: number
  top: number
  hasImages: boolean | null
  textIndex: PageTextIndex | null
  textItems: TextItemGeom[] | null
}

/** geometry of one text item on a page, PDF user space */
interface TextItemGeom {
  str: string
  x: number
  y: number
  w: number
  h: number
}

export class PdfViewerController {
  readonly numPages: number
  scale = 1
  fitMode: 'width' | 'page' | 'manual' = 'width'
  darkPdf: DarkPdfMode = 'off'
  private slots: PageSlot[] = []
  private area: HTMLDivElement
  private baseViewports: { width: number; height: number }[] = []
  private destroyed = false
  private scrollRaf = 0
  private zoomDebounce = 0
  private annotations: Annotation[] = []
  private resolvedQuads = new Map<string, { page: number; quads: Quad[]; orphan: boolean }>()
  private linkService = new SimpleLinkService()
  /** true once the user edits any form field (annotationStorage non-empty) */
  formsDirty = false
  onVisiblePage: (page: number) => void = () => {}
  onSelection: (sel: SelectionInfo | null) => void = () => {}
  onFormsDirty: () => void = () => {}

  constructor(
    public doc: PDFDocumentProxy,
    private scroll: HTMLElement,
    private theme: () => 'light' | 'dark',
  ) {
    this.numPages = doc.numPages
    this.area = document.createElement('div')
    this.area.className = 'pv-canvas-area'
    scroll.appendChild(this.area)
    scroll.addEventListener('scroll', this.onScroll)
    document.addEventListener('selectionchange', this.onSelChange)
  }

  async init(): Promise<void> {
    // measure page 1; assume uniform until pages prove otherwise (fixed lazily)
    const p1 = await this.doc.getPage(1)
    const vp1 = p1.getViewport({ scale: 1 })
    for (let i = 0; i < this.numPages; i++) {
      this.baseViewports.push({ width: vp1.width, height: vp1.height })
    }
    this.applyFit()
    this.buildSlots(p1)
    this.update()
  }

  private buildSlots(p1: PDFPageProxy): void {
    let top = 0
    for (let i = 0; i < this.numPages; i++) {
      const el = document.createElement('div')
      el.className = 'pv-page'
      el.dataset.page = String(i + 1)
      const height = this.baseViewports[i].height * this.scale
      el.style.height = `${height}px`
      el.style.top = `${top}px`
      this.area.appendChild(el)
      this.slots.push({
        el, canvas: null, textLayerDiv: null, hlLayer: null,
        page: i === 0 ? p1 : null,
        rendered: false, rendering: false, renderTask: null,
        height, top, hasImages: null, textIndex: null, textItems: null,
      })
      top += height + PAGE_GAP
    }
    this.area.style.height = `${top}px`
    this.area.style.width = `${this.baseViewports[0].width * this.scale}px`
  }

  /** relayout after scale change or corrected page sizes */
  private relayout(): void {
    let top = 0
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      s.height = this.baseViewports[i].height * this.scale
      s.top = top
      s.el.style.height = `${s.height}px`
      s.el.style.top = `${top}px`
      top += s.height + PAGE_GAP
    }
    this.area.style.height = `${top}px`
    this.area.style.width = `${this.baseViewports[0].width * this.scale}px`
  }

  applyFit(): void {
    const w = this.scroll.clientWidth - 32
    const h = this.scroll.clientHeight - 24
    const vp = this.baseViewports[0] ?? { width: 612, height: 792 }
    if (this.fitMode === 'width') this.scale = w / vp.width
    else if (this.fitMode === 'page') this.scale = Math.min(w / vp.width, h / vp.height)
    this.scale = Math.min(Math.max(this.scale, 0.25), 5)
  }

  setZoom(scale: number | 'width' | 'page'): void {
    const anchor = this.currentPage()
    if (typeof scale === 'number') {
      this.fitMode = 'manual'
      this.scale = Math.min(Math.max(scale, 0.25), 5)
    } else {
      this.fitMode = scale
      this.applyFit()
    }
    // CSS-scale live canvases immediately; re-render after settle (perf T6)
    this.relayout()
    this.invalidateRendered()
    this.scrollToPage(anchor)
    clearTimeout(this.zoomDebounce)
    this.zoomDebounce = window.setTimeout(() => this.update(), 180)
  }

  setDarkPdf(mode: DarkPdfMode): void {
    this.darkPdf = mode
    this.invalidateRendered()
    this.update()
  }

  private invalidateRendered(): void {
    for (const s of this.slots) {
      if (s.renderTask) { s.renderTask.cancel(); s.renderTask = null }
      s.rendered = false
      s.rendering = false
      // keep the old canvas visible (CSS-scaled) until replaced
      if (s.canvas) {
        s.canvas.style.width = `${this.baseViewports[0].width * this.scale}px`
        s.canvas.style.height = `${s.height}px`
      }
    }
  }

  currentPage(): number {
    const mid = this.scroll.scrollTop + this.scroll.clientHeight / 3
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      if (mid >= s.top && mid < s.top + s.height + PAGE_GAP) return i + 1
    }
    return 1
  }

  scrollToPage(page: number, offsetRatio = 0): void {
    const s = this.slots[page - 1]
    if (!s) return
    this.scroll.scrollTop = s.top + s.height * offsetRatio
  }

  /** scroll so the given PDF-space quad on `page` is visible; returns viewport y */
  scrollToQuad(page: number, quad: Quad): void {
    const s = this.slots[page - 1]
    if (!s) return
    const vp = this.baseViewports[page - 1]
    // PDF y-up -> screen y-down
    const yTopPdf = Math.max(quad.y1, quad.y2)
    const yScreen = (vp.height - yTopPdf) * this.scale
    this.scroll.scrollTop = s.top + yScreen - this.scroll.clientHeight / 3
  }

  private onScroll = (): void => {
    if (this.scrollRaf) return
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0
      this.update()
      this.onVisiblePage(this.currentPage())
    })
  }

  /** progress ratio for position persistence */
  getPosition(): { page: number; ratio: number } {
    const page = this.currentPage()
    const s = this.slots[page - 1]
    const ratio = s ? Math.max(0, (this.scroll.scrollTop - s.top) / Math.max(1, s.height)) : 0
    return { page, ratio }
  }

  restorePosition(pos: { page: number; ratio: number }): void {
    this.scrollToPage(pos.page, pos.ratio)
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private visibleRange(): [number, number] {
    const topEdge = this.scroll.scrollTop
    const botEdge = topEdge + this.scroll.clientHeight
    let first = 0
    while (first < this.slots.length - 1 && this.slots[first].top + this.slots[first].height < topEdge) first++
    let last = first
    while (last < this.slots.length - 1 && this.slots[last].top < botEdge) last++
    return [Math.max(0, first - RENDER_BUFFER), Math.min(this.slots.length - 1, last + RENDER_BUFFER)]
  }

  update(): void {
    if (this.destroyed) return
    const [lo, hi] = this.visibleRange()
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      if (i >= lo && i <= hi) {
        if (!s.rendered && !s.rendering) void this.renderPage(i)
      } else if (s.rendered || s.rendering) {
        this.releasePage(s)
      }
    }
  }

  private async renderPage(i: number): Promise<void> {
    const s = this.slots[i]
    s.rendering = true
    try {
      if (!s.page) s.page = await this.doc.getPage(i + 1)
      const real = s.page.getViewport({ scale: 1 })
      // correct height assumption if this page differs (mixed-size docs)
      if (Math.abs(real.height - this.baseViewports[i].height) > 1 ||
          Math.abs(real.width - this.baseViewports[i].width) > 1) {
        this.baseViewports[i] = { width: real.width, height: real.height }
        this.relayout()
      }
      if (this.destroyed) return
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const vp = s.page.getViewport({ scale: this.scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(vp.width * dpr)
      canvas.height = Math.floor(vp.height * dpr)
      canvas.style.width = `${vp.width}px`
      canvas.style.height = `${vp.height}px`
      const ctx = canvas.getContext('2d', { alpha: false })!
      const task = s.page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        // forms render as live DOM widgets (AnnotationLayer below), not
        // baked pixels — this is what makes填写/打勾 interactive
        annotationMode: AnnotationMode.ENABLE_FORMS,
      } as Parameters<PDFPageProxy['render']>[0])
      s.renderTask = task
      await task.promise
      s.renderTask = null
      if (this.destroyed) return

      // dark mode: smart inversion — text pages invert, image pages stay
      // (design-doc degradation rule; full mask-out is post-v1)
      if (this.theme() === 'dark' && this.darkPdf === 'smart') {
        if (s.hasImages === null) s.hasImages = await this.pageHasImages(s.page)
        canvas.classList.toggle('pv-inverted', !s.hasImages)
      }

      // swap in
      s.el.textContent = ''
      s.el.appendChild(canvas)
      s.canvas = canvas

      // text layer (selectable) — skip when the page has no text
      const textContent = await s.page.getTextContent()
      const strings: string[] = []
      const items: TextItemGeom[] = []
      for (const it of textContent.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
        if (!('str' in it)) continue
        strings.push(it.str)
        items.push({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
          h: it.height,
        })
      }
      s.textItems = items
      s.textIndex = buildPageIndex(strings)
      const hasText = strings.join('').trim().length > 0
      s.el.dataset.hasText = hasText ? '1' : '0'
      if (hasText) {
        const tl = document.createElement('div')
        tl.className = 'pv-textlayer'
        // pdf.js TextLayer sizes itself via --scale-factor
        tl.style.setProperty('--scale-factor', String(this.scale))
        s.el.appendChild(tl)
        const layer = new TextLayer({
          textContentSource: textContent,
          container: tl,
          viewport: vp,
        })
        await layer.render()
        s.textLayerDiv = tl
      }

      // interactive form widgets (text inputs / checkboxes / dropdowns)
      await this.renderFormLayer(s, vp)

      // highlight layer
      const hl = document.createElement('div')
      hl.className = 'pv-hl-layer'
      s.el.appendChild(hl)
      s.hlLayer = hl
      this.paintHighlights(i + 1)

      s.rendered = true
    } catch (err) {
      if ((err as Error)?.name !== 'RenderingCancelledException') {
        console.error(`page ${i + 1} render failed`, err)
      }
    } finally {
      s.rendering = false
    }
  }

  /** pdf.js AnnotationLayer with renderForms — fillable AcroForm widgets.
   *  Values live in doc.annotationStorage; saveDocument() bakes them out. */
  private async renderFormLayer(s: PageSlot, vp: ReturnType<PDFPageProxy['getViewport']>): Promise<void> {
    try {
      const annots = await s.page!.getAnnotations({ intent: 'display' })
      if (!annots.some((a: { subtype?: string }) => a.subtype === 'Widget')) return
      const div = document.createElement('div')
      div.className = 'annotationLayer'
      div.style.setProperty('--scale-factor', String(this.scale))
      s.el.appendChild(div)
      const layer = new AnnotationLayer({
        div,
        page: s.page!,
        viewport: vp.clone({ dontFlip: true }),
        // pdf.js 5.x reads annotationStorage from the CONSTRUCTOR, not from
        // render() — passing it only to render() silently writes all form
        // values into an orphan storage and saveDocument() exports nothing
        annotationStorage: this.doc.annotationStorage,
        accessibilityManager: null,
        annotationCanvasMap: null,
        annotationEditorUIManager: null,
        structTreeLayer: null,
      } as unknown as ConstructorParameters<typeof AnnotationLayer>[0])
      await layer.render({
        annotations: annots,
        imageResourcesPath: '',
        renderForms: true,
        linkService: this.linkService,
        annotationStorage: this.doc.annotationStorage,
        enableScripting: false,
        hasJSActions: false,
      } as unknown as Parameters<AnnotationLayer['render']>[0])
      // any input inside the layer marks the doc dirty (save button appears)
      div.addEventListener('input', this.markFormsDirty)
      div.addEventListener('change', this.markFormsDirty)
    } catch (err) {
      console.warn('form layer failed (page still readable)', err)
    }
  }

  private markFormsDirty = (): void => {
    if (!this.formsDirty) {
      this.formsDirty = true
      this.onFormsDirty()
    }
  }

  /** serialize the document WITH filled form values */
  async saveFilled(): Promise<Uint8Array> {
    return await this.doc.saveDocument()
  }

  private releasePage(s: PageSlot): void {
    if (s.renderTask) { s.renderTask.cancel(); s.renderTask = null }
    s.el.textContent = ''
    s.canvas = null
    s.textLayerDiv = null
    s.hlLayer = null
    s.rendered = false
    s.rendering = false
    // keep textIndex — cheap, and search/anchor need it
  }

  /** operator-list scan: does the page paint image XObjects? */
  private async pageHasImages(page: PDFPageProxy): Promise<boolean> {
    try {
      const ops = await page.getOperatorList()
      return ops.fnArray.some(
        (fn: number) => fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject,
      )
    } catch {
      return true // fail safe: don't invert
    }
  }

  // ── text access (search + anchors) ──────────────────────────────────────

  async getPageIndex(pageNum: number): Promise<PageTextIndex> {
    const s = this.slots[pageNum - 1]
    if (s.textIndex) return s.textIndex
    if (!s.page) s.page = await this.doc.getPage(pageNum)
    const tc = await s.page.getTextContent()
    const strings: string[] = []
    const items: TextItemGeom[] = []
    for (const it of tc.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
      if (!('str' in it)) continue
      strings.push(it.str)
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height })
    }
    s.textItems = items
    s.textIndex = buildPageIndex(strings)
    return s.textIndex
  }

  /** rough quads for a char range on a page (item-level granularity) */
  quadsForCharRange(pageNum: number, itemRange: [number, number]): Quad[] {
    const s = this.slots[pageNum - 1]
    if (!s.textItems) return []
    const quads: Quad[] = []
    for (let i = itemRange[0]; i <= itemRange[1] && i < s.textItems.length; i++) {
      const t = s.textItems[i]
      if (!t.str.trim()) continue
      quads.push({ x1: t.x, y1: t.y, x2: t.x + t.w, y2: t.y + t.h })
    }
    return quads
  }

  // ── selection capture ────────────────────────────────────────────────────

  private onSelChange = (): void => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      this.onSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    const startPageEl = closestPage(range.startContainer)
    const endPageEl = closestPage(range.endContainer)
    if (!startPageEl || !endPageEl) {
      this.onSelection(null)
      return
    }
    // v1: single-page selections (multi-page = take start page's part)
    const pageNum = parseInt(startPageEl.dataset.page!, 10)
    const s = this.slots[pageNum - 1]
    if (!s || !s.textLayerDiv) {
      this.onSelection(null)
      return
    }
    const text = sel.toString()
    if (!text.trim()) {
      this.onSelection(null)
      return
    }
    // client rects -> PDF user space quads (filter zero-width slivers)
    const pageRect = startPageEl.getBoundingClientRect()
    const vp = this.baseViewports[pageNum - 1]
    const quads: Quad[] = []
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue // phantom slivers (zero-width rects)
      if (r.top < pageRect.top - 2 || r.bottom > pageRect.bottom + 2) continue // other page
      const x1 = (r.left - pageRect.left) / this.scale
      const x2 = (r.right - pageRect.left) / this.scale
      // screen y-down -> PDF y-up
      const y2 = vp.height - (r.top - pageRect.top) / this.scale
      const y1 = vp.height - (r.bottom - pageRect.top) / this.scale
      quads.push(rnd({ x1, y1, x2, y2 }))
    }
    if (!quads.length) {
      this.onSelection(null)
      return
    }
    // fingerprint context from the page index
    const idx = s.textIndex
    let pre = ''
    let post = ''
    if (idx) {
      const norm = text.replace(/\s+/g, '')
      const at = idx.text.indexOf(norm)
      if (at >= 0) {
        pre = idx.text.slice(Math.max(0, at - 32), at)
        post = idx.text.slice(at + norm.length, at + norm.length + 32)
      }
    }
    const rects = range.getClientRects()
    this.onSelection({
      page: pageNum,
      quads,
      text,
      pre,
      post,
      clientRect: rects[rects.length - 1],
    })
  }

  clearSelection(): void {
    window.getSelection()?.removeAllRanges()
    this.onSelection(null)
  }

  // ── highlights ───────────────────────────────────────────────────────────

  async setAnnotations(annots: Annotation[]): Promise<void> {
    this.annotations = annots
    this.resolvedQuads.clear()
    for (const a of annots) {
      if (a.orphan) {
        this.resolvedQuads.set(a.id, { page: a.anchor.page, quads: [], orphan: true })
        continue
      }
      const resolved = await this.resolveAnchor(a)
      this.resolvedQuads.set(a.id, resolved)
    }
    for (let p = 1; p <= this.numPages; p++) this.paintHighlights(p)
  }

  /** triple anchoring: fingerprint on stored page > quads > full-doc search */
  private async resolveAnchor(a: Annotation): Promise<{ page: number; quads: Quad[]; orphan: boolean }> {
    const tryPage = async (pageNum: number) => {
      if (pageNum < 1 || pageNum > this.numPages) return null
      const idx = await this.getPageIndex(pageNum)
      const m = matchOnPage(a.anchor, idx)
      if (m.kind === 'exact') {
        // if stored quads still make sense relative to matched items use them,
        // else derive fresh quads from matched item range
        const fresh = this.quadsForCharRange(pageNum, m.itemRange)
        return { page: pageNum, quads: a.anchor.quads.length && pageNum === a.anchor.page ? a.anchor.quads : fresh, orphan: false }
      }
      if (m.kind === 'quads-only') return { page: pageNum, quads: a.anchor.quads, orphan: false }
      return null
    }
    const onStored = await tryPage(a.anchor.page)
    if (onStored) return onStored
    // neighbours first (page drift ±3 is the common case), then give up ->
    // full-doc search is offered lazily via UI, not eagerly (100MB docs)
    for (const d of [-1, 1, -2, 2, -3, 3]) {
      const hit = await tryPage(a.anchor.page + d)
      if (hit) return hit
    }
    return { page: a.anchor.page, quads: [], orphan: true }
  }

  resolvedFor(id: string) {
    return this.resolvedQuads.get(id)
  }

  private paintHighlights(pageNum: number): void {
    const s = this.slots[pageNum - 1]
    if (!s?.hlLayer) return
    s.hlLayer.textContent = ''
    const vp = this.baseViewports[pageNum - 1]
    for (const a of this.annotations) {
      const r = this.resolvedQuads.get(a.id)
      if (!r || r.orphan || r.page !== pageNum) continue
      for (const q of r.quads) {
        const div = document.createElement('div')
        div.className = `pv-hl pv-hl-${a.color}`
        div.dataset.annot = a.id
        const left = Math.min(q.x1, q.x2) * this.scale
        const width = Math.abs(q.x2 - q.x1) * this.scale
        const topPdf = Math.max(q.y1, q.y2)
        const top = (vp.height - topPdf) * this.scale
        const height = Math.abs(q.y2 - q.y1) * this.scale
        div.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`
        s.hlLayer.appendChild(div)
      }
    }
  }

  flashAnnotation(id: string): void {
    const r = this.resolvedQuads.get(id)
    if (!r || !r.quads.length) return
    this.scrollToQuad(r.page, r.quads[0])
    // flash after the page renders
    setTimeout(() => {
      const s = this.slots[r.page - 1]
      s?.hlLayer?.querySelectorAll(`[data-annot="${id}"]`).forEach((el) => {
        el.classList.add('pv-hl-flash')
        setTimeout(() => el.classList.remove('pv-hl-flash'), 1600)
      })
    }, 300)
  }

  destroy(): void {
    this.destroyed = true
    this.scroll.removeEventListener('scroll', this.onScroll)
    document.removeEventListener('selectionchange', this.onSelChange)
    for (const s of this.slots) this.releasePage(s)
    this.area.remove()
    void this.doc.destroy()
  }
}

function closestPage(node: Node): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node.parentElement
  return el?.closest('.pv-page') ?? null
}

function rnd(q: Quad): Quad {
  return { x1: r2(q.x1), y1: r2(q.y1), x2: r2(q.x2), y2: r2(q.y2) }
}
function r2(n: number): number {
  return Math.round(n * 100) / 100
}
