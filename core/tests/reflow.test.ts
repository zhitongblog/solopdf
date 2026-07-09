import { describe, it, expect } from 'vitest'
import { reflow, joinLines, type ReflowLine, type ReflowPageInput } from '../src/reflow.js'

const L = (t: string, y: number, opts: Partial<ReflowLine> = {}): ReflowLine => ({
  t, x: 0.1, y, w: 0.8, h: 0.02, ...opts,
})

describe('joinLines', () => {
  it('CJK joins without space', () => {
    expect(joinLines('春眠不觉晓,', '处处闻啼鸟。')).toBe('春眠不觉晓,处处闻啼鸟。')
  })
  it('latin joins with space', () => {
    expect(joinLines('the quick', 'brown fox')).toBe('the quick brown fox')
  })
  it('hyphenated english word is restored', () => {
    expect(joinLines('under-', 'standing')).toBe('understanding')
  })
  it('hyphen before capital stays (proper noun / range)', () => {
    expect(joinLines('the X-', 'Ray machine')).toBe('the X- Ray machine')
  })
})

describe('reflow', () => {
  it('merges consecutive tight lines into one paragraph', () => {
    const pages: ReflowPageInput[] = [{
      page: 1,
      lines: [L('第一行文字,', 0.10), L('第二行文字,', 0.125), L('第三行结束。', 0.15)],
    }]
    const doc = reflow(pages)
    expect(doc.blocks).toHaveLength(1)
    expect(doc.blocks[0].text).toBe('第一行文字,第二行文字,第三行结束。')
    expect(doc.blocks[0].page).toBe(1)
  })

  it('splits paragraphs on big vertical gaps', () => {
    const pages: ReflowPageInput[] = [{
      page: 1,
      lines: [
        L('段落一第一行', 0.10), L('段落一第二行。', 0.125),
        L('段落二第一行', 0.30), L('段落二第二行。', 0.325),
      ],
    }]
    const doc = reflow(pages)
    expect(doc.blocks.map((b) => b.text)).toEqual(['段落一第一行段落一第二行。', '段落二第一行段落二第二行。'])
  })

  it('splits on first-line indent', () => {
    const pages: ReflowPageInput[] = [{
      page: 1,
      lines: [
        L('前一段落的结尾行。', 0.10),
        L('新段落缩进开头', 0.125, { x: 0.14 }),
        L('新段落第二行。', 0.15),
      ],
    }]
    const doc = reflow(pages)
    expect(doc.blocks).toHaveLength(2)
    expect(doc.blocks[1].text).toBe('新段落缩进开头新段落第二行。')
  })

  it('outline entries become headings with levels', () => {
    const pages: ReflowPageInput[] = [{
      page: 3,
      lines: [L('第一章 起风了', 0.08, { h: 0.03 }), L('正文开始这里,写了很多字。', 0.14)],
    }]
    const doc = reflow(pages, [{ title: '第一章 起风了', page: 3, depth: 0 }])
    expect(doc.blocks[0]).toMatchObject({ type: 'heading', level: 1 })
    expect(doc.blocks[1].type).toBe('para')
  })

  it('large short line without terminal punctuation becomes fallback heading', () => {
    const pages: ReflowPageInput[] = [{
      page: 1,
      lines: [
        L('引言', 0.06, { h: 0.035, fontSize: 0.035, w: 0.1 }),
        L('这是正文第一行,足够普通,', 0.14),
        L('这是正文第二行。', 0.165),
        L('这是正文第三行,继续写。', 0.19),
      ],
    }]
    const doc = reflow(pages)
    expect(doc.blocks[0]).toMatchObject({ type: 'heading', text: '引言' })
  })

  it('stitches a paragraph across the page break', () => {
    const pages: ReflowPageInput[] = [
      { page: 1, lines: [L('这一段写到页尾还没有写完,句子没有', 0.90)] },
      { page: 2, lines: [L('结束,直到第二页才收尾。', 0.06)] },
    ]
    const doc = reflow(pages)
    expect(doc.blocks).toHaveLength(1)
    expect(doc.blocks[0].text).toBe('这一段写到页尾还没有写完,句子没有结束,直到第二页才收尾。')
    expect(doc.blocks[0].page).toBe(1)
  })

  it('does NOT stitch when previous page ends with terminal punctuation', () => {
    const pages: ReflowPageInput[] = [
      { page: 1, lines: [L('这一段在页尾正常结束了。', 0.90)] },
      { page: 2, lines: [L('新的一页新的段落开始。', 0.06)] },
    ]
    const doc = reflow(pages)
    expect(doc.blocks).toHaveLength(2)
  })

  it('two-column pages read column-first before paragraphing', () => {
    const lines: ReflowLine[] = []
    for (let i = 0; i < 4; i++) lines.push(L(`左${i},`, 0.1 + i * 0.03, { x: 0.05, w: 0.4 }))
    for (let i = 0; i < 4; i++) lines.push(L(`右${i},`, 0.1 + i * 0.03, { x: 0.55, w: 0.4 }))
    const doc = reflow([{ page: 1, lines }])
    const all = doc.blocks.map((b) => b.text).join('|')
    expect(all.indexOf('左3')).toBeLessThan(all.indexOf('右0'))
  })
})
