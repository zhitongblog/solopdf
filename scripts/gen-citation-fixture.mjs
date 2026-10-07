#!/usr/bin/env node
/**
 * Generates two "paper" fixtures for citation extraction and the reading
 * ruler (two-column body text = column-aware line order):
 *
 *   test-fixtures/citation-paper.pdf     English arXiv preprint front matter
 *       Info dict is deliberately useless (Title "Microsoft Word - …docx",
 *       Author "admin") so title/authors must come from the first page;
 *       arXiv id in the header; page 2 cites another DOI in its references
 *       (must NOT be taken as this paper's DOI). The title and author list
 *       are those of arXiv:1706.03762 so "Fetch exact metadata" (doi.org →
 *       DataCite) has a real record to return; every sentence of body text
 *       is original filler written for this fixture.
 *   test-fixtures/citation-cn-paper.pdf  Chinese journal article
 *       proper UTF-16 Info Title/Author, DOI in the first-page footer,
 *       non-embedded STSong-Light like smart-refs-paper.pdf.
 *
 * Hand-written PDF objects, no dependency, byte-for-byte reproducible:
 *   node scripts/gen-citation-fixture.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-fixtures')

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
const ucs2 = (s) => [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('')
/** a PDF text string in UTF-16BE (for non-Latin Info entries) */
const utf16 = (s) => `<feff${ucs2(s)}>`

function line(x, y, text, size = 10, font = 'F1') {
  const cjk = /[　-鿿＀-￯]/.test(text)
  if (cjk) return `0 g BT /F2 ${size} Tf ${x} ${y} Td <${ucs2(text)}> Tj ET\n`
  return `0 g BT /${font} ${size} Tf ${x} ${y} Td (${esc(text)}) Tj ET\n`
}

/** greedy wrap at ~0.5em per Latin char, 1em per CJK char */
function wrap(text, width, size) {
  const out = []
  if (/[　-鿿]/.test(text)) {
    const per = Math.floor(width / size)
    for (let i = 0; i < text.length; i += per) out.push(text.slice(i, i + per))
    return out
  }
  const max = Math.floor(width / (size * 0.5))
  let cur = ''
  for (const w of text.split(' ')) {
    if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w } else cur = cur ? cur + ' ' + w : w
  }
  if (cur) out.push(cur)
  return out
}

/** a column of paragraphs from (x, top) downward; returns the content + next y */
function column(x, top, width, paras, size = 10, lead = 12.5, bottom = 60) {
  let y = top
  let s = ''
  const rest = []
  for (const p of paras) {
    if (y < bottom) { rest.push(p); continue }
    const heading = p.startsWith('# ')
    const text = heading ? p.slice(2) : p
    const lines = wrap(text, width, size)
    for (let i = 0; i < lines.length; i++) {
      if (y < bottom) { rest.push(lines.slice(i).join(' ')); break }
      s += line(x, y, lines[i], heading ? size + 1 : size, heading ? 'F3' : 'F1')
      y -= lead
    }
    y -= heading ? 2 : 5
  }
  return { s, y, rest }
}

function writePdf(file, pages, info) {
  const objs = []
  const add = (body) => { objs.push(body); return objs.length }
  const catalog = add(null)
  const pagesObj = add(null)
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const f3 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  const fd = add('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>')
  const cid = add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor ${fd} 0 R /DW 1000 /W [1 95 500] >>`)
  const f2 = add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light-UniGB-UCS2-H /Encoding /UniGB-UCS2-H /DescendantFonts [${cid} 0 R] >>`)
  const kids = []
  for (const content of pages) {
    const buf = Buffer.from(content, 'latin1')
    const c = add(`<< /Length ${buf.length} >>\nstream\n${content}endstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> >>`))
  }
  const infoObj = add(`<< ${info} >>`)
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
  const offsets = []
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  fs.writeFileSync(path.join(DIR, file), Buffer.from(out, 'latin1'))
  console.log(`wrote ${file} (${pages.length} pages, ${Buffer.byteLength(out, 'latin1')} bytes)`)
}

// ── English preprint ──
const BODY = [
  '# 1  Introduction',
  'This document is a test fixture for SoloPDF. It imitates the front page of a machine learning preprint so that the citation extractor has something realistic to read: a large title, a list of authors with affiliation marks, an abstract and two columns of running text.',
  'The paragraphs below are filler. They exist so that the reading ruler has many lines to walk through, and so that those lines sit in two columns whose baselines do not quite agree. A reader moving down the left column should stay in the left column until it ends, and only then continue at the top of the right one.',
  'Line focus tools are an accessibility aid. People with dyslexia or attention difficulties often lose their place on a dense page; a band that brightens the current line and dims the rest keeps the eye anchored without changing the layout of the document itself.',
  '# 2  Background',
  'Desktop readers have offered a magnifying loupe for many years. Holding a key shows a circle that renders the area under the pointer at a higher resolution, which helps with small print in figures, footnotes and scanned tables.',
  'Reference managers made a different habit popular: copying a formatted citation straight from the document being read. The metadata is often incomplete, so a good reader combines the document information dictionary, embedded XMP and what is printed on the first page.',
  '# 3  Method',
  'We read the first two pages, group text runs into lines, and treat the largest type near the top of the first page as the title. Name-shaped lines directly underneath become the author list, and identifiers such as a DOI or an arXiv number are matched with conservative patterns.',
  'Online enrichment is never automatic. Only when the reader asks for exact metadata does the application contact the DOI resolver, which answers with structured data in the citation style language format.',
  '# 4  Evaluation',
  'The fixture deliberately ships a useless information dictionary: its title is the name of a word processor file and its author is an account name. Both must be ignored in favour of the printed front matter.',
  'The second page cites another work by its DOI. That identifier belongs to the cited work, not to this document, and must not be reported as the DOI of this paper.',
  'Further filler text follows to fill the right column. Reading aids are only useful when they are predictable, so the ruler snaps to real text lines rather than to fixed pixel steps, and it follows the reading order of columns.',
  'When the last line on a page is reached, moving further continues on the next page. In paged layouts this turns the page; in continuous layouts the view scrolls so that the band stays comfortably inside the window.',
]
const p1 = [
  line(72, 768, 'arXiv:1706.03762v5  [cs.CL]  6 Dec 2017', 8),
  line(150, 720, 'Attention Is All You Need', 20, 'F3'),
  line(90, 690, 'Ashish Vaswani*, Noam Shazeer*, Niki Parmar*, Jakob Uszkoreit*', 10),
  line(90, 676, 'Llion Jones*, Aidan N. Gomez*, Lukasz Kaiser*, Illia Polosukhin*', 10),
  line(90, 662, 'Google Brain, Google Research, University of Toronto', 8),
  line(280, 636, 'Abstract', 11, 'F3'),
]
const abs = column(100, 620, 412, ['This fixture reproduces only the bibliographic front matter of a well known preprint; the abstract and all body paragraphs are placeholder text written for testing. It is used to check that titles, authors and identifiers are recovered from the printed page when the document information dictionary is wrong.'], 9.5, 11.5)
p1.push(abs.s)
const left = column(72, abs.y - 14, 224, BODY, 10, 12.5, 70)
const right = column(316, abs.y - 14, 224, left.rest, 10, 12.5, 70)
p1.push(left.s, right.s, line(300, 40, '1', 9))
const p2body = column(72, 740, 224, [...right.rest, ...BODY.slice(1, 6)], 10, 12.5, 70)
const p2right = column(316, 740, 224, [
  ...p2body.rest,
  '# References',
  '[1] A. Author and B. Author. Reading documents at scale. Journal of Tools, 12(3):1-20, 2019. doi:10.1000/other.2019.001',
  '[2] C. Writer. A survey of PDF readers. Tech. report, 2020.',
], 10, 12.5, 70)
writePdf('citation-paper.pdf', [p1.join(''), [p2body.s, p2right.s, line(300, 40, '2', 9)].join('')],
  "/Title (Microsoft Word - nips2017_final.docx) /Author (admin) /Producer (SoloPDF gen-citation-fixture) /CreationDate (D:20171206120000Z)")

// ── Chinese journal article ──
const CN = [
  '本文件是 SoloPDF 的测试样本，模仿中文期刊论文首页的版式：大号标题、作者行、单位行、摘要与关键词，以及页脚的 DOI。正文为占位文字。',
  '阅读标尺是一种无障碍辅助功能。它把当前行保持明亮，把其余部分调暗，帮助读者在密集的版面中不丢失位置。',
  '引用信息从文档信息字典、XMP 元数据与首页文字三处综合得出；联网补全只在用户主动点击时进行。',
]
const cnBody = column(72, 560, 468, CN, 10.5, 16, 90)
writePdf('citation-cn-paper.pdf', [[
  line(72, 768, '第 45 卷 第 3 期', 9), line(420, 768, '计算机学报', 9),
  line(110, 720, '基于注意力机制的文档版面分析方法', 20),
  line(220, 690, '张三 1）  李四 2）  王五 1）', 11),
  line(140, 672, '1）（清华大学计算机科学与技术系 北京 100084）', 9),
  line(140, 658, '2）（北京大学信息科学技术学院 北京 100871）', 9),
  line(72, 620, '摘 要 本文提出一种基于注意力机制的版面分析方法。', 9),
  line(72, 604, '关键词 版面分析；注意力机制；文档理解', 9),
  cnBody.s,
  line(72, 60, '收稿日期：2021-10-12；最终修改稿收到日期：2022-01-05。', 8),
  line(72, 46, 'DOI: 10.11897/SP.J.1016.2022.00001', 8),
].join('')], `/Title ${utf16('基于注意力机制的文档版面分析方法')} /Author ${utf16('张三; 李四; 王五')} /Producer (SoloPDF gen-citation-fixture) /CreationDate (D:20220301000000+08'00')`)
