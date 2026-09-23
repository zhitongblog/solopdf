import { describe, it, expect } from 'vitest'
import {
  finishStroke, simplifyIndices, catmullRom, drawBounds, translateDrawn, strokeDist,
  exportSpec, colorTriple, isDrawn, pressureFactor,
} from '../src/drawing'
import { parse, upsertAnnotation, genId } from '../src/sidecar'
import type { Annotation } from '../src/types'

const meta = { version: 1 as const, pdfName: 'paper.pdf' }
const pdfPath = '/docs/paper.pdf'

function ink(strokes: number[][], extra: Partial<Annotation> = {}): Annotation {
  const draw = { width: 2, strokes }
  return {
    id: genId(),
    anchor: { page: 3, quads: [drawBounds('ink', draw)], pre: '', post: '', draw },
    excerpt: '', note: '', color: '#e53935', kind: 'ink', image: 'x.png', createdAt: '',
    ...extra,
  }
}

describe('stroke smoothing', () => {
  it('RDP keeps the corners of a polyline and drops the collinear samples', () => {
    const pts: number[] = []
    for (let x = 0; x <= 50; x++) pts.push(x, 0) // flat run
    for (let y = 1; y <= 50; y++) pts.push(50, y) // then straight up
    const keep = simplifyIndices(pts, 0.5)
    expect(keep).toEqual([0, 50, 100])
  })

  it('finishStroke drops duplicates and rounds to 0.1pt', () => {
    const { points, factors } = finishStroke([1.234, 2.345, 1.234, 2.345, 10.01, 2.34], null)
    expect(points).toEqual([1.2, 2.3, 10, 2.3])
    expect(factors).toBeNull()
  })

  it('keeps a pressure factor per kept point, and none when uniform', () => {
    const raw = [0, 0, 5, 5, 10, 0]
    expect(finishStroke(raw, [0.5, 0.5, 0.5]).factors).toBeNull()
    const f = finishStroke(raw, [0.1, 0.5, 1]).factors!
    expect(f).toHaveLength(finishStroke(raw, null).points.length / 2)
    expect(f[0]).toBeLessThan(f[f.length - 1])
    expect(pressureFactor(0.5)).toBeCloseTo(1)
  })

  it('Catmull-Rom passes through every control point', () => {
    const pts = [0, 0, 10, 10, 20, 0, 30, 10]
    const segs = catmullRom(pts)
    expect(segs).toHaveLength(3)
    expect([segs[0].x0, segs[0].y0]).toEqual([0, 0])
    expect([segs[1].x0, segs[1].y0]).toEqual([10, 10])
    expect([segs[2].x, segs[2].y]).toEqual([30, 10])
  })
})

describe('drawn-mark geometry', () => {
  it('bounds pad by half the stroke width', () => {
    const b = drawBounds('ink', { width: 4, strokes: [[10, 10, 20, 30]] })
    expect(b).toEqual({ x1: 7.5, y1: 7.5, x2: 22.5, y2: 32.5 })
  })

  it('arrow bounds include the head', () => {
    const plain = drawBounds('line', { width: 1, line: [0, 0, 100, 0] })
    const arrow = drawBounds('arrow', { width: 1, line: [0, 0, 100, 0] })
    expect(arrow.y2).toBeGreaterThan(plain.y2)
  })

  it('translate moves strokes, line and box together', () => {
    const a = ink([[0, 0, 10, 10]])
    const t = translateDrawn(a, 5, -5)
    expect(t.draw!.strokes![0]).toEqual([5, -5, 15, 5])
    expect(t.quads[0].x1).toBeCloseTo(a.anchor.quads[0].x1 + 5)
  })

  it('strokeDist measures to the polyline', () => {
    expect(strokeDist(5, 3, [0, 0, 10, 0])).toBeCloseTo(3)
  })
})

describe('drawn marks in the sidecar', () => {
  it('round-trips ink geometry, colour and image through the anchor', () => {
    const a = ink([[1, 2, 3, 4, 5, 6]], { note: 'circled #key' })
    const text = upsertAnnotation('', a, pdfPath, meta)
    expect(text).toContain('## p.3 — 手绘')
    expect(text).toContain('](paper.annotations.assets/x.png)')
    const got = parse(text).annotations[0]
    expect(got.kind).toBe('ink')
    expect(got.color).toBe('#e53935')
    expect(got.anchor.draw?.strokes).toEqual([[1, 2, 3, 4, 5, 6]])
    expect(got.note).toBe('circled #key')
    expect(got.orphan).toBe(false)
  })

  it('a text box keeps its text as the section body', () => {
    const a: Annotation = {
      id: 'tb0001',
      anchor: { page: 1, quads: [{ x1: 10, y1: 10, x2: 110, y2: 40 }], pre: '', post: '', draw: { width: 0, fontSize: 14 } },
      excerpt: '', note: 'Remember this\nsecond line', color: '#1e63d6', kind: 'textbox', createdAt: '',
    }
    const text = upsertAnnotation('', a, pdfPath, meta)
    expect(text).toContain('Remember this\nsecond line')
    const got = parse(text).annotations[0]
    expect(got.note).toBe('Remember this\nsecond line')
    expect(got.anchor.draw?.fontSize).toBe(14)
  })

  it('an unknown future kind still parses, keeping its anchor payload', () => {
    // what an older SoloPDF sees when a newer one wrote a kind it lacks
    const text = [
      '# 《paper.pdf》批注',
      '<!-- solopdf:meta v1 name=paper.pdf -->',
      '',
      '## p.2 — 星形 <!-- solopdf:id zz0001 -->',
      'hi',
      '<!-- solopdf:anchor zz0001 {"page":2,"quads":[{"x1":1,"y1":2,"x2":3,"y2":4}],"pre":"","post":"","kind":"star","draw":{"width":1,"points":[1,2]}} -->',
      '',
    ].join('\n')
    const got = parse(text).annotations[0]
    expect(got.kind).toBe('star')
    expect(got.orphan).toBe(false)
    expect((got.anchor as any).draw.points).toEqual([1, 2])
    // and rewriting it (a note edit) keeps the unknown geometry verbatim
    const again = upsertAnnotation(text, { ...got, note: 'edited' }, pdfPath, meta)
    expect(again).toContain('"draw":{"width":1,"points":[1,2]}')
    expect(again).toContain('"kind":"star"')
  })
})

describe('export spec', () => {
  it('carries ink geometry and pressure to the exporter', () => {
    const a = ink([[0, 0, 10, 10]])
    a.anchor.draw!.pressure = [[0.5, 1.2]]
    const s = exportSpec(a)!
    expect(s.kind).toBe('ink')
    expect(s.strokes).toEqual([[0, 0, 10, 10]])
    expect(s.pressure).toEqual([[0.5, 1.2]])
    expect(s.width).toBe(2)
    expect(s.color[0]).toBeCloseTo(0xe5 / 255)
  })

  it('text boxes always export their text, other kinds obey includeNotes', () => {
    const tb: Annotation = {
      id: 'x', anchor: { page: 1, quads: [{ x1: 0, y1: 0, x2: 50, y2: 20 }], pre: '', post: '', draw: { width: 0, fontSize: 12 } },
      excerpt: '', note: 'hello', color: 'blue', kind: 'textbox', createdAt: '',
    }
    expect(exportSpec(tb, { includeNotes: false })!.contents).toBe('hello')
    expect(exportSpec(tb)!.font_size).toBe(12)
    const hl = ink([[0, 0, 1, 1]], { note: 'mine' })
    expect(exportSpec(hl, { includeNotes: false })!.contents).toBe('')
  })

  it('skips orphans and marks without a position', () => {
    expect(exportSpec(ink([[0, 0, 1, 1]], { orphan: true }))).toBeNull()
  })

  it('colours: names and hex', () => {
    expect(colorTriple('#ff0000')).toEqual([1, 0, 0])
    expect(colorTriple('yellow')[0]).toBe(1)
    expect(isDrawn('arrow')).toBe(true)
    expect(isDrawn('highlight')).toBe(false)
  })
})
