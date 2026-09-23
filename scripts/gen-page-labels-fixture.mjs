#!/usr/bin/env node
/**
 * Generates test-fixtures/page-labels-roman.pdf — a small book-shaped PDF
 * whose printed page numbers differ from the physical ones:
 *
 *   physical 1        label "Cover"      (prefix only, no numbering style)
 *   physical 2–5      labels i … iv      (/S /r  — front matter)
 *   physical 6–21     labels 1 … 16      (/S /D  — body restarts at 1)
 *   physical 22–24    labels A-1 … A-3   (/S /D /P (A-) — appendix)
 *
 * Every page prints both numbers ("Physical page N — printed label X") so a
 * reader can see at a glance whether navigation landed where it should.
 * Hand-written PDF objects on purpose: no dependency, byte-for-byte
 * reproducible, and the /PageLabels number tree is exactly what we mean.
 *
 * Run: node scripts/gen-page-labels-fixture.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '../test-fixtures/page-labels-roman.pdf')

const N = 24
const roman = (n) => ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'][n - 1]
function labelOf(p) {
  if (p === 1) return 'Cover'
  if (p <= 5) return roman(p - 1)
  if (p <= 21) return String(p - 5)
  return `A-${p - 21}`
}
const heading = (p) =>
  p === 1 ? 'Page Labels Test Book'
    : p <= 5 ? 'Front matter'
      : p <= 21 ? `Chapter ${Math.ceil((p - 5) / 4)}`
        : 'Appendix A'

const objs = [] // index = object number - 1
const add = (body) => { objs.push(body); return objs.length }

const catalog = add('') // filled below
const pagesObj = add('')
const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
const pageIds = []
for (let p = 1; p <= N; p++) {
  const label = labelOf(p)
  const lines = [
    `BT /F1 28 Tf 72 680 Td (${heading(p)}) Tj ET`,
    `BT /F1 16 Tf 72 630 Td (Physical page ${p} - printed label ${label}) Tj ET`,
    `BT /F1 12 Tf 72 600 Td (The quick brown fox jumps over the lazy dog. Page labels let a) Tj ET`,
    `BT /F1 12 Tf 72 584 Td (book number its front matter in roman numerals and restart at 1.) Tj ET`,
    // a mid-grey box and a dark bar so tint/invert checks have non-text pixels
    '0.55 g 72 380 220 160 re f',
    '0.1 0.3 0.7 rg 320 380 220 160 re f',
    `BT /F1 40 Tf 280 60 Td (${label}) Tj ET`,
  ].join('\n')
  const content = add(`<< /Length ${Buffer.byteLength(lines)} >>\nstream\n${lines}\nendstream`)
  pageIds.push(add(
    `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
  ))
}
objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${N} >>`
objs[catalog - 1] =
  `<< /Type /Catalog /Pages ${pagesObj} 0 R /PageMode /UseNone ` +
  '/PageLabels << /Nums [ 0 << /P (Cover) >> 1 << /S /r >> 5 << /S /D >> 21 << /S /D /P (A-) >> ] >> >>'

let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
const offsets = []
objs.forEach((body, i) => {
  offsets.push(Buffer.byteLength(out, 'latin1'))
  out += `${i + 1} 0 obj\n${body}\nendobj\n`
})
const xref = Buffer.byteLength(out, 'latin1')
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
fs.writeFileSync(OUT, Buffer.from(out, 'latin1'))
console.log(`wrote ${OUT} (${N} pages)`)
