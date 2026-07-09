/**
 * 重排引擎:把固定版式的逐行文本重建为可重排的"图书流"。
 *
 * 输入是每页的文本行(归一化坐标,来自 pdf.js 文字层或 OCR),输出是
 * 段落/标题块序列。管线:
 *   行 → orderLinesForReading(多栏阅读顺序)
 *     → 段落聚合(行距、缩进、结尾标点、连字符、CJK 无空格拼接)
 *     → 标题识别(目录书签优先,字号启发兜底)
 *     → 跨页段落缝合(上一页收尾未完 + 下一页顶格续行)
 *
 * 每个块记录来源页码与页内位置,供图书视图 ⇄ 原版式双向同步和
 * 高亮指纹锚定使用。app 与将来的 EPUB 输出共用这一实现。
 */
import { orderLinesForReading, type OcrBox } from './reading-order.js'

export interface ReflowLine extends OcrBox {
  /** 行高的近似字号(归一化);缺省时用 h */
  fontSize?: number
}

export interface ReflowPageInput {
  /** 1-based 页码 */
  page: number
  lines: ReflowLine[]
}

/** 目录书签(用于标题识别与分章) */
export interface OutlineEntry {
  title: string
  page: number
  depth: number
}

export interface ReflowBlock {
  type: 'heading' | 'para'
  text: string
  /** heading 层级 1..6 */
  level?: number
  /** 来源页(块首行所在页,1-based) */
  page: number
  /** 块首行在页内的纵向位置(0..1,用于精确回跳) */
  yTop: number
}

export interface ReflowDoc {
  blocks: ReflowBlock[]
}

/** 句子明确收尾的标点(段落在页尾结束的信号) */
const TERMINAL = /[。．.!?！?”"』」)】〕…:：;；]$/
/** CJK 字符(拼接时不加空格) */
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/

function isCjkBoundary(prev: string, next: string): boolean {
  const a = prev.slice(-1)
  const b = next.slice(0, 1)
  return CJK.test(a) || CJK.test(b)
}

/** 拼接两行:英文连字符断词还原;CJK 直连;拉丁文补空格 */
export function joinLines(a: string, b: string): string {
  const at = a.trimEnd()
  const bt = b.trimStart()
  if (!at) return bt
  if (!bt) return at
  // 行尾连字符 + 下一行小写字母开头 → 断词还原
  if (/[a-zA-Z]-$/.test(at) && /^[a-z]/.test(bt)) return at.slice(0, -1) + bt
  if (isCjkBoundary(at, bt)) return at + bt
  return at + ' ' + bt
}

interface ParaAccum {
  text: string
  page: number
  yTop: number
  fontSize: number
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * 单页:有序行 → 段落块。启发:
 *  - 垂直间隙 > 0.9 × 中位行距 → 断段
 *  - 回跳到页面上方(换栏)且间隙语义不明 → 交给 orderLines 的顺序,仅按间隙断
 *  - 首行缩进(x 比段落主体大 ≥ 1 字宽)→ 新段
 *  - 字号突变(> 1.25×)→ 断段(候选标题)
 */
function pageToParas(page: number, ordered: ReflowLine[]): ParaAccum[] {
  const out: ParaAccum[] = []
  if (!ordered.length) return out
  const heights = ordered.map((l) => l.fontSize ?? l.h)
  const medH = median(heights) || 0.02
  const gaps: number[] = []
  for (let i = 1; i < ordered.length; i++) {
    const g = ordered[i].y - (ordered[i - 1].y + ordered[i - 1].h)
    if (g > 0 && g < medH * 3) gaps.push(g)
  }
  const medGap = median(gaps)
  const bodyX = median(ordered.map((l) => l.x))

  let cur: ParaAccum | null = null
  let prev: ReflowLine | null = null
  for (const l of ordered) {
    const fs = l.fontSize ?? l.h
    let breakPara = false
    if (!cur || !prev) breakPara = true
    else {
      const gap = l.y - (prev.y + prev.h)
      const bigGap = gap > Math.max(medGap * 1.9, medH * 0.9)
      const jumpedUp = l.y < prev.y - medH // 换栏/换段落带
      const indent = l.x - bodyX > medH * 0.8 && prev.x - bodyX < medH * 0.3
      const sizeShift = fs > (cur.fontSize || medH) * 1.25 || fs < (cur.fontSize || medH) / 1.25
      breakPara = bigGap || indent || sizeShift || (jumpedUp && TERMINAL.test(cur.text))
    }
    if (breakPara) {
      if (cur && cur.text.trim()) out.push(cur)
      cur = { text: l.t.trim(), page, yTop: l.y, fontSize: fs }
    } else {
      cur!.text = joinLines(cur!.text, l.t)
      cur!.fontSize = Math.max(cur!.fontSize, fs)
    }
    prev = l
  }
  if (cur && cur.text.trim()) out.push(cur)
  return out
}

const norm = (s: string): string => s.replace(/\s+/g, '').normalize('NFKC')

/**
 * 整册重排。outline 命中的段落升级为标题;字号显著大于正文且很短的
 * 段落作为兜底标题;跨页缝合仅在"上一页未收尾 + 下一页非缩进"时发生。
 */
export function reflow(pages: ReflowPageInput[], outline: OutlineEntry[] = []): ReflowDoc {
  const paras: ParaAccum[] = []
  for (const p of pages) {
    const ordered = orderLinesForReading(p.lines)
    paras.push(...pageToParas(p.page, ordered as ReflowLine[]))
  }
  if (!paras.length) return { blocks: [] }

  // 正文字号 = 全书"行"中位(按段取会被少量大段落带偏)
  const bodyFs = median(pages.flatMap((p) => p.lines.map((l) => l.fontSize ?? l.h)))

  // outline 标题匹配:同页、文本归一化后互相包含
  const outlineByPage = new Map<number, OutlineEntry[]>()
  for (const o of outline) {
    const arr = outlineByPage.get(o.page) ?? []
    arr.push(o)
    outlineByPage.set(o.page, arr)
  }

  const blocks: ReflowBlock[] = []
  let prevBlock: ReflowBlock | null = null
  for (const b of paras) {
    const cands = outlineByPage.get(b.page) ?? []
    const nb = norm(b.text)
    const hit = cands.find((o) => {
      const no = norm(o.title)
      return no.length > 0 && (nb.includes(no) || no.includes(nb))
    })
    let block: ReflowBlock
    if (hit) {
      block = {
        type: 'heading',
        level: Math.min(hit.depth + 1, 6),
        text: b.text,
        page: b.page,
        yTop: b.yTop,
      }
    } else if (b.fontSize > bodyFs * 1.3 && b.text.length <= 60 && !TERMINAL.test(b.text.trim())) {
      block = { type: 'heading', level: 3, text: b.text, page: b.page, yTop: b.yTop }
    } else {
      // 跨页缝合:上一块是未收尾的段落,且本块在新页顶部开始
      if (
        prevBlock &&
        prevBlock.type === 'para' &&
        b.page === prevBlock.page + 1 &&
        b.yTop < 0.2 &&
        !TERMINAL.test(prevBlock.text.trimEnd()) &&
        !/^[  \t]/.test(b.text)
      ) {
        prevBlock.text = joinLines(prevBlock.text, b.text)
        continue
      }
      block = { type: 'para', text: b.text, page: b.page, yTop: b.yTop }
    }
    blocks.push(block)
    prevBlock = block
  }
  return { blocks }
}
