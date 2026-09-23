/**
 * Drawn marks on screen and on disk: ink, shapes, text boxes.
 *
 * One primitive list feeds two renderers so they can never disagree:
 *
 *   annotation (PDF space) ──prims()──▶ path commands (view px)
 *                                         ├── SVG  (the live page layer)
 *                                         └── canvas (the sidecar PNG)
 *
 * The Rust exporter draws the same Catmull-Rom curve from the same points
 * (core catmullRom ⇄ pdfops.rs catmull_rom), so screen, PNG and exported PDF
 * all show one stroke.
 */
import {
  arrowHead, catmullRom, drawBounds, segDist, strokeDist, type Annotation, type DrawData, type Quad,
} from '@solopdf/core'
import { pdfRectToView, pdfToView } from '../viewer/geometry'
import type { PdfViewerController } from '../viewer/controller'

export type DrawTool = 'pen' | 'eraser' | 'text' | 'rect' | 'ellipse' | 'line' | 'arrow'
export const DRAW_TOOLS: DrawTool[] = ['pen', 'eraser', 'text', 'rect', 'ellipse', 'line', 'arrow']
export const TOOL_GLYPH: Record<DrawTool, string> = {
  pen: '✏︎', eraser: '⌫', text: 'T', rect: '▭', ellipse: '◯', line: '╱', arrow: '↗',
}
export function isDrawTool(t: string): t is DrawTool {
  return (DRAW_TOOLS as string[]).includes(t)
}

/** pen palette — stored as hex in the sidecar (highlight names still work) */
export const PEN_COLORS = ['#1f1f1f', '#e53935', '#1e63d6', '#2e9e5b', '#f59e0b'] as const
/** stroke widths in PDF points: fine / medium / marker */
export const PEN_WIDTHS = [1, 2, 4] as const
export const FONT_SIZES = [10, 14, 20] as const

/** a stored colour → CSS. Highlight names map to their darker ink tone:
 *  a pastel stroke on white paper is unreadable. */
export function cssColor(c: string): string {
  const INK: Record<string, string> = {
    yellow: '#e0b000', green: '#2e9e5b', blue: '#3a6df0', pink: '#d94f8a',
  }
  return INK[c] ?? (/^#[0-9a-f]{3,6}$/i.test(c) ? c : '#e53935')
}

type ToView = (x: number, y: number) => { x: number; y: number }

type Cmd =
  | ['M', number, number]
  | ['L', number, number]
  | ['C', number, number, number, number, number, number]
  | ['Z']

interface Prim {
  cmds: Cmd[]
  /** px */
  width: number
  /** ink: which stroke this piece belongs to (eraser feedback) */
  stroke?: number
}

/** Path primitives for one drawn mark (not text boxes), in view pixels. */
export function prims(a: Annotation, toView: ToView, scale: number): Prim[] {
  const d = a.anchor.draw
  const w = Math.max(0.5, d?.width ?? 1.5)
  const out: Prim[] = []
  const P = (x: number, y: number): [number, number] => {
    const v = toView(x, y)
    return [v.x, v.y]
  }
  switch (a.kind) {
    case 'ink': {
      ;(d?.strokes ?? []).forEach((s, si) => {
        const f = d?.pressure?.[si]
        const n = s.length / 2
        if (!n) return
        if (n === 1) {
          const [x, y] = P(s[0], s[1])
          out.push({ cmds: [['M', x, y], ['L', x, y]], width: w * scale * (f?.[0] ?? 1), stroke: si })
          return
        }
        const segs = catmullRom(s)
        if (!f || f.length !== n) {
          const cmds: Cmd[] = [['M', ...P(s[0], s[1])]]
          for (const b of segs) cmds.push(['C', ...P(b.c1x, b.c1y), ...P(b.c2x, b.c2y), ...P(b.x, b.y)])
          out.push({ cmds, width: w * scale, stroke: si })
          return
        }
        // pressure: one piece per segment at its own width
        segs.forEach((b, i) => {
          out.push({
            cmds: [['M', ...P(b.x0, b.y0)], ['C', ...P(b.c1x, b.c1y), ...P(b.c2x, b.c2y), ...P(b.x, b.y)]],
            width: w * scale * (f[i] + f[i + 1]) / 2,
            stroke: si,
          })
        })
      })
      break
    }
    case 'rect':
    case 'ellipse': {
      const q = a.anchor.quads[0]
      if (!q) break
      const i = w / 2
      const r = { x1: q.x1 + i, y1: q.y1 + i, x2: q.x2 - i, y2: q.y2 - i }
      if (a.kind === 'rect') {
        out.push({
          cmds: [['M', ...P(r.x1, r.y1)], ['L', ...P(r.x2, r.y1)], ['L', ...P(r.x2, r.y2)], ['L', ...P(r.x1, r.y2)], ['Z']],
          width: w * scale,
        })
      } else {
        const cx = (r.x1 + r.x2) / 2
        const cy = (r.y1 + r.y2) / 2
        const rx = (r.x2 - r.x1) / 2
        const ry = (r.y2 - r.y1) / 2
        const kx = rx * 0.5523
        const ky = ry * 0.5523
        out.push({
          cmds: [
            ['M', ...P(cx + rx, cy)],
            ['C', ...P(cx + rx, cy + ky), ...P(cx + kx, cy + ry), ...P(cx, cy + ry)],
            ['C', ...P(cx - kx, cy + ry), ...P(cx - rx, cy + ky), ...P(cx - rx, cy)],
            ['C', ...P(cx - rx, cy - ky), ...P(cx - kx, cy - ry), ...P(cx, cy - ry)],
            ['C', ...P(cx + kx, cy - ry), ...P(cx + rx, cy - ky), ...P(cx + rx, cy)],
            ['Z'],
          ],
          width: w * scale,
        })
      }
      break
    }
    case 'line':
    case 'arrow': {
      const l = d?.line
      if (!l) break
      const cmds: Cmd[] = [['M', ...P(l[0], l[1])], ['L', ...P(l[2], l[3])]]
      if (a.kind === 'arrow') {
        const h = arrowHead(l, w)
        cmds.push(['M', ...P(h[0], h[1])], ['L', ...P(l[2], l[3])], ['L', ...P(h[2], h[3])])
      }
      out.push({ cmds, width: w * scale })
      break
    }
  }
  return out
}

function pathD(cmds: Cmd[]): string {
  return cmds.map((c) => c[0] + (c.length > 1 ? ' ' + c.slice(1).map((n) => (n as number).toFixed(2)).join(' ') : '')).join(' ')
}

/**
 * SVG markup for one drawn mark: the visible strokes plus a fat transparent
 * copy that takes the clicks (a 1px line is impossible to hit with a finger).
 */
export function drawnSvg(a: Annotation, toView: ToView, scale: number): string {
  const color = cssColor(a.color)
  let vis = ''
  let hit = ''
  for (const p of prims(a, toView, scale)) {
    const d = pathD(p.cmds)
    const s = p.stroke != null ? ` data-stroke="${p.stroke}"` : ''
    vis += `<path d="${d}" stroke="${color}" stroke-width="${p.width.toFixed(2)}"${s}/>`
    hit += `<path class="pv-draw-hit" d="${d}" stroke-width="${(p.width + 14).toFixed(1)}"${s}/>`
  }
  return vis + hit
}

/** Paint one drawn mark onto a 2D canvas (sidecar PNG). */
export function paintDrawn(ctx: CanvasRenderingContext2D, a: Annotation, toView: ToView, scale: number): void {
  ctx.save()
  ctx.strokeStyle = cssColor(a.color)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const p of prims(a, toView, scale)) {
    ctx.lineWidth = p.width
    ctx.beginPath()
    for (const c of p.cmds) {
      if (c[0] === 'M') ctx.moveTo(c[1], c[2])
      else if (c[0] === 'L') ctx.lineTo(c[1], c[2])
      else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6])
      else ctx.closePath()
    }
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * The picture of a drawn mark that goes beside the sidecar: the page region
 * under it, with the mark painted on top — "what did I circle?" is only
 * answerable with the page in the picture.
 */
export async function renderDrawnPng(ctrl: PdfViewerController, a: Annotation): Promise<Uint8Array> {
  const page = a.anchor.page
  const { box, rotation } = ctrl.pageGeometry(page)
  const bounds = a.anchor.quads[0]
  const margin = 12
  const q: Quad = {
    x1: Math.max(box.x0, bounds.x1 - margin), y1: Math.max(box.y0, bounds.y1 - margin),
    x2: Math.min(box.x0 + box.w, bounds.x2 + margin), y2: Math.min(box.y0 + box.h, bounds.y2 + margin),
  }
  if (q.x2 - q.x1 < 2 || q.y2 - q.y1 < 2) {
    q.x1 = bounds.x1 - margin; q.y1 = bounds.y1 - margin; q.x2 = bounds.x2 + margin; q.y2 = bounds.y2 + margin
  }
  // ~180 dpi, but never a poster: a full-page doodle stays under ~1600px
  const span = Math.max(q.x2 - q.x1, q.y2 - q.y1)
  const scale = Math.min(2.5, 1600 / span)
  const v = pdfRectToView(q, box, rotation, scale)
  const canvas = await ctrl.renderToCanvas(page, scale, { x: v.left, y: v.top, w: v.width, h: v.height })
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  paintDrawn(ctx, a, (x, y) => {
    const p = pdfToView(x, y, box, rotation, scale)
    return { x: p.x - v.left, y: p.y - v.top }
  }, scale)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (!blob) throw new Error('drawing snapshot failed')
  return new Uint8Array(await blob.arrayBuffer())
}

/** a fresh bounding quad for the mark's current geometry */
export function boundsOf(a: Annotation): Quad {
  const d = a.anchor.draw ?? { width: 1 }
  return drawBounds(a.kind ?? 'ink', d, a.anchor.quads[0])
}

/**
 * Text box frame, relative to the text: which way the text runs in PDF user
 * space depends on how the page was turned when the box was written (so the
 * text reads upright on the screen it was typed on). Returns the frame size
 * in points along/across the text.
 */
export function textFrame(q: Quad, rotate: number): { w: number; h: number } {
  return rotate % 180 ? { w: q.y2 - q.y1, h: q.x2 - q.x1 } : { w: q.x2 - q.x1, h: q.y2 - q.y1 }
}

/**
 * Stylus presence, for the whole session: once an Apple Pencil / S Pen has
 * touched the page, fingers stop drawing and go back to scrolling (palm
 * rejection the way every note app does it).
 */
export const penState = { seen: false }

/**
 * What an eraser at (x, y) PDF space touches on this mark: an ink stroke's
 * index, 'all' for a shape, or null. `tol` is the finger/cursor radius in
 * PDF units. Text boxes are never erased — deleting typed text by brushing
 * past it is too easy to do by accident; they have their own delete.
 */
export function eraserHit(a: Annotation, x: number, y: number, tol: number): number | 'all' | null {
  const d = a.anchor.draw
  const w = (d?.width ?? 1) / 2 + tol
  if (a.kind === 'ink') {
    const strokes = d?.strokes ?? []
    for (let i = 0; i < strokes.length; i++) {
      const f = Math.max(1, ...(d?.pressure?.[i] ?? [1]))
      if (strokeDist(x, y, strokes[i]) <= w * f) return i
    }
    return null
  }
  if ((a.kind === 'line' || a.kind === 'arrow') && d?.line) {
    const l = d.line
    return segDist(x, y, l[0], l[1], l[2], l[3]) <= w ? 'all' : null
  }
  const q = a.anchor.quads[0]
  if (!q) return null
  if (a.kind === 'rect') {
    const edges = [q.x1, q.y1, q.x2, q.y1, q.x2, q.y2, q.x1, q.y2, q.x1, q.y1]
    return strokeDist(x, y, edges) <= w ? 'all' : null
  }
  if (a.kind === 'ellipse') {
    const cx = (q.x1 + q.x2) / 2
    const cy = (q.y1 + q.y2) / 2
    const rx = (q.x2 - q.x1) / 2
    const ry = (q.y2 - q.y1) / 2
    const ring: number[] = []
    for (let k = 0; k <= 48; k++) {
      const t = (k / 48) * Math.PI * 2
      ring.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t))
    }
    return strokeDist(x, y, ring) <= w ? 'all' : null
  }
  return null
}

/**
 * Ink draw data with one stroke appended — pressure arrays stay parallel
 * (a uniform stroke next to a pressured one gets explicit 1s).
 */
export function appendStroke(d: DrawData, points: number[], factors: number[] | null): DrawData {
  const strokes = [...(d.strokes ?? []), points]
  let pressure = d.pressure
  if (pressure || factors) {
    const old = d.strokes ?? []
    pressure = old.map((s, i) => d.pressure?.[i] ?? new Array(s.length / 2).fill(1))
    pressure.push(factors ?? new Array(points.length / 2).fill(1))
  }
  return pressure ? { ...d, strokes, pressure } : { ...d, strokes }
}

/** ink draw data without the given stroke indices (null when nothing is left) */
export function dropStrokes(d: DrawData, gone: Set<number>): DrawData | null {
  const keep = (d.strokes ?? []).map((_, i) => i).filter((i) => !gone.has(i))
  if (!keep.length) return null
  const out: DrawData = { ...d, strokes: keep.map((i) => d.strokes![i]) }
  if (d.pressure) out.pressure = keep.map((i) => d.pressure![i])
  return out
}
