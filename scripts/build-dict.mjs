#!/usr/bin/env node
/**
 * Build the bundled offline dictionary from CC-CEDICT.
 *
 * Output: app/public/dict/<bucket>.dic — 128 gzipped shards keyed by the first
 * codepoint of the headword, so a lookup pulls ~40KB instead of a 10MB file.
 * The shards live in public/ on purpose: Vite serves them in dev and copies
 * them into dist/, which Tauri then serves as ordinary frontend assets — no
 * separate resource plumbing, one code path on every platform.
 *
 * Size discipline (the whole thing ships inside a mobile app):
 *  - at most 3 senses, 120 characters per entry
 *  - the definition is stored ONCE, under the simplified headword; a
 *    differing traditional headword gets a one-field alias line
 *  - gzip, decompressed with fflate, which the app already carries for EPUB
 *
 * Source: CC-CEDICT (CC BY-SA 4.0)
 *   https://www.mdbg.net/chinese/dictionary?page=cc-cedict
 * Run:  node scripts/build-dict.mjs path/to/cedict_ts.u8
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '../app/public/dict')
const BUCKETS = 128
/** field / record separators: ASCII control codes never occur in CC-CEDICT */
const FS = String.fromCharCode(31)
const RS = String.fromCharCode(30)
const MAX_SENSES = 3
const MAX_DEF_LEN = 120

const src = process.argv[2]
if (!src) {
  console.error('usage: build-dict.mjs <cedict_ts.u8>')
  process.exit(1)
}

const bucketOf = (word) => (word.codePointAt(0) ?? 0) % BUCKETS

const shards = Array.from({ length: BUCKETS }, () => new Map())
let kept = 0
let skipped = 0

for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue
  // 傳統 简体 [pin1 yin1] /sense/sense/
  const m = line.match(/^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/)
  if (!m) { skipped++; continue }
  const [, trad, simp, pinyin, rest] = m
  const senses = rest.split('/').filter(Boolean).slice(0, MAX_SENSES)
  let def = senses.join('; ')
  if (def.length > MAX_DEF_LEN) def = def.slice(0, MAX_DEF_LEN - 1) + '…'
  // "variant of X" entries add bulk without helping a reader
  if (/^(variant of|old variant of|see [A-Z])/i.test(def) && senses.length === 1) { skipped++; continue }

  const record = [trad === simp ? '' : trad, pinyin, def].join(FS)
  const b = shards[bucketOf(simp)]
  const prev = b.get(simp)
  // one headword can carry several readings — keep them all
  b.set(simp, prev ? prev + RS + record : record)
  if (trad !== simp) {
    const ab = shards[bucketOf(trad)]
    if (!ab.has(trad)) ab.set(trad, '>' + FS + simp)
  }
  kept++
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
let total = 0
for (let i = 0; i < BUCKETS; i++) {
  const entries = [...shards[i].entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const text = entries.map(([k, v]) => k + FS + v).join('\n')
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 })
  // extension is .dic, NOT .gz: dev servers (Vite included) serve a .gz file
  // with Content-Encoding: gzip, the browser silently decompresses it, and our
  // own gunzip then fails on plain text. An opaque extension keeps dev and
  // production byte-identical.
  fs.writeFileSync(path.join(OUT, `${i}.dic`), gz)
  total += gz.length
}
fs.writeFileSync(
  path.join(OUT, 'LICENSE.txt'),
  'CC-CEDICT — Creative Commons Attribution-ShareAlike 4.0 International\n' +
    'https://www.mdbg.net/chinese/dictionary?page=cc-cedict\n' +
    'Bundled with SoloPDF for offline word lookup.\n',
)
console.log(
  `kept ${kept} entries (skipped ${skipped}), ${BUCKETS} shards, ` +
    `${(total / 1024 / 1024).toFixed(1)} MB gzipped`,
)
