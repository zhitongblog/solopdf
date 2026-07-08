import { describe, it, expect } from 'vitest'
import { orderLinesForReading, type OcrBox } from '../src/reading-order.js'

const L = (t: string, x: number, y: number, w = 0.3, h = 0.03): OcrBox => ({ t, x, y, w, h })

const texts = (lines: OcrBox[]) => lines.map((l) => l.t)

describe('orderLinesForReading', () => {
  it('single column: top to bottom', () => {
    const lines = [L('c', 0.1, 0.5), L('a', 0.1, 0.1), L('b', 0.1, 0.3)]
    expect(texts(orderLinesForReading(lines))).toEqual(['a', 'b', 'c'])
  })

  it('same visual row: left to right', () => {
    const lines = [L('right', 0.5, 0.100), L('left', 0.1, 0.104)]
    expect(texts(orderLinesForReading(lines))).toEqual(['left', 'right'])
  })

  it('two columns read column by column, not interleaved', () => {
    const left = [1, 2, 3, 4].map((i) => L(`L${i}`, 0.05, 0.1 + i * 0.1, 0.4))
    const right = [1, 2, 3, 4].map((i) => L(`R${i}`, 0.55, 0.1 + i * 0.1, 0.4))
    // 打乱输入(交错)
    const mixed = [right[0], left[0], right[1], left[1], right[2], left[2], right[3], left[3]]
    expect(texts(orderLinesForReading(mixed))).toEqual([
      'L1', 'L2', 'L3', 'L4', 'R1', 'R2', 'R3', 'R4',
    ])
  })

  it('full-width title splits bands: title, then columns below', () => {
    const title = L('TITLE', 0.1, 0.05, 0.8)
    const left = [1, 2, 3].map((i) => L(`L${i}`, 0.05, 0.1 + i * 0.1, 0.4))
    const right = [1, 2, 3].map((i) => L(`R${i}`, 0.55, 0.1 + i * 0.1, 0.4))
    const mixed = [right[0], left[0], title, right[1], left[1], right[2], left[2]]
    expect(texts(orderLinesForReading(mixed))).toEqual([
      'TITLE', 'L1', 'L2', 'L3', 'R1', 'R2', 'R3',
    ])
  })

  it('sparse right-margin page numbers do not trigger column mode', () => {
    const body = [1, 2, 3, 4, 5, 6].map((i) => L(`b${i}`, 0.1, 0.1 + i * 0.1, 0.5))
    const pageNo = L('42', 0.9, 0.95, 0.04)
    const got = texts(orderLinesForReading([pageNo, ...body]))
    expect(got).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', '42'])
  })

  it('skips empty lines and does not mutate input', () => {
    const lines = [L('a', 0.1, 0.2), L('  ', 0.1, 0.1), L('b', 0.1, 0.3)]
    const snapshot = JSON.stringify(lines)
    expect(texts(orderLinesForReading(lines))).toEqual(['a', 'b'])
    expect(JSON.stringify(lines)).toBe(snapshot)
  })
})
