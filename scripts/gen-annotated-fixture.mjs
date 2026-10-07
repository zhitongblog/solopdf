#!/usr/bin/env node
/**
 * Generates test-fixtures/annotated-by-other-apps.pdf — a 3-page PDF that
 * already carries standard annotations, the way Acrobat / Preview / Zotero
 * leave them behind. It is the fixture for "import embedded annotations":
 *
 *   p.1  Highlight ×2 (one spans two lines), Underline, StrikeOut, Squiggly,
 *        Text (sticky note, with its own /AP icon) + a reply (/IRT),
 *        FreeText, Popup (child of the first highlight)
 *   p.2  Ink (2 strokes), Square, Circle, Line with an arrow end drawn
 *        "\"-diagonal (pdf.js normalizes /L — the importer must read the
 *        raw direction back), plain Line, Polygon, a Stamp (unsupported →
 *        skipped) and a Highlight with the Hidden flag (never imported)
 *   p.3  Chinese text (STSong-Light, non-embedded) with a Highlight
 *
 * Text is set in Courier (every glyph 600/1000 em) and STSong (1000/1000),
 * so the quadpoints sit exactly on the words they name — the import can
 * then be checked against known excerpts. Hand-written PDF objects, no
 * dependency, byte-for-byte reproducible; every annotation object is left
 * uncompressed like most real-world writers do.
 *
 * Run: node scripts/gen-annotated-fixture.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '../test-fixtures/annotated-by-other-apps.pdf')

const objs = [] // index = object number - 1
const add = (body = '') => { objs.push(body); return objs.length }
const set = (n, body) => { objs[n - 1] = body }
const stream = (dict, data) => `<< ${dict} /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`
/** PDF text string, UTF-16BE with BOM when it isn't plain ASCII */
const str = (s) => /^[\x20-\x7e]*$/.test(s)
  ? `(${s.replace(/[()\\]/g, (c) => '\\' + c)})`
  : `<FEFF${[...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`
const ucs2 = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase()

const catalog = add()
const pagesObj = add()
const courier = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>')
const helv = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
const fd = add('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>')
const cid = add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor ${fd} 0 R /DW 1000 /W [1 95 500] >>`)
const song = add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light-UniGB-UCS2-H /Encoding /UniGB-UCS2-H /DescendantFonts [${cid} 0 R] >>`)
const RES = `/Resources << /Font << /F1 ${courier} 0 R /F2 ${song} 0 R /Helv ${helv} 0 R >> >>`

// ── layout helpers (Courier 12pt: 7.2pt per char) ──────────────────────────
const X0 = 72
const CW = 7.2
const lineY = (i) => 650 - i * 22
/** box over chars [from, to) of a Courier line at baseline y */
const span = (line, from, to, y) => ({ x1: X0 + from * CW, x2: X0 + to * CW, y1: y - 3, y2: y + 10 })
const spanOf = (line, phrase, y) => {
  const at = line.indexOf(phrase)
  if (at < 0) throw new Error(`"${phrase}" not in "${line}"`)
  return span(line, at, at + phrase.length, y)
}
const qp = (boxes) => boxes.map((b) => `${b.x1} ${b.y2} ${b.x2} ${b.y2} ${b.x1} ${b.y1} ${b.x2} ${b.y1}`).join(' ')
const rectOf = (boxes) => [
  Math.min(...boxes.map((b) => b.x1)), Math.min(...boxes.map((b) => b.y1)),
  Math.max(...boxes.map((b) => b.x2)), Math.max(...boxes.map((b) => b.y2)),
].map((n) => +n.toFixed(2)).join(' ')
const COMMON = (author, date) =>
  `/T ${str(author)} /M (D:${date}+08'00') /CreationDate (D:${date}+08'00') /F 4`

// ── page 1: text marks + notes ─────────────────────────────────────────────
const p1Lines = [
  'Reading is the art of noticing what the author did not say.',
  'Good notes capture the claim, the evidence, and your doubt.',
  'This sentence is underlined in blue by a colleague.',
  'This obsolete sentence was struck out in red.',
  'A squiggly line marks a questionable statistic: 73%.',
  'The second highlight spans two lines of text so that',
  'the importer must join both quads into one excerpt.',
]
let c1 = 'BT /F1 18 Tf 72 720 Td (Annotated Sample - made in other apps) Tj ET\n'
p1Lines.forEach((l, i) => { c1 += `BT /F1 12 Tf ${X0} ${lineY(i)} Td (${l}) Tj ET\n` })
const p1 = add()
const p1Annots = []

const hl1Box = [spanOf(p1Lines[0], 'the art of noticing', lineY(0))]
const hl1 = add()
const popup1 = add(`<< /Type /Annot /Subtype /Popup /Rect [400 600 560 680] /Parent ${hl1} 0 R /Open false /F 28 >>`)
set(hl1, `<< /Type /Annot /Subtype /Highlight /Rect [${rectOf(hl1Box)}] /QuadPoints [${qp(hl1Box)}] ` +
  `/C [1 0.92 0.23] /CA 0.6 /Contents ${str('Key idea - worth quoting')} /NM (acro-hl-1) ` +
  `${COMMON('Alice Chen', '20240301093000')} /Popup ${popup1} 0 R /P ${p1} 0 R >>`)
p1Annots.push(hl1, popup1)

const hl2Box = [
  span(p1Lines[5], p1Lines[5].indexOf('spans'), p1Lines[5].length, lineY(5)),
  span(p1Lines[6], 0, p1Lines[6].indexOf('quads') + 'quads'.length, lineY(6)),
]
p1Annots.push(add(`<< /Type /Annot /Subtype /Highlight /Rect [${rectOf(hl2Box)}] /QuadPoints [${qp(hl2Box)}] ` +
  `/C [0.49 0.86 0.39] /Contents ${str('Two-line highlight')} ${COMMON('Alice Chen', '20240301093500')} /P ${p1} 0 R >>`))

const ulBox = [spanOf(p1Lines[2], 'underlined in blue', lineY(2))]
p1Annots.push(add(`<< /Type /Annot /Subtype /Underline /Rect [${rectOf(ulBox)}] /QuadPoints [${qp(ulBox)}] ` +
  `/C [0 0 1] ${COMMON('Bob Li', '20240302101500')} /P ${p1} 0 R >>`))

const soBox = [spanOf(p1Lines[3], 'obsolete sentence', lineY(3))]
p1Annots.push(add(`<< /Type /Annot /Subtype /StrikeOut /Rect [${rectOf(soBox)}] /QuadPoints [${qp(soBox)}] ` +
  `/C [1 0 0] /Contents ${str('Outdated since 2023')} ${COMMON('Bob Li', '20240302101600')} /P ${p1} 0 R >>`))

const sqBox = [spanOf(p1Lines[4], '73%', lineY(4))]
p1Annots.push(add(`<< /Type /Annot /Subtype /Squiggly /Rect [${rectOf(sqBox)}] /QuadPoints [${qp(sqBox)}] ` +
  `/C [0.6 0.2 0.8] /Contents ${str('Source?')} ${COMMON('Alice Chen', '20240301094000')} /P ${p1} 0 R >>`))

// sticky note WITH an appearance stream (a yellow speech box), like Acrobat
const noteAp = add(stream('/Type /XObject /Subtype /Form /BBox [0 0 20 20]',
  '1 0.8 0 rg 0 0 0 RG 1 w 0.5 4.5 19 15 re B 0 g 4 12 m 16 12 l S 4 8 m 13 8 l S'))
const note = add(`<< /Type /Annot /Subtype /Text /Rect [500 630 520 650] /Name /Comment /C [1 0.8 0] ` +
  `/Contents ${str('Check this against chapter 3.')} ${COMMON('Alice Chen', '20240301094500')} ` +
  `/AP << /N ${noteAp} 0 R >> /P ${p1} 0 R >>`)
const reply = add(`<< /Type /Annot /Subtype /Text /Rect [500 630 520 650] /IRT ${note} 0 R /RT /R /C [1 0.8 0] ` +
  `/Contents ${str('Agreed - see p.47.')} ${COMMON('Bob Li', '20240303080000')} /F 28 /P ${p1} 0 R >>`)
p1Annots.push(note, reply)

p1Annots.push(add(`<< /Type /Annot /Subtype /FreeText /Rect [72 470 330 500] ` +
  `/DA (/Helv 14 Tf 0.85 0.1 0.1 rg) /Contents ${str('Remember: evidence first!')} ` +
  `${COMMON('Alice Chen', '20240301095000')} /P ${p1} 0 R >>`))

const c1s = add(stream('', c1))
set(p1, `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ${RES} /Contents ${c1s} 0 R ` +
  `/Annots [${p1Annots.map((n) => `${n} 0 R`).join(' ')}] >>`)

// ── page 2: drawings and shapes ────────────────────────────────────────────
const c2 = 'BT /F1 18 Tf 72 720 Td (Page two: drawings and shapes) Tj ET\n' +
  `BT /F1 12 Tf 72 690 Td (Ink, boxes, an ellipse, an arrow, a line and a triangle.) Tj ET\n` +
  `BT /F1 12 Tf 72 120 Td (A hidden highlight sits on this line.) Tj ET\n`
const p2 = add()
const p2Annots = []
const wave = (y0) => Array.from({ length: 25 }, (_, i) => [90 + i * 8, y0 + Math.round(Math.sin(i / 2) * 120) / 10])
  .flat().map((n) => +n.toFixed(1)).join(' ')
p2Annots.push(add(`<< /Type /Annot /Subtype /Ink /Rect [80 590 300 660] /InkList [[${wave(640)}] [${wave(610)}]] ` +
  `/C [0.9 0.1 0.1] /BS << /W 2 >> ${COMMON('Alice Chen', '20240304110000')} /P ${p2} 0 R >>`))
p2Annots.push(add(`<< /Type /Annot /Subtype /Square /Rect [80 440 260 560] /C [0 0.4 1] /BS << /W 2 >> ` +
  `/Contents ${str('Figure region')} ${COMMON('Alice Chen', '20240304110500')} /P ${p2} 0 R >>`))
p2Annots.push(add(`<< /Type /Annot /Subtype /Circle /Rect [320 440 500 560] /C [0 0.6 0.2] /BS << /W 1.5 >> ` +
  `${COMMON('Bob Li', '20240304111000')} /P ${p2} 0 R >>`))
// "\" diagonal, arrowhead at the END (300,300): normalizeRect would flip it to "/"
p2Annots.push(add(`<< /Type /Annot /Subtype /Line /Rect [90 290 310 410] /L [100 400 300 300] /LE [/None /OpenArrow] ` +
  `/C [0.9 0.3 0] /BS << /W 2 >> /Contents ${str('Look here')} ${COMMON('Alice Chen', '20240304111500')} /P ${p2} 0 R >>`))
p2Annots.push(add(`<< /Type /Annot /Subtype /Line /Rect [315 295 525 405] /L [320 300 520 400] ` +
  `/C [0 0 0] /BS << /W 1 >> ${COMMON('Bob Li', '20240304112000')} /P ${p2} 0 R >>`))
p2Annots.push(add(`<< /Type /Annot /Subtype /Polygon /Rect [95 175 255 285] /Vertices [100 180 250 180 175 280] ` +
  `/C [0.5 0.2 0.7] /BS << /W 1.5 >> ${COMMON('Bob Li', '20240304112500')} /P ${p2} 0 R >>`))
p2Annots.push(add(`<< /Type /Annot /Subtype /Stamp /Rect [380 170 540 230] /Name /Approved /C [0.1 0.6 0.1] ` +
  `${COMMON('Alice Chen', '20240304113000')} /P ${p2} 0 R >>`))
const hidBox = [span('', 2, 8, 120)]
p2Annots.push(add(`<< /Type /Annot /Subtype /Highlight /Rect [${rectOf(hidBox)}] /QuadPoints [${qp(hidBox)}] ` +
  `/C [1 1 0] /T (Ghost) /F 6 /P ${p2} 0 R >>`))
const c2s = add(stream('', c2))
set(p2, `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ${RES} /Contents ${c2s} 0 R ` +
  `/Annots [${p2Annots.map((n) => `${n} 0 R`).join(' ')}] >>`)

// ── page 3: CJK ────────────────────────────────────────────────────────────
const zh = '汉字是记录汉语的文字，已有三千多年历史。'
const ZS = 16
const c3 = 'BT /F1 18 Tf 72 720 Td (Page three: CJK) Tj ET\n' +
  `0 g BT /F2 ${ZS} Tf 72 660 Td <${ucs2(zh)}> Tj ET\n`
const p3 = add()
const at = zh.indexOf('记录汉语')
const zhBox = [{ x1: 72 + at * ZS, x2: 72 + (at + 4) * ZS, y1: 656, y2: 674 }]
const zhHl = add(`<< /Type /Annot /Subtype /Highlight /Rect [${rectOf(zhBox)}] /QuadPoints [${qp(zhBox)}] ` +
  `/C [1 0.4 0.6] /Contents ${str('定义：记录语言的符号')} ${COMMON('王小明', '20240305090000')} /P ${p3} 0 R >>`)
const c3s = add(stream('', c3))
set(p3, `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ${RES} /Contents ${c3s} 0 R /Annots [${zhHl} 0 R] >>`)

set(pagesObj, `<< /Type /Pages /Kids [${p1} 0 R ${p2} 0 R ${p3} 0 R] /Count 3 >>`)
set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`)

let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
const offsets = []
objs.forEach((body, i) => {
  offsets.push(Buffer.byteLength(out, 'latin1'))
  out += `${i + 1} 0 obj\n${body}\nendobj\n`
})
const xref = Buffer.byteLength(out, 'latin1')
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info << /Producer (SoloPDF fixture generator) >> >>\nstartxref\n${xref}\n%%EOF\n`
fs.writeFileSync(OUT, Buffer.from(out, 'latin1'))
console.log(`wrote ${OUT} (3 pages, ${objs.length} objects)`)
