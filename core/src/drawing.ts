/**
 * Drawn marks — ink, shapes and text boxes — as pure geometry.
 *
 * Everything here works in PDF user space (y-up, unrotated) so the same
 * numbers drive the app's SVG layer, the sidecar PNG, and the Rust exporter
 * that writes real Ink / Square / Circle / Line / FreeText annotations.
 *
 *   pointer samples ─▶ simplify (RDP) ─▶ stored control points
 *                                         │
 *                     Catmull-Rom ─▶ cubic Béziers (render / export)
 *
 * The spline is evaluated at render time, not baked into the sidecar: the
 * stored points are few (RDP drops ~80 % of raw samples) and a renderer
 * that can do Béziers — SVG, canvas, a PDF content stream — draws the
 * smooth curve natively. pdfops.rs mirrors catmullRom() exactly.
 */
import type { Annotation, AnnotationKind, DrawData, Quad } from './types.js'
import { DRAWN_KINDS } from './types.js'

export function isDrawn(kind: AnnotationKind | undefined): boolean {
  return !!kind && DRAWN_KINDS.includes(kind)
}

/** round to 0.1pt — sub-point precision is invisible and bloats the JSON */
function r1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Ramer–Douglas–Peucker on a flat [x, y, …] list. `eps` in the list's units.
 * Returns the indices kept (so a parallel pressure array can follow along).
 */
export function simplifyIndices(pts: number[], eps: number): number[] {
  const n = pts.length / 2
  if (n <= 2) return [...Array(n).keys()]
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const ax = pts[a * 2], ay = pts[a * 2 + 1]
    const bx = pts[b * 2], by = pts[b * 2 + 1]
    let worst = -1
    let worstD = eps
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i * 2], pts[i * 2 + 1], ax, ay, bx, by)
      if (d > worstD) { worstD = d; worst = i }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

/**
 * Turn raw pointer samples into a stored stroke: drop jitter, simplify,
 * round. `pressure` (0–1 per sample, optional) becomes a width factor per
 * kept point; a stroke whose factors are all ~1 stores none.
 */
export function finishStroke(
  raw: number[],
  pressure: number[] | null,
  eps = 0.35,
): { points: number[]; factors: number[] | null } {
  // collapse consecutive duplicates (a stationary stylus floods samples)
  const pts: number[] = []
  const prs: number[] = []
  for (let i = 0; i < raw.length; i += 2) {
    const n = pts.length
    if (n && Math.abs(pts[n - 2] - raw[i]) < 0.05 && Math.abs(pts[n - 1] - raw[i + 1]) < 0.05) continue
    pts.push(raw[i], raw[i + 1])
    if (pressure) prs.push(pressure[i / 2] ?? 0.5)
  }
  const idx = simplifyIndices(pts, eps)
  const points: number[] = []
  for (const i of idx) points.push(r1(pts[i * 2]), r1(pts[i * 2 + 1]))
  let factors: number[] | null = null
  if (pressure && prs.length) {
    // a factor per kept point: average of the samples it stands for, so a
    // long simplified run keeps the pressure it was actually drawn with
    factors = idx.map((k, j) => {
      const from = j ? Math.floor((idx[j - 1] + k) / 2) : 0
      const to = j + 1 < idx.length ? Math.ceil((k + idx[j + 1]) / 2) : prs.length - 1
      let s = 0
      let c = 0
      for (let q = from; q <= to; q++) { s += prs[q]; c++ }
      return Math.round(pressureFactor(c ? s / c : 0.5) * 100) / 100
    })
    if (factors.every((f) => Math.abs(f - 1) < 0.04)) factors = null
  }
  return { points, factors }
}

/** stylus pressure 0–1 → width multiplier; 0.5 (the "no pressure" value
 *  browsers report for a pressed mouse) maps to exactly 1 */
export function pressureFactor(p: number): number {
  const c = Math.min(1, Math.max(0, p))
  return 0.35 + 1.3 * c
}

export interface Bezier {
  x0: number; y0: number
  c1x: number; c1y: number
  c2x: number; c2y: number
  x: number; y: number
}

/**
 * Uniform Catmull-Rom through the points, as cubic Béziers (one per gap).
 * The end points are duplicated so the curve starts and ends on them.
 */
export function catmullRom(pts: number[]): Bezier[] {
  const n = pts.length / 2
  const out: Bezier[] = []
  const P = (i: number): [number, number] => {
    const k = Math.min(Math.max(i, 0), n - 1)
    return [pts[k * 2], pts[k * 2 + 1]]
  }
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = P(i - 1)
    const [x1, y1] = P(i)
    const [x2, y2] = P(i + 1)
    const [x3, y3] = P(i + 2)
    out.push({
      x0: x1, y0: y1,
      c1x: x1 + (x2 - x0) / 6, c1y: y1 + (y2 - y0) / 6,
      c2x: x2 - (x3 - x1) / 6, c2y: y2 - (y3 - y1) / 6,
      x: x2, y: y2,
    })
  }
  return out
}

/** distance from (px,py) to segment (ax,ay)-(bx,by) */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const qx = ax + t * dx
  const qy = ay + t * dy
  return Math.hypot(px - qx, py - qy)
}

/** closest distance from a point to a stored stroke's polyline */
export function strokeDist(px: number, py: number, stroke: number[]): number {
  if (stroke.length < 4) return Math.hypot(px - stroke[0], py - stroke[1])
  let best = Infinity
  for (let i = 0; i + 3 < stroke.length; i += 2) {
    best = Math.min(best, segDist(px, py, stroke[i], stroke[i + 1], stroke[i + 2], stroke[i + 3]))
  }
  return best
}

/** arrowhead wings for a line ending at (x2,y2): two points, PDF space */
export function arrowHead(line: [number, number, number, number], width: number): [number, number, number, number] {
  const [x1, y1, x2, y2] = line
  const len = Math.max(Math.hypot(x2 - x1, y2 - y1), 0.001)
  const ux = (x2 - x1) / len
  const uy = (y2 - y1) / len
  const size = Math.max(7, width * 4)
  const back = size * Math.cos(Math.PI / 7)
  const side = size * Math.sin(Math.PI / 7)
  return [
    x2 - ux * back - uy * side, y2 - uy * back + ux * side,
    x2 - ux * back + uy * side, y2 - uy * back - ux * side,
  ]
}

/**
 * Bounding box of a drawn mark, padded by half the stroke width (plus the
 * arrowhead). This is what goes into anchor.quads[0].
 */
export function drawBounds(kind: AnnotationKind, draw: DrawData, rect?: Quad): Quad {
  const pad = Math.max(0.5, draw.width / 2) + 0.5
  const xs: number[] = []
  const ys: number[] = []
  if (kind === 'ink') {
    for (const s of draw.strokes ?? []) {
      for (let i = 0; i < s.length; i += 2) { xs.push(s[i]); ys.push(s[i + 1]) }
    }
    const maxF = Math.max(1, ...(draw.pressure ?? []).flat())
    const p = Math.max(0.5, (draw.width * maxF) / 2) + 0.5
    if (!xs.length) return { x1: 0, y1: 0, x2: 0, y2: 0 }
    return box(xs, ys, p)
  }
  if ((kind === 'line' || kind === 'arrow') && draw.line) {
    const l = draw.line
    xs.push(l[0], l[2])
    ys.push(l[1], l[3])
    if (kind === 'arrow') {
      const h = arrowHead(l, draw.width)
      xs.push(h[0], h[2])
      ys.push(h[1], h[3])
    }
    return box(xs, ys, pad)
  }
  // rect / ellipse / textbox: the rect itself is the geometry
  return rect ? normRect(rect) : { x1: 0, y1: 0, x2: 0, y2: 0 }
}

function box(xs: number[], ys: number[], pad: number): Quad {
  return {
    x1: r1(Math.min(...xs) - pad), y1: r1(Math.min(...ys) - pad),
    x2: r1(Math.max(...xs) + pad), y2: r1(Math.max(...ys) + pad),
  }
}

export function normRect(q: Quad): Quad {
  return {
    x1: r1(Math.min(q.x1, q.x2)), y1: r1(Math.min(q.y1, q.y2)),
    x2: r1(Math.max(q.x1, q.x2)), y2: r1(Math.max(q.y1, q.y2)),
  }
}

/** move a drawn mark by (dx, dy) PDF units — returns new anchor pieces */
export function translateDrawn(a: Annotation, dx: number, dy: number): { quads: Quad[]; draw?: DrawData } {
  const q = a.anchor.quads.map((r) => ({ x1: r1(r.x1 + dx), y1: r1(r.y1 + dy), x2: r1(r.x2 + dx), y2: r1(r.y2 + dy) }))
  const d = a.anchor.draw
  if (!d) return { quads: q }
  const draw: DrawData = { ...d }
  if (d.strokes) draw.strokes = d.strokes.map((s) => s.map((v, i) => r1(v + (i % 2 ? dy : dx))))
  if (d.line) draw.line = [r1(d.line[0] + dx), r1(d.line[1] + dy), r1(d.line[2] + dx), r1(d.line[3] + dy)]
  return { quads: q, draw }
}

// ── colours ──────────────────────────────────────────────────────────────

/** highlight colour names → the hex the exporter has always used */
const NAMED: Record<string, string> = {
  yellow: '#ffd54f', green: '#81c784', blue: '#64b5f6', pink: '#f48fb1',
}

/** #rrggbb (or a named highlight colour) → 0–1 RGB triple */
export function colorTriple(name: string): [number, number, number] {
  const hex = (NAMED[name] ?? name).replace('#', '')
  const n = parseInt(hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex, 16)
  if (Number.isNaN(n) || !/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) return [1, 0.84, 0.31]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// ── export spec (JSON handed to `solopdf-doc annotate`) ─────────────────

/** Mirror of pdfops.rs AnnotSpec. Drawn kinds carry their geometry. */
export interface AnnotExportSpec {
  page: number
  kind: AnnotationKind
  quads: [number, number, number, number][]
  color: [number, number, number]
  contents: string
  author: string
  width?: number
  strokes?: number[][]
  /** per-point width factors (stylus pressure), parallel to strokes */
  pressure?: number[][]
  line?: [number, number, number, number]
  font_size?: number
  /** text box: text direction, see DrawData.rotate */
  rotate?: number
}

/**
 * One annotation → one export spec. `page`/`quads` default to the stored
 * anchor; the app passes its RESOLVED position for text marks instead.
 * A text box always exports its text (it is the annotation's content);
 * other kinds only carry the note when `includeNotes`.
 */
export function exportSpec(
  a: Annotation,
  opts: { page?: number; quads?: Quad[]; includeNotes?: boolean; author?: string } = {},
): AnnotExportSpec | null {
  const quads = opts.quads ?? a.anchor.quads
  if (a.orphan || !quads?.length) return null
  const kind = a.kind ?? 'highlight'
  const spec: AnnotExportSpec = {
    page: opts.page ?? a.anchor.page,
    kind,
    quads: quads.map((q) => [q.x1, q.y1, q.x2, q.y2]),
    color: colorTriple(a.color ?? 'yellow'),
    contents: kind === 'textbox' || opts.includeNotes !== false ? a.note ?? '' : '',
    author: opts.author || 'SoloPDF',
  }
  const d = a.anchor.draw
  if (isDrawn(kind) && d) {
    spec.width = d.width
    if (d.strokes) spec.strokes = d.strokes
    if (d.pressure) spec.pressure = d.pressure
    if (d.line) spec.line = d.line
    if (d.fontSize) spec.font_size = d.fontSize
    if (d.rotate) spec.rotate = d.rotate
  }
  // a drawn mark without its geometry can only be exported as its box
  if (isDrawn(kind) && !d && kind !== 'rect' && kind !== 'ellipse' && kind !== 'textbox') spec.kind = 'rect'
  return spec
}
