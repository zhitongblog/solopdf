#!/usr/bin/env node
/**
 * Generates two fixtures for the "attachments + layers" features:
 *
 *  test-fixtures/attachments-sample.pdf  (2 pages)
 *    Document-level attachments (/Names /EmbeddedFiles):
 *      inner-report.pdf   a 1-page PDF          → opens as a new tab
 *      data.csv           text, with /Desc       → handed to the OS
 *      photo.png          64×48 PNG              → opens in the image viewer
 *      install.bat        "risky" executable     → Save only, never opened
 *    Page 1 carries a FileAttachment annotation (no appearance stream, so
 *    the reader must draw its own paperclip) holding annexe.pdf.
 *
 *  test-fixtures/layers-sample.pdf  (2 pages)
 *    Optional content (/OCProperties) with four OCGs:
 *      Base map   ON, LOCKED (/D /Locked)       grey block
 *      Labels     ON                            "LABEL TEXT" line
 *      Day        ON  ┐ radio group (/RBGroups)  yellow block
 *      Night      OFF ┘                          dark-blue block
 *    /Order nests Day + Night under a "Theme" heading.
 *
 * Hand-written PDF objects on purpose (no dependency, byte-for-byte
 * reproducible) — same approach as gen-page-labels-fixture.mjs.
 *
 * Run: node scripts/gen-attach-layers-fixtures.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.resolve(HERE, '../test-fixtures')

/** objects: string | Buffer bodies, 1-based ids in array order */
function buildPdf(objs, rootId) {
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  let len = parts[0].length
  const offsets = []
  objs.forEach((body, i) => {
    offsets.push(len)
    const b = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ])
    parts.push(b)
    len += b.length
  })
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) tail += `${String(o).padStart(10, '0')} 00000 n \n`
  tail += `trailer\n<< /Size ${objs.length + 1} /Root ${rootId} 0 R >>\nstartxref\n${len}\n%%EOF\n`
  parts.push(Buffer.from(tail, 'latin1'))
  return Buffer.concat(parts)
}

function streamObj(dict, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1')
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${buf.length} >>\nstream\n`, 'latin1'),
    buf,
    Buffer.from('\nendstream', 'latin1'),
  ])
}

/** a minimal one-page PDF with a title line — the embedded documents */
function tinyPdf(title, color) {
  const objs = []
  const add = (b) => { objs.push(b); return objs.length }
  const cat = add('')
  const pages = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const content = add(streamObj('', [
    `${color} rg 72 500 468 200 re f`,
    `0 g BT /F1 30 Tf 90 600 Td (${title}) Tj ET`,
    'BT /F1 14 Tf 72 460 Td (This PDF was embedded inside another PDF.) Tj ET',
  ].join('\n')))
  const page = add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`)
  objs[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`
  objs[cat - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  return buildPdf(objs, cat)
}

// ── PNG (no deps): 64×48 RGB gradient ──
const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = Math.round((x / (w - 1)) * 255)
      raw[o + 1] = Math.round((y / (h - 1)) * 200)
      raw[o + 2] = 180
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── attachments-sample.pdf ──
function attachmentsPdf() {
  const objs = []
  const add = (b) => { objs.push(b); return objs.length }
  const cat = add('')
  const pages = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  const embed = (name, mime, data, desc) => {
    const ef = add(streamObj(`/Type /EmbeddedFile /Subtype /${mime.replace('/', '#2F')} /Params << /Size ${data.length} >>`, data))
    const d = desc ? ` /Desc (${desc})` : ''
    return add(`<< /Type /Filespec /F (${name}) /UF (${name}) /EF << /F ${ef} 0 R >>${d} >>`)
  }
  const files = [
    ['inner-report.pdf', embed('inner-report.pdf', 'application/pdf', tinyPdf('Inner report', '0.85 0.92 1'), 'Quarterly report (embedded PDF)')],
    ['data.csv', embed('data.csv', 'text/csv', Buffer.from('city,population\nShanghai,24870895\nBeijing,21893095\n'), 'Raw numbers behind the chart')],
    ['install.bat', embed('install.bat', 'application/octet-stream', Buffer.from('@echo off\r\necho This file must never be executed by a PDF reader.\r\n'), null)],
    ['photo.png', embed('photo.png', 'image/png', png(64, 48), 'A small gradient image')],
  ]
  const annexe = embed('annexe.pdf', 'application/pdf', tinyPdf('Annexe (from paperclip)', '1 0.9 0.8'), 'Attached via a FileAttachment annotation')

  const c1 = add(streamObj('', [
    'BT /F1 26 Tf 72 700 Td (Attachments test document) Tj ET',
    'BT /F1 13 Tf 72 670 Td (This PDF carries four document-level attachments) Tj ET',
    'BT /F1 13 Tf 72 652 Td (\\(inner-report.pdf, data.csv, install.bat, photo.png\\)) Tj ET',
    'BT /F1 13 Tf 72 634 Td (and one FileAttachment annotation: the paperclip on the right.) Tj ET',
    'BT /F1 13 Tf 300 560 Td (Paperclip here -> ) Tj ET',
    '0.9 0.9 0.9 rg 72 300 468 200 re f',
  ].join('\n')))
  const fa = add(`<< /Type /Annot /Subtype /FileAttachment /Rect [430 550 450 578] /FS ${annexe} 0 R /Contents (annexe.pdf) /Name /Paperclip /F 4 >>`)
  const p1 = add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c1} 0 R /Annots [${fa} 0 R] >>`)
  const c2 = add(streamObj('', 'BT /F1 20 Tf 72 700 Td (Page 2 - no attachments here) Tj ET'))
  const p2 = add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c2} 0 R >>`)
  objs[pages - 1] = `<< /Type /Pages /Kids [${p1} 0 R ${p2} 0 R] /Count 2 >>`
  // name tree keys must be sorted
  const sorted = [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const names = sorted.map(([n, id]) => `(${n}) ${id} 0 R`).join(' ')
  objs[cat - 1] = `<< /Type /Catalog /Pages ${pages} 0 R /PageMode /UseAttachments /Names << /EmbeddedFiles << /Names [${names}] >> >> >>`
  return buildPdf(objs, cat)
}

// ── layers-sample.pdf ──
function layersPdf() {
  const objs = []
  const add = (b) => { objs.push(b); return objs.length }
  const cat = add('')
  const pages = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const base = add('<< /Type /OCG /Name (Base map) >>')
  const labels = add('<< /Type /OCG /Name (Labels) >>')
  const day = add('<< /Type /OCG /Name (Day) >>')
  const night = add('<< /Type /OCG /Name (Night) >>')
  const props = `/Properties << /oc1 ${base} 0 R /oc2 ${labels} 0 R /oc3 ${day} 0 R /oc4 ${night} 0 R >>`
  const res = `<< /Font << /F1 ${font} 0 R >> ${props} >>`
  const body = (n) => [
    `BT /F1 22 Tf 72 730 Td (Layers test - page ${n}) Tj ET`,
    'BT /F1 11 Tf 72 712 Td (Always visible. Toggle layers in the sidebar.) Tj ET',
    '/OC /oc1 BDC 0.6 g 72 420 468 260 re f EMC',
    '/OC /oc3 BDC 1 0.85 0.1 rg 110 460 180 180 re f EMC',
    '/OC /oc4 BDC 0.1 0.15 0.45 rg 320 460 180 180 re f EMC',
    '/OC /oc2 BDC 0 0 0 rg BT /F1 28 Tf 120 380 Td (LABEL TEXT) Tj ET EMC',
  ].join('\n')
  const ids = []
  for (const n of [1, 2]) {
    const c = add(streamObj('', body(n)))
    ids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents ${c} 0 R >>`))
  }
  objs[pages - 1] = `<< /Type /Pages /Kids [${ids.map((i) => `${i} 0 R`).join(' ')}] /Count 2 >>`
  const all = [base, labels, day, night].map((i) => `${i} 0 R`).join(' ')
  objs[cat - 1] =
    `<< /Type /Catalog /Pages ${pages} 0 R /PageMode /UseOC /OCProperties << /OCGs [${all}] ` +
    `/D << /Name (Default) /BaseState /ON /OFF [${night} 0 R] /Locked [${base} 0 R] ` +
    `/RBGroups [[${day} 0 R ${night} 0 R]] ` +
    `/Order [${base} 0 R ${labels} 0 R [(Theme) ${day} 0 R ${night} 0 R]] >> >> >>`
  return buildPdf(objs, cat)
}

for (const [name, buf] of [['attachments-sample.pdf', attachmentsPdf()], ['layers-sample.pdf', layersPdf()]]) {
  fs.writeFileSync(path.join(DIR, name), buf)
  console.log(`wrote ${path.join(DIR, name)} (${buf.length} bytes)`)
}
