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
import { existsSync } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { execFileSync } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { gunzipSync } from 'fflate'
import { parse, upsertAnnotation, genId, normalize, pageLinks } from '@solopdf/core'

const ALLOW_WRITE = process.argv.includes('--allow-write')

const server = new McpServer({ name: 'solopdf', version: '0.1.0' })

async function open(path, password) {
  if (!existsSync(path)) throw new Error(`文件不存在: ${path}`)
  const data = new Uint8Array(await readFile(path))
  return await getDocument({ data, password, disableFontFace: true, verbosity: 0 }).promise
}

function sidecarPath(pdfPath) {
  return pdfPath.replace(/\.pdf$/i, '') + '.annotations.md'
}

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] })

/** the native document driver, same lookup rule as the CLI */
function docBin() {
  if (process.env.SOLOPDF_DOC_BIN) return process.env.SOLOPDF_DOC_BIN
  const here = nodePath.dirname(new URL(import.meta.url).pathname)
  const exe = process.platform === 'win32' ? 'solopdf-doc.exe' : 'solopdf-doc'
  for (const rel of [`../../app/src-tauri/target/release/${exe}`, `../../app/src-tauri/target/debug/${exe}`]) {
    const p = nodePath.resolve(here, rel)
    if (existsSync(p)) return p
  }
  return exe // PATH
}

/** #rrggbb or a highlight colour name → 0–1 RGB */
function colorTriple(name) {
  const HEX = { yellow: '#ffd54f', green: '#81c784', blue: '#64b5f6', pink: '#f48fb1' }
  const hex = (HEX[name] ?? name).replace('#', '')
  const n = parseInt(hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex, 16)
  if (Number.isNaN(n)) return [1, 0.84, 0.31]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

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
  '读取 PDF 文档信息：页数、书签数、元数据、是否加密',
  { path: z.string(), password: z.string().optional() },
  async ({ path, password }) => {
    const doc = await open(path, password)
    const meta = await doc.getMetadata().catch(() => null)
    const outline = await doc.getOutline().catch(() => null)
    const count = (items) => (!items ? 0 : items.reduce((n, it) => n + 1 + count(it.items), 0))
    const out = {
      pages: doc.numPages,
      title: meta?.info?.Title || null,
      producer: meta?.info?.Producer || null,
      outlineEntries: count(outline),
    }
    await doc.destroy()
    return text(out)
  },
)

server.tool(
  'solopdf_extract_text',
  '提取 PDF 指定页文字（与应用同引擎，NFKC 归一化前的原始文本）',
  { path: z.string(), from: z.number().int().min(1).default(1), to: z.number().int().min(1).default(1), password: z.string().optional() },
  async ({ path, from, to, password }) => {
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

if (ALLOW_WRITE) {
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
        if (a.orphan || !a.anchor.quads?.length) continue
        specs.push({
          page: a.anchor.page,
          kind: a.kind ?? 'highlight',
          quads: a.anchor.quads.map((q) => [q.x1, q.y1, q.x2, q.y2]),
          color: colorTriple(a.color ?? 'yellow'),
          contents: a.note ?? '',
          author,
        })
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
