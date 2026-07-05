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
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { parse, upsertAnnotation, genId } from '@solopdf/core'

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
}

const transport = new StdioServerTransport()
await server.connect(transport)
