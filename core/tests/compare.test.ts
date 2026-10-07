import { describe, it, expect } from 'vitest'
import {
  tokenizePage, alignPages, diffSequences, compareDocuments, mapComparedPage,
  type ComparePage,
} from '../src/compare.js'

/** a page from lines of text (one pdf.js item per line, EOL after each) */
const page = (...lines: string[]): ComparePage => lines.map((str) => ({ str, hasEOL: true }))

const LOREM = [
  'This Service Agreement is made between the Provider and the Client.',
  'The Provider shall deliver the services described in Schedule A.',
  'All deliverables remain the property of the Provider until paid in full.',
  'Either party may terminate this agreement with written notice.',
]

describe('tokenizePage', () => {
  it('splits words, keeps punctuation as tokens, drops whitespace', () => {
    const t = tokenizePage(page('Pay within thirty (30) days.'), 1)
    expect(t.map((x) => x.text)).toEqual(['Pay', 'within', 'thirty', '(', '30', ')', 'days', '.'])
    expect(t[0].space).toBe(true)
    expect(t[3].space).toBe(true)
    expect(t[4].space).toBe(false)
  })
  it('keeps joiners inside words and numbers', () => {
    const t = tokenizePage(page("don't e-mail 1,000.50 now."), 1)
    expect(t.map((x) => x.text)).toEqual(["don't", 'e-mail', '1,000.50', 'now', '.'])
  })
  it('tokenizes CJK one character at a time, Latin runs as words', () => {
    const t = tokenizePage(page('双方应对本协议保密，SoloPDF 版本2'), 1)
    expect(t.map((x) => x.text)).toEqual(['双', '方', '应', '对', '本', '协', '议', '保', '密', '，', 'SoloPDF', '版', '本', '2'])
  })
  it('records item/offset spans, including tokens straddling two items', () => {
    const t = tokenizePage([{ str: 'Agree' }, { str: 'ment is', hasEOL: true }], 3)
    expect(t[0].text).toBe('Agreement')
    expect(t[0].segs).toEqual([[0, 0, 5], [1, 0, 4]])
    expect(t[1].segs).toEqual([[1, 5, 7]])
    expect(t[0].page).toBe(3)
  })
  it('compares NFKC keys (full-width digits = ASCII digits)', () => {
    const [a] = tokenizePage(page('１２３'), 1)
    expect(a.key).toBe('123')
  })
  it('handles astral characters without splitting surrogate pairs', () => {
    const t = tokenizePage(page('𠀀字'), 1)
    expect(t.map((x) => x.text)).toEqual(['𠀀', '字'])
    expect(t[1].segs).toEqual([[0, 2, 3]])
  })
})

describe('diffSequences', () => {
  const ops = (a: number[], b: number[]) => diffSequences(a, b)!.join('')
  it('finds the minimal script', () => {
    expect(ops([1, 2, 3], [1, 2, 3])).toBe('000')
    expect(ops([1, 2, 3], [1, 3])).toBe('010')
    expect(ops([1, 3], [1, 2, 3])).toBe('020')
    expect(ops([], [1])).toBe('2')
    expect(ops([1], [])).toBe('1')
    // replace = delete + insert
    expect(ops([1, 2, 3], [1, 9, 3]).replace(/[12]/g, 'x')).toBe('0xx0')
  })
  it('produces a script that rebuilds b from a', () => {
    const a = [5, 1, 2, 3, 4, 9, 9, 7, 1]
    const b = [1, 2, 8, 4, 9, 7, 1, 1, 6]
    const script = diffSequences(a, b)!
    const out: number[] = []
    let x = 0
    let y = 0
    for (const o of script) {
      if (o === 0) { expect(a[x]).toBe(b[y]); out.push(a[x]); x++; y++ }
      else if (o === 1) x++
      else { out.push(b[y]); y++ }
    }
    expect(out).toEqual(b)
    expect(x).toBe(a.length)
  })
  it('gives up (null) beyond the edit budget', () => {
    const a = Array.from({ length: 200 }, (_, i) => i)
    const b = Array.from({ length: 200 }, (_, i) => i + 1000)
    expect(diffSequences(a, b, 10)).toBeNull()
    expect(diffSequences(a, b, 1000)).not.toBeNull()
  })
})

describe('alignPages', () => {
  const toks = (pages: ComparePage[]) => pages.map((p, i) => tokenizePage(p, i + 1))
  const p1 = page('Chapter one about apples and pears in the orchard.', 'More apples grow in autumn every year.')
  const p2 = page('Chapter two covers bridges and rivers of the north.', 'Rivers flood the bridges each spring.')
  const p3 = page('Chapter three explains taxes, invoices and receipts.', 'Receipts must be kept for seven years.')
  const ins = page('A brand new appendix on data protection obligations.', 'Personal data is processed lawfully.')

  it('pairs identical documents page for page', () => {
    const pairs = alignPages(toks([p1, p2, p3]), toks([p1, p2, p3]))
    expect(pairs.map((p) => [p.a, p.b])).toEqual([[1, 1], [2, 2], [3, 3]])
    expect(pairs[0].similarity).toBe(1)
  })
  it('detects an inserted page instead of shifting everything after it', () => {
    const pairs = alignPages(toks([p1, p2, p3]), toks([p1, ins, p2, p3]))
    expect(pairs.map((p) => [p.a, p.b])).toEqual([[1, 1], [null, 2], [2, 3], [3, 4]])
  })
  it('detects a removed page', () => {
    const pairs = alignPages(toks([p1, p2, p3]), toks([p1, p3]))
    expect(pairs.map((p) => [p.a, p.b])).toEqual([[1, 1], [2, null], [3, 2]])
  })
  it('pairs text-less (scanned) pages by position', () => {
    const pairs = alignPages(toks([p1, [], p3]), toks([p1, [], p3]))
    expect(pairs.map((p) => [p.a, p.b])).toEqual([[1, 1], [2, 2], [3, 3]])
  })
})

describe('compareDocuments', () => {
  it('reports nothing for identical documents', () => {
    const r = compareDocuments([page(...LOREM)], [page(...LOREM)])
    expect(r.changes).toEqual([])
    expect(r.pairs).toEqual([{ a: 1, b: 1, similarity: 1 }])
  })

  it('ignores whitespace and line-wrap differences', () => {
    const a = [page('The Provider shall deliver', 'the services.')]
    const b = [page('The  Provider shall', 'deliver the services.')]
    expect(compareDocuments(a, b).changes).toEqual([])
  })

  it('reports a changed phrase as ONE change with spans on both sides', () => {
    const a = [page(LOREM[0], 'The Client shall pay within thirty (30) days of receipt.', LOREM[1])]
    const b = [page(LOREM[0], 'The Client shall pay within fifteen (15) days of receipt.', LOREM[1])]
    const r = compareDocuments(a, b)
    expect(r.changes).toHaveLength(1)
    const c = r.changes[0]
    expect(c.kind).toBe('change')
    expect(c.a.text).toBe('thirty (30')
    expect(c.b.text).toBe('fifteen (15')
    expect(c.a.page).toBe(1)
    // item 1 is the second line; "thirty (30" starts at its offset 28
    const line = 'The Client shall pay within thirty (30) days of receipt.'
    expect(c.a.spans).toEqual([{ page: 1, item: 1, from: line.indexOf('thirty'), to: line.indexOf('30') + 2 }])
    expect(r.stats).toMatchObject({ changed: 1, inserted: 0, deleted: 0 })
  })

  it('reports a deleted paragraph with a caret on the new side', () => {
    const para = 'Late payments accrue interest at one percent per month.'
    const a = [page(LOREM[0], para, LOREM[1])]
    const b = [page(LOREM[0], LOREM[1])]
    const r = compareDocuments(a, b)
    expect(r.changes).toHaveLength(1)
    const c = r.changes[0]
    expect(c.kind).toBe('delete')
    expect(c.a.text).toBe(para)
    expect(c.b.text).toBe('')
    // caret right after "Client." on the new side: item 0, end of line
    expect(c.b.at).toEqual({ page: 1, item: 0, from: LOREM[0].length, to: LOREM[0].length })
  })

  it('diffs Chinese at character level', () => {
    const a = [page('双方应对本协议内容保密，未经对方书面同意不得向第三方披露。')]
    const b = [page('双方应对本协议内容严格保密，未经对方书面同意不得向任何第三方披露。')]
    const r = compareDocuments(a, b)
    expect(r.changes.map((c) => [c.kind, c.b.text])).toEqual([['insert', '严格'], ['insert', '任何']])
    expect(r.changes[0].b.spans).toEqual([{ page: 1, item: 0, from: 9, to: 11 }])
  })

  it('reports an inserted page as a page-level change and keeps later pages paired', () => {
    const p1 = page(...LOREM)
    const p2 = page('Section 2 covers payment terms and invoices.', 'Invoices are issued monthly in arrears.')
    const newPage = page('Section 3 Data Protection.', 'The Provider processes personal data only on instructions.')
    const r = compareDocuments([p1, p2], [p1, newPage, p2])
    expect(r.pairs.map((p) => [p.a, p.b])).toEqual([[1, 1], [null, 2], [2, 3]])
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0]).toMatchObject({ kind: 'insert', pageInserted: 2, a: { page: 1 }, b: { page: 2 } })
    expect(r.changes[0].b.text).toContain('Data Protection')
    expect(r.stats.insertedPages).toBe(1)
  })

  it('treats text that reflowed onto the next page as unchanged', () => {
    const a = [page('one two three four five six'), page('seven eight nine ten eleven twelve')]
    const b = [page('one two three four'), page('five six seven eight nine ten eleven twelve')]
    expect(compareDocuments(a, b).changes).toEqual([])
  })

  it('ignores printed page numbers that shift after an inserted page', () => {
    const body = (s: string) => page(s + ' clause text that is long enough to align.', 'More words follow here.')
    const a = [[...body('one'), { str: '1' }], [...body('two'), { str: '2' }]]
    const b = [[...body('one'), { str: '1' }], [...page('Inserted schedule with brand new content.'), { str: '2' }], [...body('two'), { str: '3' }]]
    const r = compareDocuments(a, b)
    expect(r.changes.map((c) => c.pageInserted)).toEqual([2])
  })

  it('keeps a section number that opens a page (only lone folios are dropped)', () => {
    const a = [page('Intro text long enough to align the two pages together.'), page('2  Payment terms apply to every invoice issued.')]
    const b = [page('Intro text long enough to align the two pages together.'), page('3  Payment terms apply to every invoice issued.')]
    const r = compareDocuments(a, b)
    expect(r.changes.map((c) => [c.a.text, c.b.text])).toEqual([['2', '3']])
  })

  it('a deleted sentence starts at its first word and carries its full stop', () => {
    const a = [page('Pay on receipt. Late fees apply monthly. Taxes are extra.')]
    const b = [page('Pay on receipt. Taxes are extra.')]
    const [c] = compareDocuments(a, b).changes
    expect(c.a.text).toBe('Late fees apply monthly.')
  })

  it('lists text-less pages instead of calling them unchanged', () => {
    const r = compareDocuments([page(...LOREM), []], [page(...LOREM), []])
    expect(r.noTextA).toEqual([2])
    expect(r.noTextB).toEqual([2])
    expect(r.changes).toEqual([])
  })

  it('falls back to a whole-page change when the edit budget is exceeded', () => {
    const a = [page('alpha beta gamma delta epsilon zeta eta theta')]
    const b = [page('one two three four five six seven eight')]
    const r = compareDocuments(a, b, { maxEdits: 2, pageThreshold: 0 })
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0].kind).toBe('change')
  })
})

describe('mapComparedPage', () => {
  const pairs = [
    { a: 1, b: 1, similarity: 1 },
    { a: null, b: 2, similarity: 0 },
    { a: 2, b: 3, similarity: 0.9 },
    { a: 3, b: null, similarity: 0 },
    { a: 4, b: 4, similarity: 1 },
  ]
  it('maps matched pages both ways', () => {
    expect(mapComparedPage(pairs, 'a', 2)).toBe(3)
    expect(mapComparedPage(pairs, 'b', 3)).toBe(2)
    expect(mapComparedPage(pairs, 'a', 4)).toBe(4)
  })
  it('maps an unmatched page to the counterpart before the gap', () => {
    expect(mapComparedPage(pairs, 'b', 2)).toBe(1)
    expect(mapComparedPage(pairs, 'a', 3)).toBe(3)
  })
})
