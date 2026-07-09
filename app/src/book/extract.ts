/**
 * 图书模式提取:pdf.js 文字层 → core reflow 输入。
 * 文本碎片先按基线聚成"行",转成归一化的 top-left 坐标,让 reflow
 * 的多栏/段落/跨页逻辑接手。目录书签映射为 OutlineEntry(分章标题)。
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  reflow, type ReflowDoc, type ReflowLine, type ReflowPageInput, type OutlineEntry,
} from '@solopdf/core'

interface RawItem {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
}

/** 碎片 → 行:按基线 y 聚类(容差 = 0.4×行高),行内按 x 排序拼接 */
function itemsToLines(items: RawItem[], pageW: number, pageH: number): ReflowLine[] {
  type Frag = { str: string; x: number; yBase: number; w: number; h: number }
  const frags: Frag[] = []
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue
    frags.push({
      str: it.str,
      x: it.transform[4],
      yBase: it.transform[5], // PDF y-up 基线
      w: it.width,
      h: it.height || Math.abs(it.transform[3]) || 10,
    })
  }
  frags.sort((a, b) => b.yBase - a.yBase || a.x - b.x) // 自上而下(y-up → 大 y 在上)
  const lines: ReflowLine[] = []
  let cur: Frag[] = []
  const flush = () => {
    if (!cur.length) return
    cur.sort((a, b) => a.x - b.x)
    let text = ''
    let prevEnd = -1
    for (const f of cur) {
      if (text && prevEnd >= 0) {
        const gap = f.x - prevEnd
        // 碎片间距超过 ~0.25 字高且两侧非 CJK → 补空格(pdf.js 常拆词)
        if (gap > f.h * 0.25 && !/[぀-ヿ㐀-鿿]$/.test(text) && !/^[぀-ヿ㐀-鿿]/.test(f.str)) {
          text += ' '
        }
      }
      text += f.str
      prevEnd = f.x + f.w
    }
    const x0 = cur[0].x
    const x1 = Math.max(...cur.map((f) => f.x + f.w))
    const h = Math.max(...cur.map((f) => f.h))
    const yTopPdf = Math.max(...cur.map((f) => f.yBase)) + h * 0.85 // 基线→行顶近似
    lines.push({
      t: text,
      x: x0 / pageW,
      y: Math.min(Math.max(1 - yTopPdf / pageH, 0), 1), // 转 top-left 原点
      w: (x1 - x0) / pageW,
      h: h / pageH,
      fontSize: h / pageH,
    })
    cur = []
  }
  for (const f of frags) {
    if (cur.length) {
      const ref = cur[0]
      if (Math.abs(f.yBase - ref.yBase) > Math.min(ref.h, f.h) * 0.5) flush()
    }
    cur.push(f)
  }
  flush()
  return lines
}

async function flattenOutline(doc: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const raw = await doc.getOutline().catch(() => null)
  if (!raw) return []
  const out: OutlineEntry[] = []
  const walk = async (items: any[], depth: number): Promise<void> => {
    for (const it of items) {
      try {
        let dest = it.dest
        if (typeof dest === 'string') dest = await doc.getDestination(dest)
        if (Array.isArray(dest) && dest[0]) {
          out.push({ title: it.title ?? '', page: (await doc.getPageIndex(dest[0])) + 1, depth })
        }
      } catch { /* skip */ }
      if (it.items?.length) await walk(it.items, depth + 1)
    }
  }
  await walk(raw, 0)
  return out
}

export interface BookExtractResult {
  doc: ReflowDoc
  /** 全书没有文字层(扫描件)→ 提示先 OCR */
  empty: boolean
}

export async function extractBook(
  doc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<BookExtractResult> {
  const outline = await flattenOutline(doc)
  const pages: ReflowPageInput[] = []
  let chars = 0
  for (let p = 1; p <= doc.numPages; p++) {
    if (isCancelled?.()) break
    const page = await doc.getPage(p)
    const vp = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const lines = itemsToLines(tc.items as RawItem[], vp.width, vp.height)
    chars += lines.reduce((n, l) => n + l.t.length, 0)
    pages.push({ page: p, lines })
    onProgress?.(p, doc.numPages)
    if (p % 20 === 0) await new Promise((r) => setTimeout(r, 0))
  }
  return { doc: reflow(pages, outline), empty: chars < 20 }
}
