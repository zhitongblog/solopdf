#!/usr/bin/env node
/**
 * solopdf CLI — same pdf.js engine as the app, so text extraction matches
 * what the viewer sees (single-engine rule from the design doc).
 *
 *   solopdf info <file.pdf> [--password pw]
 *   solopdf extract-text <file.pdf> [--pages 1-5] [--password pw]
 *   solopdf links <file.pdf> [--pages 1-5]      # hyperlinks → JSON
 *   solopdf export-annotations <file.pdf>       # sidecar -> JSON
 *   solopdf selftest <fixtures-dir>             # acceptance run over fixtures
 *   solopdf annotate <file.pdf> [--out x.pdf]   # sidecar -> real PDF annots
 *   solopdf to-images <file.pdf> --out-dir d    # pages -> PNG/JPEG
 *   solopdf search <dir> <query>                # across a folder of documents
 *   solopdf dict <word>                         # bundled offline dictionary
 *   solopdf doc <…>                             # page ops, merge, compress, …
 *
 * Used by Claude/CI for self-testing (global rule #2) and by users for
 * scripting. Read-only EXCEPT the commands that name an explicit output
 * file; nothing here ever modifies its input.
 */
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync as require$readFileSync } from 'node:fs'
import path from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { parse, orderLinesForReading, pageLinks, normalizePageLabels, formatPageLabelRanges } from '@solopdf/core'

// piping into `head` etc. closes stdout early — exit quietly instead of crashing
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0) })

const args = process.argv.slice(2)
const cmd = args[0]

function flag(name) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : undefined
}

function die(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

/** pdfjs-dist package root (for wasm/cmap/font assets — CCITT/JBIG2/JPX
 *  scanned PDFs need the wasm decoders even for text extraction) */
function pdfjsRoot() {
  const pkg = new URL(import.meta.resolve('pdfjs-dist/package.json')).pathname
  return path.dirname(pkg)
}

async function open(file) {
  if (!existsSync(file)) die(`文件不存在: ${file}`)
  const data = new Uint8Array(await readFile(file))
  const root = pdfjsRoot()
  const task = getDocument({
    data,
    password: flag('password'),
    // node has no DOM canvas; disable font rendering paths we don't need
    disableFontFace: true,
    verbosity: 0,
    wasmUrl: `file://${root}/wasm/`,
    cMapUrl: `${root}/cmaps/`,
    // the bundled cmaps are the packed .bcmap files — without this, every
    // non-embedded CJK font (UniGB-UCS2-H …) silently extracts as nothing
    cMapPacked: true,
    standardFontDataUrl: `file://${root}/standard_fonts/`,
  })
  try {
    return await task.promise
  } catch (e) {
    if (String(e?.name) === 'PasswordException') {
      die(`该 PDF 受密码保护（用 --password 提供密码）: ${e.message}`)
    }
    throw e
  }
}

function parsePages(spec, numPages) {
  if (!spec) return [1, numPages]
  const m = spec.match(/^(\d+)(?:-(\d+))?$/)
  if (!m) die(`--pages 格式: N 或 A-B`)
  const a = parseInt(m[1], 10)
  const b = m[2] ? parseInt(m[2], 10) : a
  return [Math.max(1, a), Math.min(numPages, b)]
}

async function pageText(doc, p) {
  const page = await doc.getPage(p)
  const tc = await page.getTextContent()
  let out = ''
  for (const it of tc.items) {
    if ('str' in it) out += it.str + (it.hasEOL ? '\n' : '')
  }
  return out
}

async function cmdInfo(file) {
  const doc = await open(file)
  const meta = await doc.getMetadata().catch(() => null)
  const outline = await doc.getOutline().catch(() => null)
  const countOutline = (items) =>
    !items ? 0 : items.reduce((n, it) => n + 1 + countOutline(it.items), 0)
  // printed page numbers (roman front matter, restarts): compact ranges of
  // "physical-range: first–last label"; null when the PDF has none
  const labels = normalizePageLabels(await doc.getPageLabels().catch(() => null), doc.numPages)
  console.log(JSON.stringify({
    file: path.resolve(file),
    pages: doc.numPages,
    fingerprint: doc.fingerprints?.[0] ?? null,
    title: meta?.info?.Title || null,
    producer: meta?.info?.Producer || null,
    encrypted: !!meta?.info?.IsEncrypted || !!flag('password'),
    outlineEntries: countOutline(outline),
    pageLabels: labels ? formatPageLabelRanges(labels) : null,
  }, null, 2))
}

async function cmdExtract(file) {
  const doc = await open(file)
  const [a, b] = parsePages(flag('pages'), doc.numPages)
  for (let p = a; p <= b; p++) {
    process.stdout.write(await pageText(doc, p))
    process.stdout.write('\n\f\n')
  }
}

/** every Link annotation, resolved the same way the viewer resolves a click */
async function cmdLinks(file) {
  const doc = await open(file)
  const [a, b] = parsePages(flag('pages'), doc.numPages)
  const links = []
  for (let p = a; p <= b; p++) {
    for (const l of await pageLinks(doc, p)) {
      const r = l.rect.map((n) => Math.round(n * 100) / 100)
      links.push(l.target.kind === 'external'
        ? { page: p, rect: r, url: l.target.url }
        : {
            page: p, rect: r, target: l.target.dest.page,
            fit: l.target.dest.fit,
            x: l.target.dest.x, y: l.target.dest.y,
          })
    }
  }
  const internal = links.filter((l) => l.target != null).length
  console.log(JSON.stringify({
    file: path.resolve(file),
    pages: [a, b],
    count: links.length,
    internal,
    external: links.length - internal,
    links,
  }, null, 2))
}

async function cmdExportAnnotations(file) {
  const sidecar = file.replace(/\.pdf$/i, '') + '.annotations.md'
  if (!existsSync(sidecar)) die(`没有伴生批注文件: ${sidecar}`)
  const text = await readFile(sidecar, 'utf-8')
  const sc = parse(text)
  console.log(JSON.stringify(sc, null, 2))
}

async function cmdFormFields(file) {
  const doc = await open(file)
  const fields = await doc.getFieldObjects()
  if (!fields) {
    console.log(JSON.stringify({ file, fields: null, note: '无 AcroForm 表单域' }))
    return
  }
  const out = {}
  for (const [name, objs] of Object.entries(fields)) {
    const f = objs[0]
    out[name] = { type: f.type, value: f.value ?? '', page: (f.page ?? -1) + 1 }
  }
  console.log(JSON.stringify({ file, count: Object.keys(out).length, fields: out }, null, 2))
}

async function cmdExportMd(file) {
  const doc = await open(file)
  // outline -> headings
  const outline = []
  const walk = async (items, depth) => {
    for (const it of items ?? []) {
      try {
        let dest = it.dest
        if (typeof dest === 'string') dest = await doc.getDestination(dest)
        if (Array.isArray(dest) && dest[0]) outline.push({ title: it.title ?? '', page: (await doc.getPageIndex(dest[0])) + 1, depth })
      } catch {}
      if (it.items?.length) await walk(it.items, depth + 1)
    }
  }
  await walk(await doc.getOutline().catch(() => null), 0)
  const byPage = new Map()
  for (const o of outline.sort((a,b) => a.page - b.page)) {
    if (!byPage.has(o.page)) byPage.set(o.page, [])
    byPage.get(o.page).push(o)
  }
  const name = path.basename(file)
  process.stdout.write(`# ${name.replace(/\.pdf$/i, '')}\n\n> Source: ${name} · Pages: ${doc.numPages}\n\n`)
  for (let p = 1; p <= doc.numPages; p++) {
    for (const h of byPage.get(p) ?? []) process.stdout.write(`${'#'.repeat(Math.min(h.depth + 2, 6))} ${h.title}\n\n`)
    process.stdout.write(`<!-- p.${p} -->\n`)
    const t = await pageText(doc, p)
    if (t.trim()) process.stdout.write(t.trim() + '\n\n')
  }
}

/** locate a Rust helper binary (SOLOPDF_<NAME>_BIN overrides) */
function nativeBin(name) {
  const env = process.env[`SOLOPDF_${name.toUpperCase().replace(/-/g, '_')}_BIN`]
  if (env) return env
  const here = path.dirname(new URL(import.meta.url).pathname)
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  for (const rel of [
    `../../app/src-tauri/target/release/${exe}`,
    `../../app/src-tauri/target/debug/${exe}`,
    exe, // PATH
  ]) {
    const p = rel === exe ? exe : path.resolve(here, rel)
    if (rel === exe || existsSync(p)) return p
  }
  return exe
}

const ocrBin = () => nativeBin('solopdf-ocr')
const docBin = () => nativeBin('solopdf-doc')

/**
 * Get the canvas backend THROUGH pdf.js's own resolution root.
 *
 * pdf.js polyfills Path2D/DOMMatrix/ImageData by requiring @napi-rs/canvas
 * relative to itself. Under pnpm that can be a different physical copy from
 * the one this package depends on — and a Path2D from copy A handed to a
 * context from copy B fails deep inside the native module with
 * "Value is none of these types `String`, `Path`", which looks like a
 * corrupt PDF and is not. Resolving from pdf.js guarantees one instance.
 */
async function canvasBackend() {
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'))
  return req('@napi-rs/canvas')
}

/**
 * OCR a scanned PDF (or an image) into a searchable PDF or Markdown.
 * Pages render via the same pdf.js engine, OCR runs in the native
 * solopdf-ocr binary (Vision on macOS, PP-OCR ONNX on Win/Linux).
 */
async function cmdOcr(file) {
  const { execFileSync } = await import('node:child_process')
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises')
  const os = await import('node:os')
  const out = flag('out') ?? file.replace(/\.(pdf|png|jpe?g)$/i, '') + '-ocr.pdf'
  const lang = flag('lang') ?? 'zh'
  const bin = ocrBin()

  if (/\.(png|jpe?g)$/i.test(file)) {
    // image → plain text on stdout (pipe to a file for MD)
    process.stdout.write(execFileSync(bin, ['image', file, '--lang', lang]).toString())
    return
  }

  const { createCanvas } = await canvasBackend()
  const doc = await open(file)
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'solopdf-ocr-'))
  const pages = []
  const wantMd = /\.md$/i.test(out)
  const mdParts = [`# ${path.basename(file).replace(/\.pdf$/i, '')}`, '']
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const vp1 = page.getViewport({ scale: 1 })
      const scale = Math.min(2200 / Math.max(vp1.width, vp1.height), 4)
      const vp = page.getViewport({ scale })
      const canvas = createCanvas(Math.floor(vp.width), Math.floor(vp.height))
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport: vp }).promise
      const png = path.join(tmp, `p${p}.png`)
      await writeFile(png, canvas.toBuffer('image/png'))
      const lines = JSON.parse(execFileSync(bin, ['image', png, '--lang', lang, '--json']).toString())
      console.error(`  p.${p}/${doc.numPages}: ${lines.length} 行`)
      if (wantMd) {
        mdParts.push(`<!-- p.${p} -->`)
        for (const l of orderLinesForReading(lines)) mdParts.push(l.t)
        mdParts.push('')
      } else {
        // normalized image coords → PDF user space (same math as the app)
        pages.push({
          page: p - 1,
          lines: lines.map((l) => {
            const [ax, ay] = vp1.convertToPdfPoint(l.x * vp1.width, l.y * vp1.height)
            const [bx, by] = vp1.convertToPdfPoint((l.x + l.w) * vp1.width, (l.y + l.h) * vp1.height)
            return {
              text: l.t,
              x: Math.min(ax, bx), y: Math.min(ay, by),
              w: Math.abs(bx - ax), h: Math.abs(by - ay),
            }
          }),
        })
      }
    }
    if (wantMd) {
      await writeFile(out, mdParts.join('\n'))
    } else {
      const rj = path.join(tmp, 'results.json')
      await writeFile(rj, JSON.stringify(pages))
      execFileSync(bin, ['overlay', file, rj, out], { stdio: 'inherit' })
    }
    console.error(`✓ ${out}`)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}


// ── new commands ─────────────────────────────────────────────────────────

/** #rrggbb or a highlight colour name → 0–1 RGB, mirroring the app */
function colorTriple(name) {
  const HEX = { yellow: '#ffd54f', green: '#81c784', blue: '#64b5f6', pink: '#f48fb1' }
  const hex = (HEX[name] ?? name).replace('#', '')
  const n = parseInt(hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex, 16)
  if (Number.isNaN(n)) return [1, 0.84, 0.31]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/**
 * Sidecar marks → real PDF annotations, in a copy. Uses the STORED quads
 * rather than re-resolving fingerprints: the CLI has no viewer to relocate
 * against, and a mark whose quads are gone is skipped rather than guessed at.
 */
async function cmdAnnotate(file) {
  const { execFileSync } = await import('node:child_process')
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises')
  const os = await import('node:os')
  const sidecar = file.replace(/\.pdf$/i, '') + '.annotations.md'
  if (!existsSync(sidecar)) die(`没有伴生批注文件: ${sidecar}`)
  const sc = parse(await readFile(sidecar, 'utf-8'))
  const specs = []
  for (const a of sc.annotations) {
    if (a.orphan || !a.anchor.quads?.length) continue
    specs.push({
      page: a.anchor.page,
      kind: a.kind ?? 'highlight',
      quads: a.anchor.quads.map((q) => [q.x1, q.y1, q.x2, q.y2]),
      color: colorTriple(a.color ?? 'yellow'),
      contents: a.note ?? '',
      author: flag('author') ?? 'SoloPDF',
    })
  }
  if (!specs.length) die('没有可导出的标注（都失效或没有坐标）')
  const out = flag('out') ?? file.replace(/\.pdf$/i, '') + '-annotated.pdf'
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'solopdf-annot-'))
  try {
    const json = path.join(tmp, 'annots.json')
    await writeFile(json, JSON.stringify(specs))
    execFileSync(docBin(), ['annotate', file, out, json], { stdio: 'inherit' })
    console.error(`✓ ${specs.length} 条标注 → ${out}`)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Render pages to images with the same engine the app draws with. */
async function cmdToImages(file) {
  const { createCanvas } = await canvasBackend()
  const { writeFile, mkdir } = await import('node:fs/promises')
  const dir = flag('out-dir') ?? '.'
  const dpi = Number(flag('dpi') ?? 150)
  const fmt = (flag('format') ?? 'png').toLowerCase()
  await mkdir(dir, { recursive: true })
  const doc = await open(file)
  const [a, b] = parsePages(flag('pages'), doc.numPages)
  const stem = path.basename(file).replace(/\.pdf$/i, '')
  for (let p = a; p <= b; p++) {
    const page = await doc.getPage(p)
    const vp = page.getViewport({ scale: dpi / 72 })
    const canvas = createCanvas(Math.floor(vp.width), Math.floor(vp.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport: vp }).promise
    const name = path.join(dir, `${stem}-${String(p).padStart(3, '0')}.${fmt === 'jpeg' ? 'jpg' : 'png'}`)
    await writeFile(name, canvas.toBuffer(fmt === 'jpeg' ? 'image/jpeg' : 'image/png'))
    console.error(`✓ ${name}`)
  }
}

/**
 * Search a folder the way the app searches the shelf: annotations first
 * (instant, and usually what you wanted), then document text.
 */
async function cmdSearch(dir, query) {
  const { readdir } = await import('node:fs/promises')
  const { normalize } = await import('@solopdf/core')
  if (!query) die('用法: solopdf search <dir> <query>')
  const q = normalize(query)
  const lower = query.toLowerCase()
  const entries = await readdir(dir, { withFileTypes: true })
  const pdfs = entries.filter((e) => e.isFile() && /\.pdf$/i.test(e.name)).map((e) => path.join(dir, e.name))
  const hits = []

  for (const file of pdfs) {
    const sidecar = file.replace(/\.pdf$/i, '') + '.annotations.md'
    if (!existsSync(sidecar)) continue
    for (const a of parse(await readFile(sidecar, 'utf-8')).annotations) {
      const hay = `${a.excerpt}\n${a.note}`
      if (hay.toLowerCase().includes(lower)) {
        hits.push({ file: path.basename(file), page: a.anchor.page, where: 'note', text: hay.replace(/\n/g, ' ').trim().slice(0, 120) })
      }
    }
  }
  for (const file of pdfs) {
    let doc
    try { doc = await open(file) } catch { continue }
    for (let p = 1; p <= doc.numPages; p++) {
      const text = normalize(await pageText(doc, p))
      let at = text.indexOf(q)
      while (at >= 0) {
        hits.push({
          file: path.basename(file),
          page: p,
          where: 'text',
          text: text.slice(Math.max(0, at - 30), at + q.length + 30),
        })
        at = text.indexOf(q, at + Math.max(1, q.length))
        if (hits.length > 500) break
      }
      if (hits.length > 500) break
    }
    await doc.destroy()
    if (hits.length > 500) break
  }
  console.log(JSON.stringify({ query, documents: pdfs.length, hits }, null, 2))
}

/** Bundled offline dictionary — same shards the app ships. */
async function cmdDict(word) {
  const { gunzipSync } = await import('fflate')
  if (!word) die('用法: solopdf dict <词>')
  const here = path.dirname(new URL(import.meta.url).pathname)
  const dictDir = process.env.SOLOPDF_DICT_DIR ?? path.resolve(here, '../../app/public/dict')
  const FS = String.fromCharCode(31)
  const RS = String.fromCharCode(30)
  const shard = (bucket) => {
    const f = path.join(dictDir, `${bucket}.dic`)
    if (!existsSync(f)) return null
    const raw = new Uint8Array(require$readFileSync(f))
    const text = new TextDecoder().decode(raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw)
    const map = new Map()
    for (const line of text.split('\n')) {
      const at = line.indexOf(FS)
      if (at > 0) map.set(line.slice(0, at), line.slice(at + 1))
    }
    return map
  }
  const bucketOf = (w) => (w.codePointAt(0) ?? 0) % 128
  const lookup = (w) => {
    const m = shard(bucketOf(w))
    const blob = m?.get(w)
    if (!blob) return null
    if (blob.startsWith('>' + FS)) {
      const target = blob.slice(2)
      const other = shard(bucketOf(target))
      const real = other?.get(target)
      return real ? { word: target, records: real.split(RS).map((r) => r.split(FS)) } : null
    }
    return { word: w, records: blob.split(RS).map((r) => r.split(FS)) }
  }
  const chars = [...word]
  for (let n = Math.min(chars.length, 8); n >= 1; n--) {
    const hit = lookup(chars.slice(0, n).join(''))
    if (hit) {
      console.log(JSON.stringify({
        query: word,
        matched: hit.word,
        entries: hit.records.map(([trad, pron, def]) => ({ traditional: trad || null, pronunciation: pron || null, definition: def })),
      }, null, 2))
      return
    }
  }
  console.log(JSON.stringify({ query: word, matched: null, entries: [] }, null, 2))
}

/** Everything the native document driver does, forwarded verbatim. */
async function cmdDoc(rest) {
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(docBin(), rest, { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

async function cmdSelftest(dir) {
  // acceptance sweep over the standard fixture set (design doc test plan)
  const cases = [
    { f: 'chinese-wikipedia-hanzi.pdf', minPages: 20, expectText: '漢字文化圈' },
    { f: 'toc-pdf-spec-iso32000.pdf', minPages: 700, expectOutline: 800 },
    { f: 'scanned-sherlock-1892.pdf', minPages: 300 },
    { f: 'scanned-no-textlayer.pdf', minPages: 10, expectNoText: true },
    { f: 'form-irs-w9.pdf', minPages: 6 },
    { f: 'encrypted-password-solopdf.pdf', minPages: 20, password: 'solopdf' },
    { f: 'large-britannica-v1.pdf', minPages: 1000, optional: true },
  ]
  let pass = 0, fail = 0, skip = 0
  for (const c of cases) {
    const file = path.join(dir, c.f)
    if (!existsSync(file)) {
      if (c.optional) { console.log(`SKIP ${c.f} (缺文件，可选)`); skip++; continue }
      console.log(`FAIL ${c.f}: 文件不存在`); fail++; continue
    }
    try {
      const data = new Uint8Array(await readFile(file))
      const doc = await getDocument({ data, password: c.password, disableFontFace: true, verbosity: 0 }).promise
      const problems = []
      if (doc.numPages < c.minPages) problems.push(`页数 ${doc.numPages} < ${c.minPages}`)
      if (c.expectText) {
        const t1 = (await pageText(doc, 1)).normalize('NFKC')
        if (!t1.includes(c.expectText)) problems.push(`第 1 页未找到「${c.expectText}」`)
      }
      if (c.expectNoText) {
        const t1 = (await pageText(doc, 1)).trim()
        if (t1.length > 0) problems.push(`预期无文字层但提取到 ${t1.length} 字符`)
      }
      if (c.expectOutline) {
        const outline = await doc.getOutline()
        const count = (items) => !items ? 0 : items.reduce((n, it) => n + 1 + count(it.items), 0)
        const n = count(outline)
        if (n < c.expectOutline) problems.push(`书签 ${n} < ${c.expectOutline}`)
      }
      if (problems.length) { console.log(`FAIL ${c.f}: ${problems.join('; ')}`); fail++ }
      else { console.log(`PASS ${c.f} (${doc.numPages} 页)`); pass++ }
      await doc.destroy()
    } catch (e) {
      console.log(`FAIL ${c.f}: ${e.message}`)
      fail++
    }
  }
  console.log(`\n${pass} pass, ${fail} fail, ${skip} skip`)
  process.exit(fail ? 1 : 0)
}

const file = args[1]
switch (cmd) {
  case 'info': await cmdInfo(file ?? die('用法: solopdf info <file.pdf>')); break
  case 'extract-text': await cmdExtract(file ?? die('用法: solopdf extract-text <file.pdf>')); break
  case 'links': await cmdLinks(file ?? die('用法: solopdf links <file.pdf> [--pages A-B]')); break
  case 'export-annotations': await cmdExportAnnotations(file ?? die('用法: solopdf export-annotations <file.pdf>')); break
  case 'form-fields': await cmdFormFields(file ?? die('用法: solopdf form-fields <file.pdf>')); break
  case 'export-md': await cmdExportMd(file ?? die('用法: solopdf export-md <file.pdf>')); break
  case 'ocr': await cmdOcr(file ?? die('用法: solopdf ocr <file.pdf|img> [--out x.pdf|x.md] [--lang zh|ja|en]')); break
  case 'annotate': await cmdAnnotate(file ?? die('用法: solopdf annotate <file.pdf> [--out x.pdf]')); break
  case 'to-images': await cmdToImages(file ?? die('用法: solopdf to-images <file.pdf> --out-dir <dir>')); break
  case 'search': await cmdSearch(file ?? die('用法: solopdf search <dir> <query>'), args[2]); break
  case 'dict': await cmdDict(file ?? die('用法: solopdf dict <词>')); break
  case 'doc': await cmdDoc(args.slice(1)); break
  case 'selftest': await cmdSelftest(file ?? die('用法: solopdf selftest <fixtures-dir>')); break
  default:
    console.log(`solopdf — SoloPDF 命令行工具（与应用同一渲染引擎）

用法:
  solopdf info <file.pdf> [--password pw]          文档信息（页数/书签/页码标签/元数据）
  solopdf extract-text <file.pdf> [--pages A-B]    提取文字
  solopdf links <file.pdf> [--pages A-B]           超链接列表（页、区域、内部目标页或 URL）→ JSON
  solopdf export-annotations <file.pdf>            批注伴生文件 → JSON
  solopdf form-fields <file.pdf>                   AcroForm 表单域与当前值 → JSON
  solopdf export-md <file.pdf>                     全文导出为 Markdown（stdout）
  solopdf ocr <file.pdf|img> [--out x.pdf|x.md]    本地 OCR：扫描件 → 可搜索 PDF / Markdown
  solopdf annotate <file.pdf> [--out x.pdf]        伴生批注 → 标准 PDF 注释（副本）
  solopdf to-images <file.pdf> --out-dir <dir>     页面 → PNG/JPEG（--dpi 150 --pages A-B）
  solopdf search <dir> <query>                     跨文件搜索（批注优先，再正文）
  solopdf dict <词>                                内置离线词典（CC-CEDICT）
  solopdf doc <子命令> …                            页面/合并/拆分/压缩/加密（solopdf-doc）
  solopdf selftest <fixtures-dir>                  标准测试集验收

  solopdf doc 的子命令：pages / merge / split / annotate / compress /
  images-to-pdf / protect / unprotect / info / djvu-info / djvu-page`)
    process.exit(cmd ? 1 : 0)
}
