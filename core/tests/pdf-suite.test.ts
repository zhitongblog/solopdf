import { describe, it, expect } from 'vitest'
import { computeAutoCropMargins, detectBitmapContentBox } from '../src/crop.js'
import { splitByBookmarks, splitIntoChunks, sanitizeChapterSlug } from '../src/split.js'
import { pdfToMarkdown } from '../src/pdf-to-md.js'
import { findRedactionRects } from '../src/redact.js'

describe('auto crop & whitespace detection', () => {
  it('computes safe margins across pages and separates odd/even', () => {
    const res = computeAutoCropMargins(
      [
        {
          page: 1,
          width: 600,
          height: 800,
          // left=0.15(90pt), right=0.90(margin 60pt), top=0.10(80pt), bottom=0.85(margin 120pt)
          boxes: [{ x: 0.15, y: 0.10, w: 0.75, h: 0.75 }],
        },
        {
          page: 2,
          width: 600,
          height: 800,
          // even page has smaller left margin (0.10 = 60pt), larger right margin (0.85 => 90pt)
          boxes: [{ x: 0.10, y: 0.12, w: 0.75, h: 0.73 }],
        },
      ],
      { paddingPt: 10 },
    )
    expect(res.analyzedPages).toBe(2)
    // page 1: top=70, right=50, bottom=110, left=80
    expect(res.oddMargins).toEqual([70, 50, 110, 80])
    // page 2: top=86, right=80, bottom=110, left=50
    expect(res.evenMargins).toEqual([86, 80, 110, 50])
    // combined min: [70, 50, 110, 50]
    expect(res.margins).toEqual([70, 50, 110, 50])
  })

  it('detects ink bounding box from RGBA pixel canvas', () => {
    const w = 20
    const h = 10
    const rgba = new Uint8Array(w * h * 4).fill(255) // all white
    // Paint dark pixels at (x=4..9, y=2..6)
    for (let y = 2; y <= 6; y++) {
      for (let x = 4; x <= 9; x++) {
        const i = (y * w + x) * 4
        rgba[i] = 20
        rgba[i + 1] = 20
        rgba[i + 2] = 20
        rgba[i + 3] = 255
      }
    }
    const box = detectBitmapContentBox(rgba, w, h)
    expect(box).toEqual({
      x: 4 / 20,
      y: 2 / 10,
      w: 6 / 20,
      h: 5 / 10,
    })
  })
})

describe('split by bookmarks and chunks', () => {
  it('splits by top-level bookmarks and includes front matter when first chapter starts after page 1', () => {
    const outline = [
      { title: '第一章 绪论', page: 4, depth: 0 },
      { title: '1.1 背景', page: 5, depth: 1 },
      { title: '第二章 方法 / 实验', page: 10, depth: 0 },
      { title: '第三章 结论', page: 18, depth: 0 },
    ]
    const ranges = splitByBookmarks(outline, 22, { maxDepth: 0, includeFrontMatter: true })
    expect(ranges).toEqual([
      { title: '前言', slug: '00-前言', from: 1, to: 3, rangeSpec: '1-3' },
      { title: '第一章 绪论', slug: '01-第一章_绪论', from: 4, to: 9, rangeSpec: '4-9' },
      { title: '第二章 方法 / 实验', slug: '02-第二章_方法_-_实验', from: 10, to: 17, rangeSpec: '10-17' },
      { title: '第三章 结论', slug: '03-第三章_结论', from: 18, to: 22, rangeSpec: '18-22' },
    ])
  })

  it('splits into fixed page chunks or balanced N parts', () => {
    expect(splitIntoChunks(10, { pagesPerFile: 4 })).toEqual([
      { from: 1, to: 4, rangeSpec: '1-4' },
      { from: 5, to: 8, rangeSpec: '5-8' },
      { from: 9, to: 10, rangeSpec: '9-10' },
    ])
    expect(splitIntoChunks(10, { parts: 3 })).toEqual([
      { from: 1, to: 4, rangeSpec: '1-4' },
      { from: 5, to: 7, rangeSpec: '5-7' },
      { from: 8, to: 10, rangeSpec: '8-10' },
    ])
    expect(sanitizeChapterSlug('Ch 1: A/B*C?')).toBe('Ch_1-_A-B-C')
  })
})

describe('native PDF to structured Markdown', () => {
  it('converts headings, paragraphs, bullet lists, and aligned tables into Markdown', () => {
    const md = pdfToMarkdown(
      [
        {
          page: 1,
          lines: [
            { t: '第一章 架构概览', x: 0.1, y: 0.08, w: 0.4, h: 0.035, fontSize: 0.035 },
            { t: '本系统完全在本地运行，保护用户文档隐私。', x: 0.1, y: 0.15, w: 0.7, h: 0.02, fontSize: 0.02 },
            { t: '• 零云端上传', x: 0.12, y: 0.22, w: 0.3, h: 0.02, fontSize: 0.02 },
            { t: '• 原生 Rust 引擎加速', x: 0.12, y: 0.25, w: 0.4, h: 0.02, fontSize: 0.02 },
            // 2-row 3-column table
            { t: '模块', x: 0.1, y: 0.35, w: 0.1, h: 0.02, fontSize: 0.02 },
            { t: '语言', x: 0.35, y: 0.35, w: 0.1, h: 0.02, fontSize: 0.02 },
            { t: '耗时', x: 0.65, y: 0.35, w: 0.1, h: 0.02, fontSize: 0.02 },
            { t: 'pdfops', x: 0.1, y: 0.39, w: 0.12, h: 0.02, fontSize: 0.02 },
            { t: 'Rust', x: 0.35, y: 0.39, w: 0.1, h: 0.02, fontSize: 0.02 },
            { t: '12ms', x: 0.65, y: 0.39, w: 0.1, h: 0.02, fontSize: 0.02 },
          ],
        },
      ],
      [{ title: '第一章 架构概览', page: 1, depth: 0 }],
    )

    expect(md).toContain('# 第一章 架构概览')
    expect(md).toContain('本系统完全在本地运行，保护用户文档隐私。')
    expect(md).toContain('- 零云端上传\n- 原生 Rust 引擎加速')
    expect(md).toContain('| 模块 | 语言 | 耗时 |\n| --- | --- | --- |\n| pdfops | Rust | 12ms |')
  })
})

describe('sensitive text redaction coordinate finder', () => {
  it('locates phone, email, and custom terms and converts to bottom-left PDF coordinates', () => {
    const matches = findRedactionRects(
      [
        {
          page: 1,
          width: 600,
          height: 800,
          spans: [
            {
              text: '联系人：张三，电话 13812345678，邮箱 test@example.com',
              x: 0.1,
              y: 0.2,
              w: 0.8,
              h: 0.025,
            },
          ],
        },
      ],
      {
        presets: ['phone', 'email'],
        terms: ['张三'],
        padPt: 0,
      },
    )

    expect(matches.map((m) => ({ kind: m.kind, text: m.matchedText }))).toEqual([
      { kind: 'phone', text: '13812345678' },
      { kind: 'email', text: 'test@example.com' },
      { kind: 'term', text: '张三' },
    ])

    // Check PDF bottom-left coordinates are within page bounds and y1 < y2
    for (const m of matches) {
      const [x1, y1, x2, y2] = m.rect
      expect(x1).toBeGreaterThanOrEqual(60)
      expect(x2).toBeLessThanOrEqual(540)
      expect(x2).toBeGreaterThan(x1)
      expect(y2).toBeCloseTo(800 * (1 - 0.2), 1)
      expect(y1).toBeCloseTo(800 * (1 - 0.225), 1)
    }
  })
})
