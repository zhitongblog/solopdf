/**
 * Smart references for PDFs without link annotations (Sioyek-style).
 *
 *   pointer over text layer ──refUnderPoint()──▶ "Figure 3" + its client rects
 *                                  │
 *                    SmartRefIndex.resolve(ref, fromPage)
 *                                  │   lazily reads page text as LINES,
 *                                  │   scans outward from fromPage,
 *                                  │   scores lines with core targetScore()
 *                                  ▼
 *                     { page, caption line, preview region, jump y }
 *
 * Everything is lazy and cached per document: nothing runs until the reader
 * actually hovers a reference, each page's lines are extracted once, and
 * each (kind, label, from-page) answer is remembered — including "no
 * target", which is also what suppresses false positives: an unresolvable
 * pattern simply never shows a popup.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  findRefs, targetScore, chooseTarget, isBibEntry,
  type TextRef, type Quad, type RefCandidate,
} from '@solopdf/core'

export interface TextLine {
  text: string
  /** PDF user space bounds */
  quad: Quad
}

export interface RefTarget {
  page: number
  /** the defining line (caption / numbered formula / bibliography entry) */
  line: Quad
  /** what the preview shows, PDF user space */
  region: Quad
  /** PDF y (top edge) to scroll to when the reader follows the ref */
  jumpY: number
}

interface PageData {
  lines: TextLine[]
  bibLines: number
  /** page box: x0, y0, w, h (unrotated PDF units) */
  box: { x0: number; y0: number; w: number; h: number }
}

/** how many pages away from the reference we are willing to read */
const MAX_SCAN = 400

export class SmartRefIndex {
  private pages = new Map<number, Promise<PageData>>()
  private answers = new Map<string, Promise<RefTarget | null>>()

  constructor(private doc: PDFDocumentProxy) {}

  /** text lines of one page (cached) */
  pageData(p: number): Promise<PageData> {
    let d = this.pages.get(p)
    if (!d) {
      d = this.extract(p)
      this.pages.set(p, d)
    }
    return d
  }

  private async extract(p: number): Promise<PageData> {
    const page = await this.doc.getPage(p)
    const [vx0, vy0, vx1, vy1] = page.view as number[]
    const box = { x0: Math.min(vx0, vx1), y0: Math.min(vy0, vy1), w: Math.abs(vx1 - vx0), h: Math.abs(vy1 - vy0) }
    const tc = await page.getTextContent()
    type Item = { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }
    const lines: TextLine[] = []
    let cur: { text: string; x1: number; y1: number; x2: number; y2: number; base: number; h: number; right: number } | null = null
    let eol = false
    const flush = (): void => {
      if (cur && cur.text.trim()) lines.push({ text: cur.text, quad: { x1: cur.x1, y1: cur.y1, x2: cur.x2, y2: cur.y2 } })
      cur = null
    }
    for (const it of tc.items as Item[]) {
      if (!('str' in it)) continue
      const x = it.transform[4]
      const y = it.transform[5]
      const h = Math.max(1, it.height || Math.abs(it.transform[3]) || 1)
      const blank = !it.str.trim()
      if (cur && !blank) {
        const c: NonNullable<typeof cur> = cur
        // a new line starts after an explicit EOL, a baseline change, or when
        // the pen moves back left (next line of the same column)
        const newLine = eol || Math.abs(y - c.base) > Math.max(h, c.h) * 0.6 || x < c.right - Math.max(h, c.h) * 2
        if (newLine) flush()
      }
      if (!blank) {
        if (!cur) cur = { text: '', x1: x, y1: y, x2: x + it.width, y2: y + h, base: y, h, right: x }
        const c: NonNullable<typeof cur> = cur
        // keep word boundaries that pdf.js expressed as geometry, not spaces
        if (c.text && !/\s$/.test(c.text) && x - c.right > h * 0.2) c.text += ' '
        c.text += it.str
        c.x1 = Math.min(c.x1, x)
        c.x2 = Math.max(c.x2, x + it.width)
        c.y1 = Math.min(c.y1, y - h * 0.2)
        c.y2 = Math.max(c.y2, y + h)
        c.right = Math.max(c.right, x + it.width)
      } else if (cur) {
        (cur as { text: string }).text += it.str
      }
      eol = !!it.hasEOL
    }
    flush()
    return { lines, bibLines: lines.filter((l) => isBibEntry(l.text)).length, box }
  }

  /** where is `ref` defined? null when nowhere convincing */
  resolve(ref: Pick<TextRef, 'kind' | 'label'>, fromPage: number): Promise<RefTarget | null> {
    const key = `${ref.kind}:${ref.label}:${ref.kind === 'citation' ? '' : fromPage}`
    let a = this.answers.get(key)
    if (!a) {
      a = this.search(ref, fromPage).catch(() => null)
      this.answers.set(key, a)
    }
    return a
  }

  private async search(ref: Pick<TextRef, 'kind' | 'label'>, fromPage: number): Promise<RefTarget | null> {
    const n = this.doc.numPages
    type Cand = RefCandidate & { line: TextLine; data: PageData }
    const cands: Cand[] = []
    const scanPage = async (p: number): Promise<Cand[]> => {
      const data = await this.pageData(p)
      const found: Cand[] = []
      for (const line of data.lines) {
        const score = targetScore(line.text, ref)
        if (score) found.push({ page: p, score, bibLines: data.bibLines, line, data })
      }
      return found
    }
    // visiting order mirrors chooseTarget's distance: forward first, then
    // backward at a 1.5× penalty — so the first strong hit is the answer
    const order: number[] = []
    if (ref.kind === 'citation') {
      for (let p = fromPage; p <= n; p++) order.push(p)
      for (let p = fromPage - 1; p >= 1; p--) order.push(p)
    } else {
      let f = fromPage
      let b = fromPage - 1
      while (f <= n || b >= 1) {
        const df = f <= n ? f - fromPage : Infinity
        const db = b >= 1 ? (fromPage - b) * 1.5 + 0.5 : Infinity
        if (df <= db) order.push(f++)
        else order.push(b--)
      }
    }
    for (const p of order.slice(0, MAX_SCAN)) {
      const found = await scanPage(p)
      cands.push(...found)
      const strong = ref.kind === 'citation'
        ? found.find((c) => c.score >= 2 && (c.bibLines ?? 0) >= 3)
        : found.find((c) => c.score >= 2)
      if (strong) break
    }
    const best = chooseTarget(cands, ref.kind, fromPage)
    return best ? this.targetFor(ref.kind, best.page, best.line, best.data) : null
  }

  private targetFor(kind: TextRef['kind'], page: number, line: TextLine, data: PageData): RefTarget {
    const { box } = data
    const top = box.y0 + box.h
    const q = line.quad
    const lh = Math.max(8, q.y2 - q.y1)
    const full = { x1: box.x0, x2: box.x0 + box.w }
    // the text column the line sits in, for things that live in one column
    const col = {
      x1: Math.max(box.x0, q.x1 - 12),
      x2: Math.min(box.x0 + box.w, Math.max(q.x2 + 12, q.x1 + box.w * 0.45)),
    }
    let region: Quad
    switch (kind) {
      case 'figure':
        // captions sit UNDER figures: show what's above, plus the caption
        region = { ...full, y2: Math.min(top, q.y2 + box.h * 0.42), y1: Math.max(box.y0, q.y1 - lh * 1.6) }
        break
      case 'table':
        // …and ABOVE tables
        region = { ...full, y2: Math.min(top, q.y2 + lh * 0.8), y1: Math.max(box.y0, q.y1 - box.h * 0.35) }
        break
      case 'equation':
        region = { ...full, y2: Math.min(top, q.y2 + lh * 3), y1: Math.max(box.y0, q.y1 - lh * 2) }
        break
      default:
        region = { ...col, y2: Math.min(top, q.y2 + lh * 0.6), y1: Math.max(box.y0, q.y1 - lh * 5) }
    }
    return { page, line: q, region, jumpY: region.y2 }
  }
}

// ── pointer → reference ────────────────────────────────────────────────────

const spanLists = new WeakMap<HTMLElement, HTMLElement[]>()

/** the text layer's glyph spans in order (cached per layer element) */
function spansOf(layer: HTMLElement): HTMLElement[] {
  let l = spanLists.get(layer)
  if (!l) {
    l = Array.from(layer.querySelectorAll<HTMLElement>('span[role="presentation"]'))
      .filter((s) => s.firstChild?.nodeType === Node.TEXT_NODE)
    spanLists.set(layer, l)
  }
  return l
}

export interface RefHit {
  ref: TextRef
  /** the reference as printed, e.g. "Fig. 3" */
  text: string
  rects: DOMRect[]
  /** stable identity for "is this the same hover as before" */
  key: string
}

/**
 * The smart reference under a client point, if the point is over one.
 * Looks at the hovered span plus its neighbours, so "Figure" and "3"
 * emitted as separate text runs still read as one reference.
 */
export function refUnderPoint(target: EventTarget | null, x: number, y: number): RefHit | null {
  const span = (target as HTMLElement | null)?.closest?.('span[role="presentation"]') as HTMLElement | null
  const layer = span?.closest('.pv-textlayer') as HTMLElement | null
  if (!span || !layer) return null
  const spans = spansOf(layer)
  const at = spans.indexOf(span)
  if (at < 0) return null
  const win = spans.slice(Math.max(0, at - 2), at + 3)
  const nodes: { node: Text; start: number }[] = []
  let text = ''
  let hoveredStart = 0
  for (const s of win) {
    const node = s.firstChild as Text
    if (s === span) hoveredStart = text.length
    nodes.push({ node, start: text.length })
    text += node.data
  }
  const hoveredEnd = hoveredStart + (span.firstChild as Text).data.length
  const locate = (off: number): [Text, number] => {
    for (let k = nodes.length - 1; k >= 0; k--) {
      if (off >= nodes[k].start) return [nodes[k].node, Math.min(off - nodes[k].start, nodes[k].node.data.length)]
    }
    return [nodes[0].node, 0]
  }
  for (const ref of findRefs(text)) {
    if (ref.end <= hoveredStart || ref.start >= hoveredEnd) continue
    const range = document.createRange()
    const [sn, so] = locate(ref.start)
    const [en, eo] = locate(ref.end)
    try {
      range.setStart(sn, so)
      range.setEnd(en, eo)
    } catch {
      continue
    }
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5)
    const inside = rects.some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1)
    if (!inside) continue
    const page = layer.closest('.pv-page') as HTMLElement | null
    return {
      ref,
      text: text.slice(ref.start, ref.end).trim(),
      rects,
      key: `${page?.dataset.page}:${spans.indexOf(win[0])}:${ref.start}:${ref.kind}:${ref.label}`,
    }
  }
  return null
}
