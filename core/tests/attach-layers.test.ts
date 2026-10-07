import { describe, it, expect } from 'vitest'
import { deflateSync, inflateSync } from 'node:zlib'
import {
  attachmentKind, safeAttachmentName, uniqueNames, humanSize, collectAttachments, annotationAttachments,
  type AttachDocLike,
} from '../src/attachments.js'
import {
  layerRows, setLayer, applyLayerStates, layerDiff, layerStates, findLockedOcgs, hasLayers, radioGroups,
  type OcConfigLike, type OcGroupLike,
} from '../src/layers.js'

describe('attachment names', () => {
  it('classifies by the last extension', () => {
    expect(attachmentKind('a.PDF')).toBe('pdf')
    expect(attachmentKind('b.epub')).toBe('book')
    expect(attachmentKind('c.jpeg')).toBe('image')
    expect(attachmentKind('report.pdf.exe')).toBe('risky')
    expect(attachmentKind('x.bat')).toBe('risky')
    expect(attachmentKind('page.html')).toBe('risky')
    expect(attachmentKind('data.csv')).toBe('other')
    expect(attachmentKind('README')).toBe('other')
  })
  it('strips directories and reserved characters', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('passwd')
    expect(safeAttachmentName('C:\\Users\\x\\evil.pdf')).toBe('evil.pdf')
    expect(safeAttachmentName('a<b>:c?.txt')).toBe('a_b__c_.txt')
    expect(safeAttachmentName('..hidden')).toBe('hidden')
    expect(safeAttachmentName('')).toBe('attachment')
    expect(safeAttachmentName(null)).toBe('attachment')
    expect(safeAttachmentName('CON.txt')).toBe('_CON.txt')
    expect(safeAttachmentName('x'.repeat(300) + '.pdf').length).toBeLessThanOrEqual(181)
    expect(safeAttachmentName('x'.repeat(300) + '.pdf').endsWith('.pdf')).toBe(true)
  })
  it('dedupes names case-insensitively', () => {
    expect(uniqueNames(['a.pdf', 'A.pdf', 'a.pdf', 'b'])).toEqual(['a.pdf', 'A (2).pdf', 'a (3).pdf', 'b'])
  })
  it('formats sizes', () => {
    expect(humanSize(12)).toBe('12 B')
    expect(humanSize(1536)).toBe('1.5 KB')
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('collectAttachments', () => {
  const bytes = (n: number) => new Uint8Array(n)
  const doc: AttachDocLike = {
    numPages: 3,
    getAttachments: async () => ({
      'z.csv': { filename: 'z.csv', content: bytes(10), description: 'zed' },
      'a.pdf': { filename: 'a.pdf', content: bytes(5) },
    }),
    getPage: async (n) => ({
      getAnnotations: async () => n === 2
        ? [{ subtype: 'Link' }, { subtype: 'FileAttachment', rect: [10, 20, 5, 40], file: { filename: '../x.pdf', content: bytes(7) } }]
        : [],
    }),
  }
  it('lists document-level (sorted) then annotation attachments with pages', async () => {
    const all = await collectAttachments(doc)
    expect(all.map((a) => a.info.name)).toEqual(['a.pdf', 'z.csv', 'x.pdf'])
    expect(all[1].info).toMatchObject({ size: 10, description: 'zed', source: 'document', page: null, kind: 'other' })
    expect(all[2].info).toMatchObject({ id: 'annot:2:0', source: 'annotation', page: 2, rect: [5, 20, 10, 40], kind: 'pdf', size: 7 })
  })
  it('can skip the page sweep', async () => {
    expect((await collectAttachments(doc, { annotations: false })).length).toBe(2)
  })
  it('ignores FileAttachment annotations without a file', () => {
    expect(annotationAttachments(1, [{ subtype: 'FileAttachment' }])).toEqual([])
  })
})

/** a stand-in for pdf.js OptionalContentConfig with its radio behaviour */
function fakeConfig(groups: Record<string, { name: string; on: boolean; rb?: number }>, order: unknown[] | null): OcConfigLike {
  const rbSets = new Map<number, Set<string>>()
  for (const [id, g] of Object.entries(groups)) {
    if (g.rb == null) continue
    if (!rbSets.has(g.rb)) rbSets.set(g.rb, new Set())
    rbSets.get(g.rb)!.add(id)
  }
  const map = new Map<string, OcGroupLike>()
  for (const [id, g] of Object.entries(groups)) {
    map.set(id, { name: g.name, visible: g.on, rbGroups: g.rb == null ? [] : [rbSets.get(g.rb)!] })
  }
  return {
    getOrder: () => (map.size ? order ?? [...map.keys()] : null),
    getGroup: (id) => map.get(id) ?? null,
    setVisibility(id, visible = true, preserveRB = true) {
      const g = map.get(id)
      if (!g) return
      if (preserveRB && visible) for (const s of g.rbGroups ?? []) for (const o of s) if (o !== id) map.get(o)!.visible = false
      g.visible = visible
    },
    [Symbol.iterator]: () => map.entries(),
  }
}

describe('layers', () => {
  const make = () => fakeConfig({
    '4R': { name: 'Base map', on: true },
    '5R': { name: 'Labels', on: true },
    '6R': { name: 'Day', on: true, rb: 1 },
    '7R': { name: 'Night', on: false, rb: 1 },
  }, ['4R', '5R', { name: 'Theme', order: ['6R', '7R'] }])

  it('flattens the order tree with headings and radio markers', () => {
    const rows = layerRows(make(), ['4R'])
    expect(rows).toEqual([
      { type: 'layer', id: '4R', name: 'Base map', visible: true, locked: true, radio: null, depth: 0 },
      { type: 'layer', id: '5R', name: 'Labels', visible: true, locked: false, radio: null, depth: 0 },
      { type: 'heading', name: 'Theme', depth: 0 },
      { type: 'layer', id: '6R', name: 'Day', visible: true, locked: false, radio: 0, depth: 1 },
      { type: 'layer', id: '7R', name: 'Night', visible: false, locked: false, radio: 0, depth: 1 },
    ])
    expect(radioGroups(make())).toEqual([['6R', '7R']])
  })
  it('no groups = no layers', () => {
    expect(hasLayers(fakeConfig({}, null))).toBe(false)
    expect(hasLayers(make())).toBe(true)
  })
  it('radio members are exclusive', () => {
    const c = make()
    const r = setLayer(c, '7R', true)
    expect(r).toEqual({ ok: true, changed: ['6R', '7R'] })
    expect(layerStates(c)).toMatchObject({ '6R': false, '7R': true })
  })
  it('locked layers never change', () => {
    const c = make()
    expect(setLayer(c, '4R', false, ['4R'])).toEqual({ ok: false, reason: 'locked' })
    expect(c.getGroup('4R')!.visible).toBe(true)
  })
  it('a locked radio sibling that is on blocks the switch', () => {
    const c = make()
    expect(setLayer(c, '7R', true, ['6R'])).toEqual({ ok: false, reason: 'radio-locked', by: '6R' })
    expect(layerStates(c)).toMatchObject({ '6R': true, '7R': false })
  })
  it('persists only the diff and re-applies it', () => {
    const c = make()
    const initial = layerStates(c)
    setLayer(c, '5R', false)
    setLayer(c, '7R', true)
    const diff = layerDiff(initial, layerStates(c))
    expect(diff).toEqual({ '5R': false, '6R': false, '7R': true })
    const fresh = make()
    applyLayerStates(fresh, { ...diff, '4R': false, '99R': true }, ['4R'])
    expect(layerStates(fresh)).toEqual({ '4R': true, '5R': false, '6R': false, '7R': true })
  })
})

describe('findLockedOcgs', () => {
  const enc = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))
  it('reads /Locked from plain objects (gen 0 and non-zero)', () => {
    const pdf = enc('1 0 obj\n<< /OCProperties << /D << /Locked [4 0 R 9 2 R] >> >> >>\nendobj\n')
    expect(findLockedOcgs(pdf).sort()).toEqual(['4R', '9R2'])
  })
  it('reads /Locked inside a compressed object stream', () => {
    const inner = Buffer.from('<< /D << /Order [] /Locked [12 0 R] >> >>', 'latin1')
    const z = deflateSync(inner)
    const pdf = Buffer.concat([
      Buffer.from(`5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, 'latin1'),
      z,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ])
    expect(findLockedOcgs(new Uint8Array(pdf))).toEqual([])
    expect(findLockedOcgs(new Uint8Array(pdf), (b) => new Uint8Array(inflateSync(b)))).toEqual(['12R'])
  })
  it('nothing locked → empty', () => {
    expect(findLockedOcgs(enc('%PDF-1.7\n1 0 obj << >> endobj'))).toEqual([])
  })
})
