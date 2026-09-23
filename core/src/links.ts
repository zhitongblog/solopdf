/**
 * PDF hyperlinks: Link annotations → typed targets.
 *
 * Shared by the viewer (clickable link layer, outline jumps), the CLI
 * (`solopdf links`) and the MCP server (`solopdf_links`), so all three agree
 * on what a link points at. Engine-agnostic: it only needs the handful of
 * pdf.js document methods described by `DocLike`, which keeps this package
 * free of a pdf.js dependency.
 *
 *   annotation ──linkTargetOf()──▶ { internal, raw dest } | { external, url }
 *                                        │
 *                          resolveDestination(doc, raw)   (lazy: named dests
 *                                        │                 cost a lookup each)
 *                                        ▼
 *                         { page, x, y, fit, zoom, rect? }  PDF user space
 *
 * Coordinates follow the PDF explicit-destination rules (ISO 32000-1 12.3.2.2):
 * `/XYZ left top zoom`, `/FitH top`, `/FitV left`, `/FitR l b r t`; a null
 * operand means "keep the current value", which a reader jumping from
 * somewhere else can only interpret as "unspecified".
 */

/** A resolved in-document destination. x/y are PDF user space (y-up). */
export interface LinkDest {
  /** 1-based page number */
  page: number
  /** left edge to bring into view, null = unspecified */
  x: number | null
  /** TOP edge to bring into view (PDF y-up), null = unspecified (page top) */
  y: number | null
  /** destination type: XYZ, Fit, FitH, FitV, FitR, FitB, FitBH, FitBV */
  fit: string
  zoom?: number | null
  /** FitR only: the rectangle to show [x1, y1, x2, y2] */
  rect?: [number, number, number, number]
}

/** Before resolution: what the annotation says, verbatim. */
export type RawLinkTarget =
  | { kind: 'internal'; dest: unknown }
  | { kind: 'named'; action: 'NextPage' | 'PrevPage' | 'FirstPage' | 'LastPage' }
  | { kind: 'external'; url: string }

export type LinkTarget =
  | { kind: 'internal'; dest: LinkDest }
  | { kind: 'external'; url: string }

export interface PdfLink {
  /** 1-based page the link sits on */
  page: number
  /** clickable area, PDF user space [x1, y1, x2, y2] (normalized, x1<x2, y1<y2) */
  rect: [number, number, number, number]
  target: LinkTarget
}

/** The subset of PDFDocumentProxy this module needs. */
export interface DocLike {
  numPages: number
  getDestination(id: string): Promise<unknown[] | null>
  getPageIndex(ref: unknown): Promise<number>
  getPage(n: number): Promise<{ getAnnotations(opts?: { intent?: string }): Promise<unknown[]> }>
}

/** schemes we are willing to hand to the system browser */
const SAFE_URL = /^(https?|mailto|ftp|tel):/i

/** Normalize a link URL; null when it is not something we should open. */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let url = raw.trim()
  if (!url) return null
  // bare "www.example.com" is common in hand-made PDFs
  if (/^www\./i.test(url)) url = 'https://' + url
  return SAFE_URL.test(url) ? url : null
}

/** What does this annotation point at? null for non-links / unsupported. */
export function linkTargetOf(annot: unknown): RawLinkTarget | null {
  const a = annot as {
    subtype?: string; url?: string; unsafeUrl?: string; dest?: unknown; action?: string
  }
  if (!a || a.subtype !== 'Link') return null
  if (a.dest != null) return { kind: 'internal', dest: a.dest }
  const url = safeExternalUrl(a.url) ?? safeExternalUrl(a.unsafeUrl)
  if (url) return { kind: 'external', url }
  if (a.action === 'NextPage' || a.action === 'PrevPage' || a.action === 'FirstPage' || a.action === 'LastPage') {
    return { kind: 'named', action: a.action }
  }
  return null
}

/** normalized annotation rect, or null for degenerate ones */
export function annotRect(annot: unknown): [number, number, number, number] | null {
  const r = (annot as { rect?: ArrayLike<number> })?.rect
  if (!r || r.length < 4) return null
  const x1 = Math.min(r[0], r[2])
  const x2 = Math.max(r[0], r[2])
  const y1 = Math.min(r[1], r[3])
  const y2 = Math.max(r[1], r[3])
  if (!(x2 > x1 && y2 > y1)) return null
  return [x1, y1, x2, y2]
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Explicit destination array → LinkDest, given the page it resolves to.
 * pdf.js hands the type as `{ name: 'XYZ' }`; plain strings are accepted too
 * so tests (and other engines) can pass literals.
 */
export function destFromExplicit(dest: unknown[], page: number): LinkDest {
  const t = dest[1] as { name?: string } | string | undefined
  const fit = (typeof t === 'string' ? t : t?.name) ?? 'Fit'
  const a = dest.slice(2)
  switch (fit) {
    case 'XYZ':
      return { page, fit, x: num(a[0]), y: num(a[1]), zoom: num(a[2]) }
    case 'FitH':
    case 'FitBH':
      return { page, fit, x: null, y: num(a[0]) }
    case 'FitV':
    case 'FitBV':
      return { page, fit, x: num(a[0]), y: null }
    case 'FitR': {
      const [l, b, r, tp] = a.map(num)
      if (l == null || b == null || r == null || tp == null) return { page, fit, x: l, y: tp }
      const rect: [number, number, number, number] = [
        Math.min(l, r), Math.min(b, tp), Math.max(l, r), Math.max(b, tp),
      ]
      return { page, fit, x: rect[0], y: rect[3], rect }
    }
    default:
      return { page, fit, x: null, y: null }
  }
}

/**
 * Resolve a destination (name string, or explicit array whose first element
 * is a page reference or — in some producers — a 0-based page number).
 * null when it cannot be resolved; never throws.
 */
export async function resolveDestination(doc: DocLike, dest: unknown): Promise<LinkDest | null> {
  try {
    let arr: unknown = dest
    if (typeof dest === 'string') arr = await doc.getDestination(dest)
    if (!Array.isArray(arr) || !arr.length) return null
    const ref = arr[0]
    let index: number
    if (typeof ref === 'number') index = ref
    else if (ref && typeof ref === 'object') index = await doc.getPageIndex(ref)
    else return null
    if (!(index >= 0 && index < doc.numPages)) return null
    return destFromExplicit(arr, index + 1)
  } catch {
    return null
  }
}

/** Resolve a raw target relative to the page it sits on. */
export async function resolveLinkTarget(doc: DocLike, raw: RawLinkTarget, fromPage: number): Promise<LinkTarget | null> {
  if (raw.kind === 'external') return raw
  if (raw.kind === 'named') {
    const page = raw.action === 'NextPage' ? fromPage + 1
      : raw.action === 'PrevPage' ? fromPage - 1
      : raw.action === 'FirstPage' ? 1
      : doc.numPages
    if (page < 1 || page > doc.numPages) return null
    return { kind: 'internal', dest: { page, x: null, y: null, fit: 'Fit' } }
  }
  const dest = await resolveDestination(doc, raw.dest)
  return dest ? { kind: 'internal', dest } : null
}

/**
 * Every link on one page, fully resolved. `annots` may be passed when the
 * caller already fetched them (the viewer does, for its form layer).
 */
export async function pageLinks(doc: DocLike, pageNum: number, annots?: unknown[]): Promise<PdfLink[]> {
  const list = annots ?? await (await doc.getPage(pageNum)).getAnnotations({ intent: 'display' })
  const out: PdfLink[] = []
  for (const a of list) {
    const raw = linkTargetOf(a)
    const rect = raw && annotRect(a)
    if (!raw || !rect) continue
    const target = await resolveLinkTarget(doc, raw, pageNum)
    if (target) out.push({ page: pageNum, rect, target })
  }
  return out
}
