import { describe, it, expect } from 'vitest'
import {
  destFromExplicit, resolveDestination, linkTargetOf, pageLinks, safeExternalUrl, annotRect,
  type DocLike,
} from '../src/links.js'

const ref = (num: number) => ({ num, gen: 0 })

/** a fake pdf.js document: page refs are {num}, page index = num - 10 */
function fakeDoc(annots: unknown[] = [], named: Record<string, unknown[]> = {}): DocLike {
  return {
    numPages: 50,
    getDestination: async (id) => named[id] ?? null,
    getPageIndex: async (r) => (r as { num: number }).num - 10,
    getPage: async () => ({ getAnnotations: async () => annots }),
  }
}

describe('destFromExplicit', () => {
  it('XYZ keeps left/top/zoom', () => {
    expect(destFromExplicit([ref(1), { name: 'XYZ' }, 72, 700, 0], 3))
      .toEqual({ page: 3, fit: 'XYZ', x: 72, y: 700, zoom: 0 })
  })
  it('XYZ with null operands = unspecified', () => {
    const d = destFromExplicit([ref(1), { name: 'XYZ' }, null, null, null], 2)
    expect(d.x).toBeNull()
    expect(d.y).toBeNull()
  })
  it('FitH carries only top, FitV only left', () => {
    expect(destFromExplicit([ref(1), { name: 'FitH' }, 500], 1)).toMatchObject({ x: null, y: 500 })
    expect(destFromExplicit([ref(1), { name: 'FitBV' }, 40], 1)).toMatchObject({ x: 40, y: null })
  })
  it('FitR normalizes the rect and aims at its top-left', () => {
    const d = destFromExplicit([ref(1), 'FitR', 300, 600, 100, 400], 5)
    expect(d.rect).toEqual([100, 400, 300, 600])
    expect(d).toMatchObject({ x: 100, y: 600 })
  })
  it('Fit has no coordinates', () => {
    expect(destFromExplicit([ref(1), { name: 'Fit' }], 9)).toMatchObject({ page: 9, x: null, y: null })
  })
})

describe('resolveDestination', () => {
  it('resolves named destinations through the doc', async () => {
    const doc = fakeDoc([], { 'sec.7': [ref(17), { name: 'XYZ' }, 0, 512, null] })
    expect(await resolveDestination(doc, 'sec.7')).toMatchObject({ page: 8, y: 512 })
  })
  it('accepts a bare 0-based page index as the first element', async () => {
    expect(await resolveDestination(fakeDoc(), [4, { name: 'Fit' }])).toMatchObject({ page: 5 })
  })
  it('null for unknown names, out-of-range pages, garbage', async () => {
    const doc = fakeDoc()
    expect(await resolveDestination(doc, 'nope')).toBeNull()
    expect(await resolveDestination(doc, [999, { name: 'Fit' }])).toBeNull()
    expect(await resolveDestination(doc, 42)).toBeNull()
  })
})

describe('link targets', () => {
  it('only safe schemes leave the app', () => {
    expect(safeExternalUrl('https://a.b/c')).toBe('https://a.b/c')
    expect(safeExternalUrl('mailto:x@y.z')).toBe('mailto:x@y.z')
    expect(safeExternalUrl('www.adobe.com')).toBe('https://www.adobe.com')
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('file:///etc/passwd')).toBeNull()
  })
  it('classifies internal / external / named / other', () => {
    expect(linkTargetOf({ subtype: 'Link', dest: 'x' })).toEqual({ kind: 'internal', dest: 'x' })
    expect(linkTargetOf({ subtype: 'Link', url: 'http://e.com' })).toEqual({ kind: 'external', url: 'http://e.com' })
    expect(linkTargetOf({ subtype: 'Link', unsafeUrl: 'https://e.com' })).toEqual({ kind: 'external', url: 'https://e.com' })
    expect(linkTargetOf({ subtype: 'Link', action: 'NextPage' })).toEqual({ kind: 'named', action: 'NextPage' })
    expect(linkTargetOf({ subtype: 'Widget', dest: 'x' })).toBeNull()
    expect(linkTargetOf({ subtype: 'Link', unsafeUrl: 'javascript:x' })).toBeNull()
  })
  it('rects are normalized, degenerate ones dropped', () => {
    expect(annotRect({ rect: [200, 700, 100, 680] })).toEqual([100, 680, 200, 700])
    expect(annotRect({ rect: [1, 1, 1, 1] })).toBeNull()
  })
  it('pageLinks resolves everything on a page', async () => {
    const doc = fakeDoc([
      { subtype: 'Link', rect: [10, 10, 60, 22], dest: [ref(12), { name: 'XYZ' }, 0, 300, 0] },
      { subtype: 'Link', rect: [10, 30, 60, 42], url: 'https://www.iso.org' },
      { subtype: 'Link', rect: [10, 50, 60, 62], action: 'PrevPage' },
      { subtype: 'Link', rect: [10, 70, 60, 82], dest: 'missing' },
      { subtype: 'Text', rect: [0, 0, 10, 10] },
    ])
    const links = await pageLinks(doc, 7)
    expect(links).toHaveLength(3)
    expect(links[0]).toMatchObject({ page: 7, target: { kind: 'internal', dest: { page: 3, y: 300 } } })
    expect(links[1].target).toEqual({ kind: 'external', url: 'https://www.iso.org' })
    expect(links[2].target).toMatchObject({ kind: 'internal', dest: { page: 6 } })
  })
})
