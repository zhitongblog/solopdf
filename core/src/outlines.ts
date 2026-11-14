/**
 * PDF Outlines (Bookmarks) Auto-Detection & Tree Manipulation
 *
 * Supports:
 *  - Font-size gradient clustering (body median vs heading levels 1..3)
 *  - Chapter/Section regex detection (Chinese 第X章/节, 一、, English Chapter/Section/Part, numbered 1 / 1.1 / 1.1.1)
 *  - Custom user regex
 *  - Tree flattening, unflattening (with level jump normalization), and sanitization
 */
import { joinLines } from './reflow.js'

export interface OutlineNode {
  title: string
  /** 1-based page number */
  page: number
  top?: number | null
  children?: OutlineNode[]
}

export interface FlatOutlineItem {
  title: string
  page: number
  level: number
  top?: number | null
}

export interface PdfTextItem {
  str?: string
  t?: string
  text?: string
  x: number
  y: number
  width?: number
  w?: number
  height?: number
  h?: number
  fontSize?: number
}

export interface PdfPageInput {
  /** 1-based page number */
  page: number
  width?: number
  height?: number
  items?: PdfTextItem[]
  lines?: PdfTextItem[]
}

export interface DetectOutlinesOptions {
  mode?: 'auto' | 'fontsize' | 'regex'
  customRegex?: string
  maxLevel?: number
}

interface NormalizedLine {
  text: string
  page: number
  x: number
  y: number
  height: number
  fontSize: number
}

const TERMINAL_PUNCT_RE = /[。．.!?！？；;，,、：:]$/

// Chinese & English chapter/section regex patterns with intrinsic hierarchy levels
const CN_CHAPTER_L1_RE = /^第\s*[一二三四五六七八九十百千万零两〇\d]+\s*[篇部章回讲卷集](?:[\s:：、.．\-—].*|$)/
const CN_SECTION_L2_RE = /^第\s*[一二三四五六七八九十百千万零两〇\d]+\s*节(?:[\s:：、.．\-—].*|$)/
const CN_SPECIAL_L1_RE = /^(?:序章|序言|前言|绪论|引言|导论|综述|总结|结论|参考文献|附录|致谢|后记)(?:\s+\S.*)?$/
const CN_NUM_L2_RE = /^[一二三四五六七八九十]+[、.．]\s*\S+/
const CN_PAREN_L3_RE = /^[（(][一二三四五六七八九十]+[)）]\s*\S+/

const EN_CHAPTER_L1_RE = /^(?:chapter|part|book|appendix)\s+[0-9ivxlcdm]+\b.*/i
const EN_SECTION_L2_RE = /^section\s+[0-9ivxlcdm]+(?:\.\d+)*\b.*/i

// Numbered headings: 1 Title (L1), 1.1 Title (L2), 1.1.1 Title (L3)
const NUMBERED_HEADING_RE = /^(\d+(?:\.\d+){0,2})\s+([^\d\s].*)$/

function median(xs: number[]): number {
  if (!xs.length) return 12
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Normalize a page's items or lines into visual lines sorted top-to-bottom.
 */
function extractPageLines(pageInput: PdfPageInput): NormalizedLine[] {
  const rawItems: Array<{ text: string; x: number; y: number; w: number; h: number; fontSize: number }> = []

  const sourceList = pageInput.items ?? pageInput.lines ?? []
  for (const item of sourceList) {
    const text = (item.str ?? item.t ?? item.text ?? '').trim()
    if (!text) continue
    const h = item.height ?? item.h ?? item.fontSize ?? 12
    const w = item.width ?? item.w ?? text.length * h * 0.6
    const fontSize = item.fontSize ?? h
    rawItems.push({ text, x: item.x, y: item.y, w, h, fontSize })
  }

  if (!rawItems.length) return []

  const medH = median(rawItems.map((i) => i.h).filter((h) => h > 0))
  const yTol = medH * 0.45

  // Sort primarily by y, then by x
  const sorted = [...rawItems].sort((a, b) => {
    if (Math.abs(a.y - b.y) <= yTol) return a.x - b.x
    return a.y - b.y
  })

  const rowGroups: Array<typeof rawItems> = []
  for (const item of sorted) {
    const last = rowGroups[rowGroups.length - 1]
    if (!last) {
      rowGroups.push([item])
      continue
    }
    const refY = last[0].y
    if (Math.abs(item.y - refY) <= yTol) {
      last.push(item)
    } else {
      rowGroups.push([item])
    }
  }

  return rowGroups.map((group) => {
    group.sort((a, b) => a.x - b.x)
    let text = group[0].text
    for (let i = 1; i < group.length; i++) {
      text = joinLines(text, group[i].text)
    }
    const x = Math.min(...group.map((g) => g.x))
    const y = Math.min(...group.map((g) => g.y))
    const height = Math.max(...group.map((g) => g.h))
    const fontSize = Math.max(...group.map((g) => g.fontSize))
    return {
      text: text.trim(),
      page: pageInput.page,
      x,
      y,
      height,
      fontSize,
    }
  })
}

/**
 * Match a single line against chapter/section/numbered regexes.
 * Returns heading level (1..3) or null if not matched.
 */
function matchRegexHeadingLevel(text: string, customRe: RegExp | null): number | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 80) return null

  if (customRe && customRe.test(trimmed)) {
    return 1
  }

  if (CN_CHAPTER_L1_RE.test(trimmed) || CN_SPECIAL_L1_RE.test(trimmed) || EN_CHAPTER_L1_RE.test(trimmed)) {
    return 1
  }

  if (CN_SECTION_L2_RE.test(trimmed) || CN_NUM_L2_RE.test(trimmed) || EN_SECTION_L2_RE.test(trimmed)) {
    return 2
  }

  if (CN_PAREN_L3_RE.test(trimmed)) {
    return 3
  }

  const numMatch = trimmed.match(NUMBERED_HEADING_RE)
  if (numMatch) {
    const numPart = numMatch[1]
    const restText = numMatch[2].trim()
    // Reject sentence lines ending with punctuation
    if (TERMINAL_PUNCT_RE.test(restText)) return null
    const segments = numPart.split('.').map((n) => parseInt(n, 10))
    // Filter out years/dates like "2026.11 Event" or oversized numbers like "100.5"
    if (segments[0] === 0 || segments[0] > 50) return null
    if (segments.some((s) => Number.isNaN(s) || s > 50)) return null
    // Reject if restText starts with a unit/date marker like "月", "日", "年", "%"
    if (/^[年月日%％°]/.test(restText)) return null
    return Math.min(segments.length, 3)
  }

  return null
}

/**
 * Auto-detect hierarchical PDF outlines (bookmarks) from page text items.
 */
export function detectOutlinesFromPages(
  pages: PdfPageInput[],
  opts: DetectOutlinesOptions = {},
): OutlineNode[] {
  const mode = opts.mode ?? 'auto'
  const maxLevel = Math.max(1, Math.min(opts.maxLevel ?? 3, 6))

  let customRe: RegExp | null = null
  if (opts.customRegex?.trim()) {
    try {
      customRe = new RegExp(opts.customRegex.trim())
    } catch {
      customRe = null
    }
  }

  const allLines: NormalizedLine[] = []
  for (const p of pages) {
    allLines.push(...extractPageLines(p))
  }
  if (!allLines.length) return []

  const bodyFs = median(allLines.map((l) => l.fontSize).filter((fs) => fs > 0))

  // Build font-size clusters for lines significantly larger than body text
  const largeFontSizes: number[] = []
  if (mode === 'fontsize' || mode === 'auto') {
    for (const line of allLines) {
      if (
        line.fontSize > bodyFs * 1.18 &&
        line.text.length <= 80 &&
        !TERMINAL_PUNCT_RE.test(line.text) &&
        !/^\d+$/.test(line.text)
      ) {
        largeFontSizes.push(line.fontSize)
      }
    }
  }

  // Cluster distinct heading font sizes in descending order (within 6% tolerance)
  const sortedDesc = [...largeFontSizes].sort((a, b) => b - a)
  const fsClusters: number[] = []
  for (const fs of sortedDesc) {
    const existing = fsClusters.find((c) => Math.abs(c - fs) / Math.max(c, 1e-6) <= 0.06)
    if (existing === undefined) {
      fsClusters.push(fs)
    }
  }

  const getFontSizeLevel = (line: NormalizedLine): number | null => {
    if (
      line.fontSize <= bodyFs * 1.18 ||
      line.text.length > 80 ||
      TERMINAL_PUNCT_RE.test(line.text) ||
      /^\d+$/.test(line.text)
    ) {
      return null
    }
    const idx = fsClusters.findIndex((c) => Math.abs(c - line.fontSize) / Math.max(c, 1e-6) <= 0.06)
    if (idx === -1) return null
    return Math.min(idx + 1, 3)
  }

  const flatCandidates: FlatOutlineItem[] = []
  for (const line of allLines) {
    let level: number | null = null

    if (mode === 'regex') {
      level = matchRegexHeadingLevel(line.text, customRe)
    } else if (mode === 'fontsize') {
      level = getFontSizeLevel(line)
    } else {
      // 'auto': combine regex and font-size gradient
      const regexLevel = matchRegexHeadingLevel(line.text, customRe)
      const fsLevel = getFontSizeLevel(line)
      if (regexLevel !== null && fsLevel !== null) {
        // Regex numbering gives exact structural nesting (e.g. 1 vs 1.1 vs 1.1.1)
        level = regexLevel
      } else if (regexLevel !== null) {
        level = regexLevel
      } else if (fsLevel !== null) {
        level = fsLevel
      }
    }

    if (level !== null && level <= maxLevel) {
      flatCandidates.push({
        title: line.text.trim(),
        page: line.page,
        level,
        top: Math.round(line.y * 1000) / 1000,
      })
    }
  }

  return unflattenOutlineTree(flatCandidates)
}

/**
 * Flatten a nested `OutlineNode[]` tree into a depth-first array with 1-based `level`.
 */
export function flattenOutlineTree(tree: OutlineNode[]): FlatOutlineItem[] {
  const result: FlatOutlineItem[] = []

  const walk = (nodes: OutlineNode[], level: number) => {
    for (const node of nodes) {
      const item: FlatOutlineItem = {
        title: node.title,
        page: node.page,
        level,
      }
      if (node.top !== undefined) {
        item.top = node.top
      }
      result.push(item)
      if (node.children && node.children.length > 0) {
        walk(node.children, level + 1)
      }
    }
  }

  walk(tree, 1)
  return result
}

/**
 * Reconstruct a nested `OutlineNode[]` tree from flat items with `level` >= 1.
 * Gracefully handles level jumps (e.g. starting at level 2 or jumping from 1 to 3).
 */
export function unflattenOutlineTree(flat: FlatOutlineItem[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: Array<{ node: OutlineNode; level: number }> = []

  for (const item of flat) {
    const title = item.title.trim()
    if (!title) continue
    const level = Math.max(1, Math.floor(item.level || 1))
    const node: OutlineNode = {
      title,
      page: item.page,
      ...(item.top !== undefined ? { top: item.top } : {}),
      children: [],
    }

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop()
    }

    if (stack.length === 0) {
      roots.push(node)
    } else {
      const parent = stack[stack.length - 1].node
      if (!parent.children) parent.children = []
      parent.children.push(node)
    }

    stack.push({ node, level })
  }

  return roots
}

/**
 * Sanitize an outline tree: trims titles, drops empty titles, and clamps page numbers to `1..maxPage`.
 */
export function sanitizeOutlineTree(tree: OutlineNode[], maxPage: number): OutlineNode[] {
  const safeMax = Math.max(1, Math.floor(maxPage || 1))

  const sanitizeList = (nodes: OutlineNode[]): OutlineNode[] => {
    const out: OutlineNode[] = []
    for (const n of nodes) {
      const title = (n.title ?? '').trim()
      const sanitizedChildren = n.children ? sanitizeList(n.children) : []
      if (!title) {
        // If parent has an empty title, promote any valid children instead of losing them
        out.push(...sanitizedChildren)
        continue
      }
      const rawPage = Number.isFinite(n.page) ? Math.round(n.page) : 1
      const page = Math.min(Math.max(1, rawPage), safeMax)
      const cleanNode: OutlineNode = {
        title,
        page,
        ...(n.top !== undefined ? { top: n.top } : {}),
        children: sanitizedChildren,
      }
      out.push(cleanNode)
    }
    return out
  }

  return sanitizeList(tree)
}
