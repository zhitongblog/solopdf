#!/usr/bin/env node
/**
 * Generates test-fixtures/smart-refs-paper.pdf — a 4-page "paper" with NO
 * link annotations, used to test smart references (hover "Figure 1",
 * "Table 1", "Eq. (2)", "[3]", "图 3" … and get a preview of the target).
 *
 * Hand-written PDF on purpose: no generator dependency, byte-for-byte
 * reproducible, and every caption / equation number / bibliography entry
 * sits at a known place:
 *
 *   p1  body text with every reference form (EN + 中文), eq (1),
 *       one dangling "Figure 9" that must NOT preview
 *   p2  Figure 1 (drawing, caption BELOW), Table 1 (caption ABOVE), eq (2)
 *   p3  Fig. 2 (English caption), 图 3 (Chinese caption)
 *   p4  References [1]–[5]
 *
 * Chinese text uses the non-embedded Adobe-GB1 font STSong-Light with the
 * UniGB-UCS2-H CMap — pdf.js resolves both from its bundled cmaps.
 *
 *   node scripts/gen-smartref-fixture.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-fixtures/smart-refs-paper.pdf')

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
const ucs2 = (s) => [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('')

/** one text line: Latin via F1 (Helvetica), CJK via F2 (STSong-Light) */
function line(x, y, text, size = 11, bold = false) {
  const cjk = /[　-鿿＀-￯]/.test(text)
  if (cjk) return `0 g BT /F2 ${size} Tf ${x} ${y} Td <${ucs2(text)}> Tj ET\n`
  return `0 g BT /${bold ? 'F3' : 'F1'} ${size} Tf ${x} ${y} Td (${esc(text)}) Tj ET\n`
}
/** mixed line: segments [text, x] on one baseline (equation + right number) */
const segs = (y, parts, size = 11) => parts.map(([t, x]) => line(x, y, t, size)).join('')

const pages = []

// ── page 1: the references ──
pages.push([
  line(72, 730, 'Smart References: A Test Paper', 18, true),
  line(72, 706, 'SoloPDF test fixture - no link annotations anywhere in this file', 9),
  line(72, 670, '1  Introduction', 13, true),
  line(72, 646, 'Our processing pipeline is shown in Figure 1 and the numbers are in Table 1.'),
  line(72, 630, 'The loss is defined in Eq. (2); substituting (1) into (2) gives the bound.'),
  line(72, 614, 'Prior work [2] and later studies [1, 3] looked at the same problem;'),
  line(72, 598, 'the overall architecture is sketched in Fig. 2 and surveyed in [5].'),
  line(72, 582, 'A dangling mention of Figure 9 must not produce any preview.'),
  line(72, 550, 'The classic identity we build on is'),
  segs(522, [['E = m c^2', 250], ['(1)', 520]]),
  line(72, 494, 'which holds in every inertial frame.'),
  line(72, 460, '2  中文段落', 13, true),
  line(72, 436, '如图 3 所示，系统由三部分组成；实验结果见表 1，'),
  line(72, 418, '损失函数见公式 (2)，相关工作见 [4]。'),
  line(72, 380, 'Nothing below this line refers to anything.'),
  line(72, 364, 'The interval [0, 1] is not a citation and (7) alone is not an equation.'),
].join(''))

// ── page 2: Figure 1 (caption below), Table 1 (caption above), eq (2) ──
pages.push([
  line(72, 740, 'Figure 1 shows how documents flow from parsing to rendering.'),
  // the figure: three boxes and arrows
  '0.85 0.9 1 rg 110 560 110 70 re f 250 560 110 70 re f 390 560 110 70 re f\n',
  '0.2 0.35 0.75 RG 2 w 110 560 110 70 re S 250 560 110 70 re S 390 560 110 70 re S\n',
  '220 595 m 250 595 l S 360 595 m 390 595 l S\n',
  line(140, 590, 'Parse', 12), line(275, 590, 'Layout', 12), line(420, 590, 'Render', 12),
  '0.95 0.7 0.3 rg 150 660 m 460 660 l 460 690 l 150 690 l f\n',
  line(250, 671, 'document pipeline', 11),
  line(72, 530, 'Figure 1: The processing pipeline, from parsing to rendering.', 10),
  // table 1: caption above, grid below
  line(72, 470, 'Table 1: Results on the benchmark (higher is better).', 10),
  '0 0 0 RG 0.8 w 110 360 380 90 re S 110 420 m 490 420 l S 110 390 m 490 390 l S 250 360 m 250 450 l S 370 360 m 370 450 l S\n',
  line(120, 430, 'Method', 10), line(260, 430, 'Accuracy', 10), line(380, 430, 'Speed', 10),
  line(120, 400, 'Baseline', 10), line(260, 400, '71.2', 10), line(380, 400, '1.0x', 10),
  line(120, 370, 'Ours', 10), line(260, 370, '84.9', 10), line(380, 370, '3.2x', 10),
  line(72, 320, 'We minimise the squared error'),
  segs(290, [['L = sum_i ( y_i - f(x_i) )^2', 220], ['(2)', 520]]),
  line(72, 262, 'over the whole training set.'),
].join(''))

// ── page 3: Fig. 2 and 图 3 ──
pages.push([
  line(72, 740, '3  Architecture', 13, true),
  '0.9 0.95 0.9 rg 120 520 360 180 re f 0.2 0.55 0.3 RG 2 w 120 520 360 180 re S\n',
  '0.2 0.55 0.3 rg 180 580 60 60 re f 270 580 60 60 re f 360 580 60 60 re f\n',
  line(200, 660, 'encoder', 11), line(290, 660, 'core', 11), line(370, 660, 'decoder', 11),
  line(72, 495, 'Fig. 2. Architecture overview: encoder, core and decoder.', 10),
  '1 0.93 0.85 rg 120 250 360 170 re f 0.8 0.45 0.1 RG 2 w 120 250 360 170 re S\n',
  '0.8 0.45 0.1 RG 200 300 m 300 380 l 400 300 l h S\n',
  line(72, 225, '图 3 系统结构示意：三部分之间的数据流。', 10),
].join(''))

// ── page 4: bibliography ──
pages.push([
  line(72, 730, 'References', 13, true),
  line(72, 704, '[1] A. Author and B. Author. Reading documents at scale. In Proc. DocEng, 2021.', 10),
  line(72, 686, '[2] C. Writer. A survey of PDF viewers. Journal of Tools, 12(3):1-20, 2019.', 10),
  line(72, 668, '[3] D. Reader. Hyperlinks considered helpful. Tech. report, 2020.', 10),
  line(72, 650, '[4] 张三，李四。中文文档的智能引用。计算机学报，2022。', 10),
  line(72, 632, '[5] E. Scholar. Smart references in practice. arXiv:2101.00001, 2021.', 10),
].join(''))

// ── serialize ──
const objs = [] // index = object number - 1
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
out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info << /Title (Smart references test paper) /Producer (SoloPDF gen-smartref-fixture) >> >>\nstartxref\n${xref}\n%%EOF\n`
fs.writeFileSync(OUT, Buffer.from(out, 'latin1'))
console.log(`wrote ${OUT} (${pages.length} pages, ${Buffer.byteLength(out, 'latin1')} bytes)`)
