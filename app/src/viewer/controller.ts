/**
 * PdfViewerController — owns the scroll container DOM for one document.
 *
 *   container (.pv-scroll, overflow:auto)
 *     └── .pv-canvas-area                     (row-laid-out page grid)
 *           ├── .pv-page[data-page=1]         (absolute; CLIP box = crop window)
 *           │     └── .pv-page-inner          (full rotated page, offset by −crop)
 *           │           ├── canvas            (rendered when visible ±BUFFER)
 *           │           ├── .pv-textlayer     (pdf.js TextLayer, selectable)
 *           │           ├── .annotationLayer  (AcroForm widgets)
 *           │           ├── .pv-link-layer    (hyperlinks: click / hover preview)
 *           │           └── .pv-hl-layer      (annotation marks)
 *           ├── .pv-page[data-page=2] ...
 *
 * Layout model: pages are grouped into ROWS (1 page, or 2 for facing spreads).
 * Rows stack vertically in `continuous` mode; in `paged` mode only the current
 * row (plus its hidden neighbours, kept rendered so flipping is instant) is in
 * the layout, so the scroll container holds exactly one screenful of document.
 *
 * Virtual scrolling: page heights are measured from page 1's box and corrected
 * as real pages load. Only pages within the visible row range hold live
 * canvases — this is what keeps a 1048-page scan from eating all RAM.
 *
 * Rotation and crop are display-only: stored annotation quads stay in true PDF
 * user space, and geometry.ts is the only place the two spaces meet.
 *
 * Kept deliberately outside Vue reactivity: the scroll hot path repaints at
 * 60fps and must not churn proxies.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { TextLayer, OPS, AnnotationLayer, AnnotationMode } from 'pdfjs-dist'
import { SimpleLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs'
import {
  buildPageIndex, matchOnPage, linkTargetOf, annotRect, resolveLinkTarget,
  type PageTextIndex, type RawLinkTarget, type LinkDest, type RefKind,
} from '@solopdf/core'
import { SmartRefIndex, refUnderPoint, type RefHit } from './refs'
import { splitSentences } from '../tts'
import type { Annotation, Quad } from '@solopdf/core'
import {
  NO_CROP, cropOffset, displaySize, normRotation, pdfRectToView, pdfToView, rotatedSize, viewToPdf,
  type CropRect, type PageBox,
} from './geometry'

const RENDER_BUFFER = 1 // rows beyond the viewport kept live
const MAX_DPR = 2 // cap canvas backing resolution (perf review T6)
const PAGE_GAP = 12 // between rows
const SPREAD_GAP = 8 // between the two pages of a facing spread

export type DarkPdfMode = 'off' | 'smart'
/** vertical scroll through the whole doc vs one row at a time */
export type ScrollMode = 'continuous' | 'paged'
/** 1 = single page, 2 = facing pages */
export type Spread = 1 | 2

export interface SelectionInfo {
  page: number
  quads: Quad[]
  text: string
  pre: string
  post: string
  /** viewport rect of selection end, for popover placement */
  clientRect: DOMRect
}

/**
 * What the hover/long-press preview should show. `region` is PDF user space
 * on `page`; external links carry only `url`.
 */
export interface PreviewRequest {
  kind: 'link' | 'url' | RefKind
  /** "p. 12", "Figure 3", or the URL */
  label: string
  page?: number
  region?: Quad
  dest?: LinkDest
  url?: string
  /** client rect of the thing hovered, for placement */
  anchor: DOMRect
  /** opened by long-press / tap: stays until dismissed */
  touch: boolean
}

/** a Link annotation as found on a page, target not yet resolved */
interface PageLink {
  rect: [number, number, number, number]
  raw: RawLinkTarget
}

/** hover delay before a preview appears (mouse) */
const HOVER_MS = 300
/** touch hold before a link preview appears instead of following it */
const LONG_PRESS_MS = 450

interface PageSlot {
  el: HTMLDivElement
  inner: HTMLDivElement
  canvas: HTMLCanvasElement | null
  textLayerDiv: HTMLDivElement | null
  hlLayer: HTMLDivElement | null
  page: PDFPageProxy | null
  rendered: boolean
  rendering: boolean
  renderTask: { cancel(): void } | null
  /** scale the live canvas was rendered at (for CSS re-scaling on zoom) */
  renderedScale: number
  /** rotation the live canvas was rendered at */
  renderedRotation: number
  hasImages: boolean | null
  textIndex: PageTextIndex | null
  textItems: TextItemGeom[] | null
  /** Link annotations, read once per page (null = not read yet) */
  links: PageLink[] | null
  /** placement, recomputed by relayout() */
  left: number
  top: number
}

interface Row {
  /** 0-based page indices, left to right */
  pages: number[]
  top: number
  height: number
  width: number
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
  scrollMode: ScrollMode = 'continuous'
  spread: Spread = 1
  /** first page stands alone in facing mode (book cover) */
  coverAlone = true
  /** whole-document user rotation, degrees */
  rotation = 0
  /** extra rotation for individual pages, keyed by 1-based page number */
  pageRotation = new Map<number, number>()
  crop: CropRect = NO_CROP

  private boxes: PageBox[] = []
  private slots: PageSlot[] = []
  private rows: Row[] = []
  private rowOfPage: number[] = []
  private currentRow = 0
  private area: HTMLDivElement
  private destroyed = false
  private scrollRaf = 0
  private zoomDebounce = 0
  private annotations: Annotation[] = []
  private resolvedQuads = new Map<string, { page: number; quads: Quad[]; orphan: boolean }>()
  private linkService = new SimpleLinkService()
  private autoRaf = 0
  private autoSpeed = 0
  private autoLast = 0
  private autoRemainder = 0
  /** true once the user edits any form field (annotationStorage non-empty) */
  formsDirty = false
  onVisiblePage: (page: number) => void = () => {}
  onSelection: (sel: SelectionInfo | null) => void = () => {}
  onFormsDirty: () => void = () => {}
  onAutoScrollEnd: () => void = () => {}
  /** a jump is about to happen: returns the commit that records history */
  onBeforeJump: () => () => void = () => () => {}
  /** follow an external link (system browser — never this webview) */
  onExternalLink: (url: string) => void = () => {}
  /** show a link / smart-reference preview; null = pointer left it */
  onPreview: (req: PreviewRequest | null) => void = () => {}

  private refIndex: SmartRefIndex | null = null
  private hoverTimer = 0
  private hoverKey = ''
  private hoverRaf = 0
  private pressTimer = 0
  private pressStart: { x: number; y: number } | null = null
  private suppressClick = false
  private pointerType = 'mouse'
  private refMarks: HTMLElement[] = []

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
    scroll.addEventListener('click', this.onLinkClick)
    scroll.addEventListener('pointerover', this.onPointerOver)
    scroll.addEventListener('pointerout', this.onPointerOut)
    scroll.addEventListener('pointermove', this.onPointerMove)
    scroll.addEventListener('pointerdown', this.onPointerDown)
    scroll.addEventListener('pointerup', this.onPointerEnd)
    scroll.addEventListener('pointercancel', this.onPointerEnd)
    scroll.addEventListener('contextmenu', this.onContextMenu)
  }

  async init(): Promise<void> {
    // measure page 1; assume uniform until pages prove otherwise (fixed lazily)
    const p1 = await this.doc.getPage(1)
    const box = boxOf(p1)
    for (let i = 0; i < this.numPages; i++) this.boxes.push({ ...box })
    this.buildSlots(p1)
    this.applyFit()
    this.relayout()
    this.update()
  }

  // ── page geometry ────────────────────────────────────────────────────────

  /** total rotation for a 0-based page index: intrinsic + doc + per-page */
  private rotationOf(i: number): number {
    return normRotation(
      (this.boxes[i]?.rotate ?? 0) + this.rotation + (this.pageRotation.get(i + 1) ?? 0),
    )
  }

  /** user-applied rotation only (what pdf.js adds on top of page.rotate) */
  private userRotationOf(i: number): number {
    return normRotation(this.rotation + (this.pageRotation.get(i + 1) ?? 0))
  }

  private sizeOf(i: number): { w: number; h: number } {
    const d = displaySize(this.boxes[i], this.rotationOf(i), this.crop)
    return { w: d.w * this.scale, h: d.h * this.scale }
  }

  private fullSizeOf(i: number): { w: number; h: number } {
    const r = rotatedSize(this.boxes[i], this.rotationOf(i))
    return { w: r.w * this.scale, h: r.h * this.scale }
  }

  private buildSlots(p1: PDFPageProxy): void {
    for (let i = 0; i < this.numPages; i++) {
      const el = document.createElement('div')
      el.className = 'pv-page'
      el.dataset.page = String(i + 1)
      const inner = document.createElement('div')
      inner.className = 'pv-page-inner'
      el.appendChild(inner)
      this.area.appendChild(el)
      this.slots.push({
        el, inner, canvas: null, textLayerDiv: null, hlLayer: null,
        page: i === 0 ? p1 : null,
        rendered: false, rendering: false, renderTask: null,
        renderedScale: 1, renderedRotation: 0,
        hasImages: null, textIndex: null, textItems: null, links: null,
        left: 0, top: 0,
      })
    }
  }

  /** group pages into rows according to spread settings */
  private buildRows(): void {
    this.rows = []
    this.rowOfPage = new Array(this.numPages).fill(0)
    if (this.spread === 1) {
      for (let i = 0; i < this.numPages; i++) this.rows.push({ pages: [i], top: 0, height: 0, width: 0 })
    } else {
      let i = 0
      if (this.coverAlone && this.numPages > 1) {
        this.rows.push({ pages: [0], top: 0, height: 0, width: 0 })
        i = 1
      }
      for (; i < this.numPages; i += 2) {
        const pages = i + 1 < this.numPages ? [i, i + 1] : [i]
        this.rows.push({ pages, top: 0, height: 0, width: 0 })
      }
    }
    this.rows.forEach((r, ri) => r.pages.forEach((p) => (this.rowOfPage[p] = ri)))
    this.currentRow = Math.min(this.currentRow, this.rows.length - 1)
  }

  /** recompute row metrics and write placement to the DOM */
  private relayout(): void {
    if (!this.rows.length) this.buildRows()
    let areaW = 0
    for (const row of this.rows) {
      let w = 0
      let h = 0
      for (const p of row.pages) {
        const s = this.sizeOf(p)
        w += s.w
        h = Math.max(h, s.h)
      }
      if (row.pages.length > 1) w += SPREAD_GAP
      row.width = w
      row.height = h
      areaW = Math.max(areaW, w)
    }
    const paged = this.scrollMode === 'paged'
    let top = 0
    for (let ri = 0; ri < this.rows.length; ri++) {
      const row = this.rows[ri]
      const shown = !paged || ri === this.currentRow
      row.top = shown ? top : -1
      let x = (areaW - row.width) / 2
      for (const p of row.pages) {
        const s = this.slots[p]
        const sz = this.sizeOf(p)
        s.left = x
        s.top = row.top
        s.el.style.display = shown ? '' : 'none'
        if (shown) {
          s.el.style.left = `${x}px`
          s.el.style.top = `${row.top}px`
          s.el.style.width = `${sz.w}px`
          s.el.style.height = `${sz.h}px`
          const full = this.fullSizeOf(p)
          const off = cropOffset(this.boxes[p], this.rotationOf(p), this.crop, this.scale)
          s.inner.style.left = `${-off.x}px`
          s.inner.style.top = `${-off.y}px`
          s.inner.style.width = `${full.w}px`
          s.inner.style.height = `${full.h}px`
        }
        x += sz.w + SPREAD_GAP
      }
      if (shown) top += row.height + PAGE_GAP
    }
    this.area.style.height = `${Math.max(0, top - PAGE_GAP)}px`
    this.area.style.width = `${areaW}px`
  }

  applyFit(): void {
    const avail = this.scroll.clientWidth - 32
    const availH = this.scroll.clientHeight - 24
    if (!this.rows.length) this.buildRows()
    const row = this.rows[Math.min(this.currentRow, this.rows.length - 1)] ?? { pages: [0] }
    // row extent at scale 1
    let w1 = 0
    let h1 = 0
    for (const p of row.pages) {
      const d = displaySize(this.boxes[p] ?? { x0: 0, y0: 0, w: 612, h: 792, rotate: 0 }, this.rotationOf(p), this.crop)
      w1 += d.w
      h1 = Math.max(h1, d.h)
    }
    if (row.pages.length > 1) w1 += SPREAD_GAP
    if (!w1 || !h1) return
    if (this.fitMode === 'width') this.scale = avail / w1
    else if (this.fitMode === 'page') this.scale = Math.min(avail / w1, availH / h1)
    this.scale = Math.min(Math.max(this.scale, 0.1), 8)
  }

  // ── view settings ────────────────────────────────────────────────────────

  setZoom(scale: number | 'width' | 'page'): void {
    const anchor = this.currentPage()
    if (typeof scale === 'number') {
      this.fitMode = 'manual'
      this.scale = Math.min(Math.max(scale, 0.1), 8)
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

  /**
   * Rotate the document (`page` omitted) or one page, by a relative delta.
   * Absolute values go through setRotation/setPageRotation.
   */
  rotateBy(delta: number, page?: number): void {
    if (page == null) this.setRotation(this.rotation + delta)
    else this.setPageRotation(page, (this.pageRotation.get(page) ?? 0) + delta)
  }

  setRotation(deg: number): void {
    this.rotation = normRotation(deg)
    this.afterGeometryChange()
  }

  setPageRotation(page: number, deg: number): void {
    const d = normRotation(deg)
    if (d === 0) this.pageRotation.delete(page)
    else this.pageRotation.set(page, d)
    this.afterGeometryChange()
  }

  /** serialize per-page rotations for persistence */
  pageRotations(): Record<string, number> {
    return Object.fromEntries([...this.pageRotation].map(([p, d]) => [String(p), d]))
  }

  setPageRotations(map: Record<string, number> | undefined): void {
    this.pageRotation.clear()
    for (const [k, v] of Object.entries(map ?? {})) {
      const d = normRotation(v)
      if (d) this.pageRotation.set(Number(k), d)
    }
  }

  setCrop(crop: CropRect | null): void {
    this.crop = crop ?? NO_CROP
    this.afterGeometryChange()
  }

  setScrollMode(mode: ScrollMode): void {
    if (this.scrollMode === mode) return
    const anchor = this.currentPage()
    this.scrollMode = mode
    this.currentRow = this.rowOfPage[anchor - 1] ?? 0
    this.afterGeometryChange(anchor)
  }

  setSpread(spread: Spread, coverAlone = this.coverAlone): void {
    if (this.spread === spread && this.coverAlone === coverAlone) return
    const anchor = this.currentPage()
    this.spread = spread
    this.coverAlone = coverAlone
    this.rows = []
    this.afterGeometryChange(anchor)
  }

  /** shared tail of every geometry mutation: rebuild, re-fit, re-anchor */
  private afterGeometryChange(anchor = this.currentPage()): void {
    this.buildRows()
    this.currentRow = this.rowOfPage[anchor - 1] ?? 0
    if (this.fitMode !== 'manual') this.applyFit()
    this.relayout()
    this.invalidateRendered()
    this.scrollToPage(anchor)
    this.update()
    this.onVisiblePage(this.currentPage())
  }

  setDarkPdf(mode: DarkPdfMode): void {
    this.darkPdf = mode
    this.invalidateRendered()
    this.update()
  }

  /** called by the host when the scroll container resized */
  onResize(): void {
    if (this.fitMode === 'manual') { this.relayout(); return }
    const anchor = this.currentPage()
    this.applyFit()
    this.relayout()
    this.invalidateRendered()
    this.scrollToPage(anchor)
    clearTimeout(this.zoomDebounce)
    this.zoomDebounce = window.setTimeout(() => this.update(), 180)
  }

  private invalidateRendered(): void {
    for (const s of this.slots) {
      if (s.renderTask) { s.renderTask.cancel(); s.renderTask = null }
      s.rendered = false
      s.rendering = false
      // keep the old canvas visible (CSS-scaled) until replaced, unless the
      // rotation changed — a 90°-stale canvas at the new box size is garbage
      const i = this.slots.indexOf(s)
      if (s.canvas && s.renderedRotation === this.rotationOf(i)) {
        const full = this.fullSizeOf(i)
        s.canvas.style.width = `${full.w}px`
        s.canvas.style.height = `${full.h}px`
      } else if (s.canvas) {
        s.canvas.remove()
        s.canvas = null
      }
    }
  }

  // ── navigation ───────────────────────────────────────────────────────────

  currentPage(): number {
    if (this.scrollMode === 'paged') {
      return (this.rows[this.currentRow]?.pages[0] ?? 0) + 1
    }
    const mid = this.scroll.scrollTop + this.scroll.clientHeight / 3
    for (const row of this.rows) {
      if (mid >= row.top && mid < row.top + row.height + PAGE_GAP) return row.pages[0] + 1
    }
    return this.rows.length ? this.rows[this.rows.length - 1].pages[0] + 1 : 1
  }

  scrollToPage(page: number, offsetRatio = 0): void {
    const i = Math.min(Math.max(page, 1), this.numPages) - 1
    const ri = this.rowOfPage[i] ?? 0
    const row = this.rows[ri]
    if (!row) return
    if (this.scrollMode === 'paged') {
      if (ri !== this.currentRow) {
        this.currentRow = ri
        this.relayout()
      }
      this.scroll.scrollTop = row.height * offsetRatio
    } else {
      this.scroll.scrollTop = row.top + row.height * offsetRatio
    }
  }

  /** advance by one row (paged) or one page-height (continuous) */
  turnPage(dir: 1 | -1): void {
    if (this.scrollMode === 'paged') {
      const ri = Math.min(Math.max(this.currentRow + dir, 0), this.rows.length - 1)
      if (ri === this.currentRow) return
      this.currentRow = ri
      this.relayout()
      this.scroll.scrollTop = 0
      this.update()
      this.onVisiblePage(this.currentPage())
      return
    }
    const p = this.currentPage() + (this.spread === 2 ? 2 : 1) * dir
    this.scrollToPage(Math.min(Math.max(p, 1), this.numPages))
  }

  /** scroll so the given PDF-space quad on `page` is visible */
  scrollToQuad(page: number, quad: Quad): void {
    const i = page - 1
    const s = this.slots[i]
    if (!s) return
    this.scrollToPage(page)
    const r = pdfRectToView(quad, this.boxes[i], this.rotationOf(i), this.scale)
    const off = cropOffset(this.boxes[i], this.rotationOf(i), this.crop, this.scale)
    const yInPage = r.top - off.y
    const base = this.scrollMode === 'paged' ? 0 : s.top
    this.scroll.scrollTop = Math.max(0, base + yInPage - this.scroll.clientHeight / 3)
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
    const row = this.rows[this.rowOfPage[page - 1] ?? 0]
    if (!row) return { page, ratio: 0 }
    const base = this.scrollMode === 'paged' ? 0 : row.top
    const ratio = Math.max(0, Math.min(1, (this.scroll.scrollTop - base) / Math.max(1, row.height)))
    return { page, ratio }
  }

  restorePosition(pos: { page: number; ratio: number }): void {
    this.scrollToPage(pos.page, pos.ratio)
  }

  // ── auto-scroll ──────────────────────────────────────────────────────────

  /** px/second in continuous mode; in paged mode it drives auto page-turns */
  setAutoScroll(pxPerSec: number): void {
    this.autoSpeed = Math.max(0, pxPerSec)
    if (this.autoRaf) { cancelAnimationFrame(this.autoRaf); this.autoRaf = 0 }
    if (!this.autoSpeed) return
    this.autoLast = performance.now()
    this.autoRemainder = 0
    const step = (now: number): void => {
      if (this.destroyed || !this.autoSpeed) { this.autoRaf = 0; return }
      const dt = Math.min(0.25, (now - this.autoLast) / 1000)
      this.autoLast = now
      if (this.scrollMode === 'paged') {
        // one "page" of travel = the row height; turn when we've accrued it
        this.autoRemainder += this.autoSpeed * dt
        const rowH = this.rows[this.currentRow]?.height ?? 800
        if (this.autoRemainder >= rowH) {
          this.autoRemainder = 0
          if (this.currentRow >= this.rows.length - 1) { this.stopAutoScroll(); return }
          this.turnPage(1)
        }
      } else {
        const before = this.scroll.scrollTop
        this.autoRemainder += this.autoSpeed * dt
        const whole = Math.floor(this.autoRemainder)
        if (whole > 0) {
          this.autoRemainder -= whole
          this.scroll.scrollTop = before + whole
          // hit the bottom: stop instead of spinning
          if (this.scroll.scrollTop === before) { this.stopAutoScroll(); return }
        }
      }
      this.autoRaf = requestAnimationFrame(step)
    }
    this.autoRaf = requestAnimationFrame(step)
  }

  stopAutoScroll(): void {
    this.autoSpeed = 0
    if (this.autoRaf) { cancelAnimationFrame(this.autoRaf); this.autoRaf = 0 }
    this.onAutoScrollEnd()
  }

  get autoScrolling(): boolean {
    return this.autoSpeed > 0
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private visibleRows(): [number, number] {
    if (!this.rows.length) return [0, -1]
    if (this.scrollMode === 'paged') {
      return [Math.max(0, this.currentRow - 1), Math.min(this.rows.length - 1, this.currentRow + 1)]
    }
    const topEdge = this.scroll.scrollTop
    const botEdge = topEdge + this.scroll.clientHeight
    let first = 0
    while (first < this.rows.length - 1 && this.rows[first].top + this.rows[first].height < topEdge) first++
    let last = first
    while (last < this.rows.length - 1 && this.rows[last].top < botEdge) last++
    return [Math.max(0, first - RENDER_BUFFER), Math.min(this.rows.length - 1, last + RENDER_BUFFER)]
  }

  update(): void {
    if (this.destroyed) return
    const [lo, hi] = this.visibleRows()
    const live = new Set<number>()
    for (let ri = lo; ri <= hi; ri++) for (const p of this.rows[ri].pages) live.add(p)
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      if (live.has(i)) {
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
      const real = boxOf(s.page)
      // correct the size assumption if this page differs (mixed-size docs)
      const old = this.boxes[i]
      if (Math.abs(real.w - old.w) > 1 || Math.abs(real.h - old.h) > 1 ||
          real.rotate !== old.rotate || real.x0 !== old.x0 || real.y0 !== old.y0) {
        this.boxes[i] = real
        this.relayout()
      }
      if (this.destroyed) return
      const totalRot = this.rotationOf(i)
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const vp = s.page.getViewport({ scale: this.scale, rotation: s.page.rotate + this.userRotationOf(i) })
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
      s.inner.textContent = ''
      s.inner.appendChild(canvas)
      s.canvas = canvas
      s.renderedScale = this.scale
      s.renderedRotation = totalRot

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
        // `textLayer` pulls in pdf.js's own span sizing rules; pdf.js 5 sizes
        // glyph spans from --total-scale-factor (the older --scale-factor is
        // kept for anything still reading it). Without both, every span kept
        // its unscaled 13px font — text hit-testing (selection, smart
        // references) then missed the glyphs it was drawn over.
        tl.className = 'pv-textlayer textLayer'
        tl.style.setProperty('--scale-factor', String(this.scale))
        tl.style.setProperty('--total-scale-factor', String(this.scale))
        s.inner.appendChild(tl)
        const layer = new TextLayer({
          textContentSource: textContent,
          container: tl,
          viewport: vp,
        })
        await layer.render()
        s.textLayerDiv = tl
      }

      // one getAnnotations() feeds both the form widgets and the links
      const annots = await s.page.getAnnotations({ intent: 'display' }).catch(() => [] as unknown[])
      if (this.destroyed) return
      // interactive form widgets (text inputs / checkboxes / dropdowns)
      await this.renderFormLayer(s, vp, annots)
      // hyperlinks
      this.renderLinkLayer(s, i, annots)

      // highlight layer
      const hl = document.createElement('div')
      hl.className = 'pv-hl-layer'
      s.inner.appendChild(hl)
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
  private async renderFormLayer(s: PageSlot, vp: ReturnType<PDFPageProxy['getViewport']>, all: unknown[]): Promise<void> {
    try {
      // links are ours (renderLinkLayer): pdf.js would add dead duplicates
      // wired to the no-op link service on top of them
      const annots = (all as { subtype?: string }[]).filter((a) => a.subtype !== 'Link')
      if (!annots.some((a) => a.subtype === 'Widget')) return
      const div = document.createElement('div')
      div.className = 'annotationLayer'
      div.style.setProperty('--scale-factor', String(this.scale))
      s.inner.appendChild(div)
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

  // ── links ────────────────────────────────────────────────────────────────

  /**
   * One transparent hit box per Link annotation, positioned with the same
   * geometry helpers as highlights — so rotation, crop and zoom need nothing
   * special. Sits above the text layer (like pdf.js's own viewer): a link
   * area is for clicking; selection still works everywhere else and can be
   * dragged across a link.
   */
  private renderLinkLayer(s: PageSlot, i: number, annots: unknown[]): void {
    if (!s.links) {
      s.links = []
      for (const a of annots) {
        const raw = linkTargetOf(a)
        const rect = raw && annotRect(a)
        if (raw && rect) s.links.push({ rect, raw })
      }
    }
    if (!s.links.length) return
    const layer = document.createElement('div')
    layer.className = 'pv-link-layer'
    const box = this.boxes[i]
    const rot = this.rotationOf(i)
    s.links.forEach((l, k) => {
      const v = pdfRectToView({ x1: l.rect[0], y1: l.rect[1], x2: l.rect[2], y2: l.rect[3] }, box, rot, this.scale)
      // hairline links (a 0.2pt-wide box in the ISO spec) still get a target
      const w = Math.max(v.width, 6)
      const h = Math.max(v.height, 6)
      const a = document.createElement('a')
      a.className = 'pv-link'
      a.dataset.link = String(k)
      a.draggable = false
      if (l.raw.kind === 'external') {
        a.title = l.raw.url
        a.dataset.external = '1'
      }
      a.setAttribute('role', 'link')
      a.style.cssText = `left:${v.left - (w - v.width) / 2}px;top:${v.top - (h - v.height) / 2}px;width:${w}px;height:${h}px`
      layer.appendChild(a)
    })
    s.inner.appendChild(layer)
  }

  /** does this page carry in-document links? (then smart refs stay off) */
  private hasInternalLinks(i: number): boolean {
    return !!this.slots[i]?.links?.some((l) => l.raw.kind !== 'external')
  }

  private async resolveLinkEl(el: HTMLElement): Promise<{ page: number; target: Awaited<ReturnType<typeof resolveLinkTarget>> } | null> {
    const pageEl = el.closest('.pv-page') as HTMLElement | null
    const page = pageEl ? parseInt(pageEl.dataset.page!, 10) : 0
    const link = this.slots[page - 1]?.links?.[parseInt(el.dataset.link ?? '-1', 10)]
    if (!link) return null
    return { page, target: await resolveLinkTarget(this.doc, link.raw, page) }
  }

  /** follow a link element: jump inside the doc, or hand a URL outward */
  private async followLinkEl(el: HTMLElement): Promise<void> {
    const r = await this.resolveLinkEl(el)
    if (!r?.target || this.destroyed) return
    if (r.target.kind === 'external') this.onExternalLink(r.target.url)
    else this.goToDest(r.target.dest)
  }

  /** jump to a destination, recording history (links, outline, previews) */
  goToDest(dest: LinkDest): void {
    const commit = this.onBeforeJump()
    this.scrollToDest(dest)
    commit()
  }

  /**
   * Scroll so a destination's top-left lands at the top of the viewport —
   * the exact spot, not just the page top — and flash a marker there.
   * x/y null fall back to the page's top/left.
   */
  scrollToDest(dest: LinkDest): void {
    const page = Math.min(Math.max(dest.page, 1), this.numPages)
    const i = page - 1
    const s = this.slots[i]
    this.scrollToPage(page)
    if (s && (dest.x != null || dest.y != null)) {
      const box = this.boxes[i]
      const rot = this.rotationOf(i)
      const px = dest.x ?? box.x0
      const py = Math.min(dest.y ?? box.y0 + box.h, box.y0 + box.h)
      const v = pdfToView(px, py, box, rot, this.scale)
      const off = cropOffset(box, rot, this.crop, this.scale)
      const base = this.scrollMode === 'paged' ? 0 : s.top
      this.scroll.scrollTop = Math.max(0, base + v.y - off.y - 8)
      // only when zoomed past the viewport width is there anything to aim at
      if (dest.x != null && this.scroll.scrollWidth > this.scroll.clientWidth + 4) {
        this.scroll.scrollLeft = Math.max(0, s.left + v.x - off.x - 16)
      }
      this.flashDest(i, v.y - off.y)
    }
    this.settle()
  }

  /** a short-lived bar where a jump landed, so the eye finds the spot */
  private flashDest(i: number, yInPage: number): void {
    const s = this.slots[i]
    if (!s) return
    s.el.querySelectorAll('.pv-dest-flash').forEach((e) => e.remove())
    const bar = document.createElement('div')
    bar.className = 'pv-dest-flash'
    bar.style.top = `${Math.max(0, yInPage)}px`
    // on the clip box, not the inner page: a page that renders after the
    // jump wipes its inner layers, and the marker must survive that
    s.el.appendChild(bar)
    setTimeout(() => bar.remove(), 1600)
  }

  /** render + report after a programmatic scroll (paged mode may not emit
   *  a scroll event when scrollTop happens to stay the same) */
  settle(): void {
    this.update()
    this.onVisiblePage(this.currentPage())
  }

  /**
   * On-screen size of a region preview that fits in maxW × maxH. Rotation
   * matters: a 90°-turned page makes a wide strip tall, and the popup must
   * know that before it has rendered anything, to place itself.
   */
  regionSize(pageNum: number, region: Quad, maxW: number, maxH: number): { w: number; h: number } {
    const i = pageNum - 1
    const v1 = pdfRectToView(region, this.boxes[i], this.rotationOf(i), 1)
    const css = Math.min(maxW / Math.max(1, v1.width), maxH / Math.max(1, v1.height))
    return { w: v1.width * css, h: v1.height * css }
  }

  /**
   * Render one PDF-space region of a page into a canvas fitting maxW × maxH —
   * the link / reference preview. Honours user rotation; dark-invert
   * follows the reader's setting so the popup matches the page.
   */
  async renderRegion(pageNum: number, region: Quad, maxW: number, maxH = Infinity): Promise<HTMLCanvasElement> {
    const page = await this.doc.getPage(pageNum)
    const box = boxOf(page)
    const rot = normRotation(box.rotate + this.userRotationOf(pageNum - 1))
    const v1 = pdfRectToView(region, box, rot, 1)
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    const css = Math.min(maxW / Math.max(1, v1.width), maxH / Math.max(1, v1.height))
    const scale = css * dpr
    const canvas = await this.renderToCanvas(pageNum, scale, {
      x: v1.left * scale, y: v1.top * scale, w: v1.width * scale, h: v1.height * scale,
    })
    canvas.style.width = `${v1.width * css}px`
    canvas.style.height = `${v1.height * css}px`
    if (this.theme() === 'dark' && this.darkPdf === 'smart') {
      const s = this.slots[pageNum - 1]
      if (s.hasImages === null) s.hasImages = await this.pageHasImages(page)
      canvas.classList.toggle('pv-inverted', !s.hasImages)
    }
    return canvas
  }

  /** what a link's preview shows: the destination's neighbourhood */
  private async regionForDest(dest: LinkDest): Promise<Quad> {
    const box = boxOf(await this.doc.getPage(dest.page))
    const top = box.y0 + box.h
    if (dest.rect) {
      const [x1, y1, x2, y2] = dest.rect
      return { x1: Math.max(box.x0, x1 - 12), y1: Math.max(box.y0, y1 - 12), x2: Math.min(box.x0 + box.w, x2 + 12), y2: Math.min(top, y2 + 12) }
    }
    const tall = Math.min(260, box.h * 0.4)
    // a destination near the bottom still gets a full-height window
    const y2 = Math.max(Math.min(top, (dest.y ?? top) + 12), box.y0 + tall)
    return { x1: box.x0, x2: box.x0 + box.w, y1: y2 - tall, y2 }
  }

  private async previewLinkEl(el: HTMLElement, touch: boolean): Promise<void> {
    const r = await this.resolveLinkEl(el)
    if (!r?.target || this.destroyed) return
    const anchor = el.getBoundingClientRect()
    if (r.target.kind === 'external') {
      // a mouse already sees the URL as a tooltip; touch has no hover
      if (touch) this.onPreview({ kind: 'url', label: r.target.url, url: r.target.url, anchor, touch })
      return
    }
    const dest = r.target.dest
    this.onPreview({
      kind: 'link', label: `p. ${dest.page}`, page: dest.page,
      region: await this.regionForDest(dest), dest, anchor, touch,
    })
  }

  private async previewRef(hit: RefHit, page: number, touch: boolean): Promise<boolean> {
    this.refIndex ??= new SmartRefIndex(this.doc)
    const target = await this.refIndex.resolve(hit.ref, page)
    if (!target || this.destroyed) return false
    // hovering the caption itself: nothing to preview
    if (target.page === page) {
      const s = this.slots[page - 1]
      const inner = s.inner.getBoundingClientRect()
      const v = pdfRectToView(target.line, this.boxes[page - 1], this.rotationOf(page - 1), this.scale)
      const r = hit.rects[0]
      const cx = (r.left + r.right) / 2 - inner.left
      const cy = (r.top + r.bottom) / 2 - inner.top
      if (cx >= v.left - 2 && cx <= v.left + v.width + 2 && cy >= v.top - 2 && cy <= v.top + v.height + 2) return false
    }
    const a = hit.rects[0]
    const b = hit.rects[hit.rects.length - 1]
    this.onPreview({
      kind: hit.ref.kind,
      label: `${hit.text} · p. ${target.page}`,
      page: target.page,
      region: target.region,
      dest: { page: target.page, x: null, y: target.jumpY, fit: 'XYZ' },
      anchor: new DOMRect(a.left, a.top, Math.max(b.right, a.right) - a.left, Math.max(b.bottom, a.bottom) - a.top),
      touch,
    })
    return true
  }

  /** underline the hovered reference so it reads as clickable */
  private markRef(hit: RefHit | null, page: number): void {
    for (const m of this.refMarks) m.remove()
    this.refMarks = []
    const s = hit && this.slots[page - 1]
    if (!hit || !s) return
    const inner = s.inner.getBoundingClientRect()
    for (const r of hit.rects) {
      const m = document.createElement('div')
      m.className = 'pv-ref-mark'
      m.style.cssText = `left:${r.left - inner.left}px;top:${r.top - inner.top}px;width:${r.width}px;height:${r.height}px`
      s.inner.appendChild(m)
      this.refMarks.push(m)
    }
  }

  /** smart-ref hit under a point, only on pages that have no real links */
  private refHitAt(target: EventTarget | null, x: number, y: number): { hit: RefHit; page: number } | null {
    const pageEl = (target as HTMLElement | null)?.closest?.('.pv-page') as HTMLElement | null
    if (!pageEl) return null
    const page = parseInt(pageEl.dataset.page!, 10)
    if (this.hasInternalLinks(page - 1)) return null
    const hit = refUnderPoint(target, x, y)
    return hit ? { hit, page } : null
  }

  private clearHover(): void {
    clearTimeout(this.hoverTimer)
    this.hoverTimer = 0
    if (this.hoverKey) {
      this.hoverKey = ''
      this.markRef(null, 0)
      this.onPreview(null)
    }
  }

  private onPointerOver = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || e.buttons) return
    const el = (e.target as HTMLElement).closest?.('.pv-link') as HTMLElement | null
    if (!el) return
    const key = `link:${(el.closest('.pv-page') as HTMLElement)?.dataset.page}:${el.dataset.link}`
    if (key === this.hoverKey) return
    this.clearHover()
    this.hoverKey = key
    this.hoverTimer = window.setTimeout(() => {
      if (this.hoverKey === key) void this.previewLinkEl(el, false)
    }, HOVER_MS)
  }

  private onPointerOut = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return
    const el = (e.target as HTMLElement).closest?.('.pv-link')
    if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) this.clearHover()
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.pressStart && Math.hypot(e.clientX - this.pressStart.x, e.clientY - this.pressStart.y) > 8) {
      clearTimeout(this.pressTimer)
      this.pressStart = null
    }
    if (e.pointerType !== 'mouse' || this.hoverRaf) return
    const { target, clientX, clientY, buttons } = e
    // a short timer rather than rAF: hit-testing needs no paint, and rAF
    // stalls entirely in a throttled (backgrounded) webview
    this.hoverRaf = window.setTimeout(() => {
      this.hoverRaf = 0
      if (this.destroyed || this.hoverKey.startsWith('link:')) return
      // dragging a selection is not hovering
      const found = buttons ? null : this.refHitAt(target, clientX, clientY)
      if (!found) {
        if (this.hoverKey) this.clearHover()
        return
      }
      if (found.hit.key === this.hoverKey) return
      this.clearHover()
      const key = found.hit.key
      this.hoverKey = key
      this.hoverTimer = window.setTimeout(() => {
        if (this.hoverKey !== key) return
        void this.previewRef(found.hit, found.page, false).then((ok) => {
          if (ok && this.hoverKey === key) this.markRef(found.hit, found.page)
        })
      }, HOVER_MS)
    }, 30)
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerType = e.pointerType
    this.suppressClick = false
    if (e.pointerType === 'mouse') { this.clearHover(); return }
    const el = (e.target as HTMLElement).closest?.('.pv-link') as HTMLElement | null
    if (!el) return
    this.pressStart = { x: e.clientX, y: e.clientY }
    clearTimeout(this.pressTimer)
    this.pressTimer = window.setTimeout(() => {
      this.pressStart = null
      // the finger is still down: this was a long-press, not a tap
      this.suppressClick = true
      void this.previewLinkEl(el, true)
    }, LONG_PRESS_MS)
  }

  private onPointerEnd = (): void => {
    clearTimeout(this.pressTimer)
    this.pressStart = null
  }

  private onContextMenu = (e: MouseEvent): void => {
    // iOS/Android long-press menu on a link would fight the preview
    if (this.pointerType !== 'mouse' && (e.target as HTMLElement).closest?.('.pv-link')) e.preventDefault()
  }

  private onLinkClick = (e: MouseEvent): void => {
    const el = (e.target as HTMLElement).closest?.('.pv-link') as HTMLElement | null
    if (el) {
      e.preventDefault()
      if (this.suppressClick) { this.suppressClick = false; return }
      this.clearHover()
      void this.followLinkEl(el)
      return
    }
    // touch has no hover: a tap on a smart reference opens its preview
    if (this.pointerType === 'mouse') return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    const found = this.refHitAt(e.target, e.clientX, e.clientY)
    if (found) void this.previewRef(found.hit, found.page, true)
  }

  /** E2E hook: preview the reference / link at a client point right now */
  async previewAt(x: number, y: number): Promise<boolean> {
    const target = document.elementFromPoint(x, y)
    const el = (target as HTMLElement | null)?.closest?.('.pv-link') as HTMLElement | null
    if (el) { await this.previewLinkEl(el, false); return true }
    const found = this.refHitAt(target, x, y)
    return found ? this.previewRef(found.hit, found.page, false) : false
  }

  /** serialize the document WITH filled form values */
  async saveFilled(): Promise<Uint8Array> {
    return await this.doc.saveDocument()
  }

  private releasePage(s: PageSlot): void {
    if (s.renderTask) { s.renderTask.cancel(); s.renderTask = null }
    s.inner.textContent = ''
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

  /** offscreen render of one page, for thumbnails / region capture / export */
  async renderToCanvas(pageNum: number, scale: number, clip?: { x: number; y: number; w: number; h: number }): Promise<HTMLCanvasElement> {
    const page = await this.doc.getPage(pageNum)
    const i = pageNum - 1
    const vp = page.getViewport({ scale, rotation: page.rotate + this.userRotationOf(i) })
    const canvas = document.createElement('canvas')
    const w = clip ? Math.max(1, Math.round(clip.w)) : Math.floor(vp.width)
    const h = clip ? Math.max(1, Math.round(clip.h)) : Math.floor(vp.height)
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { alpha: false })!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    if (clip) ctx.translate(-clip.x, -clip.y)
    await page.render({ canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise
    return canvas
  }

  /**
   * Render one PDF-space rectangle to a PNG — the region screenshot.
   * `dpi` is relative to PDF points (72 = 1:1); 200 keeps a figure crisp on
   * a retina screen without turning a full-page grab into a 20MB file.
   */
  async captureRegion(pageNum: number, quad: Quad, dpi = 200): Promise<Uint8Array> {
    const i = pageNum - 1
    const scale = dpi / 72
    const v = pdfRectToView(quad, this.boxes[i], this.rotationOf(i), scale)
    const canvas = await this.renderToCanvas(pageNum, scale, {
      x: v.left, y: v.top, w: v.width, h: v.height,
    })
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    if (!blob) throw new Error('region capture failed')
    return new Uint8Array(await blob.arrayBuffer())
  }

  /** page box + total rotation, for callers doing their own coordinate math */
  pageGeometry(pageNum: number): { box: PageBox; rotation: number; scale: number } {
    return { box: this.boxes[pageNum - 1], rotation: this.rotationOf(pageNum - 1), scale: this.scale }
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

  /**
   * Raw page text split into sentences, each carrying the text-item range it
   * came from so the caller can light it up while it is being read.
   *
   * Deliberately NOT built on the normalized search index: that index strips
   * whitespace (great for CJK anchoring, terrible for a speech engine, which
   * would run every English word together).
   */
  async pageSentences(pageNum: number): Promise<{ text: string; itemRange: [number, number] }[]> {
    const s = this.slots[pageNum - 1]
    if (!s) return []
    // guarantee s.textItems: the caller turns our itemRange into quads via
    // quadsForCharRange, which reads that cache and would otherwise be empty
    // on any page the user hasn't scrolled past yet
    await this.getPageIndex(pageNum)
    if (!s.page) s.page = await this.doc.getPage(pageNum)
    const tc = await s.page.getTextContent()
    type Item = { str: string; hasEOL?: boolean }
    const items = (tc.items as Item[]).filter((it) => 'str' in it)
    // rebuild a plain string, remembering which item each character came from
    let text = ''
    const owner: number[] = []
    for (let i = 0; i < items.length; i++) {
      let chunk = items[i].str
      if (items[i].hasEOL) chunk += '\n'
      // pdf.js emits per-run items; two Latin runs that meet without any
      // whitespace would otherwise be spoken as one mangled word
      if (
        text && chunk &&
        !/\s$/.test(text) && !/^\s/.test(chunk) &&
        /[A-Za-z0-9)\]]$/.test(text) && /^[A-Za-z0-9(\[]/.test(chunk)
      ) {
        text += ' '
        owner.push(i)
      }
      for (let k = 0; k < chunk.length; k++) owner.push(i)
      text += chunk
    }
    const out: { text: string; itemRange: [number, number] }[] = []
    let cursor = 0
    for (const sentence of splitSentences(text)) {
      const at = text.indexOf(sentence, cursor)
      if (at < 0) {
        out.push({ text: sentence, itemRange: [0, 0] })
        continue
      }
      cursor = at + sentence.length
      out.push({
        text: sentence,
        itemRange: [owner[at] ?? 0, owner[Math.max(at, cursor - 1)] ?? 0],
      })
    }
    return out.filter((x) => x.text.trim().length > 0)
  }

  /** transient "being read aloud" overlay; pass null to clear */
  setSpeaking(page: number | null, quads: Quad[] = []): void {
    for (const s of this.slots) s.hlLayer?.querySelectorAll('.pv-speak').forEach((el) => el.remove())
    if (page == null || !quads.length) return
    const i = page - 1
    const s = this.slots[i]
    if (!s?.hlLayer) return
    for (const q of quads) {
      const div = document.createElement('div')
      div.className = 'pv-speak'
      const v = pdfRectToView(q, this.boxes[i], this.rotationOf(i), this.scale)
      div.style.cssText = `left:${v.left}px;top:${v.top}px;width:${v.width}px;height:${v.height}px`
      s.hlLayer.appendChild(div)
    }
  }

  /** scroll just enough to bring a quad into view (no jump when already visible) */
  revealQuad(page: number, quad: Quad): void {
    const i = page - 1
    const s = this.slots[i]
    if (!s) return
    const r = pdfRectToView(quad, this.boxes[i], this.rotationOf(i), this.scale)
    const off = cropOffset(this.boxes[i], this.rotationOf(i), this.crop, this.scale)
    const base = this.scrollMode === 'paged' ? 0 : s.top
    const top = base + r.top - off.y
    const view = this.scroll.scrollTop
    const h = this.scroll.clientHeight
    if (top < view + h * 0.1 || top > view + h * 0.8) {
      this.scroll.scrollTop = Math.max(0, top - h * 0.35)
    }
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
    // client rects -> PDF user space quads (filter zero-width slivers).
    // Rects are measured against the INNER element: it is the full rotated
    // page, which is the space geometry.ts converts from.
    const innerRect = s.inner.getBoundingClientRect()
    const clipRect = startPageEl.getBoundingClientRect()
    const box = this.boxes[pageNum - 1]
    const rot = this.rotationOf(pageNum - 1)
    const quads: Quad[] = []
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue // phantom slivers (zero-width rects)
      if (r.top < clipRect.top - 2 || r.bottom > clipRect.bottom + 2) continue // other page
      const a = viewToPdf(r.left - innerRect.left, r.top - innerRect.top, box, rot, this.scale)
      const b = viewToPdf(r.right - innerRect.left, r.bottom - innerRect.top, box, rot, this.scale)
      quads.push(rnd({
        x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y),
        x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y),
      }))
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
    const i = pageNum - 1
    const s = this.slots[i]
    if (!s?.hlLayer) return
    s.hlLayer.textContent = ''
    const box = this.boxes[i]
    const rot = this.rotationOf(i)
    for (const a of this.annotations) {
      const r = this.resolvedQuads.get(a.id)
      if (!r || r.orphan || r.page !== pageNum) continue
      if (a.kind === 'note') {
        const pin = document.createElement('div')
        pin.className = 'pv-note-pin'
        pin.dataset.annot = a.id
        const q = r.quads[0]
        if (!q) continue
        const v = pdfRectToView(q, box, rot, this.scale)
        pin.style.cssText = `left:${v.left}px;top:${v.top}px`
        pin.title = a.note || ''
        s.hlLayer.appendChild(pin)
        continue
      }
      if (a.kind === 'region') {
        const q = r.quads[0]
        if (!q) continue
        const v = pdfRectToView(q, box, rot, this.scale)
        const div = document.createElement('div')
        div.className = `pv-region pv-hl-${a.color}`
        div.dataset.annot = a.id
        div.style.cssText = `left:${v.left}px;top:${v.top}px;width:${v.width}px;height:${v.height}px`
        s.hlLayer.appendChild(div)
        continue
      }
      for (const q of r.quads) {
        const div = document.createElement('div')
        div.className = `pv-hl pv-hl-${a.color} pv-mk-${a.kind ?? 'highlight'}`
        div.dataset.annot = a.id
        const v = pdfRectToView(q, box, rot, this.scale)
        div.style.cssText = `left:${v.left}px;top:${v.top}px;width:${v.width}px;height:${v.height}px`
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

  /** viewport→PDF for an arbitrary client point on a page (region capture) */
  clientToPdf(pageNum: number, clientX: number, clientY: number): { x: number; y: number } | null {
    const s = this.slots[pageNum - 1]
    if (!s) return null
    const rect = s.inner.getBoundingClientRect()
    return viewToPdf(clientX - rect.left, clientY - rect.top, this.boxes[pageNum - 1], this.rotationOf(pageNum - 1), this.scale)
  }

  /** the page element under a client point, if any.
   *  elementsFromPoint (plural) on purpose: the armed-tool overlay sits on
   *  top of everything, so the singular version only ever finds the overlay. */
  pageAt(clientX: number, clientY: number): number | null {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const page = (el as HTMLElement).closest?.('.pv-page') as HTMLElement | null
      if (page?.dataset.page) return parseInt(page.dataset.page, 10)
    }
    return null
  }

  destroy(): void {
    this.destroyed = true
    this.stopAutoScroll()
    this.scroll.removeEventListener('scroll', this.onScroll)
    document.removeEventListener('selectionchange', this.onSelChange)
    this.scroll.removeEventListener('click', this.onLinkClick)
    this.scroll.removeEventListener('pointerover', this.onPointerOver)
    this.scroll.removeEventListener('pointerout', this.onPointerOut)
    this.scroll.removeEventListener('pointermove', this.onPointerMove)
    this.scroll.removeEventListener('pointerdown', this.onPointerDown)
    this.scroll.removeEventListener('pointerup', this.onPointerEnd)
    this.scroll.removeEventListener('pointercancel', this.onPointerEnd)
    this.scroll.removeEventListener('contextmenu', this.onContextMenu)
    clearTimeout(this.hoverTimer)
    clearTimeout(this.pressTimer)
    clearTimeout(this.hoverRaf)
    for (const s of this.slots) this.releasePage(s)
    this.area.remove()
    void this.doc.destroy()
  }
}

/** page box (MediaBox origin + size) plus intrinsic rotation */
function boxOf(page: PDFPageProxy): PageBox {
  const [x0, y0, x1, y1] = page.view as number[]
  return {
    x0: Math.min(x0, x1),
    y0: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
    rotate: normRotation(page.rotate ?? 0),
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
