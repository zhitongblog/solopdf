#!/usr/bin/env node
/**
 * SoloPDF MCP server (shipped artifact, global rule #4).
 * Lets Claude / any MCP client drive SoloPDF's domain functions headlessly:
 * same pdf.js engine as the app, same core sidecar parser.
 *
 * Read-only by default; annotation writes require --allow-write.
 *
 *   claude mcp add solopdf -- node /path/to/dev-mcp/src/index.mjs [--allow-write]
 */
import { readFile, writeFile, mkdtemp, rm, readdir, mkdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { gunzipSync } from 'fflate'
import {
  parse, upsertAnnotation, genId, normalize, pageLinks, normalizePageLabels, compactPageLabels, exportSpec,
  pickTarget, guessLang, providerReady, translateWithProvider,
  collectAttachments, uniqueNames, layerRows, findLockedOcgs, radioGroups,
  scanPdfAnnotations, buildImports, spliceImports, importSummary, importedRefs, needsLineFix, fixLineDirections,
  readCitationInput, extractCitation, formatCitation, fetchDoiMetadata, CITE_FORMATS, pageDeepLink,
  compareDocuments,
} from '@solopdf/core'
import { inflateSync } from 'node:zlib'
// FB2 / TIFF go through the CLI's format module (same core parser as the app)
import { formatOf, loadFb2, fb2InfoJson, tiffInfoJson } from '../../cli/src/formats.mjs'

const ALLOW_WRITE = process.argv.includes('--allow-write')

const server = new McpServer({ name: 'solopdf', version: '0.1.0' })

/** pdfjs-dist package root: its packed CMaps are what turn non-embedded CJK
 *  fonts (STSong-Light + UniGB-UCS2-H …) into text instead of nothing */
const PDFJS_ROOT = nodePath.dirname(new URL(import.meta.resolve('pdfjs-dist/package.json')).pathname)

async function open(path, password) {
  if (!existsSync(path)) throw new Error(`文件不存在: ${path}`)
  const data = new Uint8Array(await readFile(path))
  return await getDocument({
    data, password, disableFontFace: true, verbosity: 0,
    cMapUrl: `${PDFJS_ROOT}/cmaps/`, cMapPacked: true,
    standardFontDataUrl: `file://${PDFJS_ROOT}/standard_fonts/`,
  }).promise
}

/** sidecar beside a document — same stem rule as the app (Rust file_stem) */
function sidecarPath(docPath) {
  return docPath.replace(/\.[^./\\]+$/, '') + '.annotations.md'
}

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] })

/**
 * A native helper (solopdf-doc / solopdf-ocr), same lookup rule as the CLI:
 * env override, else the NEWER of the release/debug builds (a stale release
 * build must not shadow the one just compiled), else PATH.
 */
function nativeBin(name, envKey) {
  if (process.env[envKey]) return process.env[envKey]
  const here = nodePath.dirname(new URL(import.meta.url).pathname)
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const built = ['release', 'debug']
    .map((p) => nodePath.resolve(here, `../../app/src-tauri/target/${p}/${exe}`))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return built[0] ?? exe
}
const docBin = () => nativeBin('solopdf-doc', 'SOLOPDF_DOC_BIN')
const ocrBin = () => nativeBin('solopdf-ocr', 'SOLOPDF_OCR_BIN')

/**
 * pdf.js polyfills its canvas globals from ITS OWN copy of @napi-rs/canvas;
 * rendering must use the same instance or the native module rejects the
 * Path2D. Resolving through pdf.js is what guarantees that.
 */
async function canvasBackend() {
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'))
  return req('@napi-rs/canvas')
}

server.tool(
  'solopdf_info',
  '读取文档信息：PDF 页数、书签数、元数据、页码标签（印刷页码，如罗马数字前言；按物理页区间压缩给出，null=无标签）；' +
    'FB2/.fbz/.fb2.zip 返回书名/作者/编码/章节数/目录；TIFF 返回页数与每页尺寸/压缩方式',
  { path: z.string(), password: z.string().optional() },
  async ({ path, password }) => {
    if (!existsSync(path)) throw new Error(`文件不存在: ${path}`)
    if (formatOf(path) === 'fb2') return text(await fb2InfoJson(path))
    if (formatOf(path) === 'tiff') return text(await tiffInfoJson(path))
    const doc = await open(path, password)
    const meta = await doc.getMetadata().catch(() => null)
    const outline = await doc.getOutline().catch(() => null)
    const count = (items) => (!items ? 0 : items.reduce((n, it) => n + 1 + count(it.items), 0))
    const labels = normalizePageLabels(await doc.getPageLabels().catch(() => null), doc.numPages)
    const out = {
      pages: doc.numPages,
      title: meta?.info?.Title || null,
      producer: meta?.info?.Producer || null,
      outlineEntries: count(outline),
      // physical page numbers stay the addressing scheme everywhere else;
      // these are the numbers printed on the paper
      pageLabels: labels ? compactPageLabels(labels) : null,
    }
    await doc.destroy()
    return text(out)
  },
)

server.tool(
  'solopdf_extract_text',
  '提取 PDF 指定页文字（与应用同引擎，NFKC 归一化前的原始文本）；FB2 时 from/to 按章节计',
  { path: z.string(), from: z.number().int().min(1).default(1), to: z.number().int().min(1).default(1), password: z.string().optional() },
  async ({ path, from, to, password }) => {
    if (!existsSync(path)) throw new Error(`文件不存在: ${path}`)
    if (formatOf(path) === 'tiff') throw new Error('TIFF 是图像，没有文字层')
    if (formatOf(path) === 'fb2') {
      const { book } = await loadFb2(path)
      const hi = Math.min(to, book.chapters.length)
      let out = ''
      for (let c = Math.min(from, hi); c <= hi; c++) out += `--- ch.${c} ${book.chapters[c - 1].title} ---\n${book.chapters[c - 1].text}\n`
      return text(out)
    }
    const doc = await open(path, password)
    let out = ''
    const hi = Math.min(to, doc.numPages)
    for (let p = Math.min(from, hi); p <= hi; p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      out += `--- p.${p} ---\n`
      for (const it of tc.items) if ('str' in it) out += it.str + (it.hasEOL ? '\n' : '')
      out += '\n'
    }
    await doc.destroy()
    return text(out)
  },
)

server.tool(
  'solopdf_cite',
  '论文引用信息（只读）：从 XMP/Info 元数据与前两页文字识别标题、作者、年份、DOI、arXiv 号，' +
  '生成 BibTeX / APA / GB/T 7714 引用。online=true 时才联网向 doi.org 查精确元数据（默认完全离线）',
  {
    path: z.string(),
    format: z.enum(['bibtex', 'apa', 'gbt', 'all']).default('all'),
    online: z.boolean().default(false),
    password: z.string().optional(),
  },
  async ({ path, format, online, password }) => {
    const doc = await open(path, password)
    let meta = extractCitation(await readCitationInput(doc, nodePath.basename(path)))
    await doc.destroy()
    let onlineError
    if (online) {
      try { meta = await fetchDoiMetadata(meta, (url, init) => fetch(url, init)) } catch (e) { onlineError = e.message }
    }
    const fmts = format === 'all' ? CITE_FORMATS : [format]
    return text({
      ...meta,
      link: pageDeepLink(nodePath.resolve(path), 1),
      citations: Object.fromEntries(fmts.map((f) => [f, formatCitation(meta, f)])),
      ...(onlineError ? { onlineError } : {}),
    })
  },
)

server.tool(
  'solopdf_links',
  '列出 PDF 的超链接（只读）：所在页、区域（PDF 坐标）、内部目标页与落点坐标，或外部 URL',
  {
    path: z.string(),
    from: z.number().int().min(1).default(1),
    to: z.number().int().min(1).optional(),
    password: z.string().optional(),
  },
  async ({ path, from, to, password }) => {
    const doc = await open(path, password)
    const hi = Math.min(to ?? doc.numPages, doc.numPages)
    const links = []
    for (let p = Math.min(from, hi); p <= hi; p++) {
      for (const l of await pageLinks(doc, p)) {
        const rect = l.rect.map((n) => Math.round(n * 100) / 100)
        links.push(l.target.kind === 'external'
          ? { page: p, rect, url: l.target.url }
          : { page: p, rect, target: l.target.dest.page, fit: l.target.dest.fit, x: l.target.dest.x, y: l.target.dest.y })
      }
    }
    await doc.destroy()
    const internal = links.filter((l) => l.target != null).length
    return text({ pages: [from, hi], count: links.length, internal, external: links.length - internal, links })
  },
)

server.tool(
  'solopdf_compare',
  '比较两个 PDF（只读，与应用「比较文档」同一算法）：按页文字相似度对齐（识别新增/删除的整页），'
    + '词级差异（中文按字），返回差异列表：类型 insert/delete/change、旧/新文档页码与文字；'
    + 'noTextA/noTextB 列出没有文字层、无法按文字比较的页（扫描件需先 OCR）',
  {
    a: z.string().describe('旧版本 PDF 路径'),
    b: z.string().describe('新版本 PDF 路径'),
    password: z.string().optional(),
    passwordB: z.string().optional(),
    limit: z.number().int().min(1).max(5000).default(500).describe('最多返回多少条差异'),
  },
  async ({ a, b, password, passwordB, limit }) => {
    const docA = await open(a, password)
    const docB = await open(b, passwordB ?? password)
    const pagesOf = async (doc) => {
      const pages = []
      for (let p = 1; p <= doc.numPages; p++) {
        const tc = await (await doc.getPage(p)).getTextContent()
        pages.push(tc.items.filter((it) => 'str' in it).map((it) => ({ str: it.str, hasEOL: !!it.hasEOL })))
      }
      return pages
    }
    const r = compareDocuments(await pagesOf(docA), await pagesOf(docB))
    await docA.destroy()
    await docB.destroy()
    return text({
      pagesA: r.pagesA,
      pagesB: r.pagesB,
      stats: r.stats,
      total: r.changes.length,
      noTextA: r.noTextA,
      noTextB: r.noTextB,
      // page alignment: a null side = the page exists only in the other file
      pairs: r.pairs.map((p) => [p.a, p.b]),
      changes: r.changes.slice(0, limit).map((c) => ({
        id: c.id,
        kind: c.kind,
        ...(c.pageInserted ? { pageInserted: c.pageInserted } : {}),
        ...(c.pageDeleted ? { pageDeleted: c.pageDeleted } : {}),
        a: { page: c.a.page, text: c.a.text },
        b: { page: c.b.page, text: c.b.text },
      })),
    })
  },
)

server.tool(
  'solopdf_read_annotations',
  '读取 PDF 的 .annotations.md 伴生批注（结构化 JSON）',
  { path: z.string() },
  async ({ path }) => {
    const sc = sidecarPath(path)
    if (!existsSync(sc)) return text({ annotations: [], note: '没有伴生批注文件' })
    return text(parse(await readFile(sc, 'utf-8')))
  },
)

server.tool(
  'solopdf_search',
  '在 PDF 全文中搜索（NFKC 归一化，返回页码与上下文）',
  { path: z.string(), query: z.string(), password: z.string().optional(), limit: z.number().int().default(20) },
  async ({ path, query, password, limit }) => {
    const doc = await open(path, password)
    const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '')
    const q = norm(query)
    const hits = []
    for (let p = 1; p <= doc.numPages && hits.length < limit; p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      let t = ''
      for (const it of tc.items) if ('str' in it) t += it.str
      t = norm(t)
      let from = 0
      while (hits.length < limit) {
        const at = t.indexOf(q, from)
        if (at < 0) break
        hits.push({ page: p, context: t.slice(Math.max(0, at - 20), at + q.length + 20) })
        from = at + q.length
      }
    }
    await doc.destroy()
    return text({ query, hits })
  },
)

server.tool(
  'solopdf_search_library',
  '在一个文件夹里跨文档搜索：先搜伴生批注（快），再搜正文',
  {
    dir: z.string(),
    query: z.string(),
    limit: z.number().int().default(50),
  },
  async ({ dir, query, limit }) => {
    const q = normalize(query)
    const lower = query.toLowerCase()
    const entries = await readdir(dir, { withFileTypes: true })
    const pdfs = entries.filter((e) => e.isFile() && /\.pdf$/i.test(e.name)).map((e) => nodePath.join(dir, e.name))
    const hits = []
    for (const file of pdfs) {
      const sc = sidecarPath(file)
      if (!existsSync(sc)) continue
      for (const a of parse(await readFile(sc, 'utf-8')).annotations) {
        const hay = `${a.excerpt}\n${a.note}`
        if (hay.toLowerCase().includes(lower)) {
          hits.push({ file: nodePath.basename(file), page: a.anchor.page, where: 'note', text: hay.replace(/\n/g, ' ').trim().slice(0, 160) })
        }
      }
    }
    for (const file of pdfs) {
      if (hits.length >= limit) break
      let doc
      try { doc = await open(file) } catch { continue }
      for (let p = 1; p <= doc.numPages && hits.length < limit; p++) {
        const page = await doc.getPage(p)
        const tc = await page.getTextContent()
        let t = ''
        for (const it of tc.items) if ('str' in it) t += it.str
        t = normalize(t)
        let at = t.indexOf(q)
        while (at >= 0 && hits.length < limit) {
          hits.push({ file: nodePath.basename(file), page: p, where: 'text', text: t.slice(Math.max(0, at - 30), at + q.length + 30) })
          at = t.indexOf(q, at + Math.max(1, q.length))
        }
      }
      await doc.destroy()
    }
    return text({ query, documents: pdfs.length, hits })
  },
)

server.tool(
  'solopdf_page_image',
  '把某一页渲染成 PNG 文件（与应用同引擎），返回写出的路径',
  {
    path: z.string(),
    page: z.number().int().min(1),
    out: z.string(),
    dpi: z.number().int().min(36).max(600).default(150),
    password: z.string().optional(),
  },
  async ({ path, page, out, dpi, password }) => {
    const { createCanvas } = await canvasBackend()
    const doc = await open(path, password)
    const p = await doc.getPage(Math.min(page, doc.numPages))
    const vp = p.getViewport({ scale: dpi / 72 })
    const canvas = createCanvas(Math.floor(vp.width), Math.floor(vp.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await p.render({ canvasContext: ctx, viewport: vp }).promise
    await writeFile(out, canvas.toBuffer('image/png'))
    await doc.destroy()
    return text({ written: out, width: canvas.width, height: canvas.height })
  },
)

server.tool(
  'solopdf_translate',
  '翻译一段文字（只读）。macOS 15+ 用本机 Apple 翻译（离线）；否则仅当环境变量配置了服务时联网：' +
    'SOLOPDF_DEEPL_KEY，或 SOLOPDF_OPENAI_BASE_URL + SOLOPDF_OPENAI_MODEL [+ SOLOPDF_OPENAI_KEY]。' +
    'to 省略 = 系统语言（原文已是该语言时译成英文）',
  { text: z.string(), to: z.string().optional(), fallback: z.string().optional() },
  async ({ text: input, to, fallback }) => {
    const sysLang = Intl.DateTimeFormat().resolvedOptions().locale || 'en'
    const picked = pickTarget(to ?? '', sysLang, guessLang(input))
    const fb = fallback ?? picked.fallback
    let native = null
    if (process.platform === 'darwin') {
      const r = spawnSync(ocrBin(), ['translate', '-', '--to', picked.target, '--fallback', fb], {
        input, encoding: 'utf8',
      })
      if (!r.error) {
        try { native = { ...JSON.parse(r.stdout.trim()), engine: 'apple' } } catch { native = { error: (r.stderr || r.stdout).trim(), code: 'failed' } }
        if (!native.error || !['unavailable', 'unsupported'].includes(native.code)) return text(native)
      }
    }
    const cfg = process.env.SOLOPDF_DEEPL_KEY
      ? { kind: 'deepl', deeplKey: process.env.SOLOPDF_DEEPL_KEY }
      : { kind: 'openai', baseUrl: process.env.SOLOPDF_OPENAI_BASE_URL, model: process.env.SOLOPDF_OPENAI_MODEL, apiKey: process.env.SOLOPDF_OPENAI_KEY }
    if (!providerReady(cfg)) {
      return text(native ?? { error: 'no translation engine (needs macOS 15+, or a provider configured via env)', code: 'noEngine' })
    }
    return text(await translateWithProvider(cfg, input, picked.target, fb, async (req) => {
      const r = await fetch(req.url, {
        method: 'POST',
        headers: Object.fromEntries([...req.headers, ['Content-Type', 'application/json']]),
        body: req.body,
      })
      return { status: r.status, body: await r.text() }
    }))
  },
)

server.tool(
  'solopdf_define',
  '查内置离线词典（CC-CEDICT，中英），按最长前缀匹配',
  { word: z.string() },
  async ({ word }) => {
    const here = nodePath.dirname(new URL(import.meta.url).pathname)
    const dictDir = process.env.SOLOPDF_DICT_DIR ?? nodePath.resolve(here, '../../app/public/dict')
    const FS = String.fromCharCode(31)
    const RS = String.fromCharCode(30)
    const cache = new Map()
    const shard = async (bucket) => {
      if (cache.has(bucket)) return cache.get(bucket)
      const f = nodePath.join(dictDir, `${bucket}.dic`)
      if (!existsSync(f)) { cache.set(bucket, null); return null }
      const raw = new Uint8Array(await readFile(f))
      const t = new TextDecoder().decode(raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw)
      const map = new Map()
      for (const line of t.split('\n')) {
        const at = line.indexOf(FS)
        if (at > 0) map.set(line.slice(0, at), line.slice(at + 1))
      }
      cache.set(bucket, map)
      return map
    }
    const bucketOf = (w) => (w.codePointAt(0) ?? 0) % 128
    const lookup = async (w) => {
      const m = await shard(bucketOf(w))
      const blob = m?.get(w)
      if (!blob) return null
      if (blob.startsWith('>' + FS)) {
        const target = blob.slice(2)
        const other = await shard(bucketOf(target))
        const real = other?.get(target)
        return real ? { word: target, blob: real } : null
      }
      return { word: w, blob }
    }
    const chars = [...word]
    for (let n = Math.min(chars.length, 8); n >= 1; n--) {
      const hit = await lookup(chars.slice(0, n).join(''))
      if (hit) {
        return text({
          query: word,
          matched: hit.word,
          entries: hit.blob.split(RS).map((r) => {
            const [trad, pron, def] = r.split(FS)
            return { traditional: trad || null, pronunciation: pron || null, definition: def }
          }),
        })
      }
    }
    return text({ query: word, matched: null, entries: [] })
  },
)

// ── annotations made in other apps (Acrobat / Preview / Zotero …) ──────────

/** like open(), plus the CMaps non-embedded CJK fonts need — excerpts of a
 *  highlight on Chinese text come back empty without them */
async function openForImport(path, password) {
  if (!existsSync(path)) throw new Error(`文件不存在: ${path}`)
  const data = new Uint8Array(await readFile(path))
  const root = nodePath.dirname(new URL(import.meta.resolve('pdfjs-dist/package.json')).pathname)
  const doc = await getDocument({
    data: data.slice(), password, disableFontFace: true, verbosity: 0,
    cMapUrl: `${root}/cmaps/`, cMapPacked: true, standardFontDataUrl: `file://${root}/standard_fonts/`,
  }).promise
  return { doc, data }
}

/** scan + plan an import against the current sidecar (shared by both tools) */
async function planImport(path, password) {
  const { doc, data } = await openForImport(path, password)
  try {
    const unsupported = []
    const pdf = await scanPdfAnnotations(doc, [1, doc.numPages], unsupported)
    if (needsLineFix(pdf)) fixLineDirections(pdf, data)
    const sc = sidecarPath(path)
    const text = existsSync(sc) ? await readFile(sc, 'utf-8') : ''
    const parsed = text.trim() ? parse(text) : null
    const existing = parsed?.annotations ?? []
    const { annotations } = await buildImports(doc, pdf, existing, genId)
    return { pdf, unsupported, sc, text, parsed, existing, annotations }
  } finally {
    await doc.destroy()
  }
}

server.tool(
  'solopdf_pdf_annotations',
  '列出 PDF 文件内已有的注释（Acrobat/预览/Zotero 等其他应用留下的高亮、下划线、便签、手绘、图形…；只读）。' +
  '每条含所在页、类型、作者、日期、颜色、批注内容、划线下的原文，以及是否已导入 SoloPDF 伴生文件',
  { path: z.string(), password: z.string().optional() },
  async ({ path, password }) => {
    const { pdf, unsupported, existing, annotations } = await planImport(path, password)
    const preview = new Map(annotations.map((a) => [a.anchor.src.ref, a]))
    const imported = importedRefs(existing)
    return text({
      count: pdf.length,
      pending: annotations.length,
      unsupported: unsupported.map((u) => `${u.subtype}@p.${u.page}`),
      annotations: pdf.map((p) => ({
        ref: p.ref,
        page: p.page,
        subtype: p.subtype,
        author: p.author,
        date: p.date,
        color: p.color,
        contents: p.contents,
        inReplyTo: p.inReplyTo ?? null,
        // what the import would write (null for replies — they join their parent's note)
        kind: preview.get(p.ref)?.kind ?? null,
        excerpt: preview.get(p.ref)?.excerpt ?? null,
        imported: imported.has(p.ref),
      })),
    })
  },
)

server.tool(
  'solopdf_attachments',
  '列出 PDF 的嵌入附件（只读）：文档级附件 + 页面上的回形针（FileAttachment 注释）；含名称、大小、说明、所在页、类型（pdf/book/image 可在 SoloPDF 打开，risky=可执行文件只可另存，other=交给系统）。导出到磁盘用 solopdf_extract_attachment（需 --allow-write）',
  { path: z.string(), password: z.string().optional() },
  async ({ path, password }) => {
    const doc = await open(path, password)
    const all = await collectAttachments(doc)
    await doc.destroy()
    return text({ count: all.length, attachments: all.map((a) => a.info) })
  },
)

server.tool(
  'solopdf_layers',
  '列出 PDF 的图层（可选内容 OCG，只读）：按文档 /Order 排列的图层与分组标题、默认可见性、是否锁定、所属单选组（同组只能开一个）',
  { path: z.string(), password: z.string().optional() },
  async ({ path, password }) => {
    const doc = await open(path, password)
    const config = await doc.getOptionalContentConfig()
    const has = config.getOrder() !== null
    const locked = has
      ? findLockedOcgs(new Uint8Array(await readFile(path)), (b) => inflateSync(b))
      : []
    const rows = has ? layerRows(config, locked) : []
    await doc.destroy()
    return text({
      count: rows.filter((r) => r.type === 'layer').length,
      radioGroups: has ? radioGroups(config) : [],
      layers: rows,
    })
  },
)

if (ALLOW_WRITE) {
  server.tool(
    'solopdf_extract_attachment',
    '把 PDF 的嵌入附件写到目录（需 --allow-write）。id 取自 solopdf_attachments；省略 id = 全部导出。文件名经过清洗（去目录、去保留字符、重名加序号），只写文件，从不执行',
    { path: z.string(), outDir: z.string(), id: z.string().optional(), password: z.string().optional() },
    async ({ path, outDir, id, password }) => {
      const doc = await open(path, password)
      const all = await collectAttachments(doc)
      await doc.destroy()
      const picked = id ? all.filter((a) => a.info.id === id) : all
      if (!picked.length) throw new Error(id ? `没有这个附件: ${id}` : '该 PDF 没有附件')
      await mkdir(outDir, { recursive: true })
      const names = uniqueNames(picked.map((a) => a.info.name))
      const written = []
      for (let i = 0; i < picked.length; i++) {
        const dest = nodePath.join(outDir, names[i])
        await writeFile(dest, picked[i].content)
        written.push({ id: picked[i].info.id, path: nodePath.resolve(dest), size: picked[i].info.size })
      }
      return text({ written })
    },
  )

  server.tool(
    'solopdf_import_annotations',
    '把 PDF 内其他应用留下的注释导入伴生批注文件（需 --allow-write；PDF 本身不改；已导入的不会重复导入；dryRun=true 只预览）',
    { path: z.string(), dryRun: z.boolean().default(false), password: z.string().optional() },
    async ({ path, dryRun, password }) => {
      const { pdf, unsupported, sc, text: before, parsed, existing, annotations } = await planImport(path, password)
      const meta = parsed?.meta.pdfName ? parsed.meta : { version: 1, pdfName: path.split('/').pop() }
      const written = !dryRun && annotations.length > 0
      if (written) await writeFile(sc, spliceImports(before, annotations, path, meta), 'utf-8')
      return text({ sidecar: sc, dryRun, written, ...importSummary(pdf, annotations, existing, unsupported) })
    },
  )

  server.tool(
    'solopdf_add_annotation',
    '向 PDF 的伴生批注文件追加一条批注（需 --allow-write 启动）',
    {
      path: z.string(),
      page: z.number().int().min(1),
      note: z.string(),
      excerpt: z.string().default(''),
    },
    async ({ path, page, note, excerpt }) => {
      const sc = sidecarPath(path)
      const existing = existsSync(sc) ? await readFile(sc, 'utf-8') : ''
      const name = path.split('/').pop()
      const a = {
        id: genId(),
        anchor: { page, quads: [], pre: '', post: '', text: excerpt || undefined },
        excerpt,
        note,
        color: 'yellow',
        createdAt: new Date().toISOString(),
      }
      const updated = upsertAnnotation(existing, a, path, { version: 1, pdfName: name })
      await writeFile(sc, updated, 'utf-8')
      return text({ written: sc, id: a.id })
    },
  )

  server.tool(
    'solopdf_export_annotated_pdf',
    '把伴生批注写成标准 PDF 注释，导出一份副本（原文件不动；需 --allow-write）',
    { path: z.string(), out: z.string(), author: z.string().default('SoloPDF') },
    async ({ path, out, author }) => {
      const sc = sidecarPath(path)
      if (!existsSync(sc)) throw new Error(`没有伴生批注文件: ${sc}`)
      const specs = []
      for (const a of parse(await readFile(sc, 'utf-8')).annotations) {
        // drawn marks (ink / shapes / text boxes) carry their geometry along
        const spec = exportSpec(a, { author })
        if (spec) specs.push(spec)
      }
      if (!specs.length) throw new Error('没有可导出的标注')
      const tmp = await mkdtemp(nodePath.join(os.tmpdir(), 'solopdf-mcp-'))
      try {
        const json = nodePath.join(tmp, 'annots.json')
        await writeFile(json, JSON.stringify(specs))
        execFileSync(docBin(), ['annotate', path, out, json])
        return text({ written: out, annotations: specs.length })
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    },
  )

  server.tool(
    'solopdf_pages',
    '页面操作：保留/重排指定页并另存为新文件（需 --allow-write）',
    {
      path: z.string(),
      out: z.string(),
      keep: z.string().describe('页码列表，如 "1,3-5"'),
      rotate: z.number().int().optional(),
      password: z.string().optional(),
    },
    async ({ path, out, keep, rotate, password }) => {
      const argv = ['pages', path, out, '--keep', keep]
      if (rotate) argv.push('--rotate', String(rotate))
      if (password) argv.push('--password', password)
      execFileSync(docBin(), argv)
      return text({ written: out })
    },
  )

  server.tool(
    'solopdf_merge',
    '合并多个 PDF 为一个新文件（需 --allow-write）',
    { out: z.string(), inputs: z.array(z.string()).min(2) },
    async ({ out, inputs }) => {
      execFileSync(docBin(), ['merge', out, ...inputs])
      return text({ written: out, merged: inputs.length })
    },
  )
}

const transport = new StdioServerTransport()
await server.connect(transport)
