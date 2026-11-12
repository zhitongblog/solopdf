/**
 * 原生 PDF 转结构化 Markdown（iLovePDF PDF to Markdown 本地引擎）
 *
 * 在 `reflow`（阅读顺序 + 段落缝合 + 标题识别）的基础上增加：
 *  1. 表格检测与还原：同一水平行出现 2 个以上独立单元格且连续 ≥2 行列数一致时，
 *     自动拼装为标准 Markdown 表格（`| A | B |\n| --- | --- |`）。
 *  2. 列表项识别：以 `•`、`·`、`-`、`*`、`1.`、`1)`、`(1)`、`①` 等开头的行保持独立列表项，
 *     不被错误合并进上一段落。
 *  3. 标题层级：结合 PDF 书签目录（Outline）与字号梯度输出 `#` ~ `######`。
 */
import { joinLines, type OutlineEntry, type ReflowLine, type ReflowPageInput } from './reflow.js'
import { orderLinesForReading } from './reading-order.js'

export interface PdfToMarkdownOptions {
  /** 文档总标题（若有，在顶部输出 `# Title`） */
  title?: string
  /** 是否在每页开头插入 `<!-- page N -->` 注释或分隔标记（默认 false） */
  includePageComments?: boolean
}

const LIST_BULLET_RE = /^\s*(?:[•·▪▫◦‣⁃\-*+]|\d{1,3}[.)、]|\(\d{1,3}\)|[①②③④⑤⑥⑦⑧⑨⑩])\s+/
const TERMINAL_RE = /[。．.!?！？”"』」)】〕…:：;；]$/

interface RowGroup {
  y: number
  h: number
  fontSize: number
  cells: ReflowLine[]
}

/**
 * 将单页内的文本片段按垂直重叠聚合成「视觉行」，
 * 若一行内包含多个水平间距显著（> 2 倍字高）的独立文本块，则保留为多个 cell。
 */
function groupIntoVisualRows(lines: ReflowLine[]): RowGroup[] {
  const nonEmpty = lines.filter((l) => l.t.trim().length > 0)
  if (!nonEmpty.length) return []

  const sorted = [...nonEmpty].sort((a, b) => {
    const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    if (overlap > 0.45 * Math.min(a.h, b.h)) return a.x - b.x
    return a.y - b.y
  })

  const rawRows: ReflowLine[][] = []
  for (const item of sorted) {
    const lastRow = rawRows[rawRows.length - 1]
    if (!lastRow) {
      rawRows.push([item])
      continue
    }
    const refY = lastRow[0].y
    const refH = lastRow[0].h
    const overlap = Math.min(refY + refH, item.y + item.h) - Math.max(refY, item.y)
    if (overlap > 0.45 * Math.min(refH, item.h)) {
      lastRow.push(item)
    } else {
      rawRows.push([item])
    }
  }

  return rawRows.map((row) => {
    row.sort((a, b) => a.x - b.x)
    // 合并紧挨着的同属一个单元格的碎片，保留水平间距较大的独立列
    const mergedCells: ReflowLine[] = []
    for (const seg of row) {
      const prev = mergedCells[mergedCells.length - 1]
      const h = seg.fontSize ?? seg.h
      if (prev && seg.x - (prev.x + prev.w) < Math.max(h * 1.5, 0.025)) {
        prev.t = joinLines(prev.t, seg.t)
        prev.w = Math.max(prev.x + prev.w, seg.x + seg.w) - prev.x
        prev.h = Math.max(prev.h, seg.h)
      } else {
        mergedCells.push({ ...seg })
      }
    }
    // 如果单行文本内部用 2 个以上制表符或 ≥3 个连续空格分隔，也拆成多列候选
    if (mergedCells.length === 1 && /\t+|\s{3,}/.test(mergedCells[0].t.trim())) {
      const parts = mergedCells[0].t.trim().split(/\t+|\s{3,}/).map((s) => s.trim()).filter(Boolean)
      if (parts.length >= 2) {
        const base = mergedCells[0]
        const stepW = base.w / parts.length
        return {
          y: base.y,
          h: base.h,
          fontSize: base.fontSize ?? base.h,
          cells: parts.map((text, idx) => ({
            t: text,
            x: base.x + idx * stepW,
            y: base.y,
            w: stepW * 0.9,
            h: base.h,
            fontSize: base.fontSize,
          })),
        }
      }
    }

    const y = Math.min(...mergedCells.map((c) => c.y))
    const h = Math.max(...mergedCells.map((c) => c.h))
    const fontSize = Math.max(...mergedCells.map((c) => c.fontSize ?? c.h))
    return { y, h, fontSize, cells: mergedCells }
  })
}

function escapeMdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

function formatMarkdownTable(rows: RowGroup[]): string {
  const colCount = Math.max(...rows.map((r) => r.cells.length))
  const lines: string[] = []
  rows.forEach((r, idx) => {
    const vals: string[] = []
    for (let c = 0; c < colCount; c++) {
      vals.push(escapeMdCell(r.cells[c]?.t ?? ''))
    }
    lines.push(`| ${vals.join(' | ')} |`)
    if (idx === 0) {
      lines.push(`| ${new Array(colCount).fill('---').join(' | ')} |`)
    }
  })
  return lines.join('\n')
}

function normalizeListBullet(text: string): string {
  const trimmed = text.trim()
  if (/^[•·▪▫◦‣⁃*+]\s+/.test(trimmed)) {
    return '- ' + trimmed.replace(/^[•·▪▫◦‣⁃*+]\s+/, '')
  }
  const numMatch = trimmed.match(/^(?:(\d{1,3})[.)、]|\((\d{1,3})\))\s+(.*)$/)
  if (numMatch) {
    const num = numMatch[1] || numMatch[2]
    return `${num}. ${numMatch[3]}`
  }
  return trimmed
}

const normText = (s: string): string => s.replace(/\s+/g, '').normalize('NFKC')

function median(xs: number[]): number {
  if (!xs.length) return 0.02
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * 将多页 PDF 文本行与目录树转换为结构化 Markdown 文本。
 */
export function pdfToMarkdown(
  pages: ReflowPageInput[],
  outline: OutlineEntry[] = [],
  options: PdfToMarkdownOptions = {},
): string {
  const allFontSizes = pages.flatMap((p) => p.lines.map((l) => l.fontSize ?? l.h)).filter((n) => n > 0)
  const bodyFs = median(allFontSizes)

  const outlineByPage = new Map<number, OutlineEntry[]>()
  for (const o of outline) {
    const list = outlineByPage.get(o.page) ?? []
    list.push(o)
    outlineByPage.set(o.page, list)
  }

  const outBlocks: string[] = []
  if (options.title?.trim()) {
    outBlocks.push(`# ${options.title.trim()}`)
  }

  for (const page of pages) {
    if (options.includePageComments) {
      outBlocks.push(`<!-- page ${page.page} -->`)
    }

    // 先判断该页是否存在明显的表格区（连续 ≥2 行拥有相同列数 ≥2）
    const visualRows = groupIntoVisualRows(page.lines)
    const multiCellRows = visualRows.filter((r) => r.cells.length >= 2)
    // 注意：双栏论文整页都是 2 列，不应误判为表格；表格要求行数适中或列数 >= 3，或单元格较短
    const looksLikeTwoColArticle =
      multiCellRows.length >= 8 &&
      multiCellRows.every((r) => r.cells.length === 2 && r.cells.some((c) => c.t.length > 35))

    if (!looksLikeTwoColArticle && multiCellRows.length >= 2) {
      // 按视觉行状态机输出：遇到连续同列数的多列行输出为表格，其余走常规段落/标题/列表聚合
      let i = 0
      const singleLinesBuffer: ReflowLine[] = []
      const flushSingleLines = () => {
        if (!singleLinesBuffer.length) return
        outBlocks.push(...linesToMarkdownBlocks(page.page, singleLinesBuffer, bodyFs, outlineByPage.get(page.page) ?? []))
        singleLinesBuffer.length = 0
      }

      while (i < visualRows.length) {
        const cur = visualRows[i]
        if (cur.cells.length >= 2) {
          let j = i + 1
          while (
            j < visualRows.length &&
            visualRows[j].cells.length === cur.cells.length &&
            visualRows[j].y - (visualRows[j - 1].y + visualRows[j - 1].h) < bodyFs * 2.5
          ) {
            j++
          }
          if (j - i >= 2) {
            flushSingleLines()
            outBlocks.push(formatMarkdownTable(visualRows.slice(i, j)))
            i = j
            continue
          }
        }
        singleLinesBuffer.push(...cur.cells)
        i++
      }
      flushSingleLines()
    } else {
      const ordered = orderLinesForReading(page.lines) as ReflowLine[]
      outBlocks.push(...linesToMarkdownBlocks(page.page, ordered, bodyFs, outlineByPage.get(page.page) ?? []))
    }
  }

  return outBlocks.filter(Boolean).join('\n\n') + '\n'
}

function linesToMarkdownBlocks(
  pageNumber: number,
  ordered: ReflowLine[],
  bodyFs: number,
  pageOutline: OutlineEntry[],
): string[] {
  if (!ordered.length) return []
  const blocks: string[] = []
  const bodyX = median(ordered.map((l) => l.x))

  let curPara: { text: string; fontSize: number; y: number; h: number } | null = null
  let prevLine: ReflowLine | null = null

  const flushPara = () => {
    if (!curPara || !curPara.text.trim()) {
      curPara = null
      return
    }
    const text = curPara.text.trim()
    const nt = normText(text)
    const hit = pageOutline.find((o) => {
      const no = normText(o.title)
      return no.length > 0 && (nt.includes(no) || no.includes(nt))
    })
    if (hit) {
      const level = Math.min(Math.max(hit.depth + 1, 1), 6)
      blocks.push(`${'#'.repeat(level)} ${text}`)
    } else if (curPara.fontSize > bodyFs * 1.45 && text.length <= 70 && !TERMINAL_RE.test(text)) {
      blocks.push(`## ${text}`)
    } else if (curPara.fontSize > bodyFs * 1.25 && text.length <= 70 && !TERMINAL_RE.test(text)) {
      blocks.push(`### ${text}`)
    } else {
      blocks.push(text)
    }
    curPara = null
  }

  let listAccum: string[] = []
  const flushList = () => {
    if (listAccum.length) {
      blocks.push(listAccum.join('\n'))
      listAccum = []
    }
  }

  for (const l of ordered) {
    const raw = l.t.trim()
    if (!raw) continue
    const fs = l.fontSize ?? l.h

    // 列表项单独成行
    if (LIST_BULLET_RE.test(raw)) {
      flushPara()
      listAccum.push(normalizeListBullet(raw))
      prevLine = l
      continue
    }
    flushList()

    if (!curPara || !prevLine) {
      curPara = { text: raw, fontSize: fs, y: l.y, h: l.h }
      prevLine = l
      continue
    }

    const gap = l.y - (prevLine.y + prevLine.h)
    const bigGap = gap > bodyFs * 0.95
    const indent = l.x - bodyX > bodyFs * 0.8 && prevLine.x - bodyX < bodyFs * 0.3
    const sizeShift = fs > curPara.fontSize * 1.25 || fs < curPara.fontSize / 1.25
    const jumpedUp = l.y < prevLine.y - bodyFs

    if (bigGap || indent || sizeShift || (jumpedUp && TERMINAL_RE.test(curPara.text))) {
      flushPara()
      curPara = { text: raw, fontSize: fs, y: l.y, h: l.h }
    } else {
      curPara.text = joinLines(curPara.text, raw)
      curPara.fontSize = Math.max(curPara.fontSize, fs)
    }
    prevLine = l
  }

  flushList()
  flushPara()
  return blocks
}
