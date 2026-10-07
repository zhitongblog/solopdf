/**
 * Text lines from glyph-run rectangles — what the reading ruler snaps to.
 *
 * Input is whatever the view can measure: pdf.js text-layer spans on a PDF
 * page, or Range.getClientRects() fragments in the reflowed book view. Both
 * are just boxes; this module turns them into line segments in READING
 * ORDER, so ↓ walks down the left column of a two-column paper and only then
 * continues at the top of the right column.
 *
 *   rects ──merge (same baseline, small gap)──▶ segments
 *         ──classify against the region's midline──▶ left | right | wide
 *         ──order: top-down, but a run of two-column text is emitted
 *           left column first, then right column──▶ lines
 *
 * Pure geometry (any consistent coordinate space, y down), no DOM — unit
 * tested in core, used by app/src/viewer/ruler.ts.
 */

export interface LineBox {
  left: number
  top: number
  right: number
  bottom: number
}

export interface GroupOptions {
  /** x of the region's vertical midline (page centre / spread gutter) */
  midX: number
  /** max horizontal gap inside one line; default 1.5 × median glyph height */
  gapTol?: number
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** vertical overlap two boxes need to share a line: half the smaller
 *  height, but only 30% for a much smaller box (superscripts, footnote marks) */
function needOverlap(ha: number, hb: number): number {
  const lo = Math.min(ha, hb)
  const hi = Math.max(ha, hb)
  return lo < 0.75 * hi ? 0.3 * lo : 0.5 * lo
}

/** merge runs into line segments (still unordered beyond top-to-bottom) */
export function mergeRuns(rects: LineBox[], gapTol?: number): LineBox[] {
  const runs = rects.filter((r) => r.right - r.left > 0.5 && r.bottom - r.top > 2)
  if (!runs.length) return []
  const h = median(runs.map((r) => r.bottom - r.top))
  const gap = gapTol ?? Math.max(h * 1.5, 8)
  runs.sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom) || a.left - b.left)
  const segs: LineBox[] = []
  for (const r of runs) {
    const rh = r.bottom - r.top
    let hit: LineBox | null = null
    // only recent segments can share a baseline with r (sorted by centre y)
    for (let k = segs.length - 1; k >= 0 && k >= segs.length - 40; k--) {
      const s = segs[k]
      const ov = Math.min(s.bottom, r.bottom) - Math.max(s.top, r.top)
      if (ov < needOverlap(rh, s.bottom - s.top)) continue
      const dx = r.left > s.right ? r.left - s.right : s.left > r.right ? s.left - r.right : 0
      if (dx <= gap) { hit = s; break }
    }
    if (hit) {
      hit.left = Math.min(hit.left, r.left)
      hit.right = Math.max(hit.right, r.right)
      hit.top = Math.min(hit.top, r.top)
      hit.bottom = Math.max(hit.bottom, r.bottom)
    } else {
      segs.push({ ...r })
    }
  }
  // a superscript or a tall glyph can start its own segment before the line
  // it belongs to; fold segments that now overlap mostly
  segs.sort((a, b) => a.top - b.top || a.left - b.left)
  const out: LineBox[] = []
  for (const s of segs) {
    const prev = out.find((p) => {
      const ov = Math.min(p.bottom, s.bottom) - Math.max(p.top, s.top)
      const hmin = Math.min(p.bottom - p.top, s.bottom - s.top)
      const dx = s.left > p.right ? s.left - p.right : p.left > s.right ? p.left - s.right : 0
      return ov >= Math.max(needOverlap(s.bottom - s.top, p.bottom - p.top), 0.3 * hmin) && dx <= gap
    })
    if (prev) {
      prev.left = Math.min(prev.left, s.left)
      prev.right = Math.max(prev.right, s.right)
      prev.top = Math.min(prev.top, s.top)
      prev.bottom = Math.max(prev.bottom, s.bottom)
    } else out.push(s)
  }
  return out
}

/** segments of one region (a page, a book spread) in reading order */
export function groupLines(rects: LineBox[], opts: GroupOptions): LineBox[] {
  const segs = mergeRuns(rects, opts.gapTol).sort((a, b) => a.top - b.top || a.left - b.left)
  if (segs.length < 2) return segs
  const h = median(segs.map((s) => s.bottom - s.top))
  const slack = h * 0.5
  // a short line centred on the gutter (page number, centred heading) belongs
  // to neither column
  const side = (s: LineBox): 'L' | 'R' | 'W' =>
    Math.abs((s.left + s.right) / 2 - opts.midX) < h * 1.5 ? 'W'
      : s.right <= opts.midX + slack ? 'L' : s.left >= opts.midX - slack ? 'R' : 'W'
  const out: LineBox[] = []
  let run: LineBox[] = []
  const flush = (): void => {
    if (!run.length) return
    const left = run.filter((s) => side(s) === 'L')
    const right = run.filter((s) => side(s) === 'R')
    // two real columns: read the left one down, then the right one. A
    // stray short line on one side of single-column text is not a column.
    if (left.length >= 2 && right.length >= 2) out.push(...left, ...right)
    else out.push(...run)
    run = []
  }
  for (const s of segs) {
    if (side(s) === 'W') { flush(); out.push(s) } else run.push(s)
  }
  flush()
  return out
}

/** index of the line nearest a point: same column first, then nearest y */
export function lineAt(lines: LineBox[], x: number, y: number): number {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const dy = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0
    const dx = x < l.left ? l.left - x : x > l.right ? x - l.right : 0
    // vertical distance dominates; horizontal only breaks column ties
    const d = dy * 4 + dx
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

/** union box of lines[i-k .. i+k] — the band for a 1/3/5-line ruler */
export function bandAround(lines: LineBox[], i: number, count: number): LineBox | null {
  const l = lines[i]
  if (!l) return null
  const k = Math.max(0, Math.floor((count - 1) / 2))
  const box = { ...l }
  for (let j = i - k; j <= i + k; j++) {
    const o = lines[j]
    if (!o || j === i) continue
    // a neighbour in another column or far away (next page) is not part of
    // this band
    if (Math.abs(o.top - l.top) > (l.bottom - l.top) * (k + 1) * 2.2) continue
    box.left = Math.min(box.left, o.left)
    box.right = Math.max(box.right, o.right)
    box.top = Math.min(box.top, o.top)
    box.bottom = Math.max(box.bottom, o.bottom)
  }
  return box
}
