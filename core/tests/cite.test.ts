import { describe, it, expect } from 'vitest'
import {
  findDoi, findArxivId, arxivYear, parsePdfYear, parseAuthorName, splitAuthors, isJunkTitle,
  extractCitation, firstPageHeuristics, toBibtex, toApa, toGbt, formatCitation, cslToCitation,
  fetchDoiMetadata, citeKey, citePageFromPdfjs, flattenXmp, readCitationInput,
  type CitePage, type CitationMeta,
} from '../src/cite.js'
import { pageDeepLink } from '../src/sidecar.js'

/** a fake first page: [text, size, y] lines, left-aligned */
function page(lines: [string, number, number][], height = 792): CitePage {
  return { height, items: lines.map(([str, size, y]) => ({ str, size, y, x: 72 })) }
}

const ATTENTION = page([
  ['arXiv:1706.03762v5 [cs.CL] 6 Dec 2017', 9, 770],
  ['Attention Is All You Need', 17, 700],
  ['Ashish Vaswani∗, Noam Shazeer∗, Niki Parmar∗, Jakob Uszkoreit∗', 10, 660],
  ['Llion Jones∗, Aidan N. Gomez∗†, Lukasz Kaiser∗, Illia Polosukhin∗‡', 10, 646],
  ['Google Brain, Google Research, University of Toronto', 9, 630],
  ['Abstract', 12, 590],
  ['The dominant sequence transduction models are based on complex recurrent networks.', 10, 570],
  ['We propose a new simple network architecture based solely on attention.', 10, 556],
  ['Experiments on two machine translation tasks show these models to be superior.', 10, 542],
])

describe('identifiers', () => {
  it('finds labelled and bare DOIs and trims punctuation', () => {
    expect(findDoi('DOI: 10.1145/3580305.3599999.')).toBe('10.1145/3580305.3599999')
    expect(findDoi('see https://doi.org/10.1038/nature14539)')).toBe('10.1038/nature14539')
    expect(findDoi('(doi:10.1016/S0140-6736(20)30183-5).')).toBe('10.1016/S0140-6736(20)30183-5')
    expect(findDoi('cited 10.1000/xyz123 in passing; doi 10.1145/1234.5678')).toBe('10.1145/1234.5678')
    expect(findDoi('DOI：10.11897/SP.J.1016.2022.00001。')).toBe('10.11897/SP.J.1016.2022.00001')
    expect(findDoi('no identifiers here')).toBeNull()
  })
  it('finds arXiv ids in all spellings', () => {
    expect(findArxivId('arXiv:1706.03762v5 [cs.CL] 6 Dec 2017')).toEqual({ id: '1706.03762', version: 'v5' })
    expect(findArxivId('https://arxiv.org/abs/2101.00001')).toEqual({ id: '2101.00001' })
    expect(findArxivId('arXiv: hep-th/9901001v2')).toEqual({ id: 'hep-th/9901001', version: 'v2' })
    expect(findArxivId('10.48550/arXiv.2303.08774')).toEqual({ id: '2303.08774' })
    expect(findArxivId('plain text')).toBeNull()
  })
  it('years from arXiv ids and PDF dates', () => {
    expect(arxivYear('1706.03762')).toBe(2017)
    expect(arxivYear('hep-th/9901001')).toBe(1999)
    expect(arxivYear('2413.00001')).toBeUndefined()
    expect(parsePdfYear("D:20170612093000+02'00'")).toBe(2017)
    expect(parsePdfYear('2021-03-04T10:00:00Z')).toBe(2021)
    expect(parsePdfYear(undefined)).toBeUndefined()
  })
})

describe('names', () => {
  it('parses given/family, particles, family-first, CJK', () => {
    expect(parseAuthorName('Aidan N. Gomez')).toEqual({ family: 'Gomez', given: 'Aidan N.' })
    expect(parseAuthorName('Ludwig van Beethoven')).toEqual({ family: 'van Beethoven', given: 'Ludwig' })
    expect(parseAuthorName('Vaswani, Ashish')).toEqual({ family: 'Vaswani', given: 'Ashish' })
    expect(parseAuthorName('张三')).toEqual({ family: '张三', literal: '张三' })
    expect(parseAuthorName('Plato')).toEqual({ family: 'Plato' })
  })
  it('splits author lists', () => {
    expect(splitAuthors('A. Smith and B. Jones')).toEqual(['A. Smith', 'B. Jones'])
    expect(splitAuthors('Alice Smith, Bob Jones, and Carol White')).toEqual(['Alice Smith', 'Bob Jones', 'Carol White'])
    expect(splitAuthors('Smith, John; Doe, Jane')).toEqual(['Smith, John', 'Doe, Jane'])
    expect(splitAuthors('Vaswani, Ashish')).toEqual(['Vaswani, Ashish'])
    expect(splitAuthors('Smith, J. A.')).toEqual(['Smith, J. A.'])
    expect(splitAuthors('张三，李四、王五')).toEqual(['张三', '李四', '王五'])
  })
  it('flags placeholder titles', () => {
    expect(isJunkTitle('Microsoft Word - paper_final.docx')).toBe(true)
    expect(isJunkTitle('PDF32000.book')).toBe(true)
    expect(isJunkTitle('untitled')).toBe(true)
    expect(isJunkTitle('paper_v3')).toBe(true)
    expect(isJunkTitle('draft', 'draft.pdf')).toBe(true)
    expect(isJunkTitle('Attention Is All You Need')).toBe(false)
    expect(isJunkTitle('深度学习综述')).toBe(false)
  })
})

describe('first-page heuristics', () => {
  it('title = largest type up top; authors = name lines under it', () => {
    const h = firstPageHeuristics(ATTENTION)
    expect(h.title).toBe('Attention Is All You Need')
    expect(h.authors).toEqual([
      'Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit',
      'Llion Jones', 'Aidan N. Gomez', 'Lukasz Kaiser', 'Illia Polosukhin',
    ])
  })
  it('a two-line title is joined; an affiliation line is not an author', () => {
    const h = firstPageHeuristics(page([
      ['Learning Transferable Visual Models From', 16, 720],
      ['Natural Language Supervision', 16, 700],
      ['Alec Radford, Jong Wook Kim', 11, 670],
      ['OpenAI, San Francisco', 9, 655],
      ['Abstract', 11, 620],
      ['body text body text body text body text', 10, 600],
      ['body text body text body text body text', 10, 588],
    ]))
    expect(h.title).toBe('Learning Transferable Visual Models From Natural Language Supervision')
    expect(h.authors).toEqual(['Alec Radford', 'Jong Wook Kim'])
  })
  it('Chinese journal front page', () => {
    const h = firstPageHeuristics(page([
      ['第 45 卷 第 3 期', 9, 770],
      ['基于注意力机制的文档版面分析方法', 18, 720],
      ['张三 1）  李四 2）  王五 1）', 11, 690],
      ['1）（清华大学计算机系 北京 100084）', 9, 675],
      ['摘 要 本文提出一种方法', 9, 640],
      ['正文正文正文正文正文正文正文正文', 10, 600],
      ['正文正文正文正文正文正文正文正文', 10, 585],
    ]))
    expect(h.title).toBe('基于注意力机制的文档版面分析方法')
    expect(h.authors).toEqual(['张三', '李四', '王五'])
  })
  it('a page set in one size has no detectable title', () => {
    expect(firstPageHeuristics(page([['just body text here', 10, 700], ['more body text', 10, 686]])).title).toBeUndefined()
  })
})

describe('extractCitation', () => {
  it('arXiv paper with a junk Info title falls back to the first page', () => {
    const m = extractCitation({
      info: { Title: 'Microsoft Word - nips2017.docx', Author: 'admin', CreationDate: 'D:20171206000000Z' },
      pages: [ATTENTION],
      fileName: '1706.03762v5.pdf',
    })
    expect(m.title).toBe('Attention Is All You Need')
    expect(m.source.title).toBe('firstPage')
    expect(m.authors).toHaveLength(8)
    expect(m.authors[5]).toEqual({ family: 'Gomez', given: 'Aidan N.' })
    expect(m.arxiv).toBe('1706.03762')
    expect(m.arxivVersion).toBe('v5')
    expect(m.year).toBe(2017)
    expect(m.source.year).toBe('arxiv')
    expect(m.type).toBe('preprint')
    expect(m.url).toBe('https://arxiv.org/abs/1706.03762')
  })
  it('XMP beats Info; prism fields make it a journal article', () => {
    const m = extractCitation({
      info: { Title: 'Something else', Author: 'Nobody Here' },
      xmp: {
        'dc:title': 'Deep learning',
        'dc:creator': ['Yann LeCun', 'Yoshua Bengio', 'Geoffrey Hinton'],
        'prism:doi': '10.1038/nature14539',
        'prism:publicationName': 'Nature',
        'prism:volume': '521', 'prism:number': '7553',
        'prism:startingPage': '436', 'prism:endingPage': '444',
        'prism:coverDate': '2015-05-28',
      },
    })
    expect(m).toMatchObject({
      title: 'Deep learning', year: 2015, doi: '10.1038/nature14539', journal: 'Nature',
      volume: '521', issue: '7553', pages: '436–444', type: 'article',
    })
    expect(m.authors.map((a) => a.family)).toEqual(['LeCun', 'Bengio', 'Hinton'])
    expect(m.source).toEqual({ title: 'xmp', authors: 'xmp', year: 'xmp' })
  })
  it('DOI from the first page footer; Info author list split', () => {
    const m = extractCitation({
      info: { Title: 'A Survey of PDF Readers', Author: 'Alice Smith; Bob Jones' },
      pages: [page([
        ['A Survey of PDF Readers', 16, 700],
        ['body', 10, 500],
        ['© 2023 ACM. DOI: https://doi.org/10.1145/3580305.3599999', 8, 40],
      ])],
    })
    expect(m.doi).toBe('10.1145/3580305.3599999')
    expect(m.authors.map((a) => a.family)).toEqual(['Smith', 'Jones'])
    expect(m.year).toBe(2023)
    expect(m.source.year).toBe('firstPage')
  })
  it('page-2 DOIs are citations on a real paper, the DOI on a cover page', () => {
    const body = Array.from({ length: 12 }, (_, i) => [`body text line number ${i} of the first page`, 10, 600 - i * 12] as [string, number, number])
    const p2 = page([['[3] A. Other. Some work. doi:10.1000/other.1', 9, 600]])
    expect(extractCitation({ pages: [page([['Title Words Here', 16, 700], ...body]), p2] }).doi).toBeUndefined()
    // a publisher cover sheet / scanned first page: page 2 is the article
    expect(extractCitation({ pages: [page([['Cover', 16, 700]]), page([['DOI: 10.1000/this.1', 9, 600]])] }).doi).toBe('10.1000/this.1')
  })
  it('received year is a lower bound; a nearby file date wins, a scan date does not', () => {
    const p = page([['Some Paper Title', 16, 700], ['Received 12 March 2019; accepted 2020', 8, 60]])
    expect(extractCitation({ pages: [p], info: { CreationDate: 'D:20200101' } }).year).toBe(2020)
    expect(extractCitation({ pages: [p], info: { CreationDate: 'D:20150101' } }).year).toBe(2019)
    expect(extractCitation({ pages: [p], info: { CreationDate: 'D:20240101' } }).year).toBe(2019)
    expect(extractCitation({ pages: [page([['Some Paper Title', 16, 700], ['© 2018 Elsevier Ltd.', 8, 50]])] }).year).toBe(2018)
  })
  it('account names and codes in Info /Author are not authors', () => {
    expect(extractCitation({ info: { Author: 'SE:W:CAR:MP' } }).authors).toEqual([])
    expect(extractCitation({ info: { Author: 'Administrator' } }).authors).toEqual([])
  })
  it('nothing at all → file name as title', () => {
    const m = extractCitation({ fileName: 'my_notes.pdf' })
    expect(m.title).toBe('my notes')
    expect(m.source.title).toBe('fileName')
    expect(m.authors).toEqual([])
  })
})

const ARTICLE: CitationMeta = {
  title: 'Deep learning',
  authors: [{ family: 'LeCun', given: 'Yann' }, { family: 'Bengio', given: 'Yoshua' }, { family: 'Hinton', given: 'Geoffrey' }],
  year: 2015, doi: '10.1038/nature14539', journal: 'Nature', volume: '521', issue: '7553', pages: '436–444',
  type: 'article', url: 'https://doi.org/10.1038/nature14539',
  source: { title: 'xmp', authors: 'xmp', year: 'xmp' },
}
const PREPRINT = extractCitation({ pages: [ATTENTION] })
const TODAY = new Date(2026, 9, 7)

describe('formatters', () => {
  it('BibTeX article', () => {
    expect(toBibtex(ARTICLE)).toBe([
      '@article{lecun2015deep,',
      '  title = {{Deep learning}},',
      '  author = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},',
      '  journal = {Nature},',
      '  volume = {521},',
      '  number = {7553},',
      '  pages = {436--444},',
      '  year = {2015},',
      '  doi = {10.1038/nature14539},',
      '  url = {https://doi.org/10.1038/nature14539}',
      '}',
    ].join('\n'))
  })
  it('BibTeX preprint carries eprint/archivePrefix and escapes specials', () => {
    const b = toBibtex(PREPRINT)
    expect(b.startsWith('@misc{vaswani2017attention,')).toBe(true)
    expect(b).toContain('eprint = {1706.03762}')
    expect(b).toContain('archivePrefix = {arXiv}')
    expect(b).toContain('author = {Vaswani, Ashish and Shazeer, Noam and')
    expect(toBibtex({ ...ARTICLE, title: 'R&D at 50% cost_1' })).toContain('title = {{R\\&D at 50\\% cost\\_1}}')
    expect(toBibtex({ ...ARTICLE, authors: [{ family: '张三', literal: '张三' }] })).toContain('author = {{张三}}')
  })
  it('APA 7', () => {
    expect(toApa(ARTICLE)).toBe(
      'LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539',
    )
    expect(toApa(PREPRINT)).toBe(
      'Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, L., & Polosukhin, I. (2017). ' +
      'Attention Is All You Need (arXiv:1706.03762). arXiv. https://doi.org/10.48550/arXiv.1706.03762',
    )
    expect(toApa({ ...ARTICLE, authors: [ARTICLE.authors[0]], year: undefined, doi: undefined, url: undefined }))
      .toBe('LeCun, Y. (n.d.). Deep learning. Nature, 521(7553), 436–444.')
    expect(toApa({ ...ARTICLE, authors: [] })).toMatch(/^Deep learning\. \(2015\)\. Nature/)
    expect(toApa({ ...ARTICLE, title: 'Is it?' })).toContain('(2015). Is it? Nature')
  })
  it('GB/T 7714', () => {
    expect(toGbt(ARTICLE, TODAY)).toBe(
      'LECUN Y, BENGIO Y, HINTON G. Deep learning[J]. Nature, 2015, 521(7553): 436-444. DOI:10.1038/nature14539.',
    )
    expect(toGbt(PREPRINT, TODAY)).toBe(
      'VASWANI A, SHAZEER N, PARMAR N, et al. Attention Is All You Need[EB/OL]. arXiv:1706.03762, 2017[2026-10-07]. https://arxiv.org/abs/1706.03762.',
    )
    const cn: CitationMeta = {
      title: '基于注意力机制的文档版面分析方法',
      authors: ['张三', '李四', '王五', '赵六'].map((n) => ({ family: n, literal: n })),
      year: 2022, journal: '计算机学报', volume: '45', issue: '3', pages: '1-12', type: 'article',
      source: { title: 'info', authors: 'info', year: 'info' },
    }
    expect(toGbt(cn, TODAY)).toBe('张三, 李四, 王五, 等. 基于注意力机制的文档版面分析方法[J]. 计算机学报, 2022, 45(3): 1-12.')
    expect(formatCitation(cn, 'gbt', TODAY)).toBe(toGbt(cn, TODAY))
    expect(formatCitation(ARTICLE, 'apa')).toBe(toApa(ARTICLE))
  })
  it('cite keys fold accents and skip stopwords', () => {
    expect(citeKey({ ...ARTICLE, authors: [{ family: 'Müller', given: 'Jörg' }], title: 'The Art of PDFs' })).toBe('muller2015art')
    expect(citeKey({ ...ARTICLE, authors: [], title: '中文标题', year: undefined })).toBe('anon')
  })
})

describe('online metadata (explicit)', () => {
  const CSL = {
    type: 'article-journal', title: 'Deep learning', DOI: '10.1038/nature14539',
    author: [{ family: 'LeCun', given: 'Yann' }, { family: 'Bengio', given: 'Yoshua' }, { family: 'Hinton', given: 'Geoffrey' }],
    'container-title': 'Nature', volume: '521', issue: '7553', page: '436-444',
    issued: { 'date-parts': [[2015, 5, 27]] }, publisher: 'Springer',
  }
  it('CSL-JSON → meta', () => {
    const m = cslToCitation(CSL)
    expect(m).toMatchObject({ title: 'Deep learning', year: 2015, journal: 'Nature', pages: '436–444', type: 'article' })
    expect(m.source).toEqual({ title: 'online', authors: 'online', year: 'online' })
  })
  it('DataCite arXiv record stays a preprint', () => {
    const m = cslToCitation({
      type: 'article', title: 'Attention Is All You Need', DOI: '10.48550/ARXIV.1706.03762', publisher: 'arXiv',
      'container-title': 'arXiv', author: [{ family: 'Vaswani', given: 'Ashish' }], issued: { 'date-parts': [[2017]] },
    })
    expect(m.type).toBe('preprint')
    expect(m.journal).toBeUndefined()
    expect(m.arxiv).toBe('1706.03762')
    expect(m.doi).toBe('10.48550/arXiv.1706.03762')
  })
  it('fetchDoiMetadata asks doi.org for CSL and merges', async () => {
    const calls: { url: string; accept?: string }[] = []
    const fake = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, accept: init?.headers?.Accept })
      return { ok: true, status: 200, json: async () => CSL }
    }
    const m = await fetchDoiMetadata({ ...ARTICLE, title: 'wrong', journal: undefined }, fake)
    expect(calls).toEqual([{ url: 'https://doi.org/10.1038/nature14539', accept: 'application/vnd.citationstyles.csl+json' }])
    expect(m.title).toBe('Deep learning')
    expect(m.journal).toBe('Nature')
  })
  it('arXiv-only documents use the arXiv DOI; 404 and no id are errors', async () => {
    const seen: string[] = []
    const nf = async (url: string) => { seen.push(url); return { ok: false, status: 404, json: async () => ({}) } }
    await expect(fetchDoiMetadata(PREPRINT, nf)).rejects.toThrow('doiNotFound')
    expect(seen[0]).toBe('https://doi.org/10.48550/arXiv.1706.03762')
    await expect(fetchDoiMetadata({ ...ARTICLE, doi: undefined, arxiv: undefined }, nf)).rejects.toThrow('noIdentifier')
    const hang = (_u: string, init?: { signal?: AbortSignal }) => new Promise<never>((_, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))
    })
    await expect(fetchDoiMetadata(ARTICLE, hang, 30)).rejects.toThrow('timeout')
  })
})

describe('pdf.js adapters', () => {
  it('text items → positioned runs; XMP iterable → record', () => {
    const p = citePageFromPdfjs([{ str: 'Hi', transform: [12, 0, 0, 12, 72, 700] }, { type: 'beginMarkedContent' }], [0, 0, 612, 792])
    expect(p).toEqual({ height: 792, items: [{ str: 'Hi', x: 72, y: 700, size: 12 }] })
    const md = { *[Symbol.iterator]() { yield ['dc:title', 'X'] as [string, unknown] } }
    expect(flattenXmp(md)).toEqual({ 'dc:title': 'X' })
    expect(flattenXmp(null)).toEqual({})
  })
  it('readCitationInput reads metadata + first pages', async () => {
    const doc = {
      numPages: 5,
      getMetadata: async () => ({ info: { Title: 'T' }, metadata: null }),
      getPage: async () => ({ view: [0, 0, 612, 792], getTextContent: async () => ({ items: [{ str: 'a', transform: [10, 0, 0, 10, 1, 2] }] }) }),
    }
    const inp = await readCitationInput(doc, 'x.pdf')
    expect(inp.pages).toHaveLength(2)
    expect(inp.info).toEqual({ Title: 'T' })
  })
  it('page deep link', () => {
    expect(pageDeepLink('/a b/c.pdf', 3)).toBe('solopdf://open?file=%2Fa%20b%2Fc.pdf&page=3')
  })
})
