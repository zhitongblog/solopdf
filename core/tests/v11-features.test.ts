import { describe, expect, it } from 'vitest'
import {
  textToLatex,
  extractLatexFromItems,
  buildTopicDigest,
  computeVisualDiff,
  buildPresetPipeline,
  validatePipelineSteps,
  type Annotation,
} from '../src/index.js'

describe('Math / Formula Recognition to LaTeX (math-snip)', () => {
  it('converts Unicode math symbols, Greek letters, super/subscripts, and functions', () => {
    expect(textToLatex('α + β = ∑ᵢ₌₁ⁿ xᵢ² ≤ ∞')).toBe('\\alpha + \\beta = \\sum_{i=1}^n x_i^2 \\le \\infty')
    expect(textToLatex('sin(θ) + √(x + 1) ≈ 0')).toBe('\\sin(\\theta) + \\sqrt{x + 1} \\approx 0')
    expect(textToLatex('softmax(Q · Kᵀ) ∈ ℝ')).toContain('\\operatorname{softmax}')
  })

  it('reconstructs spatial superscripts, subscripts, and stacked fractions into LaTeX', () => {
    // Simulated PDF user-space items (yDirection = 'up': larger Y is higher on page)
    const items = [
      { str: 'y', x: 10, y: 100, width: 8, height: 12 },
      { str: '=', x: 22, y: 100, width: 8, height: 12 },
      // Stacked fraction: numerator (y=114), bar (y=102), denominator (y=88)
      { str: 'a + b', x: 38, y: 114, width: 24, height: 10 },
      { str: '———', x: 36, y: 102, width: 28, height: 10 },
      { str: 'c', x: 46, y: 88, width: 8, height: 10 },
      { str: '+', x: 70, y: 100, width: 8, height: 12 },
      { str: 'x', x: 82, y: 100, width: 8, height: 12 },
      { str: 'i', x: 90, y: 95, width: 4, height: 7 }, // subscript
      { str: '2', x: 91, y: 106, width: 5, height: 7 }, // superscript
    ]
    const res = extractLatexFromItems(items, undefined, { yDirection: 'up' })
    expect(res.body).toContain('\\frac{a + b}{c}')
    expect(res.body).toContain('x_i^2')
    expect(res.isBlock).toBe(true)
    expect(res.latex.startsWith('$$')).toBe(true)
  })
})

describe('Cross-PDF Topic Digest (#tag synthesis)', () => {
  const mkAnnot = (id: string, page: number, excerpt: string, note: string, color = 'yellow'): Annotation => ({
    id,
    anchor: { page, quads: [{ x1: 0, y1: 0, x2: 10, y2: 10 }], pre: '', post: '' },
    excerpt,
    note,
    color,
    createdAt: '2026-11-14T00:00:00Z',
  })

  it('aggregates annotations across multiple PDFs by #tag with deep links', () => {
    const docs = [
      {
        docTitle: 'Attention Is All You Need',
        filePath: '/papers/attention.pdf',
        annotations: [
          mkAnnot('a1', 3, 'Scaled Dot-Product Attention', '核心注意力机制 #architecture #transformer'),
          mkAnnot('a2', 7, 'BLEU score of 28.4', '实验结果超越此前最佳 #eval'),
        ],
      },
      {
        docTitle: 'BERT Pre-training',
        filePath: '/papers/bert.pdf',
        annotations: [
          mkAnnot('b1', 2, 'Masked Language Model', '双向编码预训练架构 #architecture'),
          mkAnnot('b2', 9, 'GLUE benchmark 80.5%', '无标签备注'),
        ],
      },
    ]

    const digest = buildTopicDigest(docs, { title: '大模型精读综述' })
    expect(digest.totalDocuments).toBe(2)
    expect(digest.totalAnnotations).toBe(4)
    expect(digest.allTags).toEqual(['architecture', 'eval', 'transformer'])

    const archGroup = digest.groups.find((g) => g.key === 'architecture')
    expect(archGroup?.count).toBe(2)
    expect(digest.markdown).toContain('# 大模型精读综述')
    expect(digest.markdown).toContain('## #architecture (2)')
    expect(digest.markdown).toContain('solopdf://open?file=%2Fpapers%2Fattention.pdf&page=3&annot=a1')
    expect(digest.markdown).toContain('solopdf://open?file=%2Fpapers%2Fbert.pdf&page=2&annot=b1')
  })

  it('filters by specific tag and supports document grouping', () => {
    const docs = [
      {
        docTitle: 'Doc A',
        filePath: 'a.pdf',
        annotations: [mkAnnot('x1', 1, 'Quote 1', '#method'), mkAnnot('x2', 2, 'Quote 2', '#other')],
      },
    ]
    const filtered = buildTopicDigest(docs, { tags: ['method'], includeUntagged: false })
    expect(filtered.totalAnnotations).toBe(1)
    expect(filtered.groups.map((g) => g.key)).toEqual(['method'])

    const byDoc = buildTopicDigest(docs, { groupBy: 'document' })
    expect(byDoc.groups.length).toBe(1)
    expect(byDoc.groups[0].label).toBe('《Doc A》')
  })
})

describe('Visual Page Comparison (computeVisualDiff)', () => {
  it('computes Red/Cyan anaglyph diff and clusters hotspots accurately', () => {
    const w = 64
    const h = 64
    const bufA = new Uint8ClampedArray(w * h * 4).fill(255)
    const bufB = new Uint8ClampedArray(w * h * 4).fill(255)

    // Draw dark ink in A at (10..15, 10..15) -> removed in B (should turn Red in anaglyph)
    for (let y = 10; y < 15; y++) {
      for (let x = 10; x < 15; x++) {
        const i = (y * w + x) * 4
        bufA[i] = 0
        bufA[i + 1] = 0
        bufA[i + 2] = 0
      }
    }

    // Draw dark ink in B at (40..45, 40..45) -> added in B (should turn Cyan in anaglyph)
    for (let y = 40; y < 45; y++) {
      for (let x = 40; x < 45; x++) {
        const i = (y * w + x) * 4
        bufB[i] = 0
        bufB[i + 1] = 0
        bufB[i + 2] = 0
      }
    }

    const diff = computeVisualDiff(bufA, w, h, bufB, w, h, { mode: 'anaglyph', threshold: 20 })
    expect(diff.diffPixels).toBe(50) // 25 + 25 pixels
    expect(diff.hotspots.length).toBe(2)

    // Check pixel (12, 12) is Red-dominant (R > G and R > B)
    const idxOld = (12 * w + 12) * 4
    expect(diff.rgba[idxOld]).toBeGreaterThan(diff.rgba[idxOld + 1] + 100)

    // Check pixel (42, 42) is Cyan-dominant (G, B > R)
    const idxNew = (42 * w + 42) * 4
    expect(diff.rgba[idxNew + 2]).toBeGreaterThan(diff.rgba[idxNew] + 100)
  })
})

describe('Pipeline Deskew & Binarize steps', () => {
  it('validates deskew and binarize steps and builds scan_binarize preset', () => {
    const steps = buildPresetPipeline('scan_binarize')
    const check = validatePipelineSteps(steps)
    expect(check.valid).toBe(true)
    expect(steps.some((s) => s.op === 'deskew')).toBe(true)
    expect(steps.some((s) => s.op === 'binarize')).toBe(true)
  })
})
