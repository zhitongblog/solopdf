import { describe, it, expect } from 'vitest'
import {
  fromPdfjs, nearestSwatch, rgbHex, pdfDateToIso, textUnderQuads, mapPdfAnnot, pendingImports,
  importedRefs, buildImports, spliceImports, rawLineCoords, needsLineFix, fixLineDirections,
  importSummary, scanPdfAnnotations, type PdfAnnot, type TextItemLike, type ImportDocLike,
} from '../src/import.js'
import { parse, removeAnnotation } from '../src/sidecar.js'
import { matchOnPage, buildPageIndex } from '../src/anchor.js'
import { diffSidecar, applyEdit } from '../src/history.js'
import { catmullRom, segDist } from '../src/drawing.js'
import type { Annotation, SidecarMeta } from '../src/types.js'

const meta: SidecarMeta = { version: 1, pdfName: 'paper.pdf' }
const pdfPath = '/tmp/paper.pdf'

/** what pdf.js getAnnotations() hands over (typed arrays included) */
function pdfjsHighlight(over: Record<string, unknown> = {}) {
  return {
    id: '9R',
    subtype: 'Highlight',
    annotationFlags: 4,
    rect: [151.2, 647, 288, 660],
    color: new Uint8ClampedArray([255, 235, 59]),
    contentsObj: { str: 'Key idea\r\nworth quoting', dir: 'ltr' },
    titleObj: { str: 'Alice Chen', dir: 'ltr' },
    modificationDate: "D:20240301093000+08'00'",
    creationDate: null,
    borderStyle: { width: 1 },
    quadPoints: new Float32Array([151.2, 660, 288, 660, 151.2, 647, 288, 647]),
    ...over,
  }
}

/** Courier 12pt line: every char 7.2pt wide */
function courier(str: string, x: number, y: number, eol = true): TextItemLike {
  return { str, transform: [12, 0, 0, 12, x, y], width: str.length * 7.2, height: 12, hasEOL: eol }
}

const LINES = [
  courier('Reading is the art of noticing what the author did not say.', 72, 650),
  courier('The second highlight spans two lines of text so that', 72, 540),
  courier('the importer must join both quads into one excerpt.', 72, 518),
]
const box = (line: TextItemLike, phrase: string) => {
  const at = line.str.indexOf(phrase)
  const x = line.transform[4]
  const y = line.transform[5]
  return { x1: x + at * 7.2, x2: x + (at + phrase.length) * 7.2, y1: y - 3, y2: y + 10 }
}

function pa(over: Partial<PdfAnnot>): PdfAnnot {
  return {
    ref: '1R', page: 1, subtype: 'Highlight', rect: [0, 0, 10, 10], color: null,
    contents: '', author: '', date: null, width: 1, ...over,
  }
}

describe('fromPdfjs', () => {
  it('normalizes pdf.js data into plain JSON', () => {
    const a = fromPdfjs(pdfjsHighlight(), 1)!
    expect(a).toMatchObject({
      ref: '9R', page: 1, subtype: 'Highlight', color: [255, 235, 59],
      contents: 'Key idea\nworth quoting', author: 'Alice Chen', date: '2024-03-01T01:30:00.000Z',
    })
    expect(a.quads).toEqual([{ x1: 151.2, y1: 647, x2: 288, y2: 660 }])
    expect(JSON.parse(JSON.stringify(a))).toEqual(a) // no typed arrays left
  })

  it('skips links, widgets, popups, stamps and hidden annotations', () => {
    for (const subtype of ['Link', 'Widget', 'Popup', 'Stamp', 'Caret']) {
      expect(fromPdfjs(pdfjsHighlight({ subtype }), 1)).toBeNull()
    }
    expect(fromPdfjs(pdfjsHighlight({ annotationFlags: 6 }), 1)).toBeNull() // Hidden
    expect(fromPdfjs(pdfjsHighlight({ annotationFlags: 0x20 }), 1)).toBeNull() // NoView
  })

  it('keeps reply linkage and FreeText appearance data', () => {
    const r = fromPdfjs({ ...pdfjsHighlight(), subtype: 'Text', id: '17R', inReplyTo: '16R', replyType: 'R' }, 1)!
    expect(r.inReplyTo).toBe('16R')
    const ft = fromPdfjs({
      ...pdfjsHighlight(), subtype: 'FreeText', quadPoints: undefined,
      defaultAppearanceData: { fontSize: 14, fontColor: new Uint8ClampedArray([217, 26, 26]) },
    }, 1)!
    expect(ft.fontSize).toBe(14)
    expect(ft.fontColor).toEqual([217, 26, 26])
  })
})

describe('colours and dates', () => {
  it('maps any colour to the nearest swatch by hue', () => {
    expect(nearestSwatch([255, 255, 0])).toBe('yellow')
    expect(nearestSwatch([255, 165, 0])).toBe('yellow') // orange
    expect(nearestSwatch([0, 255, 0])).toBe('green')
    expect(nearestSwatch([125, 219, 99])).toBe('green')
    expect(nearestSwatch([0, 0, 255])).toBe('blue')
    expect(nearestSwatch([0, 200, 255])).toBe('blue') // cyan
    expect(nearestSwatch([255, 0, 0])).toBe('pink') // Acrobat's red strike-out
    expect(nearestSwatch([255, 105, 180])).toBe('pink')
    expect(nearestSwatch([153, 51, 204])).toBe('pink') // purple
    expect(nearestSwatch([0, 0, 0])).toBe('yellow') // no hue → default
    expect(nearestSwatch([128, 128, 128])).toBe('yellow')
    expect(nearestSwatch(null)).toBe('yellow')
  })

  it('hex for kinds that take any colour', () => {
    expect(rgbHex([230, 26, 26])).toBe('#e61a1a')
    expect(rgbHex(null)).toBe('#1f1f1f')
  })

  it('parses PDF date strings', () => {
    expect(pdfDateToIso("D:20240301093000+08'00'")).toBe('2024-03-01T01:30:00.000Z')
    expect(pdfDateToIso('D:20240301093000Z')).toBe('2024-03-01T09:30:00.000Z')
    expect(pdfDateToIso('D:2024')).toBe('2024-01-01T00:00:00.000Z')
    expect(pdfDateToIso('yesterday')).toBeNull()
    expect(pdfDateToIso(null)).toBeNull()
  })
})

describe('textUnderQuads', () => {
  it('finds the excerpt and a fingerprint the resolver matches', () => {
    const t = textUnderQuads(LINES, [box(LINES[0], 'the art of noticing')])!
    expect(t.text).toBe('the art of noticing')
    expect(t.pre.endsWith('Reading is ')).toBe(true)
    expect(t.post.startsWith(' what the author')).toBe(true)
    const idx = buildPageIndex(LINES.map((l) => l.str))
    expect(matchOnPage({ page: 1, quads: [], ...t }, idx).kind).toBe('exact')
  })

  it('joins a two-line highlight with a space (Latin)', () => {
    const t = textUnderQuads(LINES, [
      { ...box(LINES[1], 'spans two lines of text so that') },
      { ...box(LINES[2], 'the importer must join both quads') },
    ])!
    expect(t.text).toBe('spans two lines of text so that the importer must join both quads')
    const idx = buildPageIndex(LINES.map((l) => l.str))
    expect(matchOnPage({ page: 1, quads: [], ...t }, idx).kind).toBe('exact')
  })

  it('joins CJK lines without a space', () => {
    const items: TextItemLike[] = [
      { str: '汉字是记录', transform: [16, 0, 0, 16, 72, 660], width: 80, height: 16, hasEOL: true },
      { str: '汉语的文字', transform: [16, 0, 0, 16, 72, 640], width: 80, height: 16, hasEOL: true },
    ]
    const t = textUnderQuads(items, [
      { x1: 120, x2: 152, y1: 656, y2: 674 },
      { x1: 72, x2: 104, y1: 636, y2: 654 },
    ])!
    expect(t.text).toBe('记录汉语')
  })

  it('returns null where there is no text (scans, figures)', () => {
    expect(textUnderQuads(LINES, [{ x1: 400, x2: 500, y1: 100, y2: 120 }])).toBeNull()
    expect(textUnderQuads([], [{ x1: 0, x2: 1, y1: 0, y2: 1 }])).toBeNull()
  })
})

describe('mapPdfAnnot', () => {
  it('text marks: swatch colour, excerpt, fingerprint, source', () => {
    const p = fromPdfjs(pdfjsHighlight({ rect: [151.2, 647, 288, 660] }), 1)!
    p.quads = [box(LINES[0], 'the art of noticing')]
    const m = mapPdfAnnot(p, [], LINES)!
    expect(m.kind).toBe('highlight')
    expect(m.color).toBe('yellow')
    expect(m.excerpt).toBe('the art of noticing')
    expect(m.note).toBe('Key idea\nworth quoting')
    expect(m.anchor.text).toBe('the art of noticing')
    expect(m.anchor.src).toEqual({ ref: '9R', type: 'Highlight', author: 'Alice Chen', date: '2024-03-01T01:30:00.000Z' })
  })

  it('maps every supported subtype to its kind', () => {
    const kinds: Record<string, string> = {
      Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strike', Squiggly: 'squiggly',
      Text: 'note', FreeText: 'textbox', Square: 'rect', Circle: 'ellipse', Line: 'line',
    }
    for (const [subtype, kind] of Object.entries(kinds)) {
      const m = mapPdfAnnot(pa({ subtype, rect: [100, 100, 200, 150], line: [100, 100, 200, 150] }))
      expect(m?.kind, subtype).toBe(kind)
    }
    expect(mapPdfAnnot(pa({ subtype: 'Ink', strokes: [[0, 0, 10, 10, 20, 0]] }))?.kind).toBe('ink')
    expect(mapPdfAnnot(pa({ subtype: 'Stamp' }))).toBeNull()
  })

  it('folds replies into the note as a thread', () => {
    const m = mapPdfAnnot(
      pa({ subtype: 'Text', ref: '16R', contents: 'Check chapter 3.', rect: [500, 630, 520, 650] }),
      [pa({ subtype: 'Text', ref: '17R', author: 'Bob Li', contents: 'Agreed.' })],
    )!
    expect(m.note).toBe('Check chapter 3.\n\n— Bob Li: Agreed.')
    expect(m.anchor.src?.replies).toEqual(['17R'])
    // pin on the icon's centre
    expect(m.anchor.quads[0]).toMatchObject({ x1: 510, y1: 640 })
  })

  it('arrow at the START is turned around so the head is at the end', () => {
    const m = mapPdfAnnot(pa({ subtype: 'Line', line: [100, 400, 300, 300], lineEndings: ['OpenArrow', 'None'], width: 2 }))!
    expect(m.kind).toBe('arrow')
    expect(m.anchor.draw?.line).toEqual([300, 300, 100, 400])
    const plain = mapPdfAnnot(pa({ subtype: 'Line', line: [100, 400, 300, 300], lineEndings: ['None', 'ClosedArrow'] }))!
    expect(plain.anchor.draw?.line).toEqual([100, 400, 300, 300])
  })

  it('shapes: hex colour, border inset, text box font', () => {
    const r = mapPdfAnnot(pa({ subtype: 'Square', rect: [80, 440, 260, 560], width: 2, color: [0, 102, 255] }))!
    expect(r.color).toBe('#0066ff')
    expect(r.anchor.quads[0]).toEqual({ x1: 81, y1: 441, x2: 259, y2: 559 })
    expect(r.anchor.draw?.width).toBe(2)
    const t = mapPdfAnnot(pa({ subtype: 'FreeText', contents: 'Hi', fontSize: 14, fontColor: [217, 26, 26] }))!
    expect(t.note).toBe('Hi')
    expect(t.color).toBe('#d91a1a')
    expect(t.anchor.draw?.fontSize).toBe(14)
  })

  it('polygons keep straight edges and close', () => {
    const m = mapPdfAnnot(pa({ subtype: 'Polygon', strokes: [[100, 180, 250, 180, 175, 280]] }))!
    expect(m.kind).toBe('ink')
    const s = m.anchor.draw!.strokes![0]
    // closed: starts and ends on the first vertex
    expect(s.slice(0, 2)).toEqual([100, 180])
    expect(s.slice(-2)).toEqual([100, 180])
    // corners are guarded by points 0.5, 1, 2 … pt along each edge
    expect(s.slice(2, 8)).toEqual([100.5, 180, 101, 180, 102, 180])
    // the spline never strays more than ~half a point off the outline
    const edges: [number, number, number, number][] = [[100, 180, 250, 180], [250, 180, 175, 280], [175, 280, 100, 180]]
    const off = (x: number, y: number) => Math.min(...edges.map(([ax, ay, bx, by]) => segDist(x, y, ax, ay, bx, by)))
    let worst = 0
    for (const b of catmullRom(s)) {
      for (let t = 0; t <= 1; t += 0.25) {
        const u = 1 - t
        const x = u * u * u * b.x0 + 3 * u * u * t * b.c1x + 3 * u * t * t * b.c2x + t * t * t * b.x
        const y = u * u * u * b.y0 + 3 * u * u * t * b.c1y + 3 * u * t * t * b.c2y + t * t * t * b.y
        worst = Math.max(worst, off(x, y))
      }
    }
    expect(worst).toBeLessThan(0.6)
  })
})

describe('dedupe', () => {
  const pdf = [
    pa({ ref: '9R', subtype: 'Highlight', quads: [box(LINES[0], 'the art of noticing')] }),
    pa({ ref: '16R', subtype: 'Text', contents: 'note' }),
    pa({ ref: '17R', subtype: 'Text', contents: 'reply', inReplyTo: '16R', replyType: 'R' }),
  ]
  const doc: ImportDocLike = {
    numPages: 1,
    getPage: async () => ({
      getAnnotations: async () => [],
      getTextContent: async () => ({ items: LINES }),
    }),
  }
  let n = 0
  const gen = () => `imp${n++}`

  it('replies are never offered on their own', () => {
    expect(pendingImports(pdf, []).map((p) => p.ref)).toEqual(['9R', '16R'])
  })

  it('re-import after a write finds nothing new', async () => {
    const first = await buildImports(doc, pdf, [], gen)
    expect(first.annotations).toHaveLength(2)
    const text = spliceImports('', first.annotations, pdfPath, meta)
    const back = parse(text).annotations
    // the source survives the Markdown round-trip …
    expect(back.map((a) => a.anchor.src?.ref).sort()).toEqual(['16R', '9R'])
    // … so a second run is a no-op
    expect(pendingImports(pdf, back)).toEqual([])
    const again = await buildImports(doc, pdf, back, gen)
    expect(again.annotations).toEqual([])
    // and the summary says so
    expect(importSummary(pdf, [], back)).toMatchObject({ found: 2, replies: 1, alreadyImported: 2, imported: 0 })
  })

  it('a ref reused by a different subtype is not a duplicate', () => {
    const existing = [{ id: 'x', anchor: { page: 1, quads: [], pre: '', post: '', src: { ref: '9R', type: 'Underline' } }, excerpt: '', note: '', color: 'yellow', createdAt: '' }] as Annotation[]
    expect(pendingImports(pdf, existing).map((p) => p.ref)).toContain('9R')
  })

  it('deleting an imported mark hands it back to the PDF', async () => {
    const { annotations } = await buildImports(doc, pdf, [], gen)
    const text = spliceImports('', annotations, pdfPath, meta)
    const hl = annotations.find((a) => a.anchor.src?.ref === '9R')!
    const after = parse(removeAnnotation(text, hl.id)).annotations
    expect(pendingImports(pdf, after).map((p) => p.ref)).toEqual(['9R'])
    expect([...importedRefs(after).keys()].sort()).toEqual(['16R', '17R'])
  })

  it('the whole import is ONE undo step', async () => {
    const before = '# 《paper.pdf》批注\n<!-- solopdf:meta v1 name=paper.pdf -->\n'
    const { annotations } = await buildImports(doc, pdf, [], gen)
    const after = spliceImports(before, annotations, pdfPath, meta)
    const edit = diffSidecar(before, after)!
    expect(edit.changes).toHaveLength(2)
    expect(applyEdit(after, edit, 'undo')).toBe(before)
    expect(applyEdit(before, edit, 'redo')).toBe(after)
  })
})

describe('scanPdfAnnotations', () => {
  it('collects importable annots and reports unsupported markup only', async () => {
    const doc: ImportDocLike = {
      numPages: 2,
      getPage: async (p) => ({
        getAnnotations: async () => p === 1
          ? [pdfjsHighlight(), { id: '3R', subtype: 'Link', rect: [0, 0, 1, 1] }, { id: '4R', subtype: 'Stamp', rect: [0, 0, 1, 1] }]
          : [{ id: '5R', subtype: 'Popup', rect: [0, 0, 1, 1] }, { id: '6R', subtype: 'Widget', rect: [0, 0, 1, 1] }],
        getTextContent: async () => ({ items: [] }),
      }),
    }
    const unsupported: { page: number; subtype: string; ref: string }[] = []
    const got = await scanPdfAnnotations(doc, [1, 2], unsupported)
    expect(got.map((a) => a.ref)).toEqual(['9R'])
    expect(unsupported).toEqual([{ page: 1, subtype: 'Stamp', ref: '4R' }])
  })
})

describe('raw /L direction', () => {
  const pdfText =
    '%PDF-1.7\n24 0 obj\n<< /Type /Annot /Subtype /Line /L [100 400 300 300] /LE [/None /OpenArrow] >>\nendobj\n' +
    '124 0 obj\n<< /Subtype /Line /L [1 2 3 4] >>\nendobj\n'
  const bytes = new TextEncoder().encode(pdfText)

  it('reads the unnormalized coordinates of the right object', () => {
    expect(rawLineCoords(bytes, '24R')).toEqual([100, 400, 300, 300])
    expect(rawLineCoords(bytes, '124R')).toEqual([1, 2, 3, 4])
    expect(rawLineCoords(bytes, '99R')).toBeNull()
  })

  it('an incremental update (later definition) wins', () => {
    const upd = new TextEncoder().encode(pdfText + '24 0 obj\n<< /Subtype /Line /L [5 6 7 8] >>\nendobj\n')
    expect(rawLineCoords(upd, '24R')).toEqual([5, 6, 7, 8])
  })

  it('puts the direction back on scanned lines', () => {
    // what pdf.js reports after normalizeRect: "/" instead of "\"
    const pdf = [pa({ ref: '24R', subtype: 'Line', line: [100, 300, 300, 400], lineEndings: ['None', 'OpenArrow'] })]
    expect(needsLineFix(pdf)).toBe(true)
    fixLineDirections(pdf, bytes)
    expect(pdf[0].line).toEqual([100, 400, 300, 300])
    expect(needsLineFix([pa({ subtype: 'Line', line: [0, 0, 100, 0], lineEndings: ['None', 'None'] })])).toBe(false)
  })
})
