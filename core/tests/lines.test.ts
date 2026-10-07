import { describe, it, expect } from 'vitest'
import { mergeRuns, groupLines, lineAt, bandAround, type LineBox } from '../src/lines.js'

const box = (left: number, top: number, right: number, h = 12): LineBox => ({ left, top, right, bottom: top + h })

describe('mergeRuns', () => {
  it('joins runs on one baseline, splits far-apart columns', () => {
    const segs = mergeRuns([
      box(10, 100, 60), box(64, 100, 120), // one line, two runs
      box(310, 101, 400), // same y, other column
      box(10, 116, 130),
    ])
    expect(segs).toHaveLength(3)
    expect(segs[0]).toMatchObject({ left: 10, right: 120 })
  })
  it('folds a superscript into its line and drops slivers', () => {
    const segs = mergeRuns([box(10, 100, 100), box(101, 96, 106, 7), box(200, 100, 200.2)])
    expect(segs).toHaveLength(1)
    expect(segs[0].top).toBe(96)
  })
})

describe('groupLines', () => {
  it('two-column text reads left column down, then right column', () => {
    const rects: LineBox[] = [box(50, 40, 550, 18)] // full-width title
    for (let i = 0; i < 4; i++) rects.push(box(50, 80 + i * 16, 280), box(320, 82 + i * 16, 550))
    rects.push(box(50, 200, 550)) // full-width footer
    rects.push(box(296, 150, 304)) // page number centred under the columns
    const lines = groupLines(rects, { midX: 300 })
    expect(lines.map((l) => [l.left, Math.round(l.top)])).toEqual([
      [50, 40],
      [50, 80], [50, 96], [50, 112], [50, 128],
      [320, 82], [320, 98], [320, 114], [320, 130],
      [296, 150],
      [50, 200],
    ])
  })
  it('single column with a short last line stays top-down', () => {
    const lines = groupLines([box(50, 10, 550), box(50, 26, 200), box(50, 42, 550)], { midX: 300 })
    expect(lines.map((l) => l.top)).toEqual([10, 26, 42])
  })
  it('empty input', () => {
    expect(groupLines([], { midX: 0 })).toEqual([])
  })
})

describe('lineAt / bandAround', () => {
  const lines = [box(50, 10, 280), box(50, 26, 280), box(320, 12, 550), box(320, 28, 550)]
  it('picks the line under the pointer, column-aware', () => {
    expect(lineAt(lines, 100, 30)).toBe(1)
    expect(lineAt(lines, 400, 14)).toBe(2)
    expect(lineAt(lines, 100, 500)).toBe(1)
    expect(lineAt([], 0, 0)).toBe(-1)
  })
  it('3-line band spans neighbours of the same run', () => {
    const col = [box(50, 10, 280), box(50, 26, 260), box(50, 42, 270), box(50, 400, 280)]
    expect(bandAround(col, 1, 3)).toEqual({ left: 50, top: 10, right: 280, bottom: 54 })
    expect(bandAround(col, 1, 1)).toEqual(col[1])
    // the far-away line (next page) is not pulled into the band
    expect(bandAround(col, 2, 3)).toEqual({ left: 50, top: 26, right: 270, bottom: 54 })
    expect(bandAround(col, 9, 3)).toBeNull()
  })
})
