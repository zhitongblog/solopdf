import { describe, it, expect } from 'vitest'
import {
  serialize, parse, upsertAnnotation, removeAnnotation, stripPrivate, genId, assetsDirName,
} from '../src/sidecar.js'
import type { Annotation, SidecarMeta } from '../src/types.js'

const meta: SidecarMeta = { version: 1, pdfName: '测试文档', pdfSha256: 'ab12' }
const pdfPath = '/tmp/测试 文档.pdf'

function ann(id: string, page = 3): Annotation {
  return {
    id,
    anchor: {
      page,
      quads: [{ x1: 10.5, y1: 20, x2: 100, y2: 32 }],
      pre: '前文上下文',
      post: '后文上下文',
      text: '被高亮的文字',
    },
    excerpt: '被高亮的文字',
    note: '我的批注',
    color: 'yellow',
    createdAt: '2026-07-04T12:00:00Z',
  }
}

describe('sidecar round-trip', () => {
  it('serialize -> parse preserves everything', () => {
    const a = ann('abc123')
    const text = serialize({ meta, annotations: [a] }, pdfPath)
    const sc = parse(text)
    expect(sc.meta.pdfName).toBe('测试文档')
    expect(sc.meta.pdfSha256).toBe('ab12')
    expect(sc.annotations).toHaveLength(1)
    const got = sc.annotations[0]
    expect(got.id).toBe('abc123')
    expect(got.orphan).toBe(false)
    expect(got.anchor).toEqual(a.anchor)
    expect(got.excerpt).toBe('被高亮的文字')
    expect(got.note).toBe('我的批注')
  })

  it('deep link is URL-encoded and jumpable', () => {
    const text = serialize({ meta, annotations: [ann('abc123')] }, pdfPath)
    expect(text).toContain('solopdf://open?file=%2Ftmp%2F%E6%B5%8B%E8%AF%95%20%E6%96%87%E6%A1%A3.pdf&page=3&annot=abc123')
  })
})

describe('external-edit preservation (the SoloMD contract)', () => {
  it('user edits note body in SoloMD; upsert of ANOTHER annotation preserves it', () => {
    let text = serialize({ meta, annotations: [ann('aaaaaa')] }, pdfPath)
    // simulate external edit: user rewrites their note
    text = text.replace('我的批注', '用户在 SoloMD 里改过的批注，**含粗体**')
    // app adds a second annotation
    text = upsertAnnotation(text, ann('bbbbbb', 7), pdfPath, meta)
    const sc = parse(text)
    expect(sc.annotations).toHaveLength(2)
    expect(sc.annotations.find((a) => a.id === 'aaaaaa')!.note)
      .toBe('用户在 SoloMD 里改过的批注，**含粗体**')
    expect(sc.annotations.find((a) => a.id === 'bbbbbb')!.anchor.page).toBe(7)
  })

  it('upsert of the SAME id replaces its section only', () => {
    let text = serialize({ meta, annotations: [ann('aaaaaa'), ann('bbbbbb', 7)] }, pdfPath)
    const updated = { ...ann('aaaaaa'), note: '更新后的批注' }
    text = upsertAnnotation(text, updated, pdfPath, meta)
    const sc = parse(text)
    expect(sc.annotations).toHaveLength(2)
    expect(sc.annotations.find((a) => a.id === 'aaaaaa')!.note).toBe('更新后的批注')
    expect(sc.annotations.find((a) => a.id === 'bbbbbb')!.note).toBe('我的批注')
  })

  it('user reorders sections — upsert still finds by id', () => {
    const a = ann('aaaaaa')
    const b = ann('bbbbbb', 7)
    let text = serialize({ meta, annotations: [a, b] }, pdfPath)
    // swap the two ## sections manually
    const secA = text.slice(text.indexOf('## p.3'), text.indexOf('## p.7'))
    const secB = text.slice(text.indexOf('## p.7'))
    text = text.slice(0, text.indexOf('## p.3')) + secB + secA
    text = upsertAnnotation(text, { ...b, note: 'x' }, pdfPath, meta)
    const sc = parse(text)
    expect(sc.annotations.find((x) => x.id === 'bbbbbb')!.note).toBe('x')
    expect(sc.annotations.find((x) => x.id === 'aaaaaa')!.note).toBe('我的批注')
  })
})

describe('anchor-comment deletion degrades to plain note', () => {
  it('parses as orphan, keeps body', () => {
    let text = serialize({ meta, annotations: [ann('aaaaaa')] }, pdfPath)
    text = text.split('\n').filter((l) => !l.includes('solopdf:anchor')).join('\n')
    const sc = parse(text)
    expect(sc.annotations).toHaveLength(1)
    expect(sc.annotations[0].orphan).toBe(true)
    expect(sc.annotations[0].note).toBe('我的批注')
    // page recovered from header
    expect(sc.annotations[0].anchor.page).toBe(3)
  })

  it('corrupt anchor JSON also degrades, not crashes', () => {
    let text = serialize({ meta, annotations: [ann('aaaaaa')] }, pdfPath)
    text = text.replace(/solopdf:anchor aaaaaa \{.*\}/, 'solopdf:anchor aaaaaa {broken json')
    const sc = parse(text)
    expect(sc.annotations[0].orphan).toBe(true)
  })
})

describe('remove + privacy strip', () => {
  it('removeAnnotation deletes exactly one section', () => {
    let text = serialize({ meta, annotations: [ann('aaaaaa'), ann('bbbbbb', 7)] }, pdfPath)
    text = removeAnnotation(text, 'aaaaaa')
    const sc = parse(text)
    expect(sc.annotations.map((a) => a.id)).toEqual(['bbbbbb'])
  })

  it('stripPrivate removes excerpt AND pre/post fingerprints', () => {
    const s = stripPrivate(ann('aaaaaa'))
    expect(s.excerpt).toBe('')
    expect(s.anchor.pre).toBe('')
    expect(s.anchor.post).toBe('')
    expect(s.anchor.text).toBeUndefined()
    expect(s.anchor.quads).toHaveLength(1) // quads survive — two-factor fallback
  })

  it('genId produces 6 url-safe chars', () => {
    for (let i = 0; i < 50; i++) expect(genId()).toMatch(/^[a-z0-9]{6}$/)
  })
})

describe('highlight color persistence', () => {
  it('round-trips non-yellow colors through the sidecar', async () => {
    const { upsertAnnotation, parse, genId } = await import('../src/sidecar.js')
    const a = {
      id: genId(),
      anchor: { page: 3, quads: [], pre: 'aa', post: 'bb', text: 'needle' },
      excerpt: 'needle', note: '', color: 'green', createdAt: '',
    }
    const text = upsertAnnotation('', a as any, '/tmp/x.pdf', { version: 1, pdfName: 'x' })
    expect(parse(text).annotations[0].color).toBe('green')
    // yellow 缺省不写入,旧文件不变
    const b = { ...a, id: genId(), color: 'yellow' }
    const text2 = upsertAnnotation(text, b as any, '/tmp/x.pdf', { version: 1, pdfName: 'x' })
    expect(text2).not.toContain('"color":"yellow"')
    expect(parse(text2).annotations.find((x) => x.id === b.id)?.color).toBe('yellow')
  })
})

describe('mark kinds, notes and region screenshots', () => {
  const base = {
    anchor: { page: 4, quads: [{ x1: 1, y1: 2, x2: 3, y2: 4 }], pre: 'aa', post: 'bb', text: 'needle' },
    excerpt: 'needle', note: '', color: 'yellow', createdAt: '',
  }

  it('round-trips every non-default kind', () => {
    for (const kind of ['underline', 'strike', 'squiggly', 'note', 'region'] as const) {
      const a = { ...base, id: genId(), kind }
      const text = upsertAnnotation('', a as any, pdfPath, meta)
      expect(parse(text).annotations[0].kind).toBe(kind)
    }
  })

  it('omits the default kind so v1 files stay byte-stable', () => {
    const a = { ...base, id: genId(), kind: 'highlight' as const }
    const text = upsertAnnotation('', a as any, pdfPath, meta)
    expect(text).not.toContain('"kind"')
    expect(parse(text).annotations[0].kind).toBe('highlight')
  })

  it('reads a v1 sidecar (no kind field) as a highlight', () => {
    const text = serialize({ meta, annotations: [ann('aaaaaa')] }, pdfPath)
    expect(text).not.toContain('"kind"')
    expect(parse(text).annotations[0].kind).toBe('highlight')
  })

  it('region marks emit a Markdown image and keep it out of the note body', () => {
    const a = { ...base, id: 'rg0001', kind: 'region' as const, image: 'rg0001.png', excerpt: '', note: 'figure 3 #stats' }
    const text = upsertAnnotation('', a as any, '/docs/paper.pdf', { version: 1, pdfName: 'paper.pdf' })
    expect(text).toContain('](paper.annotations.assets/rg0001.png)')
    const got = parse(text).annotations[0]
    expect(got.image).toBe('rg0001.png')
    // the image line is ours — it must not leak into the user's note text
    expect(got.note).toBe('figure 3 #stats')
  })

  it("leaves a user's own inline image in the note body alone", () => {
    const a = { ...base, id: 'nt0001', note: 'see ![chart](./mine/chart.png) here' }
    const text = upsertAnnotation('', a as any, pdfPath, meta)
    expect(parse(text).annotations[0].note).toContain('![chart](./mine/chart.png)')
  })

  it('assetsDirName drops the extension, not the rest of the name', () => {
    expect(assetsDirName('paper.v2.final.pdf')).toBe('paper.v2.final.annotations.assets')
  })
})
