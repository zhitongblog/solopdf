/**
 * Import annotations that already live INSIDE a PDF (Acrobat / Preview /
 * PDF Expert / Zotero export / Foxit …) into the Markdown sidecar.
 *
 *   pdf.js getAnnotations() ──fromPdfjs()──▶ PdfAnnot (plain JSON data)
 *                                               │
 *          pendingImports(pdf, existing) ◀──────┤  dedupe by anchor.src.ref
 *                                               │
 *          mapPdfAnnot(p, replies, pageText) ───▶ Annotation (sans id)
 *
 * Engine-agnostic like links.ts: the async helpers only need the handful of
 * pdf.js methods in `ImportDocLike`, so the app, the CLI and the MCP server
 * run the very same mapping. The PDF file itself is never modified.
 *
 * Dedupe key: the pdf.js annotation id (the object reference, "12R") plus
 * the subtype, stored as `anchor.src` inside the imported section. Keeping
 * it per section (not in the meta line) is deliberate: undo works on
 * sections, so undoing an import also forgets that it happened, and
 * deleting an imported mark hands the annotation back to the PDF (it is
 * drawn by pdf.js again and offered for import again).
 */
import type { Annotation, AnnotationKind, DrawData, ImportSource, Quad, SidecarMeta } from './types.js'
import { makeFingerprint } from './anchor.js'
import { upsertAnnotation, type SidecarLabels } from './sidecar.js'
import { drawBounds, normRect, simplifyIndices } from './drawing.js'

/** PDF subtypes we turn into sidecar marks, and what they become. */
export const IMPORT_KIND: Readonly<Record<string, AnnotationKind>> = {
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strike',
  Squiggly: 'squiggly',
  Text: 'note',
  FreeText: 'textbox',
  Ink: 'ink',
  Square: 'rect',
  Circle: 'ellipse',
  Line: 'line',
  Polygon: 'ink',
  PolyLine: 'ink',
}

/** One annotation found in the PDF — plain data, JSON-safe (CLI / MCP). */
export interface PdfAnnot {
  /** pdf.js id = object reference ("12R") */
  ref: string
  /** 1-based page */
  page: number
  /** PDF /Subtype */
  subtype: string
  /** normalized /Rect [x1, y1, x2, y2], PDF user space */
  rect: [number, number, number, number]
  /** /C as 0–255 RGB, null when absent */
  color: [number, number, number] | null
  /** /Contents (the comment text) */
  contents: string
  /** /T */
  author: string
  /** /M or /CreationDate, ISO 8601 */
  date: string | null
  /** border width in points (/BS /W), 1 when unspecified */
  width: number
  /** text marks: one box per line */
  quads?: Quad[]
  /** Ink: strokes as flat [x0, y0, x1, y1, …]; Polygon/PolyLine: one */
  strokes?: number[][]
  /** Line: [x1, y1, x2, y2] — pdf.js NORMALIZES /L, see rawLineCoords() */
  line?: [number, number, number, number]
  /** Line: /LE start and end styles */
  lineEndings?: [string, string]
  /** FreeText: font size and colour from /DA */
  fontSize?: number
  fontColor?: [number, number, number] | null
  /** /IRT target ref, when this annotation is a reply */
  inReplyTo?: string
  /** /RT — 'R' (reply) or 'Group' */
  replyType?: string
}

/** What scanPdfAnnotations() needs from a PDFDocumentProxy. */
export interface ImportDocLike {
  numPages: number
  getPage(n: number): Promise<{
    getAnnotations(o?: { intent?: string }): Promise<unknown[]>
    getTextContent(): Promise<{ items: unknown[] }>
  }>
}

const HIDDEN = 0x02
const NOVIEW = 0x20

function rgb(c: unknown): [number, number, number] | null {
  if (!c || typeof (c as ArrayLike<number>).length !== 'number' || (c as ArrayLike<number>).length < 3) return null
  const a = c as ArrayLike<number>
  return [a[0], a[1], a[2]]
}

const r1 = (n: number): number => Math.round(n * 10) / 10

/** "D:20240301120000+08'00'" → ISO 8601 (null when unparseable) */
export function pdfDateToIso(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const m = s.match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/)
  if (!m) return null
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', tz, th = '00', tm = '00'] = m
  const off = !tz || tz === 'Z' || tz === 'z' ? 'Z' : `${tz}${th}:${tm}`
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}${off}`)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/**
 * pdf.js annotation data → PdfAnnot. Returns null for anything we don't
 * import (links, widgets, popups, stamps …) and for annotations the PDF
 * itself keeps hidden.
 */
export function fromPdfjs(raw: unknown, page: number): PdfAnnot | null {
  const a = raw as Record<string, any>
  if (!a || typeof a.subtype !== 'string' || !(a.subtype in IMPORT_KIND)) return null
  if (typeof a.id !== 'string' || !Array.isArray(a.rect) && !ArrayBuffer.isView(a.rect)) return null
  if ((a.annotationFlags ?? 0) & (HIDDEN | NOVIEW)) return null
  const rect = Array.from(a.rect as ArrayLike<number>).slice(0, 4) as [number, number, number, number]
  const out: PdfAnnot = {
    ref: a.id,
    page,
    subtype: a.subtype,
    rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])],
    color: rgb(a.color),
    contents: (a.contentsObj?.str ?? '').replace(/\r\n?/g, '\n').trim(),
    author: (a.titleObj?.str ?? '').trim(),
    date: pdfDateToIso(a.modificationDate) ?? pdfDateToIso(a.creationDate),
    width: typeof a.borderStyle?.width === 'number' ? a.borderStyle.width : 1,
  }
  if (a.quadPoints && a.quadPoints.length >= 8) {
    // pdf.js already turned every quad into an axis-aligned box:
    // [minX, maxY, maxX, maxY, minX, minY, maxX, minY]
    const q = a.quadPoints as ArrayLike<number>
    out.quads = []
    for (let i = 0; i + 7 < q.length; i += 8) {
      out.quads.push({ x1: r1(q[i]), y1: r1(q[i + 5]), x2: r1(q[i + 2]), y2: r1(q[i + 1]) })
    }
  }
  if (Array.isArray(a.inkLists)) out.strokes = a.inkLists.map((s: ArrayLike<number>) => Array.from(s))
  if (a.vertices && a.vertices.length >= 4) out.strokes = [Array.from(a.vertices as ArrayLike<number>)]
  if (a.lineCoordinates) out.line = Array.from(a.lineCoordinates as ArrayLike<number>).slice(0, 4) as PdfAnnot['line']
  if (Array.isArray(a.lineEndings)) out.lineEndings = [String(a.lineEndings[0]), String(a.lineEndings[1])]
  if (a.subtype === 'FreeText') {
    out.fontSize = a.defaultAppearanceData?.fontSize || 10
    out.fontColor = rgb(a.defaultAppearanceData?.fontColor)
  }
  if (a.inReplyTo) {
    out.inReplyTo = a.inReplyTo
    out.replyType = a.replyType ?? 'R'
  }
  return out
}

/** structural annotations that are not "someone's markup" — never reported */
const NOT_MARKUP = new Set(['Link', 'Widget', 'Popup'])

/**
 * Every importable annotation in the document (cheap: no text extraction).
 * Markup we can't represent (Stamp, Caret, FileAttachment …) is reported
 * through `unsupported` so the CLI/MCP summary can say what was left out.
 */
export async function scanPdfAnnotations(
  doc: ImportDocLike,
  pages: [number, number] = [1, doc.numPages],
  unsupported?: { page: number; subtype: string; ref: string }[],
): Promise<PdfAnnot[]> {
  const out: PdfAnnot[] = []
  for (let p = Math.max(1, pages[0]); p <= Math.min(doc.numPages, pages[1]); p++) {
    const page = await doc.getPage(p)
    const raw = await page.getAnnotations({ intent: 'display' }).catch(() => [])
    for (const r of raw) {
      const a = fromPdfjs(r, p)
      if (a) out.push(a)
      else {
        const x = r as { subtype?: string; id?: string }
        if (unsupported && x?.subtype && !(x.subtype in IMPORT_KIND) && !NOT_MARKUP.has(x.subtype)) {
          unsupported.push({ page: p, subtype: x.subtype, ref: String(x.id ?? '') })
        }
      }
    }
  }
  return out
}

// ── dedupe ───────────────────────────────────────────────────────────────

/** does this sidecar mark stand for that PDF annotation? */
export function isSameSource(src: ImportSource | undefined, p: PdfAnnot): boolean {
  return !!src && src.ref === p.ref && src.type === p.subtype
}

/** replies are folded into their parent's note, never imported alone */
function isReply(p: PdfAnnot, byRef: Map<string, PdfAnnot>): boolean {
  return !!p.inReplyTo && byRef.has(p.inReplyTo)
}

/** PDF annotations not yet in the sidecar (top-level marks only). */
export function pendingImports(pdf: PdfAnnot[], existing: Annotation[]): PdfAnnot[] {
  const byRef = new Map(pdf.map((p) => [p.ref, p]))
  const have = new Set(existing.map((a) => a.anchor.src && `${a.anchor.src.ref}|${a.anchor.src.type}`).filter(Boolean))
  return pdf.filter((p) => !isReply(p, byRef) && p.replyType !== 'Group' && !have.has(`${p.ref}|${p.subtype}`))
}

/**
 * pdf.js ids of PDF annotations the sidecar now draws itself — the viewer
 * hides their original appearance so nothing shows twice. Replies folded
 * into an imported note go with it.
 */
export function importedRefs(existing: Annotation[]): Map<string, string> {
  const out = new Map<string, string>() // ref → subtype ('' = any, for replies)
  for (const a of existing) {
    const s = a.anchor.src
    if (!s) continue
    out.set(s.ref, s.type)
    for (const r of s.replies ?? []) out.set(r, '')
  }
  return out
}

// ── colour ───────────────────────────────────────────────────────────────

/**
 * Nearest of the four highlight swatches by hue. A plain RGB distance would
 * send Acrobat's pure red strike-out to yellow or pink by accident; hue
 * keeps "reddish → pink, cyan → blue, orange → yellow" predictable. Greys
 * and blacks (no hue to speak of) fall back to the default yellow.
 */
export function nearestSwatch(c: [number, number, number] | null): string {
  if (!c) return 'yellow'
  const [r, g, b] = c.map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (max === 0 || d / max < 0.15) return 'yellow'
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h = (h * 60 + 360) % 360
  const anchors: [string, number][] = [['yellow', 52], ['green', 120], ['blue', 215], ['pink', 335]]
  let best = 'yellow'
  let bestD = 999
  for (const [name, at] of anchors) {
    const dist = Math.min(Math.abs(h - at), 360 - Math.abs(h - at))
    if (dist < bestD) { bestD = dist; best = name }
  }
  return best
}

export function rgbHex(c: [number, number, number] | null, fallback = '#1f1f1f'): string {
  if (!c) return fallback
  return '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
}

// ── text under quads ─────────────────────────────────────────────────────

/** the bits of a pdf.js TextItem we read */
export interface TextItemLike {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
}

/**
 * The page text a set of quads covers, plus fingerprint context — so an
 * imported highlight anchors (and relocates) exactly like one made here.
 *
 * Page text is the items joined in content order (the same sequence
 * buildPageIndex() indexes); a char is "under" a quad when its centre is.
 * Char boxes are an even split of the item's advance width — exact for
 * monospace, close enough for proportional fonts at quad granularity.
 * The result is the contiguous run from the first covered char to the
 * last, which is guaranteed to be found again by matchOnPage().
 */
export function textUnderQuads(
  items: TextItemLike[],
  quads: Quad[],
): { text: string; pre: string; post: string } | null {
  if (!quads.length) return null
  let full = ''
  let first = -1
  let last = -1
  const inside = (x: number, y: number) =>
    quads.some((q) => x >= q.x1 - 0.5 && x <= q.x2 + 0.5 && y >= q.y1 - 0.5 && y <= q.y2 + 0.5)
  for (const it of items) {
    if (typeof it?.str !== 'string') continue
    const s = it.str
    const n = s.length
    const [a, b, , d, e, f] = it.transform
    const vertical = Math.abs(a) < 1e-3 && Math.abs(b) > 1e-3
    const h = it.height || Math.hypot(b, d) || 10
    for (let i = 0; i < n; i++) {
      let cx: number
      let cy: number
      if (vertical) {
        // top-to-bottom columns: advance runs down the page
        cx = e + h / 2
        cy = f - (it.width * (i + 0.5)) / n
      } else {
        cx = e + (it.width * (i + 0.5)) / n
        cy = f + h * 0.35
      }
      if (/\S/.test(s[i]) && inside(cx, cy)) {
        if (first < 0) first = full.length + i
        last = full.length + i
      }
    }
    full += s + (it.hasEOL ? '\n' : '')
  }
  if (first < 0) return null
  const raw = full.slice(first, last + 1)
  const fp = makeFingerprint(full.slice(Math.max(0, first - 64), first), raw, full.slice(last + 1, last + 65))
  return { text: joinLines(fp.text), pre: fp.pre, post: fp.post }
}

/** line breaks inside an excerpt: a space between Latin words, nothing in CJK */
function joinLines(s: string): string {
  return s.replace(/[ \t]*\n[ \t]*/g, (m, off: number) => {
    const before = s[off - 1] ?? ''
    const after = s[off + m.length] ?? ''
    return /[\p{Script=Latin}\d,.;:!?)]/u.test(before) && /[\p{Script=Latin}\d(]/u.test(after) ? ' ' : ''
  }).trim()
}

// ── mapping ──────────────────────────────────────────────────────────────

const ARROWS = /Arrow$/

/** what a PDF annotation becomes, minus its id */
export function mapPdfAnnot(
  p: PdfAnnot,
  replies: PdfAnnot[] = [],
  pageText: TextItemLike[] | null = null,
): Omit<Annotation, 'id'> | null {
  const kind = IMPORT_KIND[p.subtype]
  if (!kind) return null
  const src: ImportSource = { ref: p.ref, type: p.subtype }
  if (p.author) src.author = p.author
  if (p.date) src.date = p.date
  if (replies.length) src.replies = replies.map((r) => r.ref)
  // replies read like a thread under the comment: "— Bob: agreed"
  const thread = replies
    .filter((r) => r.contents)
    .map((r) => `— ${r.author || '?'}: ${r.contents}`)
  const comment = [p.contents, ...thread].filter(Boolean).join('\n\n')
  const base = {
    excerpt: '',
    note: comment,
    createdAt: p.date ?? '',
  }
  const width = Math.max(0.5, r1(p.width || 1))

  switch (kind) {
    case 'highlight':
    case 'underline':
    case 'strike':
    case 'squiggly': {
      const quads = p.quads?.length ? p.quads : [normRect({ x1: p.rect[0], y1: p.rect[1], x2: p.rect[2], y2: p.rect[3] })]
      const t = pageText ? textUnderQuads(pageText, quads) : null
      const excerpt = t ? (t.text.length > 500 ? t.text.slice(0, 500) + '…' : t.text) : ''
      return {
        ...base,
        kind,
        color: nearestSwatch(p.color),
        excerpt,
        // no text under it (scan, figure) → page+quads anchoring, like privacy mode
        anchor: { page: p.page, quads, pre: t?.pre ?? '', post: t?.post ?? '', text: t?.text, src },
      }
    }
    case 'note': {
      // the pin sits on the centre of the other app's icon
      const x = r1((p.rect[0] + p.rect[2]) / 2)
      const y = r1((p.rect[1] + p.rect[3]) / 2)
      return {
        ...base,
        kind,
        color: nearestSwatch(p.color),
        anchor: { page: p.page, quads: [{ x1: x, y1: y, x2: x + 1, y2: y + 1 }], pre: '', post: '', src },
      }
    }
    case 'textbox': {
      const q = normRect({ x1: p.rect[0], y1: p.rect[1], x2: p.rect[2], y2: p.rect[3] })
      return {
        ...base,
        kind,
        // the text box's note IS its text; replies stay below it
        note: comment,
        color: rgbHex(p.fontColor ?? null),
        anchor: { page: p.page, quads: [q], pre: '', post: '', draw: { width: 1, fontSize: r1(p.fontSize || 10) }, src },
      }
    }
    case 'rect':
    case 'ellipse': {
      // /Rect includes the border; our geometry is the stroke's centre line
      const h = width / 2
      const q = normRect({ x1: p.rect[0] + h, y1: p.rect[1] + h, x2: p.rect[2] - h, y2: p.rect[3] - h })
      return {
        ...base,
        kind,
        color: rgbHex(p.color, '#e53935'),
        anchor: { page: p.page, quads: [q], pre: '', post: '', draw: { width }, src },
      }
    }
    case 'line': {
      let l = (p.line ?? [p.rect[0], p.rect[1], p.rect[2], p.rect[3]]).map(r1) as [number, number, number, number]
      const [le0, le1] = p.lineEndings ?? ['None', 'None']
      let k: AnnotationKind = 'line'
      if (ARROWS.test(le1)) k = 'arrow'
      else if (ARROWS.test(le0)) { k = 'arrow'; l = [l[2], l[3], l[0], l[1]] }
      const draw: DrawData = { width, line: l }
      return {
        ...base,
        kind: k,
        color: rgbHex(p.color, '#e53935'),
        anchor: { page: p.page, quads: [drawBounds(k, draw)], pre: '', post: '', draw, src },
      }
    }
    case 'ink': {
      const polygon = p.subtype === 'Polygon' || p.subtype === 'PolyLine'
      const strokes: number[][] = []
      for (const s of p.strokes ?? []) {
        if (s.length < 2) continue
        if (polygon) {
          strokes.push(straightEdges(p.subtype === 'Polygon' ? [...s, s[0], s[1]] : s))
        } else {
          // another app's ink is a dense polyline: thin it like our own pen
          const keep = simplifyIndices(s, 0.35)
          strokes.push(keep.flatMap((i) => [r1(s[i * 2]), r1(s[i * 2 + 1])]))
        }
      }
      if (!strokes.length) return null
      const draw: DrawData = { width, strokes }
      return {
        ...base,
        kind: 'ink',
        color: rgbHex(p.color, '#e53935'),
        anchor: { page: p.page, quads: [drawBounds('ink', draw)], pre: '', post: '', draw, src },
      }
    }
  }
  return null
}

/**
 * A polyline as ink control points that keep its straight edges. Our ink is
 * a uniform Catmull-Rom spline through its points, and that spline
 * overshoots wherever neighbouring gaps differ a lot: through bare corners
 * a triangle bulges into a blob; doubled vertices make loops; one guard
 * point beside a corner still flings the curve past it (the tangent there
 * scales with the long edge). So each edge gets points at 0.5, 1, 2, 4 …
 * points from both of its corners — every gap at most twice its neighbour,
 * the run between them collinear (= straight) and the corner rounded over
 * about half a point, which nobody can see. ~2·log2(edge) points per edge.
 */
function straightEdges(pts: number[]): number[] {
  const n = pts.length / 2
  const out: number[] = [r1(pts[0]), r1(pts[1])]
  for (let i = 0; i + 1 < n; i++) {
    const ax = pts[i * 2], ay = pts[i * 2 + 1]
    const bx = pts[i * 2 + 2], by = pts[i * 2 + 3]
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 0.01) continue
    const ds: number[] = []
    for (let d = 0.5; d < len / 2; d *= 2) ds.push(d)
    const along = [...ds, ...ds.map((d) => len - d).reverse(), len]
    for (const d of along) out.push(r1(ax + ((bx - ax) * d) / len), r1(ay + ((by - ay) * d) / len))
  }
  return out
}

/**
 * Pages whose text the import needs (text marks only) — callers fetch
 * getTextContent() for just these.
 */
export function pagesNeedingText(todo: PdfAnnot[]): number[] {
  const kinds = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly'])
  return [...new Set(todo.filter((p) => kinds.has(p.subtype)).map((p) => p.page))].sort((a, b) => a - b)
}

/**
 * The marks an import would add, in page order, each with a fresh id.
 * `genId` is injected so tests stay deterministic.
 */
export async function buildImports(
  doc: ImportDocLike,
  pdf: PdfAnnot[],
  existing: Annotation[],
  genId: () => string,
): Promise<{ annotations: Annotation[]; skipped: PdfAnnot[] }> {
  const todo = pendingImports(pdf, existing)
  const texts = new Map<number, TextItemLike[]>()
  for (const p of pagesNeedingText(todo)) {
    const tc = await (await doc.getPage(p)).getTextContent().catch(() => ({ items: [] }))
    texts.set(p, tc.items as TextItemLike[])
  }
  const repliesOf = new Map<string, PdfAnnot[]>()
  for (const p of pdf) {
    if (!p.inReplyTo || p.replyType === 'Group') continue
    const list = repliesOf.get(p.inReplyTo) ?? []
    list.push(p)
    repliesOf.set(p.inReplyTo, list)
  }
  const annotations: Annotation[] = []
  const skipped: PdfAnnot[] = []
  const ordered = [...todo].sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0])
  for (const p of ordered) {
    const m = mapPdfAnnot(p, repliesOf.get(p.ref) ?? [], texts.get(p.page) ?? null)
    if (m) annotations.push({ id: genId(), ...m })
    else skipped.push(p)
  }
  return { annotations, skipped }
}

/**
 * Append the imported marks to sidecar text — the same append-only splice
 * every other write uses, so sections the user already has stay untouched.
 */
export function spliceImports(
  text: string,
  annotations: Annotation[],
  pdfPath: string,
  meta: SidecarMeta,
  labels?: SidecarLabels,
): string {
  let out = text
  for (const a of annotations) out = upsertAnnotation(out, a, pdfPath, meta, labels)
  return out
}

/** JSON-friendly digest of an import, shared by the CLI and MCP output */
export function importSummary(
  pdf: PdfAnnot[],
  added: Annotation[],
  existing: Annotation[],
  unsupported: { page: number; subtype: string }[] = [],
) {
  const byKind: Record<string, number> = {}
  for (const a of added) byKind[a.kind ?? 'highlight'] = (byKind[a.kind ?? 'highlight'] ?? 0) + 1
  const top = pdf.filter((p) => !(p.inReplyTo && pdf.some((q) => q.ref === p.inReplyTo)))
  return {
    found: top.length,
    replies: pdf.length - top.length,
    alreadyImported: top.filter((p) => existing.some((a) => isSameSource(a.anchor.src, p))).length,
    imported: added.length,
    byKind,
    unsupported: unsupported.map((u) => `${u.subtype}@p.${u.page}`),
    items: added.map((a) => ({
      id: a.id,
      page: a.anchor.page,
      kind: a.kind ?? 'highlight',
      color: a.color,
      excerpt: a.excerpt,
      note: a.note,
      author: a.anchor.src?.author ?? '',
      date: a.anchor.src?.date ?? '',
      ref: a.anchor.src?.ref ?? '',
    })),
  }
}

// ── /L direction ─────────────────────────────────────────────────────────

/**
 * pdf.js hands Line annotations over with /L passed through normalizeRect,
 * which loses the direction: a "\" line comes back as "/" and the arrow
 * end can't be told from the start. The raw object still has it. This
 * reads `/L [x1 y1 x2 y2]` straight from the file bytes for an object that
 * is stored uncompressed (the common case for annotations); a line inside
 * a compressed object stream keeps pdf.js's normalized coordinates.
 */
export function rawLineCoords(file: Uint8Array | string, ref: string): [number, number, number, number] | null {
  const m = ref.match(/^(\d+)R(\d*)$/)
  if (!m) return null
  const gen = m[2] || '0'
  const head = new RegExp(`(?:^|[^0-9])${m[1]}\\s+${gen}\\s+obj\\b`, 'g')
  // latin1 view: one char per byte, object syntax is ASCII
  const text = typeof file === 'string' ? file : latin1(file)
  let at = -1
  for (const h of text.matchAll(head)) at = h.index! // the LAST definition wins (incremental updates)
  if (at < 0) return null
  const end = text.indexOf('endobj', at)
  const body = text.slice(at, end < 0 ? at + 4096 : end)
  const l = body.match(/\/L\s*\[\s*([-+.\d]+)\s+([-+.\d]+)\s+([-+.\d]+)\s+([-+.\d]+)\s*\]/)
  if (!l) return null
  const v = l.slice(1, 5).map(Number)
  return v.every(Number.isFinite) ? (v as [number, number, number, number]) : null
}

function latin1(bytes: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH))
  return s
}

/** Put the true /L direction back on the scanned Line annotations. */
export function fixLineDirections(pdf: PdfAnnot[], bytes: Uint8Array): void {
  const text = latin1(bytes) // once, not per line
  for (const p of pdf) {
    if (p.subtype !== 'Line') continue
    const l = rawLineCoords(text, p.ref)
    if (l) p.line = l
  }
}

/** a Line whose direction pdf.js may have flipped (diagonal, or arrowed) */
export function needsLineFix(pdf: PdfAnnot[]): boolean {
  return pdf.some((p) => p.subtype === 'Line' && p.line &&
    ((p.line[0] !== p.line[2] && p.line[1] !== p.line[3]) || p.lineEndings?.some((e) => ARROWS.test(e))))
}
