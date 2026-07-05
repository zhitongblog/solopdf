import { describe, it, expect } from 'vitest'
import { buildPageIndex, matchOnPage, makeFingerprint, normalize } from '../src/anchor.js'
import type { AnchorData } from '../src/types.js'

function anchor(partial: Partial<AnchorData>): AnchorData {
  return { page: 1, quads: [{ x1: 0, y1: 0, x2: 1, y2: 1 }], pre: '', post: '', ...partial }
}

// simulated pdf.js text items (Chinese + latin mix, split mid-sentence like real PDFs)
const ITEMS = ['汉字是现今世界上', '唯一仍廣泛使用的意音文字', '，也是历史最悠久的', '文字之一。', 'The quick brown ', 'fox jumps.']

describe('anchor fingerprint matching', () => {
  const idx = buildPageIndex(ITEMS)

  it('exact hit with pre/post context', () => {
    const a = anchor({ text: '唯一仍廣泛使用', pre: '现今世界上', post: '的意音文字' })
    const m = matchOnPage(a, idx)
    expect(m.kind).toBe('exact')
    if (m.kind === 'exact') {
      expect(idx.text.slice(m.startChar, m.endChar)).toBe('唯一仍廣泛使用')
      // spans into item 1
      expect(m.itemRange[0]).toBe(1)
    }
  })

  it('whitespace differences do not break matching (normalize)', () => {
    const a = anchor({ text: 'The quick  brown fox', pre: '文字之一。', post: 'jumps' })
    const m = matchOnPage(a, idx)
    expect(m.kind).toBe('exact')
  })

  it('ambiguous text resolved by context score', () => {
    const items = ['甲说：好。', '乙说：好。', '丙说：好。']
    const i2 = buildPageIndex(items)
    const a = anchor({ text: '好', pre: '乙说：', post: '。丙' })
    const m = matchOnPage(a, i2)
    expect(m.kind).toBe('exact')
    if (m.kind === 'exact') {
      // second 好 = index of '乙说：好' occurrence
      expect(i2.text.slice(0, m.startChar)).toContain('乙')
    }
  })

  it('miss on page where text no longer exists', () => {
    const a = anchor({ text: '这段话根本不存在', pre: 'x', post: 'y' })
    expect(matchOnPage(a, idx).kind).toBe('miss')
  })

  it('privacy-stripped anchor falls back to quads-only', () => {
    const a = anchor({ text: undefined, pre: '', post: '' })
    expect(matchOnPage(a, idx).kind).toBe('quads-only')
  })

  it('privacy-stripped anchor with no quads is a miss', () => {
    const a = anchor({ text: undefined, quads: [] })
    expect(matchOnPage(a, idx).kind).toBe('miss')
  })

  it('fingerprint windows clamp to 32 chars', () => {
    const fp = makeFingerprint('x'.repeat(100), 't', 'y'.repeat(100))
    expect(fp.pre.length).toBe(32)
    expect(fp.post.length).toBe(32)
  })

  it('normalize strips all whitespace forms', () => {
    expect(normalize('a b\tc\nd e')).toBe('abcde')
  })

  it('normalize folds Kangxi Radicals to unified ideographs (Skia PDF quirk)', () => {
    // verbatim from a Chrome-exported PDF: ⼜/⽂ are Kangxi-Radical codepoints
    expect(normalize('⼜稱漢⽂')).toBe('又稱漢文')
    // user query in normal ideographs matches radical-polluted document text
    const items = ['汉字是现今世界上唯一仍廣泛使用的意⾳⽂字']
    const idx = buildPageIndex(items)
    const a = anchor({ text: '意音文字', pre: '使用的', post: '' })
    expect(matchOnPage(a, idx).kind).toBe('exact')
  })

  it('normalize folds fullwidth ASCII', () => {
    expect(normalize('ＰＤＦ ｒｅａｄｅｒ')).toBe('PDFreader')
  })

  it('empty page index does not crash', () => {
    const i0 = buildPageIndex([])
    const a = anchor({ text: '任意' })
    expect(matchOnPage(a, i0).kind).toBe('miss')
  })
})
