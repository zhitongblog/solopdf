import { describe, it, expect } from 'vitest'
import {
  detectOutlinesFromPages,
  flattenOutlineTree,
  unflattenOutlineTree,
  sanitizeOutlineTree,
  extractTableFromItems,
  tableToMarkdown,
  tableToCsv,
  extractTags,
  collectAllTags,
  filterAnnotations,
  toAnkiTsv,
  toObsidianSr,
  defaultMeasureScale,
  calibrateMeasureScale,
  measureDistance,
  measurePerimeter,
  measurePolygonArea,
  polygonCentroid,
  formatMeasurement,
  STAMP_PRESETS,
  renderStampSvg,
  stampToDataUrl,
  TIP_TIERS,
  SUPPORTER_BADGE,
  tierFromProductId,
  badgeInfo,
  mergeSupporterRecord,
  type Annotation,
  type SnipTextItem,
} from '../src/index.js'

describe('1. outlines — PDF Outlines Auto-Detection & Tree Manipulation', () => {
  it('detects nested outlines from Chinese chapters, numbered headings, and font-size gradients', () => {
    const pages = [
      {
        page: 1,
        width: 600,
        height: 800,
        items: [
          { str: '第一章 系统架构', x: 60, y: 80, width: 200, height: 22, fontSize: 22 },
          { str: '本节介绍系统的整体设计与模块划分。', x: 60, y: 120, width: 400, height: 12, fontSize: 12 },
          { str: '2026.11 项目立项记录不应被误判为章节。', x: 60, y: 150, width: 350, height: 12, fontSize: 12 },
          { str: '1.1 核心模块', x: 60, y: 200, width: 150, height: 16, fontSize: 16 },
          { str: '1.1.1 渲染管线', x: 60, y: 260, width: 140, height: 14, fontSize: 14 },
        ],
      },
      {
        page: 2,
        width: 600,
        height: 800,
        items: [
          { str: 'Chapter 2 Performance', x: 60, y: 70, width: 240, height: 22, fontSize: 22 },
          { str: 'Section 2.1 Memory Pool', x: 60, y: 140, width: 200, height: 16, fontSize: 16 },
          { str: 'Regular paragraph text on page two.', x: 60, y: 190, width: 380, height: 12, fontSize: 12 },
        ],
      },
    ]

    const tree = detectOutlinesFromPages(pages, { mode: 'auto', maxLevel: 3 })
    expect(tree).toHaveLength(2)
    expect(tree[0].title).toBe('第一章 系统架构')
    expect(tree[0].page).toBe(1)
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children![0].title).toBe('1.1 核心模块')
    expect(tree[0].children![0].children).toHaveLength(1)
    expect(tree[0].children![0].children![0].title).toBe('1.1.1 渲染管线')

    expect(tree[1].title).toBe('Chapter 2 Performance')
    expect(tree[1].page).toBe(2)
    expect(tree[1].children).toHaveLength(1)
    expect(tree[1].children![0].title).toBe('Section 2.1 Memory Pool')
  })

  it('supports fontsize-only mode and custom regex mode', () => {
    const pages = [
      {
        page: 1,
        width: 600,
        height: 800,
        items: [
          { str: 'Overview Title', x: 50, y: 60, width: 200, height: 24, fontSize: 24 },
          { str: 'Subtopic Alpha', x: 50, y: 110, width: 160, height: 18, fontSize: 18 },
          { str: 'Normal body line one.', x: 50, y: 150, width: 300, height: 12, fontSize: 12 },
          { str: 'Normal body line two.', x: 50, y: 170, width: 300, height: 12, fontSize: 12 },
          { str: 'Normal body line three.', x: 50, y: 190, width: 300, height: 12, fontSize: 12 },
          { str: 'RULE-01 Custom Entry', x: 50, y: 240, width: 200, height: 12, fontSize: 12 },
        ],
      },
    ]

    const fsTree = detectOutlinesFromPages(pages, { mode: 'fontsize' })
    expect(fsTree).toHaveLength(1)
    expect(fsTree[0].title).toBe('Overview Title')
    expect(fsTree[0].children?.[0]?.title).toBe('Subtopic Alpha')

    const regexTree = detectOutlinesFromPages(pages, {
      mode: 'regex',
      customRegex: '^RULE-\\d+',
    })
    expect(regexTree).toHaveLength(1)
    expect(regexTree[0].title).toBe('RULE-01 Custom Entry')
  })

  it('flattens, unflattens, and sanitizes outline trees', () => {
    const flat = [
      { title: 'Part A', page: 1, level: 1, top: 50 },
      { title: 'Sec A.1', page: 2, level: 2, top: 100 },
      { title: 'Sub A.1.1', page: 3, level: 3, top: 150 },
      { title: 'Part B', page: 5, level: 1, top: 60 },
    ]
    const tree = unflattenOutlineTree(flat)
    expect(flattenOutlineTree(tree)).toEqual(flat)

    const dirtyTree = [
      {
        title: '  Intro  ',
        page: -3,
        children: [
          { title: '   ', page: 5, children: [{ title: 'Promoted Child', page: 999 }] },
        ],
      },
    ]
    const clean = sanitizeOutlineTree(dirtyTree, 20)
    expect(clean).toEqual([
      {
        title: 'Intro',
        page: 1,
        children: [{ title: 'Promoted Child', page: 20, children: [] }],
      },
    ])
  })
})

describe('2. table-snip — Region Table Extraction (Markdown / CSV)', () => {
  const sampleItems: SnipTextItem[] = [
    // Header row (y = 100)
    { str: 'Engine', x: 50, y: 100, width: 45, height: 12 },
    { str: 'Format', x: 180, y: 100, width: 45, height: 12 },
    { str: 'Notes', x: 320, y: 100, width: 40, height: 12 },
    // Row 1 (y = 125) - all 3 columns present
    { str: 'MuPDF', x: 50, y: 125, width: 40, height: 12 },
    { str: 'PDF | EPUB', x: 180, y: 125, width: 65, height: 12 },
    { str: 'Fast, "native"', x: 320, y: 125, width: 80, height: 12 },
    // Row 2 (y = 150) - sparse row (missing middle Format column)
    { str: 'Tesseract', x: 52, y: 150, width: 55, height: 12 },
    { str: 'OCR fallback', x: 322, y: 150, width: 75, height: 12 },
    // Outside rect item (y = 400)
    { str: 'Footer Noise', x: 50, y: 400, width: 80, height: 12 },
  ]

  it('extracts rows within SnipRect and aligns sparse cells into the proper column', () => {
    const rows = extractTableFromItems(sampleItems, { x: 40, y: 90, width: 400, height: 100 })
    expect(rows).toEqual([
      ['Engine', 'Format', 'Notes'],
      ['MuPDF', 'PDF | EPUB', 'Fast, "native"'],
      ['Tesseract', '', 'OCR fallback'],
    ])

    const md = tableToMarkdown(rows)
    expect(md).toBe(
      [
        '| Engine | Format | Notes |',
        '| --- | --- | --- |',
        '| MuPDF | PDF \\| EPUB | Fast, "native" |',
        '| Tesseract |  | OCR fallback |',
      ].join('\n'),
    )

    const csv = tableToCsv(rows)
    expect(csv).toBe(
      [
        'Engine,Format,Notes',
        'MuPDF,PDF | EPUB,"Fast, ""native"""',
        'Tesseract,,OCR fallback',
      ].join('\n'),
    )
  })

  it('supports bottom-up PDF coordinates via yDirection: "up"', () => {
    const bottomUpItems: SnipTextItem[] = [
      { str: 'ColA', x: 10, y: 700, width: 30, height: 10 },
      { str: 'ColB', x: 100, y: 700, width: 30, height: 10 },
      { str: 'Val1', x: 10, y: 680, width: 30, height: 10 },
      { str: 'Val2', x: 100, y: 680, width: 30, height: 10 },
    ]
    const rows = extractTableFromItems(bottomUpItems, undefined, { yDirection: 'up' })
    expect(rows).toEqual([
      ['ColA', 'ColB'],
      ['Val1', 'Val2'],
    ])
  })
})

describe('3. flashcards — Annotation Tagging, Filtering & Anki/Obsidian Export', () => {
  const sampleAnnots: Annotation[] = [
    {
      id: 'a1',
      anchor: {
        page: 3,
        quads: [{ x1: 10, y1: 10, x2: 100, y2: 20 }],
        pre: 'In linear algebra, ',
        post: ' is fundamental.',
        src: { ref: '1R', type: 'Highlight', author: 'Alice' },
      },
      excerpt: 'eigenvalue decomposition',
      note: 'Diagonalizes square matrices #exam/math #重要',
      color: 'yellow',
      kind: 'highlight',
      createdAt: '2026-11-14T00:00:00Z',
    },
    {
      id: 'a2',
      anchor: {
        page: 7,
        quads: [{ x1: 20, y1: 30, x2: 200, y2: 120 }],
        pre: '',
        post: '',
      },
      excerpt: 'Architecture Diagram',
      note: '# Heading Ignored\nColor #ff0000 ignored, keep #architecture and #todo_v1',
      color: 'blue',
      kind: 'region',
      image: 'assets/arch.png',
      createdAt: '2026-11-14T01:00:00Z',
    },
  ]

  it('extracts CJK and hierarchical #tags while ignoring markdown headings and hex colors', () => {
    const tags = extractTags(
      '# Markdown Title\nReview #重要 and #Exam/Math with color: #ff0000 or #fff and #todo-list',
    )
    expect(tags).toEqual(['重要', 'exam/math', 'todo-list'])
    expect(collectAllTags(sampleAnnots)).toEqual(['architecture', 'exam/math', 'todo_v1', '重要'])
  })

  it('filters annotations by color, kind, hierarchical tag, and search query', () => {
    expect(filterAnnotations(sampleAnnots, { colors: ['yellow'] }).map((a) => a.id)).toEqual(['a1'])
    expect(filterAnnotations(sampleAnnots, { kinds: ['area'] }).map((a) => a.id)).toEqual(['a2'])
    expect(filterAnnotations(sampleAnnots, { tags: ['#exam'] }).map((a) => a.id)).toEqual(['a1'])
    expect(filterAnnotations(sampleAnnots, { query: 'alice' }).map((a) => a.id)).toEqual(['a1'])
  })

  it('exports Anki TSV (standard & cloze) and Obsidian Spaced Repetition markdown', () => {
    const tsv = toAnkiTsv(sampleAnnots, {
      docTitle: 'Linear Algebra',
      fileName: 'la-notes.pdf',
      cloze: false,
    })
    expect(tsv).toContain('#separator:tab\n#html:true\n#tags column:3\n')
    expect(tsv).toContain('eigenvalue decomposition\t')
    expect(tsv).toContain('《Linear Algebra》 p.3')
    expect(tsv).toContain('solopdf://open?file=la-notes.pdf&page=3')
    expect(tsv).toContain('exam/math 重要')
    expect(tsv).toContain('<img src="assets/arch.png">')

    const clozeTsv = toAnkiTsv([sampleAnnots[0]], {
      docTitle: 'Linear Algebra',
      cloze: true,
    })
    expect(clozeTsv).toContain('In linear algebra, {{c1::eigenvalue decomposition}} is fundamental.')

    const obsidianMd = toObsidianSr(sampleAnnots, {
      docTitle: 'Linear Algebra',
      fileName: 'la-notes.pdf',
    })
    expect(obsidianMd).toContain('# 《Linear Algebra》 Flashcards')
    expect(obsidianMd).toContain('eigenvalue decomposition #exam/math #重要\n?\n')
    expect(obsidianMd).toContain('<!--p.3-->')
    expect(obsidianMd).toContain('<!--p.7-->')
  })
})

describe('4. measure — Scale Calibration, Distance, Perimeter & Polygon Area', () => {
  it('computes default scale, calibrated scale, distance, perimeter, area, and centroid', () => {
    const def = defaultMeasureScale('mm')
    expect(def.unitsPerPoint).toBeCloseTo(25.4 / 72, 6)

    // Page is 600pt x 800pt. Line from (0.1, 0.1) to (0.6, 0.1) is 300pt long.
    // Calibrate 300pt = 150 cm (i.e. 0.5 cm per pt)
    const scale = calibrateMeasureScale(
      { x: 0.1, y: 0.1 },
      { x: 0.6, y: 0.1 },
      600,
      800,
      150,
      'cm',
    )
    expect(scale.unit).toBe('cm')
    expect(scale.unitsPerPoint).toBeCloseTo(0.5, 6)

    const dist = measureDistance({ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, 600, 800, scale)
    expect(dist.points).toBeCloseTo(120, 5)
    expect(dist.value).toBeCloseTo(60, 5)
    expect(dist.formatted).toBe('60 cm')

    // Rectangle 120pt wide (0.2 * 600) by 80pt tall (0.1 * 800) => 60cm x 40cm
    const rectPts = [
      { x: 0.1, y: 0.1 },
      { x: 0.3, y: 0.1 },
      { x: 0.3, y: 0.2 },
      { x: 0.1, y: 0.2 },
    ]
    const openPerim = measurePerimeter(rectPts, 600, 800, scale, false)
    expect(openPerim.value).toBeCloseTo(60 + 40 + 60, 5)

    const closedPerim = measurePerimeter(rectPts, 600, 800, scale, true)
    expect(closedPerim.value).toBeCloseTo(200, 5)
    expect(closedPerim.formatted).toBe('200 cm')

    const area = measurePolygonArea(rectPts, 600, 800, scale)
    expect(area.pointsSq).toBeCloseTo(120 * 80, 3)
    expect(area.value).toBeCloseTo(60 * 40, 3)
    expect(area.unit).toBe('cm²')
    expect(area.formatted).toBe('2400 cm²')

    const center = polygonCentroid(rectPts)
    expect(center.x).toBeCloseTo(0.2, 5)
    expect(center.y).toBeCloseTo(0.15, 5)
    expect(formatMeasurement(12.3456, 'mm')).toBe('12.35 mm')
  })
})

describe('5. stamps — Standard & Dynamic Vector Stamps', () => {
  it('provides all 8 localized presets and renders valid SVG and data URLs', () => {
    expect(STAMP_PRESETS).toHaveLength(8)
    const ids = STAMP_PRESETS.map((p) => p.id)
    expect(ids).toEqual([
      'approved',
      'confidential',
      'draft',
      'final',
      'reviewed',
      'void',
      'urgent',
      'for-info',
    ])

    const svgZh = renderStampSvg({
      presetId: 'confidential',
      locale: 'zh-CN',
      author: '张工',
      date: '2026-11-14',
    })
    expect(svgZh).toContain('<svg')
    expect(svgZh).toContain('机密')
    expect(svgZh).toContain('张工 • 2026-11-14')
    expect(svgZh).toContain('#dc2626')

    const svgCustom = renderStampSvg({
      customText: 'R&D <INTERNAL>',
      subText: 'Dept 7',
      color: '#2563eb',
    })
    expect(svgCustom).toContain('R&amp;D &lt;INTERNAL&gt;')
    expect(svgCustom).toContain('Dept 7')

    const url = stampToDataUrl({ presetId: 'approved', locale: 'ja' })
    expect(url.startsWith('data:image/svg+xml;utf8,')).toBe(true)
    expect(decodeURIComponent(url)).toContain('承認済')
  })
})

describe('6. supporter — 3-Tier Tip Jar & Supporter Badge Logic', () => {
  it('resolves product IDs, badge metadata, and merges supporter records', () => {
    expect(TIP_TIERS.map((t) => t.productId)).toEqual([
      'app.solopdf.tip.coffee',
      'app.solopdf.tip.meal',
      'app.solopdf.tip.feast',
    ])
    expect(tierFromProductId('app.solopdf.tip.coffee')).toBe('coffee')
    expect(tierFromProductId('app.solopdf.tip.meal')).toBe('meal')
    expect(tierFromProductId('app.solopdf.tip.feast')).toBe('feast')
    expect(tierFromProductId('unknown.product')).toBeNull()

    let rec = mergeSupporterRecord(null, 'app.solopdf.tip.coffee', '2026-11-14T01:00:00Z')
    expect(rec.highestTier).toBe('coffee')
    expect(rec.tipCount).toBe(1)
    expect(badgeInfo(rec, 'zh-CN')?.emoji).toBe('☕')

    // Upgrade to feast
    rec = mergeSupporterRecord(rec, 'app.solopdf.tip.feast', '2026-11-14T02:00:00Z')
    expect(rec.highestTier).toBe('feast')
    expect(rec.tipCount).toBe(2)
    expect(rec.firstSupportedAt).toBe('2026-11-14T01:00:00Z')
    expect(rec.lastSupportedAt).toBe('2026-11-14T02:00:00Z')

    // Subsequent coffee tip increments count but preserves highestTier = feast
    rec = mergeSupporterRecord(rec, 'app.solopdf.tip.coffee', '2026-11-14T03:00:00Z')
    expect(rec.highestTier).toBe('feast')
    expect(rec.tipCount).toBe(3)
    expect(badgeInfo(rec, 'en')?.label).toBe(SUPPORTER_BADGE.feast.labels.en)
  })
})
