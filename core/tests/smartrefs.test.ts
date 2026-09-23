import { describe, it, expect } from 'vitest'
import { findRefs, refAt, targetScore, chooseTarget, isBibEntry } from '../src/smartrefs.js'

const kinds = (s: string) => findRefs(s).map((r) => `${r.kind}:${r.label}`)

describe('findRefs', () => {
  it('English figure/table/equation forms', () => {
    expect(kinds('as shown in Figure 3 and Fig. 4b, see Table 2 and Eq. (5)'))
      .toEqual(['figure:3', 'figure:4', 'table:2', 'equation:5'])
    expect(kinds('FIGURE 12 and Figs. 1.2; TABLE II; Equation 7')).toEqual(['figure:12', 'figure:1.2', 'table:II', 'equation:7'])
  })
  it('bare "(4)" only after a leading word', () => {
    expect(kinds('Substituting (4) into (5) gives')).toEqual(['equation:4', 'equation:5'])
    expect(kinds('the reader (4 of them) said (2)')).toEqual([])
    // the lead word is context, not part of the reference
    const s = 'Substituting (4) here'
    const [r] = findRefs(s)
    expect(s.slice(r.start, r.end)).toBe('(4)')
  })
  it('bracketed citations, one ref per number', () => {
    const r = findRefs('prior work [3, 7] and [12]')
    expect(r.map((x) => x.label)).toEqual(['3', '7', '12'])
    // lone citation spans its brackets; grouped ones span only the number
    expect('prior work [3, 7] and [12]'.slice(r[2].start, r[2].end)).toBe('[12]')
    expect('prior work [3, 7] and [12]'.slice(r[1].start, r[1].end)).toBe('7')
  })
  it('intervals are not citations', () => {
    expect(kinds('x in [0, 1]')).toEqual([])
  })
  it('Chinese forms', () => {
    expect(kinds('如图 3 所示，结果见表 2，代入公式 (4)')).toEqual(['figure:3', 'table:2', 'equation:4'])
    expect(kinds('图3-2 与 式（7）')).toEqual(['figure:3.2', 'equation:7'])
    expect(kinds('列表 1 与发表 2')).toEqual([])
  })
  it('refAt finds the ref under an offset', () => {
    const s = 'see Figure 3 now'
    expect(refAt(s, s.indexOf('3'))?.kind).toBe('figure')
    expect(refAt(s, 0)).toBeNull()
  })
})

describe('targetScore', () => {
  it('captions with a separator score 2, bare 1, mentions 0', () => {
    expect(targetScore('Figure 3: The pipeline', { kind: 'figure', label: '3' })).toBe(2)
    expect(targetScore('Fig. 3. The pipeline', { kind: 'figure', label: '3' })).toBe(2)
    expect(targetScore('Figure 3 shows the pipeline', { kind: 'figure', label: '3' })).toBe(1)
    expect(targetScore('Figure 31: other', { kind: 'figure', label: '3' })).toBe(0)
    expect(targetScore('as in Figure 3: x', { kind: 'figure', label: '3' })).toBe(0)
    expect(targetScore('Table 2. Results', { kind: 'table', label: '2' })).toBe(2)
    expect(targetScore('TABLE II', { kind: 'table', label: 'II' })).toBe(2)
    expect(targetScore('图 3 系统结构', { kind: 'figure', label: '3' })).toBe(2)
    expect(targetScore('表2 实验结果', { kind: 'table', label: '2' })).toBe(2)
  })
  it('equations: number at line end, not a citing sentence', () => {
    expect(targetScore('E = mc^2    (4)', { kind: 'equation', label: '4' })).toBe(2)
    expect(targetScore('x = y（4）', { kind: 'equation', label: '4' })).toBe(2)
    expect(targetScore('which follows from Eq. (4)', { kind: 'equation', label: '4' })).toBe(0)
    expect(targetScore('substituting into (4)', { kind: 'equation', label: '4' })).toBe(0)
  })
  it('bibliography entries', () => {
    expect(targetScore('[12] D. Knuth. The Art…', { kind: 'citation', label: '12' })).toBe(2)
    expect(targetScore('as [12] showed', { kind: 'citation', label: '12' })).toBe(0)
    expect(isBibEntry('[3] A. Author')).toBe(true)
    expect(isBibEntry('see [3]')).toBe(false)
  })
})

describe('chooseTarget', () => {
  it('prefers stronger score, then nearest forward page', () => {
    const c = chooseTarget([
      { page: 2, score: 2 }, { page: 6, score: 2 }, { page: 5, score: 1 },
    ], 'figure', 4)
    expect(c?.page).toBe(6)
    expect(chooseTarget([{ page: 3, score: 2 }, { page: 7, score: 2 }], 'figure', 4)?.page).toBe(3)
  })
  it('citations go to a bibliography-looking page, forward first', () => {
    const cands = [
      { page: 3, score: 2, bibLines: 1 }, // a body line that starts with [4]
      { page: 20, score: 2, bibLines: 14 },
      { page: 40, score: 2, bibLines: 9 },
    ]
    expect(chooseTarget(cands, 'citation', 5)?.page).toBe(20)
    expect(chooseTarget(cands, 'citation', 30)?.page).toBe(40)
    expect(chooseTarget(cands, 'citation', 45)?.page).toBe(40)
  })
  it('null when nothing matched', () => {
    expect(chooseTarget([], 'table', 1)).toBeNull()
  })
})
