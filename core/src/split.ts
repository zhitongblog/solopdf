/**
 * 拆分增强（iLovePDF Split PDF 增强版）：
 *  1. 按 PDF 目录书签章节自动计算拆分区间与安全文件名（splitByBookmarks）
 *  2. 按固定页数或均分份数自动计算拆分区间（splitIntoChunks）
 */
import type { OutlineEntry } from './reflow.js'

export interface SplitChapterRange {
  /** 章节标题 */
  title: string
  /** 适合做文件名的安全 slug（保留中英文与数字） */
  slug: string
  /** 1-based 起始页（含） */
  from: number
  /** 1-based 结束页（含） */
  to: number
  /** 传给后端 split_pdf 的区间字符串，如 "1-4" */
  rangeSpec: string
}

export interface SplitByBookmarksOptions {
  /** 最大书签层级（0 = 仅一级书签，1 = 含二级书签，默认 0） */
  maxDepth?: number
  /** 若首个书签不在第 1 页，是否把前面的页作为「前言 / Front Matter」单独拆出（默认 true） */
  includeFrontMatter?: boolean
  /** 前言章节标题（默认 "00-front-matter"） */
  frontMatterTitle?: string
}

/** 将章节标题清理为跨平台安全的文件名片段 */
export function sanitizeChapterSlug(title: string, index?: number): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 60)
  const base = cleaned || 'chapter'
  if (typeof index === 'number') {
    const num = String(index).padStart(2, '0')
    return `${num}-${base}`
  }
  return base
}

/**
 * 根据 PDF 书签目录树生成不重叠、覆盖全书的章节拆分区间。
 */
export function splitByBookmarks(
  outline: OutlineEntry[],
  totalPages: number,
  options: SplitByBookmarksOptions = {},
): SplitChapterRange[] {
  if (totalPages <= 0) return []
  const maxDepth = options.maxDepth ?? 0
  const includeFrontMatter = options.includeFrontMatter ?? true
  const frontTitle = options.frontMatterTitle ?? '前言'

  // 过滤有效书签并按页码升序排列；同一页出现多个书签时保留第一个
  const valid = outline
    .filter((o) => o.depth <= maxDepth && o.page >= 1 && o.page <= totalPages && o.title.trim().length > 0)
    .sort((a, b) => a.page - b.page || a.depth - b.depth)

  const deduped: OutlineEntry[] = []
  for (const item of valid) {
    if (deduped.length > 0 && deduped[deduped.length - 1].page === item.page) {
      continue
    }
    deduped.push(item)
  }

  if (!deduped.length) return []

  const result: SplitChapterRange[] = []
  if (includeFrontMatter && deduped[0].page > 1) {
    const from = 1
    const to = deduped[0].page - 1
    result.push({
      title: frontTitle,
      slug: sanitizeChapterSlug(frontTitle, 0),
      from,
      to,
      rangeSpec: `${from}-${to}`,
    })
  }

  for (let i = 0; i < deduped.length; i++) {
    const cur = deduped[i]
    const next = deduped[i + 1]
    const from = cur.page
    const to = next ? Math.max(from, next.page - 1) : totalPages
    result.push({
      title: cur.title.trim(),
      slug: sanitizeChapterSlug(cur.title, i + 1),
      from,
      to,
      rangeSpec: `${from}-${to}`,
    })
  }

  return result
}

export interface SplitChunkOptions {
  /** 每份固定页数（例如每 5 页拆成一个文件） */
  pagesPerFile?: number
  /** 平均拆成 N 份（例如把 100 页均分为 3 份） */
  parts?: number
}

/**
 * 按固定每份页数或总份数均匀计算拆分区间。
 */
export function splitIntoChunks(
  totalPages: number,
  options: SplitChunkOptions,
): Array<{ from: number; to: number; rangeSpec: string }> {
  if (totalPages <= 0) return []

  if (options.pagesPerFile && options.pagesPerFile > 0) {
    const step = Math.max(1, Math.floor(options.pagesPerFile))
    const out: Array<{ from: number; to: number; rangeSpec: string }> = []
    for (let from = 1; from <= totalPages; from += step) {
      const to = Math.min(totalPages, from + step - 1)
      out.push({ from, to, rangeSpec: `${from}-${to}` })
    }
    return out
  }

  if (options.parts && options.parts > 0) {
    const parts = Math.min(totalPages, Math.max(1, Math.floor(options.parts)))
    const base = Math.floor(totalPages / parts)
    const rem = totalPages % parts
    const out: Array<{ from: number; to: number; rangeSpec: string }> = []
    let cur = 1
    for (let i = 0; i < parts; i++) {
      const len = base + (i < rem ? 1 : 0)
      const from = cur
      const to = cur + len - 1
      out.push({ from, to, rangeSpec: `${from}-${to}` })
      cur = to + 1
    }
    return out
  }

  return [{ from: 1, to: totalPages, rangeSpec: `1-${totalPages}` }]
}
