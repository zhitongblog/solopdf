import { describe, it, expect } from 'vitest'
import {
  normalizePageLabels, pageLabel, hasDistinctLabel, resolvePageInput,
  compactPageLabels, formatPageLabelRanges,
} from '../src/page-labels.js'

// same numbering as test-fixtures/page-labels-roman.pdf
const BOOK = [
  'Cover', 'i', 'ii', 'iii', 'iv',
  ...Array.from({ length: 16 }, (_, i) => String(i + 1)),
  'A-1', 'A-2', 'A-3',
]

describe('normalizePageLabels', () => {
  it('drops absent, wrong-length and trivial label trees', () => {
    expect(normalizePageLabels(null, 3)).toBeNull()
    expect(normalizePageLabels(['1', '2'], 3)).toBeNull()
    expect(normalizePageLabels(['1', '2', '3'], 3)).toBeNull()
  })
  it('keeps meaningful labels and fills holes with the physical number', () => {
    expect(normalizePageLabels(['i', null, '1'], 3)).toEqual(['i', '2', '1'])
    expect(normalizePageLabels(BOOK, 24)).toEqual(BOOK)
  })
})

describe('pageLabel', () => {
  it('falls back to the physical number', () => {
    expect(pageLabel(null, 7)).toBe('7')
    expect(pageLabel(BOOK, 3)).toBe('ii')
    expect(hasDistinctLabel(BOOK, 3)).toBe(true)
    expect(hasDistinctLabel(null, 3)).toBe(false)
  })
})

describe('resolvePageInput', () => {
  it('accepts a label, case-insensitively', () => {
    expect(resolvePageInput('iii', BOOK, 24)).toBe(4)
    expect(resolvePageInput('III', BOOK, 24)).toBe(4)
    expect(resolvePageInput('a-2', BOOK, 24)).toBe(23)
    expect(resolvePageInput(' cover ', BOOK, 24)).toBe(1)
  })
  it('prefers a numeric label over the physical number, # forces physical', () => {
    expect(resolvePageInput('3', BOOK, 24)).toBe(8)
    expect(resolvePageInput('#3', BOOK, 24)).toBe(3)
  })
  it('falls back to the physical number when no label matches', () => {
    // body labels stop at 16, so "20" can only mean physical page 20
    expect(resolvePageInput('20', BOOK, 24)).toBe(20)
    expect(resolvePageInput('25', BOOK, 24)).toBeNull()
  })
  it('handles unlabelled docs and garbage', () => {
    expect(resolvePageInput('5', null, 10)).toBe(5)
    expect(resolvePageInput('11', null, 10)).toBeNull()
    expect(resolvePageInput('xyz', BOOK, 24)).toBeNull()
    expect(resolvePageInput('', BOOK, 24)).toBeNull()
  })
})

describe('compactPageLabels', () => {
  it('collapses consecutive runs per style and prefix', () => {
    expect(compactPageLabels(BOOK)).toEqual([
      { from: 1, to: 1, first: 'Cover', last: 'Cover' },
      { from: 2, to: 5, first: 'i', last: 'iv' },
      { from: 6, to: 21, first: '1', last: '16' },
      { from: 22, to: 24, first: 'A-1', last: 'A-3' },
    ])
    expect(formatPageLabelRanges(BOOK)).toBe('1: Cover; 2-5: i–iv; 6-21: 1–16; 22-24: A-1–A-3')
  })
  it('handles upper-case roman and breaks on a restart', () => {
    expect(formatPageLabelRanges(['I', 'II', 'III', '1', '2', '1'])).toBe('1-3: I–III; 4-5: 1–2; 6: 1')
  })
  it('is empty without labels', () => {
    expect(compactPageLabels(null)).toEqual([])
    expect(formatPageLabelRanges(null)).toBe('')
  })
})

describe('resolvePageInput — full-width IME input', () => {
  const labels = ['Cover', 'i', 'ii', 'iii', '1', '2']
  it('reads full-width digits, # and letters like their ASCII forms', () => {
    expect(resolvePageInput('＃３', labels, 6)).toBe(3)
    expect(resolvePageInput('２', labels, 6)).toBe(6)
    expect(resolvePageInput('ｉｉｉ', labels, 6)).toBe(4)
  })
})
