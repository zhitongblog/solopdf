#!/usr/bin/env node
/**
 * Generates the document-compare pair:
 *
 *   test-fixtures/compare-contract-v1.pdf  (4 pages, the original)
 *   test-fixtures/compare-contract-v2.pdf  (5 pages, the revision)
 *
 * What changed from v1 to v2 (the acceptance list for `solopdf compare`
 * and the in-app compare view):
 *
 *   1. p2 → p2  changed sentence: "within thirty (30) days" → "within fifteen (15) days"
 *   2. p2 → p2  deleted paragraph: clause 2.3 on late-payment interest
 *   3. — → p3   inserted page: new "Schedule C - Data Protection"
 *   4. p3 → p4  Chinese clause gains 严格 …
 *   5. p3 → p4  … and 任何 (two character-level insertions)
 *   6. p4 → p5  changed word: "Zurich" → "Geneva" (governing law)
 *
 * Everything else (cover page, the rest of every section, signatures) is
 * identical, so any other reported difference is a bug — including the page
 * numbers in the footers, which shift by one after the inserted page and
 * must be recognised as page numbers, not reported as changes. Hand-written PDF
 * objects like the other generators: no dependency, byte-for-byte
 * reproducible. Chinese uses the non-embedded STSong-Light (Adobe-GB1).
 *
 *   node scripts/gen-compare-fixture.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-fixtures')

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
const ucs2 = (s) => [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('')

/** a page = list of [text, size?, bold?] lines, laid out top-down */
function layout(lines) {
  let y = 730
  let out = ''
  for (const l of lines) {
    if (l === '') { y -= 12; continue }
    const [text, size = 11, bold = false] = Array.isArray(l) ? l : [l]
    const cjk = /[　-鿿＀-￯]/.test(text)
    if (cjk) out += `0 g BT /F2 ${size} Tf 72 ${y} Td <${ucs2(text)}> Tj ET\n`
    else out += `0 g BT /${bold ? 'F3' : 'F1'} ${size} Tf 72 ${y} Td (${esc(text)}) Tj ET\n`
    y -= size + 7
  }
  return out
}
const H = (s) => [s, 13, true]

// ── shared pages ──
const cover = [
  ['Service Agreement', 20, true],
  ['服务协议', 16],
  '',
  'This Service Agreement (the "Agreement") is entered into by and between',
  'Acme Analytics Ltd. (the "Provider") and Blue River Trading Co. (the "Client").',
  '本协议由甲方与乙方本着平等互利的原则签订。',
  '',
  H('1  Definitions'),
  '"Services" means the data analysis services described in Schedule A.',
  '"Deliverables" means all reports, models and documents produced for the Client.',
  '"Confidential Information" means any non-public information disclosed by a party.',
  '"Effective Date" means the date of the last signature below.',
  '',
  'The headings in this Agreement are for convenience only.',
]

const payment = (v2) => [
  H('2  Fees and Payment'),
  '2.1 The Client shall pay the fees set out in Schedule B for the Services.',
  v2
    ? '2.2 The Client shall pay each invoice within fifteen (15) days of receipt.'
    : '2.2 The Client shall pay each invoice within thirty (30) days of receipt.',
  ...(v2 ? [] : [
    '2.3 Late payments accrue interest at one percent per month on the overdue',
    'amount until paid in full, without prejudice to any other remedy.',
  ]),
  '2.4 All fees are exclusive of value added tax, which the Client shall pay.',
  '2.5 The Provider may adjust its fees once per year with sixty days notice.',
  '',
  '付款方式：乙方应通过银行转账支付全部款项。',
]

const dataProtection = [
  H('Schedule C - Data Protection'),
  'The Provider processes personal data only on documented instructions of the Client.',
  'The Provider ensures that persons authorised to process the data are bound by',
  'confidentiality and implements appropriate technical and organisational measures.',
  'Sub-processors may be engaged only with the prior written consent of the Client.',
  '',
  '个人信息处理应当遵循合法、正当、必要原则。',
]

const confidentiality = (v2) => [
  H('3  Confidentiality'),
  'Each party shall keep the Confidential Information of the other party secret',
  'and use it solely for the purpose of performing this Agreement.',
  '',
  v2
    ? '双方应对本协议内容严格保密，未经对方书面同意不得向任何第三方披露。'
    : '双方应对本协议内容保密，未经对方书面同意不得向第三方披露。',
  '',
  'This obligation survives termination of the Agreement for five years.',
]

const termination = (v2) => [
  H('4  Term and Termination'),
  'This Agreement starts on the Effective Date and continues for twelve months.',
  'Either party may terminate this Agreement by written notice if the other party',
  'materially breaches it and fails to cure the breach within thirty days.',
  '',
  H('5  Governing Law'),
  `This Agreement is governed by the laws of Switzerland. Courts of ${v2 ? 'Geneva' : 'Zurich'}`,
  'have exclusive jurisdiction.',
  '',
  'Signed for the Provider: ____________    Signed for the Client: ____________',
]

function write(name, pages, title) {
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
  pages.forEach((lines, i) => {
    const content = layout(lines) + `0.45 g BT /F1 9 Tf 290 40 Td (${i + 1}) Tj ET\n`
    const buf = Buffer.from(content, 'latin1')
    const c = add(`<< /Length ${buf.length} >>\nstream\n${content}endstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> >>`))
  })
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
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info << /Title (${title}) /Producer (SoloPDF gen-compare-fixture) >> >>\nstartxref\n${xref}\n%%EOF\n`
  const file = path.join(DIR, name)
  fs.writeFileSync(file, Buffer.from(out, 'latin1'))
  console.log(`wrote ${file} (${pages.length} pages, ${Buffer.byteLength(out, 'latin1')} bytes)`)
}

write('compare-contract-v1.pdf', [cover, payment(false), confidentiality(false), termination(false)], 'Service Agreement v1')
write('compare-contract-v2.pdf', [cover, payment(true), dataProtection, confidentiality(true), termination(true)], 'Service Agreement v2')
